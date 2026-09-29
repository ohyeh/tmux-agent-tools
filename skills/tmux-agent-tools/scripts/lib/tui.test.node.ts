import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { nodeHost } from './host.node.ts'
import {
  type PanelRow,
  newGate,
  assignWorker,
  panelRows,
  v3Of,
  displayCells,
  isFullwidth,
  CLEAR_ID,
  STOP_CONFIRM_MS,
  STOP_REPEAT_MS,
} from './workers.ts'
import {
  nextKeyState,
  renderTuiLines,
  restoreTerminal,
  enterTerminal,
  stripAnsi,
  truncateAnsi,
  runTui,
  type TuiState,
  ANSI_LEAVE_ALT,
} from './tui.node.ts'

function mockRow(id: string, opts: Partial<PanelRow> = {}): PanelRow {
  return {
    id,
    d: {
      profile: 'test',
      name: opts.d?.name ?? id,
      dir: opts.d?.dir ?? '/tmp/test-repo',
      since: opts.d?.since ?? Date.now() - 60_000,
      ...(opts.d?.goal ? { goal: opts.d.goal } : {}),
    },
    state: opts.state ?? 'running',
    ageMs: opts.ageMs ?? 60_000,
    terminal: opts.terminal ?? false,
    ...(opts.holder ? { holder: opts.holder } : {}),
    ...(opts.summary ? { summary: opts.summary } : {}),
    ...(opts.project ? { project: true } : {}),
    ...(opts.shell ? { shell: opts.shell } : {}),
    ...(opts.idleSeconds !== undefined ? { idleSeconds: opts.idleSeconds } : {}),
    ...(opts.blockedReason ? { blockedReason: opts.blockedReason } : {}),
  }
}

// -----------------------------------------------------------------------------
// 1. Key-state tests
// -----------------------------------------------------------------------------

test('key-state: q, Q, Ctrl-C quit the TUI', () => {
  const base: TuiState = { rows: [], all: [], showAll: false, adding: false, resumeInput: '', quit: false }
  const r1 = nextKeyState(base, 'q', 1000)
  assert.equal(r1.state.quit, true)
  assert.deepEqual(r1.action, { type: 'quit' })

  const r2 = nextKeyState(base, 'Q', 1000)
  assert.equal(r2.state.quit, true)
  assert.deepEqual(r2.action, { type: 'quit' })

  const r3 = nextKeyState(base, '\x03', 1000)
  assert.equal(r3.state.quit, true)
  assert.deepEqual(r3.action, { type: 'quit' })
})

test('key-state: r refreshes and clears selected, mirror, and armedStop', () => {
  const base: TuiState = {
    rows: [mockRow('w1')],
    all: [mockRow('w1')],
    showAll: false,
    selected: 'w1',
    mirror: { id: 'w1', lines: ['line 1'] },
    armedStop: { id: 'w1', from: 1000, until: 6000 },
    adding: false,
    resumeInput: '',
    quit: false,
  }
  const res = nextKeyState(base, 'r', 2000)
  assert.equal(res.state.selected, undefined)
  assert.equal(res.state.mirror, undefined)
  assert.equal(res.state.armedStop, undefined)
  assert.deepEqual(res.action, { type: 'refresh' })
})

test('key-state: a toggles showAll and updates rows with setRows', () => {
  const mine = mockRow('w1')
  const other = mockRow('w2', { holder: 'peer' })
  const base: TuiState = {
    rows: [mine],
    all: [mine, other],
    showAll: false,
    adding: false,
    resumeInput: '',
    quit: false,
  }
  const expanded = nextKeyState(base, 'a', 1000)
  assert.equal(expanded.state.showAll, true)
  assert.equal(expanded.state.rows.length, 2)

  const collapsed = nextKeyState(expanded.state, 'a', 1000)
  assert.equal(collapsed.state.showAll, false)
  assert.equal(collapsed.state.rows.length, 1)
  assert.equal(collapsed.state.rows[0]!.id, 'w1')
})

test('key-state: 1-9 selects row, and pressing same digit deselects', () => {
  const rows = [mockRow('w1'), mockRow('w2'), mockRow('w3')]
  const base: TuiState = {
    rows,
    all: rows,
    showAll: false,
    adding: false,
    resumeInput: '',
    quit: false,
  }
  const s1 = nextKeyState(base, '2', 1000)
  assert.equal(s1.state.selected, 'w2')

  const s2 = nextKeyState(s1.state, '2', 1000)
  assert.equal(s2.state.selected, undefined)

  const s3 = nextKeyState(s2.state, '9', 1000) // out of bounds
  assert.equal(s3.state.selected, undefined)
})

