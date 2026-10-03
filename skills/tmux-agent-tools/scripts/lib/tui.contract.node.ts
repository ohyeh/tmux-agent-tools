import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, cpSync, symlinkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { execFile, spawn } from 'node:child_process'
import { nodeHost } from './host.node.ts'
import {
  type PanelRow,
  newGate,
  assignWorker,
  panelRows,
  wrapperCall,
  v3Of,
  CLEAR_ID,
  STOP_CONFIRM_MS,
  STOP_REPEAT_MS,
  sessionDirOf,
  readActHealth,
  writeActState,
  heartbeat,
  episodeDetail,
  resumeWorker,
  type Health,
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
  KeyParser,
  ESC_WAIT_MS,
  SEQ_IDLE_MS,
  SEQ_MAX,
  PASTE_MAX,
  INPUT_DROPPED,
  cellWidth,
  graphemeWidth,
  graphemes,
  sanitizeAnsi,
  layoutOf,
  tuiLayout,
  healthText,
  emptyText,
  detailText,
  wrapCells,
  MUTATING_KEYS,
  READ_ONLY,
  rowHints,
  PAGE_DOWN,
  PAGE_UP,
  ANSI_CLEAR_HOME,
  padCells,
} from './tui.node.ts'
import { eawOf, EAW_UNICODE_VERSION } from './eaw-table.ts'

/** Wait for a condition with a deadline. A fixed sleep races a loaded machine (H6). */
async function until(cond: () => boolean, ms = 5_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms}ms waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

/** Filesystem host whose `run` does not exec. Keeps a TUI test off the default tmux server. */
function quietHost(owner: string | undefined, cwd: string, root: string) {
  const host = nodeHost({ owner, cwd })
  host.envTmuxAgentDir = async () => root
  host.run = async () => ({ exitCode: 0, stdout: '', stderr: '' })
  return host
}

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
    d: { profile: 'claude', name: '測試隊友👨‍👩‍👧', dir: '/Users/test/專案目錄', since: Date.now() - 120_000, goal: '處理繁體中文與CJK寬度測試' },
    state: 'running',
    idleSeconds: 300,
    summary: 'failed: 🇹🇼 #️⃣ ❤ é ·±─ 中︎ 結果',
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
    mirror: { id: 'w-cjk', lines: ['輸出 👨‍👩‍👧 🇹🇼 ok', '́lead · ±─█ 中文字中文字中文字中文字中文字中文字中文字中文字中文字中文字'] },
    quit: false,
  }

  const prev = process.env.TMUX_AGENT_AMBIGUOUS_WIDTH
  try {
  for (const amb of ['1', '2'])
  for (const width of [7, 40, 41, 80, 120]) {
    process.env.TMUX_AGENT_AMBIGUOUS_WIDTH = amb
    for (const height of [5, 10, 24]) {
      const lines = renderTuiLines(state, width, height, 1500)
      assert.ok(lines.length <= height, `rendered lines ${lines.length} must not exceed height ${height}`)

      for (const line of lines) {
        const plain = stripAnsi(line)
        const cells = cellWidth(plain)
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
  } finally {
    if (prev === undefined) delete process.env.TMUX_AGENT_AMBIGUOUS_WIDTH
    else process.env.TMUX_AGENT_AMBIGUOUS_WIDTH = prev
  }
})

test('render: truncateAnsi cleanly cuts wide characters at exact boundaries', () => {
  // '專' (2 cells), '案' (2 cells), '目' (2 cells), '錄' (2 cells)
  const cjk = '專案目錄'
  assert.equal(cellWidth(cjk), 8)

  // Max 5 cells: '專'(2) + '案'(2) = 4 cells; '目' would make 6 > 5, so it stops at '專案'
  const cut5 = truncateAnsi(cjk, 5)
  assert.equal(cut5, '專案')
  assert.equal(cellWidth(cut5), 4)

  // Max 6 cells: '專'(2) + '案'(2) + '目'(2) = 6 cells
  const cut6 = truncateAnsi(cjk, 6)
  assert.equal(cut6, '專案目錄'.slice(0, 3))
  assert.equal(cellWidth(cut6), 6)

  // With ANSI colors
  const colored = '\x1b[32m專案目錄\x1b[0m'
  const cutColored = truncateAnsi(colored, 5)
  assert.equal(stripAnsi(cutColored), '專案')
  assert.equal(cellWidth(stripAnsi(cutColored)), 4)
})

// R2.2: the old guard compared `file://${argv[1]}` with import.meta.url, which is
// percent-encoded, so a path with a space ran nothing and exited 0.
test('main guard: runs from a path with a space, %, #, and through a symlink', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tui-guard-'))
  const copy = join(tmp, 'a b%41#c')
  cpSync(import.meta.dirname, copy, { recursive: true })
  const link = join(tmp, 'link dir')
  symlinkSync(copy, link)
  const run = (script: string) =>
    new Promise<{ code: number; err: string }>(resolve => {
      execFile(process.execPath, [script, '--no-such-flag'], { timeout: 20_000 }, (error, _out, err) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, err })
      })
    })
  for (const script of [join(copy, 'tui.node.ts'), join(link, 'tui.node.ts')]) {
    const res = await run(script)
    assert.equal(res.code, 2, `${script}: main() ran and rejected the flag\n${res.err}`)
    assert.match(res.err, /^tui: /, script)
  }
  rmSync(tmp, { recursive: true, force: true })
})

// -----------------------------------------------------------------------------
// 2b. Width per plan §1c S7. Every expected cell count is written by hand.
// -----------------------------------------------------------------------------

function withAmbiguous<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.TMUX_AGENT_AMBIGUOUS_WIDTH
  if (value === undefined) delete process.env.TMUX_AGENT_AMBIGUOUS_WIDTH
  else process.env.TMUX_AGENT_AMBIGUOUS_WIDTH = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.TMUX_AGENT_AMBIGUOUS_WIDTH
    else process.env.TMUX_AGENT_AMBIGUOUS_WIDTH = prev
  }
}

test('width: S7 fixtures with hard-coded cell counts', () => {
  withAmbiguous(undefined, () => {
    const cases: [string, string, number][] = [
      ['family ZWJ', '\u{1F468}‍\u{1F469}‍\u{1F467}', 2],
      ['flag TW', '\u{1F1F9}\u{1F1FC}', 2],
      ['keycap with FE0F', '#️⃣', 2],
      ['keycap without FE0F', '#⃣', 2],
      ['lone VS16', '️', 0],
      ['A + ZWJ', 'A‍', 1],
      ['中 + VS15', '中︎', 2],
      ['text-presentation heart U+2764', '❤', 1],
      ['heart U+2764 + VS16', '❤️', 2],
      ['CJK', '中文字', 6],
      ['middle dot (ambiguous)', '·', 2],
      ['plus-minus (ambiguous)', '±', 2],
      ['leading combining mark', '́', 0],
      ['leading combining mark then a', '́a', 1],
      ['e + combining acute', 'é', 1],
      ['ASCII', 'abc', 3],
    ]
    for (const [name, text, cells] of cases) assert.equal(cellWidth(text), cells, name)
    assert.equal(graphemeWidth('\u{1F468}‍\u{1F469}‍\u{1F467}'), 2, 'family is one grapheme of 2')
  })
})

test('width: TMUX_AGENT_AMBIGUOUS_WIDTH=1 makes ambiguous characters one cell', () => {
  withAmbiguous('1', () => {
    assert.equal(cellWidth('·'), 1)
    assert.equal(cellWidth('±'), 1)
    assert.equal(cellWidth('中'), 2, 'W stays 2')
  })
  withAmbiguous('2', () => assert.equal(cellWidth('±'), 2))
})

test('width: the generated EAW table', () => {
  assert.equal(EAW_UNICODE_VERSION, '17.0.0')
  assert.equal(eawOf(0x4e2d), 'W') // 中
  assert.equal(eawOf(0xff01), 'W') // fullwidth ! (F)
  assert.equal(eawOf(0x00b7), 'A') // ·
  assert.equal(eawOf(0x0041), undefined) // A (Na)
  assert.equal(eawOf(0x2764), undefined) // ❤ (N)
  assert.equal(eawOf(0x2fff0), 'W') // unassigned plane 2: W by the file's header default
})

