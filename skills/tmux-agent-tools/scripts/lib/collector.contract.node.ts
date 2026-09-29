// The §10 P2 gate at process level: real collector passes (workers.race.node.ts), each
// its own OS process, against one shared state root. Deliveries are counted in a file
// the contenders append to; the ledger is read straight off disk.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionKey } from './ledger.ts'
import { paneAlive, pasteInto } from './collector.node.ts'

const RACE = new URL('./workers.race.node.ts', import.meta.url).pathname
const COLLECTOR = new URL('./collector.node.ts', import.meta.url).pathname
const OLD = 200 // seconds: past ORPHAN_MS (90 s)

type World = { root: string; v3: string; cwd: string; out: string; ep: string; name: string }

/** One worker whose E1 is sent and finished with an attributed result (`episode: 1`). */
function world(gen0: string): World {
  const root = mkdtempSync(join(tmpdir(), 'wrace-'))
  const cwd = mkdtempSync(join(tmpdir(), 'wrepo-'))
  const v3 = `${root}/.v3`
  const name = 'w.abcde'
  const w = `${v3}/${name}`
  const ep = `${w}/episodes/1`
  mkdirSync(`${ep}/sent`, { recursive: true })
  const since = Date.now() - 60_000
  writeFileSync(`${w}/worker.json`, JSON.stringify({ profile: 'codex', name, dir: cwd, since, owner: gen0, ownerCwd: cwd, origin: 'assign' }))
  writeFileSync(`${ep}/dispatch.json`, JSON.stringify({ seq: 1, since, owner: gen0, resultPath: `${w}/result.json`, origin: 'launch' }))
  writeFileSync(`${w}/result.json`, JSON.stringify({ schema_version: 1, status: 'success', summary: 'did it', artifacts: [], errors: [], episode: 1 }))
  return { root, v3, cwd, out: `${root}/deliveries`, ep, name }
}

/** A session whose one activation beat `agoS` seconds ago. */
function beatAt(w: World, session: string, agoS: number): void {
  const act = `${w.v3}/.sessions/${sessionKey(session)}/act`
  mkdirSync(`${act}/1`, { recursive: true })
  writeFileSync(`${act}/1.beat`, '')
  const t = Date.now() / 1000 - agoS
  utimesSync(`${act}/1`, t, t)
  utimesSync(`${act}/1.beat`, t, t)
}

/** Age every activation beat of `session` (the process stopped beating). */
function ageBeats(w: World, session: string): void {
  const act = `${w.v3}/.sessions/${sessionKey(session)}/act`
  const t = Date.now() / 1000 - OLD
  for (const f of readdirSync(act)) utimesSync(`${act}/${f}`, t, t)
}

type Run = { code: number; activation?: number; paused: string | null; logs: string[] }

function pass(w: World, session: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      [RACE, session, w.cwd],
      { env: { ...process.env, TMUX_AGENT_DIR: w.root, DELIVERIES: w.out, LIVE: `codex-cli-${w.name}`, ...env }, timeout: 30_000 },
      (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
        const line = stdout.trim().split('\n').at(-1)
        const body = line ? (JSON.parse(line) as Omit<Run, 'code'>) : { paused: null, logs: [] }
        resolve({ code, ...body })
      },
    )
  })
}

const delivered = (w: World) => (existsSync(w.out) ? readFileSync(w.out, 'utf8').trim().split('\n').filter(Boolean) : [])
const by = (w: World) => delivered(w).map(l => l.split('\t')[0])
const gens = (w: World) => (existsSync(`${w.ep}/claims`) ? readdirSync(`${w.ep}/claims`).sort() : [])
const acked = (w: World, kind = 'done') => existsSync(`${w.ep}/acks/${kind}`)

async function until(p: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !p(); i++) await new Promise(r => setTimeout(r, 20))
  assert.ok(p(), `timed out waiting for ${what}`)
}

