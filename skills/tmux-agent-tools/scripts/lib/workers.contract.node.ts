// Contract tests for the shared core on the v5 ledger (p0-contract.md §2–§8), run by
// plain node against a REAL filesystem: every ledger step (mkdir, ln -sn, mv) is the
// real syscall. Only the outside world — git, the detached launch shell, tmux and
// agent-tmux — is answered by the test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeHost } from './host.node.ts'
import { ackFinished, autoStop, AUTO_STOP_MS, cancelEpisode, collect, flagStalls, heartbeat, launchFailure, newGate, partitionWaiters, processId, reserve, takeLock, unlockWorker, panelRows, reconcile, rowMark, scan, sessionDirOf, stopWorker, tellWorker, assignWorker, resumeWorker, v3Of, UNKNOWN, LAUNCH_FAILED, type Host } from './workers.ts'
import { panel } from './snapshot.node.ts'
import { ORPHAN_MS, registerActivation, beat, releaseLock } from './ledger.ts'

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

test('tell: a failed send is uncertain, not aborted (F4) — the episode stays watched and never re-sent', async () => {
  const w = world()
  const r = await assigned(w)
  const w2 = { ...w, host: { ...w.host, run: async (argv: readonly string[], cwd: string, ms: number) => (argv[1] === 'astra' && argv[2] === 'send' ? { exitCode: 1, stdout: '', stderr: 'pane gone' } : w.host.run(argv, cwd, ms)) } }
  const d = (await scan(w.host, { claim: false })).visible[0]!
  const out = await tellWorker(w2.host, d, 'x')
  assert.ok(!out.ok)
  assert.match(out.text, /may still have reached the pane/)
  assert.ok(!existsSync(`${r.stateDir}/episodes/2/aborted`), 'a failed exit is not proof nothing was sent')
  assert.ok(existsSync(`${r.stateDir}/episodes/2/uncertain`))
  assert.ok(existsSync(`${r.stateDir}/episodes/2/sent`), 'sent: recovery never re-sends it')
  const after = await scan(w.host, { claim: false })
  assert.equal(after.visible[0]!.seq, 2, 'E2 is the watched episode')
  assert.deepEqual(after.unsent, [])
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

test('S1 (a): after a newer activation registers, the older one starts no new round of delivery', async () => {
  const w = world()
  const r = await assigned(w)
  const old = newGate()
  await reconcile(w.host, old, false)
  assert.equal(old.activation, 1)
  const fresh = newGate()
  assert.equal(await heartbeat(w.host, fresh), true)
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  await reconcile(w.host, old, false)
  await reconcile(w.host, old, false)
  assert.deepEqual(w.woken, [], 'the superseded activation submits nothing, on any later round')
  assert.match(old.paused ?? '', /superseded/)
  assert.ok(!existsSync(`${r.stateDir}/episodes/1/acks/done`), 'and acks nothing')
  await reconcile(w.host, fresh, false)
  assert.equal(w.woken.length, 1, 'the newer activation delivers it')
  assert.ok(existsSync(`${r.stateDir}/episodes/1/acks/done`))
})

test('activation: two first beats of one gate register once', async () => {
  const w = world()
  const g = newGate()
  await Promise.all([heartbeat(w.host, g), heartbeat(w.host, g)])
  assert.equal(await heartbeat(w.host, g), true)
  assert.equal(g.paused, undefined)
})

test('observation identity: a byte- and metadata-preserving rewrite is no notice; same bytes with a moved mtime is one; other bytes with the same size and mtime is one (R3-1, F4-2)', async () => {
  const w = world()
  const r = await assigned(w)
  const launch = `${r.stateDir}/result.json`
  const T = Math.floor(Date.now() / 1000) - 60
  writeFileSync(launch, result({ episode: 1 }))
  utimesSync(launch, T, T)
  const gate = newGate()
  await reconcile(w.host, gate, false)
  await tellWorker(w.host, (await scan(w.host, { claim: false })).visible[0]!, 'next') // E2 open
  writeFileSync(launch, readFileSync(launch))
  utimesSync(launch, T, T)
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 1, 'not observable, as documented (F4-2)')
  utimesSync(launch, T + 5, T + 5)
  await reconcile(w.host, gate, false)
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 2, 'a moved mtime is a new snapshot: one notice')
  assert.match(w.woken[1]!, /unattributed/)
  writeFileSync(launch, readFileSync(launch, 'utf8').replace('did it', 'did IT'))
  utimesSync(launch, T + 5, T + 5)
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 3, 'same size and mtime, other bytes: the sha256 differs')
  assert.ok(!existsSync(`${r.stateDir}/episodes/2/acks/done`), 'E2 stays open throughout')
})

test('recovery then a new tell: the recovered episode is still delivered (RECOVERY_OVERTAKEN); the tell takes the next seq', async () => {
  const w = world()
  const r = await assigned(w)
  const ep2 = `${r.stateDir}/episodes/2`
  // A tell crashed after publishing E2's descriptor, before `sent`.
  mkdirSync(ep2, { recursive: true })
  writeFileSync(`${ep2}/dispatch.json`, JSON.stringify({ seq: 2, since: Date.now(), owner: 'me', resultPath: `${ep2}/result.json`, origin: 'tell' }))
  const gate = newGate()
  await reconcile(w.host, gate, false)
  assert.ok(existsSync(`${ep2}/uncertain`) && existsSync(`${ep2}/sent`), 'recovered as uncertain + sent, never re-sent')
  await tellWorker(w.host, (await scan(w.host, { claim: false })).visible[0]!, 'three')
  assert.ok(existsSync(`${r.stateDir}/episodes/3/sent`))
  writeFileSync(`${ep2}/result.json`, result({ episode: 2 }))
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 1)
  assert.ok(existsSync(`${ep2}/acks/done`))
  assert.ok(!existsSync(`${r.stateDir}/episodes/3/acks`), 'E3 is untouched')
})

test('a waiter binds its own episode only: a running E1 waiter holds E1, and E2 (no waiter) is delivered by submit', async () => {
  const w = world()
  const r = await assigned(w)
  writeFileSync(`${r.stateDir}/episodes/1/waiter`, JSON.stringify({ agentId: 'ag1' }))
  const host: Host = { ...w.host, agentList: async () => [{ id: 'ag1', status: 'running' }] }
  const gate = newGate()
  await tellWorker(host, (await scan(host, { claim: false })).visible[0]!, 'two')
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  writeFileSync(`${r.stateDir}/episodes/2/result.json`, result({ episode: 2, summary: 'second' }))
  await reconcile(host, gate, false)
  assert.equal(w.woken.length, 1)
  assert.match(w.woken[0]!, /second/)
  assert.ok(!existsSync(`${r.stateDir}/episodes/1/acks`), 'E1 waits for its waiter')
  assert.ok(existsSync(`${r.stateDir}/episodes/2/acks/done`))
})

