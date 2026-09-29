// Contract tests for the shared core on the v5 ledger (p0-contract.md §2–§8), run by
// plain node against a REAL filesystem: every ledger step (mkdir, ln -sn, mv) is the
// real syscall. Only the outside world — git, the detached launch shell, tmux and
// agent-tmux — is answered by the test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeHost } from './host.node.ts'
import { heartbeat, newGate, panelRows, reconcile, scan, sessionDirOf, stopWorker, tellWorker, assignWorker, resumeWorker, v3Of, type Host } from './workers.ts'
import { ORPHAN_MS, registerActivation, beat } from './ledger.ts'

const BRIEF = 'GOAL: probe\nACCEPTANCE: it runs\nREPORT: one line\n'
const SHA = 'a'.repeat(40)

type Call = { argv: readonly string[]; env?: Record<string, string> }

/**
 * A node host over a fresh state root. `answer` may answer an outside command;
 * anything it leaves (`undefined`) runs for real — the ledger's own syscalls.
 */
function world(opts: { owner?: string; answer?: (argv: readonly string[]) => { exitCode: number; stdout: string; stderr: string } | undefined } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wcore-'))
  const repo = mkdtempSync(join(tmpdir(), 'wrepo-'))
  process.env.TMUX_AGENT_DIR = root
  const calls: Call[] = []
  const woken: string[] = []
  const logs: string[] = []
  const base = nodeHost({ owner: opts.owner ?? 'me', cwd: repo, log: t => logs.push(t), submit: async text => (woken.push(text), undefined) })
  const outside = new Set(['git', 'sh', 'tmux', 'agent-tmux'])
  const host: Host = {
    ...base,
    run: async (argv, cwd, ms) => {
      if (!outside.has(argv[0]!)) return base.run(argv, cwd, ms)
      calls.push({ argv })
      const a = opts.answer?.(argv)
      if (a) return a
      if (argv[0] === 'git') return { exitCode: 0, stdout: `${SHA}\n`, stderr: '' }
      if (argv[0] === 'tmux') return { exitCode: 0, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
  return { host, root, v3: v3Of(root), repo, calls, woken, logs }
}

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const result = (o: Record<string, unknown>) => JSON.stringify({ schema_version: 1, status: 'success', summary: 'did it', artifacts: [], errors: [], ...o })

async function assigned(w: ReturnType<typeof world>, name = 'w') {
  const r = await assignWorker(w.host, { profile: 'astra', name, dir: w.repo, brief: BRIEF }, { owner: w.host.owner() ?? '', ownerCwd: w.repo })
  if ('deny' in r) assert.fail(r.deny)
  return r
}

test('assign: v5 name, worker.json, E1 descriptor + sent, launch on the producer route with TMUX_AGENT_DIR', async () => {
  const w = world()
  const r = await assigned(w)
  assert.match(r.name, /^w\.[0-9a-z]{5}$/)
  assert.equal(r.stateDir, `${w.v3}/${r.name}`)
  assert.deepEqual(
    { ...read(`${r.stateDir}/worker.json`), since: 0 },
    { profile: 'astra', name: r.name, dir: w.repo, since: 0, owner: 'me', ownerCwd: w.repo, origin: 'assign' },
  )
  const e1 = read(`${r.stateDir}/episodes/1/dispatch.json`)
  assert.equal(e1.seq, 1)
  assert.equal(e1.origin, 'launch')
  assert.equal(e1.resultPath, `${r.stateDir}/result.json`)
  assert.equal(e1.owner, 'me')
  assert.equal(e1.base, SHA)
  assert.equal(e1.goal, 'probe')
  assert.ok(existsSync(`${r.stateDir}/episodes/1/sent`))
  assert.ok(!existsSync(`${r.stateDir}/.action`), 'the lock is released')
  const launch = w.calls.find(c => c.argv[0] === 'sh')!.argv[2]!
  // The child is shell-quoted twice (nohup sh -c '<child>'): check the words, not the quoting.
  assert.ok(launch.includes('TMUX_AGENT_DIR=') && launch.includes(w.v3), launch)
  assert.match(launch, /assign.*--detach.*--result-path.*result\.json.*--episode.*1.*brief\.md/)
})

test('assign: a 64-char name keeps its v5 suffix and fits', async () => {
  const w = world()
  const r = await assigned(w, 'a'.repeat(64))
  assert.match(r.name, /^a{58}\.[0-9a-z]{5}$/)
})

test('assign: a bad name is refused before any write or launch', async () => {
  const w = world()
  const r = await assignWorker(w.host, { profile: 'astra', name: 'bad name', dir: w.repo, brief: BRIEF })
  assert.ok('deny' in r)
  assert.deepEqual(w.calls, [])
  assert.ok(!existsSync(w.v3))
})

test('resume: worker.json only, no episode; a row with nothing to deliver, never auto-stopped (F5-2)', async () => {
  const w = world()
  const id = '12345678-1234-1234-1234-123456789abc'
  const out = await resumeWorker(w.host, `codex ${id}`)
  assert.ok(out.ok, out.text)
  const s = await scan(w.host, { claim: false })
  assert.equal(s.visible.length, 1)
  const d = s.visible[0]!
  assert.match(d.name, /^codex-12345678\.[0-9a-z]{5}$/)
  assert.equal(d.seq, 0)
  assert.equal(read(`${w.v3}/${d.name}/worker.json`).origin, 'resume')
  assert.ok(!existsSync(`${w.v3}/${d.name}/episodes`))
  assert.deepEqual(s.quiet, [])
  const argv = w.calls.find(c => c.argv[0] === 'agent-tmux')!.argv
  assert.deepEqual(argv.slice(1, 4), ['codex', 'resume', '--exact'])
})

test('resume: a failed wrapper resume drops the reservation', async () => {
  const w = world({ answer: a => (a[0] === 'agent-tmux' ? { exitCode: 1, stdout: '', stderr: 'no such session' } : undefined) })
  const out = await resumeWorker(w.host, 'codex 12345678-1234-1234-1234-123456789abc')
  assert.ok(!out.ok)
  assert.equal((await scan(w.host, { claim: false })).visible.length, 0)
})

test('tell: resumed worker → seq 1 on episodes/1; assigned worker → seq 2; send carries --result-path/--episode; no result init', async () => {
  const w = world()
  await resumeWorker(w.host, 'codex 12345678-1234-1234-1234-123456789abc')
  const d = (await scan(w.host, { claim: false })).visible[0]!
  const out = await tellWorker(w.host, d, 'do the thing')
  assert.ok(out.ok, out.text)
  const e = read(`${w.v3}/${d.name}/episodes/1/dispatch.json`)
  assert.deepEqual([e.seq, e.origin, e.resultPath], [1, 'tell', `${w.v3}/${d.name}/episodes/1/result.json`])
  assert.ok(existsSync(`${w.v3}/${d.name}/episodes/1/sent`))
  const send = w.calls.filter(c => c.argv[0] === 'agent-tmux').at(-1)!.argv
  assert.deepEqual(send.slice(1, 7), ['codex', 'send', '--result-path', e.resultPath, '--episode', '1'])
  assert.ok(!w.calls.some(c => c.argv.includes('init')), 'no result init')

  const r = await assigned(w)
  const d2 = (await scan(w.host, { claim: false })).visible.find(x => x.name === r.name)!
  await tellWorker(w.host, d2, 'more')
  assert.equal(read(`${r.stateDir}/episodes/2/dispatch.json`).resultPath, `${r.stateDir}/episodes/2/result.json`)
})

test('tell: a failed send marks the episode aborted; scan skips it', async () => {
  const w = world()
  const r = await assigned(w)
  const w2 = { ...w, host: { ...w.host, run: async (argv: readonly string[], cwd: string, ms: number) => (argv[1] === 'astra' && argv[2] === 'send' ? { exitCode: 1, stdout: '', stderr: 'pane gone' } : w.host.run(argv, cwd, ms)) } }
  const d = (await scan(w.host, { claim: false })).visible[0]!
  const out = await tellWorker(w2.host, d, 'x')
  assert.ok(!out.ok)
  assert.ok(existsSync(`${r.stateDir}/episodes/2/aborted`))
  assert.equal((await scan(w.host, { claim: false })).visible[0]!.seq, 1)
})

test('panelRows is read-only; only a collector scan claims an orphan episode; a live owner keeps it', async () => {
  const w = world({ owner: 'dead' })
  const r = await assigned(w)
  // `dead` never registered an activation: non-live.
  const me = { ...w.host, owner: () => 'me' }
  const rows = await panelRows(me, newGate(), w.root)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.holder, 'unknown')
  assert.ok(!existsSync(`${r.stateDir}/episodes/1/claims`))
  await scan(me, { claim: false })
  assert.ok(!existsSync(`${r.stateDir}/episodes/1/claims`))
  // A live owner: fresh beat → not claimed.
  const sd = sessionDirOf(w.v3, 'dead')
  const n = (await registerActivation(w.host, sd, { pid: 1, pidStart: '', host: '', token: 't' }))!
  await beat(w.host, sd, n, Date.now())
  await scan(me, { claim: true })
  assert.ok(!existsSync(`${r.stateDir}/episodes/1/claims`))
  // Stale beat → claimed by exactly this collector.
  const old = (Date.now() - ORPHAN_MS - 5_000) / 1000
  utimesSync(`${sd}/act/${n}.beat`, old, old)
  await scan(me, { claim: true })
  assert.equal(readFileSync(`${r.stateDir}/episodes/1/claims/1/owner`, 'utf8'), 'me\n')
  const d = (await scan(me, { claim: false })).dispatches[0]!
  assert.deepEqual([d.owner, d.adoptedFrom], ['me', 'dead'])
})

test('deliver: an attributed E1 result is delivered once and closes E1 (done + its identity)', async () => {
  const w = world()
  const r = await assigned(w)
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  const gate = newGate()
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 1)
  assert.match(w.woken[0]!, /on astra: success/)
  const acks = (await import('node:fs')).readdirSync(`${r.stateDir}/episodes/1/acks`)
  assert.ok(acks.includes('done'))
  assert.ok(acks.some(a => a.startsWith('unattributed-')), 'the closing snapshot is recorded')
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 1, 'never delivered twice')
  // Closed E1 and no newer episode: an autoStop candidate.
  assert.equal((await scan(w.host, { claim: false })).quiet.length, 1)
})

