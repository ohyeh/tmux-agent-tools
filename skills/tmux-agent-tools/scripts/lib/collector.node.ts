// The collector for a host without function hooks (Codex, agy, Cursor, any tmux CLI):
// one node process per host session (p0-contract.md §9). Same ledger, same
// `reconcileOnce` and `heartbeat` as the Claude mod; only the wake differs — a
// bracketed paste into the host's exact tmux pane id, then Enter.
//
// Usage: node collector.node.ts --session <id> --cwd <dir> --pane <%N> [--socket <abs>] [--nonce <s>] [--once]
//   --session  the host session id this collector delivers for (required, §3)
//   --cwd      the project dir; orphans are adoptable only in the same cwd (required, §3)
//   --pane     the host pane, as `%N` (required: a name or index can point elsewhere)
//   --nonce    the launcher's token for this one start, copied into collector.json
//   --once     one reconcile pass, then exit (tests, cron)
// Exit: 0 when the pane is gone or --once finished; 1 when the collector paused
// (superseded by a newer activation, or refused deliveries) or could not get ready;
// 2 on bad arguments.
//
// Readiness (plan D-collector-id): without --once, the collector reads its core version
// (`AGENT_TMUX_VERSION` of `../agent-tmux`; a read or parse error is not ready), then
// registers and beats its activation (§4): a beat that is not written is not ready.
// Only then it publishes `<sessionDir>/collector.json` (temp + rename):
// `{pid, pidStart, host, session, pane, socket, cwd, coreVersion, token, nonce}`.
// `socket` is the tmux server's `#{socket_path}` as this process resolves it. A record
// proves a ready collector only while its pid still runs with that pidStart (the
// launcher checks both), and a launcher that started it accepts only its own `nonce`.
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { nodeHost } from './host.node.ts'
import { heartbeat, newGate, POLL_MS, processId, reconcileOnce, rootOf, sessionDirOf, v3Of } from './workers.ts'

const NODE_FLOOR = [22, 18, 0]
const TMUX_MS = 5_000

function tmux(args: string[], input?: string, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; out: string; err: string }> {
  const sock = env.TMUX_AGENT_TMUX_SOCKET
  const full = sock && args[0] !== '-S' && args[0] !== '-L' ? ['-S', sock, ...args] : args
  return new Promise(resolve => {
    const child = execFile('tmux', full, { timeout: TMUX_MS, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, out: stdout, err: stderr || (error ? String(error) : '') })
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

/** The pane still exists and is the one named (a `%N` id is never reused while the server lives). */
export async function paneAlive(pane: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const r = await tmux(['display-message', '-p', '-t', pane, '#{pane_id}'], undefined, env)
  return r.code === 0 && r.out.trim() === pane
}

/** Wake the host: bracketed paste (a multi-line prompt stays one prompt), then Enter. */
export async function pasteInto(pane: string, text: string, env: NodeJS.ProcessEnv = process.env): Promise<{ text?: string; drop?: string }> {
  if (!(await paneAlive(pane, env))) return { drop: `host pane ${pane} is gone` }
  const buffer = `tmux-agent-collector-${process.pid}`
  const steps: [string[], string?][] = [
    [['load-buffer', '-b', buffer, '-'], text],
    [['paste-buffer', '-p', '-d', '-b', buffer, '-t', pane]],
    [['send-keys', '-t', pane, 'Enter']],
  ]
  for (const [args, input] of steps) {
    const r = await tmux(args, input, env)
    if (r.code !== 0) return { drop: `tmux ${args[0]} into ${pane} failed (exit ${r.code}): ${r.err.trim().slice(-200)}` }
  }
  return { text }
}

/** The tmux server this process reaches for `pane`: its socket path, or `undefined`. */
export async function serverSocket(pane: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const r = await tmux(['display-message', '-p', '-t', pane, '#{socket_path}'], undefined, env)
  return r.code === 0 && r.out.trim().startsWith('/') ? r.out.trim() : undefined
}

/** `collector.json`: published once, after the readiness handshake. */
export type CollectorRecord = {
  pid: number
  pidStart: string
  host: string
  session: string
  pane: string
  socket: string
  cwd: string
  coreVersion: string
  token: string
  /** The `--nonce` of the start that published it (absent when started without one). */
  nonce?: string
}

/**
 * The record as published; `undefined` only when it is absent (ENOENT). A read error,
 * bad JSON or an incomplete record throws, naming the path: it is unknown, not absent.
 */
export async function readCollectorRecord(path: string): Promise<CollectorRecord | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`${path}: ${String(error)}`)
  }
  let r: CollectorRecord
  try {
    r = JSON.parse(text) as CollectorRecord
  } catch (error) {
    throw new Error(`${path} is not JSON (${(error as Error).message})`)
  }
  const strings = [r?.pidStart, r?.host, r?.session, r?.pane, r?.socket, r?.cwd, r?.token]
  if (Number.isInteger(r?.pid) && r.pid > 0 && strings.every(v => typeof v === 'string' && v)) return r
  throw new Error(`${path} is not a complete collector record`)
}

