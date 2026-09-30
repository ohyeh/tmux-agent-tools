// Contract tests for snapshot.node.ts (p0-contract.md §6, workers-core plan P4).
//
// Verifies:
// 1. Panel line formatting, ordering, elapsed time, status marks, truncation, and empty state.
// 2. Dashboard JSON schema and fixture compliance: all required keys, types, and totals.
// 3. Observing mutates nothing: taking a full snapshot of the state root (path + mtime + content hash)
//    before and after panel/dashboard over an orphan whose owner is dead proves identical state,
//    and no claims/ directory appears.
// 4. Verification that scan with { claim: true } would mutate and fail this check.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeHost } from './host.node.ts'
import {
  dashboard,
  fitPanelLine,
  formatElapsed,
  panel,
  type DashboardSession,
  type DashboardSnapshot,
} from './snapshot.node.ts'
import { scan, v3Of } from './workers.ts'

type DirSnapshotEntry = {
  type: 'file' | 'dir'
  mtimeMs: number
  hash: string
}

type DirSnapshot = Map<string, DirSnapshotEntry>

function captureDir(root: string, rel = ''): DirSnapshot {
  const map: DirSnapshot = new Map()
  const dir = rel ? `${root}/${rel}` : root
  if (!existsSync(dir)) return map
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name
    const full = `${dir}/${entry.name}`
    const st = statSync(full)
    if (entry.isDirectory()) {
      map.set(entryRel, { type: 'dir', mtimeMs: st.mtimeMs, hash: '' })
      const sub = captureDir(root, entryRel)
      for (const [k, v] of sub) map.set(k, v)
    } else {
      const content = readFileSync(full)
      const hash = createHash('sha256').update(content).digest('hex')
      map.set(entryRel, { type: 'file', mtimeMs: st.mtimeMs, hash })
    }
  }
  return map
}

test('formatElapsed: units and bounds (45s, 12m, 3h, negative is 0s)', () => {
  const now = 1000000000000
  assert.equal(formatElapsed(now + 5000, now), '0s')
  assert.equal(formatElapsed(now, now), '0s')
  assert.equal(formatElapsed(now - 45000, now), '45s')
  assert.equal(formatElapsed(now - 59000, now), '59s')
  assert.equal(formatElapsed(now - 60000, now), '1m')
  assert.equal(formatElapsed(now - 12 * 60 * 1000 - 30000, now), '12m')
  assert.equal(formatElapsed(now - 3599000, now), '59m')
  assert.equal(formatElapsed(now - 3600000, now), '1h')
  assert.equal(formatElapsed(now - 3 * 3600 * 1000 - 120000, now), '3h')
  assert.equal(formatElapsed(now - 10 * 3600 * 1000, now), '10h')
})

test('fitPanelLine: drops whole entries from the end and handles edge widths', () => {
  const entries = ['aaaa zz 9h ▶', 'bbbb zz 9h ▶', 'cccc zz 9h ▶', 'dddd zz 9h ▶']
  // Empty
  assert.equal(fitPanelLine([], 120), 'tmux-agent: no workers')

  // Full fits
  const all = entries.join(' ')
  assert.equal(fitPanelLine(entries, all.length), all)
  assert.equal(fitPanelLine(entries, 400), all)

  // Two plus suffix
  const twoMore = 'aaaa zz 9h ▶ bbbb zz 9h ▶ +2 more'
  assert.equal(fitPanelLine(entries, twoMore.length), twoMore)

  // No room for suffix drops another whole entry
  const oneMore = 'aaaa zz 9h ▶ +3 more'
  assert.equal(fitPanelLine(entries, twoMore.length - 1), oneMore)

  // Narrower than one entry prints +N more
  assert.equal(fitPanelLine(entries, 1), '+4 more')
  assert.equal(fitPanelLine(entries, 0), '+4 more')
})

