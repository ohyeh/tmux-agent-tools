// P7 launcher, on a private tmux socket `tac-test-<pid>` (never the user's server).
// (a) fails if the collector is started with the TUI pane id: paste-buffer -t that
// id would put the marker on the TUI capture, the host capture would miss it, and
// the collector command line would not contain `--pane <host>`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionDirOf, v3Of } from './workers.ts'

const LAUNCHER = new URL('./launcher.node.ts', import.meta.url).pathname
const SOCK = `tac-test-${process.pid}`

let gate = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(fn, fn)
  gate = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function tmux(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    execFile('tmux', ['-L', SOCK, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, out: stdout ?? '', err: stderr ?? '' })
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function until(p: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await p()) return
    if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

type Live = {
  root: string
  cwd: string
  session: string
  env: NodeJS.ProcessEnv
  socketPath: string
  children: ChildProcess[]
}

async function live(tag: string): Promise<Live> {
  await tmux(['kill-server'])
  const root = mkdtempSync(join(tmpdir(), 'p7-'))
  const cwd = join(root, 'repo')
  mkdirSync(cwd)
  const session = `p7-${process.pid}-${tag}`
  const started = await tmux(['new-session', '-d', '-s', session, '-x', '200', '-y', '40', 'cat'])
  assert.equal(started.code, 0, started.err)
  const socketPath = (await tmux(['display-message', '-p', '-t', session, '#{socket_path}'])).out.trim()
  const serverPid = (await tmux(['display-message', '-p', '-t', session, '#{pid}'])).out.trim()
  const env: NodeJS.ProcessEnv = { ...process.env, TMUX: `${socketPath},${serverPid},0`, TMUX_AGENT_DIR: root }
  delete env.TMUX_PANE
  const routed = await new Promise<string>((resolve, reject) => {
    execFile('tmux', ['display-message', '-p', '#{socket_path}'], { encoding: 'utf8', env }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout.trim())
    })
  })
  assert.equal(routed, socketPath, 'TMUX must select the private socket before any launcher spawn')
  return { root, cwd, session, env, socketPath, children: [] }
}

