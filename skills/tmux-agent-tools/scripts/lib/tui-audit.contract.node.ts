// I2: a TUI destructive stop writes caller, the acting session, and the row holder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeHost } from './host.node.ts'
import { newGate, stopWorker, writeTuiAudit, type Host, type TmuxDispatch } from './workers.ts'

const agentTmux = fileURLToPath(new URL('../agent-tmux', import.meta.url))
const scripts = fileURLToPath(new URL('..', import.meta.url))

function stopEnv(dir: string, log: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, XDG_STATE_HOME: join(dir, 'xdg') }
  delete env.TMUX
  delete env.TMUX_PANE
  env.TMUX_AGENT_DIR = join(dir, 'state')
  env.TMUX_AGENT_TOOLS_AUDIT_LOG = log
  env.TMUX_AGENT_TMUX_SOCKET = join(dir, 'sock')
  return env
}

function stopRow(log: string): { caller?: string; session?: string | null; holder?: string | null; name?: string; event?: string } {
  const row = readFileSync(log, 'utf8').trim().split('\n').find(line => line.includes('"wrapper.stop"'))
  assert.ok(row, 'missing wrapper.stop')
  return JSON.parse(row) as { caller?: string; session?: string | null; holder?: string | null; name?: string; event?: string }
}

test('I2: TUI stop audit row has caller tmux-agent-tui, the acting session, and holder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-audit-'))
  const log = join(dir, 'audit.jsonl')
  try {
    const run = spawnSync(agentTmux, ['e2ecli', 'stop', 'wa.pco10', '--tui-audit', JSON.stringify({ session: 'acc-owner', holder: 'row-holder' })], { env: stopEnv(dir, log), encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr || run.stdout)
    const parsed = stopRow(log)
    assert.equal(parsed.name, 'wa.pco10')
    assert.equal(parsed.caller, 'tmux-agent-tui')
    assert.equal(parsed.session, 'acc-owner')
    assert.equal(parsed.holder, 'row-holder')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('I2: an empty acting session and holder are null on the stop row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-audit-'))
  const log = join(dir, 'audit.jsonl')
  try {
    const run = spawnSync(agentTmux, ['e2ecli', 'stop', 'wa.none', '--tui-audit', JSON.stringify({ session: null, holder: null })], { env: stopEnv(dir, log), encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr || run.stdout)
    const parsed = stopRow(log)
    assert.equal(parsed.caller, 'tmux-agent-tui')
    assert.equal(parsed.session, null)
    assert.equal(parsed.holder, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('I2: stopWorker puts the TUI identity on the stop argv', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-audit-'))
  const base = nodeHost({ cwd: dir, log: () => {} })
  base.envTmuxAgentDir = async () => dir
  let seen: string | undefined
  const host: Host = {
    ...base,
    run: async (argv, cwd, ms) => {
      if (argv[0] === 'agent-tmux' && argv.includes('stop')) {
        seen = argv[argv.indexOf('--tui-audit') + 1]
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return base.run(argv, cwd, ms)
    },
  }
  const d: TmuxDispatch = { profile: 'e2ecli', name: 'wa', dir, since: 1 }
  mkdirSync(join(dir, '.v3', 'wa', 'episodes'), { recursive: true })
  try {
    const out = await stopWorker(host, newGate(), d, undefined, { session: 'acc-owner', holder: 'row-holder' })
    assert.equal(out.ok, true, out.text)
    assert.equal(seen, JSON.stringify({ session: 'acc-owner', holder: 'row-holder' }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('I2: cancel and unlock append through the same audit log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-audit-'))
  const log = join(dir, 'audit.jsonl')
  const prevPath = process.env.PATH
  const prevLog = process.env.TMUX_AGENT_TOOLS_AUDIT_LOG
  const prevHome = process.env.HOME
  process.env.HOME = dir
  process.env.PATH = `${scripts}:${prevPath ?? ''}`
  process.env.TMUX_AGENT_TOOLS_AUDIT_LOG = log
  const host = nodeHost({ cwd: dir, log: () => {} })
  host.envTmuxAgentDir = async () => dir
  try {
    await writeTuiAudit(host, 'cancel', { tool: 'e2ecli', name: 'wa', session: 'acc-owner', holder: null, ok: true })
    await writeTuiAudit(host, 'unlock', { tool: 'e2ecli', name: 'wa', session: null, holder: 'row-holder', ok: false })
    const lines = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string; caller: string; session: string | null; holder: string | null })
    assert.equal(lines[0]?.event, 'wrapper.cancel')
    assert.equal(lines[0]?.caller, 'tmux-agent-tui')
    assert.equal(lines[0]?.session, 'acc-owner')
    assert.equal(lines[0]?.holder, null)
    assert.equal(lines[1]?.event, 'wrapper.unlock')
    assert.equal(lines[1]?.caller, 'tmux-agent-tui')
    assert.equal(lines[1]?.session, null)
    assert.equal(lines[1]?.holder, 'row-holder')
  } finally {
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    if (prevLog === undefined) delete process.env.TMUX_AGENT_TOOLS_AUDIT_LOG
    else process.env.TMUX_AGENT_TOOLS_AUDIT_LOG = prevLog
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  }
})