test('tell during a collect pass: the pass acks only the episode it read; the new episode stays open', async () => {
  const w = world()
  const r = await assigned(w)
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  let told = false
  const host: Host = {
    ...w.host,
    read: async path => {
      if (!told && path === `${r.stateDir}/result.json`) {
        told = true
        await tellWorker(w.host, (await scan(w.host, { claim: false })).visible[0]!, 'two')
      }
      return w.host.read(path)
    },
  }
  await reconcile(host, newGate(), false)
  assert.ok(told)
  assert.equal(w.woken.length, 1)
  assert.ok(existsSync(`${r.stateDir}/episodes/1/acks/done`))
  assert.ok(!existsSync(`${r.stateDir}/episodes/2/acks`))
  const s = await scan(w.host, { claim: false })
  assert.deepEqual(s.dispatches.filter(d => !s.reported.has(`${d.name}#${d.seq}`)).map(d => d.seq), [2])
})


/** A second live session on the same root and repo: its own owner and wake list. */
function peer(w: ReturnType<typeof world>, owner: string) {
  const woken: string[] = []
  const host: Host = { ...w.host, owner: () => owner, submit: async text => (woken.push(text), undefined) }
  return { host, woken }
}

test('two owners (F2): an attributed result of another live owner’s open episode is theirs alone — no false unattributed notice', async () => {
  const w = world({ owner: 'A' })
  const r = await assigned(w)
  const b = peer(w, 'B')
  const ga = newGate()
  const gb = newGate()
  assert.ok(await heartbeat(w.host, ga))
  assert.ok(await heartbeat(b.host, gb))
  await tellWorker(b.host, (await scan(b.host, { claim: false })).visible[0]!, 'two')
  writeFileSync(`${r.stateDir}/episodes/2/result.json`, result({ episode: 2 }))
  await reconcile(w.host, ga, false)
  assert.deepEqual(w.woken, [], 'A owns E1 only; E2’s attributed result is not A’s news')
  await reconcile(b.host, gb, false)
  assert.equal(b.woken.length, 1)
  assert.match(b.woken[0]!, /on astra: success/)
  assert.ok(existsSync(`${r.stateDir}/episodes/2/acks/done`))
})

test('two owners (F2): an unattributed write on another owner’s open path is noticed once, by the owner of the max open episode', async () => {
  const w = world({ owner: 'A' })
  const r = await assigned(w)
  const b = peer(w, 'B')
  const ga = newGate()
  const gb = newGate()
  assert.ok(await heartbeat(w.host, ga))
  assert.ok(await heartbeat(b.host, gb))
  await tellWorker(b.host, (await scan(b.host, { claim: false })).visible[0]!, 'two')
  writeFileSync(`${r.stateDir}/result.json`, result({}))
  await reconcile(w.host, ga, false)
  await reconcile(b.host, gb, false)
  await reconcile(w.host, ga, false)
  assert.deepEqual(w.woken, [])
  assert.equal(b.woken.length, 1)
  assert.match(b.woken[0]!, /unattributed/)
  assert.ok(!existsSync(`${r.stateDir}/episodes/1/acks/done`), 'E1 stays open')
})

test('superseded unknown (F3): an unreadable act dir stops the tick and the submit, without pausing', async () => {
  const w = world()
  const r = await assigned(w)
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  let broken = false
  const host: Host = {
    ...w.host,
    list: async path => {
      if (broken && path.endsWith('/act')) throw new Error('EIO: act')
      return w.host.list(path)
    },
    read: async path => {
      if (path === `${r.stateDir}/result.json`) broken = true
      return w.host.read(path)
    },
  }
  const gate = newGate()
  await reconcile(host, gate, false) // breaks between the beat and the submit
  assert.deepEqual(w.woken, [], 'stillOurs: unknown is not "still the newest"')
  assert.equal(gate.paused, undefined)
  assert.equal(await heartbeat(host, gate), false, 'the next beat sees unknown too')
  assert.equal(gate.paused, undefined)
  broken = false
  const healthy: Host = { ...w.host }
  await reconcile(healthy, gate, false)
  assert.equal(w.woken.length, 1, 'readable again: delivered')
})

test('no identity (F5): no beat, no claim, no episode written', async () => {
  const w = world({ owner: 'dead' })
  const r = await assigned(w)
  const anon: Host = { ...w.host, owner: () => undefined }
  assert.equal(await heartbeat(anon, newGate()), false)
  const old = (Date.now() - ORPHAN_MS - 5_000) / 1000
  mkdirSync(`${sessionDirOf(w.v3, 'dead')}/act/1`, { recursive: true })
  utimesSync(`${sessionDirOf(w.v3, 'dead')}/act/1`, old, old)
  await scan(anon, { claim: true })
  assert.ok(!existsSync(`${r.stateDir}/episodes/1/claims`), 'an anonymous collector owns nothing')
  const denied = await assignWorker(w.host, { profile: 'astra', name: 'x', dir: w.repo, brief: BRIEF }, { owner: '', ownerCwd: w.repo })
  assert.ok('deny' in denied)
  const told = await tellWorker(anon, (await scan(w.host, { claim: false })).visible[0]!, 'two')
  assert.ok(!told.ok)
  assert.ok(!existsSync(`${r.stateDir}/episodes/2`))
})

test('stop on unknown (F7): an episode list that cannot be read refuses the stop', async () => {
  const w = world()
  const r = await assigned(w)
  const d = (await scan(w.host, { claim: false })).visible[0]!
  const host: Host = { ...w.host, list: async path => (path.endsWith('/episodes') ? Promise.reject(new Error('EIO')) : w.host.list(path)) }
  const out = await stopWorker(host, newGate(), d)
  assert.ok(!out.ok)
  assert.match(out.text, /could not be read/)
  assert.ok(!w.calls.some(c => c.argv[0] === 'agent-tmux' && c.argv[2] === 'stop'), 'nothing killed on unknown')
  const acks = `${r.stateDir}/episodes/1/acks`
  const host2: Host = { ...w.host, list: async path => (path === acks ? Promise.reject(new Error('EIO')) : w.host.list(path)) }
  mkdirSync(acks, { recursive: true })
  const out2 = await stopWorker(host2, newGate(), d)
  assert.ok(!out2.ok)
  assert.match(out2.text, /episode 1 could not be read/)
})

test('unreadable result (F8): an EIO read is unknown — logged, not delivered, not "no result"; readable again → delivered once', async () => {
  const w = world()
  const r = await assigned(w)
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  let eio = true
  const host: Host = { ...w.host, read: async path => (eio && path === `${r.stateDir}/result.json` ? Promise.reject(new Error('EIO')) : w.host.read(path)) }
  const gate = newGate()
  await reconcile(host, gate, false)
  assert.deepEqual(w.woken, [])
  assert.ok(w.logs.some(l => l.includes('could not read') && l.includes('result.json')), w.logs.join('\n'))
  assert.ok(!existsSync(`${r.stateDir}/episodes/1/acks`))
  eio = false
  await reconcile(host, gate, false)
  assert.equal(w.woken.length, 1)
})