async function cleanup(w: Live | undefined): Promise<void> {
  if (!w) return
  for (const child of w.children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  const pidPath = `${sessionDirOf(v3Of(w.root), w.session)}/collector.pid`
  try {
    const pid = Number(readFileSync(pidPath, 'utf8').trim().split(/\s+/)[0])
    if (pid > 0) process.kill(pid, 'SIGTERM')
  } catch {
    // no collector, or already dead
  }
  await sleep(200)
  await tmux(['kill-server'])
  rmSync(w.root, { recursive: true, force: true })
}

function hostPane(session: string): Promise<string> {
  return tmux(['display-message', '-p', '-t', session, '#{pane_id}']).then(r => r.out.trim())
}

function spawnLauncher(w: Live, pane: string): ChildProcess & { out: string; err: string; closed: boolean } {
  const child = spawn(
    process.execPath,
    [LAUNCHER, '--session', w.session, '--cwd', w.cwd, '--pane', pane, '--', 'sh', '-c', 'cat'],
    { env: w.env, stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcess & { out: string; err: string; closed: boolean }
  child.out = ''
  child.err = ''
  child.closed = false
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (d: string) => {
    child.out += d
  })
  child.stderr?.on('data', (d: string) => {
    child.err += d
  })
  child.on('close', () => {
    child.closed = true
  })
  w.children.push(child)
  return child
}

async function ready(child: { out: string }): Promise<{ tui: string; host: string; pid: number; how: string }> {
  await until(() => /collector \d+ (started|reused)/.test(child.out), 'launcher status')
  const m = /tui (%\d+) beside host (%\d+); collector (\d+) (started|reused)/.exec(child.out)
  assert.ok(m, child.out)
  return { tui: m[1]!, host: m[2]!, pid: Number(m[3]), how: m[4]! }
}

function collectors(session: string): string[] {
  const out = execFileSync('ps', ['-ax', '-ww', '-o', 'pid=,command='], { encoding: 'utf8' })
  return out.split('\n').filter(line => line.includes('collector.node.ts') && line.includes(`--session ${session}`))
}

function writeResult(w: Live, marker: string): void {
  const name = 'w.abcde'
  const worker = `${v3Of(w.root)}/${name}`
  const ep = `${worker}/episodes/1`
  mkdirSync(`${ep}/sent`, { recursive: true })
  const since = Date.now() - 60_000
  writeFileSync(
    `${worker}/worker.json`,
    JSON.stringify({ profile: 'codex', name, dir: w.cwd, since, owner: w.session, ownerCwd: w.cwd, origin: 'assign' }),
  )
  writeFileSync(
    `${ep}/dispatch.json`,
    JSON.stringify({ seq: 1, since, owner: w.session, resultPath: `${worker}/result.json`, origin: 'launch' }),
  )
  writeFileSync(
    `${worker}/result.json`,
    JSON.stringify({ schema_version: 1, status: 'success', summary: marker, artifacts: [], errors: [], episode: 1 }),
  )
}

test('(a) with the TUI pane focused, a collector delivery lands in the host pane only', { timeout: 40_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('a')
      const pane = await hostPane(w.session)
      const child = spawnLauncher(w, pane)
      const status = await ready(child)
      assert.equal(status.how, 'started')
      assert.equal(status.host, pane)
      const beat = `${sessionDirOf(v3Of(w.root), w.session)}/act`
      await until(() => {
        try {
          return readdirSync(beat).some(n => n.endsWith('.beat'))
        } catch {
          return false
        }
      }, 'collector heartbeat')
      // The first pass has heartbeated; give the empty scan time to finish and sleep.
      await sleep(1_500)
      assert.equal((await tmux(['select-pane', '-t', status.tui])).code, 0)
      assert.equal((await tmux(['display-message', '-p', '-t', w.session, '#{pane_id}'])).out.trim(), status.tui)
      const marker = `P7HOST-${process.pid}-a`
      assert.doesNotMatch(await tmux(['capture-pane', '-p', '-S', '-300', '-t', pane]).then(r => r.out), new RegExp(marker))
      writeResult(w, marker)
      assert.equal((await tmux(['display-message', '-p', '-t', w.session, '#{pane_id}'])).out.trim(), status.tui, 'TUI stays focused')
      let hostScreen = ''
      try {
        await until(async () => {
          hostScreen = (await tmux(['capture-pane', '-p', '-S', '-300', '-t', pane])).out
          return hostScreen.includes(marker)
        }, 'delivery in the host pane')
      } catch (error) {
        const logPath = `${sessionDirOf(v3Of(w.root), w.session)}/collector.log`
        let log = ''
        try {
          log = readFileSync(logPath, 'utf8').slice(-2000)
        } catch {
          log = '(no collector log)'
        }
        assert.fail(`${(error as Error).message}\n--- collector log ---\n${log}\n--- host ---\n${hostScreen}`)
      }
      const tuiScreen = (await tmux(['capture-pane', '-p', '-S', '-300', '-t', status.tui])).out
      assert.equal((await tmux(['display-message', '-p', '-t', w.session, '#{pane_id}'])).out.trim(), status.tui)
      assert.doesNotMatch(tuiScreen, new RegExp(marker))
      const cmd = collectors(w.session).join('\n')
      assert.match(cmd, new RegExp(`--pane ${pane.replace('%', '\\%')}( |$)`))
      assert.doesNotMatch(cmd, new RegExp(`--pane ${status.tui.replace('%', '\\%')}( |$)`))
    } finally {
      await cleanup(w)
    }
  }),
)

test('(b) a second launch reuses the one collector', { timeout: 20_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('b')
      const pane = await hostPane(w.session)
      const first = await ready(spawnLauncher(w, pane))
      assert.equal(first.how, 'started')
      const second = await ready(spawnLauncher(w, pane))
      assert.equal(second.how, 'reused')
      assert.equal(second.pid, first.pid)
      assert.equal(collectors(w.session).length, 1)
    } finally {
      await cleanup(w)
    }
  }),
)