test('panel fixture: full panel ordering, status marks, 3-delivered cap, and foreign exclusions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'panel-fixture-'))
  const v3 = v3Of(root)
  mkdirSync(v3, { recursive: true })
  const MSESSION = 'msession-test'
  const now = 1700000000000

  // Helper to set up a worker in .v3
  const setupWorker = (opts: {
    name: string
    profile: string
    since: number
    owner: string
    delivered?: boolean
    resultStatus?: string
  }) => {
    const wdir = `${v3}/${opts.name}`
    mkdirSync(`${wdir}/episodes/1`, { recursive: true })
    writeFileSync(
      `${wdir}/worker.json`,
      JSON.stringify({
        profile: opts.profile,
        name: opts.name,
        dir: '/tmp/repo',
        since: opts.since,
        owner: opts.owner,
        ownerCwd: '/tmp/repo',
        origin: 'assign',
      }),
    )
    const resultPath = `${wdir}/episodes/1/result.json`
    writeFileSync(
      `${wdir}/episodes/1/dispatch.json`,
      JSON.stringify({
        seq: 1,
        since: opts.since,
        owner: opts.owner,
        goal: 'test',
        resultPath,
        origin: 'launch',
      }),
    )
    writeFileSync(`${wdir}/episodes/1/sent`, '')
    if (opts.delivered) {
      mkdirSync(`${wdir}/episodes/1/acks/done`, { recursive: true })
    }
    if (opts.resultStatus) {
      writeFileSync(
        resultPath,
        JSON.stringify({
          schema_version: 1,
          status: opts.resultStatus,
          summary: 'test summary',
          episode: 1,
          artifacts: [],
          errors: [],
        }),
      )
    }
  }

  // Active workers
  setupWorker({ name: 'secw', profile: 'codex', since: now - 45000, owner: MSESSION })
  setupWorker({ name: 'run1', profile: 'codex', since: now - (12 * 60 + 30) * 1000, owner: MSESSION })
  setupWorker({ name: 'ok1', profile: 'codex', since: now - (3 * 3600 + 120) * 1000, owner: MSESSION, resultStatus: 'success' })
  setupWorker({ name: 'bad1', profile: 'agy', since: now - (5 * 3600 + 120) * 1000, owner: MSESSION, resultStatus: 'failed' })

  // Delivered workers
  setupWorker({ name: 'newD', profile: 'codex', since: now - (4 * 3600 + 120) * 1000, owner: MSESSION, delivered: true, resultStatus: 'success' })
  setupWorker({ name: 'midB', profile: 'codex', since: now - (6 * 3600 + 120) * 1000, owner: MSESSION, delivered: true, resultStatus: 'success' })
  setupWorker({ name: 'midA', profile: 'codex', since: now - (8 * 3600 + 120) * 1000, owner: MSESSION, delivered: true, resultStatus: 'success' })
  setupWorker({ name: 'oldD', profile: 'codex', since: now - (10 * 3600 + 120) * 1000, owner: MSESSION, delivered: true, resultStatus: 'success' })

  // Foreign session workers (must be excluded)
  setupWorker({ name: 'foreignAct', profile: 'agy', since: now - 1000, owner: 'other-session' })
  setupWorker({ name: 'foreignDel', profile: 'agy', since: now - 2000, owner: 'other-session', delivered: true })

  const host = nodeHost({ owner: MSESSION, cwd: '/tmp/repo' })
  process.env.TMUX_AGENT_DIR = root

  try {
    const line = await panel({ host, session: MSESSION, width: 400, now })

    // Verify marks
    assert.ok(line.includes('secw codex 45s ▶'))
    assert.ok(line.includes('run1 codex 12m ▶'))
    assert.ok(line.includes('ok1 codex 3h ✓ success'))
    assert.ok(line.includes('bad1 agy 5h ✗ failed'))
    assert.ok(line.includes('newD codex 4h ✓ delivered'))
    assert.ok(line.includes('midB codex 6h ✓ delivered'))
    assert.ok(line.includes('midA codex 8h ✓ delivered'))

    // 4th delivered is capped/excluded
    assert.ok(!line.includes('oldD'))

    // Foreign workers excluded
    assert.ok(!line.includes('foreignAct'))
    assert.ok(!line.includes('foreignDel'))

    // Active newest-first, then delivered newest-first
    const order = ['secw ', 'run1 ', 'ok1 ', 'bad1 ', 'newD ', 'midB ', 'midA ']
    let prevIndex = -1
    for (const token of order) {
      const idx = line.indexOf(token)
      assert.ok(idx > prevIndex, `token ${token} out of order in line: ${line}`)
      prevIndex = idx
    }

    // Exactly 3 delivered entries shown
    const deliveredCount = (line.match(/✓ delivered/g) || []).length
    assert.equal(deliveredCount, 3)

    // Truncation check with narrow width
    const shortLine = await panel({ host, session: MSESSION, width: 60, now })
    assert.ok(shortLine.includes('more'))
  } finally {
    delete process.env.TMUX_AGENT_DIR
    rmSync(root, { recursive: true, force: true })
  }
})