test('unreadable waiter (F8): a waiter record that cannot be read holds its episode', async () => {
  const w = world()
  const r = await assigned(w)
  writeFileSync(`${r.stateDir}/episodes/1/waiter`, JSON.stringify({ agentId: 'ag1' }))
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  const host: Host = {
    ...w.host,
    agentList: async () => [],
    read: async path => (path.endsWith('/waiter') ? Promise.reject(new Error('EIO')) : w.host.read(path)),
  }
  await reconcile(host, newGate(), false)
  assert.deepEqual(w.woken, [])
  assert.ok(!existsSync(`${r.stateDir}/episodes/1/acks`))
})

test('identity ack failure (F9): no done without the closing snapshot’s identity; re-reported, then closed once', async () => {
  const w = world()
  const r = await assigned(w)
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  let fail = true
  const host: Host = {
    ...w.host,
    run: async (argv, cwd, ms) =>
      fail && argv[0] === 'mkdir' && /\/acks\/unattributed-/.test(argv.at(-1) ?? '') ? { exitCode: 1, stdout: '', stderr: 'Input/output error' } : w.host.run(argv, cwd, ms),
  }
  const gate = newGate()
  await reconcile(host, gate, false)
  assert.equal(w.woken.length, 1)
  assert.ok(!existsSync(`${r.stateDir}/episodes/1/acks/done`), 'done waits for the identity')
  fail = false
  await reconcile(host, gate, false)
  assert.equal(w.woken.length, 2, 'unacked: reported again')
  assert.ok(existsSync(`${r.stateDir}/episodes/1/acks/done`))
  await reconcile(host, gate, false)
  assert.equal(w.woken.length, 2)
})

test('waiter release under the lock (F10): a held lock defers the release; free, the ended waiter is released', async () => {
  const w = world()
  const r = await assigned(w)
  writeFileSync(`${r.stateDir}/episodes/1/waiter`, JSON.stringify({ agentId: 'ag1' }))
  const host: Host = { ...w.host, agentList: async () => [] }
  const lock = `${r.stateDir}/.action`
  ;(await import('node:fs')).symlinkSync(JSON.stringify({ token: 'other', session: 'x' }), lock)
  await reconcile(host, newGate(), false)
  assert.equal(read(`${r.stateDir}/episodes/1/waiter`).agentId, 'ag1', 'the lock holder’s action is not overwritten')
  ;(await import('node:fs')).unlinkSync(lock)
  await reconcile(host, newGate(), false)
  assert.deepEqual(read(`${r.stateDir}/episodes/1/waiter`), {})
  assert.ok(!existsSync(lock), 'released')
})

test('autoStop re-reads max n (F10): a superseded activation stops nothing', async () => {
  const done = Date.now() - AUTO_STOP_MS - 60_000
  let name = ''
  const w = world({
    answer: a =>
      a[0] === 'tmux' ? { exitCode: 0, stdout: `astra-cli-${name}\n`, stderr: '' }
      : a[0] === 'agent-tmux' && a[2] === 'status' ? { exitCode: 0, stdout: JSON.stringify({ running: false, idle_seconds: AUTO_STOP_MS / 1000 + 60 }), stderr: '' }
      : undefined,
  })
  const r = await assigned(w)
  name = r.name
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  const old = newGate()
  await heartbeat(w.host, old)
  const d = { ...(await scan(w.host, { claim: false })).visible[0]!, since: done }
  await heartbeat(w.host, newGate()) // a reload registers a newer activation
  const t = done / 1000
  utimesSync(`${r.stateDir}/result.json`, t, t)
  await autoStop(w.host, old, w.v3, [d], Date.now())
  assert.ok(!w.calls.some(c => c.argv[0] === 'agent-tmux' && c.argv[2] === 'stop'), 'nothing stopped')
  assert.ok(w.logs.some(l => l.includes('not auto-stopping') && l.includes('superseded')), w.logs.join('\n'))
  // The newest activation, same inputs: stopped (the test reaches the stop).
  const fresh = newGate()
  await heartbeat(w.host, fresh)
  await autoStop(w.host, fresh, w.v3, [d], Date.now())
  assert.ok(w.calls.some(c => c.argv[0] === 'agent-tmux' && c.argv[2] === 'stop'))
})

test('episode cancel (F6, §5): closes one episode, never the pane; idempotent; a missing episode or a held lock is refused', async () => {
  const w = world()
  const r = await assigned(w)
  await tellWorker(w.host, (await scan(w.host, { claim: false })).visible[0]!, 'two')
  const out = await cancelEpisode(w.host, r.name, 1)
  assert.ok(out.ok, out.text)
  assert.ok(existsSync(`${r.stateDir}/episodes/1/acks/cancel`))
  assert.ok(!existsSync(`${r.stateDir}/episodes/2/acks`), 'E2 stays open')
  assert.ok(!w.calls.some(c => c.argv[0] === 'agent-tmux' && c.argv[2] === 'stop'), 'the pane is untouched')
  assert.match((await cancelEpisode(w.host, r.name, 1)).text, /already closed \(cancel\)/)
  assert.ok(!(await cancelEpisode(w.host, r.name, 9)).ok)
  const held = await takeLock(w.host, r.stateDir)
  assert.ok(held.ok)
  const busy = await cancelEpisode(w.host, r.name, 2)
  assert.ok(!busy.ok)
  assert.match(busy.text, /busy/)
  const s = await scan(w.host, { claim: false })
  assert.deepEqual(s.dispatches.filter(d => !s.reported.has(`${d.name}#${d.seq}`)).map(d => d.seq), [2])
})

test('lock holder (F6): takeLock records this process — host, pid, start time — for a later unlock', async () => {
  const w = world()
  const r = await assigned(w)
  const me = await processId(w.host)
  assert.equal(me.pid, process.pid)
  assert.ok(me.host && me.pidStart)
  const lock = await takeLock(w.host, r.stateDir)
  assert.ok(lock.ok)
  const h = JSON.parse((await import('node:fs')).readlinkSync(`${r.stateDir}/.action`))
  assert.deepEqual([h.session, h.host, h.pid, h.pidStart], ['me', me.host, process.pid, me.pidStart])
})

