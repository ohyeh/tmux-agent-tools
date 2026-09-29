// The v4 ledger primitives (p0-contract.md §1–§4, §8 allocation). Pure over `Host`:
// every exclusive step is one `mkdir` or one `ln -sn`, run through `host.run` so the
// mod, a node host and zsh use the same syscall. EEXIST is a contest result; any other
// failure is `unknown` and is never read as absent, empty or won.
import type { Host } from './workers.ts'

/** Every ledger subprocess is a single syscall; a slow disk still answers well inside this. */
const OP_MS = 5_000
export const ORPHAN_MS = 90_000

export type Contest = 'won' | 'lost' | 'unknown'

async function op(host: Host, argv: readonly string[], cwd: string) {
  return host.run(argv, cwd, OP_MS).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))
}
const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'
const exists = (stderr: string) => /File exists/i.test(stderr)

function contest(host: Host, what: string, r: { exitCode: number; stderr: string }): Contest {
  if (r.exitCode === 0) return 'won'
  if (exists(r.stderr)) return 'lost'
  host.log(`tmux-agent: ${what}: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
  return 'unknown'
}

/** Exclusive create of one directory. The parent must exist. */
export async function mkdirExclusive(host: Host, path: string): Promise<Contest> {
  return contest(host, `mkdir ${path}`, await op(host, ['mkdir', path], parent(path)))
}

/** Numeric children of `dir` (`1`, `2`, …), ascending. `undefined` = unknown (never "none"). */
export async function numericChildren(host: Host, dir: string): Promise<number[] | undefined> {
  if (!(await host.exists(dir).catch(() => false))) return []
  try {
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

export async function readHolder(host: Host, lock: string): Promise<Holder | 'unreadable' | undefined> {
  const r = await op(host, ['readlink', lock], parent(lock))
  if (r.exitCode !== 0) return undefined
  try {
    const h = JSON.parse(r.stdout.trim()) as Holder
    return typeof h?.token === 'string' ? h : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

/** Acquire and holder publication are one `ln -sn`: a lock without a holder cannot exist. */
export async function acquireLock(host: Host, lock: string, holder: Holder): Promise<Lock> {
  const r = await op(host, ['ln', '-sn', JSON.stringify(holder), lock], parent(lock))
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
  const r = await op(host, ['rm', lock], parent(lock))
  return r.exitCode === 0
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

// ── claims (§3) ────────────────────────────────────────────────────────────────

export type Owner = { gen: number; session: string | undefined; complete: boolean; createdMs?: number }

/** The episode's current owner: max gen, or gen 0 = the descriptor's owner. */
export async function currentOwner(host: Host, episode: string, gen0Owner: string | undefined): Promise<Owner | undefined> {
  const gens = await numericChildren(host, `${episode}/claims`)
  if (!gens) return undefined
  const g = gens.at(-1)
  if (g === undefined) return { gen: 0, session: gen0Owner, complete: true }
  const dir = `${episode}/claims/${g}`
  const text = await host.read(`${dir}/owner`).catch(() => undefined)
  const born = await statOrAbsent(host, dir)
  const createdMs = born && born !== 'unknown' ? born.mtimeMs : undefined
  const complete = !!text && text.endsWith('\n') && text.trim().length > 0
  return { gen: g, session: complete ? text!.trim() : undefined, complete, createdMs }
}

/**
 * Contest the next claim gen for `me`. Allowed only when the current owner session is
 * non-live, or the max gen is incomplete and ORPHAN_MS old. The owner file is
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
  const mv = await op(host, ['mv', tmp, `${next}/owner`], next)
  return mv.exitCode === 0 ? 'claimed' : 'unknown'
}