test('dashboard fixture and schema: keys, totals, and values match contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dash-fixture-'))
  const v3 = v3Of(root)
  mkdirSync(v3, { recursive: true })
  const now = 1700000000000

  // Empty snapshot check
  const hostEmpty = nodeHost({ cwd: '/tmp/repo' })
  process.env.TMUX_AGENT_DIR = root
  try {
    const emptySnap = await dashboard({ host: hostEmpty, now, sessions: [] })
    assert.equal(emptySnap.schema_version, 1)
    assert.equal(typeof emptySnap.at, 'string')
    assert.deepEqual(emptySnap.totals, { running: 0, exited: 0, stopped: 0, total: 0 })
    assert.deepEqual(emptySnap.sessions, [])

    // Add running, exited, and stopped workers
    const setup = (name: string, profile: string, since: number, status?: string) => {
      const wdir = `${v3}/${name}`
      mkdirSync(`${wdir}/episodes/1`, { recursive: true })
      writeFileSync(
        `${wdir}/worker.json`,
        JSON.stringify({
          profile,
          name,
          dir: '/tmp/repo',
          since,
          owner: 'owner-1',
          ownerCwd: '/tmp/repo',
          origin: 'assign',
        }),
      )
      const resultPath = `${wdir}/episodes/1/result.json`
      writeFileSync(
        `${wdir}/episodes/1/dispatch.json`,
        JSON.stringify({
          seq: 1,
          since,
          owner: 'owner-1',
          goal: 'goal',
          resultPath,
          origin: 'launch',
        }),
      )
      writeFileSync(`${wdir}/episodes/1/sent`, '')
      if (status) {
        writeFileSync(
          resultPath,
          JSON.stringify({
            schema_version: 1,
            status,
            summary: 'summary',
            episode: 1,
            artifacts: [],
            errors: [],
          }),
        )
      }
    }

    setup('w-run', 'codex', now - 10000)
    setup('w-bad', 'agy', now - 20000, 'failed')
    setup('w-ok', 'claude', now - 30000, 'success')

    const snap = await dashboard({ host: hostEmpty, now, sessions: [] })
    assert.equal(snap.schema_version, 1)
    assert.equal(snap.totals.total, 3)
    assert.equal(snap.sessions.length, 3)

    // Check all 30 keys on each session object
    const requiredKeys = [
      'schema_version',
      'tool',
      'name',
      'session',
      'prefix',
      'exists',
      'running',
      'exit_detected',
      'exit_code',
      'local_or_remote',
      'diagnostic',
      'last_capture_lines',
      'confirmation_detected',
      'blocked_reason',
      'blocked_evidence',
      'started_at',
      'last_change_at',
      'idle_seconds',
      'bytes_in_pane',
      'marker_seen',
      'state',
      'wrapper',
      'agent_name',
      'tmux_session',
      'cwd',
      'result_path',
      'created_at',
      'created_epoch',
      'age_seconds',
      'age',
    ]

    for (const sess of snap.sessions) {
      assert.equal(sess.schema_version, 1)
      for (const k of requiredKeys) {
        assert.ok(k in sess, `missing key: ${k} in session ${sess.name}`)
      }
      assert.ok(['running', 'exited', 'stopped'].includes(sess.state))
      assert.equal(sess.tool, sess.name === 'w-bad' ? 'agy' : sess.name === 'w-ok' ? 'claude' : 'codex')
      assert.equal(sess.wrapper, `agent-tmux ${sess.tool}`)
    }

    // Totals match sum of session states
    assert.equal(
      snap.totals.running + snap.totals.exited + snap.totals.stopped,
      snap.totals.total,
    )

    // Verify fixture file against required keys and totals
    const fixturePath = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/dashboard.fixture.json')
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as DashboardSnapshot
    assert.equal(fixture.schema_version, 1)
    assert.equal(fixture.totals.total, fixture.sessions.length)
    assert.equal(
      fixture.totals.running + fixture.totals.exited + fixture.totals.stopped,
      fixture.totals.total,
    )
    for (const sess of fixture.sessions) {
      assert.equal(sess.schema_version, 1)
      for (const k of requiredKeys) {
        assert.ok(k in sess, `missing key ${k} in fixture session ${sess.name}`)
      }
    }
  } finally {
    delete process.env.TMUX_AGENT_DIR
    rmSync(root, { recursive: true, force: true })
  }
})