test('unlock (F6, §5): maintenance only — needs confirm; refuses a live process, a live session, another host, no pid; removes a gone holder', async () => {
  const w = world()
  const r = await assigned(w)
  const fs = await import('node:fs')
  const lock = `${r.stateDir}/.action`
  const me = await processId(w.host)
  const hold = (h: Record<string, unknown>) => {
    if (fs.existsSync(lock) || (() => { try { fs.readlinkSync(lock); return true } catch { return false } })()) fs.unlinkSync(lock)
    fs.symlinkSync(JSON.stringify({ token: 't', activation: '', session: 'gone', host: me.host, pid: 999_999, pidStart: 'Thu Jan  1 00:00:00 1970', ...h }), lock)
  }
  assert.match((await unlockWorker(w.host, r.name)).text, /not locked/)
  hold({})
  const ask = await unlockWorker(w.host, r.name)
  assert.ok(!ask.ok)
  assert.match(ask.text, /unlock .* confirm/)
  assert.ok(fs.readlinkSync(lock))
  hold({ pid: process.pid, pidStart: me.pidStart })
  assert.match((await unlockWorker(w.host, r.name, 'confirm')).text, /still running/)
  hold({ host: 'elsewhere' })
  assert.match((await unlockWorker(w.host, r.name, 'confirm')).text, /not provably this host/)
  hold({ pid: 0, pidStart: '' })
  assert.match((await unlockWorker(w.host, r.name, 'confirm')).text, /records no process/)
  const sd = sessionDirOf(w.v3, 'gone')
  const n = (await registerActivation(w.host, sd, { pid: 1, pidStart: '', host: '', token: 'x' }))!
  await beat(w.host, sd, n, Date.now())
  hold({})
  assert.match((await unlockWorker(w.host, r.name, 'confirm')).text, /session is live/)
  const old = (Date.now() - ORPHAN_MS - 5_000) / 1000
  utimesSync(`${sd}/act/${n}.beat`, old, old)
  const done = await unlockWorker(w.host, r.name, 'confirm')
  assert.ok(done.ok, done.text)
  assert.throws(() => fs.readlinkSync(lock), 'removed')
})

test('workers CLI (F6): cancel and unlock on the shared ledger; bad arguments exit 2', async () => {
  const w = world()
  const r = await assigned(w)
  const cli = new URL('./workers.cli.node.ts', import.meta.url).pathname
  const { execFile } = await import('node:child_process')
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string }>(resolve =>
      execFile(process.execPath, [cli, ...args], { env: { ...process.env, TMUX_AGENT_DIR: w.root } }, (error, stdout) =>
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, out: stdout }),
      ),
    )
  const id = ['--session', 'me', '--cwd', w.repo]
  const c = await run([...id, 'cancel', r.name, '1'])
  assert.equal(c.code, 0, c.out)
  assert.ok(existsSync(`${r.stateDir}/episodes/1/acks/cancel`))
  assert.equal((await run([...id, 'unlock', r.name])).code, 0)
  assert.equal((await run([...id, 'cancel', r.name])).code, 2)
  assert.equal((await run([...id, 'nope'])).code, 2)
  assert.equal((await run([...id, 'cancel', r.name, '7'])).code, 1)
})

test('reserve (F6): a drawn name whose tmux session exists is redrawn, never reserved; two hits deny', async () => {
  let live = ''
  const w = world({ answer: a => (a[0] === 'tmux' ? { exitCode: 0, stdout: live, stderr: '' } : undefined) })
  const rec = { profile: 'astra', dir: w.repo, since: Date.now(), owner: 'me', ownerCwd: w.repo, origin: 'assign' as const }
  live = 'astra-cli-w.aaaaa\n'
  const draws = ['aaaaa', 'bbbbb']
  const got = await reserve(w.host, w.v3, 'w', rec, w.repo, () => draws.shift()!)
  assert.deepEqual(got, { name: 'w.bbbbb', w: `${w.v3}/w.bbbbb` })
  assert.ok(!existsSync(`${w.v3}/w.aaaaa`), 'the live name is never reserved')
  live = 'astra-cli-w.ccccc\nastra-cli-w.ddddd\n'
  const both = ['ccccc', 'ddddd']
  const denied = await reserve(w.host, w.v3, 'w', rec, w.repo, () => both.shift()!)
  assert.ok('deny' in denied)
  assert.ok(!w.calls.some(c => c.argv[0] === 'agent-tmux'), 'the wrapper never ran on a live name')
})

test('a seq ≥ 2 result on the launch path (§10): one unattributed notice; E1 and E2 stay open', async () => {
  const w = world()
  const r = await assigned(w)
  await tellWorker(w.host, (await scan(w.host, { claim: false })).visible[0]!, 'two')
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 2 }))
  const gate = newGate()
  await reconcile(w.host, gate, false)
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 1)
  assert.match(w.woken[0]!, /unattributed/)
  assert.ok(!existsSync(`${r.stateDir}/episodes/1/acks/done`))
  assert.ok(!existsSync(`${r.stateDir}/episodes/2/acks/done`), 'E2 closes only from its own path')
})

