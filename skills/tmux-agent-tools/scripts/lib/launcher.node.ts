// Open the workers TUI beside the host CLI. Deliveries stay on the host pane.
//
//   node launcher.node.ts --session <id> --cwd <abs> [--pane %N] -- <tui command…>
//   node launcher.node.ts --unlock-launcher <session> [--yes]
//   node launcher.node.ts --migrate-launcher <session> [--yes]
//
// The host pane is `--pane`, or `$TMUX_PANE` when `--pane` is omitted. It must
// match `%N` and it must be alive (exit 2 otherwise). The TUI is a horizontal
// split of that pane (`split-window -h -d`), not a popup: a popup is an overlay
// on one client, not a second pane that can be focused, captured, and closed
// on its own. `-d` leaves the host pane current. Focus cannot steer a delivery:
// the one collector for this session is always started with `--pane <host>`,
// and collector.node.ts pastes with `paste-buffer -t` that id (p0-contract §9).
//
// Files, in the session dir `<root>/.v3/.sessions/<hex(session)>`:
// - `collector.owner`: the launcher lock, the core action lock (ledger.ts
//   `acquireLock`): one `ln -sn` whose target is the holder `{token, session,
//   host, pid, pidStart}`. The check-and-spawn runs inside it. It is never taken
//   over: a held lock is waited for while its holder provably runs, otherwise the
//   launcher stops with busy, the holder, and the maintenance command. Only the
//   holder releases it (token check), so an old holder's `finally` cannot remove
//   a newer lock.
// - `collector.json`: the collector's own record (collector.node.ts), published
//   after its readiness handshake. A collector is "running" only when that record
//   names this session, pane, tmux socket path and cwd, and its pid provably runs
//   with the recorded start time. A different pane, socket or cwd: SIGTERM, wait
//   for it to exit (a straggler is fenced by the new activation, §4), then start
//   one. Dead or reused pid: start one. Unprovable (EPERM, ps error), or a record
//   that cannot be read or parsed (only ENOENT is absent): busy.
//   A started collector counts only after it publishes its record with this start's
//   `--nonce`, its own pid, and a start time that pid provably runs with; an early
//   exit, a spawn error, a record read error, or no record in time is an error (the
//   child is stopped), and nothing is written for it.
// - `collector.log`: the collector's stderr (including `host pane %N is gone`).
// - Legacy (the launcher before plan R6): a `collector.lock` dir and a
//   `collector.pid` file. While either exists the launcher does nothing but name
//   `--migrate-launcher`, which moves them (never deletes) into `legacy-<ts>/`
//   once `ps` shows no launcher or collector process for this session (its own
//   parent included) and no descendant of one. Limit: that `ps` is one snapshot
//   and the old launcher takes no lock, so nothing fences an old launcher started
//   after it; `--yes` is the operator's confirmation that none will start.
//
// `--unlock-launcher` removes `collector.owner` only when its holder is provably
// gone (dead pid, or the pid runs with another start time) and `--yes` is given.
// It reads, checks and removes inside `collector.owner.unlock` (ledger.ts
// `maintainLock`), so two unlocks cannot remove a newer holder's lock; that lock
// is never taken over either (a dead one is busy, and removed by hand).
// Both maintenance commands print what they would do without `--yes`.
//
// Closing the TUI does not stop the collector (detached; this process watches
// only the host pane). When the host pane vanishes, the collector exits on its
// own and this process exits 1 with `host pane %N is gone`. Without `--socket`,
// tmux commands use the caller's server (`$TMUX`, otherwise the default socket).
// `--socket <abs>` puts `-S` on every tmux call and does not pass `TMUX` or
// `TMUX_PANE` to the collector. The split pane gets `TMUX_AGENT_SESSION` (the
// same id as the collector) and, when a socket was given, `TMUX_AGENT_TMUX_SOCKET`.
// A host that is not in tmux has nothing to split and nothing to paste into.
import { execFile, spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { paneAlive, readCollectorRecord, serverSocket, type CollectorRecord } from './collector.node.ts'
import { nodeHost } from './host.node.ts'
import { acquireLock, maintainLock, probeHolder, releaseLock, type Holder } from './ledger.ts'
import { holderProvablyAlive, processId, randomBase36, rootOf, sessionDirOf, unlockBusyText, v3Of, type Host } from './workers.ts'

const NODE_FLOOR = [22, 18, 0]
/** How long a launcher waits for a lock whose holder provably runs (the holder's check-and-spawn). */
const LOCK_WAIT_MS = 20_000
const READY_MS = 15_000
const EXIT_WAIT_MS = 5_000
const COLLECTOR = fileURLToPath(new URL('./collector.node.ts', import.meta.url))
const LEGACY = ['collector.lock', 'collector.pid'] as const
const USAGE = [
  'usage: node launcher.node.ts --session <id> --cwd <abs> [--pane %N] [--socket <abs>] -- <tui command…>',
  '       node launcher.node.ts --unlock-launcher <session> [--yes]',
  '       node launcher.node.ts --migrate-launcher <session> [--yes]',
].join('\n')

export type Outcome = { ok: boolean; text: string }

function usage(why: string): never {
  process.stderr.write(`tmux-agent-launcher: ${why}\n${USAGE}\n`)
  process.exit(2)
}

function die(why: string): never {
  process.stderr.write(`tmux-agent-launcher: ${why}\n`)
  process.exit(1)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
export const unlockCommand = (session: string) => `tmux-agent-tui --unlock-launcher ${shq(session)} --yes`
export const migrateCommand = (session: string) => `tmux-agent-tui --migrate-launcher ${shq(session)} --yes`

function tmux(args: string[], socket?: string): Promise<{ code: number; out: string; err: string }> {
  const full = socket ? ['-S', socket, ...args] : args
  return new Promise(resolve => {
    execFile('tmux', full, { timeout: 5_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        out: stdout ?? '',
        err: stderr || (error ? String(error) : ''),
      })
    })
  })
}