test('fleet sessions: live session with no ledger record and session from another cwd are both in sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-fixture-'))
  const v3 = v3Of(root)
  mkdirSync(v3, { recursive: true })
  const now = 1700000000000

  // 1. Ledger worker recorded in this repo's .v3
  const wdir = `${v3}/repo-worker`
  mkdirSync(`${wdir}/episodes/1`, { recursive: true })
  writeFileSync(
    `${wdir}/worker.json`,
    JSON.stringify({
      profile: 'codex',
      name: 'repo-worker',
      dir: '/tmp/repo-a',
      since: now - 5000,
      owner: 'owner-1',
      ownerCwd: '/tmp/repo-a',
      origin: 'assign',
    }),
  )
  writeFileSync(
    `${wdir}/episodes/1/dispatch.json`,
    JSON.stringify({
      seq: 1,
      since: now - 5000,
      owner: 'owner-1',
      goal: 'goal',
      resultPath: `${wdir}/episodes/1/result.json`,
      origin: 'launch',
    }),
  )
  writeFileSync(`${wdir}/episodes/1/sent`, '')

  // 2. Three fleet sessions:
  // a) live session with NO ledger record (plain start in same cwd)
  const plainSession: DashboardSession = {
    schema_version: 1,
    tool: 'claude',
    name: 'plain-live',
    session: 'claude-cli-plain-live',
    prefix: 'claude-cli',
    exists: true,
    running: true,
    exit_detected: false,
    exit_code: null,
    local_or_remote: 'local',
    diagnostic: null,
    last_capture_lines: [],
    confirmation_detected: false,
    blocked_reason: null,
    blocked_evidence: null,
    started_at: '2026-09-29T12:00:00Z',
    last_change_at: null,
    idle_seconds: 10,
    bytes_in_pane: 100,
    marker_seen: [],
    state: 'running',
    wrapper: 'agent-tmux claude',
    agent_name: 'plain-live',
    tmux_session: 'claude-cli-plain-live',
    cwd: '/tmp/repo-a',
    result_path: '/tmp/repo-a/result.json',
    created_at: '2026-09-29T12:00:00Z',
    created_epoch: 1790683200,
    age_seconds: 10,
    age: '10s',
  }

  // b) live session from ANOTHER cwd (e.g. another project)
  const otherCwdSession: DashboardSession = {
    schema_version: 1,
    tool: 'agy',
    name: 'other-cwd-live',
    session: 'agy-cli-other-cwd-live',
    prefix: 'agy-cli',
    exists: true,
    running: true,
    exit_detected: false,
    exit_code: null,
    local_or_remote: 'local',
    diagnostic: null,
    last_capture_lines: [],
    confirmation_detected: false,
    blocked_reason: null,
    blocked_evidence: null,
    started_at: '2026-09-29T11:00:00Z',
    last_change_at: null,
    idle_seconds: 20,
    bytes_in_pane: 200,
    marker_seen: [],
    state: 'running',
    wrapper: 'agent-tmux agy',
    agent_name: 'other-cwd-live',
    tmux_session: 'agy-cli-other-cwd-live',
    cwd: '/tmp/repo-other',
    result_path: '/tmp/repo-other/result.json',
    created_at: '2026-09-29T11:00:00Z',
    created_epoch: 1790679600,
    age_seconds: 3600,
    age: '3600s',
  }

  // c) live session matching the ledger record in this repo
  const matchingSession: DashboardSession = {
    schema_version: 1,
    tool: 'codex',
    name: 'repo-worker',
    session: 'codex-cli-repo-worker',
    prefix: 'codex-cli',
    exists: true,
    running: true,
    exit_detected: false,
    exit_code: null,
    local_or_remote: 'local',
    diagnostic: null,
    last_capture_lines: [],
    confirmation_detected: false,
    blocked_reason: null,
    blocked_evidence: null,
    started_at: '2026-09-29T12:00:00Z',
    last_change_at: null,
    idle_seconds: 5,
    bytes_in_pane: 50,
    marker_seen: [],
    state: 'running',
    wrapper: 'agent-tmux codex',
    agent_name: 'repo-worker',
    tmux_session: 'codex-cli-repo-worker',
    cwd: '/tmp/repo-a',
    result_path: `${wdir}/episodes/1/result.json`,
    created_at: '2026-09-29T12:00:00Z',
    created_epoch: 1790683200,
    age_seconds: 5,
    age: '5s',
  }

  const host = nodeHost({ cwd: '/tmp/repo-a' })
  process.env.TMUX_AGENT_DIR = root

  try {
    const snap = await dashboard({
      host,
      now,
      sessions: [plainSession, otherCwdSession, matchingSession],
    })

    // Both plain session and other-cwd session MUST be in sessions!
    assert.equal(snap.sessions.length, 3)
    const plain = snap.sessions.find(s => s.name === 'plain-live')
    assert.ok(plain, 'live session with no ledger record must be in sessions')
    assert.equal(plain.worker, undefined)

    const other = snap.sessions.find(s => s.name === 'other-cwd-live')
    assert.ok(other, 'session from another cwd must be in sessions')
    assert.equal(other.cwd, '/tmp/repo-other')
    assert.equal(other.worker, undefined)

    const matching = snap.sessions.find(s => s.name === 'repo-worker')
    assert.ok(matching, 'matching ledger session must be in sessions')
    assert.equal(matching.worker?.name, 'repo-worker')
    assert.equal(matching.worker?.seq, 1)

    // Verification check: filtering sessions to ledger workers only drops plain and other-cwd
    const ledgerOnly = snap.sessions.filter(s => s.worker)
    assert.equal(ledgerOnly.length, 1)
    assert.equal(ledgerOnly[0]?.name, 'repo-worker')
  } finally {
    delete process.env.TMUX_AGENT_DIR
    rmSync(root, { recursive: true, force: true })
  }
})