test('key-state: j/k and Up/Down arrows navigate selection', () => {
  const rows = [mockRow('w1'), mockRow('w2')]
  const base: TuiState = {
    rows,
    all: rows,
    showAll: false,
    adding: false,
    resumeInput: '',
    quit: false,
  }
  const d1 = nextKeyState(base, 'j', 1000)
  assert.equal(d1.state.selected, 'w1')

  const d2 = nextKeyState(d1.state, '\x1b[B', 1000) // Down
  assert.equal(d2.state.selected, 'w2')

  const u1 = nextKeyState(d2.state, 'k', 1000)
  assert.equal(u1.state.selected, 'w1')

  const u2 = nextKeyState(u1.state, '\x1b[A', 1000) // Up wraps to last
  assert.equal(u2.state.selected, 'w2')
})

test('key-state: n enters adding mode; typing, backspace, Enter submit, Escape cancel', () => {
  const base: TuiState = {
    rows: [],
    all: [],
    showAll: false,
    adding: false,
    resumeInput: '',
    quit: false,
  }
  const n = nextKeyState(base, 'n', 1000)
  assert.equal(n.state.adding, true)

  const t1 = nextKeyState(n.state, 'a', 1000)
  const t2 = nextKeyState(t1.state, 'g', 1000)
  const t3 = nextKeyState(t2.state, 'y', 1000)
  assert.equal(t3.state.resumeInput, 'agy')

  const bs = nextKeyState(t3.state, '\x7f', 1000)
  assert.equal(bs.state.resumeInput, 'ag')

  const submit = nextKeyState(bs.state, '\r', 1000)
  assert.equal(submit.state.adding, false)
  assert.equal(submit.state.resumeInput, '')
  assert.deepEqual(submit.action, { type: 'resume', value: 'ag' })

  // Empty submit cancels adding
  const emptySubmit = nextKeyState({ ...base, adding: true, resumeInput: '   ' }, '\n', 1000)
  assert.equal(emptySubmit.state.adding, false)
  assert.equal(emptySubmit.action, undefined)

  // Escape cancels adding
  const esc = nextKeyState({ ...base, adding: true, resumeInput: 'abc' }, '\x1b', 1000)
  assert.equal(esc.state.adding, false)
  assert.equal(esc.state.resumeInput, '')
  assert.equal(esc.action, undefined)
})

test('key-state: i interrupts running or stalled worker only', () => {
  const rRun = mockRow('w-run', { state: 'running' })
  const rStall = mockRow('w-stall', { state: 'stalled' })
  const rDone = mockRow('w-done', { state: 'delivered' })
  const rProj = mockRow('p1', { project: true, state: 'running' })

  const stateRun: TuiState = {
    rows: [rRun, rStall, rDone, rProj],
    all: [rRun, rStall, rDone, rProj],
    showAll: true,
    selected: 'w-run',
    adding: false,
    resumeInput: '',
    quit: false,
  }
  assert.deepEqual(nextKeyState(stateRun, 'i', 1000).action, { type: 'interrupt', row: rRun })

  const stateStall = { ...stateRun, selected: 'w-stall' }
  assert.deepEqual(nextKeyState(stateStall, 'i', 1000).action, { type: 'interrupt', row: rStall })

  const stateDone = { ...stateRun, selected: 'w-done' }
  assert.equal(nextKeyState(stateDone, 'i', 1000).action, undefined)

  const stateProj = { ...stateRun, selected: 'p1' }
  assert.equal(nextKeyState(stateProj, 'i', 1000).action, undefined)
})

