// Open the workers TUI beside the host CLI. Deliveries stay on the host pane.
//
//   node launcher.node.ts --session <id> --cwd <abs> [--pane %N] -- <tui command…>
//   node launcher.node.ts --unlock-launcher <session> [--yes]
//   node launcher.node.ts --migrate-launcher <session> [--yes]
//   node launcher.node.ts --handover-channel <session> <mod|node|mcp> [--yes]
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
// Channel authority (plan §1c S3): `<sessionDir>/channel` names the one delivery channel
// (mod, node or mcp) of the session. The launcher starts a node collector only when that
// channel is node or not yet chosen; another channel owns the session → no collector,
// a status line, and the TUI still opens. An unreadable channel record is busy, never
// "not chosen". `--handover-channel <session> <to>` is the only way to change it: it takes
// `channel.lock`, then `collector.owner` (this order, never reversed: the launcher holds
// `collector.owner` and only reads `channel`), proves with one `ps` snapshot that the old
// channel's registration callers and their children are gone, and switches. A stale heartbeat
// is not quiescence and is not read at all.
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
import { acquireLock, maintainLock, probeHolder, switchChannel, underLock, unlinkHeld, type Holder } from './ledger.ts'
import { holderProvablyAlive, maintainedOutcome, processId, randomBase36, rootOf, sessionDirOf, v3Of, type Host } from './workers.ts'

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
  '       node launcher.node.ts --handover-channel <session> <mod|node|mcp> [--yes]',
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
export const handoverCommand = (session: string, to: string) => `tmux-agent-tui --handover-channel ${shq(session)} ${to} --yes`

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
  // Latched: an exit seen while a check below is awaited still stops readiness.
  let endedWhy: string | undefined
  const ended = new Promise<string>(resolve => {
    const end = (why: string) => resolve((endedWhy ??= why))
    child.once('error', error => end(`could not start: ${error.message}`))
    child.once('exit', (code, signal) => end(`exited (${signal ?? `code ${code}`}) before it was ready`))
  })
  child.unref()
  await log.close()
  const deadline = Date.now() + READY_MS
  try {
    for (;;) {
      await Promise.race([ended, sleep(100)])
      if (endedWhy) throw new Error(`the collector ${endedWhy}; collector.log: ${await logTail(logPath)}`)
      // Only a confirmed-absent record is waited for; any other read error is the answer.
      let rec: CollectorRecord | undefined
      try {
        rec = await readCollectorRecord(`${dir}/collector.json`)
      } catch (error) {
        child.kill('SIGTERM')
        throw new Error(`could not read the record of collector ${child.pid ?? '?'}: ${(error as Error).message}; stopped it. collector.log: ${await logTail(logPath)}`)
      }
      if (child.pid && rec?.nonce === nonce && rec.pid === child.pid && sameCollector(rec, want) && (await holderProvablyAlive(host, rec)) === true) {
        // Checked after the awaits, synchronously: a child that ended meanwhile is not ready.
        if (endedWhy) throw new Error(`the collector ${endedWhy}; collector.log: ${await logTail(logPath)}`)
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
): Promise<{ skipped: string } | { pid: number; reused: boolean; replaced?: { pid: number; exited: boolean } }> {
  const dir = sessionDirOf(v3Of(opts.root), opts.session)
  await mkdir(dir, { recursive: true })
  const token = await takeLauncherLock(host, dir, opts.session)
  return await underLock(host, `${dir}/collector.owner`, token, async () => {
    const legacy = await legacyFiles(dir)
    if (legacy.length) {
      throw new Error(
        `busy: ${dir} has files of the launcher before plan R6 (${legacy.join(', ')}); an old launcher or collector may still run. ` +
          `Nothing is started. Run: ${migrateCommand(opts.session)}`,
      )
    }
    // Read only (channel.lock is not taken here: handover takes it first, then this lock).
    const ch = await probeHolder(host, `${dir}/channel`)
    if ('unreadable' in ch) throw new Error(`busy: ${ch.unreadable}; the channel of this session is unknown, so no collector is started`)
    if ('holder' in ch) {
      const owner = (ch.holder as unknown as { channel?: unknown }).channel
      if (typeof owner !== 'string' || !owner) throw new Error(`busy: ${dir}/channel names no channel; the channel of this session is unknown, so no collector is started`)
      if (owner !== 'node') {
        return {
          skipped:
            `no collector started: this session is collected by its ${owner} channel (one delivery channel per session). ` +
            `To collect with a node collector instead, run: ${handoverCommand(opts.session, 'node')}`,
        }
      }
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
  }, (_v, note) => {
    throw new Error(`busy: the launch itself completed, but ${note}`)
  })
}

/** A release that did not come out clean turns the outcome into a failure that says so. */
const noted = (o: Outcome, note: string): Outcome => ({ ok: false, text: `${o.text}; ${note}` })

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
  return maintainedOutcome(host, m)
}

async function unlockHeld(host: Host, lock: string, session: string, yes: boolean, p: Awaited<ReturnType<typeof probeHolder>>): Promise<Outcome> {
  if ('absent' in p) return { ok: true, text: `${lock} is not held; nothing to unlock` }
  if ('unreadable' in p) return { ok: false, text: `busy: ${p.unreadable}; not removing it` }
  const h = p.holder
  const alive = await holderProvablyAlive(host, h)
  const who = holderText(h, alive)
  if (alive !== false) return { ok: false, text: `not unlocking ${lock}: its holder is ${who}` }
  if (!yes) return { ok: false, text: `${lock} is held by ${who}. To remove it, run: ${unlockCommand(session)}` }
  const gone = await unlinkHeld(host, lock, h.token)
  if (!gone.ok) return { ok: false, text: `${lock} changed or could not be removed (${gone.error}); nothing removed` }
  return { ok: true, text: `unlocked ${lock} (its holder ${who})` }
}

export type Proc = { pid: number; ppid: number; line: string }

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

/** `hits` and their descendants by ppid (a dead launcher's orphans are reparented and not found). */
function family(procs: Proc[], hits: Proc[]): { hits: Proc[]; kids: Proc[] } {
  const seen = new Set(hits.map(p => p.pid))
  const tree = [...hits]
  for (let i = 0; i < tree.length; i++) {
    for (const p of procs) {
      if (p.ppid !== tree[i]!.pid || seen.has(p.pid) || p.pid === process.pid) continue
      seen.add(p.pid)
      tree.push(p)
    }
  }
  return { hits, kids: tree.slice(hits.length) }
}
const listProcs = (ps: Proc[]) => ps.map(p => `pid ${p.pid}: ${p.line.slice(0, 200)}`).join('; ')

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
  return await underLock(host, `${dir}/collector.owner`, token, async (): Promise<Outcome> => {
    const procs = await processes()
    if (!procs) return { ok: false, text: 'busy: ps -o pid=,ppid=,lstart=,args= failed; cannot prove that no old launcher runs' }
    // Only this process is left out: a matching parent is an old launcher too.
    const hits = procs.filter(
      p => p.pid !== process.pid && p.line.includes(session) && (p.line.includes('launcher.node.ts') || p.line.includes('collector.node.ts')),
    )
    if (hits.length) {
      const { kids } = family(procs, hits)
      return {
        ok: false,
        text:
          `busy: a launcher or collector for session ${session} still runs: ${listProcs(hits)}` +
          `${kids.length ? `; and its descendants: ${listProcs(kids)}` : ''}. ` +
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
  }, noted)
}

const CHANNELS = ['mod', 'node', 'mcp']

/**
 * `--handover-channel <session> <to>` (plan §1c S3): the only way to change the session's
 * channel. Order: `channel.lock`, then `collector.owner`, never reversed. Under both, one
 * `ps` snapshot must show none of the old channel's registration callers (a launcher or
 * collector naming the session; for mcp any MCP server process, since its args carry no
 * session id) nor a child of one. The beat is never read: a stale heartbeat is not
 * quiescence. The mod runs inside a Claude Code process that `ps` cannot tie to a session,
 * and nothing fences a caller that starts after the snapshot, so `--yes` also confirms that
 * no old-channel caller runs or starts meanwhile. A late registration of the old channel
 * re-reads `channel` inside `channel.lock` and is refused (ledger.ts `registerOnChannel`).
 */
export async function handoverChannel(
  host: Host,
  root: string,
  session: string,
  to: string,
  yes: boolean,
  ps: () => Promise<Proc[] | undefined> = processes,
): Promise<Outcome> {
  if (!CHANNELS.includes(to)) return { ok: false, text: `the target channel is one of ${CHANNELS.join(', ')} (got ${JSON.stringify(to)})` }
  const dir = sessionDirOf(v3Of(root), session)
  if (!(await host.exists(dir))) return { ok: true, text: `${dir} does not exist; the session has no channel to hand over` }
  const me = await processId(host)
  if (!(me.pid > 0 && me.pidStart && me.host)) return { ok: false, text: 'busy: could not read this process id (ps); not taking a lock that nobody could later prove dead' }
  const lockPath = `${dir}/channel.lock`
  const mine: Holder = { token: randomBase36(12), session, activation: 'handover', ...me }
  const lock = await acquireLock(host, lockPath, mine)
  if (!lock.ok) {
    const h = lock.busy
    const who = typeof h === 'string' ? (h === 'unreadable' ? 'an unreadable holder' : 'an unknown state (see the log)') : holderText(h, await holderProvablyAlive(host, h))
    return { ok: false, text: `busy: ${lockPath} is held by ${who}. It is never taken over; if its holder is gone, rm ${shq(lockPath)}` }
  }
  return await underLock(host, lockPath, mine.token, async (): Promise<Outcome> => {
    const ch = await probeHolder(host, `${dir}/channel`)
    if ('absent' in ch) return { ok: true, text: `${dir} has no channel record; the first registrant picks the channel, nothing to hand over` }
    if ('unreadable' in ch) return { ok: false, text: `busy: ${ch.unreadable}; the channel is unknown, nothing is switched` }
    const old = (ch.holder as unknown as { channel?: unknown }).channel
    if (typeof old !== 'string' || !old) return { ok: false, text: `busy: ${dir}/channel names no channel; nothing is switched` }
    if (old === to) return { ok: true, text: `session ${session} is already collected by its ${to} channel` }
    let owner: string
    try {
      owner = await takeLauncherLock(host, dir, session)
    } catch (error) {
      return { ok: false, text: (error as Error).message }
    }
    return await underLock(host, `${dir}/collector.owner`, owner, async (): Promise<Outcome> => {
      const procs = await ps()
      if (!procs) return { ok: false, text: 'busy: ps -o pid=,ppid=,lstart=,args= failed; cannot prove that the old channel is quiescent' }
      const hits = procs.filter(
        p =>
          p.pid !== process.pid &&
          ((p.line.includes(session) && (p.line.includes('launcher.node.ts') || p.line.includes('collector.node.ts'))) ||
            (old === 'mcp' && (p.line.includes('mcp-server.mjs') || p.line.includes('tmux-agent-mcp')))),
      )
      if (hits.length) {
        const { kids } = family(procs, hits)
        return {
          ok: false,
          text:
            `busy: a ${old} channel caller for session ${session} still runs: ${listProcs(hits)}` +
            `${kids.length ? `; and its descendants: ${listProcs(kids)}` : ''}. A stale heartbeat is not quiescence: stop it, then hand over again`,
        }
      }
      if (!yes) {
        return {
          ok: false,
          text:
            `would switch session ${session} from its ${old} channel to ${to}. ps shows no ${old} caller for it, but that is one snapshot` +
            `${old === 'mod' ? ' and the mod runs inside a Claude Code process that ps cannot tie to a session' : ''}: ` +
            `confirm that no ${old} caller (a collector, an MCP server, a Claude Code session with this plugin) runs or will start for it, then run: ${handoverCommand(session, to)}`,
        }
      }
      if (!(await switchChannel(host, dir, to, mine.token))) {
        return { ok: false, text: `could not switch ${dir}/channel (see the log); the ${old} channel is unchanged and keeps its authority` }
      }
      return { ok: true, text: `session ${session}: ${old} → ${to}. The ${to} channel registers next and fences the ${old} activations; a late ${old} caller is refused` }
    }, noted)
  }, noted)
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
  let values: { session?: string; cwd?: string; pane?: string; socket?: string; 'unlock-launcher'?: string; 'migrate-launcher'?: string; 'handover-channel'?: string; yes?: boolean }
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
        'handover-channel': { type: 'string' },
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
  const handover = values['handover-channel']
  if (handover !== undefined) {
    if (unlock !== undefined || migrate !== undefined) usage('--handover-channel is a separate command')
    if (!handover) usage('a session id is required')
    if (positionals.length !== 1) usage('--handover-channel takes <session> <mod|node|mcp>')
    const root = await rootOf(nodeHost())
    if (!root) usage('no state root (set TMUX_AGENT_DIR, XDG_STATE_HOME, or HOME)')
    const out = await handoverChannel(nodeHost(), root, handover, positionals[0]!, values.yes === true)
    process.stdout.write(`tmux-agent-launcher: ${out.text}\n`)
    process.exit(out.ok ? 0 : 1)
  }
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
  if ('skipped' in ensured) {
    process.stdout.write(`tmux-agent-launcher: tui ${tui} beside host ${pane}; ${ensured.skipped}\n`)
  } else {
    const old = ensured.replaced
    process.stdout.write(
      `tmux-agent-launcher: tui ${tui} beside host ${pane}; collector ${ensured.pid} ${ensured.reused ? 'reused' : 'started'}` +
        `${old ? `; replaced collector ${old.pid}${old.exited ? '' : ' (still exiting; the new activation fences it, §4)'}` : ''}\n`,
    )
  }
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