test('dashboard calls host.run with tmux-agent-sessions list --json when sessions not passed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-run-test-'))
  const dummy: DashboardSession = {
    schema_version: 1,
    tool: 'claude',
    name: 'shell-worker',
    session: 'claude-cli-shell-worker',
    prefix: 'claude-cli',
    exists: true,
    running: true,
    exit_detected: false,
    exit_code: null,
    local_or_remote: 'local',
    diagnostic: null,
    last_capture_lines: [],
    confirmation_detected: false,
    blocked_reason: null,
    blocked_evidence: null,
    started_at: '2026-09-29T12:00:00Z',
    last_change_at: null,
    idle_seconds: 10,
    bytes_in_pane: 100,
    marker_seen: [],
    state: 'running',
    wrapper: 'agent-tmux claude',
    agent_name: 'shell-worker',
    tmux_session: 'claude-cli-shell-worker',
    cwd: '/tmp/repo',
    result_path: '/tmp/repo/result.json',
    created_at: '2026-09-29T12:00:00Z',
    created_epoch: 1790683200,
    age_seconds: 10,
    age: '10s',
  }
  const baseHost = nodeHost({ cwd: '/tmp/repo' })
  const host: typeof baseHost = {
    ...baseHost,
    run: async (argv, cwd, ms) => {
      if (argv.some(a => a.includes('tmux-agent-sessions')) && argv.includes('list') && argv.includes('--json')) {
        return { exitCode: 0, stdout: `${JSON.stringify(dummy)}\n`, stderr: '' }
      }
      return baseHost.run(argv, cwd, ms)
    },
  }
  process.env.TMUX_AGENT_DIR = root
  try {
    const snap = await dashboard({ host })
    assert.equal(snap.sessions.length, 1)
    assert.equal(snap.sessions[0]?.name, 'shell-worker')
    assert.equal(snap.totals.running, 1)
  } finally {
    delete process.env.TMUX_AGENT_DIR
    rmSync(root, { recursive: true, force: true })
  }
})

test('no-mutation: panel and dashboard over an orphan with dead owner mutate nothing and create no claims', async () => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-no-mutation-'))
  const v3 = v3Of(root)
  mkdirSync(`${v3}/orphan-worker/episodes/1`, { recursive: true })

  writeFileSync(
    `${v3}/orphan-worker/worker.json`,
    JSON.stringify({
      profile: 'codex',
      name: 'orphan-worker',
      dir: '/tmp/repo',
      since: 1700000000000,
      owner: 'dead-session',
      ownerCwd: '/tmp/repo',
      origin: 'assign',
    }),
  )

  const resultPath = `${v3}/orphan-worker/result.json`
  writeFileSync(
    `${v3}/orphan-worker/episodes/1/dispatch.json`,
    JSON.stringify({
      seq: 1,
      since: 1700000000000,
      owner: 'dead-session',
      goal: 'orphan goal',
      resultPath,
      origin: 'launch',
    }),
  )
  writeFileSync(`${v3}/orphan-worker/episodes/1/sent`, '')

  process.env.TMUX_AGENT_DIR = root
  const host = nodeHost({ owner: 'live-viewer', cwd: '/tmp/repo' })

  try {
    // Capture state root before observing
    const before = captureDir(root)
    assert.ok(before.size > 0)

    // Call panel
    const panelLine = await panel({ host, session: 'live-viewer', width: 120 })
    assert.ok(typeof panelLine === 'string')

    // Call dashboard
    const dashSnap = await dashboard({ host })
    assert.ok(dashSnap.totals.total >= 0)

    // Capture state root after observing
    const after = captureDir(root)

    // Deep equality: every path, type, mtime, and content hash must match
    assert.equal(after.size, before.size)
    for (const [path, entry] of before) {
      const afterEntry = after.get(path)
      assert.ok(afterEntry, `path missing after snapshot: ${path}`)
      assert.equal(afterEntry.type, entry.type, `type changed for ${path}`)
      assert.equal(afterEntry.mtimeMs, entry.mtimeMs, `mtime changed for ${path}`)
      assert.equal(afterEntry.hash, entry.hash, `content hash changed for ${path}`)
    }

    // Explicit check: no claims/ directory was created
    assert.ok(
      !existsSync(`${v3}/orphan-worker/episodes/1/claims`),
      'claims/ directory must never be created by read-only snapshot',
    )
  } finally {
    delete process.env.TMUX_AGENT_DIR
    rmSync(root, { recursive: true, force: true })
  }
})

