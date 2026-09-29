// Open the workers TUI beside the host CLI. Deliveries stay on the host pane.
//
//   node launcher.node.ts --session <id> --cwd <abs> [--pane %N] -- <tui command…>
//
// The host pane is `--pane`, or `$TMUX_PANE` when `--pane` is omitted. It must
// match `%N` and it must be alive (exit 2 otherwise). The TUI is a horizontal
// split of that pane (`split-window -h -d`), not a popup: a popup is an overlay
// on one client, not a second pane that can be focused, captured, and closed
// on its own. `-d` leaves the host pane current. Focus cannot steer a delivery:
// the one collector for this session is always started with `--pane <host>`,
// and collector.node.ts pastes with `paste-buffer -t` that id (p0-contract §9).
//
// "Running" is `<sessionDir>/collector.pid`, one line `<pid> <pane>`. The
// session dir is the ledger's `<root>/.v3/.sessions/<hex(session)>`. The pid
// is running when `ps` shows that pid's command is `collector.node.ts` with
// this `--session` and this host `--pane`. A missing file, a dead pid, a pid
// reused by another command, or a file that does not parse is stale: it is
// replaced and a collector is started. A live collector whose pane is not the
// host pane is stopped and replaced, so a relaunch cannot keep pasting at a
// pane that is no longer the host. `collector.log` in the same directory is
// that process's stderr (including `host pane %N is gone`).
//
// The check-and-spawn sits inside the directory `collector.lock` (`mkdir`).
// ponytail: a lock older than 5s is removed. Ceiling: a launcher stuck inside
// the lock for longer than that can be stolen and start a second collector.
// Upgrade: write the holder pid in the lock and steal only when that pid is dead.
// ponytail: `ps` output is split on spaces, so a collector path that contains a
// space can look stale and a second collector can start. Upgrade: match the
// pid's argv from a null-delimited source.
//
// Closing the TUI does not stop the collector (detached; this process watches
// only the host pane). When the host pane vanishes, the collector exits on its
// own and this process exits 1 with `host pane %N is gone`. tmux commands use
// the caller's server (`$TMUX`, otherwise the default socket). A host that is
// not in tmux has nothing to split and nothing to paste into.
import { execFile, spawn } from 'node:child_process'
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { paneAlive } from './collector.node.ts'
import { nodeHost } from './host.node.ts'
import { rootOf, sessionDirOf, v3Of } from './workers.ts'

const NODE_FLOOR = [22, 18, 0]
const LOCK_STALE_MS = 5_000
const COLLECTOR = new URL('./collector.node.ts', import.meta.url).pathname
const USAGE = 'usage: node launcher.node.ts --session <id> --cwd <abs> [--pane %N] -- <tui command…>'

function usage(why: string): never {
  process.stderr.write(`tmux-agent-launcher: ${why}\n${USAGE}\n`)
  process.exit(2)
}

function die(why: string): never {
  process.stderr.write(`tmux-agent-launcher: ${why}\n`)
  process.exit(1)
}

function tmux(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    execFile('tmux', args, { timeout: 5_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        out: stdout ?? '',
        err: stderr || (error ? String(error) : ''),
      })
    })
  })
}

function commandOf(pid: number): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined)
    })
  })
}

function hasArg(command: string, name: string, value: string): boolean {
  const parts = command.split(' ')
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === name && parts[i + 1] === value) return true
    if (parts[i] === `${name}=${value}`) return true
  }
  return false
}

type Identity = 'match' | 'wrong-pane' | 'dead' | 'other'

async function identify(pid: number, session: string, pane: string): Promise<Identity> {
  const command = await commandOf(pid)
  if (!command) return 'dead'
  if (!command.includes('collector.node.ts') || !hasArg(command, '--session', session)) return 'other'
  return hasArg(command, '--pane', pane) ? 'match' : 'wrong-pane'
}

async function readPidFile(path: string): Promise<{ pid: number; pane: string } | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const [pidText, pane] = text.trim().split(/\s+/)
  const pid = Number(pidText)
  if (!Number.isInteger(pid) || pid <= 0 || !pane) return undefined
  return { pid, pane }
}