test('width: truncation never splits a grapheme or an escape, and fits the width', () => {
  withAmbiguous(undefined, () => {
    assert.equal(truncateAnsi('a\u{1F468}‍\u{1F469}‍\u{1F467}b', 2), 'a')
    assert.equal(truncateAnsi('éxyz', 1), 'é')
    assert.equal(truncateAnsi('\u{1F1F9}\u{1F1FC}\u{1F1EF}\u{1F1F5}', 3), '\u{1F1F9}\u{1F1FC}')
    assert.equal(truncateAnsi('\x1b[31m中文\x1b[0m', 3), '\x1b[31m中\x1b[0m')
    const text = '\x1b[32mok 👨‍👩‍👧 中\x1b[1m文 #️⃣ é ·\x1b[0m end'
    const all = graphemes(stripAnsi(text))
    for (let max = 0; max <= 25; max++) {
      const cut = truncateAnsi(text, max)
      assert.ok(cellWidth(cut) <= max, `max ${max}: ${cellWidth(cut)}`)
      const got = graphemes(stripAnsi(cut))
      assert.deepEqual(got, all.slice(0, got.length), `max ${max}: a whole-grapheme prefix`)
      assert.ok(!/\x1b(?!\[[0-9;]*m)/.test(cut), `max ${max}: no split escape`)
    }
  })
})

// -----------------------------------------------------------------------------
// 2c. Untrusted text keeps only SGR
// -----------------------------------------------------------------------------

test('escape: OSC title is stripped (BEL and ST forms)', () => {
  assert.equal(sanitizeAnsi('a\x1b]0;evil title\x07b'), 'ab')
  assert.equal(sanitizeAnsi('a\x1b]2;evil\x1b\\b'), 'ab')
})

test('escape: OSC 52 clipboard write is stripped', () => {
  assert.equal(sanitizeAnsi('x\x1b]52;c;ZXZpbA==\x07y'), 'xy')
})

test('escape: cursor movement and other CSI are stripped; SGR is kept', () => {
  assert.equal(sanitizeAnsi('a\x1b[2J\x1b[H\x1b[10;5Hb\x1b[?25l\x1b[1A'), 'ab')
  assert.equal(sanitizeAnsi('\x1b[31mred\x1b[0m'), '\x1b[31mred\x1b[0m')
  assert.equal(sanitizeAnsi('\x1bc\x1b(Bz\x1bPq#0\x1b\\'), 'z', 'RIS, charset, DCS')
  assert.equal(sanitizeAnsi('a\x9b2Jb\x07\x08\tc'), 'a2Jb c', 'C1 CSI, BEL, BS dropped; tab is a space')
})

test('escape: an incomplete escape at the end is dropped', () => {
  assert.equal(sanitizeAnsi('ok\x1b[31'), 'ok')
  assert.equal(sanitizeAnsi('ok\x1b]0;tit'), 'ok')
  assert.equal(sanitizeAnsi('ok\x1b'), 'ok')
})

test('escape: CJK mixed with escapes, through the renderer', () => {
  assert.equal(sanitizeAnsi('中\x1b]0;t\x07文\x1b[1A字'), '中文字')
  const row = mockRow('w-esc', { state: 'delivered', summary: 'success: 完成\x1b]52;c;ZXZpbA==\x07了\x1b[2J' })
  const state: TuiState = {
    rows: [row],
    all: [row],
    showAll: false,
    selected: 'w-esc',
    adding: false,
    resumeInput: '',
    mirror: { id: 'w-esc', lines: ['輸出\x1b]0;pwned\x07中\x1b[H文\x1b[31m紅\x1b[0m', 'tail\x1b[3'] },
    statusMessage: 'stop — FAILED: \x1b]0;x\x07錯誤',
    statusUntil: Date.now() + 60_000,
    quit: false,
  }
  const lines = renderTuiLines(state, 80, 24, Date.now())
  const screen = lines.join('\n')
  assert.ok(screen.includes('完成了'), screen)
  assert.ok(screen.includes('輸出中文\x1b[31m紅'), screen)
  assert.ok(screen.includes('錯誤'), screen)
  // Only SGR may remain: every ESC starts `ESC [ digits/; m`.
  assert.ok(!/\x1b(?!\[[0-9;]*m)/.test(screen), JSON.stringify(screen))
})

// -----------------------------------------------------------------------------
// 2d. Streaming input
// -----------------------------------------------------------------------------

test('input: rq in one chunk is refresh, then quit (COALESCED_QUIT)', async () => {
  assert.deepEqual(new KeyParser().feed('rq'), ['r', 'q'])
  const { stdin, stdout } = mockTty()
  const root = mkdtempSync(join(tmpdir(), 'tui-rq-'))
  const host = quietHost('rq', root, root)
  // runTui copies the host, so the counter is in place before it starts.
  let refreshes = 0
  let counting = false
  const realNow = host.now
  host.now = async () => {
    if (counting) refreshes += 1
    return realNow()
  }
  const run = runTui({ stdin, stdout, host, session: 'rq', cwd: root, root, mirrorMs: 60_000 })
  await until(() => stdout.written.includes('workers'), 5_000, 'the first render')
  counting = true
  stdin.emit('data', 'rq')
  const ended = await Promise.race([run.then(() => 'quit'), new Promise(r => setTimeout(() => r('hung'), 3_000))])
  if (ended === 'hung') stdin.emit('data', 'q')
  await run
  assert.equal(ended, 'quit', 'rq in one chunk must quit')
  assert.ok(refreshes > 0, 'the r ran a refresh before the q')
})

test('input: jk in one chunk moves down, then up', () => {
  assert.deepEqual(new KeyParser().feed('jk'), ['j', 'k'])
  const rows = [mockRow('a'), mockRow('b'), mockRow('c')]
  let state: TuiState = { rows, all: rows, showAll: false, selected: 'b', adding: false, resumeInput: '', quit: false }
  for (const key of new KeyParser().feed('jk')) state = nextKeyState(state, key, 1).state
  assert.equal(state.selected, 'b', 'j to c, k back to b')
})

test('input: ESC and an arrow key split across chunks', () => {
  const p = new KeyParser()
  assert.deepEqual(p.feed('\x1b'), [])
  assert.equal(p.pendingEsc(), true)
  assert.deepEqual(p.feed('[A'), ['\x1b[A'], 'ESC + "[A" in the next chunk is Up')
  assert.deepEqual(p.feed('\x1b['), [])
  assert.deepEqual(p.feed('1;5'), [])
  assert.deepEqual(p.feed('B'), ['\x1b[1;5B'])
  assert.deepEqual(p.feed('\x1bO'), [])
  assert.deepEqual(p.feed('A'), ['\x1bOA'], 'SS3 split')
  assert.deepEqual(p.feed('\x1b'), [])
  assert.deepEqual(p.flushEsc(), ['\x1b'], 'a lone ESC is let go by the timer')
  assert.equal(p.pendingEsc(), false)
  assert.deepEqual(p.feed('\x1b'), [])
  assert.deepEqual(p.feed('q'), ['\x1b', 'q'], 'ESC then a plain key in the next chunk')
})

test('input: a lone ESC in runTui resolves after the wait and cancels the prompt', async () => {
  const { stdin, stdout } = mockTty()
  const root = mkdtempSync(join(tmpdir(), 'tui-esc-'))
  const run = runTui({ stdin, stdout, host: quietHost('e', root, root), session: 'e', cwd: root, root, mirrorMs: 60_000 })
  await until(() => stdout.written.includes('workers'), 5_000, 'the first render')
  stdin.emit('data', 'n')
  await until(() => stdout.written.includes('<session-id>'), 5_000, 'the resume prompt')
  stdout.written = ''
  const sent = Date.now()
  stdin.emit('data', '\x1b')
  await until(() => stdout.written.includes('workers'), 5_000, 'the render after ESC')
  assert.ok(Date.now() - sent >= ESC_WAIT_MS - 5, 'ESC waited for a possible sequence')
  assert.ok(!stdout.written.includes('<session-id>'), 'ESC closed the prompt')
  stdin.emit('data', 'q')
  await run
})

test('input: bracketed paste markers split across chunks', () => {
  const p = new KeyParser()
  assert.deepEqual(p.feed('\x1b[20'), [])
  assert.deepEqual(p.feed('0~abc-'), [])
  assert.deepEqual(p.feed('def\x1b[2'), [])
  assert.deepEqual(p.feed('01~'), ['\x1b[200~abc-def\x1b[201~'])
  const base: TuiState = { rows: [], all: [], showAll: false, adding: true, resumeInput: '', quit: false }
  assert.equal(nextKeyState(base, '\x1b[200~abc-def\x1b[201~', 1).state.resumeInput, 'abc-def')
  const pastedQ = new KeyParser().feed('\x1b[200~q\x1b[201~')
  assert.deepEqual(pastedQ, ['\x1b[200~q\x1b[201~'])
  assert.equal(nextKeyState({ ...base, adding: false }, pastedQ[0]!, 1).state.quit, false, 'a pasted q is not quit')
})

test('input: a UTF-8 character split across chunks arrives whole', async () => {
  const { stdin, stdout } = mockTty()
  const root = mkdtempSync(join(tmpdir(), 'tui-utf8-'))
  const run = runTui({ stdin, stdout, host: quietHost('u', root, root), session: 'u', cwd: root, root, mirrorMs: 60_000 })
  await until(() => stdout.written.includes('workers'), 5_000, 'the first render')
  stdin.emit('data', Buffer.from('n'))
  const bytes = Buffer.from('中👍')
  for (const cut of [[0, 1], [1, 3], [3, 5], [5, 7]]) stdin.emit('data', bytes.subarray(cut[0], cut[1]))
  await until(() => stdout.written.includes(': 中👍█'), 5_000, 'the decoded text in the prompt')
  assert.ok(!stdout.written.includes('�'))
  stdin.emit('data', '\x1b')
  stdin.emit('data', 'q')
  await run
})

test('input: backspace deletes one grapheme (emoji, CJK, combining)', () => {
  const base: TuiState = { rows: [], all: [], showAll: false, adding: true, resumeInput: '', quit: false }
  const bs = (text: string) => nextKeyState({ ...base, resumeInput: text }, '\x7f', 1).state.resumeInput
  assert.equal(bs('ab\u{1F468}‍\u{1F469}‍\u{1F467}'), 'ab')
  assert.equal(bs('id\u{1F1F9}\u{1F1FC}'), 'id')
  assert.equal(bs('中文'), '中')
  assert.equal(bs('cé'), 'c')
  assert.equal(bs(''), '')
})

// -----------------------------------------------------------------------------
// 2e. Terminal state: one cleanup for every way out
// -----------------------------------------------------------------------------

function mockTty(raw = false) {
  class In extends EventEmitter {
    isTTY = true
    isRaw = raw
    setRawMode(r: boolean) {
      this.isRaw = r
    }
    resume() {}
    pause() {}
  }
  class Out extends EventEmitter {
    columns = 80
    rows = 24
    written = ''
    write(t: string) {
      this.written += t
      return true
    }
  }
  return { stdin: new In() as any, stdout: new Out() as any }
}

function listenerCounts() {
  return ['SIGWINCH', 'SIGINT', 'SIGTERM', 'exit'].map(e => process.listenerCount(e))
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  test(`terminal: ${sig} restores the terminal through the one cleanup`, async () => {
    const before = listenerCounts()
    const { stdin, stdout } = mockTty()
    const root = mkdtempSync(join(tmpdir(), 'tui-sig-'))
    const run = runTui({ stdin, stdout, host: quietHost('s', root, root), session: 's', cwd: root, root, mirrorMs: 60_000 })
    await until(() => stdout.written.includes('workers'), 5_000, 'the first render')
    process.emit(sig)
    await run
    assert.equal(stdin.isRaw, false)
    assert.ok(stdout.written.endsWith(ANSI_LEAVE_ALT))
    assert.deepEqual(listenerCounts(), before)
    assert.equal(stdin.listenerCount('data') + stdin.listenerCount('end') + stdin.listenerCount('error'), 0)
  })
}

test("terminal: stdin 'end' quits and restores", async () => {
  const { stdin, stdout } = mockTty()
  const root = mkdtempSync(join(tmpdir(), 'tui-end-'))
  const run = runTui({ stdin, stdout, host: quietHost('s', root, root), session: 's', cwd: root, root, mirrorMs: 60_000 })
  await until(() => stdout.written.includes('workers'), 5_000, 'the first render')
  stdin.emit('end')
  await run
  assert.equal(stdin.isRaw, false)
  assert.ok(stdout.written.endsWith(ANSI_LEAVE_ALT))
})

test("terminal: stdin 'error' rejects and restores", async () => {
  const { stdin, stdout } = mockTty()
  const root = mkdtempSync(join(tmpdir(), 'tui-err-'))
  const run = runTui({ stdin, stdout, host: quietHost('s', root, root), session: 's', cwd: root, root, mirrorMs: 60_000 })
  await until(() => stdout.written.includes('workers'), 5_000, 'the first render')
  stdin.emit('error', new Error('EIO_STDIN'))
  await assert.rejects(run, /EIO_STDIN/)
  assert.equal(stdin.isRaw, false)
  assert.ok(stdout.written.endsWith(ANSI_LEAVE_ALT))
})

test('terminal: an async rejection inside the refresh timer rejects and restores', async () => {
  const { stdin, stdout } = mockTty()
  const root = mkdtempSync(join(tmpdir(), 'tui-timer-'))
  const host = quietHost('s', root, root)
  let bomb = false
  const realNow = host.now
  host.now = () => (bomb ? Promise.reject(new Error('BOMB_IN_TIMER')) : realNow())
  const run = runTui({ stdin, stdout, host, session: 's', cwd: root, root, mirrorMs: 20 })
  await until(() => stdout.written.includes('workers'), 5_000, 'the first render')
  bomb = true
  const ended = await Promise.race([run.then(() => 'resolved', () => 'rejected'), new Promise(r => setTimeout(() => r('hung'), 3_000))])
  if (ended === 'hung') stdin.emit('data', 'q')
  assert.equal(ended, 'rejected', 'a rejection in the timer ends runTui')
  await assert.rejects(run, /BOMB_IN_TIMER/)
  assert.equal(stdin.isRaw, false)
  assert.ok(stdout.written.endsWith(ANSI_LEAVE_ALT))
})

test('terminal: after a stop, an in-flight refresh does not render', async () => {
  const { stdin, stdout } = mockTty()
  const root = mkdtempSync(join(tmpdir(), 'tui-late-'))
  const host = quietHost('s', root, root)
  let release: () => void = () => {}
  const gate = new Promise<void>(r => (release = r))
  const realNow = host.now
  host.now = async () => {
    await gate
    return realNow()
  }
  const run = runTui({ stdin, stdout, host, session: 's', cwd: root, root, mirrorMs: 60_000 })
  process.emit('SIGTERM')
  await run
  const after = stdout.written
  release()
  await new Promise(r => setTimeout(r, 50))
  process.emit('SIGWINCH')
  assert.equal(stdout.written, after, 'nothing is drawn after the leave-alt sequence')
  assert.ok(after.endsWith(ANSI_LEAVE_ALT))
})

test('terminal: a tty that was already raw is left raw', async () => {
  const { stdin, stdout } = mockTty(true)
  const root = mkdtempSync(join(tmpdir(), 'tui-raw-'))
  const run = runTui({ stdin, stdout, host: quietHost('s', root, root), session: 's', cwd: root, root, mirrorMs: 60_000 })
  stdin.emit('data', 'q')
  await run
  assert.equal(stdin.isRaw, true, 'restored to the entry state, raw')
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
  const root = mkdtempSync(join(tmpdir(), 'tui-root-'))

  let tuiPromise: Promise<void> | undefined
  try {
    tuiPromise = runTui({
      stdin: mockStdin,
      stdout: mockStdout,
      host: quietHost('test-session', root, root),
      session: 'test-session',
      cwd: root,
      root,
      mirrorMs: 60_000,
    })

    await until(() => mockStdout.written.includes('workers'), 5_000, 'the first render')

    // Trigger resize to 120x30
    mockStdout.columns = 120
    mockStdout.rows = 30
    mockStdout.written = ''
    process.emit('SIGWINCH')

    await until(() => mockStdout.written.includes('workers'), 5_000, 'SIGWINCH to re-render')
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
  const root = mkdtempSync(join(tmpdir(), 'tui-root-'))

  const runPromise = runTui({
    stdin: mockStdin,
    stdout: mockStdout,
    host: quietHost('restore-test', root, root),
    session: 'restore-test',
    cwd: root,
    root,
    mirrorMs: 60_000,
  })

  await until(() => mockStdin.isRaw === true, 5_000, 'raw mode')

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

  const root = mkdtempSync(join(tmpdir(), 'tui-bomb-'))
  const hostWithBomb = quietHost('bomb', root, root)
  hostWithBomb.now = () => Promise.reject(new Error('BOMB_IN_LOOP'))

  await assert.rejects(
    async () => {
      await runTui({
        stdin: mockStdin,
        stdout: mockStdout,
        host: hostWithBomb,
        session: 'bomb',
        cwd: root,
        root,
        mirrorMs: 60_000,
      })
    },
    /BOMB_IN_LOOP/,
  )

  assert.equal(mockStdin.isRaw, false, 'raw mode must be false even after exception')
  assert.ok(mockStdout.written.includes(ANSI_LEAVE_ALT), 'alt screen must be left even after exception')
})

// H6: runTui attached its stdin listener only after the first refresh; a key
// that arrived during a slow first load was dropped and runTui never resolved.
test('input: a q sent before the first refresh completes quits at once (H6)', async () => {
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
  const root = mkdtempSync(join(tmpdir(), 'tui-slow-'))
  const slow = quietHost('slow', root, root)
  let release: () => void = () => {}
  const gate = new Promise<void>(r => (release = r))
  const realNow = slow.now
  slow.now = async () => {
    await gate
    return realNow()
  }
  const started = Date.now()
  const run = runTui({ stdin: mockStdin, stdout: mockStdout, host: slow, session: 'slow', cwd: root, root, mirrorMs: 60_000 })
  mockStdin.emit('data', 'q')
  const quitFirst = await Promise.race([run.then(() => 'quit'), new Promise(r => setTimeout(() => r('hung'), 2_000))])
  release()
  if (quitFirst === 'hung') {
    // The early q was dropped. Quit for real so the test fails here instead of hanging.
    await until(() => mockStdin.listenerCount('data') > 0, 5_000, 'the stdin listener')
    mockStdin.emit('data', 'q')
  }
  await run
  assert.equal(quitFirst, 'quit', 'q during the first load must end runTui without waiting for the load')
  assert.ok(Date.now() - started < 2_000)
  assert.equal(mockStdin.isRaw, false, 'terminal restored')
  assert.equal(mockStdin.listenerCount('data'), 0, 'stdin listener removed')
})

test('cleanup: two runTui calls leave process and stream listener counts unchanged (H6)', async () => {
  const count = () => ({
    winch: process.listenerCount('SIGWINCH'),
    int: process.listenerCount('SIGINT'),
    term: process.listenerCount('SIGTERM'),
    exit: process.listenerCount('exit'),
  })
  const before = count()
  for (const n of [1, 2]) {
    const stdout = Object.assign(new EventEmitter(), { columns: 80, rows: 24, write: () => true }) as any
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {} }) as any
    const root = mkdtempSync(join(tmpdir(), `tui-count-${n}-`))
    const run = runTui({ stdin, stdout, host: quietHost('count', root, root), session: 'count', cwd: root, root, mirrorMs: 60_000 })
    stdin.emit('data', 'q')
    await run
    assert.equal(stdin.listenerCount('data'), 0)
    assert.equal(stdout.listenerCount('resize'), 0)
  }
  assert.deepEqual(count(), before, 'runTui must remove every listener it added')
})

// -----------------------------------------------------------------------------
// 5. No-mutation check over a root with a dead owner's orphan
// -----------------------------------------------------------------------------

test('no-mutation core panelRows: reads a dead-owner orphan and mutates nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-nomut-root-'))
  const repo = mkdtempSync(join(tmpdir(), 'tui-nomut-repo-'))
  process.env.TMUX_AGENT_DIR = root

  // Create worker assigned by dead-owner with outside calls stubbed
  const base = nodeHost({ owner: 'dead-owner', cwd: repo })
  const outside = new Set(['git', 'sh', 'tmux', 'agent-tmux'])
  const deadHost = {
    ...base,
    run: async (argv: readonly string[], cwd: string, ms: number) => {
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

test('pty run: q, rq, Ctrl-C, Ctrl-C in the prompt (Sol#10), SIGTERM, an exception, and an already-raw tty all restore the tty flags', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-pty-root-'))
  const repo = mkdtempSync(join(tmpdir(), 'tui-pty-repo-'))
  const tuiScript = join(import.meta.dirname, 'tui.node.ts')
  // The exception case: the real runTui on a real tty, with a host whose clock
  // rejects inside the refresh timer once the TUI is up.
  const bombScript = join(root, 'bomb.ts')
  writeFileSync(
    bombScript,
    `import { runTui } from ${JSON.stringify(pathToFileURL(tuiScript).href)}
import { nodeHost } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'host.node.ts')).href)}
const [, , root, cwd] = process.argv as [string, string, string, string]
const host = nodeHost({ owner: 'pty-bomb', cwd })
const realNow = host.now
let bomb = false
setTimeout(() => (bomb = true), 300)
host.now = () => (bomb ? Promise.reject(new Error('PTY_BOMB')) : realNow())
await runTui({ host, session: 'pty-bomb', cwd, root, mirrorMs: 50 }).catch(err => {
  process.stderr.write('tui error: ' + String(err) + '\\n')
  process.exit(1)
})
`,
  )

  // Python PTY harness: run the TUI in a real pseudo-terminal, act per scenario,
  // and compare the slave's termios before start and after exit.
  const pythonScript = `
import pty, os, select, sys, time, subprocess, termios, tty, signal

master, slave = pty.openpty()
env = dict(os.environ)
env.pop('TMUX', None)
env.pop('TMUX_PANE', None)
env['TMUX_AGENT_DIR'] = sys.argv[1]
env['TMUX_AGENT_TMUX_SOCKET'] = sys.argv[5]

node_bin = sys.argv[2]
tui_file = sys.argv[3]
repo_dir = sys.argv[4]
scenario = sys.argv[6]
bomb_file = sys.argv[7]

if scenario == 'preraw':
    tty.setraw(slave)
pre_attr = termios.tcgetattr(slave)
cmd = [node_bin, bomb_file, sys.argv[1], repo_dir] if scenario == 'exception' else [node_bin, tui_file, '--session', 'pty-session', '--cwd', repo_dir]
p = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=env)
# The slave stays open here so its termios can be read after the child exits.

def read_some(master, seconds, until=None):
    # os.read on a PTY master blocks until bytes arrive. The old loops checked
    # the clock only after a read returned, so a partial frame (no "workers"
    # yet, child still open) waited forever. select makes the bound real.
    deadline = time.time() + seconds
    buf = bytearray()
    while time.time() < deadline and (until is None or until not in buf):
        left = deadline - time.time()
        ready, _, _ = select.select([master], [], [], left)
        if not ready:
            break
        try:
            chunk = os.read(master, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf.extend(chunk)
    return buf

output = bytearray()
start = time.time()
while time.time() - start < 3 and b'workers' not in output:
    output.extend(read_some(master, max(0.0, 3 - (time.time() - start)), b'workers'))

time.sleep(0.1)
if scenario == 'q':
    os.write(master, b'r')
    time.sleep(0.1)
    os.write(master, b'q')
elif scenario == 'rq':
    os.write(master, b'rq')  # one chunk: refresh, then quit
elif scenario == 'ctrl-c':
    os.write(master, b'\\x03')  # raw mode: Ctrl-C arrives as a key
elif scenario == 'ctrl-c-prompt':
    os.write(master, b'n')  # open the resume prompt
    output.extend(read_some(master, 2, b'<session-id>'))
    os.write(master, b'\\x03')
elif scenario == 'sigterm':
    p.send_signal(signal.SIGTERM)
elif scenario == 'preraw':
    os.write(master, b'q')
# 'exception': the TUI ends by itself.

while time.time() - start < 6 and p.poll() is None:
    output.extend(read_some(master, 0.2))
output.extend(read_some(master, 0.2))

try:
    p.wait(timeout=3)
except subprocess.TimeoutExpired:
    p.kill()
    p.wait(timeout=3)
post_attr = termios.tcgetattr(slave)
os.close(slave)
os.close(master)

print("EXIT=%d" % p.returncode)
print("PRE_CANON=%s" % bool(pre_attr[3] & termios.ICANON))
print("SAME_TTY=%s" % (pre_attr == post_attr))
print("=== SCREEN OUTPUT ===")
print(output.decode('utf-8', errors='replace'))
`

  const nodeBin = process.execPath
  const socket = join(root, 'tmux.sock')
  const tmuxS = (args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>(resolve => {
      const env = { ...process.env }
      delete env.TMUX
      delete env.TMUX_PANE
      execFile('tmux', ['-S', socket, ...args], { encoding: 'utf8', env, timeout: 20_000 }, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          out: stdout ?? '',
          err: stderr ?? '',
        })
      })
    })
  const started = await tmuxS(['new-session', '-d', '-s', 'pty', '-x', '80', '-y', '24'])
  assert.equal(started.code, 0, started.err)
  const scenarios: { name: string; exit: number; preCanon: boolean; screen: RegExp }[] = [
    { name: 'q', exit: 0, preCanon: true, screen: /workers/ },
    { name: 'rq', exit: 0, preCanon: true, screen: /workers/ },
    { name: 'ctrl-c', exit: 0, preCanon: true, screen: /workers/ },
    { name: 'ctrl-c-prompt', exit: 0, preCanon: true, screen: /<session-id>/ },
    { name: 'sigterm', exit: 0, preCanon: true, screen: /workers/ },
    { name: 'exception', exit: 1, preCanon: true, screen: /tui error: Error: PTY_BOMB/ },
    { name: 'preraw', exit: 0, preCanon: false, screen: /workers/ },
  ]
  try {
    for (const sc of scenarios) {
    const res = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      const cp = spawn('python3', ['-c', pythonScript, root, nodeBin, tuiScript, repo, socket, sc.name, bombScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      const timer = setTimeout(() => cp.kill('SIGKILL'), 20_000)
      cp.stdout.on('data', d => {
        out += d
      })
      cp.stderr.on('data', d => {
        err += d
      })
      cp.on('close', code => {
        clearTimeout(timer)
        resolve({ code: code ?? -1, stdout: out, stderr: err })
      })
    })

    assert.equal(res.code, 0, `${sc.name}: python pty harness failed: ${res.stderr}`)
    assert.ok(res.stdout.includes(`EXIT=${sc.exit}\n`), `${sc.name}: exit ${sc.exit}\n${res.stdout}`)
    assert.ok(res.stdout.includes(`PRE_CANON=${sc.preCanon ? 'True' : 'False'}\n`), `${sc.name}: start state`)
    assert.ok(res.stdout.includes('SAME_TTY=True\n'), `${sc.name}: tty flags must equal the start state\n${res.stdout}`)
    assert.match(res.stdout, sc.screen, `${sc.name}: screen`)
    }
  } finally {
    await tmuxS(['kill-server'])
  }
})