function holderText(h: Holder, alive: boolean | undefined): string {
  const state = alive === true ? 'still running' : alive === false ? 'gone (its pid is dead or runs another process)' : 'not provably alive or dead'
  return `pid ${h.pid || '?'} on ${h.host || '?'} (started ${h.pidStart || '?'}, session ${h.session || '?'}): ${state}`
}

/** The legacy launcher files present in `dir`. ENOENT is absent; any other stat error throws. */
async function legacyFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const name of LEGACY) {
    try {
      await stat(`${dir}/${name}`)
      found.push(name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return found
}

/**
 * Take `<dir>/collector.owner` for this process. Waits only while the holder provably
 * runs; a dead, unprovable or unreadable holder is reported, never taken over (§5).
 */
export async function takeLauncherLock(host: Host, dir: string, session: string): Promise<string> {
  const me = await processId(host)
  if (!(me.pid > 0 && me.pidStart && me.host)) throw new Error('could not read this process id (ps); not taking a lock that nobody could later prove dead')
  const holder: Holder = { token: randomBase36(12), session, activation: 'launcher', ...me }
  const lock = `${dir}/collector.owner`
  const deadline = Date.now() + LOCK_WAIT_MS
  for (let unknown = 0; ; ) {
    const r = await acquireLock(host, lock, holder)
    if (r.ok) return r.token
    if (r.busy === 'unknown') {
      // Released between our `ln` and its `readlink`, or `ln` failed (see the log): a few tries only.
      if (++unknown < 3) continue
      throw new Error(`could not take ${lock}: its state is unknown (see the log above)`)
    }
    const alive = r.busy === 'unreadable' ? undefined : await holderProvablyAlive(host, r.busy)
    if (alive === true && Date.now() < deadline) {
      await sleep(100)
      continue
    }
    const who = r.busy === 'unreadable' ? 'an unreadable holder' : holderText(r.busy, alive)
    throw new Error(
      `busy: the launcher lock ${lock} is held by ${who}. A launcher never takes this lock over. ` +
        `If no launcher for this session is running, run: ${unlockCommand(session)}`,
    )
  }
}

async function logTail(path: string): Promise<string> {
  const text = await readFile(path, 'utf8').catch((error: unknown) => `(could not read ${path}: ${String(error)})`)
  return text.trim().slice(-400) || '(empty log)'
}

type Want = { session: string; cwd: string; pane: string; socket: string }
const sameCollector = (r: CollectorRecord, w: Want) => r.session === w.session && r.pane === w.pane && r.socket === w.socket && r.cwd === w.cwd

/** SIGTERM a provably running collector and wait a bounded time for it to exit. */
async function stopCollector(host: Host, r: CollectorRecord): Promise<boolean> {
  try {
    process.kill(r.pid, 'SIGTERM')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return true
    throw new Error(`busy: could not stop collector ${r.pid} (pane ${r.pane}): ${code ?? String(error)}`)
  }
  const deadline = Date.now() + EXIT_WAIT_MS
  while (Date.now() < deadline) {
    if ((await holderProvablyAlive(host, r)) === false) return true
    await sleep(100)
  }
  return false
}

async function startCollector(host: Host, dir: string, want: Want, explicitSocket: string | undefined): Promise<number> {
  const logPath = `${dir}/collector.log`
  let log
  try {
    log = await open(logPath, 'a')
  } catch (error) {
    throw new Error(`could not open ${logPath}: ${(error as Error).message}; no collector started`)
  }
  // This start's token: a record left by any other start (a dead collector whose pid
  // the child reuses) cannot carry it.
  const nonce = randomBase36(16)
  const args = [COLLECTOR, '--session', want.session, '--cwd', want.cwd, '--pane', want.pane, '--nonce', nonce]
  const env = { ...process.env }
  if (explicitSocket) {
    args.push('--socket', explicitSocket)
    delete env.TMUX
    delete env.TMUX_PANE
    env.TMUX_AGENT_TMUX_SOCKET = explicitSocket
  }
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log.fd, log.fd], env })
  const ended = new Promise<string>(resolve => {
    child.once('error', error => resolve(`could not start: ${error.message}`))
    child.once('exit', (code, signal) => resolve(`exited (${signal ?? `code ${code}`}) before it was ready`))
  })
  child.unref()
  await log.close()
  const deadline = Date.now() + READY_MS
  try {
    for (;;) {
      const why = await Promise.race([ended, sleep(100).then(() => undefined)])
      if (why) throw new Error(`the collector ${why}; collector.log: ${await logTail(logPath)}`)
      // Only a confirmed-absent record is waited for; any other read error is the answer.
      let rec: CollectorRecord | undefined
      try {
        rec = await readCollectorRecord(`${dir}/collector.json`)
      } catch (error) {
        child.kill('SIGTERM')
        throw new Error(`could not read the record of collector ${child.pid ?? '?'}: ${(error as Error).message}; stopped it. collector.log: ${await logTail(logPath)}`)
      }
      if (child.pid && rec?.nonce === nonce && rec.pid === child.pid && sameCollector(rec, want) && (await holderProvablyAlive(host, rec)) === true) {
        return child.pid
      }
      if (Date.now() > deadline) {
        child.kill('SIGTERM')
        throw new Error(`collector ${child.pid ?? '?'} published no collector.json within ${READY_MS / 1000}s; stopped it. collector.log: ${await logTail(logPath)}`)
      }
    }
  } finally {
    child.removeAllListeners()
  }
}

