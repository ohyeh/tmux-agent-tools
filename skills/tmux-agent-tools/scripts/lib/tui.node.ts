// A full-screen terminal TUI of /workers for any host (Codex, Cursor, agy, plain shell),
// sharing the Claude mod's row model, actions, and confirmations from the core (p0-contract.md §9).
//
// Usage: node tui.node.ts [--session <id>] [--cwd <dir>]
// Keys:
//   r       refresh rows and clear selection
//   q       quit the TUI (restoring the terminal)
//   x       stop selected worker (press-twice confirmation)
//   c       clear all workers (press-twice confirmation)
//   n       resume a CLI session by id (opens input prompt)
//   i       interrupt running/stalled worker
//   a       toggle show all / others' workers
//   1-9     select / deselect row 1..9
//   j / k   select next / previous row
//   Esc     cancel pending confirm or deselect row

import { parseArgs } from 'node:util'
import {
  type Host,
  type PanelRow,
  type Gate,
  newGate,
  panelRows,
  setRows,
  othersLine,
  rowLabel,
  rowGlyph,
  clearButtonLabel,
  stopButtonLabel,
  displayCells,
  isFullwidth,
  padCells,
  STATE_COLOR,
  CLEAR_ID,
  STOP_CONFIRM_MS,
  STOP_REPEAT_MS,
  MIRROR_MS,
  MIRROR_ROWS,
  MIRROR_MIN_ROWS,
  rootOf,
  stopWorker,
  stopAll,
  interruptWorker,
  resumeWorker,
  mirrorOf,
  mirrorProject,
  collectorDown,
  exactSessionTarget,
  observeView,
} from './workers.ts'
import { nodeHost } from './host.node.ts'

export const NODE_FLOOR = [22, 18, 0]

export const ANSI_ENTER_ALT = '\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H'
export const ANSI_LEAVE_ALT = '\x1b[?25h\x1b[?1049l'
export const ANSI_HIDE_CURSOR = '\x1b[?25l'
export const ANSI_SHOW_CURSOR = '\x1b[?25h'
export const ANSI_CLEAR_HOME = '\x1b[2J\x1b[H'
export const ANSI_RESET = '\x1b[0m'
export const ANSI_BOLD = '\x1b[1m'
export const ANSI_DIM = '\x1b[2m'
export const ANSI_BG_CYAN = '\x1b[46m'
export const ANSI_FG_BLACK = '\x1b[30m'

export const ANSI_COLOR_MAP: Record<string, string> = {
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
}

export const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

export function displayCellsAnsi(text: string): number {
  return displayCells(stripAnsi(text))
}

/** Truncate text (potentially containing ANSI escapes) to `maxWidth` display cells without breaking wide chars. */
export function truncateAnsi(text: string, maxWidth: number): string {
  const plain = stripAnsi(text)
  if (displayCells(plain) <= maxWidth) return text

  let out = ''
  let curWidth = 0
  let i = 0
  let hadEscape = false
  while (i < text.length) {
    if (text[i] === '\x1b') {
      const end = text.indexOf('m', i)
      if (end !== -1) {
        out += text.slice(i, end + 1)
        i = end + 1
        hadEscape = true
        continue
      }
    }
    const ch = text[i]!
    const cp = text.codePointAt(i) ?? 0
    const w = ch === '·' || isFullwidth(cp) ? 2 : 1
    if (curWidth + w > maxWidth) break
    const charLen = cp > 0xffff ? 2 : 1
    out += text.slice(i, i + charLen)
    curWidth += w
    i += charLen
  }
  return hadEscape ? out + ANSI_RESET : out
}

export interface TuiState {
  rows: PanelRow[]
  all: PanelRow[]
  showAll: boolean
  selected?: string
  armedStop?: { id: string; from: number; until: number }
  adding: boolean
  resumeInput: string
  mirror?: { id: string; lines: string[] }
  statusMessage?: string
  statusUntil?: number
  owner?: string
  /** No --session and no TMUX_AGENT_SESSION. Rows are shown; the band says viewer. */
  viewer?: boolean
  quit: boolean
}