test('key-state: x on selected worker arms stop; second press within 400ms debounces; second press between 400ms and 5000ms confirms stop', () => {
  const w1 = mockRow('w1')
  const base: TuiState = {
    rows: [w1],
    all: [w1],
    showAll: false,
    selected: 'w1',
    adding: false,
    resumeInput: '',
    quit: false,
  }

  // 1st press at t=1000: arm stop
  const press1 = nextKeyState(base, 'x', 1000)
  assert.equal(press1.action, undefined)
  assert.deepEqual(press1.state.armedStop, { id: 'w1', from: 1000, until: 1000 + STOP_CONFIRM_MS })

  // 2nd press at t=1200 (200ms < 400ms STOP_REPEAT_MS): debounced repeat, slides from
  const press2 = nextKeyState(press1.state, 'x', 1200)
  assert.equal(press2.action, undefined)
  assert.deepEqual(press2.state.armedStop, { id: 'w1', from: 1200, until: 1000 + STOP_CONFIRM_MS })

  // 3rd press at t=1700 (500ms > 400ms, and < 6000ms): confirmed!
  const press3 = nextKeyState(press2.state, 'x', 1700)
  assert.equal(press3.state.armedStop, undefined)
  assert.deepEqual(press3.action, { type: 'stop', row: w1 })
})

test('key-state: x expired confirm re-arms instead of firing', () => {
  const w1 = mockRow('w1')
  const armed: TuiState = {
    rows: [w1],
    all: [w1],
    showAll: false,
    selected: 'w1',
    armedStop: { id: 'w1', from: 1000, until: 6000 },
    adding: false,
    resumeInput: '',
    quit: false,
  }
  // Press at t=7000 (> 6000ms): expired! Re-arms until 12000.
  const expired = nextKeyState(armed, 'x', 7000)
  assert.equal(expired.action, undefined)
  assert.deepEqual(expired.state.armedStop, { id: 'w1', from: 7000, until: 12000 })
})

test('key-state: c arms clear all; second press confirms stopAll', () => {
  const w1 = mockRow('w1')
  const base: TuiState = {
    rows: [w1],
    all: [w1],
    showAll: false,
    adding: false,
    resumeInput: '',
    quit: false,
  }
  const press1 = nextKeyState(base, 'c', 1000)
  assert.equal(press1.action, undefined)
  assert.deepEqual(press1.state.armedStop, { id: CLEAR_ID, from: 1000, until: 1000 + STOP_CONFIRM_MS })

  const press2 = nextKeyState(press1.state, 'c', 1600)
  assert.equal(press2.state.armedStop, undefined)
  assert.deepEqual(press2.action, { type: 'stopAll' })
})

test('key-state: c on project-only fleet does nothing', () => {
  const p1 = mockRow('p1', { project: true })
  const base: TuiState = {
    rows: [p1],
    all: [p1],
    showAll: false,
    adding: false,
    resumeInput: '',
    quit: false,
  }
  const res = nextKeyState(base, 'c', 1000)
  assert.equal(res.state.armedStop, undefined)
  assert.equal(res.action, undefined)
})

test('key-state: cancel pending confirm via Escape, r, or selecting another row', () => {
  const w1 = mockRow('w1')
  const w2 = mockRow('w2')
  const armed: TuiState = {
    rows: [w1, w2],
    all: [w1, w2],
    showAll: false,
    selected: 'w1',
    armedStop: { id: 'w1', from: 1000, until: 6000 },
    adding: false,
    resumeInput: '',
    quit: false,
  }

  // Cancel via Escape
  const cEsc = nextKeyState(armed, '\x1b', 1200)
  assert.equal(cEsc.state.armedStop, undefined)

  // Cancel via r
  const cR = nextKeyState(armed, 'r', 1200)
  assert.equal(cR.state.armedStop, undefined)

  // Cancel via selecting row 2
  const cRow2 = nextKeyState(armed, '2', 1200)
  assert.equal(cRow2.state.armedStop, undefined)
  assert.equal(cRow2.state.selected, 'w2')
})

// -----------------------------------------------------------------------------
// 2. Render tests at widths 40/80/120 incl. CJK (display width & no wide cut)
// -----------------------------------------------------------------------------