test('mutation proof: scan with claim:true mutates and creates claims/ for a dead owner orphan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-claim-mutation-'))
  const v3 = v3Of(root)
  mkdirSync(`${v3}/orphan-worker/episodes/1`, { recursive: true })

  writeFileSync(
    `${v3}/orphan-worker/worker.json`,
    JSON.stringify({
      profile: 'codex',
      name: 'orphan-worker',
      dir: '/tmp/repo',
      since: 1700000000000,
      owner: 'dead-session',
      ownerCwd: '/tmp/repo',
      origin: 'assign',
    }),
  )

  const resultPath = `${v3}/orphan-worker/result.json`
  writeFileSync(
    `${v3}/orphan-worker/episodes/1/dispatch.json`,
    JSON.stringify({
      seq: 1,
      since: 1700000000000,
      owner: 'dead-session',
      goal: 'orphan goal',
      resultPath,
      origin: 'launch',
    }),
  )
  writeFileSync(`${v3}/orphan-worker/episodes/1/sent`, '')

  process.env.TMUX_AGENT_DIR = root
  const host = nodeHost({ owner: 'live-collector', cwd: '/tmp/repo' })

  try {
    const before = captureDir(root)
    // Invoking scan with claim: true actively contests and mutates the ledger
    await scan(host, { claim: true })
    const after = captureDir(root)

    // Proves that claim:true mutates the root and creates claims/
    assert.notEqual(after.size, before.size)
    assert.ok(
      existsSync(`${v3}/orphan-worker/episodes/1/claims`),
      'scan with claim: true creates claims directory',
    )
  } finally {
    delete process.env.TMUX_AGENT_DIR
    rmSync(root, { recursive: true, force: true })
  }
})

test('finding R3/R12: no-mutation with live fleet pane compares root before and after', async () => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-nomut-live-'))
  const v3 = v3Of(root)
  const name = 'reviewdash'
  mkdirSync(`${v3}/${name}/episodes/2/sent`, { recursive: true })
  const now = Date.now()
  writeFileSync(
    `${v3}/${name}/worker.json`,
    JSON.stringify({
      profile: 'codex',
      name,
      dir: root,
      ownerCwd: root,
      owner: 'owner',
      since: now,
      origin: 'assign',
    }),
  )
  writeFileSync(
    `${v3}/${name}/episodes/2/dispatch.json`,
    JSON.stringify({
      seq: 2,
      owner: 'owner',
      since: now,
      resultPath: `${v3}/${name}/episodes/2/result.json`,
      origin: 'tell',
    }),
  )
  writeFileSync(
    `${v3}/${name}/episodes/2/result.json`,
    JSON.stringify({ schema_version: 1, episode: 2, status: 'success', summary: 'done', artifacts: [], errors: [] }),
  )

  const socketDir = mkdtempSync(join(tmpdir(), 'dash-sock-'))
  chmodSync(socketDir, 0o700)
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501
  const userDir = join(socketDir, `tmux-${uid}`)
  mkdirSync(userDir, { mode: 0o700, recursive: true })
  chmodSync(userDir, 0o700)
  const socketPath = join(userDir, 'default')
  const execTmux = (args: string[]) => {
    const env = { ...process.env, TMUX_TMPDIR: socketDir }
    delete env.TMUX
    delete env.TMUX_PANE
    return execFileSync('tmux', ['-S', socketPath, ...args], { env, encoding: 'utf8', timeout: 20_000 })
  }

  process.env.TMUX_AGENT_DIR = root
  process.env.TMUX_TMPDIR = socketDir
  const savedTmux = process.env.TMUX
  const savedTmuxPane = process.env.TMUX_PANE
  delete process.env.TMUX
  delete process.env.TMUX_PANE

  try {
    execTmux(['-f', '/dev/null', 'new-session', '-d', '-s', `codex-cli-${name}`, 'cat'])
    const host = nodeHost({ cwd: root })

    const before = captureDir(root)
    assert.ok(before.size > 0)

    const snap = await dashboard({ host })
    assert.ok(snap.sessions.some(s => s.name === name))

    const after = captureDir(root)
    assert.equal(after.size, before.size, 'root must not have added or removed files')
    for (const [path, entry] of before) {
      const afterEntry = after.get(path)
      assert.ok(afterEntry, `path missing after snapshot: ${path}`)
      assert.equal(afterEntry.type, entry.type, `type changed for ${path}`)
      assert.equal(afterEntry.mtimeMs, entry.mtimeMs, `mtime changed for ${path}`)
      assert.equal(afterEntry.hash, entry.hash, `content hash changed for ${path}`)
    }
  } finally {
    try {
      execTmux(['kill-server'])
    } catch {}
    if (savedTmux !== undefined) process.env.TMUX = savedTmux
    if (savedTmuxPane !== undefined) process.env.TMUX_PANE = savedTmuxPane
    delete process.env.TMUX_AGENT_DIR
    delete process.env.TMUX_TMPDIR
    rmSync(root, { recursive: true, force: true })
    rmSync(socketDir, { recursive: true, force: true })
  }
})