/**
 * The one collector for this session, inside the launcher lock: reuse a ready one
 * for this pane, socket and cwd; otherwise stop the old one (if any) and start one.
 */
export async function ensureCollector(
  host: Host,
  opts: { session: string; cwd: string; pane: string; root: string; socket?: string },
): Promise<{ pid: number; reused: boolean; replaced?: { pid: number; exited: boolean } }> {
  const dir = sessionDirOf(v3Of(opts.root), opts.session)
  await mkdir(dir, { recursive: true })
  const token = await takeLauncherLock(host, dir, opts.session)
  try {
    const legacy = await legacyFiles(dir)
    if (legacy.length) {
      throw new Error(
        `busy: ${dir} has files of the launcher before plan R6 (${legacy.join(', ')}); an old launcher or collector may still run. ` +
          `Nothing is started. Run: ${migrateCommand(opts.session)}`,
      )
    }
    const socket = await serverSocket(opts.pane)
    if (!socket) throw new Error(`could not read the tmux socket path of pane ${opts.pane}`)
    const want: Want = { session: opts.session, cwd: opts.cwd, pane: opts.pane, socket }
    let cur: CollectorRecord | undefined
    try {
      cur = await readCollectorRecord(`${dir}/collector.json`)
    } catch (error) {
      throw new Error(
        `busy: ${(error as Error).message}; a collector may still run, so none is started. ` +
          `If none runs for this session, move ${dir}/collector.json aside and launch again`,
      )
    }
    let replaced: { pid: number; exited: boolean } | undefined
    if (cur) {
      const alive = await holderProvablyAlive(host, cur)
      if (alive === undefined) {
        throw new Error(`busy: collector ${cur.pid} (collector.json) is not provably alive or dead; not starting a second one`)
      }
      if (alive && sameCollector(cur, want)) return { pid: cur.pid, reused: true }
      if (alive) replaced = { pid: cur.pid, exited: await stopCollector(host, cur) }
    }
    return { pid: await startCollector(host, dir, want, opts.socket), reused: false, replaced }
  } finally {
    await releaseLock(host, `${dir}/collector.owner`, token)
  }
}