test('slow-claim race (astra-review.md:94-99): 8 collectors see one dead owner; one claim gen, one delivery', async () => {
  const w = world('X')
  beatAt(w, 'X', OLD)
  const claimTick = await Promise.all(Array.from({ length: 8 }, (_, i) => pass(w, `B${i}`)))
  assert.deepEqual(claimTick.map(r => r.code), Array(8).fill(0))
  assert.deepEqual(gens(w), ['1'], 'exactly one claim gen was won')
  assert.deepEqual(delivered(w), [], 'the claim tick delivers nothing')
  const owner = readFileSync(`${w.ep}/claims/1/owner`, 'utf8').trim()
  await Promise.all(Array.from({ length: 8 }, (_, i) => pass(w, `B${i}`)))
  assert.deepEqual(by(w), [owner], 'only the claimant delivers, once')
  assert.ok(acked(w))
})

test('a slow pass that lost its claim delivers nothing (§4 re-check before submit)', async () => {
  const w = world('A')
  const a = pass(w, 'A', { HOLD_READ: '/result.json' })
  await until(() => existsSync(`${w.root}/held.A`), 'A to reach its result read')
  ageBeats(w, 'A') // A stopped beating while it hung
  await pass(w, 'B') // claims gen 1
  await pass(w, 'B') // delivers
  assert.deepEqual(by(w), ['B'])
  writeFileSync(`${w.root}/go.A`, '')
  const r = await a
  assert.equal(r.code, 0)
  assert.deepEqual(by(w), ['B'], 'the old owner, woken, does not deliver a second time')
  assert.ok(r.logs.some(l => l.includes('changed owner during this pass')), r.logs.join('\n'))
})

test('crash between claim mkdir and owner publish: nobody delivers inside the grace, then one claim of gen+1 delivers once', async () => {
  const w = world('X')
  beatAt(w, 'X', OLD)
  assert.equal((await pass(w, 'B', { CRASH_AT: 'claim-owner' })).code, 9)
  assert.deepEqual(gens(w), ['1'])
  assert.ok(!existsSync(`${w.ep}/claims/1/owner`), 'the crash left gen 1 without an owner')
  await pass(w, 'C')
  await pass(w, 'C')
  assert.deepEqual(delivered(w), [], 'an incomplete max gen: nobody owns, nobody delivers')
  assert.deepEqual(gens(w), ['1'], 'no claim of gen 2 inside ORPHAN_MS')
  const t = Date.now() / 1000 - OLD
  utimesSync(`${w.ep}/claims/1`, t, t)
  await pass(w, 'C') // claims gen 2
  await pass(w, 'C') // delivers
  assert.deepEqual(gens(w), ['1', '2'])
  assert.deepEqual(by(w), ['C'])
})

test('crash after submit, before the ack: re-reported (never missed), then acked once', async () => {
  const w = world('A')
  assert.equal((await pass(w, 'A', { CRASH_AT: 'after-submit' })).code, 9)
  assert.equal(delivered(w).length, 1)
  assert.ok(!acked(w))
  await pass(w, 'A')
  assert.equal(delivered(w).length, 2, 'the unacked delivery is reported again')
  assert.ok(acked(w))
  await pass(w, 'A')
  assert.equal(delivered(w).length, 2, 'acked: nothing more')
})

test('crash before submit: nothing recorded, the next pass delivers once', async () => {
  const w = world('A')
  assert.equal((await pass(w, 'A', { CRASH_AT: 'before-submit' })).code, 9)
  assert.deepEqual(delivered(w), [])
  assert.ok(!acked(w))
  await pass(w, 'A')
  await pass(w, 'A')
  assert.equal(delivered(w).length, 1)
  assert.ok(acked(w))
})

test('two activations of one session: the older, woken after a newer registered, delivers nothing', async () => {
  const w = world('A')
  const old = pass(w, 'A', { HOLD_READ: '/result.json' })
  await until(() => existsSync(`${w.root}/held.A`), 'the first activation to hang')
  const fresh = await pass(w, 'A')
  assert.equal(delivered(w).length, 1)
  writeFileSync(`${w.root}/go.A`, '')
  const r = await old
  assert.equal(delivered(w).length, 1)
  assert.ok(r.activation! < fresh.activation!)
  assert.match(r.paused ?? '', /superseded/)
})

test('a submit already past its last check may land twice (allowed re-report); the ack is still one dir', async () => {
  const w = world('A')
  const old = pass(w, 'A', { HOLD_SUBMIT: '1' })
  await until(() => existsSync(`${w.root}/held.A`), 'the first activation to hang inside submit')
  await pass(w, 'A')
  writeFileSync(`${w.root}/go.A`, '')
  await old
  assert.equal(delivered(w).length, 2)
  assert.deepEqual(readdirSync(`${w.ep}/acks`).filter(k => k === 'done'), ['done'])
})

