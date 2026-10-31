// Prints one LOCATOR line for the FR-03 pty/pipe checks. Not a *.contract.node.ts.
import { spawnSync } from 'node:child_process'
import { nodeHost } from './host.node.ts'
import { focusTui, type TuiClaimResult } from './workers.ts'
import { ownLocator } from './tui.node.ts'

const term = process.argv[2] ?? ''
const logs: string[] = []
const calls: string[][] = []
const base = nodeHost({ log: text => logs.push(text) })
const host = {
  ...base,
  envTermProgram: async () => term,
  run: async (argv: readonly string[], cwd: string, ms: number) => {
    if (argv[0] === 'osascript' || argv[0] === 'open') {
      calls.push([...argv])
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    return base.run(argv, cwd, ms)
  },
}
const loc = await ownLocator(host, 'sess-1')
const ttyRun = spawnSync('/usr/bin/tty', [], { stdio: [1, 'pipe', 'pipe'], encoding: 'utf8' })
const actual = (ttyRun.stdout ?? '').trim()
let focus = ''
let argv0 = ''
let argvTty = ''
if (loc && (loc.kind === 'iterm' || loc.kind === 'terminal')) {
  const result: TuiClaimResult = {
    kind: 'occupied-ready',
    locator: loc,
    claim: { host: 'probe', pid: 1, pidStart: 'probe', token: 'aaaaaaaaaaaa', state: 'ready', at: 1 },
  }
  const focused = await focusTui(host, result)
  focus = 'raised' in focused ? focused.raised : focused.refused
  argv0 = calls[0]?.[0] ?? ''
  argvTty = calls[0]?.at(-1) ?? ''
}
process.stdout.write(`${JSON.stringify({ loc: loc ?? null, actual, focus, argv0, argvTty, log: logs.join('\n') })}\n`)