async function acquire(lock: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await mkdir(lock)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const st = await stat(lock).catch(() => undefined)
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true })
        continue
      }
      await new Promise(r => setTimeout(r, 20))
    }
  }
  throw new Error(`collector lock held: ${lock}`)
}

async function ensureCollector(
  session: string,
  cwd: string,
  pane: string,
  root: string,
): Promise<{ pid: number; reused: boolean }> {
  const dir = sessionDirOf(v3Of(root), session)
  await mkdir(dir, { recursive: true })
  const lock = `${dir}/collector.lock`
  const pidPath = `${dir}/collector.pid`
  await acquire(lock)
  try {
    const cur = await readPidFile(pidPath)
    if (cur) {
      const kind = await identify(cur.pid, session, pane)
      if (kind === 'match') return { pid: cur.pid, reused: true }
      if (kind === 'wrong-pane') {
        try {
          process.kill(cur.pid, 'SIGTERM')
        } catch {
          // already dead: the pid file is the stale case below
        }
      }
    }
    const log = await open(`${dir}/collector.log`, 'a')
    const child = spawn(process.execPath, [COLLECTOR, '--session', session, '--cwd', cwd, '--pane', pane], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: process.env,
    })
    child.unref()
    await log.close()
    if (!child.pid) throw new Error('collector did not start')
    await writeFile(pidPath, `${child.pid} ${pane}\n`)
    return { pid: child.pid, reused: false }
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

async function splitTui(hostPane: string, cwd: string, command: string[]): Promise<string> {
  const r = await tmux(['split-window', '-t', hostPane, '-h', '-d', '-c', cwd, '-P', '-F', '#{pane_id}', ...command])
  if (r.code !== 0) die(`could not open the TUI pane: ${r.err.trim().slice(-400) || `tmux exit ${r.code}`}`)
  const id = r.out.trim()
  if (!/^%\d+$/.test(id)) die(`split did not name a pane id (got ${JSON.stringify(id)})`)
  return id
}

async function main(): Promise<void> {
  const have = process.versions.node.split('.').map(Number)
  const below = NODE_FLOOR.findIndex((n, i) => have[i]! !== n)
  if (below >= 0 && have[below]! < NODE_FLOOR[below]!) usage(`node ${process.versions.node} is below the floor ${NODE_FLOOR.join('.')}`)
  let values: { session?: string; cwd?: string; pane?: string }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      options: { session: { type: 'string' }, cwd: { type: 'string' }, pane: { type: 'string' } },
      allowPositionals: true,
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (error) {
    usage((error as Error).message)
  }
  const { session, cwd } = values
  const pane = values.pane ?? process.env.TMUX_PANE
  if (!session) usage('--session is required')
  if (!cwd || !cwd.startsWith('/')) usage('--cwd must be an absolute path')
  if (positionals.length === 0) usage('a TUI command is required after --')
  if (!pane || !/^%\d+$/.test(pane)) usage(`--pane must be a tmux pane id like %3 (got ${pane ?? 'nothing'})`)
  if (!(await paneAlive(pane))) usage(`host pane ${pane} is not alive`)
  const root = await rootOf(nodeHost())
  if (!root) usage('no state root (set TMUX_AGENT_DIR, XDG_STATE_HOME, or HOME)')
  const ensured = await ensureCollector(session, cwd, pane, root)
  const tui = await splitTui(pane, cwd, positionals)
  process.stdout.write(
    `tmux-agent-launcher: tui ${tui} beside host ${pane}; collector ${ensured.pid} ${ensured.reused ? 'reused' : 'started'}\n`,
  )
  for (;;) {
    if (!(await paneAlive(pane))) {
      process.stderr.write(`tmux-agent-launcher: host pane ${pane} is gone\n`)
      process.exit(1)
    }
    await new Promise(r => setTimeout(r, 200))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    process.stderr.write(`tmux-agent-launcher: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