test('an ack that cannot be written is logged and re-reported, never read as delivered', async () => {
  const w = world('A')
  chmodSync(w.ep, 0o555)
  try {
    const r = await pass(w, 'A')
    assert.equal(delivered(w).length, 1)
    assert.ok(r.logs.some(l => l.includes('could not ack')), r.logs.join('\n'))
    await pass(w, 'A')
    assert.equal(delivered(w).length, 2)
  } finally {
    chmodSync(w.ep, 0o755)
  }
  await pass(w, 'A')
  await pass(w, 'A')
  assert.equal(delivered(w).length, 3)
  assert.ok(acked(w))
})

test('an exited-but-open orphan (F1): a dead owner, acks/exited, a late result — one claim gen, one delivery, closed done', async () => {
  const w = world('X')
  beatAt(w, 'X', OLD)
  mkdirSync(`${w.ep}/acks/exited`, { recursive: true })
  const late = readFileSync(`${w.ep}/../../result.json`, 'utf8')
  writeFileSync(`${w.ep}/../../result.json`, '{"schema_version":1,"status":"running"}')
  await Promise.all(Array.from({ length: 4 }, (_, i) => pass(w, `B${i}`)))
  assert.deepEqual(gens(w), ['1'], 'open (exited is not closed): contested, claimed once')
  const owner = readFileSync(`${w.ep}/claims/1/owner`, 'utf8').trim()
  writeFileSync(`${w.ep}/../../result.json`, late)
  await Promise.all(Array.from({ length: 4 }, (_, i) => pass(w, `B${i}`)))
  await Promise.all(Array.from({ length: 4 }, (_, i) => pass(w, `B${i}`)))
  assert.deepEqual(by(w), [owner], 'the late result is delivered once, by the claimant')
  assert.ok(acked(w))
})

test('uncrashed contention: a live owner and 7 peers in one pass each — exactly one delivery, no claim', async () => {
  const w = world('A')
  beatAt(w, 'A', 0)
  await Promise.all([pass(w, 'A'), ...Array.from({ length: 7 }, (_, i) => pass(w, `P${i}`))])
  assert.deepEqual(by(w), ['A'])
  assert.deepEqual(gens(w), [])
})

test('collector entry: missing identity or a pane that is not %N is refused with exit 2', async () => {
  const run = (args: string[]) =>
    new Promise<number>(resolve => execFile(process.execPath, [COLLECTOR, ...args], error => resolve(error ? (typeof error.code === 'number' ? error.code : -1) : 0)))
  assert.equal(await run(['--cwd', '/x', '--pane', '%1']), 2)
  assert.equal(await run(['--session', 's', '--cwd', 'rel', '--pane', '%1']), 2)
  assert.equal(await run(['--session', 's', '--cwd', '/x', '--pane', 'main']), 2)
})

test('collector wake: a bracketed paste into the exact pane, then Enter; a gone pane is a drop', async t => {
  const tmux = (args: string[]) =>
    new Promise<{ code: number; out: string }>(resolve =>
      execFile('tmux', args, { encoding: 'utf8' }, (error, stdout) => resolve({ code: error ? 1 : 0, out: stdout })),
    )
  const name = `tac-collector-${process.pid}`
  if ((await tmux(['new-session', '-d', '-s', name, '-x', '120', '-y', '20', 'cat'])).code !== 0) return t.skip('no tmux server can start here')
  try {
    const pane = (await tmux(['display-message', '-p', '-t', name, '#{pane_id}'])).out.trim()
    assert.ok(await paneAlive(pane))
    assert.deepEqual(await pasteInto(pane, 'line one\nline two'), { text: 'line one\nline two' })
    await new Promise(r => setTimeout(r, 300))
    const screen = (await tmux(['capture-pane', '-p', '-t', pane])).out
    assert.match(screen, /line one/)
    assert.match(screen, /line two/)
  } finally {
    await tmux(['kill-session', '-t', name])
  }
  assert.equal(await paneAlive('%999999'), false)
  assert.match((await pasteInto('%999999', 'x')).drop ?? '', /gone/)
})
