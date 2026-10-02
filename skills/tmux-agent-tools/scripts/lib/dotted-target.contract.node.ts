// R1: reserve() draws `<base>.<5 base36>`. The wrapper must start, send, status,
// and stop that session. A bare `-t codex-cli-review.abcde` is pane `abcde`.
// Private socket only. agent-tmux treats an executable $TMUX as the tmux binary, then
// unsets it; the shim unsets TMUX/TMUX_PANE again and execs `tmux -S <abs>`.
// A bare PATH entry is not enough: zsh scripts source zshenv, which can hide it.
// Inside a pane, TMUX outranks TMUX_TMPDIR, so the real client must not see it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeHost } from './host.node.ts'
import { reserve, v3Of, type Host } from './workers.ts'

const AGENT = new URL('../agent-tmux', import.meta.url).pathname
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  delete env.TMUX
  delete env.TMUX_PANE
  return env
}
const realTmux = execFileSync('/bin/zsh', ['-c', 'command -v tmux'], { encoding: 'utf8', env: cleanEnv() }).trim()

type Run = { exitCode: number; stdout: string; stderr: string }

function exec(bin: string, args: string[], env: NodeJS.ProcessEnv, timeout = 20_000): Promise<Run> {
  return new Promise(resolve => {
    execFile(bin, args, { encoding: 'utf8', env, timeout }, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        stdout: stdout ?? '',
        stderr: stderr || (error && typeof error.code !== 'number' ? String(error) : ''),
      })
    })
  })
}

test('reserved dotted name: start, send, status, stop on a private socket', async () => {
  const priv = mkdtempSync(join(tmpdir(), 'dotted-'))
  const sock = join(priv, 'sock')
  const shimDir = join(priv, 'bin')
  const root = join(priv, 'state')
  const repo = join(priv, 'repo')
  mkdirSync(shimDir)
  mkdirSync(root)
  mkdirSync(repo)
  const shim = join(shimDir, 'tmux')
  writeFileSync(shim, `#!/bin/sh\nunset TMUX TMUX_PANE\nexec '${realTmux}' -S '${sock}' "$@"\n`)
  chmodSync(shim, 0o755)
  const fake = join(priv, 'fake.sh')
  writeFileSync(fake, '#!/bin/sh\necho ready\nwhile IFS= read -r line; do printf "%s\\n" "got:$line"; done\n')
  chmodSync(fake, 0o755)
  const prof = join(priv, 'codex.conf')
  writeFileSync(prof, `bin=${fake}\nexec_mode=interactive\nprompt_via=paste\nprompt_delivery=paste\nsession_id_capture=off\n`)

  const tmux = (args: string[]) => exec(realTmux, ['-S', sock, ...args], cleanEnv())
  const base = nodeHost({ owner: 'dotted', cwd: repo, log: () => {} })
  const host: Host = {
    ...base,
    run: (argv, cwd, ms) => (argv[0] === 'tmux' ? tmux(argv.slice(1)) : base.run(argv, cwd, ms)),
  }
  const wrapperEnv = cleanEnv()
  wrapperEnv.TMUX_AGENT_DIR = root
  wrapperEnv.TMUX = shim
  const wrapper = (args: string[]) => exec(AGENT, args, wrapperEnv, 60_000)

  let session = ''
  try {
    const rec = { profile: 'codex', dir: repo, since: Date.now(), owner: 'dotted', ownerCwd: repo, origin: 'assign' as const }
    const reserved = await reserve(host, v3Of(root), 'review', rec, repo, () => 'abcde')
    assert.ok(!('deny' in reserved), 'deny' in reserved ? reserved.deny : '')
    assert.equal(reserved.name, 'review.abcde')

    const started = await wrapper(['codex', '--profile', prof, 'start', '--exact', reserved.name, repo])
    assert.equal(started.exitCode, 0, `${started.stderr}\n${started.stdout}`)
    session = started.stdout.match(/Started (\S+)/)?.[1] ?? ''
    assert.equal(session, 'codex-cli-review.abcde')
    assert.equal((await tmux(['has-session', '-t', `=${session}:`])).exitCode, 0, 'exact target sees the session start created')

    const sent = await wrapper(['codex', '--profile', prof, 'send', reserved.name, 'dotted-ping'])
    assert.equal(sent.exitCode, 0, `${sent.stderr}\n${sent.stdout}`)

    const status = await wrapper(['codex', '--profile', prof, 'status', '--json', reserved.name])
    assert.equal(status.exitCode, 0, status.stderr)
    const row = JSON.parse(status.stdout) as { exists?: boolean; running?: boolean }
    assert.equal(row.exists, true)
    assert.equal(row.running, true)

    const stopped = await wrapper(['codex', '--profile', prof, 'stop', reserved.name])
    assert.equal(stopped.exitCode, 0, `${stopped.stderr}\n${stopped.stdout}`)
    assert.notEqual((await tmux(['has-session', '-t', `=${session}:`])).exitCode, 0)
  } finally {
    if (session) await tmux(['kill-session', '-t', `=${session}:`])
    await tmux(['kill-server'])
    rmSync(priv, { recursive: true, force: true })
  }
})
