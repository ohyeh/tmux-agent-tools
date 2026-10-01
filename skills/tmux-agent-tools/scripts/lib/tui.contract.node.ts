import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, cpSync, symlinkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  cellWidth,
  graphemeWidth,
  graphemes,
  sanitizeAnsi,
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

test('pty run: q, rq, Ctrl-C, SIGTERM, an exception, and an already-raw tty all restore the tty flags', { timeout: 90_000 }, async () => {
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

test('view probe: permission is needs-input, project is read, collector health is unknown', async () => {
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
  assert.match(screen, /collector health unknown/)
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
    assert.match(screen, /viewer — no session; not a collecting owner/)
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
        if (argv[0] === 'agent-tmux') cmd.splice(0, 1, '/bin/zsh', '-f', agentTmux)
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
