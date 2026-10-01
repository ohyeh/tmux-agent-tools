// Contract tests for the v4 ledger primitives (p0-contract.md §3–§5, §8 allocation),
// against a real filesystem and real OS-process contention.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ack, acquireLock, allocateNext, claim, currentOwner, hasMark, mark, openEpisode, ORPHAN_MS, publishWorker, readDescriptor, readWorker, recoverEpisodes,
  registerActivation, releaseLock, sessionKey, sessionLiveness, superseded, type Descriptor,
} from './ledger.ts'
import type { Host } from './workers.ts'
import { nodeHost } from './host.node.ts'

const RACE = new URL('./ledger.race.node.ts', import.meta.url).pathname
const host = (owner = 'me') => nodeHost({ owner, log: () => {} })
const fresh = () => mkdtempSync(join(tmpdir(), 'ledger-'))
const holder = (token: string) => ({ token, session: token, activation: '1', host: 'h', pid: process.pid, pidStart: 'x' })

/** Run `n` contender processes at once; resolve their parsed outputs. */
function race(n: number, args: (i: number) => string[]): Promise<unknown[]> {
  return Promise.all(
    Array.from({ length: n }, (_, i) =>
      new Promise<unknown>((resolve, reject) =>
        execFile(process.execPath, [RACE, ...args(i)], (error, stdout, stderr) =>
          error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(JSON.parse(stdout)),
        ),
      ),
    ),
  )
}

test('lock: 8 processes, exactly one holder, 20 rounds', async () => {
  for (let round = 0; round < 20; round++) {
    const lock = join(fresh(), '.action')
    const outs = (await race(8, i => ['lock', lock, `p${i}`])) as { ok: boolean }[]
    assert.equal(outs.filter(o => o.ok).length, 1, `round ${round}: ${JSON.stringify(outs)}`)
  }
})

test('lock: the loser sees the holder; a non-holder cannot release; the holder can', async () => {
  const h = host()
  const lock = join(fresh(), '.action')
  assert.deepEqual(await acquireLock(h, lock, holder('A')), { ok: true, token: 'A' })
  const second = await acquireLock(h, lock, holder('B'))
  assert.equal(second.ok, false)
  assert.equal(!second.ok && second.busy !== 'unknown' && second.busy !== 'unreadable' && second.busy.token, 'A')
  assert.equal(await releaseLock(h, lock, 'B'), false)
  assert.equal(await releaseLock(h, lock, 'A'), true)
  assert.equal((await acquireLock(h, lock, holder('B'))).ok, true)
})

test('allocate: 8 processes get 8 distinct consecutive numbers', async () => {
  const dir = join(fresh(), 'episodes')
  mkdirSync(dir)
  const outs = (await race(8, i => ['allocate', dir, `p${i}`])) as number[]
  assert.deepEqual([...outs].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8])
})

test('allocate: a crash after mkdir (no descriptor) never makes the next allocation reuse it', async () => {
  const dir = join(fresh(), 'episodes')
  mkdirSync(join(dir, '1'), { recursive: true })
  assert.equal(await allocateNext(host(), dir), 2)
})

test('ack: create-once — first records, second reports already recorded', async () => {
  const ep = fresh()
  assert.equal(await ack(host(), ep, 'done'), 'won')
  assert.equal(await ack(host(), ep, 'done'), 'lost')
})

test('liveness: fresh beat live; stale beat non-live; no beat inside grace initializing, after grace non-live', async () => {
  const s = fresh()
  const now = Date.now()
  mkdirSync(join(s, 'act', '1'), { recursive: true })
  assert.equal(await sessionLiveness(host(), s, now), 'initializing')
  const old = (now - ORPHAN_MS - 5_000) / 1000
  utimesSync(join(s, 'act', '1'), old, old)
  assert.equal(await sessionLiveness(host(), s, now), 'non-live')
  writeFileSync(join(s, 'act', '1.beat'), '')
  assert.equal(await sessionLiveness(host(), s, now), 'live')
  utimesSync(join(s, 'act', '1.beat'), old, old)
  assert.equal(await sessionLiveness(host(), s, now), 'non-live')
  mkdirSync(join(s, 'act', '2'))
  assert.equal(await sessionLiveness(host(), s, now), 'initializing', 'a newer registration without a beat fences the older one')
})