function writePermissionWorker(root: string, repo: string, owner: string, name = 'w.abcde'): void {
  const worker = join(root, '.v3', name)
  const now = Date.now() - 60_000
  for (const seq of [1, 2]) {
    const ep = join(worker, 'episodes', String(seq))
    mkdirSync(join(ep, 'sent'), { recursive: true })
    writeFileSync(
      join(ep, 'dispatch.json'),
      JSON.stringify({ seq, since: now, owner, resultPath: join(ep, 'result.json'), origin: 'tell' }),
    )
  }
  mkdirSync(join(worker, 'episodes', '1', 'acks', 'done'), { recursive: true })
  writeFileSync(
    join(worker, 'worker.json'),
    JSON.stringify({ profile: 'codex', name, dir: repo, ownerCwd: repo, owner, since: now, origin: 'assign' }),
  )
}

function treeSnap(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name)
      const rel = full.slice(dir.length)
      const st = statSync(full)
      if (e.isDirectory()) {
        out.set(`${rel}/`, String(st.mtimeMs))
        walk(full)
      } else out.set(rel, `${st.mtimeMs}\n${readFileSync(full)}`)
    }
  }
  walk(dir)
  return out
}

/** First paint, optional keys, quit. `waitWrites` counts stdout.write calls (render + refresh). */
async function framed(opts: {
  host: ReturnType<typeof quietHost>
  root: string
  cwd: string
  session?: string
  keys?: string[]
  mirrorMs?: number
  waitWrites?: number
  waitMs?: number
}): Promise<{ screen: string; writes: number }> {
  class In extends EventEmitter {
    isTTY = true
    setRawMode() {}
    resume() {}
    pause() {}
  }
  class Out extends EventEmitter {
    columns = 180
    rows = 40
    written = ''
    writes = 0
    write(t: string) {
      this.written += t
      this.writes += 1
      return true
    }
  }
  const stdin = new In()
  const stdout = new Out()
  const done = runTui({
    host: opts.host,
    root: opts.root,
    cwd: opts.cwd,
    session: opts.session,
    stdin: stdin as any,
    stdout: stdout as any,
    mirrorMs: opts.mirrorMs ?? 60_000,
  })
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const waitMs = opts.waitMs ?? 3_000
  const start = Date.now()
  while (!stdout.written.includes('workers') && Date.now() - start < waitMs) await sleep(20)
  for (const key of opts.keys ?? []) {
    stdin.emit('data', key)
    await sleep(20)
  }
  if (opts.waitWrites) {
    const again = Date.now()
    while (stdout.writes < opts.waitWrites && Date.now() - again < waitMs) await sleep(20)
  }
  stdin.emit('data', 'q')
  await done
  return { screen: stripAnsi(stdout.written), writes: stdout.writes }
}

test('view probe: permission is needs-input, project is read, health with no session dir is 無收件者', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-view-root-'))
  const repo = mkdtempSync(join(tmpdir(), 'tui-view-repo-'))
  writePermissionWorker(root, repo, 'owner')
  const host = quietHost('owner', repo, root)
  let submits = 0
  host.submit = async () => {
    submits += 1
    return { drop: 'view' }
  }
  host.run = async argv => {
    if (argv[0] === 'agent-tmux') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ exists: true, running: true, blocked_reason: 'permission', idle_seconds: 120 }),
        stderr: '',
      }
    }
    if (argv[0] === 'tmux') {
      return { exitCode: 0, stdout: `proj-a\t${repo}\t${Math.floor(Date.now() / 1000)}\n`, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const { screen } = await framed({ host, root, cwd: repo, session: 'owner' })
  assert.match(screen, /w\.abcde/)
  assert.match(screen, /needs input — permission/)
  assert.match(screen, /proj-a/)
  // C-health: this session never registered (no session dir) → no collector, not `unknown`.
  assert.match(screen, /收件：無收件者/)
  assert.doesNotMatch(screen, /內部 \?/)
  assert.doesNotMatch(screen, /viewer — no session/)
  assert.equal(submits, 0)
  assert.equal(existsSync(join(root, '.v3', 'w.abcde', 'episodes', '2', 'claims')), false)
})

test('viewer: no session shows the owner worker and says viewer', async () => {
  const prev = process.env.TMUX_AGENT_SESSION
  delete process.env.TMUX_AGENT_SESSION
  try {
    const root = mkdtempSync(join(tmpdir(), 'tui-viewer-root-'))
    const repo = mkdtempSync(join(tmpdir(), 'tui-viewer-repo-'))
    writePermissionWorker(root, repo, 'owner')
    const host = quietHost(undefined, repo, root)
    const { screen } = await framed({ host, root, cwd: repo })
    assert.match(screen, /viewer — no session; 唯讀；帶 --session 才能操作 · 收件：無收件者/)
    assert.match(screen, /w\.abcde/)
    assert.doesNotMatch(screen, /No workers outstanding/)
  } finally {
    if (prev === undefined) delete process.env.TMUX_AGENT_SESSION
    else process.env.TMUX_AGENT_SESSION = prev
  }
})

test('resume paste: a pasted session UUID fills the resume field', async () => {
  const uuid = '12345678-1234-1234-1234-123456789abc'
  const base: TuiState = { rows: [], all: [], showAll: false, adding: true, resumeInput: '', quit: false }
  assert.equal(nextKeyState(base, uuid, 1).state.resumeInput, uuid)
  assert.equal(nextKeyState(base, `\x1b[200~${uuid}\x1b[201~`, 1).state.resumeInput, uuid)
  const root = mkdtempSync(join(tmpdir(), 'tui-paste-'))
  const host = quietHost('s', root, root)
  const { screen } = await framed({ host, root, cwd: root, session: 's', keys: ['n', uuid, '\x1b'] })
  assert.match(screen, new RegExp(uuid))
})