function lstartOf(tz: string): string {
  const env = { ...process.env }
  delete env.TMUX
  delete env.TMUX_PANE
  const r = spawnSync('/bin/sh', ['-c', 'TZ="$1" LC_ALL=C ps -o lstart= -p "$2"', 'ps', tz, String(process.pid)], {
    encoding: 'utf8',
    env,
  })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

test('unlock (R6.0): a broken ps and a kill -0 without ESRCH is unknown, not gone — the lock stays', async () => {
  const w = world()
  const r = await assigned(w)
  const fs = await import('node:fs')
  const lock = `${r.stateDir}/.action`
  const me = await processId(w.host)
  fs.symlinkSync(JSON.stringify({ token: 't', activation: '', session: 'gone', host: me.host, pid: 999_999, pidStart: 'Thu Jan  1 00:00:00 1970' }), lock)
  const broken: Host = {
    ...w.host,
    run: async (argv, cwd, ms) =>
      argv[4] === '999999'
        ? { exitCode: 1, stdout: '', stderr: argv[3] === 'ps' ? 'ps: broken' : 'kill: Operation not permitted' }
        : w.host.run(argv, cwd, ms),
  }
  const out = await unlockWorker(broken, r.name, 'confirm')
  assert.ok(!out.ok)
  assert.match(out.text, /could not check pid 999999/)
  assert.ok(fs.readlinkSync(lock).includes('999999'), 'the lock is kept')
})

test('unlock lstart (R2-1): a live holder is kept when the recorded start is UTC and the process TZ is not', async () => {
  const utc = lstartOf('UTC')
  const taipei = lstartOf('Asia/Taipei')
  assert.notEqual(utc, taipei)
  const w = world()
  const r = await assigned(w)
  const fs = await import('node:fs')
  const lock = `${r.stateDir}/.action`
  const me = await processId(w.host)
  const prev = process.env.TZ
  process.env.TZ = 'Asia/Taipei'
  try {
    if (fs.existsSync(lock) || (() => { try { fs.readlinkSync(lock); return true } catch { return false } })()) fs.unlinkSync(lock)
    fs.symlinkSync(JSON.stringify({ token: 't', activation: '', session: 'gone', host: me.host, pid: process.pid, pidStart: utc }), lock)
    const out = await unlockWorker(w.host, r.name, 'confirm')
    assert.match(out.text, /still running/)
    assert.equal(fs.readlinkSync(lock).includes(String(process.pid)), true)
  } finally {
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
})

test('processId (R2-2): a failed probe is not cached', () => {
  const url = new URL('./workers.ts', import.meta.url).href
  const code = `
    const { processId } = await import(${JSON.stringify(url)})
    let calls = 0
    const host = { run: async () => {
      calls += 1
      if (calls === 1) return { exitCode: 1, stdout: '', stderr: 'fail' }
      return { exitCode: 0, stdout: '4242\\nprobe-host\\nTue Jan  1 00:00:00 2020\\n', stderr: '' }
    }}
    const a = await processId(host)
    const b = await processId(host)
    console.log(JSON.stringify({ calls, aPid: a.pid, bPid: b.pid }))
  `
  const env = { ...process.env }
  delete env.TMUX
  delete env.TMUX_PANE
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  const got = JSON.parse(r.stdout) as { calls: number; aPid: number; bPid: number }
  assert.equal(got.calls, 2)
  assert.equal(got.aPid, 0)
  assert.equal(got.bPid, 4242)
})

test('agent.list failure (R2-3): a notice with a waiter is not delivered; one without still is', async () => {
  const w = world()
  const r = await assigned(w)
  const d = (await scan(w.host, { claim: false })).visible[0]!
  const host: Host = { ...w.host, agentList: async () => { throw new Error('EIO') } }
  const notice = (waiter?: string) => ({ d: waiter ? { ...d, waiter } : d, path: `${r.stateDir}/result.json`, status: 'success', summary: 'did it' })
  const parted = await partitionWaiters(host, newGate(), [notice('ag-live'), notice()])
  assert.equal(parted.deliver.length, 1)
  assert.equal(parted.deliver[0]!.d.waiter, undefined)
  assert.equal(parted.silent.length, 0)
  assert.ok(w.logs.some(l => l.includes('agent.list failed')))
})

test('waiter bind (R2-4): the waiter file is written while the action lock is held, and a binding record is not submitted', async () => {
  const w = world()
  let held = false
  const r = await assignWorker(
    w.host,
    { profile: 'astra', name: 'w', dir: w.repo, brief: BRIEF },
    {
      owner: 'me',
      ownerCwd: w.repo,
      bindWaiter: async stateDir => {
        try { readlinkSync(`${stateDir}/.action`); held = true } catch { held = false }
        await w.host.write(`${stateDir}/episodes/1/waiter`, '{"binding":true}')
        writeFileSync(`${stateDir}/result.json`, result({ episode: 1 }))
        await reconcile(w.host, newGate(), false)
        assert.deepEqual(w.woken, [])
        await w.host.write(`${stateDir}/episodes/1/waiter`, JSON.stringify({ agentId: 'ag-live' }))
      },
    },
  )
  if ('deny' in r) assert.fail(r.deny)
  assert.equal(held, true)
  assert.equal(JSON.parse(readFileSync(`${r.stateDir}/episodes/1/waiter`, 'utf8')).agentId, 'ag-live')
  assert.throws(() => readlinkSync(`${r.stateDir}/.action`))
})

test('waiter bind: a stale binding record delivers E1 once after the action lock is released', async () => {
  const w = world()
  const r = await assigned(w)
  const lock = await takeLock(w.host, r.stateDir)
  if (!lock.ok) assert.fail('lock')
  await w.host.write(`${r.stateDir}/episodes/1/waiter`, JSON.stringify({ binding: true, token: lock.token }))
  assert.equal(await releaseLock(w.host, `${r.stateDir}/.action`, lock.token), true)
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  const gate = newGate()
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 1)
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 1, 'delivered exactly once')
})

test('waiter bind: a binding record is not delivered while its token holds the action lock', async () => {
  const w = world()
  const r = await assigned(w)
  const lock = await takeLock(w.host, r.stateDir)
  if (!lock.ok) assert.fail('lock')
  await w.host.write(`${r.stateDir}/episodes/1/waiter`, JSON.stringify({ binding: true, token: lock.token }))
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  await reconcile(w.host, newGate(), false)
  assert.equal(w.woken.length, 0)
  await releaseLock(w.host, `${r.stateDir}/.action`, lock.token)
})

test('waiter bind: a binding record whose token differs from the lock holder is delivered', async () => {
  const w = world()
  const r = await assigned(w)
  const lock = await takeLock(w.host, r.stateDir)
  if (!lock.ok) assert.fail('lock')
  await w.host.write(`${r.stateDir}/episodes/1/waiter`, JSON.stringify({ binding: true, token: 'not-the-holder' }))
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  await reconcile(w.host, newGate(), false)
  assert.equal(w.woken.length, 1)
  await releaseLock(w.host, `${r.stateDir}/.action`, lock.token)
})

test('closing snapshot without identity (R2-5): a stat failure does not write done', async () => {
  const w = world()
  const r = await assigned(w)
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  const host: Host = {
    ...w.host,
    stat: async path => (path === `${r.stateDir}/result.json` ? Promise.reject(new Error('EIO')) : w.host.stat(path)),
  }
  await reconcile(host, newGate(), false)
  assert.equal(w.woken.length, 1)
  assert.ok(!existsSync(`${r.stateDir}/episodes/1/acks/done`))
})

test('stop cancel unknown (R2-7): an unrecorded cancel is not reported as cancelled', async () => {
  const w = world()
  const r = await assigned(w)
  const d = (await scan(w.host, { claim: false })).visible[0]!
  const host: Host = {
    ...w.host,
    run: async (argv, cwd, ms) =>
      argv[0] === 'mkdir' && String(argv.at(-1)).endsWith('/acks/cancel')
        ? { exitCode: 1, stdout: '', stderr: 'Input/output error' }
        : w.host.run(argv, cwd, ms),
  }
  const out = await stopWorker(host, newGate(), d)
  assert.equal(out.ok, false)
  assert.doesNotMatch(out.text, /cancelled episode/)
  assert.ok(!existsSync(`${r.stateDir}/episodes/1/acks/cancel`))
})

test('workers CLI (§3, §9): missing --session or --cwd is refused; assign, tell, stop and rows call the core', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wcli-'))
  const repo = mkdtempSync(join(tmpdir(), 'wrepo-'))
  const bin = mkdtempSync(join(tmpdir(), 'wbin-'))
  const log = join(root, 'fake.log')
  writeFileSync(log, '')
  writeFileSync(`${bin}/agent-tmux`, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_LOG"\nexit 0\n')
  chmodSync(`${bin}/agent-tmux`, 0o755)
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo })
  const brief = join(root, 'brief.md')
  const text = join(root, 'tell.md')
  writeFileSync(brief, BRIEF)
  writeFileSync(text, 'next step\n')
  const cli = new URL('./workers.cli.node.ts', import.meta.url).pathname
  const { execFile } = await import('node:child_process')
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>(resolve =>
      execFile(
        process.execPath,
        [cli, ...args],
        { env: { ...process.env, TMUX_AGENT_DIR: root, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_LOG: log } },
        (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, out: stdout, err: stderr }),
      ),
    )
  const noSession = await run(['rows', '--cwd', repo])
  assert.equal(noSession.code, 2, noSession.err)
  assert.match(noSession.err, /--session is required/)
  const noCwd = await run(['rows', '--session', 's1'])
  assert.equal(noCwd.code, 2, noCwd.err)
  assert.match(noCwd.err, /--cwd/)
  const id = ['--session', 's1', '--cwd', repo]
  const assignedCli = await run(['assign', 'codex', 'w', repo, brief, ...id])
  assert.equal(assignedCli.code, 0, assignedCli.out + assignedCli.err)
  assert.match(assignedCli.out, /end the turn/)
  const rows = await run(['rows', ...id])
  assert.equal(rows.code, 0, rows.err)
  const parsed = JSON.parse(rows.out) as { d: { name: string } }[]
  assert.equal(parsed.length, 1)
  assert.match(parsed[0]!.d.name, /^w\.[0-9a-z]{5}$/)
  const name = parsed[0]!.d.name
  assert.ok(existsSync(`${root}/.v3/${name}/episodes/1/dispatch.json`))
  const told = await run(['tell', name, text, ...id])
  assert.equal(told.code, 0, told.out + told.err)
  assert.match(readFileSync(log, 'utf8'), /send/)
  assert.match(readFileSync(log, 'utf8'), /--episode/)
  const stopped = await run(['stop', name, ...id])
  assert.equal(stopped.code, 0, stopped.out + stopped.err)
  assert.match(readFileSync(log, 'utf8'), /stop/)
})