test('liveness: no registration at all is non-live', async () => {
  assert.equal(await sessionLiveness(host(), fresh(), Date.now()), 'non-live')
})

test('claim: a live owner keeps it; a dead owner is claimed by exactly one of 8 processes', async () => {
  const root = fresh()
  const ep = join(root, 'w', 'episodes', '1')
  mkdirSync(ep, { recursive: true })
  const dead = 'dead-session'
  const act = join(root, '.sessions', sessionKey(dead), 'act')
  mkdirSync(join(act, '1'), { recursive: true })
  writeFileSync(join(act, '1.beat'), '')
  const now = Date.now()
  assert.equal(await claim(host('x'), root, ep, dead, 'x', now), 'held', 'a live owner keeps it')
  const old = (now - ORPHAN_MS - 5_000) / 1000
  utimesSync(join(act, '1.beat'), old, old)
  const outs = (await race(8, i => ['claim', ep, `c${i}`, root, dead, String(now)])) as string[]
  assert.equal(outs.filter(o => o === 'claimed').length, 1, JSON.stringify(outs))
  const owner = await currentOwner(host(), ep, dead)
  assert.equal(owner?.gen, 1)
  assert.equal(owner?.complete, true)
  assert.match(owner?.session ?? '', /^c\d$/)
})

test('claim: aged owner beats on a closed episode do not open a new gen', async () => {
  const root = fresh()
  const ep = join(root, 'w', 'episodes', '1')
  mkdirSync(join(ep, 'acks', 'done'), { recursive: true })
  const dead = 'dead-session'
  const act = join(root, '.sessions', sessionKey(dead), 'act')
  mkdirSync(join(act, '1'), { recursive: true })
  writeFileSync(join(act, '1.beat'), '')
  const now = Date.now()
  const old = (now - ORPHAN_MS - 5_000) / 1000
  utimesSync(join(act, '1.beat'), old, old)
  const out = await claim(host('other'), root, ep, dead, 'other', now)
  assert.equal(out, 'held', 'claim on a closed episode reports held')
  assert.equal(existsSync(join(ep, 'claims')), false, 'closed episode must not gain a claim gen')
})

test('claim: an incomplete max gen is waited out for ORPHAN_MS, never promoted early', async () => {
  const root = fresh()
  const ep = join(root, 'w', 'episodes', '1')
  mkdirSync(join(ep, 'claims', '1'), { recursive: true })
  const now = Date.now()
  assert.equal(await claim(host('x'), root, ep, 'gone', 'x', now), 'held')
  const old = (now - ORPHAN_MS - 5_000) / 1000
  utimesSync(join(ep, 'claims', '1'), old, old)
  assert.equal(await claim(host('x'), root, ep, 'gone', 'x', now), 'claimed')
  assert.equal((await currentOwner(host(), ep, 'gone'))?.gen, 2)
})

test('sessionKey is injective where the legacy slug was not', () => {
  assert.notEqual(sessionKey('a/b'), sessionKey('a_b'))
})

test('activation: 8 processes register 8 distinct numbers, each with its record; only the max is not superseded', async () => {
  const dir = fresh()
  const ns = ((await race(8, i => ['activate', dir, `p${i}`])) as number[]).sort((a, b) => a - b)
  assert.deepEqual(ns, [1, 2, 3, 4, 5, 6, 7, 8])
  for (const n of ns) assert.ok(JSON.parse(readFileSync(join(dir, 'act', `${n}.json`), 'utf8')).token.startsWith('p'))
  assert.equal(await superseded(host(), dir, 8), false)
  assert.equal(await superseded(host(), dir, 7), true)
  assert.equal(await registerActivation(host(), dir, { pid: 1, pidStart: 'x', host: 'h', token: 't' }), 9)
  assert.equal(await superseded(host(), dir, 8), true)
})