/**
 * `--unlock-launcher`: remove `collector.owner` only when its holder is provably gone.
 * The read, the check and the rm run inside the lock's maintenance section.
 */
export async function unlockLauncher(host: Host, root: string, session: string, yes: boolean): Promise<Outcome> {
  const lock = `${sessionDirOf(v3Of(root), session)}/collector.owner`
  // Absent or unreadable: nothing is removed, so it is answered outside the section.
  const pre = await probeHolder(host, lock)
  if (!('holder' in pre)) return unlockHeld(host, lock, session, yes, pre)
  const me = await processId(host)
  if (!(me.pid > 0 && me.pidStart && me.host)) return { ok: false, text: 'busy: could not read this process id (ps); not unlocking' }
  const m = await maintainLock(host, lock, { token: randomBase36(12), session, activation: 'unlock', ...me }, async () =>
    unlockHeld(host, lock, session, yes, await probeHolder(host, lock)),
  )
  return m.ok ? m.value : { ok: false, text: await unlockBusyText(host, m) }
}

async function unlockHeld(host: Host, lock: string, session: string, yes: boolean, p: Awaited<ReturnType<typeof probeHolder>>): Promise<Outcome> {
  if ('absent' in p) return { ok: true, text: `${lock} is not held; nothing to unlock` }
  if ('unreadable' in p) return { ok: false, text: `busy: ${p.unreadable}; not removing it` }
  const h = p.holder
  const alive = await holderProvablyAlive(host, h)
  const who = holderText(h, alive)
  if (alive !== false) return { ok: false, text: `not unlocking ${lock}: its holder is ${who}` }
  if (!yes) return { ok: false, text: `${lock} is held by ${who}. To remove it, run: ${unlockCommand(session)}` }
  if (!(await releaseLock(host, lock, h.token))) return { ok: false, text: `${lock} changed while checking; nothing removed` }
  return { ok: true, text: `unlocked ${lock} (its holder ${who})` }
}

type Proc = { pid: number; ppid: number; line: string }

/** Every process with its parent and full args (`ps -o pid=,ppid=,lstart=,args=`); `undefined` = ps failed. */
function processes(): Promise<Proc[] | undefined> {
  return new Promise(resolve => {
    execFile(
      'ps',
      ['-ax', '-ww', '-o', 'pid=,ppid=,lstart=,args='],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
      (error, stdout) => {
        if (error) return resolve(undefined)
        const procs: Proc[] = []
        for (const raw of stdout.split('\n')) {
          const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(raw)
          if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), line: m[3]! })
        }
        resolve(procs)
      },
    )
  })
}

/**
 * `--migrate-launcher` (plan §1c S2): move the legacy `collector.lock` / `collector.pid`
 * (and `collector.log`) into `legacy-<ts>/`, never delete them. Only when `ps` shows no
 * launcher or collector process naming this session (a substring match on the full
 * args: any hit is busy, this process's parent and other ancestors included), no
 * descendant of one, and the legacy pid is provably dead or provably not a collector.
 * The scan is one snapshot and old code takes no lock, so `--yes` also confirms that
 * no old launcher starts meanwhile (no fence can enforce it).
 */