test('finding R4: live ledger worker result_path comes from descriptor, overriding fleet default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-r4-'))
  const v3 = v3Of(root)
  const name = 'reviewdash'
  const ep2Dir = `${v3}/${name}/episodes/2`
  mkdirSync(`${ep2Dir}/sent`, { recursive: true })
  const now = Date.now()
  writeFileSync(
    `${v3}/${name}/worker.json`,
    JSON.stringify({
      profile: 'codex',
      name,
      dir: root,
      ownerCwd: root,
      owner: 'owner',
      since: now,
      origin: 'assign',
    }),
  )
  const descriptorResultPath = `${ep2Dir}/result.json`
  writeFileSync(
    `${ep2Dir}/dispatch.json`,
    JSON.stringify({
      seq: 2,
      owner: 'owner',
      since: now,
      resultPath: descriptorResultPath,
      origin: 'tell',
    }),
  )
  writeFileSync(
    descriptorResultPath,
    JSON.stringify({ schema_version: 1, episode: 2, status: 'success', summary: 'done', artifacts: [], errors: [] }),
  )

  process.env.TMUX_AGENT_DIR = root
  const host = nodeHost({ cwd: root })

  const fakeFleetSession: DashboardSession = {
    schema_version: 1,
    tool: 'codex',
    name,
    session: `codex-cli-${name}`,
    prefix: 'codex-cli',
    exists: true,
    running: true,
    exit_detected: false,
    exit_code: null,
    local_or_remote: 'local',
    diagnostic: null,
    last_capture_lines: [],
    confirmation_detected: false,
    blocked_reason: null,
    blocked_evidence: null,
    started_at: new Date(now).toISOString(),
    last_change_at: null,
    idle_seconds: 10,
    bytes_in_pane: 100,
    marker_seen: [],
    state: 'running',
    wrapper: 'agent-tmux codex',
    agent_name: name,
    tmux_session: `codex-cli-${name}`,
    cwd: root,
    result_path: `${root}/${name}/result.json`,
    created_at: new Date(now).toISOString(),
    created_epoch: Math.floor(now / 1000),
    age_seconds: 10,
    age: '10s',
  }

  try {
    const snap = await dashboard({ host, sessions: [fakeFleetSession] })
    const row = snap.sessions.find(s => s.name === name)
    assert.ok(row, 'session row must exist')
    assert.equal(row.result_path, descriptorResultPath, 'live worker result_path must come from descriptor')
  } finally {
    delete process.env.TMUX_AGENT_DIR
    rmSync(root, { recursive: true, force: true })
  }
})

test('finding R5: E1 done does not mark E2 pending as delivered in panel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-r5-'))
  const v3 = v3Of(root)
  const name = 'w.abcde'
  const workerDir = `${v3}/${name}`
  const now = Date.now()

  mkdirSync(`${workerDir}/episodes/1/sent`, { recursive: true })
  mkdirSync(`${workerDir}/episodes/1/acks/done`, { recursive: true })
  mkdirSync(`${workerDir}/episodes/2/sent`, { recursive: true })

  writeFileSync(
    `${workerDir}/worker.json`,
    JSON.stringify({
      profile: 'codex',
      name,
      dir: root,
      ownerCwd: root,
      owner: 'owner',
      since: now - 60000,
      origin: 'assign',
    }),
  )
  writeFileSync(
    `${workerDir}/episodes/1/dispatch.json`,
    JSON.stringify({ seq: 1, since: now - 60000, owner: 'owner', resultPath: `${workerDir}/episodes/1/result.json`, origin: 'launch' }),
  )
  writeFileSync(
    `${workerDir}/episodes/2/dispatch.json`,
    JSON.stringify({ seq: 2, since: now - 30000, owner: 'owner', resultPath: `${workerDir}/episodes/2/result.json`, origin: 'tell' }),
  )

  process.env.TMUX_AGENT_DIR = root
  const host = nodeHost({ owner: 'owner', cwd: root })

  try {
    const line = await panel({ host, session: 'owner' })
    assert.doesNotMatch(line, /delivered/, 'pending E2 must not be reported as delivered when E1 was done')
    assert.match(line, /▶/, 'pending E2 must be marked active')
  } finally {
    delete process.env.TMUX_AGENT_DIR
    rmSync(root, { recursive: true, force: true })
  }
})