test('(c) killing the TUI pane leaves the collector alive', { timeout: 20_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('c')
      const pane = await hostPane(w.session)
      const child = spawnLauncher(w, pane)
      const status = await ready(child)
      assert.equal((await tmux(['kill-pane', '-t', status.tui])).code, 0)
      await sleep(1_000)
      assert.equal(child.exitCode, null)
      assert.doesNotThrow(() => process.kill(status.pid, 0))
      assert.equal(collectors(w.session).length, 1)
    } finally {
      await cleanup(w)
    }
  }),
)

test('(d) killing the host pane exits the collector and the launcher names the pane', { timeout: 30_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('d')
      const pane = await hostPane(w.session)
      const child = spawnLauncher(w, pane)
      const status = await ready(child)
      assert.equal(status.host, pane)
      assert.doesNotThrow(() => process.kill(status.pid, 0))
      assert.equal((await tmux(['kill-pane', '-t', pane])).code, 0)
      await until(() => child.closed, 'launcher exit', 8_000)
      assert.equal(child.exitCode, 1)
      assert.match(child.err, new RegExp(`host pane ${pane.replace('%', '\\%')} is gone`))
      await until(() => {
        try {
          process.kill(status.pid, 0)
          return false
        } catch {
          return true
        }
      }, 'collector exit', 20_000)
      const log = readFileSync(`${sessionDirOf(v3Of(w.root), w.session)}/collector.log`, 'utf8')
      assert.match(log, new RegExp(`host pane ${pane.replace('%', '\\%')} is gone`))
    } finally {
      await cleanup(w)
    }
  }),
)

test('(e) a bad --pane exits 2 and names it', { timeout: 20_000 }, () =>
  exclusive(async () => {
    const format = await new Promise<{ code: number; err: string }>(resolve => {
      const child = spawn(process.execPath, [LAUNCHER, '--session', 's', '--cwd', '/tmp', '--pane', 'main', '--', 'sh', '-c', 'cat'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let err = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (d: string) => {
        err += d
      })
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      child.on('close', code => {
        clearTimeout(timer)
        resolve({ code: code ?? -1, err })
      })
    })
    assert.equal(format.code, 2)
    assert.match(format.err, /main/)

    let w: Live | undefined
    try {
      w = await live('e')
      const pane = await hostPane(w.session)
      const before = (await tmux(['list-panes', '-t', w.session, '-F', '#{pane_id}'])).out.trim().split('\n')
      assert.equal((await tmux(['kill-pane', '-t', pane])).code, 0)
      const dead = await new Promise<{ code: number; err: string }>(resolve => {
        const child = spawn(
          process.execPath,
          [LAUNCHER, '--session', w!.session, '--cwd', w!.cwd, '--pane', pane, '--', 'sh', '-c', 'cat'],
          { env: w!.env, stdio: ['ignore', 'ignore', 'pipe'] },
        )
        let err = ''
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (d: string) => {
          err += d
        })
        const timer = setTimeout(() => child.kill('SIGKILL'), 8_000)
        child.on('close', code => {
          clearTimeout(timer)
          resolve({ code: code ?? -1, err })
        })
      })
      assert.equal(dead.code, 2, dead.err)
      assert.match(dead.err, new RegExp(`host pane ${pane.replace('%', '\\%')} is not alive`))
      const after = (await tmux(['list-panes', '-s', '-F', '#{pane_id}'])).out
      assert.equal(after.trim(), '', 'a dead pane must not be split')
      assert.ok(before.includes(pane))
    } finally {
      await cleanup(w)
    }
  }),
)

