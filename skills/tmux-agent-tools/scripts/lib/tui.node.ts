// A full-screen terminal TUI of the workers panel for any host (Codex, Cursor, agy,
// plain shell), sharing the Claude mod's row model, actions, and confirmations from
// the core (p0-contract.md §9).
//
// Usage: node tui.node.ts [--session <id>] [--cwd <dir>]
// Without a session it is a viewer: every row, read-only (D-viewer).
// Keys (header):
//   n       resume a CLI session by id (input line)
//   +       assign a new worker: <profile> <name> <brief-file> (input line)
//   r       refresh rows and clear the selection
//   c       clear all workers (press twice)
//   q       quit (the terminal is restored)
//   a       toggle all / only this session's workers
//   1-9, j / k, Up / Down   select a row
// Keys (selected row):
//   t       tell: send the worker a follow-up (input line)
//   i       interrupt a running or stalled worker
//   x       stop the worker (press twice)
//   -       cancel its episode (press twice; the pane is untouched)
//   U       unlock its action lock, maintenance (press twice; only a provably gone holder)
//   Enter   detail view; PgUp / PgDn scroll it
//   Esc     cancel a confirmation, close the detail, or deselect

import { parseArgs } from 'node:util'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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
  UNLOCK_WORD,
  type EpisodeDetail,
  type Health,
  rootOf,
  stopWorker,
  stopAll,
  interruptWorker,
  resumeWorker,
  tellWorker,
  assignWorker,
  cancelEpisode,
  unlockWorker,
  episodeDetail,
  mirrorOf,
  mirrorProject,
  exactSessionTarget,
  observeView,
} from './workers.ts'
import { nodeHost } from './host.node.ts'
import { graphemes, graphemeWidth as widthOf } from './width.ts'

export const NODE_FLOOR = [22, 18, 0]

// `?2004h` turns on bracketed paste: the terminal wraps a paste in ESC[200~ … ESC[201~,
// so a pasted `q` or `x` is text, not a key (KeyParser). `?2004l` turns it off again.
export const ANSI_ENTER_ALT = '\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[2J\x1b[H'
export const ANSI_LEAVE_ALT = '\x1b[?2004l\x1b[?25h\x1b[?1049l'
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

// The one SGR grammar: `ESC [ params m`, params from `0-9 ; :` (colon sub-parameters,
// as in `ESC[38:2::255:0:0m`). sanitizeAnsi keeps exactly these; stripAnsi, cellWidth
// and truncateAnsi read them as zero width.
const SGR_PARAMS = '[0-9;:]*'
const SGR_RE = new RegExp(`^\\x1b\\[${SGR_PARAMS}m$`)
const SGR_SPLIT_RE = new RegExp(`(\\x1b\\[${SGR_PARAMS}m)`)
export const ANSI_RE = new RegExp(`\\x1b\\[${SGR_PARAMS}[a-zA-Z]`, 'g')
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

/** `TMUX_AGENT_AMBIGUOUS_WIDTH` (1 or 2, default 2): cells for an East Asian Width A character. */
export function ambiguousWidth(): 1 | 2 {
  return process.env.TMUX_AGENT_AMBIGUOUS_WIDTH === '1' ? 1 : 2
}