const desc = (seq: number, resultPath = `/r/${seq}.json`): Descriptor =>
  ({ seq, since: 1, owner: 'me', resultPath, origin: seq === 1 ? 'launch' : 'tell' })

test('worker record: published whole, read back; absent → undefined; torn → undefined', async () => {
  const w = fresh()
  assert.equal(await readWorker(host(), w), undefined)
  const rec = { profile: 'codex', name: 'w.abcde', dir: '/d', since: 1, owner: 'me', ownerCwd: '/d', origin: 'resume' as const }
  assert.equal(await publishWorker(host(), w, rec, 't'), true)
  assert.deepEqual(await readWorker(host(), w), rec)
  writeFileSync(join(w, 'worker.json'), '{"profile":')
  assert.equal(await readWorker(host(), w), undefined)
})

test('episode: seq = max+1, the descriptor is published whole and names its own seq', async () => {
  const w = fresh()
  assert.equal((await openEpisode(host(), w, 't', desc))?.seq, 1)
  assert.equal((await openEpisode(host(), w, 't', desc))?.seq, 2)
  assert.deepEqual(await readDescriptor(host(), join(w, 'episodes', '2')), desc(2))
  await assert.rejects(openEpisode(host(), w, 't', () => desc(9)), /not the allocated 3/)
})

test('markers: create-once', async () => {
  const e = fresh()
  assert.equal(await mark(host(), e, 'sent'), 'won')
  assert.equal(await mark(host(), e, 'sent'), 'lost')
  assert.equal(await hasMark(host(), e, 'sent'), true)
  assert.equal(await hasMark(host(), e, 'uncertain'), false)
})

test('recovery: no descriptor → aborted; descriptor without sent → uncertain+sent; sent → untouched; idempotent', async () => {
  const w = fresh()
  const h = host()
  await openEpisode(h, w, 't', desc) // 1: descriptor, never sent
  await openEpisode(h, w, 't', desc) // 2: sent
  await mark(h, join(w, 'episodes', '2'), 'sent')
  mkdirSync(join(w, 'episodes', '3')) // 3: crash between mkdir and publish
  mkdirSync(join(w, 'episodes', '4'))
  writeFileSync(join(w, 'episodes', '4', 'dispatch.json'), '{"seq":') // 4: torn write outside the protocol
  assert.deepEqual(await recoverEpisodes(h, w), ['1: uncertain', '3: aborted', '4: aborted'])
  assert.ok(existsSync(join(w, 'episodes', '1', 'uncertain')) && existsSync(join(w, 'episodes', '1', 'sent')))
  assert.ok(!existsSync(join(w, 'episodes', '2', 'uncertain')))
  assert.deepEqual(await recoverEpisodes(h, w), [])
  assert.equal((await openEpisode(h, w, 't', desc))?.seq, 5)
})

test('liveness: a registration dir that cannot be listed (EACCES) is unknown, never non-live', async () => {
  const s = fresh()
  mkdirSync(join(s, 'act', '1'), { recursive: true })
  chmodSync(join(s, 'act'), 0o000)
  try {
    assert.equal(await sessionLiveness(host(), s, Date.now()), 'unknown')
  } finally {
    chmodSync(join(s, 'act'), 0o755)
  }
})

