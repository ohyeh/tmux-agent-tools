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
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
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
import { eawOf } from './eaw-table.ts'

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

// Created on first use, so a Node without Intl.Segmenter reaches main()'s message
// instead of failing at import.
let segmenter: Intl.Segmenter | undefined
export function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return Array.from(segmenter.segment(text), s => s.segment)
}

/** `TMUX_AGENT_AMBIGUOUS_WIDTH` (1 or 2, default 2): cells for an East Asian Width A character. */
export function ambiguousWidth(): 1 | 2 {
  return process.env.TMUX_AGENT_AMBIGUOUS_WIDTH === '1' ? 1 : 2
}

// Marks (variation selectors and U+20E3 included) and ZWJ are never a grapheme's base.
const NOT_BASE_RE = /[\p{M}‍]/u
const EMOJI_RE = /\p{Emoji}/u
const EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u
const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u
const FLAG_RE = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u
const KEYCAP_RE = /^[0-9#*]️?⃣$/

function baseOf(g: string): string | undefined {
  for (const ch of g) if (!NOT_BASE_RE.test(ch)) return ch
  return undefined
}

/** One grapheme's cells, plan §1c S7 rules 0–7 in order. */
export function graphemeWidth(g: string, ambiguous: number = ambiguousWidth()): number {
  const base = baseOf(g)
  if (base === undefined) return 0 // 0: no base
  if (FLAG_RE.test(g)) return 2 // 1
  if (KEYCAP_RE.test(g)) return 2 // 2
  const emojiZwj =
    g.includes('‍') &&
    g.split('‍').every(part => {
      const b = baseOf(part)
      return b !== undefined && PICTOGRAPHIC_RE.test(b)
    })
  if (EMOJI_PRESENTATION_RE.test(base) || (EMOJI_RE.test(base) && g.includes('️')) || emojiZwj) return 2 // 3
  const eaw = eawOf(base.codePointAt(0)!)
  if (EMOJI_RE.test(base) && g.includes('︎') && eaw !== 'W') return 1 // 4
  if (eaw === 'W') return 2 // 5
  if (eaw === 'A') return ambiguous // 6
  return 1 // 7
}

/** Terminal cells of `text`. SGR escapes count 0. The TUI's one width function. */
export function cellWidth(text: string): number {
  const amb = ambiguousWidth()
  let n = 0
  for (const g of graphemes(stripAnsi(text))) n += graphemeWidth(g, amb)
  return n
}

export function padCells(text: string, width: number): string {
  const gap = width - cellWidth(text)
  return gap > 0 ? text + ' '.repeat(gap) : text
}

const SGR_SPLIT_RE = /(\x1b\[[0-9;:]*m)/

/** `text` cut to `maxWidth` cells. Never splits a grapheme or an SGR escape. */
export function truncateAnsi(text: string, maxWidth: number): string {
  if (cellWidth(text) <= maxWidth) return text
  const amb = ambiguousWidth()
  let out = ''
  let cur = 0
  let hadEscape = false
  const parts = text.split(SGR_SPLIT_RE)
  outer: for (let p = 0; p < parts.length; p++) {
    if (p % 2 === 1) {
      out += parts[p]
      hadEscape = true
      continue
    }
    for (const g of graphemes(parts[p]!)) {
      const w = graphemeWidth(g, amb)
      if (cur + w > maxWidth) break outer
      out += g
      cur += w
    }
  }
  return hadEscape ? out + ANSI_RESET : out
}

/**
 * Untrusted text (mirror, summary, command output) made safe to print: SGR
 * (`ESC [ … m`) is kept; every other CSI, OSC (title, OSC 52 clipboard), DCS/SOS/PM/APC,
 * other ESC sequences, C0/C1 controls and DEL are removed (a tab becomes a space).
 * An escape left incomplete at the end is dropped with the rest of the text.
 */
export function sanitizeAnsi(text: string): string {
  let out = ''
  let i = 0
  const code = (k: number) => text.charCodeAt(k)
  while (i < text.length) {
    const c = code(i)
    if (c === 0x1b) {
      const next = text[i + 1]
      if (next === undefined) break
      if (next === '[') {
        let j = i + 2
        while (j < text.length && code(j) >= 0x30 && code(j) <= 0x3f) j++
        while (j < text.length && code(j) >= 0x20 && code(j) <= 0x2f) j++
        if (j >= text.length) break
        if (code(j) >= 0x40 && code(j) <= 0x7e) {
          const seq = text.slice(i, j + 1)
          if (/^\x1b\[[0-9;:]*m$/.test(seq)) out += seq
          i = j + 1
        } else i = j
        continue
      }
      if (']PX^_'.includes(next)) {
        let j = i + 2
        let end = -1
        for (; j < text.length; j++) {
          if (code(j) === 0x07) {
            end = j + 1
            break
          }
          if (code(j) === 0x1b && text[j + 1] === '\\') {
            end = j + 2
            break
          }
        }
        if (end < 0) break
        i = end
        continue
      }
      let j = i + 1
      while (j < text.length && code(j) >= 0x20 && code(j) <= 0x2f) j++
      if (j >= text.length) break
      i = j + 1
      continue
    }
    if (c === 0x09) out += ' '
    else if (!(c < 0x20 || (c >= 0x7f && c <= 0x9f))) out += text[i]
    i += 1
  }
  return out
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

/** How long a lone ESC waits for the rest of an escape sequence. */
export const ESC_WAIT_MS = 50

/**
 * Decoded stdin text → keys, across chunk boundaries. A key is one grapheme, one
 * control character, one CSI (`ESC [ … final`) or SS3 (`ESC O x`) sequence, a lone
 * ESC, or a whole bracketed paste (kept wrapped in its markers, so a pasted `q`
 * is text, not quit). A partial sequence waits for the next chunk; a lone ESC (or
 * a partial sequence) is let go by `flushEsc()`, which the caller runs after
 * ESC_WAIT_MS with no new input.
 */
export class KeyParser {
  private buf = ''
  private paste: string | undefined

  feed(text: string): string[] {
    this.buf += text
    return this.drain(false)
  }

  /** True when the buffer holds an unfinished escape (not a paste). */
  pendingEsc(): boolean {
    return this.paste === undefined && this.buf.startsWith('\x1b')
  }

  flushEsc(): string[] {
    return this.drain(true)
  }

  private drain(force: boolean): string[] {
    const out: string[] = []
    const b = this.buf
    let i = 0
    while (i < b.length) {
      if (this.paste !== undefined) {
        const end = b.indexOf(PASTE_END, i)
        if (end < 0) {
          // Keep a tail that may be the start of the end marker.
          let keep = Math.min(PASTE_END.length - 1, b.length - i)
          while (keep > 0 && !PASTE_END.startsWith(b.slice(b.length - keep))) keep--
          this.paste += b.slice(i, b.length - keep)
          i = b.length - keep
          break
        }
        const text = this.paste + b.slice(i, end)
        if (text) out.push(PASTE_START + text + PASTE_END)
        this.paste = undefined
        i = end + PASTE_END.length
        continue
      }
      if (b[i] === '\x1b') {
        const rest = b.slice(i)
        let len = 0 // 0 = incomplete, -1 = lone ESC
        if (rest.length === 1) len = 0
        else if (rest[1] === '[') {
          let j = 2
          while (j < rest.length && rest.charCodeAt(j) >= 0x20 && rest.charCodeAt(j) <= 0x3f) j++
          if (j >= rest.length) len = 0
          else len = rest.charCodeAt(j) >= 0x40 && rest.charCodeAt(j) <= 0x7e ? j + 1 : -1
        } else if (rest[1] === 'O') len = rest.length >= 3 ? 3 : 0
        else len = -1
        if (len === 0 && !force) break
        if (len <= 0) {
          out.push('\x1b')
          i += 1
          continue
        }
        const seq = rest.slice(0, len)
        if (seq === PASTE_START) this.paste = ''
        else out.push(seq)
        i += len
        continue
      }
      const c = b.charCodeAt(i)
      if (c < 0x20 || c === 0x7f) {
        out.push(b[i]!)
        i += 1
        continue
      }
      let j = i
      while (j < b.length && b.charCodeAt(j) >= 0x20 && b.charCodeAt(j) !== 0x7f && b[j] !== '\x1b') j++
      out.push(...graphemes(b.slice(i, j)))
      i = j
    }
    this.buf = b.slice(i)
    return out
  }
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
      return { state: { ...state, resumeInput: graphemes(state.resumeInput).slice(0, -1).join('') } }
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
  const clearBtn = clearable ? `[ ✕ ${clearLabel} ]` : ''

  const btnParts = ['[ + new ]', '[ ↻ refresh ]']
  if (clearBtn) btnParts.push(clearBtn)
  btnParts.push('[ quit ]')
  const buttonsStr = btnParts.join(' ')
  const buttonCells = cellWidth(buttonsStr)

  const fullTitle = ` workers · ${counts} `
  let titleText = ` workers `
  if (cellWidth(fullTitle) + buttonCells <= width) {
    titleText = fullTitle
  } else if (cellWidth(` ${counts} `) + buttonCells <= width) {
    titleText = ` ${counts} `
  }

  const titleCells = cellWidth(titleText) + buttonCells
  const hintRoom = Math.max(0, width - titleCells)
  let hint = ''
  for (const piece of ['  /workers stop <name>', ' · /workers tell <name> <text>']) {
    if (cellWidth(hint) + cellWidth(piece) + 1 > hintRoom) break
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
    const labelStr = sanitizeAnsi(rowLabel(r, isSelected))
    const rowLine = `${digitPrefix}${glyphStr}${labelStr}`
    lines.push(truncateAnsi(rowLine, width))

    if (isSelected) {
      if (r.summary) {
        const sumColor = r.summary.startsWith('success') ? '\x1b[32m' : '\x1b[33m'
        lines.push(truncateAnsi(`    ${sumColor}${sanitizeAnsi(r.summary)}\x1b[0m`, width))
      }
      const ctrlParts: string[] = []
      if (r.state === 'running' || r.state === 'stalled') {
        ctrlParts.push('[ ↯ interrupt ]')
      }
      const armed = state.armedStop?.id === r.id && now < state.armedStop.until
      ctrlParts.push(`[ ✕ ${stopButtonLabel(r.d.name, armed)} ]`)
      if (armed) {
        const secs = Math.ceil((state.armedStop!.until - now) / 1000)
        ctrlParts.push(`\x1b[31mends its tmux session · ${secs}s\x1b[0m`)
      }
      lines.push(truncateAnsi(`    ${ctrlParts.join('  ')}`, width))

      if (mirrorAvailable > 0 && state.mirror && state.mirror.id === r.id) {
        lines.push(truncateAnsi(`\x1b[2m${'─'.repeat(Math.min(width, 60))}\x1b[0m`, width))
        const tailLines = state.mirror.lines.slice(-mirrorAvailable)
        for (const ml of tailLines) {
          lines.push(truncateAnsi(sanitizeAnsi(ml) || ' ', width))
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

  if (state.statusMessage && now < (state.statusUntil ?? 0)) {
    lines.push(truncateAnsi(`\x1b[36mtmux-agent: ${sanitizeAnsi(state.statusMessage)}\x1b[0m`, width))
  }

  return lines.slice(0, height)
}

/** stdin as the TUI found it. `restoreTerminal` puts it back. */
export interface TerminalEntry {
  raw: boolean
  flowing: boolean
}

/**
 * `setRawMode(false)` makes libuv restore the termios it saved when raw mode was
 * first entered, so a tty that was already raw before the TUI stays raw.
 */
export function restoreTerminal(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  entry: TerminalEntry = { raw: false, flowing: false },
): void {
  try {
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(entry.raw)
    }
    if (!entry.flowing && typeof stdin.pause === 'function') {
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
): TerminalEntry {
  const entry = { raw: stdin.isRaw === true, flowing: stdin.readableFlowing === true }
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
  return entry
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

  // After quit (or any stop) nothing more is drawn, even by an action still in flight.
  const render = () => {
    if (stopped) return
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

  // Every way out — q, an exception (key, first load, or timer), SIGINT, SIGTERM,
  // stdin 'end' or 'error' — only settles `done`; the `finally` at the bottom runs
  // the one cleanup. `exit` is the last resort for a process.exit elsewhere.
  let finish: { resolve: () => void; reject: (err: unknown) => void } | undefined
  const done = new Promise<void>((resolve, reject) => {
    finish = { resolve, reject }
  })
  // A key can fail before `await done` below is reached; mark it handled here so
  // that is not an unhandled rejection. `await done` still throws it.
  done.catch(() => {})
  let stopped = false
  const stop = () => {
    stopped = true
    finish?.resolve()
  }
  const fail = (err: unknown) => {
    stopped = true
    finish?.reject(err)
  }

  const onResize = () => {
    width = stdout.columns || 80
    height = stdout.rows || 24
    try {
      render()
    } catch (err) {
      fail(err)
    }
  }
  const onExit = () => cleanup()
  const onEnd = () => stop()
  const onError = (err: unknown) => fail(err)

  // Every listener runTui adds is removed here, so a second runTui in the same
  // process starts from the same listener counts (H6: a leaked handler outlived the TUI).
  let entry: TerminalEntry | undefined
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    if (timer) clearInterval(timer)
    if (escTimer) clearTimeout(escTimer)
    stdin.off('data', onData)
    stdin.off('end', onEnd)
    stdin.off('error', onError)
    stdout.off('resize', onResize)
    process.off('SIGWINCH', onResize)
    process.off('exit', onExit)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    restoreTerminal(stdin, stdout, entry)
  }

  // Input is read from the first byte: enterTerminal resumes stdin, and a flowing
  // stream with no 'data' listener drops what arrives. The listener is attached
  // before the first refresh, so a key typed while the ledger loads (or a test's
  // early `q`) is kept (H6). Keys run one at a time, in arrival order: `rq` in one
  // chunk refreshes, then quits.
  const decoder = new StringDecoder('utf8')
  const parser = new KeyParser()
  let escTimer: NodeJS.Timeout | undefined
  let chain: Promise<void> = Promise.resolve()
  const runKeys = (keys: string[]) => {
    if (!keys.length) return
    chain = chain.then(async () => {
      if (stopped) return
      try {
        for (const key of keys) {
          const result = nextKeyState(state, key, Date.now())
          state = result.state
          if (result.action) await handleAction(result.action)
          if (state.quit) return stop()
        }
        render()
      } catch (err) {
        fail(err)
      }
    })
  }
  const onData = (data: Buffer | string) => {
    if (escTimer) clearTimeout(escTimer)
    escTimer = undefined
    runKeys(parser.feed(typeof data === 'string' ? data : decoder.write(data)))
    if (parser.pendingEsc()) {
      escTimer = setTimeout(() => {
        escTimer = undefined
        runKeys(parser.flushEsc())
      }, ESC_WAIT_MS)
    }
  }

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

  entry = enterTerminal(stdin, stdout)
  stdin.on('data', onData)
  stdin.on('end', onEnd)
  stdin.on('error', onError)
  stdout.on('resize', onResize)
  process.on('SIGWINCH', onResize)
  process.on('exit', onExit)
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  try {
    // `q` during a slow first load quits at once; it does not wait for the load.
    const first = refreshRows().then(() => {
      if (!stopped) render()
    })
    first.catch(() => {})
    await Promise.race([first, done])
    if (!stopped) {
      const tick = async () => {
        const fresh = await refreshRows()
        if (state.selected && !stopped) {
          await captureSelected()
        }
        if (fresh) render()
      }
      timer = setInterval(() => {
        if (!stopped) tick().catch(fail)
      }, options.mirrorMs ?? MIRROR_MS)
      await done
    }
  } finally {
    stopped = true
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
  // Widths are per grapheme (plan §1c S7). No silent fallback to per-code-point counting.
  if (typeof Intl.Segmenter !== 'function') {
    process.stderr.write(`tui: this node (${process.versions.node}) has no Intl.Segmenter; widths would be wrong\n`)
    process.exit(2)
  }
  const amb = process.env.TMUX_AGENT_AMBIGUOUS_WIDTH
  if (amb !== undefined && amb !== '1' && amb !== '2') {
    process.stderr.write(`tui: TMUX_AGENT_AMBIGUOUS_WIDTH must be 1 or 2, not ${JSON.stringify(amb)}\n`)
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
  // Terminal already restored. A signal can arrive while an action's child still
  // runs; exit now instead of waiting for it (the old SIGINT/SIGTERM handler did too).
  process.exit(0)
}

/** Run as a script (not imported)? argv[1] may hold spaces, `%`, `#`, or a symlink. */
function isMain(): boolean {
  const arg = process.argv[1]
  if (!arg) return false
  let path = arg
  try {
    path = realpathSync(arg)
  } catch {
    // Not resolvable: compare the path as given.
  }
  return pathToFileURL(path).href === import.meta.url
}

if (isMain()) {
  await main().catch(err => {
    process.stderr.write(`tui error: ${String(err)}\n`)
    process.exit(1)
  })
}
