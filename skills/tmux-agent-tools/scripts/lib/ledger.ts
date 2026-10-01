// The v4 ledger primitives (p0-contract.md §1–§4, §8 allocation). Pure over `Host`:
// every exclusive step is one `mkdir` or one `ln -sn`, run through `host.run` so the
// mod, a node host and zsh use the same syscall. EEXIST is a contest result; any other
// failure is `unknown` and is never read as absent, empty or won.
import type { Host } from './workers.ts'

/** Every ledger subprocess is a single syscall; a slow disk still answers well inside this. */
const OP_MS = 5_000
export const ORPHAN_MS = 90_000

export type Contest = 'won' | 'lost' | 'unknown'

// Every op names absolute paths; `/` is a cwd that always exists (a missing parent must not fail the spawn).
async function op(host: Host, argv: readonly string[]) {
  return host.run(argv, '/', OP_MS).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))
}
const exists = (stderr: string) => /File exists/i.test(stderr)

function contest(host: Host, what: string, r: { exitCode: number; stderr: string }): Contest {
  if (r.exitCode === 0) return 'won'
  if (exists(r.stderr)) return 'lost'
  host.log(`tmux-agent: ${what}: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
  return 'unknown'
}

/** Exclusive create of one directory. The parent must exist. */
export async function mkdirExclusive(host: Host, path: string): Promise<Contest> {
  return contest(host, `mkdir ${path}`, await op(host, ['mkdir', path]))
}

/** Numeric children of `dir` (`1`, `2`, …), ascending. `undefined` = unknown (never "none"). */
export async function numericChildren(host: Host, dir: string): Promise<number[] | undefined> {
  try {
    if (!(await host.exists(dir))) return []
    const entries = await host.list(dir)
    return entries
      .filter(e => e.kind === 'dir' && /^[1-9][0-9]*$/.test(e.name))
      .map(e => Number(e.name))
      .sort((a, b) => a - b)
  } catch (error) {
    host.log(`tmux-agent: could not list ${dir}: ${String(error)}`)
    return undefined
  }
}

/**
 * Take the next number under `dir` (§4 activations, §8 episodes): re-list, contest
 * `mkdir <max+1>`, on EEXIST re-list and try again. Order = creation order, never time.
 */
export async function allocateNext(host: Host, dir: string, tries = 8): Promise<number | undefined> {
  for (let i = 0; i < tries; i++) {
    const have = await numericChildren(host, dir)
    if (!have) return undefined
    const n = (have.at(-1) ?? 0) + 1
    const r = await mkdirExclusive(host, `${dir}/${n}`)
    if (r === 'won') return n
    if (r === 'unknown') return undefined
  }
  host.log(`tmux-agent: gave up allocating under ${dir} after ${tries} contests`)
  return undefined
}

// ── action lock (§5): a symlink whose target is the holder ──────────────────────

export type Holder = { token: string; session: string; activation: string; host: string; pid: number; pidStart: string }
export type Lock = { ok: true; token: string } | { ok: false; busy: Holder | 'unreadable' | 'unknown' }

/**
 * The lock's holder, `absent` (confirmed: not listed in its dir, or its dir is ENOENT),
 * or `unreadable` with why: a list error (EACCES, EIO), a listed lock readlink cannot
 * read, or a target that is not a holder record.
 */
export async function probeHolder(host: Host, lock: string): Promise<{ holder: Holder } | { absent: true } | { unreadable: string }> {
  const r = await op(host, ['readlink', lock])
  if (r.exitCode !== 0) {
    // BSD readlink prints nothing on any failure: the dir listing tells absent from an error.
    const failed = `readlink ${lock} failed (exit ${r.exitCode}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ''})`
    const dir = lock.slice(0, lock.lastIndexOf('/')) || '/'
    let names: string[]
    try {
      names = (await host.list(dir)).map(e => e.name)
    } catch (error) {
      if (!(await host.exists(dir).catch(() => true))) return { absent: true }
      return { unreadable: `${failed}; could not list ${dir}: ${String(error)}` }
    }
    if (!names.includes(lock.slice(dir.length + 1))) return { absent: true }
    return { unreadable: `${failed}, but it is listed in ${dir}` }
  }
  try {
    const h = JSON.parse(r.stdout.trim()) as Holder
    if (typeof h?.token === 'string') return { holder: h }
  } catch {
    // not JSON: below
  }
  return { unreadable: `${lock} names no holder record (${JSON.stringify(r.stdout.trim().slice(0, 80))})` }
}

/** Each distinct unreadable answer is logged once per process: reconcile reads the same locks every tick. */
const saidUnreadable = new Set<string>()

/** `undefined` only when the lock is confirmed absent; every other non-holder answer is `unreadable`. */
export async function readHolder(host: Host, lock: string): Promise<Holder | 'unreadable' | undefined> {
  const p = await probeHolder(host, lock)
  if ('holder' in p) return p.holder
  if ('absent' in p) return undefined
  if (!saidUnreadable.has(p.unreadable)) {
    saidUnreadable.add(p.unreadable)
    host.log(`tmux-agent: ${p.unreadable}`)
  }
  return 'unreadable'
}

/** Acquire and holder publication are one `ln -sn`: a lock without a holder cannot exist. */
export async function acquireLock(host: Host, lock: string, holder: Holder): Promise<Lock> {
  const r = await op(host, ['ln', '-sn', JSON.stringify(holder), lock])
  const c = contest(host, `lock ${lock}`, r)
  if (c === 'won') return { ok: true, token: holder.token }
  if (c === 'unknown') return { ok: false, busy: 'unknown' }
  return { ok: false, busy: (await readHolder(host, lock)) ?? 'unknown' }
}

/** Only the holder releases, and only its own instance. No stealing (§5). */
export async function releaseLock(host: Host, lock: string, token: string): Promise<boolean> {
  const h = await readHolder(host, lock)
  if (!h || h === 'unreadable' || h.token !== token) {
    host.log(`tmux-agent: release of ${lock} refused: not held by ${token}`)
    return false
  }
  const r = await op(host, ['rm', lock])
  return r.exitCode === 0
}

/**
 * The maintenance section of `lock` (§5 unlock). Every caller that removes another
 * holder's `lock` runs inside `<lock>.unlock`, itself an action lock held by this
 * process. So holder-read → liveness check → rm is one section: a second unlock cannot
 * judge the same dead holder, and then remove a newer holder's lock after the first
 * unlock removed the dead one. `<lock>.unlock` is never taken over: a dead holder of it
 * is `busy` like any other, and is cleared by hand.
 */
export async function maintainLock<T>(
  host: Host,
  lock: string,
  me: Holder,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; busy: Holder | 'unreadable' | 'unknown'; path: string }> {
  const path = `${lock}.unlock`
  const m = await acquireLock(host, path, me)
  if (!m.ok) return { ok: false, busy: m.busy, path }
  try {
    return { ok: true, value: await fn() }
  } finally {
    if (!(await releaseLock(host, path, me.token))) host.log(`tmux-agent: could not release ${path}; the next unlock reports it busy`)
  }
}

// ── acks (§5): create-once directories ─────────────────────────────────────────

/** `won` = this call recorded it; `lost` = it was already recorded. Both mean "acked". */
export async function ack(host: Host, episode: string, kind: string): Promise<Contest> {
  if ((await mkdirExclusive(host, `${episode}/acks`)) === 'unknown') return 'unknown'
  return mkdirExclusive(host, `${episode}/acks/${kind}`)
}

// ── activations and liveness (§4) ──────────────────────────────────────────────

/** Injective, filesystem-safe (v1 F2): hex of the UTF-8 bytes. No Buffer: the engine has no Node. */
export const sessionKey = (sessionId: string) =>
  [...new TextEncoder().encode(sessionId)].map(b => b.toString(16).padStart(2, '0')).join('')

export type Liveness = 'live' | 'initializing' | 'non-live' | 'unknown'

/**
 * A session's liveness from its authoritative (max) activation. The registration dir
 * stays empty, so its mtime is its creation time: the R2-4 grace runs from there.
 */
export async function sessionLiveness(host: Host, sessionDir: string, now: number): Promise<Liveness> {
  const acts = await numericChildren(host, `${sessionDir}/act`)
  if (!acts) return 'unknown'
  const n = acts.at(-1)
  if (n === undefined) return 'non-live'
  const beat = await statOrAbsent(host, `${sessionDir}/act/${n}.beat`)
  if (beat === 'unknown') return 'unknown'
  if (beat) return now - beat.mtimeMs <= ORPHAN_MS ? 'live' : 'non-live'
  const born = await statOrAbsent(host, `${sessionDir}/act/${n}`)
  if (!born || born === 'unknown') return 'unknown'
  return now - born.mtimeMs <= ORPHAN_MS ? 'initializing' : 'non-live'
}

/** ENOENT is an answer (absent); any other stat failure is unknown. */
async function statOrAbsent(host: Host, path: string): Promise<{ mtimeMs: number } | undefined | 'unknown'> {
  try {
    return await host.stat(path)
  } catch (error) {
    if (!(await host.exists(path).catch(() => true))) return undefined
    host.log(`tmux-agent: could not stat ${path}: ${String(error)}`)
    return 'unknown'
  }
}

export const UNKNOWN = 'unknown' as const

/** A file's text; `undefined` = confirmed absent (ENOENT); `UNKNOWN` = any other failure, logged (§1). */
export async function readOrAbsent(host: Host, path: string): Promise<string | undefined | typeof UNKNOWN> {
  try {
    return await host.read(path)
  } catch (error) {
    const there = await host.exists(path).catch(() => true)
    if (!there) return undefined
    host.log(`tmux-agent: could not read ${path}: ${String(error)}`)
    return UNKNOWN
  }
}

// ── claims (§3) ────────────────────────────────────────────────────────────────

export type Owner = { gen: number; session: string | undefined; complete: boolean; createdMs?: number }

/** The episode's current owner: max gen, or gen 0 = the descriptor's owner. */
export async function currentOwner(host: Host, episode: string, gen0Owner: string | undefined): Promise<Owner | undefined> {
  const gens = await numericChildren(host, `${episode}/claims`)
  if (!gens) return undefined
  const g = gens.at(-1)
  if (g === undefined) return { gen: 0, session: gen0Owner, complete: true }
  const dir = `${episode}/claims/${g}`
  const text = await readOrAbsent(host, `${dir}/owner`)
  if (text === UNKNOWN) return undefined
  const born = await statOrAbsent(host, dir)
  const createdMs = born && born !== 'unknown' ? born.mtimeMs : undefined
  const complete = !!text && text.endsWith('\n') && text.trim().length > 0
  return { gen: g, session: complete ? text.trim() : undefined, complete, createdMs }
}

const CLAIM_CLOSED = ['done', 'expired', 'cancel'] as const

/** `true` when a closing ack exists. `unknown` = the ack dirs could not be read (not "open"). */
async function closedForClaim(host: Host, episode: string): Promise<boolean | 'unknown'> {
  for (const kind of CLAIM_CLOSED) {
    const path = `${episode}/acks/${kind}`
    try {
      if (await host.exists(path)) return true
    } catch (error) {
      host.log(`tmux-agent: could not check ${path}: ${String(error)}`)
      return 'unknown'
    }
  }
  return false
}

/**
 * Contest the next claim gen for `me`. Allowed only when the current owner session is
 * non-live, or the max gen is incomplete and ORPHAN_MS old. A closed episode
 * (`acks/done|expired|cancel`) is never re-claimed. The owner file is
 * published by tmp + rename, newline-terminated, so a torn read is incomplete.
 */
export async function claim(
  host: Host,
  root: string,
  episode: string,
  gen0Owner: string | undefined,
  me: string,
  now: number,
): Promise<'claimed' | 'held' | 'lost' | 'unknown'> {
  const closed = await closedForClaim(host, episode)
  if (closed === 'unknown') return 'unknown'
  if (closed) return 'held'
  const cur = await currentOwner(host, episode, gen0Owner)
  if (!cur) return 'unknown'
  if (cur.complete) {
    if (cur.session === me) return 'held'
    if (cur.session) {
      const live = await sessionLiveness(host, `${root}/.sessions/${sessionKey(cur.session)}`, now)
      if (live !== 'non-live') return live === 'unknown' ? 'unknown' : 'held'
    }
  } else if (cur.createdMs === undefined || now - cur.createdMs <= ORPHAN_MS) {
    return cur.createdMs === undefined ? 'unknown' : 'held'
  }
  if ((await mkdirExclusive(host, `${episode}/claims`)) === 'unknown') return 'unknown'
  const next = `${episode}/claims/${cur.gen + 1}`
  const r = await mkdirExclusive(host, next)
  if (r !== 'won') return r === 'lost' ? 'lost' : 'unknown'
  const tmp = `${next}/owner.${me}.tmp`
  await host.write(tmp, `${me}\n`)
  const mv = await op(host, ['mv', tmp, `${next}/owner`])
  return mv.exitCode === 0 ? 'claimed' : 'unknown'
}

// ── activation writer (§4) ─────────────────────────────────────────────────────

export type ActivationRecord = { pid: number; pidStart: string; host: string; token: string }

/**
 * Register one activation (module load, node process start) of a session:
 * contest `act/<max+1>`, then write its sibling record. The dir stays empty so its
 * mtime is its creation time (the R2-4 grace). `undefined` = could not register.
 */
export async function registerActivation(host: Host, sessionDir: string, record: ActivationRecord): Promise<number | undefined> {
  const mk = await op(host, ['mkdir', '-p', `${sessionDir}/act`])
  if (mk.exitCode !== 0) {
    host.log(`tmux-agent: mkdir ${sessionDir}/act: ${mk.stderr.trim() || `exit ${mk.exitCode}`}`)
    return undefined
  }
  const n = await allocateNext(host, `${sessionDir}/act`)
  if (n === undefined) return undefined
  await host.write(`${sessionDir}/act/${n}.json`, JSON.stringify(record))
  return n
}

/** This activation's own liveness beat: only its mtime is read. */
export async function beat(host: Host, sessionDir: string, n: number, now: number): Promise<void> {
  await host.write(`${sessionDir}/act/${n}.beat`, String(now))
}

/** A higher registration fences this one for good. `undefined` = unknown (never "not superseded"). */
export async function superseded(host: Host, sessionDir: string, n: number): Promise<boolean | undefined> {
  const acts = await numericChildren(host, `${sessionDir}/act`)
  return acts ? (acts.at(-1) ?? 0) > n : undefined
}

// ── episodes (§2, §8): allocation, immutable descriptor, markers, recovery ──────

/** `worker.json`: the worker's identity, published once at name reservation (assign and resume). */
export type WorkerRecord = {
  profile: string
  name: string
  dir: string
  since: number
  owner: string
  ownerCwd: string
  origin: 'assign' | 'resume'
}

/** `episodes/<seq>/dispatch.json`: one episode; worker fields live in `worker.json`. */
export type Descriptor = {
  seq: number
  since: number
  /** The session that opened this episode: claim gen 0. A tell from another session moves the answer there. */
  owner: string
  goal?: string
  /** `git rev-parse HEAD` of the worker dir when the episode began, when it is a repo. */
  base?: string
  resultPath: string
  origin: 'launch' | 'tell'
}

export type Marker = 'sent' | 'uncertain' | 'aborted'

let published = 0

/** Whole-content publication: unique tmp in the same dir, then one rename. */
async function publish(host: Host, path: string, text: string, token: string): Promise<boolean> {
  const tmp = `${path}.${token}.${++published}`
  await host.write(tmp, text)
  const mv = await op(host, ['mv', tmp, path])
  if (mv.exitCode !== 0) host.log(`tmux-agent: publish ${path}: ${mv.stderr.trim() || `exit ${mv.exitCode}`}`)
  return mv.exitCode === 0
}

/** A complete descriptor parses and names its own seq; anything else is incomplete. */
export async function readDescriptor(host: Host, episodeDir: string): Promise<Descriptor | undefined | 'unknown'> {
  let text: string
  try {
    text = await host.read(`${episodeDir}/dispatch.json`)
  } catch {
    return (await host.exists(`${episodeDir}/dispatch.json`).catch(() => true)) ? 'unknown' : undefined
  }
  try {
    const d = JSON.parse(text) as Descriptor
    return typeof d?.seq === 'number' && typeof d.resultPath === 'string' ? d : undefined
  } catch {
    return undefined
  }
}

/** Publish `worker.json` right after the reservation mkdir, before any wrapper call. */
export const publishWorker = (host: Host, workerDir: string, w: WorkerRecord, token: string) =>
  publish(host, `${workerDir}/worker.json`, JSON.stringify(w), token)

/** `undefined` = no complete record (the reservation is `incomplete`); `'unknown'` = unreadable. */
export async function readWorker(host: Host, workerDir: string): Promise<WorkerRecord | undefined | 'unknown'> {
  let text: string
  try {
    text = await host.read(`${workerDir}/worker.json`)
  } catch {
    return (await host.exists(`${workerDir}/worker.json`).catch(() => true)) ? 'unknown' : undefined
  }
  try {
    const w = JSON.parse(text) as WorkerRecord
    return typeof w?.profile === 'string' && typeof w.name === 'string' && typeof w.owner === 'string' ? w : undefined
  } catch {
    return undefined
  }
}

/** Markers are create-once directories, like acks. */
export const mark = (host: Host, episodeDir: string, m: Marker) => mkdirExclusive(host, `${episodeDir}/${m}`)
export const hasMark = (host: Host, episodeDir: string, m: Marker) => host.exists(`${episodeDir}/${m}`)

/**
 * Allocate the next episode of a worker and publish its immutable descriptor.
 * The CALLER holds the worker's action lock (§5). seq = max(listed)+1; EEXIST under
 * the lock means a writer outside the protocol: re-list and retry once, then refuse.
 */
export async function openEpisode(
  host: Host,
  workerDir: string,
  token: string,
  make: (seq: number) => Descriptor,
): Promise<Descriptor | undefined> {
  if ((await mkdirExclusive(host, `${workerDir}/episodes`)) === 'unknown') return undefined
  const seq = await allocateNext(host, `${workerDir}/episodes`, 2)
  if (seq === undefined) return undefined
  const d = make(seq)
  if (d.seq !== seq) throw new Error(`descriptor seq ${d.seq} is not the allocated ${seq}`)
  return (await publish(host, `${workerDir}/episodes/${seq}/dispatch.json`, JSON.stringify(d), token)) ? d : undefined
}

/**
 * Recovery (§8), run by the next action-lock holder: an episode dir without a
 * complete descriptor is `aborted`; a descriptor without `sent` gets `uncertain`
 * then `sent` (never re-sent). Returns what it changed, for the log.
 */
export async function recoverEpisodes(host: Host, workerDir: string): Promise<string[] | undefined> {
  const seqs = await numericChildren(host, `${workerDir}/episodes`)
  if (!seqs) return undefined
  const changed: string[] = []
  for (const seq of seqs) {
    const dir = `${workerDir}/episodes/${seq}`
    const aborted = await hasMark(host, dir, 'aborted').catch((error: unknown) => {
      host.log(`tmux-agent: could not check ${dir}/aborted: ${String(error)}`)
      return undefined
    })
    if (aborted === undefined) return undefined
    if (aborted) continue
    const d = await readDescriptor(host, dir)
    if (d === 'unknown') return undefined
    if (!d) {
      if ((await mark(host, dir, 'aborted')) === 'won') changed.push(`${seq}: aborted`)
      continue
    }
    const sent = await hasMark(host, dir, 'sent').catch((error: unknown) => {
      host.log(`tmux-agent: could not check ${dir}/sent: ${String(error)}`)
      return undefined
    })
    if (sent === undefined) return undefined
    if (!sent) {
      await mark(host, dir, 'uncertain')
      if ((await mark(host, dir, 'sent')) === 'won') changed.push(`${seq}: uncertain`)
    }
  }
  return changed
}