export type TuiAction =
  | { type: 'quit' }
  | { type: 'refresh' }
  | { type: 'stop'; row: PanelRow }
  | { type: 'stopAll' }
  | { type: 'interrupt'; row: PanelRow }
  | { type: 'resume'; value: string }

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/** Printable resume text from one key or one bracketed paste. Control keys are undefined. */
export function resumeText(key: string): string | undefined {
  let text = key
  if (text.startsWith(PASTE_START) && text.endsWith(PASTE_END) && text.length >= PASTE_START.length + PASTE_END.length) {
    text = text.slice(PASTE_START.length, -PASTE_END.length)
  }
  if (!text) return undefined
  for (const ch of text) {
    if (ch < ' ' || ch === '\x7f') return undefined
  }
  return text
}

/** One stdin chunk → keys. A bracketed paste is one text key. */
export function inputEvents(chunk: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < chunk.length) {
    if (chunk.startsWith(PASTE_START, i)) {
      const end = chunk.indexOf(PASTE_END, i + PASTE_START.length)
      const from = i + PASTE_START.length
      if (end < 0) {
        const rest = chunk.slice(from)
        if (rest) out.push(rest)
        break
      }
      const text = chunk.slice(from, end)
      if (text) out.push(text)
      i = end + PASTE_END.length
      continue
    }
    const csi = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(chunk.slice(i))
    if (csi) {
      out.push(csi[0])
      i += csi[0].length
      continue
    }
    const ch = chunk[i]!
    if (ch >= ' ' && ch !== '\x7f') {
      let j = i + 1
      while (j < chunk.length && chunk[j]! >= ' ' && chunk[j] !== '\x7f' && !chunk.startsWith('\x1b', j)) j++
      out.push(chunk.slice(i, j))
      i = j
      continue
    }
    out.push(ch)
    i += 1
  }
  return out
}