test('deliver: a decimal-string episode is attributed (F5-3)', async () => {
  const w = world()
  const r = await assigned(w)
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: '1' }))
  await reconcile(w.host, newGate(), false)
  assert.ok(existsSync(`${r.stateDir}/episodes/1/acks/done`))
})

test('unattributed: a result without episode is observed once, E1 stays open; a late attributed one still closes it', async () => {
  const w = world()
  const r = await assigned(w)
  writeFileSync(`${r.stateDir}/result.json`, result({}))
  const gate = newGate()
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 1)
  assert.match(w.woken[0]!, /unattributed/)
  assert.ok(!existsSync(`${r.stateDir}/episodes/1/acks/done`))
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 1, 'the same snapshot is not news twice')
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1, summary: 'late' }))
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 2)
  assert.ok(existsSync(`${r.stateDir}/episodes/1/acks/done`))
})

test('unattributed: a closed episode path is still watched (F4-6); an unchanged closed result is not re-notified after a tell', async () => {
  const w = world()
  const r = await assigned(w)
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  const gate = newGate()
  await reconcile(w.host, gate, false)
  const d = (await scan(w.host, { claim: false })).visible[0]!
  await tellWorker(w.host, d, 'next')
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 1, 'E1’s own closing result is not news')
  mkdirSync(`${r.stateDir}/episodes/2`, { recursive: true })
  writeFileSync(`${r.stateDir}/episodes/2/result.json`, result({ episode: 3 }))
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 2)
  assert.match(w.woken[1]!, /unattributed/)
  assert.ok(!existsSync(`${r.stateDir}/episodes/2/acks/done`))
})

