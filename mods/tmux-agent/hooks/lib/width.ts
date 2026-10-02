// Plan §1c S7: one width rule set for the TUI (node) and the mod band (hooks
// environment: no Node, so nothing here reads process or imports node:*).
import { eawOf } from './eaw-table.ts'

// Created on first use, so a Node without Intl.Segmenter reaches main()'s message
// instead of failing at import.
let segmenter: Intl.Segmenter | undefined
export function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return Array.from(segmenter.segment(text), s => s.segment)
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
export function graphemeWidth(g: string, ambiguous: number = 2): number {
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

/** Cells of plain text (no escapes). `ambiguous` = cells for an East Asian Width A character. */
export function textCells(text: string, ambiguous: number = 2): number {
  let n = 0
  for (const g of graphemes(text)) n += graphemeWidth(g, ambiguous)
  return n
}