export function nextKeyState(state: TuiState, key: string, now: number): { state: TuiState; action?: TuiAction } {
  if (state.adding) {
    if (key === '\x1b') {
      return { state: { ...state, adding: false, resumeInput: '' } }
    }
    if (key === '\r' || key === '\n') {
      const val = state.resumeInput.trim()
      if (!val) {
        return { state: { ...state, adding: false, resumeInput: '' } }
      }
      return {
        state: { ...state, adding: false, resumeInput: '' },
        action: { type: 'resume', value: val },
      }
    }
    if (key === '\x7f' || key === '\b') {
      return { state: { ...state, resumeInput: state.resumeInput.slice(0, -1) } }
    }
    const text = resumeText(key)
    if (text) {
      return { state: { ...state, resumeInput: state.resumeInput + text } }
    }
    return { state }
  }

  if (key === 'q' || key === 'Q' || key === '\x03') {
    return { state: { ...state, quit: true }, action: { type: 'quit' } }
  }

  if (key === 'r' || key === 'R') {
    return {
      state: { ...state, selected: undefined, mirror: undefined, armedStop: undefined },
      action: { type: 'refresh' },
    }
  }

  if (key === 'n' || key === 'N') {
    return {
      state: { ...state, adding: true, resumeInput: '' },
    }
  }

  if (key === 'a' || key === 'A') {
    const showAll = !state.showAll
    const panelLike = { rows: state.rows, all: state.all, showAll, selected: state.selected }
    setRows(panelLike as any, state.all)
    return {
      state: {
        ...state,
        showAll,
        rows: panelLike.rows,
        selected: panelLike.selected,
        mirror: undefined,
      },
    }
  }

  if (key === 'c' || key === 'C') {
    const clearable = state.rows.some(r => !r.project)
    if (!clearable) return { state }
    const armed = state.armedStop
    if (armed?.id === CLEAR_ID) {
      if (now < armed.until && now - armed.from >= STOP_REPEAT_MS) {
        return {
          state: { ...state, armedStop: undefined },
          action: { type: 'stopAll' },
        }
      }
      if (now < armed.until && now - armed.from < STOP_REPEAT_MS) {
        return {
          state: { ...state, armedStop: { ...armed, from: now } },
        }
      }
      return {
        state: { ...state, armedStop: { id: CLEAR_ID, from: now, until: now + STOP_CONFIRM_MS } },
      }
    }
    return {
      state: { ...state, armedStop: { id: CLEAR_ID, from: now, until: now + STOP_CONFIRM_MS } },
    }
  }

  if (key === 'x' || key === 'X') {
    if (!state.selected) return { state }
    const r = state.rows.find(x => x.id === state.selected)
    if (!r || r.project) return { state }

    const armed = state.armedStop
    if (armed?.id === r.id) {
      if (now < armed.until && now - armed.from >= STOP_REPEAT_MS) {
        return {
          state: { ...state, armedStop: undefined },
          action: { type: 'stop', row: r },
        }
      }
      if (now < armed.until && now - armed.from < STOP_REPEAT_MS) {
        return {
          state: { ...state, armedStop: { ...armed, from: now } },
        }
      }
      return {
        state: { ...state, armedStop: { id: r.id, from: now, until: now + STOP_CONFIRM_MS } },
      }
    }
    return {
      state: { ...state, armedStop: { id: r.id, from: now, until: now + STOP_CONFIRM_MS } },
    }
  }

  if (key === 'i' || key === 'I') {
    if (!state.selected) return { state }
    const r = state.rows.find(x => x.id === state.selected)
    if (r && !r.project && (r.state === 'running' || r.state === 'stalled')) {
      return { state, action: { type: 'interrupt', row: r } }
    }
    return { state }
  }

  if (/^[1-9]$/.test(key)) {
    const idx = Number(key) - 1
    if (idx < state.rows.length) {
      const target = state.rows[idx]!
      const newSelected = state.selected === target.id ? undefined : target.id
      return {
        state: {
          ...state,
          selected: newSelected,
          mirror: undefined,
          armedStop: undefined,
        },
      }
    }
    return { state }
  }

  if (key === '\x1b[A' || key === 'k') {
    if (state.rows.length === 0) return { state }
    const curIdx = state.selected ? state.rows.findIndex(r => r.id === state.selected) : -1
    const nextIdx = curIdx <= 0 ? state.rows.length - 1 : curIdx - 1
    return {
      state: {
        ...state,
        selected: state.rows[nextIdx]!.id,
        mirror: undefined,
        armedStop: undefined,
      },
    }
  }

  if (key === '\x1b[B' || key === 'j') {
    if (state.rows.length === 0) return { state }
    const curIdx = state.selected ? state.rows.findIndex(r => r.id === state.selected) : -1
    const nextIdx = curIdx < 0 || curIdx >= state.rows.length - 1 ? 0 : curIdx + 1
    return {
      state: {
        ...state,
        selected: state.rows[nextIdx]!.id,
        mirror: undefined,
        armedStop: undefined,
      },
    }
  }

  if (key === '\x1b') {
    if (state.armedStop) {
      return { state: { ...state, armedStop: undefined } }
    }
    if (state.selected) {
      return { state: { ...state, selected: undefined, mirror: undefined } }
    }
  }

  return { state }
}