test('no-mutation tui: runTui renders, refreshes, and leaves paths, mtimes, and contents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-nomut-run-'))
  const repo = mkdtempSync(join(tmpdir(), 'tui-nomut-run-repo-'))
  const base = nodeHost({ owner: 'dead-owner', cwd: repo })
  base.envTmuxAgentDir = async () => root
  const outside = new Set(['git', 'sh', 'tmux', 'agent-tmux'])
  const deadHost = {
    ...base,
    run: async (argv: readonly string[], cwd: string, ms: number) => {
      if (outside.has(argv[0]!)) return { exitCode: 0, stdout: '', stderr: '' }
      return base.run(argv, cwd, ms)
    },
  }
  const assigned = await assignWorker(
    deadHost,
    { profile: 'claude', name: 'orphan-w', dir: repo, brief: 'GOAL: orphan\nACCEPTANCE: none\nREPORT: one line\n' },
    { owner: 'dead-owner', ownerCwd: repo },
  )
  if ('deny' in assigned) assert.fail(assigned.deny)
  const before = treeSnap(root)
  const host = quietHost('tui-viewer', repo, root)
  const statusArgv: string[][] = []
  const run = host.run
  host.run = async (argv, cwd, ms) => {
    if (argv[0] === 'agent-tmux' && argv.includes('status')) statusArgv.push([...argv])
    return run(argv, cwd, ms)
  }
  const { screen, writes } = await framed({ host, root, cwd: repo, session: 'tui-viewer', mirrorMs: 30, waitWrites: 2 })
  assert.ok(writes >= 2, `expected a first render and a refresh, writes=${writes}`)
  assert.ok(statusArgv.some(argv => argv.includes('--no-write')), `status argv missing --no-write: ${JSON.stringify(statusArgv)}`)
  assert.match(screen, /workers/)
  const after = treeSnap(root)
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort())
  for (const [path, body] of before) assert.equal(after.get(path), body, `mutated ${path}`)
})

function realTmuxBin(): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, 'tmux')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('tmux is not on PATH')
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