test('a send blocked past ORPHAN_MS does not lose ownership while its beat still runs (§4)', async () => {
  const w = world()
  const r = await assigned(w)
  const gate = newGate()
  assert.equal(await heartbeat(w.host, gate), true)
  let release: () => void = () => {}
  const hung = new Promise<void>(res => {
    release = res
  })
  let saw = false
  const orig = w.host.run
  w.host.run = (argv, cwd, ms) => {
    if (argv[0] === 'agent-tmux' && argv[2] === 'send') {
      saw = true
      return hung.then(() => ({ exitCode: 0, stdout: '', stderr: '' }))
    }
    return orig(argv, cwd, ms)
  }
  const d = (await scan(w.host, { claim: false })).visible[0]!
  const telling = tellWorker(w.host, d, 'hold the send')
  for (let i = 0; i < 200 && !saw; i++) await new Promise(res => setTimeout(res, 10))
  assert.ok(saw, 'the send started')
  const beat = `${sessionDirOf(w.v3, 'me')}/act/${gate.activation}.beat`
  const old = (Date.now() - ORPHAN_MS - 5_000) / 1000
  utimesSync(beat, old, old)
  try {
    assert.equal(await heartbeat(w.host, gate), true, 'the beat is not blocked by the in-flight send')
    const peerWoken: string[] = []
    const peerBase = nodeHost({ owner: 'peer', cwd: w.repo, submit: async text => (peerWoken.push(text), undefined) })
    const peer: Host = {
      ...peerBase,
      run: async (argv, cwd, ms) => {
        if (argv[0] === 'tmux' || argv[0] === 'agent-tmux' || argv[0] === 'sh') return { exitCode: 0, stdout: '', stderr: '' }
        if (argv[0] === 'git') return { exitCode: 0, stdout: `${SHA}\n`, stderr: '' }
        return peerBase.run(argv, cwd, ms)
      },
    }
    await reconcile(peer, newGate(), false)
    assert.deepEqual(peerWoken, [], 'a peer does not deliver the episode')
    assert.ok(!existsSync(`${r.stateDir}/episodes/1/claims`), 'no claim gen: the beat kept the owner')
  } finally {
    release()
    await telling
  }
})

test('finding F3: dead holder pid with a live session delivers finished E1 once', async () => {
  const w = world()
  const r = await assigned(w)
  const gate = newGate()
  assert.equal(await heartbeat(w.host, gate), true)
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  const me = await processId(w.host)
  assert.ok(me.host && me.pid > 0, JSON.stringify(me))
  const holder = { token: 'dead-token', session: 'me', activation: '1', host: me.host, pid: 2147483646, pidStart: 'Thu Jan  1 00:00:00 1970' }
  symlinkSync(JSON.stringify(holder), `${r.stateDir}/.action`)
  await w.host.write(`${r.stateDir}/episodes/1/waiter`, JSON.stringify({ binding: true, token: 'dead-token' }))
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 1, 'finished E1 is delivered')
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 1, 'delivered exactly once')
})

test('finding F3: unprovable holder delivers nothing and the row is not shown as delivered', async () => {
  const w = world()
  const r = await assigned(w)
  const gate = newGate()
  assert.equal(await heartbeat(w.host, gate), true)
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1 }))
  const holder = { token: 'dead-token', session: 'me', activation: '1', host: 'not-this-host', pid: 2147483646, pidStart: 'Thu Jan  1 00:00:00 1970' }
  symlinkSync(JSON.stringify(holder), `${r.stateDir}/.action`)
  await w.host.write(`${r.stateDir}/episodes/1/waiter`, JSON.stringify({ binding: true, token: 'dead-token' }))
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 0)
  const line = await panel({ host: w.host, session: 'me', width: 200 })
  assert.doesNotMatch(line, /delivered/, line)
  const s = await scan(w.host, { claim: false })
  assert.equal(s.reported.has(`${r.name}#0`), false, `reported ${[...s.reported].join(',')}`)
  const rows = await panelRows(w.host, newGate(), w.root)
  assert.ok(rows.every(row => row.state !== 'delivered'), rows.map(row => row.state).join(','))
})

test('finding F4: stop inside the status probe submits no stall notice', async () => {
  const w = world()
  const r = await assigned(w)
  const d = (await scan(w.host, { claim: false })).visible[0]!
  const gate = newGate()
  let cancelBeforeSubmit = false
  const host: Host = {
    ...w.host,
    run: async (argv, cwd, ms) => {
      if (argv[0] === 'agent-tmux' && argv.includes('status')) {
        await stopWorker(w.host, gate, d)
        cancelBeforeSubmit = existsSync(`${r.stateDir}/episodes/1/acks/cancel`)
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            exists: true,
            running: true,
            idle_seconds: 1200,
            blocked_reason: 'model_error',
            blocked_evidence: 'API error column 0',
          }),
          stderr: '',
        }
      }
      return w.host.run(argv, cwd, ms)
    },
  }
  await flagStalls(host, gate, w.v3, [d], [d], true)
  assert.equal(cancelBeforeSubmit, true)
  assert.equal(w.woken.length, 0, w.woken.join('\n'))
})

test('finding F5: exists error is an incomplete scan, not an empty ledger', async () => {
  const w = world()
  await assigned(w)
  const denied = Object.assign(new Error('EACCES ledger exists denied'), { code: 'EACCES' })
  const host: Host = {
    ...w.host,
    exists: async path => {
      if (path === w.v3) throw denied
      return w.host.exists(path)
    },
  }
  const s = await scan(host, { claim: false })
  assert.equal(s.complete, false, 'exists error must not look like an empty ledger')
  assert.equal(s.error, 'EACCES')
})