test('render: display width bounds and wide CJK characters at widths 40, 80, 120', () => {
  const rCJK = mockRow('w-cjk', {
    d: { profile: 'claude', name: '測試隊友', dir: '/Users/test/專案目錄', since: Date.now() - 120_000, goal: '處理繁體中文與CJK寬度測試' },
    state: 'running',
    idleSeconds: 300,
  })
  const rNeedsInput = mockRow('w-input', {
    d: { profile: 'codex', name: 'codex-worker', dir: '/tmp/repo', since: Date.now() - 60_000 },
    state: 'needs-input',
    blockedReason: 'dialog',
  })
  const rDelivered = mockRow('w-done', {
    d: { profile: 'agy', name: 'agy-worker', dir: '/tmp/repo', since: Date.now() - 3600_000 },
    state: 'delivered',
    summary: 'success: 完成所有測試任務並產生清晰報表',
  })
  const rProj = mockRow('p-cjk', {
    d: { profile: '', name: '專案後台進程', dir: '/tmp/repo', since: Date.now() - 7200_000 },
    project: true,
    shell: 'zsh',
  })

  const state: TuiState = {
    rows: [rCJK, rNeedsInput, rDelivered, rProj],
    all: [rCJK, rNeedsInput, rDelivered, rProj, mockRow('w-other', { holder: 'deadbeef' })],
    showAll: false,
    selected: 'w-cjk',
    armedStop: { id: 'w-cjk', from: 1000, until: 6000 },
    adding: true,
    resumeInput: 'cursor-chat 12345678',
    statusMessage: 'stop 測試隊友 — ok',
    statusUntil: Date.now() + 5000,
    owner: 'mysessionid',
    quit: false,
  }

  for (const width of [40, 80, 120]) {
    for (const height of [5, 10, 24]) {
      const lines = renderTuiLines(state, width, height, 1500)
      assert.ok(lines.length <= height, `rendered lines ${lines.length} must not exceed height ${height}`)

      for (const line of lines) {
        const plain = stripAnsi(line)
        const cells = displayCells(plain)
        assert.ok(
          cells <= width,
          `line cell width ${cells} must not exceed ${width}: [${plain}]`,
        )

        // Ensure string is valid UTF-8 without broken code units
        assert.equal(Buffer.from(plain).toString('utf8'), plain)
        assert.ok(!plain.includes('\ufffd'), `line must not contain replacement character \\ufffd: ${plain}`)
      }
    }
  }
})

test('render: truncateAnsi cleanly cuts wide characters at exact boundaries', () => {
  // '專' (2 cells), '案' (2 cells), '目' (2 cells), '錄' (2 cells)
  const cjk = '專案目錄'
  assert.equal(displayCells(cjk), 8)

  // Max 5 cells: '專'(2) + '案'(2) = 4 cells; '目' would make 6 > 5, so it stops at '專案'
  const cut5 = truncateAnsi(cjk, 5)
  assert.equal(cut5, '專案')
  assert.equal(displayCells(cut5), 4)

  // Max 6 cells: '專'(2) + '案'(2) + '目'(2) = 6 cells
  const cut6 = truncateAnsi(cjk, 6)
  assert.equal(cut6, '專案目錄'.slice(0, 3))
  assert.equal(displayCells(cut6), 6)

  // With ANSI colors
  const colored = '\x1b[32m專案目錄\x1b[0m'
  const cutColored = truncateAnsi(colored, 5)
  assert.equal(stripAnsi(cutColored), '專案')
  assert.equal(displayCells(stripAnsi(cutColored)), 4)
})

// -----------------------------------------------------------------------------
// 3. Resize test (SIGWINCH re-render)
// -----------------------------------------------------------------------------

test('resize: SIGWINCH and window resize triggers re-render with new dimensions', async () => {
  class MockStdout extends EventEmitter {
    columns = 80
    rows = 24
    written = ''
    write(chunk: string) {
      this.written += chunk
      return true
    }
  }
  class MockStdin extends EventEmitter {
    isTTY = true
    isRaw = false
    setRawMode(raw: boolean) {
      this.isRaw = raw
    }
  }

  const mockStdin = new MockStdin() as any
  const mockStdout = new MockStdout() as any

  let tuiPromise: Promise<void> | undefined
  try {
    tuiPromise = runTui({
      stdin: mockStdin,
      stdout: mockStdout,
      session: 'test-session',
      root: mkdtempSync(join(tmpdir(), 'tui-root-')),
      mirrorMs: 60_000,
    })

    // Wait microtask for initial render
    await new Promise(r => setTimeout(r, 50))
    const initialOutput = mockStdout.written
    assert.ok(initialOutput.includes('workers'))

    // Trigger resize to 120x30
    mockStdout.columns = 120
    mockStdout.rows = 30
    mockStdout.written = ''
    process.emit('SIGWINCH')

    await new Promise(r => setTimeout(r, 20))
    assert.ok(mockStdout.written.length > 0, 'SIGWINCH must trigger re-render')
    assert.ok(mockStdout.written.includes('workers'))
  } finally {
    mockStdin.emit('data', 'q')
    await tuiPromise
  }
})