test('no-mutation tui: a live pane status leaves paths, mtimes, and contents', { timeout: 60_000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'tui-nomut-live-'))
  const root = join(parent, 'state')
  const repo = join(parent, 'repo')
  const socket = join(parent, 'tmux.sock')
  const bin = join(parent, 'bin')
  mkdirSync(root)
  mkdirSync(repo)
  mkdirSync(bin)
  const real = realTmuxBin()
  // ponytail: agent-tmux unsets TMUX and execs `tmux` with no -S. This PATH shim
  // is the private socket. Upgrade: pass -S from the wrapper, then delete the shim.
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec ${shQuote(real)} -S ${shQuote(socket)} "$@"\n`)
  chmodSync(join(bin, 'tmux'), 0o755)
  const name = 'wabcde'
  writePermissionWorker(root, repo, 'owner', name)
  const session = `codex-cli-${name}`
  const agentTmux = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent-tmux')
  const tmuxS = (args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>(resolve => {
      const env = { ...process.env }
      delete env.TMUX
      delete env.TMUX_PANE
      execFile(real, ['-S', socket, ...args], { encoding: 'utf8', env, timeout: 20_000 }, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          out: stdout ?? '',
          err: stderr ?? '',
        })
      })
    })
  const started = await tmuxS(['new-session', '-d', '-s', session, '-c', repo, '-x', '80', '-y', '24'])
  assert.equal(started.code, 0, `${started.err}\n${started.out}`)
  let liveStatus = ''
  try {
    const base = nodeHost({ owner: 'owner', cwd: repo })
    const host = {
      ...base,
      envTmuxAgentDir: async () => root,
      run: async (argv: readonly string[], cwd?: string, timeoutMs?: number) => {
        const call = await wrapperCall(host, argv)
        const cmd = [...call.argv]
        // zsh scripts read /etc/zshenv, which rebuilds PATH and hides the shim.
        // Replace the wrapper's run prefix (`zsh <path>`) with this checkout's agent-tmux.
        if (argv[0] === 'agent-tmux') cmd.splice(0, cmd.length - (argv.length - 1), '/bin/zsh', '-f', agentTmux)
        if ((cmd[0] === 'tmux' || cmd[0] === real) && cmd[1] !== '-S' && cmd[1] !== '-L') cmd.splice(1, 0, '-S', socket)
        const env: NodeJS.ProcessEnv = { ...process.env, ...call.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }
        delete env.TMUX
        delete env.TMUX_PANE
        const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(resolve => {
          // The sweep hands status a 3s cap. A full contract run can spend that
          // on startup and kill the probe before it answers, so this check
          // would not see the live pane. The write happens only if status
          // finishes; give it room.
          execFile(cmd[0]!, cmd.slice(1), { cwd, timeout: Math.max(timeoutMs ?? 0, 15_000), encoding: 'utf8', env }, (error, stdout, stderr) => {
            const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
            resolve({
              exitCode: code,
              stdout: stdout ?? '',
              stderr: stderr || (error && typeof error.code !== 'number' ? String(error) : ''),
            })
          })
        })
        if (argv[0] === 'agent-tmux' && argv[2] === 'status') liveStatus = `${result.stdout}\n${result.stderr}`
        return result
      },
    }
    const before = treeSnap(root)
    const { screen, writes } = await framed({
      host,
      root,
      cwd: repo,
      session: 'owner',
      mirrorMs: 40,
      waitWrites: 2,
      waitMs: 20_000,
    })
    assert.ok(writes >= 2, `expected a first render and a refresh, writes=${writes}\n${screen}`)
    assert.match(screen, new RegExp(name))
    assert.match(liveStatus, /"exists":\s*true/, liveStatus)
    const after = treeSnap(root)
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort())
    for (const [path, body] of before) assert.equal(after.get(path), body, `mutated ${path}`)
  } finally {
    await tmuxS(['kill-server'])
    rmSync(parent, { recursive: true, force: true })
  }
})

// -----------------------------------------------------------------------------
// 8. R4: health, layout, detail, viewer, key hints, cancel/unlock, empty states
// -----------------------------------------------------------------------------

/** One open episode with an optional result. Owner = the session that shows it. */
function writeWorker(
  root: string,
  repo: string,
  owner: string,
  name: string,
  result?: { status: string; summary: string; episode?: number },
): string {
  const worker = join(root, '.v3', name)
  const ep = join(worker, 'episodes', '1')
  const since = Date.now() - 60_000
  mkdirSync(join(ep, 'sent'), { recursive: true })
  writeFileSync(join(ep, 'dispatch.json'), JSON.stringify({ seq: 1, since, owner, resultPath: join(ep, 'result.json'), origin: 'assign' }))
  writeFileSync(join(worker, 'worker.json'), JSON.stringify({ profile: 'codex', name, dir: repo, ownerCwd: repo, owner, since, origin: 'assign' }))
  if (result) writeFileSync(join(ep, 'result.json'), JSON.stringify({ schema_version: 1, episode: 1, ...result }))
  return ep
}

/** `act/<n>` of session `S` under `root`, as a collector leaves it. Returns the act dir. */
function writeAct(
  root: string,
  n: number,
  opts: { token?: string; beatAgoMs?: number; state?: Record<string, unknown> | string; record?: string | false } = {},
): string {
  const act = join(sessionDirOf(v3Of(root), 'S'), 'act')
  mkdirSync(join(act, String(n)), { recursive: true })
  const token = opts.token ?? `tok${n}`
  if (opts.record !== false) writeFileSync(join(act, `${n}.json`), opts.record ?? JSON.stringify({ pid: 0, pidStart: '', host: '', token }))
  if (opts.state !== undefined) {
    writeFileSync(join(act, `${n}.state`), typeof opts.state === 'string' ? opts.state : JSON.stringify({ token, updatedAt: 1, ...opts.state }))
  }
  if (opts.beatAgoMs !== undefined) {
    const beat = join(act, `${n}.beat`)
    writeFileSync(beat, '1')
    const t = (Date.now() - opts.beatAgoMs) / 1000
    utimesSync(beat, t, t)
  }
  return act
}

const fsHost = (root: string) => quietHost('S', root, root)

/** treeSnap, but a file this test made unreadable is compared by mtime alone. */
function snapOrStat(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name)
      const st = statSync(full)
      if (e.isDirectory()) {
        out.set(`${full.slice(dir.length)}/`, String(st.mtimeMs))
        walk(full)
        continue
      }
      let body = ''
      try {
        body = readFileSync(full, 'utf8')
      } catch {}
      out.set(full.slice(dir.length), `${st.mtimeMs}\n${body}`)
    }
  }
  walk(dir)
  return out
}

test('health: C-health fixtures, each with its hard-coded state', async () => {
  const cases: { name: string; build: (root: string) => void; want: Health; text: string }[] = [
    { name: 'no session dir', build: () => {}, want: { kind: 'none' }, text: '收件：無收件者' },
    {
      name: 'session dir, no activation',
      build: root => mkdirSync(join(sessionDirOf(v3Of(root), 'S'), 'act'), { recursive: true }),
      want: { kind: 'none' },
      text: '收件：無收件者',
    },
    {
      name: 'mod collecting, fresh beat',
      build: root => writeAct(root, 1, { beatAgoMs: 1_000, state: { channel: 'mod', mode: 'auto', status: 'collecting' } }),
      want: { kind: 'collecting', channel: 'mod', mode: 'auto' },
      text: '收件：collecting（mod）',
    },
    {
      name: 'node collecting, fresh beat',
      build: root => writeAct(root, 1, { beatAgoMs: 1_000, state: { channel: 'node', mode: 'auto', status: 'collecting' } }),
      want: { kind: 'collecting', channel: 'node', mode: 'auto' },
      text: '收件：collecting（node）',
    },
    {
      name: 'mcp on-request, fresh beat',
      build: root => writeAct(root, 1, { beatAgoMs: 1_000, state: { channel: 'mcp', mode: 'on-request', status: 'collecting' } }),
      want: { kind: 'collecting', channel: 'mcp', mode: 'on-request' },
      text: '收件：MCP：host 呼叫 tool 時才收',
    },
    {
      name: 'paused 120s ago: paused, not stale (a paused collector stops beating)',
      build: root => writeAct(root, 1, { beatAgoMs: 120_000, state: { channel: 'node', mode: 'auto', status: 'paused', reason: 'collector paused after 3 delivery refusals' } }),
      want: { kind: 'paused', channel: 'node', reason: 'collector paused after 3 delivery refusals' },
      text: '收件：paused（collector paused after 3 delivery refusals）',
    },
    {
      name: 'collecting state, beat 200s old',
      build: root => writeAct(root, 1, { beatAgoMs: 200_000, state: { channel: 'mod', mode: 'auto', status: 'collecting' } }),
      want: { kind: 'stale', ageS: 200 },
      text: '收件：stale（beat 200s 前）',
    },
    {
      name: 'max n just registered (no record, no beat) while n=1 collects: initializing, no look back',
      build: root => {
        writeAct(root, 1, { beatAgoMs: 1_000, state: { channel: 'mod', mode: 'auto', status: 'collecting' } })
        writeAct(root, 2, { record: false })
      },
      want: { kind: 'initializing' },
      text: '收件：initializing',
    },
    {
      name: 'old n writes late (paused) after n=2 collects: only max n counts',
      build: root => {
        writeAct(root, 2, { beatAgoMs: 1_000, state: { channel: 'mod', mode: 'auto', status: 'collecting' } })
        writeAct(root, 1, { beatAgoMs: 0, state: { channel: 'mod', mode: 'auto', status: 'paused', reason: 'superseded' } })
      },
      want: { kind: 'collecting', channel: 'mod', mode: 'auto' },
      text: '收件：collecting（mod）',
    },
    {
      name: 'half-written state',
      build: root => writeAct(root, 1, { beatAgoMs: 1_000, state: '{"token":"tok1","chan' }),
      want: { kind: 'unknown', reason: 'act/1 is not valid JSON (half-written?)' },
      text: '收件：unknown（act/1 is not valid JSON (half-written?)）',
    },
    {
      name: 'state of another registration (token mismatch)',
      build: root => writeAct(root, 1, { beatAgoMs: 1_000, state: { token: 'other', channel: 'mod', mode: 'auto', status: 'collecting' } }),
      want: { kind: 'unknown', reason: 'act/1.state token does not match its registration' },
      text: '收件：unknown（act/1.state token does not match its registration）',
    },
    {
      name: 'beats but no state (a collector from before R4)',
      build: root => writeAct(root, 1, { beatAgoMs: 1_000 }),
      want: { kind: 'unknown', reason: 'act/1 beats but has no state (a collector older than this TUI?)' },
      text: '收件：unknown（act/1 beats but has no state (a collector older than this TUI?)）',
    },
    {
      name: 'EACCES on the state file',
      build: root => {
        const act = writeAct(root, 1, { beatAgoMs: 1_000, state: { channel: 'mod', mode: 'auto', status: 'collecting' } })
        chmodSync(join(act, '1.state'), 0o000)
      },
      want: { kind: 'unknown', reason: 'act/1 could not be read' },
      text: '收件：unknown（act/1 could not be read）',
    },
  ]
  for (const c of cases) {
    const root = mkdtempSync(join(tmpdir(), 'tui-health-'))
    c.build(root)
    const before = snapOrStat(root)
    const got = await readActHealth(fsHost(root), v3Of(root), 'S', Date.now())
    assert.deepEqual(got, c.want, c.name)
    assert.equal(healthText(got), c.text, c.name)
    // The TUI only reads: paths, mtimes and contents are unchanged.
    const after = snapOrStat(root)
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), c.name)
    for (const [path, body] of before) assert.equal(after.get(path), body, `${c.name}: mutated ${path}`)
  }
  assert.equal(healthText(undefined), '收件：unknown（尚未讀取）')
  assert.equal(healthText({ kind: 'stale' }), '收件：stale（從未 beat）')
})

test('health: max n changing while read is read again; changing every time is unknown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-health-race-'))
  writeAct(root, 1, { beatAgoMs: 1_000, state: { channel: 'mod', mode: 'auto', status: 'collecting' } })
  writeAct(root, 2, { beatAgoMs: 1_000, state: { channel: 'node', mode: 'auto', status: 'collecting' } })
  const act = join(sessionDirOf(v3Of(root), 'S'), 'act')
  // A list of act/ that grows by one on each read: the first read sees n=1 only.
  const grow = (always: boolean) => {
    const host = fsHost(root)
    const list = host.list
    let calls = 0
    host.list = async path => {
      const real = await list(path)
      if (path !== act) return real
      calls += 1
      if (!always && calls > 1) return real
      const keep = String(Math.min(calls, 2))
      const extra = always ? [{ name: String(calls + 2), kind: 'dir' }] : []
      return [...real.filter(e => !/^\d+$/.test(e.name) || e.name <= keep), ...extra]
    }
    return host
  }
  assert.deepEqual(await readActHealth(grow(false), v3Of(root), 'S', Date.now()), { kind: 'collecting', channel: 'node', mode: 'auto' })
  assert.deepEqual(await readActHealth(grow(true), v3Of(root), 'S', Date.now()), { kind: 'unknown', reason: 'registrations kept changing (變動中)' })
})

test('health writer: heartbeat publishes act/<n>.state for its channel, once per change; a pause rewrites it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-health-writer-'))
  const base = nodeHost({ owner: 'S', cwd: root })
  base.envTmuxAgentDir = async () => root
  const mvs: string[] = []
  const host = {
    ...base,
    run: async (argv: readonly string[], cwd: string, ms: number) => {
      if (argv[0] === 'mv') mvs.push(String(argv[2]))
      return base.run(argv, cwd, ms)
    },
  }
  for (const [channel, want] of [
    [undefined, { kind: 'collecting', channel: 'mod', mode: 'auto' }],
    ['node', { kind: 'collecting', channel: 'node', mode: 'auto' }],
    ['mcp', { kind: 'collecting', channel: 'mcp', mode: 'on-request' }],
  ] as const) {
    // One session has one channel (S3): drop the previous channel's record, as a handover would.
    rmSync(join(sessionDirOf(v3Of(root), 'S'), 'channel'), { force: true })
    const gate = newGate()
    if (channel) gate.channel = channel
    assert.equal(await heartbeat(host, gate), true)
    assert.deepEqual(await readActHealth(host, v3Of(root), 'S', Date.now()), want)
    const state = JSON.parse(readFileSync(join(sessionDirOf(v3Of(root), 'S'), 'act', `${gate.activation}.state`), 'utf8'))
    assert.equal(state.token, gate.token)
    assert.equal(state.status, 'collecting')
    const n = mvs.length
    assert.equal(await heartbeat(host, gate), true)
    assert.equal(mvs.length, n, 'an unchanged state is not published again')
    gate.paused = 'collector paused after 3 delivery refusals (refused: busy) — restart this session to resume'
    await writeActState(host, gate)
    assert.equal(mvs.length, n + 1)
    assert.deepEqual(await readActHealth(host, v3Of(root), 'S', Date.now()), {
      kind: 'paused',
      channel: channel ?? 'mod',
      reason: 'collector paused after 3 delivery refusals (refused: busy) — restart this session to resume',
    })
  }
  // No tmp file is left beside the states.
  const act = readdirSync(join(sessionDirOf(v3Of(root), 'S'), 'act'))
  assert.deepEqual(act.filter(f => !/^\d+(\.json|\.beat|\.state)?$/.test(f)), [])
})

test('layout: one function sizes every section; hard-coded fixtures (R4.1, R4.2)', () => {
  // [height, input] → expected. The sum of the sections never exceeds the height.
  const fixtures: [number, Parameters<typeof layoutOf>[1], ReturnType<typeof layoutOf>][] = [
    [24, { status: 1, rows: 3, sel: 2, selExtra: 2, footer: 1 }, { status: 1, first: 0, list: 3, hidden: 0, more: 0, selExtra: 2, body: 14, footer: 1 }],
    [24, { status: 1, rows: 1, sel: 0, selExtra: 1, footer: 0 }, { status: 1, first: 0, list: 1, hidden: 0, more: 0, selExtra: 1, body: 18, footer: 0 }],
    [60, { status: 1, rows: 1, sel: 0, selExtra: 1, footer: 0 }, { status: 1, first: 0, list: 1, hidden: 0, more: 0, selExtra: 1, body: 54, footer: 0 }],
    [60, { status: 1, rows: 3, sel: 0, selExtra: 2, footer: 1 }, { status: 1, first: 0, list: 3, hidden: 0, more: 0, selExtra: 2, body: 50, footer: 1 }],
    [10, { status: 1, rows: 5, sel: 4, selExtra: 2, footer: 0 }, { status: 1, first: 0, list: 5, hidden: 0, more: 0, selExtra: 2, body: 0, footer: 0 }],
    [10, { status: 1, rows: 9, sel: 8, selExtra: 2, footer: 1 }, { status: 1, first: 5, list: 4, hidden: 5, more: 1, selExtra: 2, body: 0, footer: 1 }],
    [10, { status: 1, rows: 1, sel: 0, selExtra: 2, footer: 0 }, { status: 1, first: 0, list: 1, hidden: 0, more: 0, selExtra: 2, body: 3, footer: 0 }],
    [3, { status: 1, rows: 4, sel: 3, selExtra: 2, footer: 1 }, { status: 1, first: 3, list: 1, hidden: 3, more: 0, selExtra: 0, body: 0, footer: 0 }],
    [5, { status: 2, rows: 0, sel: -1, selExtra: 0, footer: 3 }, { status: 2, first: 0, list: 0, hidden: 0, more: 0, selExtra: 0, body: 0, footer: 2 }],
  ]
  for (const [height, input, want] of fixtures) {
    const got = layoutOf(height, input)
    assert.deepEqual(got, want, `height ${height} ${JSON.stringify(input)}`)
    const used = 1 + got.status + got.list + got.selExtra + (got.body ? got.body + 2 : 0) + got.more + got.footer
    assert.ok(used <= height, `height ${height}: ${used} lines`)
  }
})

test('mirror: capture asks for the layout body; a resize drops the capture started before it (R4.1, R4.2)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-mirror-'))
  const repo = mkdtempSync(join(tmpdir(), 'tui-mirror-repo-'))
  writeWorker(root, repo, 'S', 'mir.abcde')
  const host = quietHost('S', repo, root)
  const tails: string[] = []
  let hold: (() => void) | undefined
  host.run = async argv => {
    if (argv[0] === 'agent-tmux' && argv.includes('capture')) {
      tails.push(argv[argv.indexOf('--tail') + 1]!)
      if (tails.length === 1) {
        await new Promise<void>(r => (hold = r))
        return { exitCode: 0, stdout: 'STALE-80x24\n', stderr: '' }
      }
      return { exitCode: 0, stdout: 'FRESH-120x60\n', stderr: '' }
    }
    if (argv[0] === 'agent-tmux' && argv.includes('status')) return { exitCode: 0, stdout: '{"exists":true,"running":true}', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const { stdin, stdout } = mockTty()
  const run = runTui({ stdin, stdout, host, session: 'S', cwd: repo, root, mirrorMs: 30 })
  try {
    await until(() => stdout.written.includes('mir.abcde'), 5_000, 'the row')
    stdin.emit('data', 'j')
    await until(() => tails.length === 1 && !!hold, 5_000, 'the first capture')
    assert.equal(tails[0], '18', '80x24, one selected row: 18 mirror rows')
    stdout.columns = 120
    stdout.rows = 60
    stdout.emit('resize')
    hold!()
    await until(() => stdout.written.includes('FRESH-120x60'), 5_000, 'the capture at the new size')
    assert.equal(tails.at(-1), '54', '120x60: 54 mirror rows')
    assert.ok(!stdout.written.includes('STALE-80x24'), 'a capture sized before the resize is never drawn')
  } finally {
    stdin.emit('data', 'q')
    await run
  }
})

test('detail: the whole result, past SUMMARY_MAX, with row and result state apart; PgDn reaches the end (R4.3)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-detail-'))
  const repo = mkdtempSync(join(tmpdir(), 'tui-detail-repo-'))
  const long = `開始${'中文摘要'.repeat(3_000)}END-MARKER`
  const ep = writeWorker(root, repo, 'S', 'det.abcde', { status: 'success', summary: long })
  const host = quietHost('S', repo, root)
  const d = { profile: 'codex', name: 'det.abcde', dir: repo, since: 1, seq: 1, resultPath: join(ep, 'result.json') }
  const det = await episodeDetail(host, d)
  assert.equal(det.kind, 'result')
  assert.equal(det.kind === 'result' && det.summary?.length, 12_012, 'not cut at SUMMARY_MAX (12000)')
  assert.equal(det.kind === 'result' && det.status, 'success')
  assert.equal(det.kind === 'result' && det.otherEpisode, false)
  const row = { ...mockRow('det', { state: 'finished' }), d }
  const lines = detailText(row, det)
  assert.equal(lines[0], 'row: finished · codex det.abcde · episode 1')
  assert.equal(lines[1], `result: success · ${join(ep, 'result.json')}`)
  assert.equal(lines[2], 'summary:')
  assert.ok(lines[3]!.endsWith('END-MARKER'))
  // Other kinds, hard-coded.
  assert.deepEqual(await episodeDetail(host, { ...d, resultPath: join(ep, 'none.json') }), { kind: 'no-result', resultPath: join(ep, 'none.json') })
  assert.deepEqual(await episodeDetail(host, { profile: 'codex', name: 'r', dir: repo, since: 1 }), { kind: 'no-episode' })
  writeFileSync(join(ep, 'bad.json'), '[1')
  assert.deepEqual(await episodeDetail(host, { ...d, resultPath: join(ep, 'bad.json') }), {
    kind: 'error',
    resultPath: join(ep, 'bad.json'),
    reason: 'result.json is not a JSON object',
  })
  writeFileSync(join(ep, 'locked.json'), '{}')
  chmodSync(join(ep, 'locked.json'), 0o000)
  assert.deepEqual(await episodeDetail(host, { ...d, resultPath: join(ep, 'locked.json') }), {
    kind: 'error',
    resultPath: join(ep, 'locked.json'),
    reason: 'result.json could not be read (see the log)',
  })
  writeFileSync(join(ep, 'other.json'), JSON.stringify({ status: 'failed', summary: 's', episode: 7, blocked_reason: 'quota' }))
  assert.deepEqual(detailText({ ...mockRow('o', { state: 'running' }), d }, await episodeDetail(host, { ...d, resultPath: join(ep, 'other.json') })), [
    'row: running · codex det.abcde · episode 1',
    `result: failed (names another episode) · ${join(ep, 'other.json')}`,
    'blocked: quota',
    'summary:',
    's',
  ])
  assert.deepEqual(detailText(mockRow('p', { project: true }), { kind: 'project' }), ['project session p: not a ledger worker; no episode, no result'])

  // Through runTui: Enter expands, PgDn pages to the end, Enter collapses.
  const { stdin, stdout } = mockTty()
  const run = runTui({ stdin, stdout, host, session: 'S', cwd: repo, root, mirrorMs: 60_000 })
  try {
    await until(() => stdout.written.includes('det.abcde'), 5_000, 'the row')
    stdin.emit('data', 'j')
    stdin.emit('data', '\r')
    await until(() => stdout.written.includes('detail 1–'), 5_000, 'the detail view')
    const total = Number(/detail 1–\d+ of (\d+)/.exec(stripAnsi(stdout.written))![1])
    assert.ok(total > 300, `a long summary wraps to many lines: ${total}`)
    for (let i = 0; i < Math.ceil(total / 10) && !stripAnsi(stdout.written.slice(stdout.written.lastIndexOf(ANSI_CLEAR_HOME))).includes('END-MARKER'); i++) {
      stdin.emit('data', PAGE_DOWN)
      await new Promise(r => setTimeout(r, 2))
    }
    await until(() => stripAnsi(stdout.written.slice(stdout.written.lastIndexOf(ANSI_CLEAR_HOME))).includes('END-MARKER'), 5_000, 'the end of the summary')
    const last = stripAnsi(stdout.written.slice(stdout.written.lastIndexOf(ANSI_CLEAR_HOME)))
    assert.match(last, new RegExp(`detail \\d+–${total} of ${total}`))
    stdin.emit('data', PAGE_UP)
    stdin.emit('data', '\r')
    await until(() => !stripAnsi(stdout.written.slice(stdout.written.lastIndexOf(ANSI_CLEAR_HOME))).includes('detail '), 5_000, 'collapse')
  } finally {
    stdin.emit('data', 'q')
    await run
  }
})

test('wrap: CJK and emoji wrap by cells and never split a grapheme', () => {
  assert.deepEqual(wrapCells('中文字ab👨‍👩‍👧c', 4), ['中文', '字ab', '👨‍👩‍👧c'])
  assert.deepEqual(wrapCells('x\x1b]0;t\x07y\nz', 5), ['xy', 'z'])
  assert.deepEqual(wrapCells('中', 1), [''])
})

/** A state with one running worker that has an episode, selected; owner mode. */
function ownerState(): TuiState {
  const r = mockRow('w1', { state: 'running', d: { profile: 'codex', name: 'w1', dir: '/tmp/r', since: 1 } })
  r.d.seq = 1
  return { rows: [r], all: [r], showAll: false, selected: 'w1', adding: false, resumeInput: '', quit: false, owner: 'S' }
}

test('viewer: every mutating key is read-only in the key layer (D-viewer)', () => {
  const s = { ...ownerState(), viewer: true }
  assert.deepEqual([...MUTATING_KEYS].sort(), ['+', '-', 'C', 'I', 'N', 'T', 'U', 'X', 'c', 'i', 'n', 't', 'x'])
  for (const key of MUTATING_KEYS) {
    for (const now of [1_000, 1_000 + STOP_REPEAT_MS + 1]) {
      const r = nextKeyState(s, key, now)
      assert.equal(r.action, undefined, `viewer ${key}`)
      assert.equal(r.state.adding, false, `viewer ${key}`)
      assert.equal(r.state.armedStop, undefined, `viewer ${key}`)
      assert.equal(r.state.statusMessage, READ_ONLY, `viewer ${key}`)
    }
  }
  // Reading still works.
  assert.equal(nextKeyState(s, '\r', 1).action?.type, 'detail')
  assert.equal(nextKeyState(s, 'r', 1).action?.type, 'refresh')
})

test('viewer: x, -, U, t, c over a real ledger change nothing on disk and run nothing that writes (D-viewer)', async () => {
  const prev = process.env.TMUX_AGENT_SESSION
  delete process.env.TMUX_AGENT_SESSION
  try {
    const root = mkdtempSync(join(tmpdir(), 'tui-viewer-ro-'))
    const repo = mkdtempSync(join(tmpdir(), 'tui-viewer-ro-repo-'))
    writeWorker(root, repo, 'owner', 'ro.abcde', { status: 'success', summary: '完成' })
    const host = quietHost(undefined, repo, root)
    const ran: string[] = []
    host.run = async argv => {
      ran.push(argv.join(' '))
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const before = treeSnap(root)
    const keys = ['j', 'x', 'x', '-', '-', 'U', 'U', 't', 'hello\r', 'c', 'c', '+', 'n']
    const { screen } = await framed({ host, root, cwd: repo, keys })
    assert.match(screen, /ro\.abcde/)
    assert.match(screen, new RegExp(READ_ONLY))
    const after = treeSnap(root)
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort())
    for (const [path, body] of before) assert.equal(after.get(path), body, `mutated ${path}`)
    assert.deepEqual(ran.filter(c => /\b(stop|send|kill|interrupt|mkdir|mv|ln|rm)\b/.test(c)), [], ran.join('\n'))
  } finally {
    if (prev === undefined) delete process.env.TMUX_AGENT_SESSION
    else process.env.TMUX_AGENT_SESSION = prev
  }
})

test('hints: every key the header and the row show has a handler; no /workers command text (R4.6)', () => {
  const owner = ownerState()
  const viewer = { ...owner, viewer: true }
  for (const s of [owner, viewer, { ...owner, selected: undefined }]) {
    const screen = renderTuiLines(s, 200, 30, 1_000).map(stripAnsi).join('\n')
    const keys = new Set([...screen.matchAll(/\[ (\S+) /g)].map(m => m[1]!))
    if (/a all · j\/k select/.test(screen)) for (const k of ['a', 'j', 'k']) keys.add(k)
    if (/Enter (detail|mirror)/.test(screen)) keys.add('\r')
    assert.ok(keys.size >= (s.viewer ? 2 : 5), `${[...keys]}\n${screen}`)
    for (const key of keys) {
      const r = nextKeyState(s, key, 1_000)
      const handled = r.action !== undefined || JSON.stringify(r.state) !== JSON.stringify(s)
      assert.ok(handled, `key ${JSON.stringify(key)} is shown but does nothing\n${screen}`)
    }
  }
  const header = stripAnsi(renderTuiLines(owner, 200, 30, 1_000)[0]!)
  assert.match(header, /\[ n resume \] \[ \+ assign \] \[ r refresh \] \[ c clear \] \[ q quit \]  a all · j\/k select/)
  const row = renderTuiLines(owner, 200, 30, 1_000).map(stripAnsi).find(l => l.includes('[ t tell ]'))!
  assert.match(row, /\[ t tell \] \[ i interrupt \] \[ x stop \] \[ - cancel \] \[ U unlock \]  Enter detail/)
  // Narrow: hints shorten in order (words, then keys only), never past the width.
  assert.match(stripAnsi(renderTuiLines(owner, 60, 30, 1_000)[0]!), /\[ n \] \[ \+ \] \[ r \] \[ c \] \[ q \]/)
  // No `/workers …` command anywhere in the TUI source (the import path is not one).
  const src = readFileSync(join(import.meta.dirname, 'tui.node.ts'), 'utf8')
  assert.deepEqual(src.split('\n').filter(l => /\/workers(?!\.ts')/.test(l)), [])
})

test('resume: the Outcome names the TUI key, not a /workers command (D-new)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-resume-'))
  const repo = mkdtempSync(join(tmpdir(), 'tui-resume-repo-'))
  const base = nodeHost({ owner: 'S', cwd: repo })
  base.envTmuxAgentDir = async () => root
  base.envHome = async () => root
  const host = {
    ...base,
    run: async (argv: readonly string[], cwd: string, ms: number) =>
      argv[0] === 'agent-tmux' ? { exitCode: 0, stdout: '', stderr: '' } : base.run(argv, cwd, ms),
  }
  const out = await resumeWorker(host, 'codex 12345678-1234-1234-1234-123456789abc')
  assert.equal(out.ok, true, out.text)
  assert.doesNotMatch(out.text, /\/workers/)
  assert.match(out.text, /in the TUI select "codex-12345678\.[0-9a-z]{5}" and press t \(tell\)\.$/)
})

test('key-state: t and + open their input lines; Enter sends tell or assign (D-new)', () => {
  const s = ownerState()
  const t = nextKeyState(s, 't', 1).state
  assert.equal(t.adding, true)
  assert.equal(t.inputKind, 'tell')
  assert.equal(t.inputFor, 'w1')
  const typed = nextKeyState({ ...t, resumeInput: ' go on ' }, '\r', 1)
  assert.deepEqual(typed.action, { type: 'tell', row: s.rows[0], text: 'go on' })
  assert.equal(typed.state.adding, false)
  const plus = nextKeyState(s, '+', 1).state
  assert.equal(plus.inputKind, 'assign')
  assert.deepEqual(nextKeyState({ ...plus, resumeInput: 'codex rev /tmp/brief.md' }, '\r', 1).action, { type: 'assign', value: 'codex rev /tmp/brief.md' })
  assert.equal(nextKeyState({ ...s, selected: undefined }, 't', 1).state.adding, false)
  const screen = renderTuiLines(t, 120, 20, 1).map(stripAnsi).join('\n')
  assert.match(screen, /t tell w1: █/)
})

test('key-state: - and U confirm by a second press and act on the selected row (C-cancel)', () => {
  const s = ownerState()
  const row = s.rows[0]!
  for (const [key, type, id] of [
    ['-', 'cancel', 'cancel:w1'],
    ['U', 'unlock', 'unlock:w1'],
  ] as const) {
    const one = nextKeyState(s, key, 1_000)
    assert.equal(one.action, undefined)
    assert.deepEqual(one.state.armedStop, { id, from: 1_000, until: 1_000 + STOP_CONFIRM_MS })
    assert.equal(nextKeyState(one.state, key, 1_100).action, undefined, 'a fast second press only debounces')
    assert.deepEqual(nextKeyState(one.state, key, 1_000 + STOP_REPEAT_MS).action, { type, row })
    assert.equal(nextKeyState(one.state, key, 1_000 + STOP_CONFIRM_MS + 1).action, undefined, 'an expired arm re-arms')
    assert.equal(nextKeyState(one.state, '\x1b', 1_200).state.armedStop, undefined)
  }
  const noEp = { ...s, rows: [{ ...row, d: { ...row.d, seq: 0 } }] }
  const r = nextKeyState(noEp, '-', 1)
  assert.equal(r.action, undefined)
  assert.equal(r.state.statusMessage, 'cancel — "w1" has no episode yet')
})

test('cancel and unlock: the TUI keys run the same core calls as workers.cli.node.ts (C-cancel)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-cancel-'))
  const repo = mkdtempSync(join(tmpdir(), 'tui-cancel-repo-'))
  const base = nodeHost({ owner: 'S', cwd: repo })
  base.envTmuxAgentDir = async () => root
  const outside = new Set(['git', 'sh', 'tmux', 'agent-tmux'])
  const host = {
    ...base,
    run: async (argv: readonly string[], cwd: string, ms: number) =>
      outside.has(argv[0]!) ? { exitCode: 0, stdout: '', stderr: '' } : base.run(argv, cwd, ms),
  }
  const r = await assignWorker(
    host,
    { profile: 'claude', name: 'can', dir: repo, brief: 'GOAL: g\nACCEPTANCE: a\nREPORT: r\n' },
    { owner: 'S', ownerCwd: repo },
  )
  if ('deny' in r) assert.fail(r.deny)
  const pause = (ms: number) => new Promise(res => setTimeout(res, ms))
  const { stdin, stdout } = mockTty()
  stdout.columns = 200
  const run = runTui({ stdin, stdout, host, session: 'S', cwd: repo, root, mirrorMs: 60_000 })
  const shown = () => stripAnsi(stdout.written)
  try {
    await until(() => shown().includes(r.name), 5_000, 'the row')
    stdin.emit('data', 'j')
    stdin.emit('data', 'U')
    await pause(STOP_REPEAT_MS + 50)
    stdin.emit('data', 'U')
    await until(() => shown().includes(`unlock ${r.name} — ok: "${r.name}" is not locked`), 5_000, 'unlockWorker text')
    stdin.emit('data', '-')
    await until(() => shown().includes('cancel episode 1? press again'), 5_000, 'the arm')
    await pause(STOP_REPEAT_MS + 50)
    stdin.emit('data', '-')
    await until(
      () => shown().includes(`cancelled episode 1 of "${r.name}"; its pane is untouched, and nothing more is delivered for that episode`),
      5_000,
      'cancelEpisode text',
    )
    assert.ok(existsSync(join(r.stateDir, 'episodes', '1', 'acks', 'cancel')), 'acks/cancel written by the core')
  } finally {
    stdin.emit('data', 'q')
    await run
  }
})

test('empty states: none outstanding, filtered out, read failure — hard-coded (R4.7)', async () => {
  const base: TuiState = { rows: [], all: [], showAll: false, adding: false, resumeInput: '', quit: false }
  assert.equal(emptyText(base), 'No workers outstanding.')
  const theirs = mockRow('t1', { holder: 'deadbeef' })
  assert.equal(emptyText({ ...base, all: [theirs] }), 'No rows shown: 1 worker(s) of other sessions are filtered out — press a to show all')
  assert.equal(emptyText({ ...base, all: [theirs], loadError: 'EACCES' }), 'Could not read the ledger: EACCES')
  const shownAll = nextKeyState({ ...base, all: [theirs] }, 'a', 1).state
  assert.equal(shownAll.rows.length, 1, 'a shows the filtered rows')

  // Read failure through runTui: an unreadable .v3 is an incomplete scan with its errno.
  const root = mkdtempSync(join(tmpdir(), 'tui-empty-'))
  mkdirSync(join(root, '.v3'))
  chmodSync(join(root, '.v3'), 0o000)
  try {
    const { screen } = await framed({ host: quietHost('S', root, root), root, cwd: root, session: 'S' })
    assert.match(screen, /Could not read the ledger: EACCES/)
  } finally {
    chmodSync(join(root, '.v3'), 0o755)
  }
})

test('pty sizes: 120x60, 80x24, 40x10, 2 rows — last row selected, CJK summaries, no line past the width, resize re-lays out', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-ptysz-'))
  const repo = mkdtempSync(join(tmpdir(), 'tui-ptysz-repo-'))
  const home = mkdtempSync(join(tmpdir(), 'tui-ptysz-home-'))
  for (const [i, name] of ['a.abcde', 'b.abcde', 'c.abcde'].entries()) {
    writeWorker(root, repo, 'owner', name, { status: 'success', summary: `完成第${i + 1}項：繁體中文摘要，寬度測試 👨‍👩‍👧 🇹🇼 結果${'很長'.repeat(30)}` })
  }
  const py = `