test('(f) real TUI shows this session worker, not a viewer', { timeout: 40_000 }, () =>
  exclusive(async () => {
    const root = mkdtempSync(join(tmpdir(), 'p7-f-'))
    const cwd = join(root, 'repo')
    const bin = join(root, 'bin')
    const socket = join(root, 'tmux.sock')
    mkdirSync(bin)
    mkdirSync(cwd)
    // getcwd resolves /var → /private/var; sameProject compares the strings.
    const dir = realpathSync(cwd)
    writeFileSync(
      join(bin, 'agent-tmux'),
      `#!/bin/sh
# fixture: never calls tmux
if [ "$2" = status ]; then
  printf '%s\\n' '{"exists":true,"running":true,"blocked_reason":"permission","idle_seconds":30}'
  exit 0
fi
exit 0
`,
    )
    chmodSync(join(bin, 'agent-tmux'), 0o755)
    const session = 'owner'
    const name = 'w.abcde'
    const worker = `${v3Of(root)}/${name}`
    const now = Date.now() - 60_000
    for (const seq of [1, 2]) {
      const ep = `${worker}/episodes/${seq}`
      mkdirSync(`${ep}/sent`, { recursive: true })
      writeFileSync(
        `${ep}/dispatch.json`,
        JSON.stringify({ seq, since: now, owner: session, resultPath: `${ep}/result.json`, origin: 'tell' }),
      )
    }
    mkdirSync(`${worker}/episodes/1/acks/done`, { recursive: true })
    writeFileSync(
      `${worker}/worker.json`,
      JSON.stringify({ profile: 'codex', name, dir, ownerCwd: dir, owner: session, since: now, origin: 'assign' }),
    )
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      TMUX_AGENT_DIR: root,
      TMUX_AGENT_TMUX_SOCKET: socket,
    }
    delete env.TMUX
    delete env.TMUX_PANE
    assert.equal(env.TMUX, undefined)
    assert.equal(env.TMUX_PANE, undefined)
    const tmuxS = (args: string[]) =>
      new Promise<{ code: number; out: string; err: string }>(resolve => {
        const childEnv = { ...env }
        delete childEnv.TMUX
        delete childEnv.TMUX_PANE
        execFile('tmux', ['-S', socket, ...args], { encoding: 'utf8', env: childEnv }, (error, stdout, stderr) => {
          resolve({
            code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
            out: stdout ?? '',
            err: stderr ?? '',
          })
        })
      })
    const children: ChildProcess[] = []
    let collectorPid = 0
    try {
      const started = await tmuxS(['new-session', '-d', '-s', 'fxv', '-c', dir, '-x', '200', '-y', '40', 'cat'])
      assert.equal(started.code, 0, started.err)
      const pane = (await tmuxS(['display-message', '-p', '-t', 'fxv', '#{pane_id}'])).out.trim()
      assert.match(pane, /^%\d+$/)
      const tui = new URL('./tui.node.ts', import.meta.url).pathname
      const child = spawn(
        process.execPath,
        [LAUNCHER, '--session', session, '--cwd', dir, '--pane', pane, '--socket', socket, '--', process.execPath, tui],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      children.push(child)
      let out = ''
      let err = ''
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (d: string) => {
        out += d
      })
      child.stderr?.on('data', (d: string) => {
        err += d
      })
      await until(() => /collector \d+ (started|reused)/.test(out), 'launcher status')
      const m = /tui (%\d+) beside host (%\d+); collector (\d+) (started|reused)/.exec(out)
      assert.ok(m, `${out}\n${err}`)
      collectorPid = Number(m[3])
      assert.equal(m[4], 'started')
      let screen = ''
      try {
        await until(async () => {
          screen = (await tmuxS(['capture-pane', '-p', '-t', m[1]!])).out
          return screen.includes(name) && screen.includes('needs input') && !screen.includes('viewer — no session')
        }, 'owner worker on the real TUI')
      } catch (error) {
        assert.fail(`${(error as Error).message}\n--- screen ---\n${screen}\n--- launcher ---\n${out}\n${err}`)
      }
      assert.match(screen, /@owner/)
      assert.doesNotThrow(() => process.kill(collectorPid, 0))
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      }
      if (collectorPid > 0) {
        try {
          process.kill(collectorPid, 'SIGTERM')
        } catch {
          // already gone
        }
      }
      await sleep(200)
      await tmuxS(['kill-server'])
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(root, { recursive: true, force: true })
          break
        } catch (error) {
          if (i === 4) throw error
          await sleep(100)
        }
      }
    }
  }),
)
