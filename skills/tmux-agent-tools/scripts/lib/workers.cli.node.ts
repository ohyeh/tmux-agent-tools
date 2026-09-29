// The workers core for a shell: the actions every host shares, on the same ledger
// (p0-contract.md §5, §9). The state root is the CLI's: TMUX_AGENT_DIR, else
// $XDG_STATE_HOME/tmux-agent-tools, else ~/.local/state/tmux-agent-tools.
//
// Usage: node workers.cli.node.ts <command> [args] [--session <id>]
//   cancel <name> <seq>        close one episode (acks/cancel); the pane is untouched
//   unlock <name> [confirm]    maintenance: remove a lock whose holder is provably gone
//   --session  the id recorded as lock holder (default cli-<pid>)
// Exit: 0 ok; 1 refused or failed (the reason is printed); 2 bad arguments.
import { parseArgs } from 'node:util'
import { nodeHost } from './host.node.ts'
import { cancelEpisode, unlockWorker, type Outcome } from './workers.ts'

const USAGE = 'usage: node workers.cli.node.ts cancel <name> <seq> | unlock <name> [confirm] [--session <id>]'

function bad(why: string): never {
  process.stderr.write(`workers: ${why}\n${USAGE}\n`)
  process.exit(2)
}

async function main(): Promise<void> {
  let parsed: { values: { session?: string }; positionals: string[] }
  try {
    parsed = parseArgs({ options: { session: { type: 'string' } }, allowPositionals: true })
  } catch (error) {
    bad((error as Error).message)
  }
  const [command, name, arg] = parsed.positionals
  const host = nodeHost({ owner: parsed.values.session ?? `cli-${process.pid}`, cwd: process.cwd() })
  let out: Outcome
  if (command === 'cancel') {
    if (!name || !arg || !/^[0-9]+$/.test(arg)) bad('cancel takes <name> <seq>')
    out = await cancelEpisode(host, name, Number(arg))
  } else if (command === 'unlock') {
    if (!name) bad('unlock takes <name> [confirm]')
    out = await unlockWorker(host, name, arg)
  } else {
    bad(command ? `unknown command "${command}"` : 'a command is required')
  }
  process.stdout.write(`${out.text}\n`)
  process.exitCode = out.ok ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