import pty, os, select, sys, time, subprocess, termios, struct, fcntl, signal, base64
cols, rows, cols2, rows2 = (int(x) for x in sys.argv[4:8])
master, slave = pty.openpty()
def size(c, r):
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
size(cols, rows)
env = {'PATH': os.path.dirname(sys.argv[1]) + ':/usr/bin:/bin', 'HOME': sys.argv[8], 'TMUX_AGENT_DIR': sys.argv[3], 'LANG': 'en_US.UTF-8'}
pre = termios.tcgetattr(slave)
p = subprocess.Popen([sys.argv[1], sys.argv[2], '--session', 'owner', '--cwd', sys.argv[9]], stdin=slave, stdout=slave, stderr=slave, env=env)
out = bytearray()
def pump(seconds, until=None):
    end = time.time() + seconds
    while time.time() < end and (until is None or until not in out):
        r, _, _ = select.select([master], [], [], max(0, end - time.time()))
        if not r: break
        try: chunk = os.read(master, 65536)
        except OSError: break
        if not chunk: break
        out.extend(chunk)
pump(8, b'c.abcde' if rows > 2 else b'3 worker(s)')
pump(0.3)
os.write(master, b'k')
pump(0.8)
mark = len(out)
if cols2:
    size(cols2, rows2)
    p.send_signal(signal.SIGWINCH)
    pump(0.8)
    os.write(master, b'k')
    pump(0.8)
