// A stand-in for cursor-agent's composer, for collector.contract.node.ts: node fake-cursor.mjs <dir>.
// <dir>/mode = idle | busy | permission | shell | unknown | mangle (the composer shows the
// text with junk added); <dir>/draft = text already in the composer; touching <dir>/clear empties it. Every paste and every
// Enter is appended to <dir>/log, so a test can prove what was (not) sent.
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'

const dir = process.argv[2]
let buf = existsSync(`${dir}/draft`) ? readFileSync(`${dir}/draft`, 'utf8') : ''
let inPaste = false
const history = [] // what was submitted, shown above the composer like a transcript
const log = s => appendFileSync(`${dir}/log`, `${s}\n`)
const mode = () => (existsSync(`${dir}/mode`) ? readFileSync(`${dir}/mode`, 'utf8').trim() : 'idle')

function draw() {
  if (existsSync(`${dir}/clear`)) {
    rmSync(`${dir}/clear`)
    buf = ''
  }
  const m = mode()
  const out = history.slice(-30)
  if (m === 'shell') out.push('user@host dir % ')
  else if (m === 'permission') out.push('  Would you like to run the following command?', '  $ echo hi', '› 1. Yes, proceed (y)', '  2. No (esc)', '  Press enter to confirm or esc to cancel')
  else if (m === 'unknown') out.push('  something unexpected is on screen')
  else {
    const shown = m === 'mangle' && buf ? `${buf}XX` : buf
    const lines = shown ? shown.split('\n') : ['Plan, search, build anything']
    if (m === 'busy') out.push(' ⠰⠳ Working')
    out.push(' ▄▄▄▄▄▄▄▄▄▄▄▄', ...lines.map((l, i) => (i ? '    ' : '  → ') + l), ' ▀▀▀▀▀▀▀▀▀▀▀▀', '  [Model] │ dir')
  }
  process.stdout.write(`\x1b[2J\x1b[H${out.join('\r\n')}`)
}

process.stdout.write('\x1b[?2004h') // bracketed paste on, as a real TUI does
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', data => {
  for (const tok of data.split(/(\x1b\[20[01]~|\r)/).filter(Boolean)) {
    if (tok === '\x1b[200~') inPaste = true
    else if (tok === '\x1b[201~') {
      inPaste = false
      log(`PASTE:${JSON.stringify(buf)}`)
    } else if (tok === '\r' && inPaste) buf += '\n'
    else if (tok === '\r') {
      log(`ENTER:${mode()}:${JSON.stringify(buf)}`)
      if (mode() === 'idle' || mode() === 'mangle') {
        history.push(...buf.split('\n'))
        buf = ''
      }
    } else buf += tok
  }
  draw()
})
setInterval(draw, 100)
draw()