export async function migrateLauncher(host: Host, root: string, session: string, yes: boolean): Promise<Outcome> {
  const dir = sessionDirOf(v3Of(root), session)
  const legacy = await legacyFiles(dir)
  if (!legacy.length) return { ok: true, text: `${dir} has no legacy launcher files; nothing to migrate` }
  let token: string
  try {
    token = await takeLauncherLock(host, dir, session)
  } catch (error) {
    return { ok: false, text: (error as Error).message }
  }
  try {
    const procs = await processes()
    if (!procs) return { ok: false, text: 'busy: ps -o pid=,ppid=,lstart=,args= failed; cannot prove that no old launcher runs' }
    // Only this process is left out: a matching parent is an old launcher too.
    const hits = procs.filter(
      p => p.pid !== process.pid && p.line.includes(session) && (p.line.includes('launcher.node.ts') || p.line.includes('collector.node.ts')),
    )
    if (hits.length) {
      // Their descendants by ppid (a dead launcher's orphans are reparented and not found).
      const seen = new Set(hits.map(p => p.pid))
      const tree = [...hits]
      for (let i = 0; i < tree.length; i++) {
        for (const p of procs) {
          if (p.ppid !== tree[i]!.pid || seen.has(p.pid) || p.pid === process.pid) continue
          seen.add(p.pid)
          tree.push(p)
        }
      }
      const kids = tree.slice(hits.length)
      const list = (ps: Proc[]) => ps.map(p => `pid ${p.pid}: ${p.line.slice(0, 200)}`).join('; ')
      return {
        ok: false,
        text:
          `busy: a launcher or collector for session ${session} still runs: ${list(hits)}` +
          `${kids.length ? `; and its descendants: ${list(kids)}` : ''}. ` +
          'Confirm it is the old one, stop it (SIGTERM), then migrate again',
      }
    }
    const pidText = await readFile(`${dir}/collector.pid`, 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? '' : undefined))
    if (pidText === undefined) return { ok: false, text: `busy: ${dir}/collector.pid cannot be read` }
    const pid = Number(pidText.trim().split(/\s+/)[0])
    if (Number.isInteger(pid) && pid > 0) {
      let gone = false
      try {
        process.kill(pid, 0)
      } catch (error) {
        gone = (error as NodeJS.ErrnoException).code === 'ESRCH'
      }
      const seen = procs.find(p => p.pid === pid)
      if (!gone && (!seen || seen.line.includes('collector.node.ts'))) {
        return { ok: false, text: `busy: the legacy collector pid ${pid} may still run (${seen ? seen.line.slice(0, 200) : 'not listed by ps'}); confirm, SIGTERM it, then migrate again` }
      }
    }
    const moving = [...legacy, ...((await stat(`${dir}/collector.log`).then(() => true, () => false)) ? ['collector.log'] : [])]
    if (!yes) {
      return {
        ok: false,
        text:
          `would move ${moving.join(', ')} from ${dir} into legacy-<time>/. This ps check is one snapshot and the old launcher ` +
          `takes no lock: confirm that no old launcher or collector for this session will start, then run: ${migrateCommand(session)}`,
      }
    }
    const dest = `${dir}/legacy-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await mkdir(dest)
    for (const name of moving) await rename(`${dir}/${name}`, `${dest}/${name}`)
    return { ok: true, text: `moved ${moving.join(', ')} into ${dest}; the next launch starts a new collector` }
  } finally {
    await releaseLock(host, `${dir}/collector.owner`, token)
  }
}

async function splitTui(hostPane: string, cwd: string, command: string[], session: string, root: string, socket?: string): Promise<string> {
  // The pane's environment is the tmux session's, not this process's. The collector
  // was started with this root; the TUI has to see the same ledger.
  const args = [
    'split-window', '-t', hostPane, '-h', '-d', '-c', cwd, '-P', '-F', '#{pane_id}',
    '-e', `TMUX_AGENT_SESSION=${session}`,
    '-e', `TMUX_AGENT_DIR=${root}`,
  ]
  if (socket) args.push('-e', `TMUX_AGENT_TMUX_SOCKET=${socket}`)
  const r = await tmux([...args, ...command], socket)
  if (r.code !== 0) die(`could not open the TUI pane: ${r.err.trim().slice(-400) || `tmux exit ${r.code}`}`)
  const id = r.out.trim()
  if (!/^%\d+$/.test(id)) die(`split did not name a pane id (got ${JSON.stringify(id)})`)
  return id
}

async function main(): Promise<void> {
  const have = process.versions.node.split('.').map(Number)
  const below = NODE_FLOOR.findIndex((n, i) => have[i]! !== n)
  if (below >= 0 && have[below]! < NODE_FLOOR[below]!) usage(`node ${process.versions.node} is below the floor ${NODE_FLOOR.join('.')}`)
  let values: { session?: string; cwd?: string; pane?: string; socket?: string; 'unlock-launcher'?: string; 'migrate-launcher'?: string; yes?: boolean }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      options: {
        session: { type: 'string' },
        cwd: { type: 'string' },
        pane: { type: 'string' },
        socket: { type: 'string' },
        'unlock-launcher': { type: 'string' },
        'migrate-launcher': { type: 'string' },
        yes: { type: 'boolean' },
      },
      allowPositionals: true,
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (error) {
    usage((error as Error).message)
  }
  const unlock = values['unlock-launcher']
  const migrate = values['migrate-launcher']
  if (unlock !== undefined || migrate !== undefined) {
    if (unlock !== undefined && migrate !== undefined) usage('--unlock-launcher and --migrate-launcher are separate commands')
    const session = unlock ?? migrate!
    if (!session) usage('a session id is required')
    const root = await rootOf(nodeHost())
    if (!root) usage('no state root (set TMUX_AGENT_DIR, XDG_STATE_HOME, or HOME)')
    const out = await (unlock !== undefined ? unlockLauncher : migrateLauncher)(nodeHost(), root, session, values.yes === true)
    process.stdout.write(`tmux-agent-launcher: ${out.text}\n`)
    process.exit(out.ok ? 0 : 1)
  }
  const { session, cwd, socket } = values
  const pane = values.pane ?? process.env.TMUX_PANE
  if (!session) usage('--session is required')
  if (!cwd || !cwd.startsWith('/')) usage('--cwd must be an absolute path')
  if (positionals.length === 0) usage('a TUI command is required after --')
  if (!pane || !/^%\d+$/.test(pane)) usage(`--pane must be a tmux pane id like %3 (got ${pane ?? 'nothing'})`)
  if (socket && !socket.startsWith('/')) usage('--socket must be an absolute path')
  if (socket) {
    process.env.TMUX_AGENT_TMUX_SOCKET = socket
    delete process.env.TMUX
    delete process.env.TMUX_PANE
  }
  if (!(await paneAlive(pane))) usage(`host pane ${pane} is not alive`)
  const root = await rootOf(nodeHost())
  if (!root) usage('no state root (set TMUX_AGENT_DIR, XDG_STATE_HOME, or HOME)')
  const ensured = await ensureCollector(nodeHost(), { session, cwd, pane, root, socket })
  const tui = await splitTui(pane, cwd, positionals, session, root, socket)
  const old = ensured.replaced
  process.stdout.write(
    `tmux-agent-launcher: tui ${tui} beside host ${pane}; collector ${ensured.pid} ${ensured.reused ? 'reused' : 'started'}` +
      `${old ? `; replaced collector ${old.pid}${old.exited ? '' : ' (still exiting; the new activation fences it, §4)'}` : ''}\n`,
  )
  for (;;) {
    if (!(await paneAlive(pane))) {
      process.stderr.write(`tmux-agent-launcher: host pane ${pane} is gone\n`)
      process.exit(1)
    }
    await new Promise(r => setTimeout(r, 200))
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
if (isMain) {
  main().catch(error => {
    process.stderr.write(`tmux-agent-launcher: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