/** `AGENT_TMUX_VERSION` of the wrapper beside lib/, the version every install ships. Throws with the path. */
async function coreVersion(): Promise<string> {
  const path = fileURLToPath(new URL('../agent-tmux', import.meta.url))
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`could not read the core version from ${path}: ${String(error)}`)
  }
  const version = /^AGENT_TMUX_VERSION='([^']+)'$/m.exec(text)?.[1]
  if (!version) throw new Error(`${path} has no AGENT_TMUX_VERSION='…' line`)
  return version
}

function usage(why: string): never {
  process.stderr.write(`tmux-agent-collector: ${why}\nusage: node collector.node.ts --session <id> --cwd <dir> --pane <%N> [--socket <abs>] [--nonce <s>] [--once]\n`)
  process.exit(2)
}

async function main(): Promise<void> {
  const have = process.versions.node.split('.').map(Number)
  const below = NODE_FLOOR.findIndex((n, i) => have[i]! !== n) // first differing part decides
  if (below >= 0 && have[below]! < NODE_FLOOR[below]!) usage(`node ${process.versions.node} is below the floor ${NODE_FLOOR.join('.')}`)
  let values: { session?: string; cwd?: string; pane?: string; once?: boolean; socket?: string; nonce?: string }
  try {
    ;({ values } = parseArgs({
      options: {
        session: { type: 'string' },
        cwd: { type: 'string' },
        pane: { type: 'string' },
        once: { type: 'boolean' },
        socket: { type: 'string' },
        nonce: { type: 'string' },
      },
    }))
  } catch (error) {
    usage(String((error as Error).message))
  }
  const { session, cwd, pane, once, socket, nonce } = values
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
  gate.channel = 'node' // act/<n>.state (C-health): written by heartbeat and the refusal pause
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
  function notReady(why: string): never {
    log(`tmux-agent-collector: not ready — ${why}; exiting`)
    process.exit(1)
  }
  // Before registering: a start that cannot get ready must not fence the running activation.
  let version = ''
  try {
    version = await coreVersion()
  } catch (error) {
    notReady((error as Error).message)
  }
  if (!(await heartbeat(host, gate))) notReady(gate.paused ?? 'could not register or beat this activation (see above)')
  const me = await processId(host)
  if (me.pid !== process.pid || !me.pidStart || !me.host) notReady(`could not read this process's own id (got pid ${me.pid || '?'})`)
  const sock = await serverSocket(pane)
  if (!sock) notReady(`could not read the tmux socket path of pane ${pane}`)
  const root = (await rootOf(host))!
  const record: CollectorRecord = {
    pid: process.pid,
    pidStart: me.pidStart,
    host: me.host,
    session,
    pane,
    socket: sock,
    cwd,
    coreVersion: version,
    token: gate.token,
    ...(nonce ? { nonce } : {}),
  }
  const path = `${sessionDirOf(v3Of(root), session)}/collector.json`
  try {
    await writeFile(`${path}.${process.pid}.tmp`, JSON.stringify(record))
    await rename(`${path}.${process.pid}.tmp`, path)
  } catch (error) {
    notReady(`could not publish ${path}: ${String(error)}`)
  }
  log(`tmux-agent-collector: ready — activation ${gate.activation}, pane ${pane}, socket ${sock}`)
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

// The module URL is the real path (symlinks resolved, `%20` for a space); argv[1] is as typed.
const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false // imported by a process whose argv[1] is not a file
  }
})()
if (isMain) await main()
