// Contract tests for the shared core, run by plain node (node --test), no engine.
// Every host (mod, collector, TUI, MCP) reaches the world only through `Host`,
// so an in-memory Host is enough to pin the core's behaviour.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignWorker, heartbeatOf, newGate, panelRows, scan, type Host } from './workers.ts'

const ROOT = '/state/tmux-agent-tools'
const REPO = '/repo'
const BRIEF = 'GOAL: probe\nACCEPTANCE: it runs\nREPORT: one line\n'

type Run = { argv: readonly string[]; cwd: string }

function fakeHost(opts: { owner?: string; files?: Record<string, string> } = {}) {
  const files = new Map(Object.entries(opts.files ?? {}))
  const writes: string[] = []
  const runs: Run[] = []
  const store = new Map<string, unknown>()
  const dirs = () => {
    const out = new Set<string>()
    for (const p of files.keys()) {
      let d = p.slice(0, p.lastIndexOf('/'))
      while (d) {
        out.add(d)
        d = d.slice(0, d.lastIndexOf('/'))
      }
    }
    return out
  }
  const host: Host = {
    now: async () => 1_000_000,
    owner: () => opts.owner,
    cwd: () => REPO,
    envTmuxAgentDir: async () => ROOT,
    envXdgStateHome: async () => undefined,
    envHome: async () => '/home/u',
    envPath: async () => undefined,
    read: async p => {
      const v = files.get(p)
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
    write: async (p, text) => {
      writes.push(p)
      files.set(p, text)
    },
    stat: async p => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`)
      return { mtimeMs: 1_000_000 }
    },
    exists: async p => files.has(p) || dirs().has(p),
    list: async p => {
      const names = new Map<string, string>()
      for (const f of files.keys()) {
        if (!f.startsWith(`${p}/`)) continue
        const rest = f.slice(p.length + 1)
        const i = rest.indexOf('/')
        names.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? 'file' : 'dir')
      }
      return [...names].map(([name, kind]) => ({ name, kind }))
    },
    storeGet: async k => store.get(k),
    storeSet: async (k, v) => {
      writes.push(`store:${k}`)
      store.set(k, v)
    },
    storeKeys: async () => [...store.keys()],
    storeDelete: async k => {
      writes.push(`store-delete:${k}`)
      store.delete(k)
    },
    submit: async () => undefined,
    toast: () => {},
    log: () => {},
    run: async (argv, cwd) => {
      runs.push({ argv, cwd })
      if (argv[0] === 'git') return { exitCode: 0, stdout: 'a'.repeat(40) + '\n', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    agentList: async () => [],
  }
  return { host, files, writes, runs }
}

/** An unsettled worker of this repo whose owner stopped heartbeating: an orphan. */
const orphanFiles = () => ({
  [`${ROOT}/w1-abcd/dispatch.json`]: JSON.stringify({
    profile: 'astra',
    name: 'w1-abcd',
    dir: REPO,
    since: 1,
    owner: 'dead-session',
    ownerCwd: REPO,
  }),
})

test('assignWorker writes the brief and the dispatch record, and launches through Host.run', async () => {
  const { host, files, runs } = fakeHost({ owner: 'me' })
  const r = await assignWorker(host, { profile: 'astra', name: 'w', dir: REPO, brief: BRIEF }, { owner: 'me', ownerCwd: REPO })
  if ('deny' in r) assert.fail(r.deny)
  assert.equal(files.get(`${r.stateDir}/brief.md`), BRIEF)
  const d = JSON.parse(files.get(`${r.stateDir}/dispatch.json`)!)
  assert.equal(d.owner, 'me')
  assert.equal(d.goal, 'probe')
  assert.deepEqual(runs.map(x => x.argv[0]), ['git', 'sh'])
  assert.match(runs[1]!.argv[2]!, /agent-tmux.*assign.*--detach/)
})

test('assignWorker refuses a bad name before any write or launch', async () => {
  const { host, writes, runs } = fakeHost({ owner: 'me' })
  const r = await assignWorker(host, { profile: 'astra', name: 'bad name', dir: REPO, brief: BRIEF })
  assert.ok('deny' in r)
  assert.deepEqual(writes, [])
  assert.deepEqual(runs, [])
})

test('panelRows is read-only: an orphan is listed, never claimed', async () => {
  const { host, files, writes } = fakeHost({ owner: 'me', files: orphanFiles() })
  const before = files.get(`${ROOT}/w1-abcd/dispatch.json`)
  const rows = await panelRows(host, newGate(), ROOT)
  assert.equal(rows.length, 1)
  assert.deepEqual(writes, [])
  assert.equal(files.get(`${ROOT}/w1-abcd/dispatch.json`), before)
})

test('only a collector scan claims the orphan', async () => {
  const { host, files } = fakeHost({ owner: 'me', files: orphanFiles() })
  await scan(host, { claim: false })
  assert.equal(JSON.parse(files.get(`${ROOT}/w1-abcd/dispatch.json`)!).owner, 'dead-session')
  await scan(host, { claim: true })
  const d = JSON.parse(files.get(`${ROOT}/w1-abcd/dispatch.json`)!)
  assert.equal(d.owner, 'me')
  assert.equal(d.adoptedFrom, 'dead-session')
})

test('an orphan whose owner still heartbeats is not claimed', async () => {
  const { host, files } = fakeHost({
    owner: 'me',
    files: { ...orphanFiles(), [heartbeatOf(ROOT, 'dead-session')]: '' },
  })
  await scan(host, { claim: true })
  assert.equal(JSON.parse(files.get(`${ROOT}/w1-abcd/dispatch.json`)!).owner, 'dead-session')
})