test('expiry: an attributed result older than the window is delivered once as expired and closes (F4-5); a stale seed closes nothing', async () => {
  const w = world()
  const r = await assigned(w)
  writeFileSync(`${r.stateDir}/result.json`, JSON.stringify({ schema_version: 1, status: 'pending', summary: '', artifacts: [], errors: [] }))
  const old = (Date.now() - 25 * 3600_000) / 1000
  utimesSync(`${r.stateDir}/result.json`, old, old)
  const gate = newGate()
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 0, 'a pending seed is not a result')
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1, finished_at: new Date(Date.now() - 25 * 3600_000).toISOString() }))
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 1)
  assert.match(w.woken[0]!, /expired/)
  assert.ok(existsSync(`${r.stateDir}/episodes/1/acks/expired`))
})

test('stop: cancels every open episode, whatever the kill answered', async () => {
  const w = world({ answer: a => (a[0] === 'agent-tmux' && a[2] === 'stop' ? { exitCode: 1, stdout: '', stderr: 'no pane' } : undefined) })
  const r = await assigned(w)
  const d = (await scan(w.host, { claim: false })).visible[0]!
  await tellWorker(w.host, d, 'two')
  const out = await stopWorker(w.host, newGate(), d)
  assert.match(out.text, /cancelled episode\(s\) 1, 2/)
  assert.ok(existsSync(`${r.stateDir}/episodes/1/acks/cancel`) && existsSync(`${r.stateDir}/episodes/2/acks/cancel`))
})

test('stop: an autoStop re-validated inside the lock keeps a pane that took a newer tell', async () => {
  const w = world()
  await assigned(w)
  const d = (await scan(w.host, { claim: false })).visible[0]!
  await tellWorker(w.host, d, 'two')
  const out = await stopWorker(w.host, newGate(), d, 1)
  assert.ok(!out.ok)
  assert.match(out.text, /a tell opened episode 2/)
})

test('activation: a reload registers a newer activation; the older one stops collecting', async () => {
  const w = world()
  const a = newGate()
  const b = newGate()
  assert.equal(await heartbeat(w.host, a), true)
  assert.equal(await heartbeat(w.host, b), true)
  assert.equal(await heartbeat(w.host, a), false)
  assert.match(a.paused ?? '', /superseded/)
  assert.equal(await heartbeat(w.host, b), true)
})

test('activation: two first beats of one gate register once', async () => {
  const w = world()
  const g = newGate()
  await Promise.all([heartbeat(w.host, g), heartbeat(w.host, g)])
  assert.equal(await heartbeat(w.host, g), true)
  assert.equal(g.paused, undefined)
})