test('finding M5: claim returns unknown and does not open gen 2 when owner read errors (EACCES)', async () => {
  const root = fresh()
  const ep = join(root, 'w', 'episodes', '1')
  mkdirSync(join(ep, 'claims', '1'), { recursive: true })
  writeFileSync(join(ep, 'claims', '1', 'owner'), 'previous\n')
  const now = Date.now()
  const old = (now - ORPHAN_MS - 5_000) / 1000
  utimesSync(join(ep, 'claims', '1'), old, old)

  const unreadableHost: Host = {
    ...host('x'),
    read: async (path: string) => {
      if (path.endsWith('/claims/1/owner')) {
        const err = new Error('EACCES: permission denied')
        ;(err as any).code = 'EACCES'
        throw err
      }
      return host('x').read(path)
    },
  }

  const out = await claim(unreadableHost, root, ep, 'gone', 'x', now)
  assert.equal(out, 'unknown')
  assert.equal(existsSync(join(ep, 'claims', '2')), false, 'must not open gen 2 on read error')
})

test('finding N4: recoverEpisodes returns undefined when checking sent mark throws (EACCES)', async () => {
  const w = fresh()
  const h = host()
  await openEpisode(h, w, 't', desc) // 1: descriptor, never sent
  const errorHost: Host = {
    ...h,
    exists: async (path: string) => {
      if (path.endsWith('/sent')) {
        const err = new Error('EACCES: permission denied')
        ;(err as any).code = 'EACCES'
        throw err
      }
      return h.exists(path)
    },
  }
  const res = await recoverEpisodes(errorHost, w)
  assert.equal(res, undefined, 'recovery must return undefined when mark check throws')
})

test('finding N4 / M6: recoverEpisodes returns undefined when checking aborted mark throws (EACCES)', async () => {
  const w = fresh()
  const h = host()
  await openEpisode(h, w, 't', desc)
  const errorHost: Host = {
    ...h,
    exists: async (path: string) => {
      if (path.endsWith('/aborted')) {
        const err = new Error('EACCES: permission denied')
        ;(err as any).code = 'EACCES'
        throw err
      }
      return h.exists(path)
    },
  }
  const res = await recoverEpisodes(errorHost, w)
  assert.equal(res, undefined, 'recovery must return undefined when aborted check throws')
})

test('Sol#3 readHolder: absent only on ENOENT; a lock in an unsearchable dir (EACCES) is unreadable, and the probe keeps the errno', async () => {
  const h = host()
  const dir = join(fresh(), 'd')
  mkdirSync(dir)
  const lock = `${dir}/lock`
  assert.equal(await (await import('./ledger.ts')).readHolder(h, lock), undefined, 'ENOENT is absent')
  assert.equal((await acquireLock(h, lock, holder('A'))).ok, true)
  chmodSync(dir, 0o000)
  try {
    const ledger = await import('./ledger.ts')
    assert.equal(await ledger.readHolder(h, lock), 'unreadable')
    const probe = await ledger.probeHolder(h, lock)
    assert.ok('unreadable' in probe, JSON.stringify(probe))
    assert.match(probe.unreadable, /EACCES/)
    assert.equal(await releaseLock(h, lock, 'A'), false, 'not released while unreadable')
  } finally {
    chmodSync(dir, 0o755)
  }
  assert.equal(await releaseLock(h, lock, 'A'), true)
})

test('readHolder: the same unreadable answer is logged once, not on every reconcile pass', async () => {
  const lines: string[] = []
  const h = nodeHost({ owner: 'me', log: (t: string) => lines.push(t) })
  const dir = join(fresh(), 'd')
  mkdirSync(dir)
  const lock = `${dir}/lock`
  assert.equal((await acquireLock(h, lock, holder('A'))).ok, true)
  chmodSync(dir, 0o000)
  try {
    const { readHolder } = await import('./ledger.ts')
    for (let i = 0; i < 3; i++) assert.equal(await readHolder(h, lock), 'unreadable')
  } finally {
    chmodSync(dir, 0o755)
  }
  assert.equal(lines.filter(l => l.includes(lock)).length, 1, lines.join('\n'))
})