export function renderTuiLines(
  state: TuiState,
  width: number,
  height: number,
  now: number,
  gate?: Gate,
): string[] {
  if (width < 1 || height < 1) return []

  const down = gate ? collectorDown(gate) : undefined
  const healthUnknown = !down && gate?.viewHealth === 'unknown'
  const tmuxRunning = state.rows.filter(r => !r.project && !r.terminal).length
  const me = state.owner
  const counts = `${me ? `@${me.slice(0, 8)} · ` : ''}tmux ${tmuxRunning} · 內部 ?`
  const clearable = state.rows.some(r => !r.project)
  const clearArmed = state.armedStop?.id === CLEAR_ID && now < state.armedStop.until
  const clearLabel = clearButtonLabel(clearArmed)
  const clearBtn = clearable ? `[ ${clearLabel} ]` : ''

  const btnParts = ['[ + ]', '[ refresh ]']
  if (clearBtn) btnParts.push(clearBtn)
  btnParts.push('[ quit ]')
  const buttonsStr = btnParts.join(' ')
  const buttonCells = displayCells(buttonsStr)

  const fullTitle = ` workers · ${counts} `
  let titleText = ` workers `
  if (displayCells(fullTitle) + buttonCells <= width) {
    titleText = fullTitle
  } else if (displayCells(` ${counts} `) + buttonCells <= width) {
    titleText = ` ${counts} `
  }

  const titleCells = displayCells(titleText) + buttonCells
  const hintRoom = Math.max(0, width - titleCells)
  let hint = ''
  for (const piece of ['  /workers stop <name>', ' · /workers tell <name> <text>']) {
    if (displayCells(hint) + displayCells(piece) + 1 > hintRoom) break
    hint += piece
  }

  const titleContent = `${titleText}${buttonsStr}${padCells(hint, hintRoom)}`
  const titleLine = `${ANSI_FG_BLACK}${ANSI_BG_CYAN}${ANSI_BOLD}${truncateAnsi(titleContent, width)}${ANSI_RESET}`

  if (height <= 1) {
    return [titleLine]
  }

  if (height <= 2) {
    const compactMsg = `${state.rows.length} worker(s); window too small (${height} rows) — /workers N · /workers stop <name>`
    return [titleLine, truncateAnsi(compactMsg, width)]
  }

  const others = othersLine(state.all)
  const selIndex = state.rows.findIndex(r => r.id === state.selected)
  const selected = selIndex >= 0 ? state.rows[selIndex] : undefined

  const fixed =
    1 +
    (state.adding ? 1 : 0) +
    (down ? 1 : 0) +
    (state.viewer ? 1 : 0) +
    (healthUnknown ? 1 : 0) +
    (others ? 1 : 0) +
    (gate?.legacy ? 1 : 0) +
    (state.statusMessage && now < (state.statusUntil ?? 0) ? 1 : 0) +
    (selected ? 1 + (selected.summary ? 1 : 0) : 0) +
    (state.rows.length ? 0 : 1)

  const reserve = selected ? 1 + MIRROR_MIN_ROWS : 0
  const fitsAt = (n: number) => fixed + n + (n < state.rows.length ? 1 : 0) + reserve <= height

  let shownRows = state.rows.length
  while (shownRows > 1 && !fitsAt(shownRows)) shownRows -= 1

  const first = selected
    ? Math.max(0, Math.min(selIndex - shownRows + 1, state.rows.length - shownRows))
    : 0
  const hidden = state.rows.length - shownRows

  const used = fixed + shownRows + (hidden > 0 ? 1 : 0)
  const room = height - used - 1
  const mirrorAvailable = room >= MIRROR_MIN_ROWS ? Math.min(MIRROR_ROWS * 2, room) : 0

  const lines: string[] = [titleLine]

  if (down) {
    lines.push(truncateAnsi(`\x1b[2m⚠ ${down}\x1b[0m`, width))
  }

  if (state.viewer) {
    lines.push(truncateAnsi('\x1b[2mviewer — no session; not a collecting owner\x1b[0m', width))
  }

  if (healthUnknown) {
    lines.push(truncateAnsi('\x1b[2mcollector health unknown — this view does not collect\x1b[0m', width))
  }

  if (state.adding) {
    lines.push(truncateAnsi(`  + [profile] <session-id> [name]: ${state.resumeInput}█`, width))
  }

  if (state.rows.length === 0) {
    lines.push(truncateAnsi('\x1b[2mNo workers outstanding.\x1b[0m', width))
  }

  for (let i = 0; i < state.rows.length; i++) {
    if (i < first || i >= first + shownRows) continue
    const r = state.rows[i]!
    const isSelected = r.id === state.selected
    const digitPrefix = i < 9 ? `${i + 1}: ` : '   '
    const color = r.project ? ANSI_COLOR_MAP['blue'] : (ANSI_COLOR_MAP[STATE_COLOR[r.state]] ?? '')
    const glyphStr = `${color}${ANSI_BOLD}${rowGlyph(r)}${ANSI_RESET}`
    const labelStr = rowLabel(r, isSelected)
    const rowLine = `${digitPrefix}${glyphStr}${labelStr}`
    lines.push(truncateAnsi(rowLine, width))

    if (isSelected) {
      if (r.summary) {
        const sumColor = r.summary.startsWith('success') ? '\x1b[32m' : '\x1b[33m'
        lines.push(truncateAnsi(`    ${sumColor}${r.summary}\x1b[0m`, width))
      }
      const ctrlParts: string[] = []
      if (r.state === 'running' || r.state === 'stalled') {
        ctrlParts.push('[ interrupt ]')
      }
      const armed = state.armedStop?.id === r.id && now < state.armedStop.until
      ctrlParts.push(`[ ${stopButtonLabel(r.d.name, armed)} ]`)
      if (armed) {
        const secs = Math.ceil((state.armedStop!.until - now) / 1000)
        ctrlParts.push(`\x1b[31mends its tmux session · ${secs}s\x1b[0m`)
      }
      lines.push(truncateAnsi(`    ${ctrlParts.join('  ')}`, width))

      if (mirrorAvailable > 0 && state.mirror && state.mirror.id === r.id) {
        lines.push(truncateAnsi(`\x1b[2m${'─'.repeat(Math.min(width, 60))}\x1b[0m`, width))
        const tailLines = state.mirror.lines.slice(-mirrorAvailable)
        for (const ml of tailLines) {
          lines.push(truncateAnsi(ml || ' ', width))
        }
        const seeWhole = r.project
          ? `See it whole: tmux attach -t ${exactSessionTarget(r.d.name)}`
          : `See it whole: agent-tmux ${r.d.profile} attach ${r.d.name}`
        lines.push(truncateAnsi(`\x1b[2m${seeWhole}\x1b[0m`, width))
      } else if (mirrorAvailable === 0 && height < 12) {
        lines.push(truncateAnsi(`\x1b[2mBand too short to mirror — enlarge the window.\x1b[0m`, width))
      }
    }
  }

  if (hidden > 0) {
    lines.push(truncateAnsi(`\x1b[2m  +${hidden} more — /workers N selects row N\x1b[0m`, width))
  }

  if (others) {
    const glyphColor = others.running ? '\x1b[32m' : '\x1b[2m'
    lines.push(truncateAnsi(`${glyphColor}◌\x1b[0m [ ${state.showAll ? '只看自己' : '展開'} · ${others.text} ]`, width))
  }

  if (gate?.legacy) {
    lines.push(truncateAnsi(`\x1b[2mlegacy: ${gate.legacy} worker(s) still pending in the old state root (not collected by this version)\x1b[0m`, width))
  }

  if (state.statusMessage && now < (state.statusUntil ?? 0)) {
    lines.push(truncateAnsi(`\x1b[36mtmux-agent: ${state.statusMessage}\x1b[0m`, width))
  }

  return lines.slice(0, height)
}