os.write(master, b'q')
try: p.wait(timeout=5)
except subprocess.TimeoutExpired: p.kill(); p.wait()
pump(0.2)
post = termios.tcgetattr(slave)
print('EXIT=%d' % p.returncode)
print('SAME_TTY=%s' % (pre == post))
print('MARK=%d' % mark)
print('OUT=' + base64.b64encode(bytes(out)).decode())
`
  const frames = (bytes: Buffer) => bytes.toString('utf8').split(ANSI_CLEAR_HOME).slice(1).map(f => f.replace(ANSI_LEAVE_ALT, ''))
  const check = (frame: string, cols: number, rows: number, what: string) => {
    // The pty's ONLCR turns the TUI's \r\n into \r\r\n.
    const lines = frame.split(/\r*\n/)
    assert.ok(lines.length <= rows, `${what}: ${lines.length} lines > ${rows}`)
    for (const l of lines) assert.ok(cellWidth(stripAnsi(l)) <= cols, `${what}: ${cellWidth(stripAnsi(l))} cells > ${cols}: [${stripAnsi(l)}]`)
  }
  const scenarios: [number, number, number, number][] = [
    [120, 60, 40, 10],
    [80, 24, 120, 60],
    [40, 10, 0, 0],
    [80, 2, 0, 0],
  ]
  for (const [cols, rows, cols2, rows2] of scenarios) {
    const what = `${cols}x${rows}${cols2 ? `→${cols2}x${rows2}` : ''}`
    const res = await new Promise<{ code: number; out: string; err: string }>(resolve => {
      execFile(
        'python3',
        ['-c', py, process.execPath, join(import.meta.dirname, 'tui.node.ts'), root, String(cols), String(rows), String(cols2), String(rows2), home, repo],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ code: error ? -1 : 0, out: stdout, err: stderr }),
      )
    })
    assert.equal(res.code, 0, `${what}: ${res.err}`)
    assert.match(res.out, /EXIT=0\n/, `${what}\n${res.out.slice(0, 400)}`)
    assert.match(res.out, /SAME_TTY=True\n/, what)
    const mark = Number(/MARK=(\d+)/.exec(res.out)![1])
    const bytes = Buffer.from(/OUT=(\S*)/.exec(res.out)![1]!, 'base64')
    const before = frames(bytes.subarray(0, mark))
    assert.ok(before.length > 0, `${what}: no frame`)
    const sel = before.at(-1)!
    check(sel, cols, rows, what)
    const plain = stripAnsi(sel)
    if (rows > 2) {
      assert.match(plain, /3: \S*\s*› c\.abcde/, `${what}: the last row is selected\n${plain}`)
      assert.match(plain, /完成第3項/, `${what}: its CJK summary is shown`)
    } else {
      assert.match(plain, /3 worker\(s\) · 收件：無收件者 · window too small \(2 rows\)/, plain)
    }
    if (cols2) {
      const after = frames(bytes.subarray(mark))
      assert.ok(after.length > 0, `${what}: no frame after the resize`)
      check(after.at(-1)!, cols2, rows2, `${what} after resize`)
      assert.match(stripAnsi(after.at(-1)!), /› [abc]\.abcde/, `${what}: still a selected row`)
    }
  }
})

test('health on screen: observeView → the status line for collecting, paused, stale (C-health through runTui)', async () => {
  const cases: [Parameters<typeof writeAct>[2], RegExp][] = [
    [{ beatAgoMs: 1_000, state: { channel: 'mod', mode: 'auto', status: 'collecting' } }, /收件：collecting（mod）/],
    [{ beatAgoMs: 1_000, state: { channel: 'node', mode: 'auto', status: 'collecting', reason: 'host composer is busy; nothing pasted, retrying' } }, /收件：collecting（node） · host composer is busy/],
    [{ beatAgoMs: 120_000, state: { channel: 'node', mode: 'auto', status: 'paused', reason: 'refused 3 times' } }, /收件：paused（refused 3 times）/],
    [{ beatAgoMs: 200_000, state: { channel: 'mod', mode: 'auto', status: 'collecting' } }, /收件：stale（beat 20\ds 前）/],
  ]
  for (const [act, want] of cases) {
    const root = mkdtempSync(join(tmpdir(), 'tui-health-screen-'))
    writeAct(root, 1, act)
    const { screen } = await framed({ host: quietHost('S', root, root), root, cwd: root, session: 'S' })
    assert.match(screen, want)
    assert.doesNotMatch(screen, /內部 \?/)
  }
})

test('health line: a collecting collector shows its published reason, cut to the width without wrapping', () => {
  const reason = 'host composer is busy; nothing pasted, retrying'
  const gate = newGate()
  gate.viewHealth = { kind: 'collecting', channel: 'node', mode: 'auto', reason }
  const state: TuiState = { rows: [], all: [], showAll: false, adding: false, resumeInput: '', quit: false }
  assert.equal(healthText(gate.viewHealth), `收件：collecting（node） · ${reason}`)
  const wide = renderTuiLines(state, 120, 10, 1_000, gate).map(stripAnsi)
  assert.ok(wide.some(l => l.includes(`collecting（node） · ${reason}`)), wide.join('\n'))
  for (const width of [30, 12, 5]) {
    const lines = renderTuiLines(state, width, 10, 1_000, gate)
    assert.ok(lines.length <= 10)
    for (const l of lines) assert.ok(cellWidth(stripAnsi(l)) <= width, `width ${width}: ${stripAnsi(l)}`)
    assert.ok(healthText(gate.viewHealth).startsWith(stripAnsi(lines[1]!)), stripAnsi(lines[1]!))
  }
})

// -----------------------------------------------------------------------------
// 9. Sol r6 findings 7, 8, 10–13: paste mode, split sequences, Ctrl-C, terminal
//    errors, colon SGR, SGR inside a grapheme
// -----------------------------------------------------------------------------

const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

test('Sol#7 paste mode: entry enables bracketed paste (DECSET 2004), the one cleanup disables it', async () => {
  const t = mockTty()
  enterTerminal(t.stdin, t.stdout)
  assert.ok(t.stdout.written.includes('\x1b[?2004h'), 'entry enables 2004')
  t.stdout.written = ''
  restoreTerminal(t.stdin, t.stdout, { raw: false, flowing: false })
  assert.ok(t.stdout.written.includes('\x1b[?2004l'), 'restore disables 2004')
  const { stdin, stdout } = mockTty()
  const root = mkdtempSync(join(tmpdir(), 'tui-paste-'))
  const run = runTui({ stdin, stdout, host: quietHost('p', root, root), session: 'p', cwd: root, root, mirrorMs: 60_000 })
  await until(() => stdout.written.includes('workers'), 5_000, 'the first render')
  assert.ok(stdout.written.includes('\x1b[?2004h'), 'runTui enables 2004')
  stdin.emit('data', 'q')
  await run
  assert.ok(stdout.written.lastIndexOf('\x1b[?2004l') > stdout.written.lastIndexOf('\x1b[?2004h'), 'the cleanup turns 2004 off last')
})

test('Sol#8 split sequence: the ESC timer lets go only a lone ESC; a CSI, SS3 or paste prefix waits for its end', async () => {
  const p = new KeyParser()
  assert.deepEqual(p.feed('\x1b[3'), [])
  assert.deepEqual(p.flushEsc(), [], 'a CSI prefix is not let go as keys')
  assert.deepEqual(p.feed('~q'), ['\x1b[3~', 'q'])
  assert.deepEqual(p.feed('\x1bO'), [])
  assert.deepEqual(p.flushEsc(), [], 'an SS3 prefix is not let go as keys')
  assert.deepEqual(p.feed('B'), ['\x1bOB'])
  assert.deepEqual(p.feed('\x1b[20'), [])
  assert.deepEqual(p.flushEsc(), [], 'a paste-start prefix is not let go as keys')
  assert.deepEqual(p.feed('0~q\x1b[201~'), ['\x1b[200~q\x1b[201~'])
  assert.deepEqual(p.feed('\x1b[2\x03'), ['\x03'], 'a CSI cut by a control byte is dropped whole; the control key stays')
  assert.deepEqual(p.feed('\x1b'), [])
  assert.deepEqual(p.flushEsc(), ['\x1b'], 'a lone ESC is still let go')

  // runTui, real timer: the paste-start marker is cut with a gap > ESC_WAIT_MS
  // while the prompt is open. The pasted q is prompt text; the TUI does not quit.
  const { stdin, stdout } = mockTty()
  const root = mkdtempSync(join(tmpdir(), 'tui-split-'))
  const run = runTui({ stdin, stdout, host: quietHost('s8', root, root), session: 's8', cwd: root, root, mirrorMs: 60_000 })
  let ended = false
  run.then(() => (ended = true), () => (ended = true))
  await until(() => stdout.written.includes('workers'), 5_000, 'the first render')
  stdin.emit('data', 'n')
  await until(() => stdout.written.includes('<session-id>'), 5_000, 'the resume prompt')
  stdin.emit('data', '\x1b[20')
  await tick(ESC_WAIT_MS * 4)
  stdin.emit('data', '0~q\x1b[201~')
  try {
    await until(() => ended || stdout.written.includes(': q█'), 3_000, 'the pasted q in the prompt')
    assert.equal(ended, false, 'the split paste quit the TUI')
    assert.ok(stdout.written.includes(': q█'))
  } finally {
    stdin.emit('data', '\x1b')
    await tick(ESC_WAIT_MS * 2)
    stdin.emit('data', 'q')
    await run
  }
})

test('Sol-r2#N2 parser bounds: Ctrl-C in an open paste, the idle bound, and an over-long CSI or paste never stay buffered', () => {
  const p = new KeyParser()
  assert.deepEqual(p.feed('\x1b[200~abc'), [])
  assert.deepEqual(p.feed('q\x03'), ['\x03'], 'Ctrl-C in an open paste is read as Ctrl-C; the partial is dropped')
  assert.equal(p.waitMs(), undefined, 'nothing is left open')
  assert.deepEqual(p.feed('q'), ['q'])
  assert.deepEqual(p.feed('\x1b[200~abc'), [])
  assert.equal(p.waitMs(), SEQ_IDLE_MS, 'an open paste has the idle bound')
  assert.deepEqual(p.expire(), [INPUT_DROPPED], 'the idle bound drops the paste')
  // Sol-r3 R3-5: the tail of the dropped paste is skipped up to ESC[201~, never read as keys.
  assert.equal(p.waitMs(), undefined, 'a skip in progress waits for its terminator, not the clock')
  assert.deepEqual(p.expire(), [], 'a second idle expiry does not repeat the notice')
  assert.deepEqual(p.feed('q\x1b[201~'), [], 'q inside the dead paste is not quit')
  assert.deepEqual(p.feed('q'), ['q'], 'normal keys again after the end marker')
  assert.deepEqual(p.feed('\x1b[12'), [])
  assert.equal(p.waitMs(), SEQ_IDLE_MS)
  assert.deepEqual(p.expire(), [INPUT_DROPPED], 'the idle bound drops a started CSI')
  assert.deepEqual(p.feed('3'), [], 'a CSI parameter byte after the drop is skipped')
  assert.deepEqual(p.feed('x'), [], 'the CSI final byte ends the skip and is not a key')
  assert.deepEqual(p.feed('x'), ['x'], 'normal keys again after the final byte')
  const split = new KeyParser()
  split.feed('\x1b[200~abc\x1b[20')
  assert.deepEqual(split.expire(), [INPUT_DROPPED])
  assert.deepEqual(split.feed('1~q'), ['q'], 'an end marker split across the idle drop still ends the skip')
  const ctrlc = new KeyParser()
  ctrlc.feed('\x1b[200~abc')
  ctrlc.expire()
  assert.deepEqual(ctrlc.feed('q\x03'), ['\x03'], 'Ctrl-C cuts through a skip')
  assert.deepEqual(p.feed('\x1b'), [])
  assert.equal(p.waitMs(), ESC_WAIT_MS, 'a lone ESC keeps its short wait')
  assert.deepEqual(p.expire(), ['\x1b'])
  // A huge unfinished CSI: dropped once past SEQ_MAX, its rest (`+`, a mutating key) skipped.
  const big = new KeyParser()
  const seen: string[] = []
  seen.push(...big.feed('\x1b['))
  for (let n = 0; n < 2_000; n++) seen.push(...big.feed('1;+'.repeat(100)))
  assert.deepEqual(seen, [INPUT_DROPPED])
  assert.ok((big as unknown as { buf: string }).buf.length <= SEQ_MAX, 'memory bounded')
  assert.deepEqual(big.feed('~q'), ['q'], 'the final byte ends the skip; q is a key')
  // A huge paste: dropped past PASTE_MAX, the rest skipped up to its end marker.
  const paste = new KeyParser()
  const got: string[] = [...paste.feed('\x1b[200~')]
  for (let n = 0; n < 40; n++) got.push(...paste.feed('xq'.repeat(PASTE_MAX / 16)))
  assert.ok((paste as unknown as { paste: string }).paste.length <= PASTE_MAX, 'memory bounded')
  got.push(...paste.feed('xq\x1b[201~q'))
  assert.deepEqual(got, [INPUT_DROPPED, 'q'], 'only the drop notice and the key after the end marker')
})

test('Sol-r3 R3-5: after the idle drop, the tail of a dead paste or CSI is skipped to its terminator, never read as action keys', () => {
  const p = new KeyParser()
  assert.deepEqual(p.feed('\x1b[200~unfinished'), [])
  assert.deepEqual(p.expire(), [INPUT_DROPPED])
  assert.deepEqual(p.feed('q\x1b[201~'), [], 'q in the dead paste is not an action key')
  assert.deepEqual(p.feed('q'), ['q'], 'the end marker frees the keys')
  const c = new KeyParser()
  c.feed('\x1b[1;')
  assert.deepEqual(c.expire(), [INPUT_DROPPED])
  assert.deepEqual(c.feed('x'), [], 'the CSI final byte is skipped, not a key (x would stop a worker)')
  assert.deepEqual(c.feed('x'), ['x'])
})

test('Sol-r2#N2 runTui: an unterminated paste then Ctrl-C ends the run and restores the terminal; the end marker (not idle time) frees the keys', async () => {
  for (const how of ['ctrl-c', 'idle'] as const) {
    const { stdin, stdout } = mockTty()
    const root = mkdtempSync(join(tmpdir(), 'tui-n2-'))
    const run = runTui({ stdin, stdout, host: quietHost('n2', root, root), session: 'n2', cwd: root, root, mirrorMs: 60_000 })
    let ended = false
    run.then(() => (ended = true), () => (ended = true))
    await until(() => stdout.written.includes('workers'), 5_000, 'the first render')
    stdin.emit('data', '\x1b[200~abc')
    await tick(ESC_WAIT_MS * 4)
    try {
      if (how === 'ctrl-c') {
        stdin.emit('data', 'q\x03')
        await until(() => ended, 3_000, `${how}: Ctrl-C in an open paste to end the run`)
      } else {
        await until(() => stdout.written.includes('dropped an unfinished paste'), SEQ_IDLE_MS + 3_000, `${how}: the drop status`)
        assert.equal(ended, false)
        stdin.emit('data', 'q')
        await tick(ESC_WAIT_MS * 4)
        assert.equal(ended, false, 'q inside the dropped paste is skipped, not quit')
        stdin.emit('data', '\x1b[201~q')
        await until(() => ended, 3_000, `${how}: q after the end marker to end the run`)
      }
    } finally {
      if (!ended) {
        stdin.emit('data', '\x1b[201~')
        await tick(ESC_WAIT_MS * 2)
        stdin.emit('data', 'q')
      }
      await run
    }
    assert.equal(stdin.isRaw, false, `${how}: raw mode restored`)
    assert.ok(stdout.written.endsWith(ANSI_LEAVE_ALT), `${how}: alt screen left last`)
  }
})

test('Sol#10 Ctrl-C quits from every mode: list, prompt (n, t, +), confirm', async () => {
  const rows = [mockRow('a')]
  const base: TuiState = { rows, all: rows, showAll: false, selected: 'a', adding: false, resumeInput: '', quit: false }
  const modes: TuiState[] = [
    base,
    { ...base, adding: true, inputKind: 'resume' },
    { ...base, adding: true, inputKind: 'tell', inputFor: 'a', resumeInput: 'hi' },
    { ...base, adding: true, inputKind: 'assign' },
    { ...base, armedStop: { id: 'a', from: 0, until: 1e12 } },
  ]
  for (const s of modes) {
    const r = nextKeyState(s, '\x03', 1)
    assert.equal(r.state.quit, true, `adding=${s.adding} kind=${s.inputKind} armed=${!!s.armedStop}`)
    assert.deepEqual(r.action, { type: 'quit' })
  }
  assert.equal(nextKeyState({ ...base, adding: true }, 'q', 1).state.quit, false, 'a typed q in the prompt is text')

  // runTui: prompt open, Ctrl-C ends the run through the one cleanup.
  const { stdin, stdout } = mockTty()
  const root = mkdtempSync(join(tmpdir(), 'tui-ctrlc-'))
  const run = runTui({ stdin, stdout, host: quietHost('c', root, root), session: 'c', cwd: root, root, mirrorMs: 60_000 })
  let ended = false
  run.then(() => (ended = true), () => (ended = true))
  await until(() => stdout.written.includes('workers'), 5_000, 'the first render')
  stdin.emit('data', 'n')
  await until(() => stdout.written.includes('<session-id>'), 5_000, 'the resume prompt')
  stdin.emit('data', '\x03')
  try {
    await until(() => ended, 3_000, 'Ctrl-C in the prompt to end the run')
  } finally {
    if (!ended) {
      stdin.emit('data', '\x1b')
      await tick(ESC_WAIT_MS * 2)
      stdin.emit('data', 'q')
    }
    await run
  }
  assert.equal(stdin.isRaw, false, 'raw mode restored')
  assert.ok(stdout.written.endsWith(ANSI_LEAVE_ALT), 'alt screen left last')
})

test('Sol#11 setup: setRawMode(true) EIO stops startup with the error; nothing is left set', async () => {
  const before = listenerCounts()
  const { stdin, stdout } = mockTty()
  stdin.setRawMode = (r: boolean) => {
    if (r) throw Object.assign(new Error('EIO_RAW'), { code: 'EIO' })
    stdin.isRaw = r
  }
  assert.throws(() => enterTerminal(stdin, stdout), /terminal setup failed: setRawMode\(true\): EIO_RAW/)
  assert.equal(stdout.written, '', 'no alt screen on a failed setup')
  const root = mkdtempSync(join(tmpdir(), 'tui-eio-in-'))
  await assert.rejects(
    runTui({ stdin, stdout, host: quietHost('e', root, root), session: 'e', cwd: root, root, mirrorMs: 60_000 }),
    /terminal setup failed: setRawMode\(true\): EIO_RAW/,
  )
  assert.equal(stdout.written, '', 'runTui drew nothing')
  assert.equal(stdin.listenerCount('data'), 0, 'no stdin listener left')
  assert.deepEqual(listenerCounts(), before, 'no process listener left')

  // A later step fails: the steps done before it are undone.
  const t = mockTty()
  const write = t.stdout.write.bind(t.stdout)
  t.stdout.write = (s: string) => {
    if (s.includes('\x1b[?1049h')) throw Object.assign(new Error('EIO_WRITE'), { code: 'EIO' })
    return write(s)
  }
  assert.throws(() => enterTerminal(t.stdin, t.stdout), /terminal setup failed: enter alt screen: EIO_WRITE/)
  assert.equal(t.stdin.isRaw, false, 'raw mode undone')
})

test('Sol#11 teardown: setRawMode(false) EIO is reported on stderr after the alt screen is left; the other steps still run; runTui rejects (exit 1)', async () => {
  const { stdin, stdout } = mockTty()
  const order: string[] = []
  stdin.setRawMode = (r: boolean) => {
    if (!r) throw Object.assign(new Error('EIO_RESTORE'), { code: 'EIO' })
    stdin.isRaw = r
  }
  let paused = false
  stdin.pause = () => {
    paused = true
  }
  const write = stdout.write.bind(stdout)
  stdout.write = (s: string) => {
    if (s.includes(ANSI_LEAVE_ALT)) order.push('leave')
    return write(s)
  }
  const realErr = process.stderr.write
  let err = ''
  const root = mkdtempSync(join(tmpdir(), 'tui-eio-out-'))
  const run = runTui({ stdin, stdout, host: quietHost('e', root, root), session: 'e', cwd: root, root, mirrorMs: 60_000 })
  await until(() => stdout.written.includes('workers'), 5_000, 'the first render')
  process.stderr.write = ((s: string) => {
    err += s
    order.push('stderr')
    return true
  }) as any
  try {
    stdin.emit('data', 'q')
    await assert.rejects(run, /terminal restore failed: setRawMode\(false\): EIO_RESTORE/, 'a quit with a failed restore is not a success')
  } finally {
    process.stderr.write = realErr
  }
  assert.match(err, /setRawMode\(false\): EIO_RESTORE/)
  assert.ok(paused, 'stdin paused despite the raw-mode error')
  assert.deepEqual(order, ['leave', 'stderr'], 'the error is printed after the alt screen is left')
  const errors = restoreTerminal(stdin, stdout, { raw: false, flowing: false })
  assert.deepEqual(errors.map(e => e.message), ['setRawMode(false): EIO_RESTORE'])
})

test('Sol#12 colon SGR: one grammar for sanitize, strip, width, pad, truncate and render', () => {
  const sgr = '\x1b[38:2::255:0:0m中\x1b[0m'
  assert.equal(sanitizeAnsi(sgr), sgr, 'kept')
  assert.equal(stripAnsi(sgr), '中')
  assert.equal(cellWidth(sgr), 2)
  assert.equal(padCells(sgr, 4), sgr + '  ')
  assert.equal(truncateAnsi(sgr, 2), sgr, 'fits: unchanged')
  assert.equal(truncateAnsi('\x1b[38:2::255:0:0m中文\x1b[0m', 3), '\x1b[38:2::255:0:0m中\x1b[0m')
  const row = mockRow('w-sgr')
  const state: TuiState = {
    rows: [row],
    all: [row],
    showAll: false,
    selected: 'w-sgr',
    adding: false,
    resumeInput: '',
    mirror: { id: 'w-sgr', lines: [sgr] },
    quit: false,
  }
  const lines = renderTuiLines(state, 12, 24, Date.now())
  assert.ok(lines.includes(sgr), `the mirror line is drawn unchanged: ${JSON.stringify(lines)}`)
})

test('Sol#13 SGR inside a grapheme: truncation cuts only at whole visible graphemes', () => {
  withAmbiguous(undefined, () => {
    const family = '\u{1F468}\x1b[31m‍\u{1F469}‍\u{1F467}b'
    assert.equal(cellWidth(family), 3)
    const cut = truncateAnsi(family, 2)
    assert.equal(stripAnsi(cut), '\u{1F468}‍\u{1F469}‍\u{1F467}', 'the whole ZWJ family')
    assert.equal(cut, '\u{1F468}\x1b[31m‍\u{1F469}‍\u{1F467}\x1b[0m', 'the SGR stays where it was')
    assert.equal(truncateAnsi(family, 1), '', 'a 2-cell family does not fit 1 cell')
    // Combining enclosing keycap (U+20E3) after an SGR: the keycap is 2 cells.
    const keycap = '1\x1b[1m⃣x'
    assert.equal(cellWidth(keycap), 3)
    assert.equal(truncateAnsi(keycap, 2), '1\x1b[1m⃣\x1b[0m')
    assert.equal(truncateAnsi(keycap, 1), '')
    const accent = 'e\x1b[1ḿx'
    assert.equal(truncateAnsi(accent, 1), 'e\x1b[1ḿ\x1b[0m')
    for (const text of [family, keycap, accent, '❤\x1b[31m️ab']) {
      const all = graphemes(stripAnsi(text))
      for (let max = 0; max <= 5; max++) {
        const got = truncateAnsi(text, max)
        assert.ok(cellWidth(got) <= max, `${JSON.stringify(text)} max ${max}: ${cellWidth(got)} cells`)
        const gs = graphemes(stripAnsi(got))
        assert.deepEqual(gs, all.slice(0, gs.length), `${JSON.stringify(text)} max ${max}: a whole-grapheme prefix`)
      }
    }
  })
})


test('R8.5: a stale delivery reservation shows "unknown: 可能已送達" and - force-closes it (same core call as the CLI); a dead resumed pane shows exited', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-r85-'))
  const repo = mkdtempSync(join(tmpdir(), 'tui-r85-repo-'))
  const base = nodeHost({ owner: 'S', cwd: repo })
  base.envTmuxAgentDir = async () => root
  const outside = new Set(['git', 'sh', 'tmux', 'agent-tmux'])
  const host = {
    ...base,
    run: async (argv: readonly string[], cwd: string, ms: number) =>
      outside.has(argv[0]!) ? { exitCode: 0, stdout: '', stderr: '' } : base.run(argv, cwd, ms),
  }
  const r = await assignWorker(host, { profile: 'claude', name: 'res', dir: repo, brief: 'GOAL: g\nACCEPTANCE: a\nREPORT: r\n' }, { owner: 'S', ownerCwd: repo })
  if ('deny' in r) assert.fail(r.deny)
  const rs = await resumeWorker(host, 'codex 12345678-1234-1234-1234-123456789abc')
  assert.ok(rs.ok, rs.text)
  // `ghost` delivered and lost its activation: activation 1 is superseded by 2.
  const gd = join(sessionDirOf(v3Of(root), 'ghost'), 'act')
  mkdirSync(join(gd, '1'), { recursive: true })
  mkdirSync(join(gd, '2'), { recursive: true })
  writeFileSync(join(gd, '1.json'), '{"pid":1,"pidStart":"x","host":"h","token":"t"}')
  writeFileSync(join(gd, '2.json'), '{"pid":1,"pidStart":"x","host":"h","token":"t"}')
  writeFileSync(join(r.stateDir, 'episodes', '1', 'delivering'), JSON.stringify({ token: 'old', activation: 1, session: 'ghost', at: 1 }))
  const pause = (ms: number) => new Promise(res => setTimeout(res, ms))
  const { stdin, stdout } = mockTty()
  stdout.columns = 200
  stdout.rows = 40
  const run = runTui({ stdin, stdout, host, session: 'S', cwd: repo, root, mirrorMs: 60_000 })
  const shown = () => stripAnsi(stdout.written)
  try {
    await until(() => shown().includes(r.name), 5_000, 'the rows')
    assert.match(shown(), /codex-12345678\.[0-9a-z]{5}\s+exited — no result/, 'the resumed worker with a dead pane')
    const rows = shown().split('\n').map(l => l.trim())
    // Select the assigned worker's row (the list order is not the point of this test).
    for (let i = 0; i < 4 && !shown().includes(`› ${r.name}`); i++) {
      stdin.emit('data', 'j')
      await pause(150)
    }
    await until(() => shown().includes('unknown: 可能已送達'), 5_000, 'the honest wording')
    await until(() => /- force-close/.test(shown()), 5_000, 'the force-close hint')

    stdin.emit('data', '-')
    await until(() => shown().includes('force-close episode 1? press again'), 5_000, 'the arm')
    await pause(STOP_REPEAT_MS + 50)
    stdin.emit('data', '-')
    await until(() => shown().includes(`cancel ${r.name} — ok: force-closed episode 1 of "${r.name}"`), 5_000, 'force-close text')
    assert.match(shown(), /force-closed episode 1 of "[^"]+": unknown: 可能已送達/)
    assert.deepEqual(readdirSync(join(r.stateDir, 'episodes', '1', 'acks')), ['cancel'])
  } finally {
    stdin.emit('data', 'q')
    await run
  }
})

test('R8.5 key-state: - on a stale reservation arms force-close; the viewer stays read-only', () => {
  const s = ownerState()
  const row = { ...s.rows[0]!, state: 'unknown' as const, reservation: 'stale' as const }
  const t = { ...s, rows: [row], all: [row] }
  assert.match(rowHints(t, row, 1).join('\n'), /- force-close/)
  const one = nextKeyState(t, '-', 1_000)
  assert.equal(one.action, undefined)
  assert.deepEqual(nextKeyState(one.state, '-', 1_000 + STOP_REPEAT_MS).action, { type: 'cancel', row, force: true })
  const v = nextKeyState({ ...t, viewer: true }, '-', 1_000)
  assert.equal(v.action, undefined)
  assert.equal(v.state.statusMessage, READ_ONLY)
})

test('R4-10 key-state: an incomplete reservation row clears with - (press twice); x, t, U do not reach a worker action', () => {
  const s = ownerState()
  const row = { ...s.rows[0]!, state: 'unknown' as const, incomplete: true as const, d: { ...s.rows[0]!.d, seq: 0 } }
  const t = { ...s, rows: [row], all: [row], selected: row.id }
  assert.match(rowHints(t, row, 1).join('\n'), /- clear/)
  const one = nextKeyState(t, '-', 1_000)
  assert.equal(one.action, undefined)
  assert.deepEqual(nextKeyState(one.state, '-', 1_000 + STOP_REPEAT_MS).action, { type: 'clear', row })
  for (const k of ['x', 't', 'U', 'i']) {
    const r = nextKeyState(t, k, 1_000)
    assert.equal(r.action, undefined, k)
    assert.match(r.state.statusMessage ?? '', /no worker\.json/, k)
  }
  const v = nextKeyState({ ...t, viewer: true }, '-', 1_000)
  assert.equal(v.state.statusMessage, READ_ONLY)
})
