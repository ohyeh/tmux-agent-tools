// The collector for a host without function hooks (Codex, agy, Cursor, any tmux CLI):
// one node process per host session (p0-contract.md §9). Same ledger, same
// `reconcileOnce` and `heartbeat` as the Claude mod; only the wake differs — a
// bracketed paste into the host's exact tmux pane id, then Enter.
//
// Usage: node collector.node.ts --session <id> --cwd <dir> --pane <%N> [--socket <abs>] [--once]
//   --session  the host session id this collector delivers for (required, §3)
//   --cwd      the project dir; orphans are adoptable only in the same cwd (required, §3)
//   --pane     the host pane, as `%N` (required: a name or index can point elsewhere)
//   --once     one reconcile pass, then exit (tests, cron)
// Exit: 0 when the pane is gone or --once finished; 1 when the collector paused
// (superseded by a newer activation, or refused deliveries); 2 on bad arguments.
import { execFile } from 'node:child_process'
import { parseArgs } from 'node:util'
import { nodeHost } from './host.node.ts'
import { heartbeat, newGate, POLL_MS, reconcileOnce } from './workers.ts'

const NODE_FLOOR = [22, 18, 0]
const TMUX_MS = 5_000

function tmux(args: string[], input?: string): Promise<{ code: number; out: string; err: string }> {
  const sock = process.env.TMUX_AGENT_TMUX_SOCKET
  const full = sock && args[0] !== '-S' && args[0] !== '-L' ? ['-S', sock, ...args] : args
  return new Promise(resolve => {
    const child = execFile('tmux', full, { timeout: TMUX_MS, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, out: stdout, err: stderr || (error ? String(error) : '') })
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

/** The pane still exists and is the one named (a `%N` id is never reused while the server lives). */
export async function paneAlive(pane: string): Promise<boolean> {
  const r = await tmux(['display-message', '-p', '-t', pane, '#{pane_id}'])
  return r.code === 0 && r.out.trim() === pane
}

/** Wake the host: bracketed paste (a multi-line prompt stays one prompt), then Enter. */
export async function pasteInto(pane: string, text: string): Promise<{ text?: string; drop?: string }> {
  if (!(await paneAlive(pane))) return { drop: `host pane ${pane} is gone` }
  const buffer = `tmux-agent-collector-${process.pid}`
  const steps: [string[], string?][] = [
    [['load-buffer', '-b', buffer, '-'], text],
    [['paste-buffer', '-p', '-d', '-b', buffer, '-t', pane]],
    [['send-keys', '-t', pane, 'Enter']],
  ]
  for (const [args, input] of steps) {
    const r = await tmux(args, input)
    if (r.code !== 0) return { drop: `tmux ${args[0]} into ${pane} failed (exit ${r.code}): ${r.err.trim().slice(-200)}` }
  }
  return { text }
}

function usage(why: string): never {
  process.stderr.write(`tmux-agent-collector: ${why}\nusage: node collector.node.ts --session <id> --cwd <dir> --pane <%N> [--socket <abs>] [--once]\n`)
  process.exit(2)
}

async function main(): Promise<void> {
  const have = process.versions.node.split('.').map(Number)
  const below = NODE_FLOOR.findIndex((n, i) => have[i]! !== n) // first differing part decides
  if (below >= 0 && have[below]! < NODE_FLOOR[below]!) usage(`node ${process.versions.node} is below the floor ${NODE_FLOOR.join('.')}`)
  let values: { session?: string; cwd?: string; pane?: string; once?: boolean; socket?: string }
  try {
    ;({ values } = parseArgs({
      options: {
        session: { type: 'string' },
        cwd: { type: 'string' },
        pane: { type: 'string' },
        once: { type: 'boolean' },
        socket: { type: 'string' },
      },
    }))
  } catch (error) {
    usage(String((error as Error).message))
  }
  const { session, cwd, pane, once, socket } = values
  if (socket) {
    if (!socket.startsWith('/')) usage('--socket must be an absolute path')
    process.env.TMUX_AGENT_TMUX_SOCKET = socket
    delete process.env.TMUX
    delete process.env.TMUX_PANE
  }
  if (!session) usage('--session is required: a collector without a session id would own everything (§3)')
  if (!cwd || !cwd.startsWith('/')) usage('--cwd must be an absolute path')
  if (!pane || !/^%\d+$/.test(pane)) usage('--pane must be a tmux pane id like %3')
  const log = (text: string) => process.stderr.write(`${new Date().toISOString()} ${text}\n`)
  const host = nodeHost({ owner: session, cwd, log, submit: text => pasteInto(pane, text) })
  const gate = newGate()
  const stopIfPaused = () => {
    if (!gate.paused) return
    log(`tmux-agent-collector: paused — ${gate.paused}`)
    process.exit(1)
  }
  if (once) {
    await reconcileOnce(host, gate)
    stopIfPaused()
    return
  }
  // The beat has its own clock, as in the mod: a slow pass must not let a peer adopt (§4).
  const beat = setInterval(() => {
    if (!gate.paused) void heartbeat(host, gate).catch(error => log(`tmux-agent-collector: beat failed: ${String(error)}`))
  }, POLL_MS)
  for (;;) {
    if (!(await paneAlive(pane))) {
      log(`tmux-agent-collector: host pane ${pane} is gone; exiting`)
      clearInterval(beat)
      return
    }
    await reconcileOnce(host, gate).catch(error => log(`tmux-agent-collector: pass failed: ${String(error)}`))
    stopIfPaused()
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
