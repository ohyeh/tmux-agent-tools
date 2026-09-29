// One collector pass as a separate OS process, for collector.contract.node.ts (§10).
// It is the real `reconcileOnce` over the real filesystem; only the outside world
// (tmux, agent-tmux, git) is answered here, and the fault points live in this
// host wrapper, never in the product code.
//
// Usage: node workers.race.node.ts <session> <cwd>   (TMUX_AGENT_DIR = the shared root)
// env:
//   DELIVERIES   file; each accepted submit appends `<session>\t<activation>\t<one-line text>\n`
//   LIVE         comma list of tmux session names `tmux list-sessions` reports
//   HOLD_READ    substring of a read path: announce `<root>/held.<session>` and wait for
//                `<root>/go.<session>` before that read (a slow pass, released by the test)
//   HOLD_SUBMIT  `1`: the same hold, inside submit, before anything is recorded
//   CRASH_AT     claim-owner | before-submit | after-submit: exit 9 at that point
//   REFUSE       `1`: every submit resolves { drop }
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { nodeHost } from './host.node.ts'
import { newGate, reconcileOnce, type Host } from './workers.ts'

const [session, cwd] = process.argv.slice(2) as [string, string]
const root = process.env.TMUX_AGENT_DIR!
const env = process.env
const logs: string[] = []

async function hold(): Promise<void> {
  writeFileSync(`${root}/held.${session}`, '')
  while (!existsSync(`${root}/go.${session}`)) await new Promise(r => setTimeout(r, 20))
}

const gate = newGate()
const base = nodeHost({
  owner: session,
  cwd,
  log: t => logs.push(t),
  submit: async text => {
    if (env.HOLD_SUBMIT === '1') await hold()
    if (env.CRASH_AT === 'before-submit') process.exit(9)
    if (env.REFUSE === '1') return { drop: 'refused by the test' }
    appendFileSync(env.DELIVERIES!, `${session}\t${gate.activation}\t${text.replace(/\n/g, ' ')}\n`)
    if (env.CRASH_AT === 'after-submit') process.exit(9)
    return { text }
  },
})
const host: Host = {
  ...base,
  read: async path => {
    if (env.HOLD_READ && path.includes(env.HOLD_READ)) await hold()
    return base.read(path)
  },
  run: async (argv, dir, ms) => {
    if (env.CRASH_AT === 'claim-owner' && argv[0] === 'mv' && /\/claims\/\d+\/owner$/.test(argv[2] ?? '')) process.exit(9)
    if (argv[0] === 'tmux') {
      const live = (env.LIVE ?? '').split(',').filter(Boolean)
      return { exitCode: 0, stdout: live.map(s => `${s}\t${cwd}\t0\n`).join(''), stderr: '' }
    }
    if (argv[0] === 'agent-tmux') return { exitCode: 0, stdout: '{"exists":true,"running":true,"idle_seconds":1}', stderr: '' }
    if (argv[0] === 'git') return { exitCode: 0, stdout: '', stderr: '' }
    return base.run(argv, dir, ms)
  },
}

await reconcileOnce(host, gate, false)
process.stdout.write(`${JSON.stringify({ activation: gate.activation, paused: gate.paused ?? null, logs })}\n`)