test('finding M1: readDescriptor returning unknown makes panel print incomplete and omits name#0 from reported', async () => {
  const w = world()
  const r = await assigned(w)
  const denied = Object.assign(new Error('EACCES dispatch.json denied'), { code: 'EACCES' })
  const host: Host = {
    ...w.host,
    read: async (path: string) => {
      if (path.endsWith('/dispatch.json')) throw denied
      return w.host.read(path)
    },
  }
  const s = await scan(host, { claim: false })
  assert.equal(s.complete, false, 'scan must be marked incomplete')
  assert.equal(s.reported.has(`${r.name}#0`), false, 'name#0 must not be in reported')
  assert.ok(s.withheld.has(r.name), 'worker name must be withheld')
  const line = await panel({ host, session: 'me', width: 200 })
  assert.doesNotMatch(line, /delivered/, line)
  assert.match(line, /^tmux-agent: ledger incomplete/, line)
})

test('finding M2: ackNames list error prevents submitting stall notice', async () => {
  const w = world()
  const r = await assigned(w)
  mkdirSync(`${r.stateDir}/episodes/1/acks`, { recursive: true })
  const d = (await scan(w.host, { claim: false })).visible[0]!
  const gate = newGate()
  const denied = Object.assign(new Error('EACCES ack dir list denied'), { code: 'EACCES' })
  const host: Host = {
    ...w.host,
    list: async (path: string) => {
      if (path.includes('/acks')) throw denied
      return w.host.list(path)
    },
    run: async (argv, cwd, ms) => {
      if (argv[0] === 'agent-tmux' && argv.includes('status')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            exists: true,
            running: true,
            idle_seconds: 1200,
            blocked_reason: 'model_error',
            blocked_evidence: 'API error column 0',
          }),
          stderr: '',
        }
      }
      return w.host.run(argv, cwd, ms)
    },
  }
  await flagStalls(host, gate, w.v3, [d], [d], true)
  assert.equal(w.woken.length, 0, 'must not submit stall notice when ack read fails')
})

test('finding M6: exists error on aborted mark marks scan incomplete and omits episode from dispatches', async () => {
  const w = world()
  const r = await assigned(w)
  const denied = Object.assign(new Error('EACCES aborted check denied'), { code: 'EACCES' })
  const host: Host = {
    ...w.host,
    exists: async (path: string) => {
      if (path.endsWith('/aborted')) throw denied
      return w.host.exists(path)
    },
  }
  const s = await scan(host, { claim: false })
  assert.equal(s.complete, false, 'scan must be incomplete on aborted check failure')
  assert.equal(s.dispatches.some(d => d.seq === 1), false, 'episode 1 must not be in dispatches')
  assert.equal((s.episodes.get(r.name) ?? []).length, 0, 'no episodes parsed')
})

test('finding N5: read error on launch.exit neither marks a worker exited nor clears exited', async () => {
  const w = world()
  await assigned(w)
  const d = (await scan(w.host, { claim: false })).visible[0]!
  const id = `${d.name}#${d.seq}`
  const denied = Object.assign(new Error('EACCES launch.exit denied'), { code: 'EACCES' })
  const host: Host = {
    ...w.host,
    exists: async (path: string) => (path.endsWith('/launch.exit') ? true : w.host.exists(path)),
    read: async (path: string) => {
      if (path.endsWith('/launch.exit')) throw denied
      return w.host.read(path)
    },
    run: async (argv, cwd, ms) =>
      argv[0] === 'agent-tmux' && argv.includes('status')
        ? { exitCode: 0, stdout: JSON.stringify({ exists: false, running: false }), stderr: '' }
        : w.host.run(argv, cwd, ms),
  }
  for (const before of [false, true]) {
    const gate = newGate()
    if (before) gate.exited.add(id)
    await flagStalls(host, gate, w.v3, [d], [d], true)
    assert.equal(gate.exited.has(id), before, `exited must stay ${before} when launch.exit is unreadable`)
  }
  assert.equal(w.woken.length, 0, 'an unreadable receipt submits nothing')
  assert.ok(w.logs.some(l => l.includes('could not read launch.exit')), 'must log read failure')
})

test('sol-review F3: panelRows shows an unreadable launch receipt as unknown, never running or exited', async () => {
  const w = world()
  await assigned(w)
  const denied = Object.assign(new Error('EACCES launch.exit denied'), { code: 'EACCES' })
  const host: Host = {
    ...w.host,
    exists: async (path: string) => (path.endsWith('/launch.exit') ? true : w.host.exists(path)),
    read: async (path: string) => {
      if (path.endsWith('/launch.exit')) throw denied
      return w.host.read(path)
    },
  }
  const d = (await scan(w.host, { claim: false })).visible[0]!
  for (const exited of [false, true]) {
    const gate = newGate()
    if (exited) gate.exited.add(`${d.name}#${d.seq}`)
    const rows = await panelRows(host, gate, w.root)
    assert.deepEqual(rows.map(r => r.state), ['unknown'], `exited=${exited}`)
    assert.match(rowMark(rows[0]!), /unknown/)
  }
  assert.ok(w.logs.some(l => l.includes('could not read launch.exit')), 'must log read failure')
})

test('sol-review F2: tell stops when an earlier episode cannot be read — no episode, no send, lock released', async () => {
  const w = world()
  const r = await assigned(w)
  const d = (await scan(w.host, { claim: false })).visible[0]!
  const denied = Object.assign(new Error('EACCES sent denied'), { code: 'EACCES' })
  const host: Host = {
    ...w.host,
    exists: async (path: string) => {
      if (path.endsWith('/episodes/1/sent')) throw denied
      return w.host.exists(path)
    },
  }
  const sends = () => w.calls.filter(c => c.argv[0] === 'agent-tmux' && c.argv.includes('send'))
  const out = await tellWorker(host, d, 'more')
  assert.equal(out.ok, false, out.text)
  assert.match(out.text, /nothing was sent/)
  assert.equal(sends().length, 0, 'nothing is sent on top of an unsettled episode')
  assert.ok(!existsSync(`${r.stateDir}/episodes/2`), 'no new episode')
  assert.ok(!existsSync(`${r.stateDir}/.action`), 'the lock is released')
  assert.ok(w.logs.some(l => l.includes('could not check') && l.includes('/episodes/1/sent')), 'recovery logs the read error')
})

test('finding R2: launchFailure uses readOrAbsent, UNKNOWN does not count as no receipt nor exit 0', async () => {
  const w = world()
  await assigned(w)
  const d = (await scan(w.host, { claim: false })).visible[0]!
  const dir = `${w.v3}/${d.name}`
  const denied = Object.assign(new Error('EACCES launch.exit denied'), { code: 'EACCES' })
  const host: Host = {
    ...w.host,
    exists: async (path: string) => {
      if (path.endsWith('/launch.exit')) return true
      return w.host.exists(path)
    },
    read: async (path: string) => {
      if (path.endsWith('/launch.exit')) throw denied
      return w.host.read(path)
    },
  }

  // 1. launchFailure directly returns UNKNOWN and logs
  const res = await launchFailure(host, dir, d.since)
  assert.equal(res, UNKNOWN, 'launchFailure must return UNKNOWN on read failure')
  assert.ok(w.logs.some(l => l.includes('could not read launch.exit')), 'must log read failure')

  // 2. collect with UNKNOWN launchFailure: session marked exited, but launch receipt is UNKNOWN.
  // Must NOT treat as "no receipt" / exit 0 and deliver EXITED or LAUNCH_FAILED.
  const id = `${d.name}#${d.seq}`
  const exited = new Set([id])
  const result = await collect(host, w.v3, [d], exited)
  assert.equal(result.finished.length, 0, 'must not deliver finished (neither EXITED nor LAUNCH_FAILED) when launch.exit is UNKNOWN')
})

