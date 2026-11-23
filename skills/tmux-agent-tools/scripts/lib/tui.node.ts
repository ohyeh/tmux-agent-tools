// A full-screen terminal TUI of the workers panel for any host (Codex, Cursor, agy,
// plain shell), sharing the Claude mod's row model, actions, and confirmations from
// the core (p0-contract.md §9).
//
// Usage: node tui.node.ts [--session <id>] [--cwd <dir>]
// Without a session it is a viewer: every row on the machine, read-only (D-viewer).
// Keys (header):
//   n       resume a CLI session by id (input line)
//   +       assign a new worker: <profile> <name> <brief-file> (input line)
//   r       refresh rows and clear the selection
//   d       delete the selected row (press twice; 預覽, 編輯 and viewer): a worker with no live
//           tmux session moves to .v3/.removed/<name>-<ms>; a finished own hc row runs `hc rm`.
//           A live or unknown session is refused.
//   c       clear all workers and finished own hc rows (press twice)
//   q       quit (the terminal is restored)
//   a       toggle all / only this session's workers
//   預覽 is the default. e enters 編輯 when this TUI holds an owner; otherwise the session picker.
//   1-9, j / k     select a row
//   ↑ / ↓, b / f   scroll (PgUp / PgDn and the wheel too). ↑/↓ do not move the selection.
// Keys (編輯, selected row):
//   t       tell: send the worker a follow-up (input line)
//   i       interrupt a running or stalled worker
//   x       stop the worker (press twice)
//   -       cancel its episode (press twice; the pane is untouched)
//   U       unlock its action lock, maintenance (press twice; only a provably gone holder)
//   Enter   detail view of a worker; b / f scroll it
//   Esc     disarm, close detail, 編輯 → 預覽, then deselect. 預覽 with nothing selected quits (T6b).