export function restoreTerminal(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): void {
  try {
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(false)
    }
    if (typeof stdin.pause === 'function') {
      stdin.pause()
    }
  } catch {}
  try {
    stdout.write(ANSI_LEAVE_ALT)
  } catch {}
}

export function enterTerminal(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): void {
  try {
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true)
    }
    if (typeof stdin.resume === 'function') {
      stdin.resume()
    }
  } catch {}
  try {
    stdout.write(ANSI_ENTER_ALT)
  } catch {}
}

export interface TuiOptions {
  host?: Host
  session?: string
  cwd?: string
  root?: string
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  pollMs?: number
  mirrorMs?: number
}

export async function runTui(options: TuiOptions = {}): Promise<void> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  // No invented owner. A missing id is a viewer (every row, labeled), never `tui-<pid>`.
  const session = options.session ?? process.env.TMUX_AGENT_SESSION
  const cwd = options.cwd ?? process.cwd()
  const base = options.host ?? nodeHost({ owner: session, cwd })
  const host: Host = options.root ? { ...base, envTmuxAgentDir: async () => options.root as string } : base
  const root = options.root ?? (await rootOf(host))
  const gate = newGate()

  let width = stdout.columns || 80
  let height = stdout.rows || 24

  let state: TuiState = {
    rows: [],
    all: [],
    showAll: false,
    adding: false,
    resumeInput: '',
    quit: false,
    owner: host.owner(),
    viewer: !session,
  }

  let refreshing = false
  let capturing = false
  let timer: NodeJS.Timeout | undefined

  const render = () => {
    const lines = renderTuiLines(state, width, height, Date.now(), gate)
    stdout.write(ANSI_CLEAR_HOME + lines.join('\r\n'))
  }

  const refreshRows = async (): Promise<boolean> => {
    if (refreshing) return false
    refreshing = true
    try {
      if (root) await observeView(host, gate, root)
      const rows = await panelRows(host, gate, root)
      state.all = rows
      const panelLike = { rows: state.rows, all: state.all, showAll: state.showAll, selected: state.selected }
      setRows(panelLike as any, rows)
      state.rows = panelLike.rows
      state.selected = panelLike.selected
      return true
    } finally {
      refreshing = false
    }
  }

  const captureSelected = async () => {
    if (!state.selected || capturing) return
    const row = state.rows.find(r => r.id === state.selected)
    if (!row) return
    capturing = true
    try {
      const lines = row.project
        ? await mirrorProject(host, row.d.name, MIRROR_ROWS)
        : await mirrorOf(host, row.d, MIRROR_ROWS)
      if (state.selected === row.id) {
        state.mirror = { id: row.id, lines }
      }
    } finally {
      capturing = false
    }
  }

  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    if (timer) clearInterval(timer)
    restoreTerminal(stdin, stdout)
  }

  enterTerminal(stdin, stdout)

  try {
    await refreshRows()
    render()

    const onResize = () => {
      width = stdout.columns || 80
      height = stdout.rows || 24
      render()
    }

    stdout.on('resize', onResize)
    process.on('SIGWINCH', onResize)

    const onExit = () => cleanup()
    const onSig = () => {
      cleanup()
      process.exit(0)
    }

    process.on('exit', onExit)
    process.on('SIGINT', onSig)
    process.on('SIGTERM', onSig)

    timer = setInterval(async () => {
      if (state.quit) return
      const fresh = await refreshRows()
      if (state.selected) {
        await captureSelected()
      }
      if (fresh) render()
    }, options.mirrorMs ?? MIRROR_MS)

    const handleAction = async (action: TuiAction) => {
      if (action.type === 'quit') {
        state.quit = true
        return
      }
      if (action.type === 'refresh') {
        await refreshRows()
        render()
        return
      }
      if (action.type === 'stop') {
        const out = await stopWorker(host, gate, action.row.d)
        state.statusMessage = `stop ${action.row.d.name} — ${out.ok ? 'ok' : 'FAILED'}: ${out.text.slice(0, 100)}`
        state.statusUntil = Date.now() + 5000
        await refreshRows()
        render()
        return
      }
      if (action.type === 'stopAll') {
        const out = await stopAll(host, gate)
        state.statusMessage = `clear — ${out.ok ? 'ok' : 'FAILED'}: ${out.text.slice(0, 100)}`
        state.statusUntil = Date.now() + 5000
        await refreshRows()
        render()
        return
      }
      if (action.type === 'interrupt') {
        const out = await interruptWorker(host, action.row.d)
        state.statusMessage = `interrupt ${action.row.d.name} — ${out.ok ? 'ok' : 'FAILED'}: ${out.text.slice(0, 100)}`
        state.statusUntil = Date.now() + 5000
        await refreshRows()
        render()
        return
      }
      if (action.type === 'resume') {
        const out = await resumeWorker(host, action.value)
        state.statusMessage = `resume — ${out.ok ? 'ok' : 'FAILED'}: ${out.text.slice(0, 100)}`
        state.statusUntil = Date.now() + 5000
        if (out.ok) await refreshRows()
        render()
        return
      }
    }

    await new Promise<void>((resolve, reject) => {
      const onData = async (data: Buffer | string) => {
        try {
          for (const key of inputEvents(String(data))) {
            const result = nextKeyState(state, key, Date.now())
            state = result.state
            if (result.action) await handleAction(result.action)
            if (state.quit) {
              stdin.off('data', onData)
              resolve()
              return
            }
          }
          render()
        } catch (err) {
          stdin.off('data', onData)
          reject(err)
        }
      }
      stdin.on('data', onData)
    })
  } finally {
    cleanup()
  }
}

async function main(): Promise<void> {
  const have = process.versions.node.split('.').map(Number)
  const below = NODE_FLOOR.findIndex((n, i) => have[i]! !== n)
  if (below >= 0 && have[below]! < NODE_FLOOR[below]!) {
    process.stderr.write(`node ${process.versions.node} is below floor ${NODE_FLOOR.join('.')}\n`)
    process.exit(2)
  }
  let values: { session?: string; cwd?: string }
  try {
    ;({ values } = parseArgs({ options: { session: { type: 'string' }, cwd: { type: 'string' } } }))
  } catch (error) {
    process.stderr.write(`tui: ${(error as Error).message}\n`)
    process.exit(2)
  }
  await runTui({ session: values.session, cwd: values.cwd })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main().catch(err => {
    process.stderr.write(`tui error: ${String(err)}\n`)
    process.exit(1)
  })
}
