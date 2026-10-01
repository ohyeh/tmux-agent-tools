// The workers core for a shell: the actions every host shares, on the same ledger
// (p0-contract.md §3, §5, §9). The state root is the CLI's: TMUX_AGENT_DIR, else
// $XDG_STATE_HOME/tmux-agent-tools, else ~/.local/state/tmux-agent-tools.
//
// Usage: node workers.cli.node.ts <command> [args] --session <id> --cwd <abs>
//   assign <profile> <name> <dir> <brief-file> [--collector-down <text>]
//   tell <name> <text-file>
//   stop <name>
//   rows                       read-only panel rows, one JSON array
//   cancel <name> <seq> [--force]  close one episode (acks/cancel); the pane is untouched.
//                              --force closes an episode whose delivery was reserved and never acknowledged
//                              ("unknown: 可能已送達"): it only stops new attempts, it never says "not delivered"
//   unlock <name> [confirm]    maintenance: remove a lock whose holder is provably gone
// --session and --cwd are required (§3). A missing identity is a refusal, never "mine".
// Exit: 0 ok; 1 refused or failed (the reason is printed); 2 bad arguments.
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { nodeHost } from './host.node.ts'
import {
  assignWorker,
  cancelEpisode,
  newGate,
  panelRows,
  rootOf,
  scan,
  stopWorker,
  tellWorker,
  unlockWorker,
  type Host,
  type Outcome,
  type TmuxDispatch,
} from './workers.ts'

const NODE_FLOOR = [22, 18, 0]
const USAGE =
  'usage: node workers.cli.node.ts <assign|tell|stop|rows|cancel|unlock> [args] --session <id> --cwd <abs>'

function bad(why: string): never {
  process.stderr.write(`workers: ${why}\n${USAGE}\n`)
  process.exit(2)
}

function floor(): void {
  const have = process.versions.node.split('.').map(Number)
  const below = NODE_FLOOR.findIndex((n, i) => have[i]! !== n)
  if (below >= 0 && have[below]! < NODE_FLOOR[below]!) bad(`node ${process.versions.node} is below the floor ${NODE_FLOOR.join('.')}`)
}

async function readText(file: string, what: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    bad(`cannot read ${what}: ${(error as Error).message}`)
  }
}

async function byName(host: Host, name: string): Promise<TmuxDispatch | undefined> {
  const s = await scan(host, { claim: false })
  return s.visible.find(d => d.name === name)
}

function finish(out: Outcome): void {
  process.stdout.write(`${out.text}\n`)
  process.exitCode = out.ok ? 0 : 1
}

async function main(): Promise<void> {
  floor()
  let parsed: { values: { session?: string; cwd?: string; 'collector-down'?: string; force?: boolean }; positionals: string[] }
  try {
    parsed = parseArgs({
      options: {
        session: { type: 'string' },
        cwd: { type: 'string' },
        'collector-down': { type: 'string' },
        force: { type: 'boolean' },
      },
      allowPositionals: true,
    })
  } catch (error) {
    bad((error as Error).message)
  }
  const session = parsed.values.session
  const cwd = parsed.values.cwd
  if (!session) bad('--session is required: a CLI without a session id would own everything (§3)')
  if (!cwd || !cwd.startsWith('/')) bad('--cwd must be an absolute path (§3)')
  const [command, ...rest] = parsed.positionals
  const host = nodeHost({ owner: session, cwd })
  if (command === 'assign') {
    const [profile, name, dir, briefFile] = rest
    if (!profile || !name || !dir || !briefFile || rest.length !== 4) bad('assign takes <profile> <name> <dir> <brief-file>')
    const brief = await readText(briefFile, 'brief file')
    const down = parsed.values['collector-down']
    const got = await assignWorker(host, { profile, name, dir, brief }, {
      owner: session,
      ownerCwd: cwd,
      ...(down ? { down: () => down } : {}),
    })
    if ('deny' in got) {
      process.stdout.write(`${got.deny}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`${got.receipt}\n`)
    return
  }
  if (command === 'tell') {
    const [name, file] = rest
    if (!name || !file || rest.length !== 2) bad('tell takes <name> <text-file>')
    const d = await byName(host, name)
    if (!d) return finish({ ok: false, text: `no worker "${name}" in this project` })
    return finish(await tellWorker(host, d, await readText(file, 'text file')))
  }
  if (command === 'stop') {
    const [name] = rest
    if (!name || rest.length !== 1) bad('stop takes <name>')
    const d = await byName(host, name)
    if (!d) return finish({ ok: false, text: `no worker "${name}" in this project` })
    return finish(await stopWorker(host, newGate(), d))
  }
  if (command === 'rows') {
    if (rest.length) bad('rows takes no arguments')
    const rows = await panelRows(host, newGate(), await rootOf(host))
    process.stdout.write(`${JSON.stringify(rows)}\n`)
    return
  }
  if (command === 'cancel') {
    const [name, seq] = rest
    if (!name || !seq || rest.length !== 2 || !/^[0-9]+$/.test(seq)) bad('cancel takes <name> <seq> [--force]')
    return finish(await cancelEpisode(host, name, Number(seq), { force: !!parsed.values.force }))
  }
  if (command === 'unlock') {
    const [name, word] = rest
    if (!name || rest.length > 2) bad('unlock takes <name> [confirm]')
    return finish(await unlockWorker(host, name, word))
  }
  bad(command ? `unknown command "${command}"` : 'a command is required')
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