test('finding R6: failed fleet probe surfaces error and incomplete, never synthesizes stopped or fresh at', async () => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-r6-'))
  const v3 = v3Of(root)
  const name = 'w.abcde'
  const workerDir = `${v3}/${name}`
  const now = Date.now()

  mkdirSync(`${workerDir}/episodes/1/sent`, { recursive: true })
  writeFileSync(
    `${workerDir}/worker.json`,
    JSON.stringify({
      profile: 'codex',
      name,
      dir: root,
      ownerCwd: root,
      owner: 'owner',
      since: now - 60000,
      origin: 'assign',
    }),
  )
  writeFileSync(
    `${workerDir}/episodes/1/dispatch.json`,
    JSON.stringify({ seq: 1, since: now - 60000, owner: 'owner', resultPath: `${workerDir}/episodes/1/result.json`, origin: 'launch' }),
  )

  process.env.TMUX_AGENT_DIR = root
  const logs: string[] = []
  const host = nodeHost({ owner: 'owner', cwd: root, log: t => logs.push(t) })
  const failureHost: typeof host = {
    ...host,
    run: async () => ({ exitCode: -1, stdout: '', stderr: 'EACCES fleet probe denied' }),
  }

  try {
    const failed = await dashboard({ host: failureHost })
    assert.equal(failed.incomplete, true, 'snapshot must be marked incomplete on probe failure')
    assert.match(failed.diagnostic ?? '', /EACCES fleet probe denied/, 'diagnostic must contain probe stderr')
    assert.equal(failed.at, undefined, 'never stamp fresh at on incomplete data')
    assert.equal(failed.totals?.stopped ?? 0, 0, 'never synthesize stopped for unmatched ledger workers on failure')
    assert.equal(failed.sessions.length, 0, 'sessions must not contain synthesized stopped sessions')
    assert.ok(logs.length > 0, 'error must be logged to host')
  } finally {
    delete process.env.TMUX_AGENT_DIR
    rmSync(root, { recursive: true, force: true })
  }
})

test('finding R6: ledger read error is surfaced and not suppressed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-r6-ledger-'))
  const v3 = v3Of(root)
  process.env.TMUX_AGENT_DIR = root
  const logs: string[] = []
  const host = nodeHost({ owner: 'owner', cwd: root, log: t => logs.push(t) })
  const errorHost: typeof host = {
    ...host,
    exists: async path => {
      if (path.includes(v3)) {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      return host.exists(path)
    },
  }

  try {
    const line = await panel({ host: errorHost, session: 'owner' })
    assert.match(line, /ledger incomplete/)
    assert.match(line, /EACCES/)
    assert.doesNotMatch(line, /no workers/)

    // In dashboard: must mark incomplete and surface diagnostic
    const snap = await dashboard({ host: errorHost, sessions: [] })
    assert.equal(snap.incomplete, true)
    assert.match(snap.diagnostic ?? snap.error ?? '', /EACCES/)
    assert.equal(snap.at, undefined)
  } finally {
    delete process.env.TMUX_AGENT_DIR
    rmSync(root, { recursive: true, force: true })
  }
})

test('finding F5: panel CLI prints ledger incomplete and exits 1, never no workers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'panel-f5-'))
  const v3 = join(root, '.v3', 'w.abcde')
  mkdirSync(v3, { recursive: true })
  writeFileSync(join(v3, 'worker.json'), '{"profile":"codex","name":"w.abcde"}\n')
  chmodSync(join(root, '.v3'), 0o000)
  const script = fileURLToPath(new URL('./snapshot.node.ts', import.meta.url))
  const run = await new Promise<{ code: number; out: string; err: string }>(resolve => {
    execFile(
      process.execPath,
      ['--experimental-strip-types', script, 'panel'],
      { env: { ...process.env, TMUX_AGENT_DIR: root }, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          out: stdout ?? '',
          err: stderr ?? '',
        })
      },
    )
  })
  try {
    assert.doesNotMatch(run.out, /no workers/, run.out)
    assert.match(run.out, /ledger incomplete/)
    assert.match(run.out, /EACCES/)
    assert.equal(run.code, 1)
  } finally {
    chmodSync(join(root, '.v3'), 0o755)
    rmSync(root, { recursive: true, force: true })
  }
})

test('finding M1: panel CLI prints ledger incomplete and exits 1 when worker episode read errors without top-level error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'panel-m1-'))
  const v3 = join(root, '.v3', 'w.abcde')
  const ep = join(v3, 'episodes', '1')
  mkdirSync(ep, { recursive: true })
  writeFileSync(join(v3, 'worker.json'), JSON.stringify({ profile: 'codex', name: 'w.abcde', owner: 'me', dir: root, since: Date.now() }) + '\n')
  writeFileSync(join(ep, 'dispatch.json'), '{"seq":1,"resultPath":"/tmp/r.json"}\n')
  chmodSync(join(ep, 'dispatch.json'), 0o000)
  const script = fileURLToPath(new URL('./snapshot.node.ts', import.meta.url))
  const run = await new Promise<{ code: number; out: string; err: string }>(resolve => {
    execFile(
      process.execPath,
      ['--experimental-strip-types', script, 'panel'],
      { env: { ...process.env, TMUX_AGENT_DIR: root }, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          out: stdout ?? '',
          err: stderr ?? '',
        })
      },
    )
  })
  try {
    assert.doesNotMatch(run.out, /no workers/, run.out)
    assert.doesNotMatch(run.out, /delivered/, run.out)
    assert.match(run.out, /ledger incomplete/)
    assert.equal(run.code, 1)
  } finally {
    chmodSync(join(ep, 'dispatch.json'), 0o644)
    rmSync(root, { recursive: true, force: true })
  }
})