import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { readlinkSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import {
  type Host,
  type PanelRow,
  type Gate,
  newGate,
  readHc,
  hcLook,
  hcMark,
  elapsed,
  rowRepo,
  hcBin,
  hcSocketLive,
  hcId,
  hcFinished,
  mirrorHc,
  stopHc,
  sendHc,
  interruptHc,
  isOwnHc,
  captureError,
  type HcAgent,
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
  UNLOCK_WORD,
  type EpisodeDetail,
  type Health,
  type MirrorCapture,
  rootOf,
  stopWorker,
  stopAll,
  writeTuiAudit,
  type TuiAudit,
  interruptWorker,
  resumeWorker,
  tellWorker,
  assignWorker,
  cancelEpisode,
  clearIncomplete,
  deleteWorker,
  unlockWorker,
  episodeDetail,
  mirrorOf,
  mirrorProject,
  MIRROR_PROBE_MS,
  fitWorker,
  exactSessionTarget,
  observeRows,
  sweepStalls,
  claimTui,
  releaseTui,
  focusTui,
  dropLaunchFile,
  ensureSessionDir,
  tuiLaunchDir,
  tuiLaunchPath,
  withTmuxSocket,
  ageText,
  type Flight,
  processId,
  sessionDirOf,
  v3Of,
  type ProcessId,
  type Scan,
  type TuiClaimResult,
  type TuiFocus,
  type TuiLocator,
} from './workers.ts'
import { sessionLiveness, type Liveness } from './ledger.ts'
import { nodeHost } from './host.node.ts'
import { coreVersion } from './collector.node.ts'
import { graphemes, graphemeWidth as widthOf } from './width.ts'

export const NODE_FLOOR = [22, 18, 0]

// `?2004h` turns on bracketed paste: the terminal wraps a paste in ESC[200~ … ESC[201~,
// so a pasted `q` or `x` is text, not a key (KeyParser). `?2004l` turns it off again.
// Phase 1 keeps mouse reporting OFF (I7) and sets `?1007h`, so drag-select is the
// terminal's and the wheel arrives as ↑/↓. `?1007l` clears that on the way out.
export const ANSI_MOUSE_OFF = '\x1b[?1006l\x1b[?1000l'
export const ANSI_LEAVE_ALT = `${ANSI_MOUSE_OFF}\x1b[?1007l\x1b[?2004l\x1b[?25h\x1b[?1049l\x1b]0;\x07`
/** Alt screen, paste, alternate scroll, hidden cursor, window title, clear. No mouse reporting. */
export function altEnter(title: string): string {
  const safe = title.replace(/[\x00-\x1f\x7f]/g, '')
  return `\x1b[?1049h\x1b[?2004h\x1b[?1007h\x1b[?25l\x1b]0;${safe}\x07\x1b[2J\x1b[H`
}
/** Lines one wheel notch scrolls. */
const WHEEL_LINES = 3
export const ANSI_HIDE_CURSOR = '\x1b[?25l'
export const ANSI_SHOW_CURSOR = '\x1b[?25h'
export const ANSI_CLEAR_HOME = '\x1b[2J\x1b[H'
/** Synchronized output (DEC 2026): the terminal shows the frame whole. Every frame starts with it. */
export const ANSI_SYNC_START = '\x1b[?2026h'
const ANSI_SYNC_END = '\x1b[?2026l'
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

/** `TMUX_AGENT_AMBIGUOUS_WIDTH` (1 or 2, default 1): cells for an East Asian Width A character. */
// Default 1: tmux lays out the mirrored pane with 1, so 2 cut a worker's `─` rule at half the width.
export function ambiguousWidth(): 1 | 2 {
  return process.env.TMUX_AGENT_AMBIGUOUS_WIDTH === '2' ? 2 : 1
}

export { graphemes } from './width.ts'
/** One grapheme's cells (width.ts), with the ambiguous width from the environment by default. */
export function graphemeWidth(g: string, ambiguous: number = ambiguousWidth()): number {
  return widthOf(g, ambiguous)
}

/** Printable ASCII is one cell per character at any ambiguous width, and never joins into a longer grapheme. */
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/

/** Terminal cells of `text`. SGR escapes count 0. The TUI's one width function. */
export function cellWidth(text: string): number {
  const plain = stripAnsi(text)
  if (PRINTABLE_ASCII_RE.test(plain)) return plain.length
  const amb = ambiguousWidth()
  let n = 0
  for (const g of graphemes(plain)) n += graphemeWidth(g, amb)
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
    const plain = stripAnsi(sanitizeAnsi(para))
    if (PRINTABLE_ASCII_RE.test(plain)) {
      for (let i = 0; i < plain.length; i += width) out.push(plain.slice(i, i + width))
      if (!plain.length) out.push('')
      continue
    }
    let line = ''
    let cur = 0
    for (const g of graphemes(plain)) {
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
export type InputKind = 'resume' | 'tell' | 'assign' | 'hcSend'

export interface TuiState {
  rows: PanelRow[]
  all: PanelRow[]
  showAll: boolean
  selected?: string
  /** One press-twice confirmation: a row id (stop), CLEAR_ID, `cancel:<id>`, `unlock:<id>` or `delete:<id>`. */
  armedStop?: { id: string; from: number; until: number }
  adding: boolean
  resumeInput: string
  inputKind?: InputKind
  /** The row a `tell` input is for. */
  inputFor?: string
  mirror?: { id: string } & MirrorCapture
  /** Enter on the selected row: its detail replaces the mirror. */
  expanded?: boolean
  /** Narrow (<80): one pane. Enter walks list → preview → Detail. */
  narrowView?: 'list' | 'preview'
  detail?: { id: string; lines: string[] }
  /** First detail line shown (PgUp/PgDn). */
  scroll?: number
  /** Mirror lines scrolled back from the bottom (PgUp/PgDn); 0 follows live. */
  back?: number
  /** Body rows of the last layout and the last scroll offset; runTui sets both. */
  page?: number
  scrollMax?: number
  statusMessage?: string
  statusUntil?: number
  owner?: string
  /** `AGENT_TMUX_VERSION` beside lib/: the title names the code that drew it, as the band's MOD_VERSION does. */
  version?: string
  /** No --session and no TMUX_AGENT_SESSION: every row, read-only (D-viewer). */
  viewer?: boolean
  /** OWNER: this session's hc terminal (`--hc-parent`, else `$HC_TERMINAL_ID`); every hc mutation and the finished filter use it. */
  hcParent?: string
  /** SELF: this process's own `$HC_TERMINAL_ID`, used only to hide this terminal's own row (never for the finished filter). */
  hcSelf?: string
  /** 預覽 is the default. Mutating keys act only in 編輯 (I3). */
  mode?: 'preview' | 'edit' | 'picker'
  /** SessionPicker highlight (T2a). */
  pickerIndex?: number
  pickerEntries?: PickerEntry[]
  /** Set after a pick. `unknown` refuses n, +, and resume (C03). Absent means the launch cwd is known. */
  cwdFrom?: 'collector' | 'workers' | 'unknown'
  heldClaim?: { session: string; token: string; me: ProcessId }
  /** Why the ledger could not be read (the third empty state). */
  loadError?: string
  /** Last successful rows read, and whether that job is in flight (T9). */
  rowsAge?: Flight
  /** Every hc agent, all machines, with its `parent`: rows after the tmux rows in the one list; `?` = the read failed; unset = no hc on PATH or no running core. */
  herdr?: HcAgent[] | '?'
  /** What one `hc get` told when an address first appeared; never refreshed, dropped when the address leaves `hc ls`. `{}` = the get failed. */
  hcInfo?: Record<string, HcInfo>
  /** The selected hc row's own `hc get` (taken with each capture): its `status.msg` is the summary line, coloured by the `status.state` of the same get. */
  hcMsg?: { address: string; msg?: string; status?: string; finished?: boolean }
  quit: boolean
}

export type TuiAction =
  | { type: 'quit' }
  | { type: 'refresh' }
  | { type: 'stop'; row: PanelRow }
  | { type: 'stopAll' }
  | { type: 'interrupt'; row: PanelRow }
  | { type: 'hcSend'; address: string; text: string }
  | { type: 'interruptHc'; address: string }
  | { type: 'resume'; value: string }
  | { type: 'tell'; row: PanelRow; text: string }
  | { type: 'assign'; value: string }
  | { type: 'cancel'; row: PanelRow; force?: boolean }
  | { type: 'unlock'; row: PanelRow }
  | { type: 'clear'; row: PanelRow }
  | { type: 'delete'; row: PanelRow }
  | { type: 'detail' }
  | { type: 'attach'; address: string }
  | { type: 'stopHc'; hc: HcAgent }
  | { type: 'mouseOff' }
  | { type: 'openPicker' }
  | { type: 'pick'; index: number }

export { hcId, mirrorHc }

/** The hc rows of the list: they follow the tmux rows, live before finished (`readHc` sorts them). */
export function hcAgents(state: TuiState): HcAgent[] {
  return Array.isArray(state.herdr) ? state.herdr : []
}

export function selectedHc(state: TuiState): HcAgent | undefined {
  if (!state.selected?.startsWith('hc:')) return undefined
  const addr = state.selected.slice(3)
  return hcAgents(state).find(a => a.address === addr)
}

function navIds(state: TuiState): string[] {
  return [...state.rows.map(r => r.id), ...hcAgents(state).map(a => hcId(a.address))]
}

const ROW_WORKER_KEYS: ReadonlySet<string> = new Set(['t', 'T', 'i', 'I', '-', 'U'])

const armedTargetId = (id: string) => (/^(cancel|unlock|delete):/.test(id) ? id.slice(id.indexOf(':') + 1) : id)
const isHcArmed = (id: string) => armedTargetId(id).startsWith('hc:')
const hasClearable = (state: TuiState) =>
  state.rows.some(r => !r.project) || (Array.isArray(state.herdr) && state.herdr.some(hcFinished))

export type HcGetDetail = {
  address: string
  name?: string
  agent: string
  /** `status.state` of the status object (or the plain string hc once gave). */
  status: string
  cwd: string
  parent?: string
  turn?: number | string
  foregroundCwd?: string
  /** The rest of the status object: what the agent said (`msg`), what kind of block (`kind`), who said it (`app`). */
  msg?: string
  kind?: string
  app?: string
  /** Basename of `foreground.argv[0]`: the program that runs, where `agent` says `env`. */
  program?: string
  createdMs?: number
  finishedMs?: number
  exitCode?: number
  reason?: string
  error?: string
}

/** What the row keeps of its first `hc get`. */
export type HcInfo = {
  createdMs?: number
  finishedMs?: number
  program?: string
  /** The get was taken on a finished row (or the one extra get at the live→finished change ran): no get follows. */
  final?: boolean
}

export function parseHcGet(stdout: string, fallback: HcAgent): HcGetDetail {
  const raw = JSON.parse(stdout) as Record<string, unknown>
  if (raw.error && typeof raw.error === 'object') {
    const err = raw.error as { kind?: unknown; message?: unknown }
    throw new Error(`hc: ${String(err.kind)}: ${String(err.message)}`)
  }
  const doc =
    !('address' in raw) && raw.terminal && typeof raw.terminal === 'object'
      ? (raw.terminal as Record<string, unknown>)
      : raw
  const str = (v: unknown, fb: string) => (typeof v === 'string' && v ? v : fb)
  const opt = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined)
  const fg = obj(doc.foreground)
  const st = obj(doc.status)
  const turn = typeof doc.turn === 'number' || typeof doc.turn === 'string' ? doc.turn : undefined
  const argv0 = Array.isArray(fg?.argv) ? opt(fg.argv[0]) : undefined
  const program = argv0?.split('/').filter(Boolean).at(-1)
  const created = num(doc.created_ms)
  const finished = num(doc.finished_ms)
  const exitCode = num(doc.exit_code)
  return {
    address: str(doc.address, fallback.address),
    name: 'name' in doc ? opt(doc.name) : fallback.name,
    agent: str(doc.agent, fallback.agent),
    status: st ? str(st.state, fallback.status) : str(doc.status, fallback.status),
    cwd: str(doc.cwd, fallback.cwd),
    parent: 'parent' in doc ? opt(doc.parent) : fallback.parent,
    ...(turn !== undefined ? { turn } : {}),
    ...(opt(fg?.cwd) ? { foregroundCwd: opt(fg?.cwd) } : {}),
    ...(opt(st?.msg) ? { msg: opt(st?.msg) } : {}),
    ...(opt(st?.kind) ? { kind: opt(st?.kind) } : {}),
    ...(opt(st?.app) ? { app: opt(st?.app) } : {}),
    ...(program ? { program } : {}),
    ...(created !== undefined ? { createdMs: created } : {}),
    ...(finished !== undefined ? { finishedMs: finished } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(opt(doc.reason) ? { reason: opt(doc.reason) } : {}),
  }
}

export async function readHcDetail(host: Host, agent: HcAgent): Promise<HcGetDetail> {
  const fallback: HcGetDetail = {
    address: agent.address,
    ...(agent.name ? { name: agent.name } : {}),
    agent: agent.agent,
    status: agent.status,
    cwd: agent.cwd,
    ...(agent.parent ? { parent: agent.parent } : {}),
  }
  const bin = await hcBin(host)
  if (!bin) return { ...fallback, error: 'hc is not on PATH' }
  if (!(await hcSocketLive(host))) return { ...fallback, error: 'hc core is not running' }
  const probe = await host
    .run([bin, 'get', agent.address, '--json'], host.cwd() ?? '/', MIRROR_PROBE_MS)
    .catch((err: unknown) => err)
  const error = captureError(probe)
  if (error) return { ...fallback, error }
  try {
    return parseHcGet((probe as { stdout: string }).stdout, agent)
  } catch (err) {
    return { ...fallback, error: err instanceof Error ? err.message : String(err) }
  }
}

const isoSeconds = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + 'Z'

export function hcDetailText(det: HcGetDetail, mirror?: MirrorCapture): string[] {
  const out = [
    `address: ${det.address}`,
    `name: ${det.name ?? '(none)'}`,
    `agent: ${det.agent}`,
    `status: ${det.status || '-'}${det.kind ? ` (${sanitizeAnsi(det.kind)})` : ''}`,
    ...(det.msg ? [`message: ${sanitizeAnsi(det.msg)}`] : []),
    `cwd: ${det.cwd}${det.foregroundCwd && det.foregroundCwd !== det.cwd ? ` (now: ${det.foregroundCwd})` : ''}`,
    `parent: ${det.parent ? `@${det.parent}` : '未記錄'}`,
    `turn: ${det.turn !== undefined ? String(det.turn) : '-'}`,
    ...(det.program ? [`program: ${sanitizeAnsi(det.program)}`] : []),
    ...(det.createdMs !== undefined ? [`created: ${isoSeconds(det.createdMs)}`] : []),
    ...(det.finishedMs !== undefined ? [`finished: ${isoSeconds(det.finishedMs)}`] : []),
    ...(det.exitCode !== undefined || det.reason ? [`exit: ${det.exitCode ?? '-'}${det.reason ? ` · ${sanitizeAnsi(det.reason)}` : ''}`] : []),
  ]
  if (det.error) out.push(`get error: ${det.error}`)
  out.push('preview:')
  if (!mirror) out.push('(no preview yet)')
  else if (mirror.error) out.push(`capture failed: ${mirror.error}`)
  else if (!mirror.lines.length) out.push('(the pane is empty)')
  else out.push(...mirror.lines)
  return out
}

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
/** Mirror capture depth: tmux's default history-limit. */
export const MIRROR_HISTORY = 2000
export const PAGE_UP = '\x1b[5~'
export const PAGE_DOWN = '\x1b[6~'
export const READ_ONLY = '唯讀；帶 --session 才能操作'
/** I3: a mutating key in 預覽 names this reason and does not act. */
export const PREVIEW_ONLY = '預覽；按 e 進入編輯'
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
/** KeyParser saw an X10 mouse report: the terminal ignored SGR 1006. */
export const X10_MOUSE = '\x00x10mouse'

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
    if (this.buf.startsWith('\x1b[M')) {
      this.buf = ''
      return [X10_MOUSE]
    }
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
        // X10 mouse report (a terminal that ignores SGR 1006): not parsed, only detected, and
        // the TUI then turns mouse reporting off. Its 3 payload bytes are always >= 0x20, so
        // a control byte (Ctrl-C) ends it and is read as its own key.
        // shortcut: a payload byte >= 0x80 (column/row > 95) is merged by the UTF-8 decoder, so
        // up to 2 chars can leak as keys once before mouse is off; parse bytes before the
        // decoder only if a terminal in use ever answers in X10.
        else if (rest.startsWith('\x1b[M')) {
          let k = 3
          while (k < 6 && k < rest.length && rest.charCodeAt(k) >= 0x20) k++
          if (k < 6 && k === rest.length) break
          out.push(X10_MOUSE)
          i += k
          continue
        }
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
/**
 * One rows tick (I14). An armed confirm stays when the selection and its target
 * row stay. It clears when the selection changes or that row is gone.
 */
export function applyRowsTick(state: TuiState, rows: PanelRow[]): TuiState {
  const hcSelected = selectedHc(state) !== undefined
  const panelLike = { rows: state.rows, all: rows, showAll: state.showAll, selected: hcSelected ? undefined : state.selected }
  const was = hcSelected ? undefined : state.rows.find(r => r.id === state.selected)
  setRows(panelLike as any, rows)
  if (was && !panelLike.selected) {
    panelLike.selected = panelLike.rows.find(r => r.project === was.project && r.d.name === was.d.name)?.id
  }
  const nextSelected = hcSelected ? state.selected : panelLike.selected
  const selChanged = nextSelected !== state.selected
  let armed = state.armedStop
  if (armed && armed.id !== CLEAR_ID && !isHcArmed(armed.id)) {
    const rowId = armedTargetId(armed.id)
    if (!panelLike.rows.some(r => r.id === rowId)) armed = undefined
  }
  if (selChanged) armed = undefined
  return {
    ...state,
    all: rows,
    rows: panelLike.rows,
    selected: nextSelected,
    armedStop: armed,
    ...(selChanged ? { expanded: false, detail: undefined, scroll: 0, mirror: undefined, narrowView: undefined } : {}),
  }
}

export function applyHerdrTick(state: TuiState, herdr: HcAgent[] | '?' | undefined): TuiState {
  // The cache keeps an address only while `hc ls` lists it; a failed read (`?`) says nothing about who left.
  const listed = Array.isArray(herdr) ? new Set(herdr.map(a => a.address)) : undefined
  const hcInfo = herdr === undefined ? {} : listed ? Object.fromEntries(Object.entries(state.hcInfo ?? {}).filter(([k]) => listed.has(k))) : state.hcInfo
  const next: TuiState = { ...state, herdr, ...(hcInfo ? { hcInfo } : {}) }
  if (state.selected?.startsWith('hc:') && !selectedHc(next)) {
    return {
      ...next,
      selected: undefined,
      expanded: false,
      detail: undefined,
      scroll: 0,
      mirror: undefined,
      narrowView: undefined,
      ...(state.armedStop && isHcArmed(state.armedStop.id) ? { armedStop: undefined } : {}),
    }
  }
  if (state.armedStop && isHcArmed(state.armedStop.id) && armedTargetId(state.armedStop.id) !== state.selected) {
    return { ...next, armedStop: undefined }
  }
  return next
}

function scrollView(state: TuiState, dir: 'up' | 'down', step: number): { state: TuiState } {
  if (!state.expanded) {
    const m = state.mirror?.id === state.selected ? state.mirror : undefined
    if (!m) return { state }
    const page = Math.max(1, state.page ?? 1)
    const max = Math.max(0, m.lines.length - page)
    const cur = Math.min(state.back ?? 0, max)
    const back = dir === 'up' ? Math.min(max, cur + step) : Math.max(0, cur - step)
    return { state: { ...state, back } }
  }
  const max = state.scrollMax ?? Number.MAX_SAFE_INTEGER
  const cur = Math.min(state.scroll ?? 0, max)
  const scroll = dir === 'up' ? Math.max(0, cur - step) : Math.min(max, cur + step)
  return { state: { ...state, scroll } }
}

const reselect = (state: TuiState, selected: string | undefined): TuiState => ({
  ...state,
  selected,
  mirror: undefined,
  armedStop: undefined,
  expanded: false,
  detail: undefined,
  scroll: 0,
  back: 0,
})

export function nextKeyState(
  state: TuiState,
  key: string,
  now: number,
  screen?: { width: number; height: number },
): { state: TuiState; action?: TuiAction } {
  // Raw mode turns Ctrl-C into a key (no SIGINT): it quits from every mode, prompt included.
  if (key === '\x03') return { state: { ...state, quit: true }, action: { type: 'quit' } }
  if (key === INPUT_DROPPED) return say(state, 'input — dropped an unfinished paste or escape sequence (no end in time or too long)', now)
  if (key === X10_MOUSE) return { ...say(state, 'mouse — this terminal answers in X10, not SGR: mouse off; b/f scroll', now), action: { type: 'mouseOff' } }
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
      if (state.inputKind === 'hcSend') {
        // The prompt is for the address it opened on, not whatever is selected now.
        const address = state.inputFor?.startsWith('hc:') ? state.inputFor.slice(3) : undefined
        const hc = address ? hcAgents(state).find(a => a.address === address) : undefined
        // `hc ?` or the row missing is not proof it left: keep the draft and let a later tick resolve it.
        if (!hc || state.herdr === '?') {
          return say({ ...state, resumeInput: val }, `send — ${address ? `waiting for hc to list ${address} again` : 'that hc row is gone'}; the text is kept`, now)
        }
        if (hcFinished(hc)) return say({ ...state, resumeInput: val }, `send — ${address} has ended; the text is kept, Esc drops it`, now)
        if (!isOwnHc(hc, state.hcParent)) return say({ ...state, resumeInput: val }, `send — ${address} is another hc terminal's row; the text is kept, Esc drops it`, now)
        return { state: closed, action: { type: 'hcSend', address: hc.address, text: val } }
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

  if (state.mode === 'picker') {
    const n = state.pickerEntries?.length ?? 0
    const i = n ? Math.min(state.pickerIndex ?? 0, n - 1) : 0
    if (key === '\x1b') return say({ ...state, mode: 'preview' }, '仍是預覽', now)
    if (key === 'j' || key === '\x1b[B' || key === '\x1bOB') return { state: { ...state, pickerIndex: n ? (i + 1) % n : 0 } }
    if (key === 'k' || key === '\x1b[A' || key === '\x1bOA') return { state: { ...state, pickerIndex: n ? (i + n - 1) % n : 0 } }
    if (/^[1-9]$/.test(key)) {
      const idx = Number(key) - 1
      if (idx >= n) return { state }
      return { state: { ...state, pickerIndex: idx }, action: { type: 'pick', index: idx } }
    }
    if ((key === '\r' || key === '\n') && n) return { state, action: { type: 'pick', index: i } }
    return { state }
  }

  const row = state.selected ? state.rows.find(x => x.id === state.selected) : undefined
  const hc = row ? undefined : selectedHc(state)

  // Worker-row keys on an hc row: - and U do nothing (no episode, no lock). t/T/i/I fall through: the mode
  // gates just below speak outside edit (唯讀 / 預覽), and in edit the handler names why a row is not
  // actionable (another hc terminal, ended) or runs the hc send / interrupt.
  if (hc && ROW_WORKER_KEYS.has(key) && !['t', 'T', 'i', 'I'].includes(key)) return { state }

  // The one read-only gate: no key a viewer presses reaches an action (D-viewer).
  if (state.viewer && MUTATING_KEYS.has(key)) return say(state, READ_ONLY, now)
  // I3: 預覽 names the reason. 編輯 without an owner session does too.
  if (MUTATING_KEYS.has(key) && state.mode !== 'edit') return say(state, PREVIEW_ONLY, now)

  if (key === 'e' || key === 'E') {
    if (state.mode === 'edit') return { state: { ...state, mode: 'preview', armedStop: undefined } }
    if (state.viewer || !state.owner) return { state: { ...state, mode: 'picker', pickerIndex: 0 }, action: { type: 'openPicker' } }
    return { state: { ...state, mode: 'edit' } }
  }

  if (key === 'r' || key === 'R') {
    return { state: reselect(state, undefined), action: { type: 'refresh' } }
  }

  // A dir with no worker.json is not a worker yet: only `-` (clear) acts on it.
  if (row?.incomplete && ['x', 'X', 't', 'T', 'i', 'I', 'U'].includes(key)) {
    return say(state, `${row.d.name} — no worker.json yet; press - to clear it once it is old enough`, now)
  }

  if ((key === 'n' || key === 'N' || key === '+') && state.cwdFrom === 'unknown') {
    return say(state, 'cwd unknown；不能 resume 或 assign', now)
  }

  if (key === 'n' || key === 'N') {
    return { state: { ...state, adding: true, resumeInput: '', inputKind: 'resume' } }
  }

  if (key === '+') {
    return { state: { ...state, adding: true, resumeInput: '', inputKind: 'assign' } }
  }

  if (key === 't' || key === 'T') {
    if (hc) {
      if (hcFinished(hc)) return say(state, `send — ${hc.address} has ended; send reaches a live hc row only`, now)
      if (!isOwnHc(hc, state.hcParent)) return say(state, `send — ${hc.address} is another hc terminal's row; send works on your own rows only`, now)
      return { state: { ...state, adding: true, resumeInput: '', inputKind: 'hcSend', inputFor: hcId(hc.address) } }
    }
    if (!row || row.project) return { state }
    return { state: { ...state, adding: true, resumeInput: '', inputKind: 'tell', inputFor: row.id } }
  }

  if (key === 'a' || key === 'A') {
    const showAll = !state.showAll
    const panelLike = { rows: state.rows, all: state.all, showAll, selected: hc ? undefined : state.selected }
    setRows(panelLike as any, state.all)
    const nextSelected = hc ? state.selected : panelLike.selected
    const next = nextSelected === state.selected ? { ...state, mirror: hc ? state.mirror : undefined } : reselect(state, nextSelected)
    return { state: { ...next, showAll, rows: panelLike.rows, selected: nextSelected } }
  }

  if (key === 'c' || key === 'C') {
    if (!hasClearable(state)) return { state }
    return pressTwice(state, CLEAR_ID, now, { type: 'stopAll' })
  }

  if (key === 'x' || key === 'X') {
    // The verb is in the arm id: a live row that finishes inside the window re-arms instead of turning kill into rm.
    // Own parent only (brief default): digits reach every hc row, so a kill must not. A finished row in the
    // list is this session's own (the tick lists only own finished rows), so rm needs no parent check.
    if (hc) {
      if (!hcFinished(hc) && !isOwnHc(hc, state.hcParent)) return say(state, `stop — ${hc.address} is another hc terminal's row; stop works on your own rows only`, now)
      return pressTwice(state, hcFinished(hc) ? `delete:${hcId(hc.address)}` : hcId(hc.address), now, { type: 'stopHc', hc })
    }
    if (!row || row.project) return { state }
    return pressTwice(state, row.id, now, { type: 'stop', row })
  }

  if (key === '-') {
    if (!row || row.project) return { state }
    if (row.incomplete) return pressTwice(state, `cancel:${row.id}`, now, { type: 'clear', row })
    // A resumed worker has no episode until its first tell (seq 0).
    if (!row.d.seq) return say(state, `cancel — "${row.d.name}" has no episode yet`, now)
    return pressTwice(state, `cancel:${row.id}`, now, { type: 'cancel', row, ...(row.reservation === 'stale' ? { force: true } : {}) })
  }

  // Not a MUTATING_KEY: a dead row (or finished own hc row) is removable from the viewer and 預覽 too (owner ask).
  if (key === 'd') {
    if (hc) {
      if (!hcFinished(hc)) return { state }
      return pressTwice(state, `delete:${hcId(hc.address)}`, now, { type: 'stopHc', hc })
    }
    if (!row || row.project) return { state }
    // No worker.json: a writer may still publish it; clearIncomplete keeps the ORPHAN_MS grace.
    return pressTwice(state, `delete:${row.id}`, now, row.incomplete ? { type: 'clear', row } : { type: 'delete', row })
  }

  if (key === 'U') {
    if (!row || row.project) return { state }
    return pressTwice(state, `unlock:${row.id}`, now, { type: 'unlock', row })
  }

  if (key === 'i' || key === 'I') {
    if (hc) {
      if (hcFinished(hc)) return say(state, `interrupt — ${hc.address} has ended; nothing to interrupt`, now)
      if (!isOwnHc(hc, state.hcParent)) return say(state, `interrupt — ${hc.address} is another hc terminal's row; interrupt works on your own rows only`, now)
      // hc interrupt presses the program's own stop key; it never kills the terminal.
      return { state, action: { type: 'interruptHc', address: hc.address } }
    }
    if (row && !row.project && (row.state === 'running' || row.state === 'stalled')) {
      return { state, action: { type: 'interrupt', row } }
    }
    return { state }
  }

  if (key === '\r' || key === '\n') {
    // Narrow is one pane (frameMode, including a 38-col or 60x8 pane): Enter walks list → preview → Detail.
    // A project row has a mirror and no episode, so it stops on the preview.
    // In hc Detail, Enter attaches to the hc terminal (works in viewer mode too).
    if (narrowScreen(screen)) {
      if (!row && !hc) return { state }
      const view = state.narrowView ?? 'list'
      if (view !== 'preview') return { state: { ...state, narrowView: 'preview', expanded: false, detail: undefined, scroll: 0 } }
      if (row?.project) return { state }
      if (state.expanded) {
        return hc ? { state, action: { type: 'attach', address: hc.address } } : { state }
      }
      return {
        state: { ...state, narrowView: 'preview', expanded: true, scroll: 0, armedStop: undefined },
        action: { type: 'detail' },
      }
    }
    if (hc) {
      if (state.expanded) return { state, action: { type: 'attach', address: hc.address } }
      return {
        state: { ...state, expanded: true, scroll: 0, armedStop: undefined },
        action: { type: 'detail' },
      }
    }
    // A project session has no episode to show: Enter keeps the mirror.
    if (!row || row.project) return { state }
    const expanded = !state.expanded
    return {
      state: { ...state, expanded, scroll: 0, armedStop: undefined, ...(expanded ? {} : { detail: undefined }) },
      ...(expanded ? { action: { type: 'detail' } as const } : {}),
    }
  }

  // ↑/↓ scroll one line (CSI and SS3). Wheel-as-arrow from ?1007 lands here. Left/right are accepted and do nothing.
  if (key === '\x1b[A' || key === '\x1bOA') return scrollView(state, 'up', 1)
  if (key === '\x1b[B' || key === '\x1bOB') return scrollView(state, 'down', 1)
  if (key === '\x1b[C' || key === '\x1b[D' || key === '\x1bOC' || key === '\x1bOD') return { state }
  // b/f too: a Mac laptop has no PgUp/PgDn key, and some terminals keep them for their own window.
  if (key === 'b' || key === 'f') key = key === 'b' ? PAGE_UP : PAGE_DOWN
  // SGR mouse report (ESC [ < b ; x ; y M): button 64/65 is the wheel up/down; clicks are ignored.
  const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(key)
  if (sgr && sgr[1] !== '64' && sgr[1] !== '65') return { state }
  const mouse = !!sgr
  if (sgr) key = sgr[1] === '64' ? PAGE_UP : PAGE_DOWN
  if (key === PAGE_UP || key === PAGE_DOWN) {
    // The viewport bounds the scroll; the wheel steps WHEEL_LINES, a key a viewport.
    const page = Math.max(1, state.page ?? 1)
    const step = mouse ? WHEEL_LINES : page
    return scrollView(state, key === PAGE_UP ? 'up' : 'down', step)
  }

  if (/^[1-9]$/.test(key)) {
    const idx = Number(key) - 1
    const hc = hcAgents(state)[idx - state.rows.length]
    const targetId = idx < state.rows.length ? state.rows[idx]!.id : hc && hcId(hc.address)
    if (targetId) return { state: reselect(state, state.selected === targetId ? undefined : targetId) }
    return { state }
  }

  if (key === 'k') {
    const ids = navIds(state)
    if (ids.length === 0) return { state }
    const curIdx = state.selected ? ids.indexOf(state.selected) : -1
    const nextIdx = curIdx <= 0 ? ids.length - 1 : curIdx - 1
    return { state: reselect(state, ids[nextIdx]!) }
  }

  if (key === 'j') {
    const ids = navIds(state)
    if (ids.length === 0) return { state }
    const curIdx = state.selected ? ids.indexOf(state.selected) : -1
    const nextIdx = curIdx < 0 || curIdx >= ids.length - 1 ? 0 : curIdx + 1
    return { state: reselect(state, ids[nextIdx]!) }
  }

  if (key === '\x1b') {
    if (state.armedStop) return { state: { ...state, armedStop: undefined } }
    if (state.expanded) return { state: { ...state, expanded: false, detail: undefined, scroll: 0 } }
    if (narrowScreen(screen) && (state.narrowView ?? 'list') === 'preview') {
      return { state: { ...state, narrowView: 'list' } }
    }
    if (state.mode === 'edit') return { state: { ...state, mode: 'preview', armedStop: undefined } }
    if (state.selected) return { state: reselect(state, undefined) }
    return { state: { ...state, quit: true }, action: { type: 'quit' } }
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
  const editing = state.mode === 'edit' && !state.viewer
  const keys: [string, string][] = !editing
    ? [['e', '編輯'], ['r', 'refresh'], ['q', 'quit']]
    : [
        ['n', 'resume'],
        ['+', 'assign'],
        ['r', 'refresh'],
        ...(hasClearable(state) ? [['c', clearButtonLabel(clearArmed)] as [string, string]] : []),
        ['q', 'quit'],
      ]
  const words = keys.map(([k, l]) => hint(k, l, true)).join(' ')
  const short = keys.map(([k, l]) => hint(k, l, false)).join(' ')
  const tail = editing ? '  a all · j/k select' : '  a all · j/k 選 · ↑↓ 捲動'
  return [`${words}${tail}`, words, short, hint('q', 'quit', false)]
}

/** The selected row's key hints, longest first. */
export function rowHints(state: TuiState, r: PanelRow, now: number): string[] {
  if (r.project) return ['project session · read-only  b/f scroll', 'read-only']
  const armed = (id: string) => state.armedStop?.id === id && now < state.armedStop.until
  const del = hint('d', armed(`delete:${r.id}`) ? `delete ${r.d.name}? press again` : 'delete', true)
  if (state.viewer) return [`${del}  ${READ_ONLY}  Enter detail`, `${del}  唯讀`, del]
  if (state.mode !== 'edit') return [`${del}  e 編輯 · ↑↓ 捲動 · Enter detail`, `${del}  e 編輯`, del]
  const keys: [string, string][] = [['t', 'tell']]
  if (r.incomplete) return [`${hint('-', armed(`cancel:${r.id}`) ? 'clear unfinished reservation? press again' : 'clear', true)}  no worker.json`, hint('-', 'clear', true), hint('-', 'clear', false)]
  if (r.state === 'running' || r.state === 'stalled') keys.push(['i', 'interrupt'])
  keys.push(['x', stopButtonLabel(r.d.name, armed(r.id))])
  if (r.d.seq) {
    const force = r.reservation === 'stale'
    keys.push(['-', armed(`cancel:${r.id}`) ? `${force ? 'force-close' : 'cancel'} episode ${r.d.seq}? press again` : force ? 'force-close' : 'cancel'])
  }
  keys.push(['U', armed(`unlock:${r.id}`) ? 'unlock (maintenance)? press again' : 'unlock'])
  keys.push(['d', armed(`delete:${r.id}`) ? `delete ${r.d.name}? press again` : 'delete'])
  const tail = armed(r.id) ? `  \x1b[31mends its tmux session · ${Math.ceil((state.armedStop!.until - now) / 1000)}s\x1b[0m` : ''
  return [
    `${keys.map(([k, l]) => hint(k, l, true)).join(' ')}  Enter ${state.expanded ? 'mirror' : 'detail'}${tail}`,
    keys.map(([k, l]) => hint(k, l, true)).join(' ') + tail,
    keys.map(([k, l]) => hint(k, l, false)).join(' '),
  ]
}

function hcHints(state: TuiState, hc: HcAgent, now: number): string[] {
  const id = hcId(hc.address)
  const label = hc.name ?? hc.address
  const finished = hcFinished(hc)
  // A finished row in the list was listed because its parent is OWNER (the tick's filter), so it is own by construction.
  const own = isOwnHc(hc, state.hcParent) || finished
  const delArmed = state.armedStop?.id === `delete:${id}` && now < state.armedStop.until
  // x on an own finished row arms the same delete:hc id as d (the verb lives in the id), so x shows it too.
  const stopArmed = (state.armedStop?.id === id && now < state.armedStop.until) || (own && finished && delArmed)
  const sendHint = own && !finished ? hint('t', 'send', true) : undefined
  const intHint = own && !finished ? hint('i', 'interrupt', true) : undefined
  const xLong = own ? hint('x', stopButtonLabel(label, stopArmed), true) : undefined
  const dLong = own && finished ? hint('d', delArmed ? `delete ${label}? press again` : 'delete', true) : undefined
  const xShort = own ? hint('x', 'stop', false) : undefined
  const dShort = own && finished ? hint('d', 'delete', false) : undefined
  const tail = stopArmed
    ? `  \x1b[31m${finished ? 'removes finished hc terminal' : 'ends its hc terminal'} · ${Math.ceil((state.armedStop!.until - now) / 1000)}s\x1b[0m`
    : delArmed
      ? `  \x1b[31mremoves finished hc terminal · ${Math.ceil((state.armedStop!.until - now) / 1000)}s\x1b[0m`
      : ''
  const attach = state.viewer ? 'Enter attach (watch-only)' : 'Enter attach'
  const btn = (...xs: (string | undefined)[]) => xs.filter((x): x is string => !!x).join(' ')
  const why = own ? '' : '  \x1b[2mother hc terminal — t/i/x act on your own rows only\x1b[0m'
  if (state.expanded) {
    if (state.mode === 'edit' && !state.viewer) {
      // An armed or forbidden row's reason comes first: the two-press warning must survive 80 columns.
      const lead = btn(xLong, dLong)
      const btns = btn(sendHint, intHint, lead)
      return [`${btns}  ${attach} · Esc mirror · ↑↓ 捲動${tail}${why}`, `${lead || btns}${tail}`, `${lead || btn(sendHint, intHint, xShort, dShort)}`]
    }
    // Preview and viewer cannot run x (it needs 編輯): offer only what acts there.
    return dLong
      ? [`${dLong}  hc · ${attach} · Esc mirror · ↑↓ 捲動${tail}${why}`, `${dLong}  ${attach}${tail}`, `${dLong}${why}`]
      : [`hc · ${attach} · Esc mirror · ↑↓ 捲動${why}`, attach, '']
  }
  if (state.viewer) {
    return dLong
      ? [`${dLong}  ${READ_ONLY} · Enter detail${tail}`, `${dLong}  唯讀${tail}`, dLong]
      : [`hc · ${READ_ONLY} · Enter detail`, 'Enter detail', '']
  }
  if (state.mode !== 'edit') {
    const head = own ? '' : 'hc · other hc terminal · '
    return dLong
      ? [`${dLong}  e 編輯 · ↑↓ 捲動 · Enter detail${tail}`, `${dLong}  e 編輯${tail}`, dLong]
      : [`${head}e 編輯 · ↑↓ 捲動 · Enter detail`, 'Enter detail', '']
  }
  // Edit: the long form, then the same keys with the armed/forbidden warning kept ahead of the t/i shortcuts.
  // The armed line carries its consequence text at every width it can fit; only a non-armed row falls
  // back to the one-key form.
  const long = btn(sendHint, intHint, xLong, dLong)
  const medium = btn(xLong, dLong, sendHint, intHint)
  const oneKey = btn(xLong, dShort, sendHint, intHint)
  // Armed: the warning and its consequence own the line; t/i wait for the arm to clear.
  const armedLine = `${btn(xLong, dLong)}${tail}`
  return [
    `${long}  ↑↓ 捲動 · Enter detail${tail}${why}`,
    `${medium}${tail}${why}`,
    `${(stopArmed || delArmed) && tail ? armedLine : oneKey}${why}`,
  ]
}

function fitFirst(options: string[], width: number): string {
  return options.find(o => cellWidth(o) <= width) ?? truncateAnsi(options.at(-1) ?? '', width)
}

/** The first empty state that holds (R4.7): read failure, filtered out, nothing outstanding. */
export function emptyText(state: TuiState): string {
  if (state.loadError) return `Could not read the ledger: ${state.loadError}`
  if (state.all.length) return `No rows shown: ${state.all.length} worker(s) of other sessions are filtered out — press a to show all`
  return NO_WORKERS
}
const NO_WORKERS = 'No workers outstanding.'

/** Lines of the detail view (R4.3): row state and result state are separate lines. */
export function detailText(r: PanelRow, det: EpisodeDetail): string[] {
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

/** The preview's rule and its tail. They sit outside C, so they do not shrink the 2/3. */
const BODY_CHROME = 2

export type TuiLayout = {
  frame: Frame
  sections: Sections
  /** The open detail wrapped once to the preview width (drawn, paged and measured from this); undefined unless the selected row's detail is expanded. */
  detail?: string[]
}

export type Rect = { x: number; y: number; cols: number; rows: number }
export type NarrowView = 'list' | 'preview'
export type Frame = {
  mode: 'standard' | 'narrow' | 'tiny'
  title: Rect
  list: Rect & { first: number }
  /** Capture and fitWorker use this rectangle, never the terminal width. */
  preview: Rect
  footer: Rect
  /** Content rows after chrome, group headers and the more line. */
  content: number
  more: number
  hidden: number
}

export function frameMode(width: number, height: number): Frame['mode'] {
  if (width < 40 && height < 10) return 'tiny'
  if (width >= 80) return 'standard'
  return 'narrow'
}

/** Keys and frameOf share this. Width alone, or a short 60x8 pane, is still narrow. */
function narrowScreen(screen: { width: number; height: number } | undefined): boolean {
  return screen !== undefined && frameMode(screen.width, screen.height) === 'narrow'
}

const firstShown = (selected: number, shown: number, rows: number) =>
  selected >= 0 && shown > 0 ? Math.max(0, Math.min(selected - shown + 1, rows - shown)) : 0

/**
 * One geometry (L1). `headers` is the full-width chrome (title, status, selection
 * extra, footer, group headers). The preview's rule and tail are chrome too, so
 * they are not part of C. Standard: list ≤ ⌊C/3⌋ and preview ≥ ⌈2C/3⌉.
 */
export function frameOf(
  width: number,
  height: number,
  rows: number,
  selected: number,
  headers: number,
  narrowView: NarrowView = 'list',
  footerRows = 0,
  hasPreview = selected >= 0,
): Frame {
  const mode = frameMode(width, height)
  const chrome = Math.min(Math.max(0, headers), Math.max(0, height))
  const title: Rect = { x: 0, y: 0, cols: Math.max(0, width), rows: height > 0 ? 1 : 0 }
  const footer: Rect = { x: 0, y: Math.max(0, height - footerRows), cols: Math.max(0, width), rows: Math.min(footerRows, height) }
  const contentY = chrome - footer.rows
  const empty = (content: number): Frame => ({
    mode,
    title,
    list: { x: 0, y: chrome, cols: width, rows: 0, first: 0 },
    preview: { x: 0, y: chrome, cols: width, rows: 0 },
    footer,
    content,
    more: 0,
    hidden: rows,
  })
  if (mode === 'tiny' || width < 1 || height < 1) return empty(0)

  if (mode === 'narrow' && narrowView !== 'preview') {
    let shown = Math.min(rows, Math.max(0, height - chrome))
    let more = rows > shown ? 1 : 0
    if (more) shown = Math.min(rows, Math.max(0, height - chrome - 1))
    const C = Math.max(0, height - chrome - more)
    return {
      mode,
      title,
      list: { x: 0, y: contentY, cols: width, rows: shown, first: firstShown(selected, shown, rows) },
      preview: { x: 0, y: chrome, cols: width, rows: 0 },
      footer,
      content: C,
      more,
      hidden: rows - shown,
    }
  }

  // Standard, or narrow preview: the preview is the pane. Rule + tail sit outside C.
  const previewChrome = hasPreview ? BODY_CHROME : 0
  let more = 0
  let C = 0
  let shown = 0
  let previewRows = 0
  for (let pass = 0; pass < 3; pass++) {
    C = Math.max(0, height - chrome - previewChrome - more)
    const cap = hasPreview && rows > 0 ? Math.floor(C / 3) : C
    shown = mode === 'narrow' ? 0 : Math.min(rows, cap)
    previewRows = hasPreview ? C - shown : rows === 0 ? C : 0
    const need = mode === 'narrow' ? 0 : rows > shown ? 1 : 0
    if (need === more) break
    more = need
  }
  return {
    mode,
    title,
    list: { x: 0, y: contentY, cols: width, rows: shown, first: firstShown(selected, shown, rows) },
    preview: { x: 0, y: contentY + shown + more + (hasPreview ? 1 : 0), cols: width, rows: previewRows },
    footer,
    content: C,
    more,
    hidden: rows - shown,
  }
}

/** `sel` is the selected tmux row's index, `selIndex` the selected row's place in the whole list (tmux rows, then hc rows); both -1 when none. */
type Sections = { title: string; status: string[]; selExtra: string[]; footer: string[]; sel: number; selIndex: number; hcSel?: HcAgent }

function sectionsOf(state: TuiState, width: number, now: number, gate?: Gate, height = Number.POSITIVE_INFINITY): Sections {
  const tmuxRunning = state.rows.filter(r => !r.project && !r.terminal).length
  const me = state.owner
  const age = state.rowsAge ? ` · ${ageText(now, state.rowsAge)}` : ''
  const herdrEnded = Array.isArray(state.herdr) ? state.herdr.filter(hcFinished).length : 0
  const herdrCount =
    state.herdr === undefined ? '' : ` · hc ${state.herdr === '?' ? '?' : `${state.herdr.length - herdrEnded} live${herdrEnded ? ` · ${herdrEnded} ended` : ''}`}`
  const counts = `${me ? `@${me.slice(0, 8)} · ` : ''}tmux ${tmuxRunning}${herdrCount}${age}`
  // The short count (`hc N`, live agents) the title falls back to before it gives up a hint that names what a second press does.
  const herdrShort = Array.isArray(state.herdr) ? ` · hc ${state.herdr.length - herdrEnded}` : herdrCount
  const shortCounts = `${me ? `@${me.slice(0, 8)} · ` : ''}tmux ${tmuxRunning}${herdrShort}${age}`
  const hints = headerHints(state, now)
  let title = ''
  // As the band: the hint words go first, then the session id, then the counts; the name and version never
  // (mods/README.md rule 11 in agent-scripts).
  const name = ` workers${state.version ? ` v${state.version}` : ''}`
  const clearArmed = state.armedStop?.id === CLEAR_ID && now < state.armedStop.until
  const heads = [`${name} · ${counts} `, `${name} · ${shortCounts} `, `${name} · tmux ${tmuxRunning}${herdrShort} `, `${name} `]
  // Armed `c`: the long hint (it says what the second press does) wins over the live/ended detail of the counts.
  if (clearArmed) {
    const t = heads.find(t => cellWidth(t) + cellWidth(hints[0]!) <= width)
    if (t) title = `${t}${hints[0]}`
  }
  if (!title) {
    outer: for (const t of heads) {
      for (const h of hints) {
        if (cellWidth(t) + cellWidth(h) <= width) {
          title = `${t}${h}`
          break outer
        }
      }
    }
  }
  if (!title) title = `${name} ${hints.at(-1)}`
  const titleLine = `${ANSI_FG_BLACK}${ANSI_BG_CYAN}${ANSI_BOLD}${padCells(truncateAnsi(title, width), width)}${ANSI_RESET}`

  const status: string[] = []
  const health = healthText(gate?.viewHealth)
  if (state.mode === 'picker') {
    status.push('選擇 session：數字或 Enter 接手，Esc 返回')
    const entries = state.pickerEntries ?? []
    if (!entries.length) status.push('（沒有 session）')
    else {
      // Title + this prompt stay; the window follows the highlight. Lines after it are what a short frame drops.
      const index = Math.min(Math.max(state.pickerIndex ?? 0, 0), entries.length - 1)
      const room = Number.isFinite(height) ? Math.max(1, height - 2) : entries.length
      const shown = Math.min(entries.length, room)
      const first = firstShown(index, shown, entries.length)
      for (let i = first; i < first + shown; i++) {
        const e = entries[i]!
        const mark = i === index ? '› ' : '  '
        const cwd = e.cwdFrom === 'unknown' || !e.cwd ? 'cwd unknown' : sanitizeAnsi(e.cwd)
        status.push(`${mark}${i + 1} [${e.liveness}] ${sanitizeAnsi(e.session)} ${cwd}`)
      }
    }
  } else if (state.viewer) status.push(`\x1b[2mviewer — no session; ${READ_ONLY} · ${health}\x1b[0m`)
  else {
    const ok = gate?.viewHealth?.kind === 'collecting' && !gate.viewHealth.reason // a deferral shows in yellow
    status.push(`${ok ? '\x1b[2m' : '\x1b[33m'}${sanitizeAnsi(health)}\x1b[0m`)
  }
  if (state.adding) {
    const label =
      state.inputKind === 'tell'
        ? `t tell ${state.rows.find(r => r.id === state.inputFor)?.d.name ?? '?'}`
        : state.inputKind === 'hcSend'
          ? `t send ${state.inputFor?.startsWith('hc:') ? state.inputFor.slice(3) : '?'}`
        : state.inputKind === 'assign'
          ? '+ assign <profile> <name> <brief-file>'
          : 'n resume [profile] <session-id> [name]'
    status.push(`  ${label}: ${state.resumeInput}█`)
  }
  // hc rows are in the list: `No workers outstanding.` would be false then (the other empty states still hold).
  if (state.rows.length === 0 && !(hcAgents(state).length && emptyText(state) === NO_WORKERS)) status.push(`\x1b[2m${sanitizeAnsi(emptyText(state))}\x1b[0m`)

  const sel = state.rows.findIndex(r => r.id === state.selected)
  const hcSel = sel < 0 ? selectedHc(state) : undefined
  const selExtra: string[] = []
  if (sel >= 0) {
    const r = state.rows[sel]!
    if (r.summary && !state.expanded) {
      const sumColor = r.summary.startsWith('success') ? '\x1b[32m' : '\x1b[33m'
      selExtra.push(`    ${sumColor}${sanitizeAnsi(r.summary)}\x1b[0m`)
    }
    selExtra.push(`    ${fitFirst(rowHints(state, r, now), Math.max(0, width - 4))}`)
  } else if (hcSel) {
    // No msg, no line: a summary is never made up. The colour is the row's status colour.
    // The colour is the status of the get that gave the msg (a live row's ls status may be older); a finished row keeps its own.
    // A msg sampled while the row was live is not drawn once the row has ended (and the reverse never happens).
    const sample = state.hcMsg?.address === hcSel.address && !!state.hcMsg.finished === hcFinished(hcSel) ? state.hcMsg : undefined
    if (sample?.msg && !state.expanded) {
      const look = hcLook(sample.status && !hcFinished(hcSel) ? { ...hcSel, status: sample.status } : hcSel)
      selExtra.push(`    ${ANSI_COLOR_MAP[STATE_COLOR[look.state]] ?? ''}${sanitizeAnsi(sample.msg)}\x1b[0m`)
    }
    selExtra.push(`    ${fitFirst(hcHints(state, hcSel, now), Math.max(0, width - 4))}`)
  }
  const hcIndex = hcSel ? hcAgents(state).findIndex(a => a.address === hcSel.address) : -1
  const selIndex = sel >= 0 ? sel : hcIndex >= 0 ? state.rows.length + hcIndex : -1

  const footer: string[] = []
  const others = othersLine(state.all)
  if (others) {
    const glyphColor = others.running ? '\x1b[32m' : '\x1b[2m'
    footer.push(`${glyphColor}◌\x1b[0m [ a ${state.showAll ? '只看自己' : '展開'} · ${others.text} ]`)
  }
  if (state.statusMessage && now < (state.statusUntil ?? 0)) {
    footer.push(`\x1b[36mtmux-agent: ${sanitizeAnsi(state.statusMessage)}\x1b[0m`)
  }
  return { title: titleLine, status, selExtra, footer, sel, selIndex, ...(hcSel ? { hcSel } : {}) }
}

/** Full-width lines that are not list, more, or the preview pane. */
function chromeLines(s: Sections): number {
  return 1 + s.status.length + s.selExtra.length + s.footer.length
}

/** The layout runTui sizes the capture and the detail page with: the same one render draws. */
export function tuiLayout(state: TuiState, width: number, height: number, now: number, gate?: Gate): TuiLayout {
  const sections = sectionsOf(state, width, now, gate, height)
  const hasPreview = sections.sel >= 0 || sections.hcSel !== undefined
  const frame = frameOf(width, height, state.rows.length + hcAgents(state).length, sections.selIndex, chromeLines(sections), state.narrowView ?? 'list', sections.footer.length, hasPreview)
  const wrapW = frame.preview.cols > 0 ? frame.preview.cols : width
  const open = state.expanded && state.detail && state.detail.id === state.selected
  return { frame, sections, ...(open ? { detail: wrapCells(state.detail!.lines.join('\n'), wrapW) } : {}) }
}

function rowLine(state: TuiState, index: number, selected: number): string {
  const r = state.rows[index]!
  const digitPrefix = index < 9 ? `${index + 1}: ` : '   '
  const color = r.project ? ANSI_COLOR_MAP['blue'] : (ANSI_COLOR_MAP[STATE_COLOR[r.state]] ?? '')
  return `${digitPrefix}${color}${ANSI_BOLD}${rowGlyph(r)}${ANSI_RESET}${sanitizeAnsi(rowLabel(r, index === selected))}`
}

/** `text` cut to `max` cells by the same rule as `cellWidth` (`TMUX_AGENT_AMBIGUOUS_WIDTH`), `…` marking the cut; no `…` when it does not fit. */
function fitByCells(text: string, max: number): string {
  if (cellWidth(text) <= max) return text
  const cut = (limit: string, room: number) => {
    let out = ''
    let cur = 0
    for (const g of graphemes(limit)) {
      const w = cellWidth(g)
      if (cur + w > room) break
      out += g
      cur += w
    }
    return out
  }
  const dots = cellWidth('…')
  return max >= dots ? `${cut(text, max - dots)}…` : cut(text, max)
}

/** One hc row, the tmux row's grammar: `N: ` glyph `› name  @parent  mark  age  repo`. Narrow drops the repo, then @parent, then age. */
function hcLine(state: TuiState, a: HcAgent, index: number, selected: boolean, width: number, now: number): string {
  const info = state.hcInfo?.[a.address]
  const look = hcLook(a)
  const color = ANSI_COLOR_MAP[STATE_COLOR[look.state]] ?? ''
  const prefix = index < 9 ? `${index + 1}: ` : '   '
  const plain = (t: string) => stripAnsi(sanitizeAnsi(t))
  const name = plain(a.name ?? a.address)
  // The address only on a wide row and when the name is not already the address.
  const addr = a.name && width >= 120 ? plain(a.address) : ''
  const marker = `${selected ? '›' : ' '} `
  const lead = (n: string, withAddr: boolean) => `${marker}${n}${withAddr ? ` ${ANSI_DIM}${addr}${ANSI_RESET}` : ''}`
  const parent = a.parent ? `  @${plain(a.parent.split('/').pop()!)}` : ''
  const mark = `  ${plain(hcMark(a, info?.program))}`
  // A live row's age runs to now; a finished one shows `ran <created→finished>` once finished_ms is known (never a growing number).
  const end = hcFinished(a) ? info?.finishedMs : now
  const age = info?.createdMs !== undefined && end !== undefined ? `  ${hcFinished(a) ? 'ran ' : ''}${elapsed(end - info.createdMs)}` : ''
  const repo = `  ${plain(rowRepo(a.cwd))}`
  const room = Math.max(0, width - cellWidth(prefix) - cellWidth(look.glyph))
  // Room goes to the mark first. Out of room: the address, the repo, @parent, the age; then the name takes the cut (`…`), never the mark.
  const tails = [parent + mark + age + repo, parent + mark + age, mark + age, mark]
  const fits = [...(addr ? [lead(name, true) + tails[0]!] : []), ...tails.map(t => lead(name, false) + t)].find(l => cellWidth(l) <= room)
  const nameRoom = room - cellWidth(marker) - cellWidth(mark)
  const cutMark = (): string => {
    // The mark alone is too long: one cell of name, then the mark cut from its end, so the status word is the last to go.
    const nameCut = fitByCells(name, 1)
    const markRoom = room - cellWidth(marker) - cellWidth(nameCut)
    return markRoom >= cellWidth(`  ${mark.trim().split(' · ')[0]}`) ? `${marker}${nameCut}${fitByCells(mark, markRoom)}` : `${marker}${fitByCells(mark.trimStart(), Math.max(0, room - cellWidth(marker)))}`
  }
  const label = fits ?? (nameRoom >= 1 ? `${marker}${fitByCells(name, nameRoom)}${mark}` : cutMark())
  return `${prefix}${color}${ANSI_BOLD}${look.glyph}${ANSI_RESET}${label}`
}

/** Detail slice or mirror slice for one preview. The standard painter keeps its own tail line. */
function previewLines(state: TuiState, bodyRows: number, detail: string[] | undefined): string[] {
  const r = state.rows.find(row => row.id === state.selected)
  const hc = r ? undefined : selectedHc(state)
  if ((!r && !hc) || bodyRows <= 0) return []
  const out: string[] = []
  if (state.expanded) {
    const all = detail ?? ['loading…']
    const top = Math.max(0, Math.min(state.scroll ?? 0, all.length - bodyRows))
    for (const l of all.slice(top, top + bodyRows)) out.push(l || ' ')
    return out
  }
  const targetId = r ? r.id : hcId(hc!.address)
  const m = state.mirror?.id === targetId ? state.mirror : undefined
  if (!m) out.push('\x1b[2mcapturing the pane…\x1b[0m')
  else if (m.error) out.push(`\x1b[33mcapture failed: ${sanitizeAnsi(m.error)}\x1b[0m`)
  else if (!m.lines.length) out.push('\x1b[2m(the pane is empty)\x1b[0m')
  const total = m?.lines.length ?? 0
  const end = total - Math.min(state.back ?? 0, Math.max(0, total - bodyRows))
  if (m && !m.error && total) for (const ml of m.lines.slice(Math.max(0, end - bodyRows), end)) out.push(sanitizeAnsi(ml) || ' ')
  return out
}

function linesFromLayout(state: TuiState, width: number, height: number, lay: TuiLayout, now: number, gate?: Gate): string[] {
  const { frame, sections: s } = lay
  if (height <= 2) {
    const compact = `${state.rows.length} worker(s) · ${healthText(gate?.viewHealth)} · window too small (${height} rows)`
    return [s.title, truncateAnsi(compact, width)].slice(0, height)
  }
  const fit = (line: string) => truncateAnsi(line, width)
  const lines: string[] = [s.title, ...s.status.map(fit)]
  if (s.sel >= 0 || s.hcSel) lines.push(...s.selExtra.map(fit))

  const hcs = hcAgents(state)
  const shown = Math.max(0, state.rows.length + hcs.length - frame.hidden)
  for (let i = frame.list.first; i < frame.list.first + shown; i++) {
    lines.push(fit(i < state.rows.length ? rowLine(state, i, s.sel) : hcLine(state, hcs[i - state.rows.length]!, i, i === s.selIndex, width, now)))
  }
  if (frame.more) lines.push(fit(`\x1b[2m  +${frame.hidden} more — j/k moves the selection\x1b[0m`))

  // Full-width chrome precedes the list and preview in every frame mode.
  const r = s.sel >= 0 ? state.rows[s.sel] : undefined
  const hc = r ? undefined : s.hcSel
  const bodyRows = frame.preview.rows
  if ((r || hc) && bodyRows > 0) {
    // The preview owns its rule, `bodyRows` rows and a tail line in every state, so
    // the frame is `height` rows and the footer stays at the bottom (T1 C1).
    const rule = `\x1b[2m${padCells('─'.repeat(Math.floor(width / cellWidth('─'))), width)}\x1b[0m`
    const body = previewLines(state, bodyRows, lay.detail)
    let tail: string
    if (state.expanded) {
      const all = lay.detail ?? ['loading…']
      const top = Math.max(0, Math.min(state.scroll ?? 0, all.length - bodyRows))
      const end = Math.min(all.length, top + bodyRows)
      // hc Detail: the forbidden reason leads when this row is another terminal's, then the nav.
      const why = hc && !(isOwnHc(hc, state.hcParent) || hcFinished(hc)) ? 'other hc terminal · ' : ''
      // The reason costs cells at 80 columns: give up `b/f scroll` (the keys still work) before cutting a word.
      const nav = hc ? (state.viewer ? 'Enter attach (watch-only) · Esc mirror' : 'Enter attach · Esc mirror') : 'Enter mirror'
      const full = `${why}detail ${all.length ? top + 1 : 0}–${end} of ${all.length} · b/f scroll · ${nav}`
      const short = `${why}detail ${all.length ? top + 1 : 0}–${end} of ${all.length} · ${nav}`
      tail = `\x1b[2m${cellWidth(full) <= width ? full : short}\x1b[0m`
    } else {
      const targetId = r ? r.id : hcId(hc!.address)
      const m = state.mirror?.id === targetId ? state.mirror : undefined
      const total = m?.lines.length ?? 0
      const end = total - Math.min(state.back ?? 0, Math.max(0, total - bodyRows))
      tail =
        end < total
          ? `\x1b[2mscrollback ${Math.max(1, end - bodyRows + 1)}–${end} of ${total} · b/f scroll · f to the end follows live\x1b[0m`
          : hc
            ? `\x1b[2mSee it whole: hc attach ${sanitizeAnsi(hc.address)} · b scrollback\x1b[0m`
            : r!.project
              ? `\x1b[2mSee it whole: tmux attach -t ${exactSessionTarget(r!.d.name)} · b scrollback\x1b[0m`
              : `\x1b[2mSee it whole: agent-tmux ${r!.d.profile} attach ${r!.d.name} · b scrollback\x1b[0m`
    }
    lines.push(fit(rule))
    for (const l of body) lines.push(fit(l) + ANSI_RESET) // a capture line can leave its SGR open
    for (let k = body.length; k < bodyRows; k++) lines.push(' ')
    lines.push(fit(tail))
  }
  const footer = s.footer.map(fit)
  // Every frame is `height` rows with the footer on the last ones, also when there is
  // no preview (no selection, or a window too short for one) (T1 C1/C5).
  while (lines.length + footer.length < height) lines.push(' ')
  lines.push(...footer)
  return lines.slice(0, height)
}

export function renderTuiLines(
  state: TuiState,
  width: number,
  height: number,
  now: number,
  gate?: Gate,
): string[] {
  if (width < 1 || height < 1) return []
  return linesFromLayout(state, width, height, tuiLayout(state, width, height, now, gate), now, gate)
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
  title = 'workers-tui',
): TerminalEntry {
  const entry = { raw: stdin.isRaw === true, flowing: stdin.readableFlowing === true }
  const steps: [string, () => unknown][] = [
    ['setRawMode(true)', () => stdin.isTTY && typeof stdin.setRawMode === 'function' && stdin.setRawMode(true)],
    ['resume stdin', () => typeof stdin.resume === 'function' && stdin.resume()],
    ['enter alt screen', () => stdout.write(altEnter(title))],
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

export type AttachRunner = (
  argv: readonly string[],
  cwd: string,
) => { status: number | null; error?: Error } | Promise<{ status: number | null; error?: Error }>

export interface TuiOptions {
  host?: Host
  session?: string
  cwd?: string
  root?: string
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  pollMs?: number
  mirrorMs?: number
  rowsMs?: number
  /** Adopt this pending token (`--claim`). Any other current record is stale. */
  claim?: string
  /** This session's hc terminal (`--hc-parent`): the parent of the hc rows `t`/`i`/`x` act on. Default `$HC_TERMINAL_ID`. */
  hcParent?: string
  /** Delete `workers-tui-<sessionKey>-<token>.yaml` here once the claim is ready. */
  launchDir?: string
  /** Interactive attach runner (defaults to spawnSync with inherited stdio). */
  attach?: AttachRunner
}

export type PickerEntry = {
  session: string
  liveness: Liveness
  cwd?: string
  cwdFrom: 'collector' | 'workers' | 'unknown'
  socket?: string
}

export type TuiBind = { session: string; cwd?: string; socket?: string }

/** A picked session's owner, cwd, and tmux socket. cwd stays undefined when it is unknown — never `/`. */
export function rebindHost(base: Host, identity: TuiBind): Host {
  return {
    ...base,
    owner: () => identity.session,
    cwd: () => identity.cwd,
    run: (argv, cwd, ms) => base.run(withTmuxSocket(argv, identity.socket), cwd, ms),
  }
}

function sessionIdFromKey(hex: string): string | undefined {
  if (!hex || hex.length % 2 || !/^[0-9a-f]+$/.test(hex)) return undefined
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return new TextDecoder().decode(bytes)
}

async function collectorBits(host: Host, dir: string, session: string): Promise<{ cwd?: string; socket?: string } | undefined> {
  try {
    const parsed = JSON.parse(await host.read(`${dir}/collector.json`)) as { session?: unknown; cwd?: unknown; socket?: unknown }
    if (parsed.session !== session) return undefined
    const cwd = typeof parsed.cwd === 'string' && parsed.cwd && parsed.cwd !== '/' ? parsed.cwd : undefined
    const socket = typeof parsed.socket === 'string' && parsed.socket ? parsed.socket : undefined
    return { cwd, socket }
  } catch {
    return undefined
  }
}

/** Each owner's ownerCwd set across all workers: one worker.json read apiece. `/` and empty are unknown. */
async function ownerCwds(host: Host, v3: string): Promise<Map<string, Set<string>>> {
  const byOwner = new Map<string, Set<string>>()
  let names: readonly { name: string; kind: string }[]
  try {
    names = await host.list(v3)
  } catch {
    return byOwner
  }
  const recs = await Promise.all(
    names
      .filter(e => e.kind === 'dir' && !e.name.startsWith('.'))
      .map(async e => {
        try {
          return JSON.parse(await host.read(`${v3}/${e.name}/worker.json`)) as { owner?: unknown; ownerCwd?: unknown } | null
        } catch {
          return undefined
        }
      }),
  )
  for (const rec of recs) {
    if (typeof rec?.owner !== 'string' || typeof rec.ownerCwd !== 'string' || !rec.ownerCwd || rec.ownerCwd === '/') continue
    byOwner.set(rec.owner, (byOwner.get(rec.owner) ?? new Set()).add(rec.ownerCwd))
  }
  return byOwner
}

/** `.v3/.sessions` + liveness. Four liveness kinds stay distinct. Workers that agree on one ownerCwd supply it when the collector has none. */
export async function listSessions(host: Host, root: string, now: number): Promise<PickerEntry[]> {
  const v3 = v3Of(root)
  const dir = `${v3}/.sessions`
  let names: readonly { name: string; kind: string }[]
  try {
    if (!(await host.exists(dir))) return []
    names = await host.list(dir)
  } catch {
    return []
  }
  let owners: Promise<Map<string, Set<string>>> | undefined
  const sessions = names.flatMap(e => {
    const session = e.kind === 'dir' ? sessionIdFromKey(e.name) : undefined
    return session ? [session] : []
  })
  return Promise.all(
    sessions.map(async (session): Promise<PickerEntry> => {
      const sd = sessionDirOf(v3, session)
      const [liveness, col] = await Promise.all([sessionLiveness(host, sd, now), collectorBits(host, sd, session)])
      let cwd = col?.cwd
      let cwdFrom: PickerEntry['cwdFrom'] = cwd ? 'collector' : 'unknown'
      if (!cwd) {
        const set = (await (owners ??= ownerCwds(host, v3))).get(session)
        if (set?.size === 1) {
          cwd = [...set][0]
          cwdFrom = 'workers'
        }
      }
      return { session, liveness, ...(cwd ? { cwd } : {}), cwdFrom, ...(col?.socket ? { socket: col.socket } : {}) }
    }),
  )
}

/** This process's stdout tty. macOS `/dev/fd/1` is not a symlink (`readlink` returns EINVAL); `tty` on that fd is the query that works. */
function ownStdoutTty(): { tty: string } | { error: string } {
  try {
    const linked = readlinkSync('/dev/fd/1')
    if (linked.startsWith('/dev/')) return { tty: linked }
  } catch {
    // macOS: /dev/fd/1 is not a symlink.
  }
  const run = spawnSync('/usr/bin/tty', [], { stdio: [1, 'pipe', 'pipe'], encoding: 'utf8' })
  const name = (run.stdout ?? '').trim()
  if (run.status === 0 && name.startsWith('/dev/')) return { tty: name }
  return { error: (run.stderr ?? '').trim() || name || `exit ${run.status}` }
}

/** The locator this process writes at ready. A tmux pane wins, so a second launch selects that pane instead of opening an app. */
export async function ownLocator(host: Host, session: string): Promise<TuiLocator | undefined> {
  const term = (await host.envTermProgram()) ?? ''
  const title = `workers-tui ${session.slice(0, 8)}`
  const pane = await host.envTmuxPane()
  if (pane) {
    const socket = await host.envTmuxSocket()
    return { kind: 'tmux', pane, ...(socket ? { socket } : {}) }
  }
  if (/warp/i.test(term)) return { kind: 'warp', tabTitle: title }
  const tty = ownStdoutTty()
  if ('error' in tty) {
    host.log(`tmux-agent: own tty unavailable (${term || 'terminal'}): ${tty.error}`)
    return undefined
  }
  if (/iterm/i.test(term)) return { kind: 'iterm', tty: tty.tty }
  return { kind: 'terminal', tty: tty.tty }
}

function occupiedWhere(result: TuiClaimResult): string {
  if (result.kind === 'occupied-ready') {
    const loc = result.locator
    const where = !loc ? 'no locator' : loc.kind === 'warp' ? loc.tabTitle : loc.kind === 'tmux' ? loc.pane : loc.tty
    return `已有 TUI（ready）${where}`
  }
  if (result.kind === 'occupied-pending') return `已有 TUI（pending）pid ${result.claim.pid}`
  if (result.kind === 'occupied-unknown') return `已有 TUI（unknown）${result.reason ?? result.claim?.pid ?? ''}`
  return result.kind
}

/** T2b/T2c: claim ready in this process, then rebind. Occupied leaves the viewer identity as it was. */
export async function applyPick(host: Host, root: string, state: TuiState, index: number): Promise<{ host: Host; state: TuiState }> {
  const entry = state.pickerEntries?.[index]
  const back = (text: string): { host: Host; state: TuiState } => ({
    host,
    state: say({ ...state, mode: 'preview' }, text, Date.now()).state,
  })
  if (!entry || entry.liveness !== 'live') return back(entry ? '只有 live 的 session 可以接手' : '沒有這個 session')
  const me = await processId(host)
  if (!(me.pid > 0 && me.pidStart)) return back('無法確認這個行程')
  const locator = await ownLocator(host, entry.session)
  const result = await claimTui(host, root, entry.session, me, { state: 'ready', ...(locator ? { locator } : {}) })
  if (result.kind !== 'won' && result.kind !== 'adopted') return back(occupiedWhere(result))
  return {
    host: rebindHost(host, { session: entry.session, cwd: entry.cwd, socket: entry.socket }),
    state: {
      ...state,
      mode: 'edit',
      viewer: false,
      owner: entry.session,
      cwdFrom: entry.cwdFrom,
      statusMessage: undefined,
      heldClaim: { session: entry.session, token: result.claim.token, me },
    },
  }
}

function focusLine(focus: TuiFocus): string {
  if ('refused' in focus) return `無法把既有 TUI 拉到前面：${focus.refused}`
  if (focus.raised === 'pane') return '已有 TUI（ready），已切到那個 pane'
  return `已有 TUI（ready），raised: app${focus.tabTitle ? ` ${focus.tabTitle}` : ''}`
}

type LaunchClaim =
  | { kind: 'skip' }
  | { kind: 'stop'; code: number }
  | { kind: 'held'; held: { session: string; token: string; me: ProcessId } }

/** Identity claims before the terminal is touched. No identity, or a mkdir that did not stick, skips the claim. */
async function claimLaunch(host: Host, root: string, session: string, opts: { claim?: string; launchDir?: string }): Promise<LaunchClaim> {
  if (!(await ensureSessionDir(host, root, session))) return { kind: 'skip' }
  const me = await processId(host)
  if (!(me.pid > 0 && me.pidStart)) return { kind: 'skip' }
  const locator = await ownLocator(host, session)
  const result = await claimTui(host, root, session, me, {
    state: 'ready',
    ...(locator ? { locator } : {}),
    ...(opts.claim ? { adopt: opts.claim } : {}),
    ...(opts.launchDir ? { launchDir: opts.launchDir } : {}),
  })
  if (result.kind === 'stale') {
    process.stderr.write('這個視窗已失效，另一個 TUI 已接手\n')
    return { kind: 'stop', code: 1 }
  }
  if (result.kind === 'occupied-ready') {
    const focus = await focusTui(host, result)
    process.stderr.write(`${focusLine(focus)}\n`)
    return { kind: 'stop', code: 0 }
  }
  if (result.kind === 'occupied-pending' || result.kind === 'occupied-unknown') {
    process.stderr.write(`${occupiedWhere(result)}\n`)
    return { kind: 'stop', code: 0 }
  }
  if (opts.launchDir) {
    const target = tuiLaunchPath(opts.launchDir, session, result.claim.token)
    if (await dropLaunchFile(host, target, '/')) host.log(`tmux-agent: could not remove ${target}`)
  }
  return { kind: 'held', held: { session, token: result.claim.token, me } }
}

export const ROWS_MS = 2_000
export const SWEEP_MS = 10_000
export const MIRROR_TICK_MS = 1_000

/** One run at a time. A kick during a run queues one more, and a second kick does not add another. */
export async function kickJob(flight: Flight, now: () => number, run: () => Promise<boolean>): Promise<void> {
  if (flight.running) {
    flight.queued = true
    return
  }
  flight.running = true
  let ok = false
  try {
    ok = await run()
  } finally {
    flight.running = false
    if (ok) flight.lastOk = now()
    if (flight.queued) {
      flight.queued = false
      await kickJob(flight, now, run)
    }
  }
}

export async function runTui(options: TuiOptions = {}): Promise<number> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  // No invented owner. A missing id is a viewer (every row, labeled), never `tui-<pid>`.
  const session = options.session ?? process.env.TMUX_AGENT_SESSION
  // A viewer is the whole machine (D-viewer): `/` lists every project's rows; --cwd narrows it.
  const cwd = options.cwd ?? (session ? process.cwd() : '/')
  const base = options.host ?? nodeHost({ owner: session, cwd })
  let host: Host = options.root ? { ...base, envTmuxAgentDir: async () => options.root as string } : base
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
    version: coreVersion(),
    viewer: !session,
    hcParent: options.hcParent,
    mode: 'preview',
  }

  let capturing = false
  let attaching = false
  let rowsTimer: NodeJS.Timeout | undefined
  let mirrorTimer: NodeJS.Timeout | undefined
  let sweepTimer: NodeJS.Timeout | undefined
  // Bumped on every resize: a capture started before it was sized for the old
  // layout and is dropped when it lands (R4.1).
  let generation = 0

  const layout = () => tuiLayout(state, width, height, Date.now(), gate)

  // A full clear blanks the screen (閃屏): only the first draw and a resize clear; a repaint
  // overwrites in place, and a frame equal to the last one is not written.
  let clearNext = true
  let lastBody = ''
  // After quit (or any stop) nothing more is drawn, even by an action still in flight.
  const render = () => {
    if (stopped || attaching) return
    state.rowsAge = { running: rowsFlight.running, queued: rowsFlight.queued, lastOk: rowsFlight.lastOk }
    const now = Date.now()
    const lay = tuiLayout(state, width, height, now, gate)
    state.page = lay.frame.preview.rows
    state.scrollMax = Math.max(0, (lay.detail?.length ?? 0) - lay.frame.preview.rows)
    const lines = linesFromLayout(state, width, height, lay, now, gate)
    const body = lines.join('\r\n')
    if (!clearNext && body === lastBody) return
    // Erase each line before it is drawn, not after: `\x1b[K` behind a full-width line
    // erases its last cell (pending wrap). Then erase what an older, taller frame left below.
    const drawn = lines.map(l => `\x1b[2K${l}`).join('\r\n') + (lines.length < height ? '\r\n\x1b[J' : '')
    stdout.write(ANSI_SYNC_START + (clearNext ? ANSI_CLEAR_HOME : '\x1b[H') + drawn + ANSI_SYNC_END)
    clearNext = false
    lastBody = body
  }

  const rowsFlight: Flight = { running: false, queued: false }
  const sweepFlight: Flight = { running: false, queued: false }
  let live: Scan['visible'] = []
  const applyRows = async (scanned?: Scan): Promise<void> => {
    // The rows are read first: `state` is taken after the await, so a late hc get that landed meanwhile is not overwritten.
    const rows = await panelRows(host, gate, root, scanned)
    state = applyRowsTick(state, rows)
  }
  const runRows = async (): Promise<boolean> => {
    const scanned = root ? await observeRows(host, gate, root) : undefined
    if (scanned) live = scanned.visible
    state.loadError = root ? gate.viewError : 'no state root (TMUX_AGENT_DIR, XDG_STATE_HOME and HOME are all unset)'
    const [, herdr] = await Promise.all([applyRows(scanned), herdrNow()])
    state = applyHerdrTick(state, herdr)
    fillHcInfo(herdr)
    return true
  }
  // A failed read is `hc ?`, never a failed rows tick. The tick draws the `hc ls` list at once; the one `hc get` an address
  // gets when it first appears (and once more when it ends, for its finish time) runs after, in one queue shared by all
  // ticks with at most HC_GETS in flight, and fills the row's age and program when it lands. A known address, selected or
  // not, runs none. A failed get leaves `{ final: true }`, so the row stays without an age and the get is not tried again.
  // Each get has a token. Only a successful `hc ls` that no longer lists the address removes its token (a failed read says
  // nothing about who left), and the token is checked before the get is issued, so a queued address that left is never
  // queried; a result whose token is gone is dropped. Every finished get releases its own token.
  const HC_GETS = 4
  const hcPending = new Map<string, symbol>()
  const hcQueue: { a: HcAgent; token: symbol }[] = []
  let hcMember = new Set<string>()
  let hcRunning = 0
  const herdrNow = async (): Promise<HcAgent[] | '?' | undefined> => {
    try {
      const [agents, self] = await Promise.all([readHc(host), host.envHcTerminal()])
      if (!agents) return undefined
      // SELF hides this terminal's own row; OWNER (--hc-parent or env) decides which finished rows are ours.
      const owner = state.hcParent
      return agents.filter(a => (!self || a.address !== self) && (!hcFinished(a) || (!!owner && a.parent === owner)))
    } catch {
      return '?'
    }
  }
  const pumpHc = () => {
    while (hcRunning < HC_GETS && hcQueue.length && !stopped) {
      const { a, token } = hcQueue.shift()!
      if (hcPending.get(a.address) !== token) continue
      hcRunning++
      void (async () => {
        try {
          const det = await readHcDetail(host, a)
          if (stopped || hcPending.get(a.address) !== token) return
          hcPending.delete(a.address)
          if (!hcMember.has(a.address)) return
          const old = state.hcInfo?.[a.address]
          const got: HcInfo = det.error
            ? { ...old, final: true }
            : {
                ...old,
                ...(det.createdMs !== undefined ? { createdMs: det.createdMs } : {}),
                ...(det.finishedMs !== undefined ? { finishedMs: det.finishedMs } : {}),
                ...(det.program ? { program: det.program } : {}),
                final: hcFinished(a) || det.finishedMs !== undefined,
              }
          state = { ...state, hcInfo: { ...state.hcInfo, [a.address]: got } }
          render()
        } finally {
          hcRunning--
          pumpHc()
        }
      })()
    }
  }
  const fillHcInfo = (herdr: HcAgent[] | '?' | undefined) => {
    if (herdr === '?') return
    const list = herdr ?? []
    hcMember = new Set(list.map(a => a.address))
    for (const k of [...hcPending.keys()]) if (!hcMember.has(k)) hcPending.delete(k)
    for (const a of list) {
      const known = state.hcInfo?.[a.address]
      if (hcPending.has(a.address) || (known && !(hcFinished(a) && !known.final))) continue
      const token = Symbol(a.address)
      hcPending.set(a.address, token)
      hcQueue.push({ a, token })
    }
    pumpHc()
  }
  const refreshRows = () => kickJob(rowsFlight, () => Date.now(), runRows)
  const runSweep = async (): Promise<boolean> => {
    if (!root) return false
    await sweepStalls(host, gate, root, live)
    await applyRows()
    return true
  }

  // A capture asked for while one runs is not dropped: it runs when that one ends,
  // for whatever row is selected then (T1 C2).
  let captureAgain = false
  // Set by a resize: the kept mirror was sized for the old layout.
  let resized = false
  // Set by a user action (select, resize): the next capture fits the worker's window.
  // The tick never fits, so two TUIs on one worker do not trade sizes each tick: the
  // window follows the last TUI action, as tmux's window-size latest follows the last client.
  // shortcut: a worker resized by another TUI or resumed under the same row keeps that size until reselected (j/k); refit on resume if it bites.
  let fitPending = false
  /** True when a capture landed in `state.mirror`. */
  const captureSelected = async (): Promise<boolean> => {
    if (stopped || attaching) return false
    if (capturing) {
      captureAgain = true
      return false
    }
    if (!state.selected || state.expanded) return false
    const row = state.rows.find(r => r.id === state.selected)
    const hc = row ? undefined : selectedHc(state)
    if (!row && !hc) return false
    const targetId = row ? row.id : hcId(hc!.address)
    const frame = layout().frame
    const body = frame.preview.rows
    if (body < 1 || frame.preview.cols < 1) return false
    const gen = generation
    capturing = true
    let landed = false
    try {
      // The worker's screen is the preview rectangle, not the terminal's width (I4, I5).
      // A viewer too (owner ruling 2026-10-15): read-only covers the ledger and the
      // worker's input, not the size of a window nobody is attached to.
      const fit = fitPending && !!row && !row.project
      fitPending = false
      const fitOut = fit ? await fitWorker(host, row.d, frame.preview.cols, body) : undefined
      // The whole scrollback, like `tmux attach`; the view shows a window of it (PgUp/PgDn).
      // Colour on: every mirror line goes through sanitizeAnsi before it is printed.
      // An hc row's own `hc get` rides with its capture: its `status.msg` is the summary line.
      const [cap, hcDet] = hc
        ? await Promise.all([mirrorHc(host, hc.address, MIRROR_HISTORY, true), readHcDetail(host, hc)])
        : [row!.project ? await mirrorProject(host, row!.d.name, MIRROR_HISTORY, true) : await mirrorOf(host, row!.d, MIRROR_HISTORY, true), undefined]
      // A gone session is the capture's error to show; a live one that would not resize is said here.
      if (fitOut && !fitOut.ok && !cap.error) say(fitOut.text)
      if (gen === generation && state.selected === targetId && !stopped) {
        // Scrolled back: keep the same lines in view while new output lands below.
        // shortcut: once the pane passes MIRROR_HISTORY lines the window drifts; pin by content if that bites.
        const prev = state.mirror?.id === targetId ? state.mirror.lines.length : cap.lines.length
        if (state.back) state.back += Math.max(0, cap.lines.length - prev)
        state.mirror = { id: targetId, ...cap }
        if (hc) state.hcMsg = { address: hc.address, finished: hcFinished(hc), ...(hcDet && !hcDet.error ? { ...(hcDet.msg ? { msg: hcDet.msg } : {}), ...(hcDet.status ? { status: hcDet.status } : {}) } : {}) }
        landed = true
      }
    } finally {
      capturing = false
    }
    if (captureAgain) {
      captureAgain = false
      if (!stopped) return (await captureSelected()) || landed
    }
    return landed
  }

  // A selection or size change shows the pending preview at once and captures now,
  // not at the next tick (MIRROR_TICK_MS) (T1 C2).
  const captureNow = () => {
    if (stopped || attaching || !state.selected || state.expanded || (state.mirror?.id === state.selected && !resized)) return
    resized = false
    fitPending = true
    captureSelected()
      .then(landed => {
        if (landed) render()
      })
      .catch(fail)
  }

  // Read-only, whole (R4.3). A read error is shown in the detail, not thrown.
  const loadDetail = async () => {
    const hc = selectedHc(state)
    if (hc && state.expanded) {
      const id = hcId(hc.address)
      const existing = state.mirror?.id === id ? state.mirror : undefined
      const [det, cap] = await Promise.all([
        readHcDetail(host, hc),
        existing ? Promise.resolve(existing) : mirrorHc(host, hc.address, MIRROR_HISTORY, true),
      ])
      if (state.selected === id && state.expanded) {
        if (!existing) state.mirror = { id, ...cap }
        state.detail = { id, lines: hcDetailText(det, cap) }
      }
      return
    }
    const row = state.rows.find(r => r.id === state.selected)
    if (!row || row.project || !state.expanded) return
    const det = await episodeDetail(host, row.d)
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
    if (attaching) return
    width = stdout.columns || 80
    height = stdout.rows || 24
    // The same row's last capture stays, cut to the new body, until the one sized
    // for the new layout lands; a capture already in flight is dropped (R4.1).
    generation += 1
    resized = true
    clearNext = true
    try {
      render()
      captureNow()
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
    if (rowsTimer) clearInterval(rowsTimer)
    if (mirrorTimer) clearInterval(mirrorTimer)
    if (sweepTimer) clearInterval(sweepTimer)
    if (escTimer) clearTimeout(escTimer)
    stdin.off('data', onData)
    stdin.off('end', onEnd)
    stdin.off('error', onError)
    stdout.off('resize', onResize)
    process.off('SIGWINCH', onResize)
    process.off('exit', onExit)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    process.off('SIGHUP', stop)
    // Printed after the alt screen is left (the last restore step), so it stays readable.
    // No entry: this exit never touched the terminal (occupied, stale, or a signal during claim).
    restoreErrors = entry ? restoreTerminal(stdin, stdout, entry) : []
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
          const result = nextKeyState(state, key, Date.now(), { width, height })
          state = result.state
          if (result.action) await handleAction(result.action)
          if (state.quit) return stop()
        }
        render()
        captureNow()
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

  const auditOf = (holder: string | undefined): TuiAudit => {
    const id = host.owner()
    return { session: id ? id : null, holder: holder ?? null }
  }

  /** The selected row's detail (expanded) or mirror (preview). True when a mirror capture landed. */
  const refreshView = async (): Promise<boolean> => {
    if (!state.selected || stopped || attaching) return false
    if (state.expanded) {
      await loadDetail()
      return selectedHc(state) !== undefined
    }
    return captureSelected()
  }

  const handleAction = async (action: TuiAction) => {
    if (action.type === 'quit') {
      state.quit = true
      return
    }
    if (action.type === 'openPicker') {
      state.pickerEntries = root ? await listSessions(host, root, Date.now()) : []
      if (!state.pickerEntries.some(e => e.liveness === 'live')) {
        state.mode = 'preview'
        say('沒有 live 的 session')
      }
      render()
      return
    }
    if (action.type === 'pick') {
      if (!root) {
        state.mode = 'preview'
        say('沒有 state root')
        render()
        return
      }
      const got = await applyPick(host, root, state, action.index)
      host = got.host
      state = got.state
      if (state.mode === 'edit') await refreshRows()
      render()
      return
    }
    if (action.type === 'refresh') {
      await refreshRows()
      await refreshView()
      render()
      return
    }
    if (action.type === 'stop') {
      const out = await stopWorker(host, gate, action.row.d, undefined, auditOf(action.row.holder))
      say(`stop ${action.row.d.name} — ${out.ok ? 'ok' : 'FAILED'}: ${out.text.slice(0, 100)}`)
      await refreshRows()
      render()
      return
    }
    if (action.type === 'stopHc') {
      const out = await stopHc(host, action.hc)
      say(`stop ${action.hc.address} — ${out.ok ? 'ok' : 'FAILED'}: ${out.text.slice(0, 100)}`)
      await refreshRows()
      render()
      return
    }
    if (action.type === 'hcSend') {
      const out = await sendHc(host, action.address, action.text, state.hcParent)
      // Refused before any write: the prompt stays open with its draft, and Enter retries.
      if (!out.ok && out.refusedBeforeWrite) {
        state = { ...state, adding: true, inputKind: 'hcSend', inputFor: hcId(action.address), resumeInput: action.text }
        say(`send ${action.address} — FAILED: ${out.text.slice(0, 120)}`)
      } else {
        say(`send ${action.address} — ${out.ok ? 'ok' : 'FAILED'}: ${out.text.slice(0, 120)}`)
      }
      await refreshRows()
      render()
      return
    }
    if (action.type === 'interruptHc') {
      const out = await interruptHc(host, action.address, state.hcParent)
      say(`interrupt ${action.address} — ${out.ok ? 'ok' : 'FAILED'}: ${out.text.slice(0, 120)}`)
      await refreshRows()
      render()
      return
    }
    if (action.type === 'stopAll') {
      const out = await stopAll(host, gate, name => {
        const row = state.all.find(r => r.d.name === name) ?? state.rows.find(r => r.d.name === name)
        return auditOf(row?.holder)
      }, state.hcParent)
      say(`clear — ${out.ok ? 'ok' : 'FAILED'}: ${out.text.slice(0, 100)}`)
      await refreshRows()
      render()
      return
    }
    if (action.type === 'interrupt') {
      const out = await interruptWorker(host, action.row.d)
      say(`interrupt ${action.row.d.name} — ${out.ok ? 'ok' : 'FAILED'}: ${out.text.slice(0, 100)}`)
      await refreshRows()
      render()
      return
    }
    if (action.type === 'resume') {
      if (state.cwdFrom === 'unknown' || !host.cwd()) {
        say('cwd unknown；不能 resume 或 assign')
        render()
        return
      }
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
      const dir = host.cwd()
      if (state.cwdFrom === 'unknown' || !dir) {
        say('cwd unknown；不能 resume 或 assign')
        render()
        return
      }
      const path = resolve(dir, file.join(' '))
      const brief = await readFile(path, 'utf8').catch((error: Error) => error)
      if (brief instanceof Error) {
        say(`assign — FAILED: cannot read the brief ${path}: ${brief.message}`)
        render()
        return
      }
      const h = gate.viewHealth
      const got = await assignWorker(host, { profile, name, dir, brief }, {
        owner: host.owner() ?? session ?? '',
        ownerCwd: dir,
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
      await writeTuiAudit(host, 'cancel', { tool: action.row.d.profile, name: action.row.d.name, ok: out.ok, ...auditOf(action.row.holder) })
      say(`cancel ${action.row.d.name} — ${out.ok ? 'ok' : 'FAILED'}: ${out.text}`)
      await refreshRows()
      render()
      return
    }
    if (action.type === 'clear') {
      const out = await clearIncomplete(host, action.row.d.name)
      say(`clear ${action.row.d.name} — ${out.ok ? 'ok' : 'FAILED'}: ${out.text}`)
      await refreshRows()
      render()
      return
    }
    if (action.type === 'delete') {
      const out = await deleteWorker(host, action.row.d.name)
      await writeTuiAudit(host, 'delete', { tool: action.row.d.profile, name: action.row.d.name, ok: out.ok, ...auditOf(action.row.holder) })
      say(`delete ${action.row.d.name} — ${out.ok ? 'ok' : 'FAILED'}: ${out.text}`)
      await refreshRows()
      render()
      return
    }
    if (action.type === 'unlock') {
      const out = await unlockWorker(host, action.row.d.name, UNLOCK_WORD)
      await writeTuiAudit(host, 'unlock', { tool: action.row.d.profile, name: action.row.d.name, ok: out.ok, ...auditOf(action.row.holder) })
      say(`unlock ${action.row.d.name} — ${out.ok ? 'ok' : 'FAILED'}: ${out.text}`)
      render()
      return
    }
    if (action.type === 'mouseOff') {
      stdout.write(ANSI_MOUSE_OFF)
      render()
      return
    }
    if (action.type === 'detail') {
      await loadDetail()
      render()
      return
    }
    if (action.type === 'attach') {
      const bin = await hcBin(host)
      const live = bin ? await hcSocketLive(host) : false
      if (!bin || !live) {
        say(bin ? 'hc core is not running' : 'hc is not on PATH')
        render()
        return
      }
      attaching = true
      const prevEntry = entry
      if (prevEntry) {
        stdin.off('data', onData)
        entry = undefined
        const errs = restoreTerminal(stdin, stdout, prevEntry)
        for (const err of errs) process.stderr.write(`tui: terminal restore failed: ${err.message}\n`)
      }
      let res: { status: number | null; error?: Error } | undefined
      try {
        const runner: AttachRunner =
          options.attach ?? ((argv, dir) => spawnSync(argv[0]!, argv.slice(1), { cwd: dir, stdio: 'inherit' }))
        res = await runner([bin, 'attach', ...(state.viewer ? ['--observe'] : []), action.address], host.cwd() ?? '/')
      } finally {
        attaching = false
        if (!stopped) {
          width = stdout.columns || 80
          height = stdout.rows || 24
          entry = enterTerminal(stdin, stdout, `workers-tui ${sid8}`)
          stdin.on('data', onData)
          clearNext = true
        }
      }
      if (stopped) return
      if (res?.error) say(`attach ${action.address} — FAILED: ${res.error.message}`)
      else if (res && res.status !== null && res.status !== 0) say(`attach ${action.address} — exited ${res.status}`)
      state = { ...state, mirror: undefined }
      await refreshRows()
      await refreshView()
      render()
      return
    }
  }

  const sid8 = (session && session.length ? session : 'viewer').slice(0, 8)
  // Listeners before the first await, so a SIGTERM emitted as runTui yields is ours.
  stdin.on('data', onData)
  stdin.on('end', onEnd)
  stdin.on('error', onError)
  stdout.on('resize', onResize)
  process.on('SIGWINCH', onResize)
  process.on('exit', onExit)
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('SIGHUP', stop)

  // Read after the listeners are attached: it must not delay a key (an early `q` is kept, H6).
  // SELF is this process's own terminal (hide its row); OWNER is the session's (the band's --hc-parent wins over env).
  {
    const me = await host.envHcTerminal().catch(() => undefined)
    if (me) state = { ...state, hcSelf: me, hcParent: state.hcParent ?? me }
  }

  try {
    if (session && root) {
      const claimed = await claimLaunch(host, root, session, { claim: options.claim, launchDir: options.launchDir })
      if (claimed.kind === 'held') state.heldClaim = claimed.held
      if (claimed.kind === 'stop') return claimed.code
    }
    if (!stopped) {
    entry = enterTerminal(stdin, stdout, `workers-tui ${sid8}`)
    // `q` during a slow first load quits at once; it does not wait for the load.
    const first = (async () => {
      await refreshRows()
      // One sweep so the first frame has stall state. Later sweeps stay on their own 10s clock.
      if (!stopped) await kickJob(sweepFlight, () => Date.now(), runSweep)
      if (!stopped) render()
    })()
    first.catch(() => {})
    await Promise.race([first, done])
    if (!stopped) {
      const mirrorTick = async () => {
        if (await refreshView()) render()
      }
      rowsTimer = setInterval(() => {
        if (!stopped && !attaching) refreshRows().then(() => { if (!stopped && !attaching) render() }).catch(fail)
      }, options.rowsMs ?? ROWS_MS)
      mirrorTimer = setInterval(() => {
        if (!stopped && !attaching) mirrorTick().catch(fail)
      }, options.mirrorMs ?? MIRROR_TICK_MS)
      sweepTimer = setInterval(() => {
        if (!stopped && !attaching) kickJob(sweepFlight, () => Date.now(), runSweep).then(() => { if (!stopped && !attaching) render() }).catch(fail)
      }, SWEEP_MS)
      await done
    }
    }
  } finally {
    stopped = true
    cleanup()
    const held = state.heldClaim
    if (held && root) {
      try {
        await releaseTui(host, root, held.session, held.token, 'tui', held.me)
      } catch (error) {
        process.stderr.write(`tui: release failed: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }
  // A quit that left the tty broken is not a success: main exits 1, so a wrapper sees it.
  if (restoreErrors.length) throw new Error(`terminal restore failed: ${restoreErrors.map(e => e.message).join('; ')}`)
  return 0
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
  let values: { session?: string; cwd?: string; claim?: string; 'hc-parent'?: string }
  try {
    ;({ values } = parseArgs({ options: { session: { type: 'string' }, cwd: { type: 'string' }, claim: { type: 'string' }, 'hc-parent': { type: 'string' } } }))
  } catch (error) {
    process.stderr.write(`tui: ${(error as Error).message}\n`)
    process.exit(2)
  }
  // Outside tmux, Warp's own launch file is removed at ready.
  const launchDir = await tuiLaunchDir(nodeHost())
  const code = await runTui({ session: values.session, cwd: values.cwd, claim: values.claim, launchDir, hcParent: values['hc-parent'] })
  // Terminal already restored. A signal can arrive while an action's child still
  // runs; exit now instead of waiting for it (the old SIGINT/SIGTERM handler did too).
  process.exit(code)
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