// -----------------------------------------------------------------------------
// 4. Terminal restore on exit and on an exception
// -----------------------------------------------------------------------------

test('restore: restoreTerminal turns off raw mode, shows cursor, and exits alt screen', () => {
  let rawState = true
  let output = ''
  const mockStdin = {
    isTTY: true,
    setRawMode: (b: boolean) => {
      rawState = b
    },
  } as any
  const mockStdout = {
    write: (s: string) => {
      output += s
      return true
    },
  } as any

  restoreTerminal(mockStdin, mockStdout)
  assert.equal(rawState, false, 'raw mode must be turned off')
  assert.ok(output.includes(ANSI_LEAVE_ALT), 'leave alt screen sequence must be written')
})

test('restore: runTui restores terminal on normal quit', async () => {
  class MockStdout extends EventEmitter {
    columns = 80
    rows = 24
    written = ''
    write(chunk: string) {
      this.written += chunk
      return true
    }
  }
  class MockStdin extends EventEmitter {
    isTTY = true
    isRaw = false
    setRawMode(raw: boolean) {
      this.isRaw = raw
    }
  }

  const mockStdin = new MockStdin() as any
  const mockStdout = new MockStdout() as any

  const runPromise = runTui({
    stdin: mockStdin,
    stdout: mockStdout,
    session: 'restore-test',
    root: mkdtempSync(join(tmpdir(), 'tui-root-')),
    mirrorMs: 60_000,
  })

  await new Promise(r => setTimeout(r, 30))
  assert.equal(mockStdin.isRaw, true, 'entered raw mode')

  // Quit
  mockStdin.emit('data', 'q')
  await runPromise

  assert.equal(mockStdin.isRaw, false, 'exited raw mode')
  assert.ok(mockStdout.written.includes(ANSI_LEAVE_ALT), 'exited alt screen')
})

test('restore: runTui restores terminal when an exception occurs in the loop', async () => {
  class MockStdout extends EventEmitter {
    columns = 80
    rows = 24
    written = ''
    write(chunk: string) {
      this.written += chunk
      return true
    }
  }
  class MockStdin extends EventEmitter {
    isTTY = true
    isRaw = false
    setRawMode(raw: boolean) {
      this.isRaw = raw
    }
  }

  const mockStdin = new MockStdin() as any
  const mockStdout = new MockStdout() as any

  const hostWithBomb = nodeHost({ owner: 'bomb', cwd: process.cwd() })
  hostWithBomb.now = () => Promise.reject(new Error('BOMB_IN_LOOP'))

  await assert.rejects(
    async () => {
      await runTui({
        stdin: mockStdin,
        stdout: mockStdout,
        host: hostWithBomb,
        mirrorMs: 60_000,
      })
    },
    /BOMB_IN_LOOP/,
  )

  assert.equal(mockStdin.isRaw, false, 'raw mode must be false even after exception')
  assert.ok(mockStdout.written.includes(ANSI_LEAVE_ALT), 'alt screen must be left even after exception')
})

// -----------------------------------------------------------------------------
// 5. No-mutation check over a root with a dead owner's orphan
// -----------------------------------------------------------------------------