export { graphemes } from './width.ts'
/** One grapheme's cells (width.ts), with the ambiguous width from the environment by default. */
export function graphemeWidth(g: string, ambiguous: number = ambiguousWidth()): number {
  return widthOf(g, ambiguous)
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

/** `text` cut to `maxWidth` cells. Never splits a grapheme or an SGR escape. */
export function truncateAnsi(text: string, maxWidth: number): string {
  if (cellWidth(text) <= maxWidth) return text
  const amb = ambiguousWidth()
  // Odd parts are SGR. The cut is found on the SGR-free text, so an SGR inside a
  // grapheme (ZWJ family, combining mark) cannot split it; then the original is
  // copied up to that cut, SGR tokens included where they were.
  const parts = text.split(SGR_SPLIT_RE)
  let left = 0
  let cur = 0
  for (const g of graphemes(parts.filter((_, p) => p % 2 === 0).join(''))) {
    cur += graphemeWidth(g, amb)
    if (cur > maxWidth) break
    left += g.length
  }
  let out = ''
  let hadEscape = false
  for (let p = 0; p < parts.length && left > 0; p++) {
    if (p % 2 === 1) {
      out += parts[p]
      hadEscape = true
      continue
    }
    out += parts[p]!.slice(0, left)
    left -= Math.min(left, parts[p]!.length)
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
          if (SGR_RE.test(seq)) out += seq
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

/** Width-wrapped plain lines of untrusted text: escapes stripped, graphemes never split. */
export function wrapCells(text: string, width: number): string[] {
  if (width < 1) return []
  const amb = ambiguousWidth()
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    let cur = 0
    for (const g of graphemes(stripAnsi(sanitizeAnsi(para)))) {
      const w = graphemeWidth(g, amb)
      if (w > width) continue // a 2-cell grapheme in a 1-cell window
      if (cur + w > width) {
        out.push(line)
        line = ''
        cur = 0
      }
      line += g
      cur += w
    }
    out.push(line)
  }
  return out
}

/** What the input line is for. Unset `inputKind` = resume. */
export type InputKind = 'resume' | 'tell' | 'assign'

export interface TuiState {
  rows: PanelRow[]
  all: PanelRow[]
  showAll: boolean
  selected?: string
  /** One press-twice confirmation: a row id (stop), CLEAR_ID, `cancel:<id>` or `unlock:<id>`. */
  armedStop?: { id: string; from: number; until: number }
  adding: boolean
  resumeInput: string
  inputKind?: InputKind
  /** The row a `tell` input is for. */
  inputFor?: string
  mirror?: { id: string; lines: string[] }
  /** Enter on the selected row: its detail replaces the mirror. */
  expanded?: boolean
  detail?: { id: string; lines: string[] }
  /** First detail line shown (PgUp/PgDn). */
  scroll?: number
  /** Body rows of the last layout and the last scroll offset; runTui sets both. */
  page?: number
  scrollMax?: number
  statusMessage?: string
  statusUntil?: number
  owner?: string
  /** No --session and no TMUX_AGENT_SESSION: every row, read-only (D-viewer). */
  viewer?: boolean
  /** Why the ledger could not be read (the third empty state). */
  loadError?: string
  quit: boolean
}

export type TuiAction =
  | { type: 'quit' }
  | { type: 'refresh' }
  | { type: 'stop'; row: PanelRow }
  | { type: 'stopAll' }
  | { type: 'interrupt'; row: PanelRow }
  | { type: 'resume'; value: string }
  | { type: 'tell'; row: PanelRow; text: string }
  | { type: 'assign'; value: string }
  | { type: 'cancel'; row: PanelRow; force?: boolean }
  | { type: 'unlock'; row: PanelRow }
  | { type: 'detail' }

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
export const PAGE_UP = '\x1b[5~'
export const PAGE_DOWN = '\x1b[6~'
export const READ_ONLY = '唯讀；帶 --session 才能操作'
/** Keys that act on the ledger or a pane. A viewer gets READ_ONLY for each (D-viewer). */
export const MUTATING_KEYS: ReadonlySet<string> = new Set(['x', 'X', 'c', 'C', 'i', 'I', 'n', 'N', 't', 'T', '+', '-', 'U'])
const STATUS_MS = 5_000

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
/** Idle bound: a started CSI/SS3 or an open paste with no new byte for this long is dropped. */
export const SEQ_IDLE_MS = 1_000
/** Size bounds: an unfinished CSI parameter stream / an open paste longer than this is dropped. */
export const SEQ_MAX = 256
export const PASTE_MAX = 65_536
/** Emitted by KeyParser (never read from input): an unfinished sequence was dropped. */
export const INPUT_DROPPED = '\x00dropped'

/**
 * Decoded stdin text → keys, across chunk boundaries. A key is one grapheme, one
 * control character, one CSI (`ESC [ … final`) or SS3 (`ESC O x`) sequence, a lone
 * ESC, or a whole bracketed paste (kept wrapped in its markers, so a pasted `q`
 * is text, not quit). A partial sequence waits for the next chunk. Only a lone ESC
 * is let go after ESC_WAIT_MS with no new input (`waitMs()` tells the caller when to
 * run `expire()`): a started CSI (`ESC [`), SS3 (`ESC O`) or paste marker stays
 * buffered until it ends or a bound drops it, so its tail never becomes keys. A CSI or SS3 cut by a byte that cannot
 * belong to it is dropped whole; that byte (Ctrl-C, say) is read as a key.
 * Bounds (a sequence that never ends must not hold the TUI): `expire()` after
 * SEQ_IDLE_MS with no new input drops a started CSI/SS3 or an open paste and skips its tail up to the final byte / ESC[201~. A CSI parameter stream past SEQ_MAX is dropped and the rest of it
 * skipped up to its final byte; a paste past PASTE_MAX is dropped and the rest of
 * it skipped up to ESC[201~. Each drop emits INPUT_DROPPED (a status line), never
 * the dropped bytes as keys. Ctrl-C (0x03) inside an open paste drops the paste and
 * is read as Ctrl-C, so one press quits (inside a CSI/SS3 it already cuts it): a
 * stuck parser never needs a second key, and quit restores the terminal. Limit: a
 * paste whose text holds a raw 0x03 quits the TUI.
 */
export class KeyParser {
  private buf = ''
  private paste: string | undefined
  private pasteOver = false // the open paste passed PASTE_MAX: skip to its end marker
  private skipCsi = false // an over-long CSI was dropped: skip its rest

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

  /** When the caller runs `expire()`: ESC_WAIT_MS for a lone ESC, SEQ_IDLE_MS for a started sequence or paste. A skip in progress waits for its terminator, not for the clock. */
  waitMs(): number | undefined {
    if (this.paste === undefined && this.buf === '\x1b') return ESC_WAIT_MS
    const open = this.paste !== undefined ? !this.pasteOver : !this.skipCsi && this.buf !== ''
    return open ? SEQ_IDLE_MS : undefined
  }

  /**
   * Idle bound reached: a lone ESC is a key; a started sequence or paste is dropped and
   * its tail skipped up to the terminator (ESC[201~ / the CSI final byte), so the rest of
   * a dead paste or sequence never becomes action keys. Ctrl-C still cuts through.
   */
  expire(): string[] {
    if (this.paste === undefined && this.buf === '\x1b') return this.flushEsc()
    if (this.paste !== undefined) {
      const first = !this.pasteOver
      this.paste = '' // buf keeps only a prefix of ESC[201~
      this.pasteOver = true
      return first ? [INPUT_DROPPED] : []
    }
    if (this.skipCsi || this.buf === '') return []
    this.buf = ''
    this.skipCsi = true
    return [INPUT_DROPPED]
  }

  private drain(force: boolean): string[] {
    const out: string[] = []
    const b = this.buf
    let i = 0
    const param = (k: number) => b.charCodeAt(k) >= 0x20 && b.charCodeAt(k) <= 0x3f
    while (i < b.length) {
      if (this.skipCsi) {
        while (i < b.length && param(i)) i++
        if (i === b.length) break
        this.skipCsi = false
        if (b.charCodeAt(i) >= 0x40 && b.charCodeAt(i) <= 0x7e) i++
        continue
      }
      if (this.paste !== undefined) {
        const end = b.indexOf(PASTE_END, i)
        const cc = b.indexOf('\x03', i)
        if (cc >= 0 && (end < 0 || cc < end)) {
          this.paste = undefined
          this.pasteOver = false
          out.push('\x03')
          i = cc + 1
          continue
        }
        if (end < 0) {
          // Keep a tail that may be the start of the end marker.
          let keep = Math.min(PASTE_END.length - 1, b.length - i)
          while (keep > 0 && !PASTE_END.startsWith(b.slice(b.length - keep))) keep--
          if (!this.pasteOver) this.paste += b.slice(i, b.length - keep)
          if (this.paste.length > PASTE_MAX) {
            this.paste = ''
            this.pasteOver = true
            out.push(INPUT_DROPPED)
          }
          i = b.length - keep
          break
        }
        const text = this.paste + b.slice(i, end)
        if (this.pasteOver) {
          // already reported when it passed PASTE_MAX
        } else if (text.length > PASTE_MAX) out.push(INPUT_DROPPED)
        else if (text) out.push(PASTE_START + text + PASTE_END)
        this.paste = undefined
        this.pasteOver = false
        i = end + PASTE_END.length
        continue
      }
      if (b[i] === '\x1b') {
        const rest = b.slice(i)
        const final = (k: number) => rest.charCodeAt(k) >= 0x40 && rest.charCodeAt(k) <= 0x7e
        let len = 0 // 0 = incomplete, -1 = ESC alone (then a plain key), -k = drop k bytes
        if (rest.length === 1) len = force ? -1 : 0
        else if (rest[1] === '[') {
          let j = 2
          while (j < rest.length && rest.charCodeAt(j) >= 0x20 && rest.charCodeAt(j) <= 0x3f) j++
          if (j >= rest.length && j > SEQ_MAX) {
            this.skipCsi = true
            out.push(INPUT_DROPPED)
            i = b.length
            break
          }
          if (j >= rest.length) len = 0
          else len = final(j) ? j + 1 : -j
        } else if (rest[1] === 'O') len = rest.length < 3 ? 0 : final(2) ? 3 : -2
        else len = -1
        if (len === 0) break
        if (len < -1) {
          i -= len
          continue
        }
        if (len === -1) {
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

/**
 * Press-twice confirmation (stop, clear, cancel, unlock): the first press arms `id`
 * for STOP_CONFIRM_MS; a second press after STOP_REPEAT_MS fires; a faster one only
 * debounces; an expired arm re-arms.
 */
function pressTwice(state: TuiState, id: string, now: number, action: TuiAction): { state: TuiState; action?: TuiAction } {
  const armed = state.armedStop
  if (armed?.id === id && now < armed.until) {
    if (now - armed.from >= STOP_REPEAT_MS) return { state: { ...state, armedStop: undefined }, action }
    return { state: { ...state, armedStop: { ...armed, from: now } } }
  }
  return { state: { ...state, armedStop: { id, from: now, until: now + STOP_CONFIRM_MS } } }
}

const say = (state: TuiState, text: string, now: number): { state: TuiState } => ({
  state: { ...state, statusMessage: text, statusUntil: now + STATUS_MS },
})

/** Selection moved: the mirror, the detail and any confirmation belong to the old row. */
const reselect = (state: TuiState, selected: string | undefined): TuiState => ({
  ...state,
  selected,
  mirror: undefined,
  armedStop: undefined,
  expanded: false,
  detail: undefined,
  scroll: 0,
})

export function nextKeyState(state: TuiState, key: string, now: number): { state: TuiState; action?: TuiAction } {
  // Raw mode turns Ctrl-C into a key (no SIGINT): it quits from every mode, prompt included.
  if (key === '\x03') return { state: { ...state, quit: true }, action: { type: 'quit' } }
  if (key === INPUT_DROPPED) return say(state, 'input — dropped an unfinished paste or escape sequence (no end in time or too long)', now)
  if (state.adding) {
    const closed: TuiState = { ...state, adding: false, resumeInput: '', inputKind: undefined, inputFor: undefined }
    if (key === '\x1b') return { state: closed }
    if (key === '\r' || key === '\n') {
      const val = state.resumeInput.trim()
      if (!val) return { state: closed }
      if (state.inputKind === 'tell') {
        const row = state.rows.find(r => r.id === state.inputFor)
        if (!row) return say(closed, 'tell — that row is gone', now)
        return { state: closed, action: { type: 'tell', row, text: val } }
      }
      if (state.inputKind === 'assign') return { state: closed, action: { type: 'assign', value: val } }
      return { state: closed, action: { type: 'resume', value: val } }
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

  if (key === 'q' || key === 'Q') {
    return { state: { ...state, quit: true }, action: { type: 'quit' } }
  }

  // The one read-only gate: no key a viewer presses reaches an action (D-viewer).
  if (state.viewer && MUTATING_KEYS.has(key)) return say(state, READ_ONLY, now)

  if (key === 'r' || key === 'R') {
    return { state: reselect(state, undefined), action: { type: 'refresh' } }
  }

  const row = state.selected ? state.rows.find(x => x.id === state.selected) : undefined

  if (key === 'n' || key === 'N') {
    return { state: { ...state, adding: true, resumeInput: '', inputKind: 'resume' } }
  }

  if (key === '+') {
    return { state: { ...state, adding: true, resumeInput: '', inputKind: 'assign' } }
  }

  if (key === 't' || key === 'T') {
    if (!row || row.project) return { state }
    return { state: { ...state, adding: true, resumeInput: '', inputKind: 'tell', inputFor: row.id } }
  }

  if (key === 'a' || key === 'A') {
    const showAll = !state.showAll
    const panelLike = { rows: state.rows, all: state.all, showAll, selected: state.selected }
    setRows(panelLike as any, state.all)
    const next = panelLike.selected === state.selected ? { ...state, mirror: undefined } : reselect(state, panelLike.selected)
    return { state: { ...next, showAll, rows: panelLike.rows, selected: panelLike.selected } }
  }

  if (key === 'c' || key === 'C') {
    if (!state.rows.some(r => !r.project)) return { state }
    return pressTwice(state, CLEAR_ID, now, { type: 'stopAll' })
  }

  if (key === 'x' || key === 'X') {
    if (!row || row.project) return { state }
    return pressTwice(state, row.id, now, { type: 'stop', row })
  }

  if (key === '-') {
    if (!row || row.project) return { state }
    // A resumed worker has no episode until its first tell (seq 0).
    if (!row.d.seq) return say(state, `cancel — "${row.d.name}" has no episode yet`, now)
    return pressTwice(state, `cancel:${row.id}`, now, { type: 'cancel', row, ...(row.reservation === 'stale' ? { force: true } : {}) })
  }

  if (key === 'U') {
    if (!row || row.project) return { state }
    return pressTwice(state, `unlock:${row.id}`, now, { type: 'unlock', row })
  }

  if (key === 'i' || key === 'I') {
    if (row && !row.project && (row.state === 'running' || row.state === 'stalled')) {
      return { state, action: { type: 'interrupt', row } }
    }
    return { state }
  }

  if (key === '\r' || key === '\n') {
    if (!row) return { state }
    const expanded = !state.expanded
    return {
      state: { ...state, expanded, scroll: 0, armedStop: undefined, ...(expanded ? {} : { detail: undefined }) },
      ...(expanded ? { action: { type: 'detail' } as const } : {}),
    }
  }

  if (key === PAGE_UP || key === PAGE_DOWN) {
    if (!state.expanded) return { state }
    const page = Math.max(1, state.page ?? 1)
    const max = state.scrollMax ?? Number.MAX_SAFE_INTEGER
    const cur = Math.min(state.scroll ?? 0, max)
    const scroll = key === PAGE_UP ? Math.max(0, cur - page) : Math.min(max, cur + page)
    return { state: { ...state, scroll } }
  }

  if (/^[1-9]$/.test(key)) {
    const idx = Number(key) - 1
    if (idx < state.rows.length) {
      const target = state.rows[idx]!
      return { state: reselect(state, state.selected === target.id ? undefined : target.id) }
    }
    return { state }
  }

  if (key === '\x1b[A' || key === 'k') {
    if (state.rows.length === 0) return { state }
    const curIdx = state.selected ? state.rows.findIndex(r => r.id === state.selected) : -1
    const nextIdx = curIdx <= 0 ? state.rows.length - 1 : curIdx - 1
    return { state: reselect(state, state.rows[nextIdx]!.id) }
  }

  if (key === '\x1b[B' || key === 'j') {
    if (state.rows.length === 0) return { state }
    const curIdx = state.selected ? state.rows.findIndex(r => r.id === state.selected) : -1
    const nextIdx = curIdx < 0 || curIdx >= state.rows.length - 1 ? 0 : curIdx + 1
    return { state: reselect(state, state.rows[nextIdx]!.id) }
  }

  if (key === '\x1b') {
    if (state.armedStop) return { state: { ...state, armedStop: undefined } }
    if (state.expanded) return { state: { ...state, expanded: false, detail: undefined, scroll: 0 } }
    if (state.selected) return { state: reselect(state, undefined) }
  }

  return { state }
}

/** The collector health line (C-health); `undefined` = not read yet. */
export function healthText(h: Health | undefined): string {
  if (!h) return '收件：unknown（尚未讀取）'
  switch (h.kind) {
    case 'none':
      return '收件：無收件者'
    case 'initializing':
      return '收件：initializing'
    case 'collecting':
      return (h.mode === 'on-request' ? '收件：MCP：host 呼叫 tool 時才收' : `收件：collecting（${h.channel}）`) + (h.reason ? ` · ${h.reason}` : '')
    case 'paused':
      return `收件：paused（${h.reason}）`
    case 'stale':
      return `收件：stale（${h.ageS === undefined ? '從未 beat' : `beat ${h.ageS}s 前`}）`
    case 'unknown':
      return `收件：unknown（${h.reason}）`
  }
}

const hint = (key: string, label: string, words: boolean) => (words ? `[ ${key} ${label} ]` : `[ ${key} ]`)

/** Header key hints, longest first; the renderer takes the first that fits (R4.6). */
export function headerHints(state: TuiState, now: number): string[] {
  const clearArmed = state.armedStop?.id === CLEAR_ID && now < state.armedStop.until
  const keys: [string, string][] = state.viewer
    ? [['r', 'refresh'], ['q', 'quit']]
    : [
        ['n', 'resume'],
        ['+', 'assign'],
        ['r', 'refresh'],
        ...(state.rows.some(r => !r.project) ? [['c', clearButtonLabel(clearArmed)] as [string, string]] : []),
        ['q', 'quit'],
      ]
  const words = keys.map(([k, l]) => hint(k, l, true)).join(' ')
  const short = keys.map(([k, l]) => hint(k, l, false)).join(' ')
  return [`${words}  a all · j/k select`, words, short, hint('q', 'quit', false)]
}

/** The selected row's key hints, longest first. */
export function rowHints(state: TuiState, r: PanelRow, now: number): string[] {
  if (r.project) return ['project session · read-only  Enter detail', 'read-only']
  if (state.viewer) return [`${READ_ONLY}  Enter detail`, '唯讀']
  const armed = (id: string) => state.armedStop?.id === id && now < state.armedStop.until
  const keys: [string, string][] = [['t', 'tell']]
  if (r.state === 'running' || r.state === 'stalled') keys.push(['i', 'interrupt'])
  keys.push(['x', stopButtonLabel(r.d.name, armed(r.id))])
  if (r.d.seq) {
    const force = r.reservation === 'stale'
    keys.push(['-', armed(`cancel:${r.id}`) ? `${force ? 'force-close' : 'cancel'} episode ${r.d.seq}? press again` : force ? 'force-close' : 'cancel'])
  }
  keys.push(['U', armed(`unlock:${r.id}`) ? 'unlock (maintenance)? press again' : 'unlock'])
  const tail = armed(r.id) ? `  \x1b[31mends its tmux session · ${Math.ceil((state.armedStop!.until - now) / 1000)}s\x1b[0m` : ''
  return [
    `${keys.map(([k, l]) => hint(k, l, true)).join(' ')}  Enter ${state.expanded ? 'mirror' : 'detail'}${tail}`,
    keys.map(([k, l]) => hint(k, l, true)).join(' ') + tail,
    keys.map(([k, l]) => hint(k, l, false)).join(' '),
  ]
}

function fitFirst(options: string[], width: number): string {
  return options.find(o => cellWidth(o) <= width) ?? truncateAnsi(options.at(-1) ?? '', width)
}

/** The first empty state that holds (R4.7): read failure, filtered out, nothing outstanding. */
export function emptyText(state: TuiState): string {
  if (state.loadError) return `Could not read the ledger: ${state.loadError}`
  if (state.all.length) return `No rows shown: ${state.all.length} worker(s) of other sessions are filtered out — press a to show all`
  return 'No workers outstanding.'
}

/** Lines of the detail view (R4.3): row state and result state are separate lines. */
export function detailText(r: PanelRow, det: EpisodeDetail | { kind: 'project' }): string[] {
  if (det.kind === 'project') return [`project session ${r.d.name}: not a ledger worker; no episode, no result`]
  const out = [`row: ${r.state} · ${r.d.profile} ${r.d.name} · episode ${r.d.seq ?? 0}`]
  if (det.kind === 'no-episode') out.push('result: none — no episode yet (a resumed worker gets one at its first tell)')
  else if (det.kind === 'no-result') out.push(`result: not written yet · ${det.resultPath}`)
  else if (det.kind === 'error') out.push(`result: unreadable — ${det.reason} · ${det.resultPath}`)
  else {
    out.push(`result: ${det.status ?? '(no status)'}${det.otherEpisode ? ' (names another episode)' : ''} · ${det.resultPath}`)
  }
  const blocked = r.blockedReason ?? (det.kind === 'result' ? det.blockedReason : undefined)
  if (blocked) out.push(`blocked: ${blocked}`)
  if (det.kind === 'result') {
    out.push(det.summary ? 'summary:' : 'summary: (none)')
    if (det.summary) out.push(...det.summary.split('\n'))
  }
  return out
}

/** Mirror or detail rows below the selected row; fewer and it is not drawn. */
export const BODY_MIN = 3
/** The body's separator and its last line (see-whole / scroll position). */
const BODY_CHROME = 2

export type TuiLayout = {
  status: number
  /** Index of the first row shown, how many are shown, how many are not. */
  first: number
  list: number
  hidden: number
  /** The `+N more` line. */
  more: number
  /** Lines under the selected row before the body (summary, key hints). */
  selExtra: number
  /** Mirror or detail content rows: what capture asks for (R4.2). */
  body: number
  footer: number
}

/**
 * The one layout (R4.1): title 1, then status lines, then at least one row (the
 * selected one), its extra lines, the footer, then more rows, and what is left is
 * the body. Every count is clamped, so the sum never exceeds `height`.
 */
export function layoutOf(
  height: number,
  p: { status: number; rows: number; sel: number; selExtra: number; footer: number },
): TuiLayout {
  let left = Math.max(0, height - 1)
  const status = Math.min(p.status, left)
  left -= status
  if (p.rows === 0 || left === 0) {
    return { status, first: 0, list: 0, hidden: p.rows, more: 0, selExtra: 0, body: 0, footer: Math.min(p.footer, left) }
  }
  left -= 1
  const selExtra = p.sel >= 0 ? Math.min(p.selExtra, left) : 0
  left -= selExtra
  const footer = Math.min(p.footer, left)
  left -= footer
  const moreFor = (n: number) => (n < p.rows ? 1 : 0)
  const want = BODY_MIN + BODY_CHROME
  const reserve = p.sel >= 0 && moreFor(1) + want <= left ? want : 0
  let list = 1
  while (list < p.rows && list + moreFor(list + 1) + reserve <= left) list += 1
  left -= list - 1
  const more = moreFor(list) && left >= 1 ? 1 : 0
  left -= more
  const body = p.sel >= 0 && left >= want ? left - BODY_CHROME : 0
  const first = p.sel >= 0 ? Math.max(0, Math.min(p.sel - list + 1, p.rows - list)) : 0
  return { status, first, list, hidden: p.rows - list, more, selExtra, body, footer }
}

type Sections = { title: string; status: string[]; selExtra: string[]; footer: string[]; sel: number }

function sectionsOf(state: TuiState, width: number, now: number, gate?: Gate): Sections {
  const tmuxRunning = state.rows.filter(r => !r.project && !r.terminal).length
  const me = state.owner
  const counts = `${me ? `@${me.slice(0, 8)} · ` : ''}tmux ${tmuxRunning}`
  const hints = headerHints(state, now)
  let title = ''
  outer: for (const h of hints) {
    for (const t of [` workers · ${counts} `, ` ${counts} `]) {
      if (cellWidth(t) + cellWidth(h) <= width) {
        title = `${t}${h}`
        break outer
      }
    }
  }
  if (!title) title = ` ${counts} ${hints.at(-1)}`
  const titleLine = `${ANSI_FG_BLACK}${ANSI_BG_CYAN}${ANSI_BOLD}${padCells(truncateAnsi(title, width), width)}${ANSI_RESET}`

  const status: string[] = []
  const health = healthText(gate?.viewHealth)
  if (state.viewer) status.push(`\x1b[2mviewer — no session; ${READ_ONLY} · ${health}\x1b[0m`)
  else {
    const ok = gate?.viewHealth?.kind === 'collecting' && !gate.viewHealth.reason // a deferral shows in yellow
    status.push(`${ok ? '\x1b[2m' : '\x1b[33m'}${sanitizeAnsi(health)}\x1b[0m`)
  }
  if (state.adding) {
    const label =
      state.inputKind === 'tell'
        ? `t tell ${state.rows.find(r => r.id === state.inputFor)?.d.name ?? '?'}`
        : state.inputKind === 'assign'
          ? '+ assign <profile> <name> <brief-file>'
          : 'n resume [profile] <session-id> [name]'
    status.push(`  ${label}: ${state.resumeInput}█`)
  }
  if (state.rows.length === 0) status.push(`\x1b[2m${sanitizeAnsi(emptyText(state))}\x1b[0m`)

  const sel = state.rows.findIndex(r => r.id === state.selected)
  const selExtra: string[] = []
  if (sel >= 0) {
    const r = state.rows[sel]!
    if (r.summary && !state.expanded) {
      const sumColor = r.summary.startsWith('success') ? '\x1b[32m' : '\x1b[33m'
      selExtra.push(`    ${sumColor}${sanitizeAnsi(r.summary)}\x1b[0m`)
    }
    selExtra.push(`    ${fitFirst(rowHints(state, r, now), Math.max(0, width - 4))}`)
  }

  const footer: string[] = []
  const others = othersLine(state.all)
  if (others) {
    const glyphColor = others.running ? '\x1b[32m' : '\x1b[2m'
    footer.push(`${glyphColor}◌\x1b[0m [ a ${state.showAll ? '只看自己' : '展開'} · ${others.text} ]`)
  }
  if (state.statusMessage && now < (state.statusUntil ?? 0)) {
    footer.push(`\x1b[36mtmux-agent: ${sanitizeAnsi(state.statusMessage)}\x1b[0m`)
  }
  return { title: titleLine, status, selExtra, footer, sel }
}

/** The layout runTui sizes the capture and the detail page with: the same one render draws. */
export function tuiLayout(state: TuiState, width: number, height: number, now: number, gate?: Gate): TuiLayout & { detailTotal: number } {
  const s = sectionsOf(state, width, now, gate)
  const lay = layoutOf(height, { status: s.status.length, rows: state.rows.length, sel: s.sel, selExtra: s.selExtra.length, footer: s.footer.length })
  const detailTotal = state.expanded && state.detail && state.detail.id === state.selected ? wrapCells(state.detail.lines.join('\n'), width).length : 0
  return { ...lay, detailTotal }
}

export function renderTuiLines(
  state: TuiState,
  width: number,
  height: number,
  now: number,
  gate?: Gate,
): string[] {
  if (width < 1 || height < 1) return []
  const s = sectionsOf(state, width, now, gate)
  if (height <= 2) {
    const compact = `${state.rows.length} worker(s) · ${healthText(gate?.viewHealth)} · window too small (${height} rows)`
    return [s.title, truncateAnsi(compact, width)].slice(0, height)
  }
  const lay = layoutOf(height, { status: s.status.length, rows: state.rows.length, sel: s.sel, selExtra: s.selExtra.length, footer: s.footer.length })
  const fit = (line: string) => truncateAnsi(line, width)
  const lines: string[] = [s.title, ...s.status.slice(0, lay.status).map(fit)]

  for (let i = lay.first; i < lay.first + lay.list; i++) {
    const r = state.rows[i]!
    const isSelected = i === s.sel
    const digitPrefix = i < 9 ? `${i + 1}: ` : '   '
    const color = r.project ? ANSI_COLOR_MAP['blue'] : (ANSI_COLOR_MAP[STATE_COLOR[r.state]] ?? '')
    const glyphStr = `${color}${ANSI_BOLD}${rowGlyph(r)}${ANSI_RESET}`
    lines.push(fit(`${digitPrefix}${glyphStr}${sanitizeAnsi(rowLabel(r, isSelected))}`))
    if (!isSelected) continue
    lines.push(...s.selExtra.slice(s.selExtra.length - lay.selExtra).map(fit))
    if (lay.body === 0) continue
    const rule = `\x1b[2m${'─'.repeat(Math.max(0, Math.min(width, 60) - 1))}\x1b[0m`
    if (state.expanded) {
      const all = state.detail?.id === r.id ? wrapCells(state.detail.lines.join('\n'), width) : ['loading…']
      const top = Math.max(0, Math.min(state.scroll ?? 0, all.length - lay.body))
      lines.push(fit(rule))
      for (const l of all.slice(top, top + lay.body)) lines.push(l || ' ')
      const end = Math.min(all.length, top + lay.body)
      lines.push(fit(`\x1b[2mdetail ${all.length ? top + 1 : 0}–${end} of ${all.length} · PgUp/PgDn scroll · Enter mirror\x1b[0m`))
    } else if (state.mirror && state.mirror.id === r.id) {
      lines.push(fit(rule))
      for (const ml of state.mirror.lines.slice(-lay.body)) lines.push(fit(sanitizeAnsi(ml) || ' '))
      const seeWhole = r.project
        ? `See it whole: tmux attach -t ${exactSessionTarget(r.d.name)}`
        : `See it whole: agent-tmux ${r.d.profile} attach ${r.d.name}`
      lines.push(fit(`\x1b[2m${seeWhole}\x1b[0m`))
    }
  }

  if (lay.more) lines.push(fit(`\x1b[2m  +${lay.hidden} more — j/k moves the selection\x1b[0m`))
  lines.push(...s.footer.slice(s.footer.length - lay.footer).map(fit))
  return lines.slice(0, height)
}

/** stdin as the TUI found it. `restoreTerminal` puts it back. */
export interface TerminalEntry {
  raw: boolean
  flowing: boolean
}

/** Runs one terminal step; a failure comes back named after the step. */
function termStep(name: string, fn: () => unknown): Error | undefined {
  try {
    fn()
    return undefined
  } catch (err) {
    return new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}

/**
 * Best effort: every step runs even when one before it fails, and each failure is
 * returned (the caller reports it). `setRawMode(false)` makes libuv restore the
 * termios it saved when raw mode was first entered, so a tty that was already raw
 * before the TUI stays raw.
 */
export function restoreTerminal(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  entry: TerminalEntry = { raw: false, flowing: false },
): Error[] {
  const steps = [
    termStep(`setRawMode(${entry.raw})`, () => {
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(entry.raw)
    }),
    termStep('pause stdin', () => {
      if (!entry.flowing && typeof stdin.pause === 'function') stdin.pause()
    }),
    termStep('leave alt screen', () => stdout.write(ANSI_LEAVE_ALT)),
  ]
  return steps.filter((e): e is Error => e !== undefined)
}

/**
 * A step that fails stops the setup: the steps done before it are undone and the
 * error is thrown, so the TUI never runs on a half-set terminal.
 */
export function enterTerminal(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): TerminalEntry {
  const entry = { raw: stdin.isRaw === true, flowing: stdin.readableFlowing === true }
  const steps: [string, () => unknown][] = [
    ['setRawMode(true)', () => stdin.isTTY && typeof stdin.setRawMode === 'function' && stdin.setRawMode(true)],
    ['resume stdin', () => typeof stdin.resume === 'function' && stdin.resume()],
    ['enter alt screen', () => stdout.write(ANSI_ENTER_ALT)],
  ]
  for (const [k, [name, fn]] of steps.entries()) {
    const err = termStep(name, fn)
    if (!err) continue
    const undo = k > 0 ? restoreTerminal(stdin, stdout, entry) : []
    const also = undo.length ? `; undo failed too: ${undo.map(e => e.message).join('; ')}` : ''
    throw new Error(`terminal setup failed: ${err.message}${also}`, { cause: err })
  }
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
  // Bumped on every resize: a capture started before it was sized for the old
  // layout and is dropped when it lands (R4.1).
  let generation = 0

  const layout = () => tuiLayout(state, width, height, Date.now(), gate)

  // After quit (or any stop) nothing more is drawn, even by an action still in flight.
  const render = () => {
    if (stopped) return
    const lay = layout()
    state.page = lay.body
    state.scrollMax = Math.max(0, lay.detailTotal - lay.body)
    const lines = renderTuiLines(state, width, height, Date.now(), gate)
    stdout.write(ANSI_CLEAR_HOME + lines.join('\r\n'))
  }

  const refreshRows = async (): Promise<boolean> => {
    if (refreshing) return false
    refreshing = true
    try {
      if (root) await observeView(host, gate, root)
      state.loadError = root ? gate.viewError : 'no state root (TMUX_AGENT_DIR, XDG_STATE_HOME and HOME are all unset)'
      const rows = await panelRows(host, gate, root)
      state.all = rows
      const panelLike = { rows: state.rows, all: state.all, showAll: state.showAll, selected: state.selected }
      const was = state.rows.find(r => r.id === state.selected)
      setRows(panelLike as any, rows)
      // A row id carries its episode (`name#seq`): after a tell the selection follows the worker.
      if (was && !panelLike.selected) panelLike.selected = panelLike.rows.find(r => r.project === was.project && r.d.name === was.d.name)?.id
      if (panelLike.selected !== state.selected) state = { ...state, expanded: false, detail: undefined, scroll: 0, mirror: undefined }
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
    const rows = layout().body
    if (rows < 1) return
    const gen = generation
    capturing = true
    try {
      const lines = row.project ? await mirrorProject(host, row.d.name, rows) : await mirrorOf(host, row.d, rows)
      if (gen === generation && state.selected === row.id) {
        state.mirror = { id: row.id, lines }
      }
    } finally {
      capturing = false
    }
  }

  // Read-only, whole (R4.3). A read error is shown in the detail, not thrown.
  const loadDetail = async () => {
    const row = state.rows.find(r => r.id === state.selected)
    if (!row || !state.expanded) return
    const det: EpisodeDetail | { kind: 'project' } = row.project ? { kind: 'project' } : await episodeDetail(host, row.d)
    if (state.selected === row.id && state.expanded) state.detail = { id: row.id, lines: detailText(row, det) }
  }

  const say = (text: string) => {
    state.statusMessage = text
    state.statusUntil = Date.now() + STATUS_MS
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
    generation += 1
    state.mirror = undefined
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
  let restoreErrors: Error[] = []
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
    // Printed after the alt screen is left (the last restore step), so it stays readable.
    restoreErrors = restoreTerminal(stdin, stdout, entry)
    for (const err of restoreErrors) process.stderr.write(`tui: terminal restore failed: ${err.message}\n`)
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
    const ms = parser.waitMs()
    if (ms !== undefined) {
      escTimer = setTimeout(() => {
        escTimer = undefined
        runKeys(parser.expire())
      }, ms)
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
      say(`resume — ${out.ok ? 'ok' : 'FAILED'}: ${out.text}`)
      if (out.ok) await refreshRows()
      render()
      return
    }
    if (action.type === 'tell') {
      const out = await tellWorker(host, action.row.d, action.text)
      say(`tell ${action.row.d.name} — ${out.ok ? 'ok' : 'FAILED'}: ${out.text}`)
      await refreshRows()
      render()
      return
    }
    if (action.type === 'assign') {
      // `<profile> <name> <brief-file>`: the file is the rest, so a path may hold spaces.
      const [profile, name, ...file] = action.value.split(/\s+/)
      if (!profile || !name || !file.length) {
        say('assign — FAILED: assign takes <profile> <name> <brief-file>')
        render()
        return
      }
      const path = resolve(cwd, file.join(' '))
      const brief = await readFile(path, 'utf8').catch((error: Error) => error)
      if (brief instanceof Error) {
        say(`assign — FAILED: cannot read the brief ${path}: ${brief.message}`)
        render()
        return
      }
      const h = gate.viewHealth
      const got = await assignWorker(host, { profile, name, dir: cwd, brief }, {
        owner: session ?? '',
        ownerCwd: cwd,
        down: () => (h && h.kind !== 'collecting' && h.kind !== 'initializing' ? healthText(h) : undefined),
      })
      say('deny' in got ? `assign — FAILED: ${got.deny}` : `assign — ok: ${got.receipt}`)
      await refreshRows()
      render()
      return
    }
    // Same core calls as `workers.cli.node.ts cancel|unlock`; the second press is the confirm.
    if (action.type === 'cancel') {
      const out = await cancelEpisode(host, action.row.d.name, action.row.d.seq ?? 0, { force: action.force === true })
      say(`cancel ${action.row.d.name} — ${out.ok ? 'ok' : 'FAILED'}: ${out.text}`)
      await refreshRows()
      render()
      return
    }
    if (action.type === 'unlock') {
      const out = await unlockWorker(host, action.row.d.name, UNLOCK_WORD)
      say(`unlock ${action.row.d.name} — ${out.ok ? 'ok' : 'FAILED'}: ${out.text}`)
      render()
      return
    }
    if (action.type === 'detail') {
      await loadDetail()
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
          await (state.expanded ? loadDetail() : captureSelected())
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
  // A quit that left the tty broken is not a success: main exits 1, so a wrapper sees it.
  if (restoreErrors.length) throw new Error(`terminal restore failed: ${restoreErrors.map(e => e.message).join('; ')}`)
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