test('gap B5: a launch-failed notice is provisional: a real result of the same episode is delivered once', async () => {
  const w = world()
  const r = await assigned(w)
  const gate = newGate()

  // 1. Simulate failed launch receipt
  writeFileSync(`${r.stateDir}/launch.exit`, '1\n')
  writeFileSync(`${r.stateDir}/mod-assign.log`, 'fake launch failure: dialog was not answered\n')

  // First reconcile pass: delivers launch-failed notice
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 1, 'first pass delivers launch failure')
  assert.match(w.woken[0]!, /launch-failed/)

  // 2. Real terminal result.json is written for the same episode
  writeFileSync(`${r.stateDir}/result.json`, result({ episode: 1, summary: 'real result arrived' }))

  // Second reconcile pass: real result outranks provisional launch notice and is delivered
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 2, 'second pass delivers real result')
  assert.match(w.woken[1]!, /on astra: success/)
  assert.match(w.woken[1]!, /real result arrived/)

  // Third reconcile pass: already closed, never delivered twice
  await reconcile(w.host, gate, false)
  assert.equal(w.woken.length, 2, 'never delivered twice')
})

test('gap B6: a result.json written for an episode after stop cancelled it is not delivered, and no ack is written; live episode is delivered', async () => {
  const w = world()
  const r1 = await assigned(w, 'stopped')
  const r2 = await assigned(w, 'live')
  writeFileSync(`${r2.stateDir}/result.json`, result({ episode: 1, summary: 'live ok' }))

  let stopped = false
  const host: Host = {
    ...w.host,
    read: async path => {
      if (!stopped && path.includes('stopped') && path.endsWith('result.json')) {
        stopped = true
        const d1 = (await scan(w.host, { claim: false })).visible.find(d => d.name === r1.name)!
        await stopWorker(w.host, newGate(), d1)
        writeFileSync(path, result({ episode: 1, summary: 'result after stop' }))
      }
      return w.host.read(path)
    },
  }

  await reconcile(host, newGate(), false)
  assert.ok(stopped, 'stopWorker was invoked during reconcile pass')
  assert.equal(w.woken.length, 1, 'only live episode is delivered')
  assert.match(w.woken[0]!, new RegExp(r2.name), 'live episode delivered')
  assert.doesNotMatch(w.woken[0]!, new RegExp(r1.name), 'stopped episode not delivered')
  assert.ok(!existsSync(`${r1.stateDir}/episodes/1/acks/done`), 'no done ack written for cancelled episode')
  assert.ok(existsSync(`${r1.stateDir}/episodes/1/acks/cancel`), 'cancel ack preserved')
  assert.ok(existsSync(`${r2.stateDir}/episodes/1/acks/done`), 'live episode acked done')

  await reconcile(w.host, newGate(), false)
  assert.equal(w.woken.length, 1, 'subsequent pass delivers nothing more')
})


// ── Sol r6 review (sol-review-r6.json items 1, 3, 4) ──

const DEAD_START = 'Thu Jan  1 00:00:00 1970'

test('Sol#1 worker unlock: A and B unlock one dead holder, C takes the lock at A\'s rm cut point — C\'s lock survives', async () => {
  const w = world()
  const r = await assigned(w)
  const lock = `${r.stateDir}/.action`
  const me = await processId(w.host)
  symlinkSync(JSON.stringify({ token: 'old', activation: '', session: 'gone', host: me.host, pid: 999_999, pidStart: DEAD_START }), lock)
  let armed = true
  let b: { ok: boolean; text: string } | undefined
  let c = false
  const a: Host = {
    ...w.host,
    run: async (argv, cwd, ms) => {
      if (armed && argv[0] === 'rm' && argv[1] === lock) {
        armed = false
        b = await unlockWorker(w.host, r.name, 'confirm')
        c = (await takeLock(w.host, r.stateDir, 'new')).ok
      }
      return w.host.run(argv, cwd, ms)
    },
  }
  const outA = await unlockWorker(a, r.name, 'confirm')
  assert.equal(armed, false, 'the cut point was reached')
  assert.ok(outA.ok, outA.text)
  assert.equal(b?.ok, false, `B unlocked while A's unlock ran: ${b?.text}`)
  assert.match(b!.text, /\.action\.unlock/)
  if (!c) c = (await takeLock(w.host, r.stateDir, 'new')).ok
  assert.ok(c, 'C takes the lock once A removed the dead holder')
  const late = await unlockWorker(w.host, r.name, 'confirm')
  assert.equal(late.ok, false, late.text)
  assert.equal(JSON.parse(readlinkSync(lock)).token, 'new', 'C\'s lock survives both unlocks')
})

test('Sol#3 worker unlock: a readlink error (EACCES) is busy with the errno, never "not locked"', async () => {
  const w = world()
  const r = await assigned(w)
  const lock = `${r.stateDir}/.action`
  const me = await processId(w.host)
  symlinkSync(JSON.stringify({ token: 'old', activation: '', session: 'gone', host: me.host, pid: 999_999, pidStart: DEAD_START }), lock)
  const denied: Host = {
    ...w.host,
    run: async (argv, cwd, ms) =>
      argv[0] === 'readlink' && argv[1] === lock ? { exitCode: 1, stdout: '', stderr: '' } : w.host.run(argv, cwd, ms), // BSD readlink is silent
    list: async path => {
      if (path === r.stateDir) throw Object.assign(new Error(`EACCES: permission denied, scandir '${path}'`), { code: 'EACCES' })
      return w.host.list(path)
    },
  }
  for (const word of [undefined, 'confirm']) {
    const out = await unlockWorker(denied, r.name, word)
    assert.equal(out.ok, false, out.text)
    assert.doesNotMatch(out.text, /not locked/)
    assert.match(out.text, /EACCES/)
  }
  assert.equal(JSON.parse(readlinkSync(lock)).token, 'old')
})

test('Sol#4 heartbeat: a beat that cannot be written is not a successful beat', async () => {
  const w = world()
  const failing: Host = {
    ...w.host,
    write: async (path, text) => {
      if (path.endsWith('.beat')) throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' })
      return w.host.write(path, text)
    },
  }
  const gate = newGate()
  assert.equal(await heartbeat(failing, gate), false, 'registered, but the first beat failed')
  assert.ok(w.logs.some(l => /could not beat: .*EACCES/.test(l)), w.logs.join('\n'))
  assert.equal(await heartbeat(failing, gate), false, 'a later failed beat is not success either')
  assert.equal(await heartbeat(w.host, gate), true, 'a beat that lands is')
})