test('no-mutation: TUI reads over a root with a dead owner orphan and mutates nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-nomut-root-'))
  const repo = mkdtempSync(join(tmpdir(), 'tui-nomut-repo-'))
  process.env.TMUX_AGENT_DIR = root

  // Create worker assigned by dead-owner with outside calls stubbed
  const base = nodeHost({ owner: 'dead-owner', cwd: repo })
  const outside = new Set(['git', 'sh', 'tmux', 'agent-tmux'])
  const deadHost = {
    ...base,
    run: async (argv: readonly string[], cwd?: string, ms?: number) => {
      if (outside.has(argv[0]!)) return { exitCode: 0, stdout: '', stderr: '' }
      return base.run(argv, cwd, ms)
    },
  }
  const r = await assignWorker(
    deadHost,
    { profile: 'claude', name: 'orphan-w', dir: repo, brief: 'GOAL: orphan\nACCEPTANCE: none\nREPORT: one line\n' },
    { owner: 'dead-owner', ownerCwd: repo },
  )
  if ('deny' in r) assert.fail(r.deny)

  // Verify initial state
  const claimsPath = `${r.stateDir}/episodes/1/claims`
  assert.ok(!existsSync(claimsPath), 'claims directory should not exist initially')

  // Helper to get recursive snapshot of all file paths and mtimes
  function dirSnapshot(dir: string): Map<string, number> {
    const snap = new Map<string, number>()
    function walk(p: string) {
      const entries = readdirSync(p, { withFileTypes: true })
      for (const e of entries) {
        const full = join(p, e.name)
        const rel = full.slice(dir.length)
        snap.set(rel, statSync(full).mtimeMs)
        if (e.isDirectory()) walk(full)
      }
    }
    walk(dir)
    return snap
  }

  const beforeSnap = dirSnapshot(root)

  // Now create TUI host with viewer 'tui-viewer'
  const tuiHost = nodeHost({ owner: 'tui-viewer', cwd: repo })
  const rows = await panelRows(tuiHost, newGate(), root)

  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.d.name, r.name)
  assert.equal(rows[0]!.holder, 'unknown', 'dead owner with no beat must show holder as unknown')

  // Verify claims directory was NOT created
  assert.ok(!existsSync(claimsPath), 'TUI must not claim: claims directory must still not exist')

  // Verify no files in the state root were created, deleted, or modified
  const afterSnap = dirSnapshot(root)
  assert.deepEqual(Array.from(afterSnap.keys()).sort(), Array.from(beforeSnap.keys()).sort())
  for (const [path, mtime] of beforeSnap) {
    assert.equal(afterSnap.get(path), mtime, `file ${path} was mutated during TUI read`)
  }
})

// -----------------------------------------------------------------------------
// 6. PTY run test
// -----------------------------------------------------------------------------

test('pty run: starts TUI in a real PTY, presses keys, quits, verifies screen output and restored tty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-pty-root-'))
  const repo = mkdtempSync(join(tmpdir(), 'tui-pty-repo-'))
  const tuiScript = join(import.meta.dirname, 'tui.node.ts')

  // Python PTY harness to run node tui.node.ts in an actual pseudo-terminal
  const pythonScript = `
import pty, os, sys, time, subprocess, termios

master, slave = pty.openpty()
env = dict(os.environ)
env['TMUX_AGENT_DIR'] = sys.argv[1]

node_bin = sys.argv[2]
tui_file = sys.argv[3]
repo_dir = sys.argv[4]

p = subprocess.Popen(
    [node_bin, tui_file, '--session', 'pty-session', '--cwd', repo_dir],
    stdin=slave, stdout=slave, stderr=slave, env=env
)
os.close(slave)

output = bytearray()
start = time.time()
while time.time() - start < 3:
    try:
        chunk = os.read(master, 4096)
        if chunk:
            output.extend(chunk)
            if b'workers' in output:
                break
    except OSError:
        break

# Send key 'r' (refresh), then key 'q' (quit)
time.sleep(0.1)
os.write(master, b'r')
time.sleep(0.1)
os.write(master, b'q')

while time.time() - start < 5:
    try:
        chunk = os.read(master, 4096)
        if chunk:
            output.extend(chunk)
    except OSError:
        break
    if p.poll() is not None:
        break

p.wait(timeout=3)
post_attr = termios.tcgetattr(master)
os.close(master)

# Write captured screen and status
print("=== EXIT CODE ===")
print(p.returncode)
print("=== TTY RESTORED ===")
# Check if ECHO and ICANON are restored (non-zero)
print(bool(post_attr[3] & (termios.ECHO | termios.ICANON)))
print("=== SCREEN OUTPUT ===")
print(output.decode('utf-8', errors='replace'))
`

  const nodeBin = process.execPath
  const res = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const cp = spawn('python3', ['-c', pythonScript, root, nodeBin, tuiScript, repo], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    cp.stdout.on('data', d => {
      out += d
    })
    cp.stderr.on('data', d => {
      err += d
    })
    cp.on('close', code => {
      resolve({ code: code ?? -1, stdout: out, stderr: err })
    })
  })

  assert.equal(res.code, 0, `python pty harness failed: ${res.stderr}`)
  assert.ok(res.stdout.includes('=== EXIT CODE ===\n0'), 'TUI must exit with code 0 on q')
  assert.ok(res.stdout.includes('=== TTY RESTORED ===\nTrue'), 'TTY flags must be restored after exit')
  assert.ok(res.stdout.includes('workers'), 'Screen output must contain workers title')
})
