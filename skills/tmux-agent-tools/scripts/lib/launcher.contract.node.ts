// P7 launcher, on a private tmux socket `tac-test-<pid>` (never the user's server).
// (a) fails if the collector is started with the TUI pane id: paste-buffer -t that
// id would put the marker on the TUI capture, the host capture would miss it, and
// the collector command line would not contain `--pane <host>`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { nodeHost } from './host.node.ts'
import { acquireLock, releaseLock, type Holder } from './ledger.ts'
import { takeLauncherLock, unlockLauncher } from './launcher.node.ts'
import { holderProvablyAlive, processId, sessionDirOf, v3Of, type Host } from './workers.ts'

const LAUNCHER = fileURLToPath(new URL('./launcher.node.ts', import.meta.url))
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
  const env = { ...process.env }
  delete env.TMUX
  delete env.TMUX_PANE
  return new Promise(resolve => {
    execFile('tmux', ['-L', SOCK, ...args], { encoding: 'utf8', env, timeout: 20_000 }, (error, stdout, stderr) => {
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
  // The host is a fake composer; its state dir is named cursor-agent-* so the collector's `hostCli` finds the CLI.
  const fake = new URL('./fixtures/composer/fake-cursor.mjs', import.meta.url).pathname
  const started = await tmux(['new-session', '-d', '-s', session, '-x', '200', '-y', '40', `${process.execPath} ${fake} ${mkdtempSync(join(tmpdir(), 'cursor-agent-fake-'))}`])
  assert.equal(started.code, 0, started.err)
  const socketPath = (await tmux(['display-message', '-p', '-t', session, '#{socket_path}'])).out.trim()
  const serverPid = (await tmux(['display-message', '-p', '-t', session, '#{pid}'])).out.trim()
  const env: NodeJS.ProcessEnv = { ...process.env, TMUX: `${socketPath},${serverPid},0`, TMUX_AGENT_DIR: root }
  delete env.TMUX_PANE
  const routed = await new Promise<string>((resolve, reject) => {
    execFile('tmux', ['display-message', '-p', '#{socket_path}'], { encoding: 'utf8', env, timeout: 15_000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout.trim())
    })
  })
  assert.equal(routed, socketPath, 'TMUX must select the private socket before any launcher spawn')
  return { root, cwd, session, env, socketPath, children: [] }
}

/** SIGTERM the collector `collector.json` names (the launcher writes no pid file). */
function killRecorded(root: string, session: string): void {
  try {
    const pid = Number(JSON.parse(readFileSync(`${sessionDirOf(v3Of(root), session)}/collector.json`, 'utf8')).pid)
    if (pid > 0) process.kill(pid, 'SIGTERM')
  } catch {
    // no collector, or already dead
  }
}

async function cleanup(w: Live | undefined): Promise<void> {
  if (!w) return
  for (const child of w.children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  killRecorded(w.root, w.session)
  await sleep(200)
  await tmux(['kill-server'])
  rmSync(w.root, { recursive: true, force: true })
}

function hostPane(session: string): Promise<string> {
  return tmux(['display-message', '-p', '-t', session, '#{pane_id}']).then(r => r.out.trim())
}

function spawnLauncher(
  w: Live,
  pane: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; launcher?: string } = {},
): ChildProcess & { out: string; err: string; closed: boolean } {
  const child = spawn(
    process.execPath,
    [opts.launcher ?? LAUNCHER, '--session', w.session, '--cwd', opts.cwd ?? w.cwd, '--pane', pane, '--', 'sh', '-c', 'cat'],
    { env: opts.env ?? w.env, stdio: ['ignore', 'pipe', 'pipe'] },
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

test('(c2) beside the top half of a vertical split, the TUI pane still gets the full window height (T1 C4)', { timeout: 20_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('c2')
      const pane = await hostPane(w.session)
      assert.equal((await tmux(['split-window', '-v', '-d', '-t', pane, 'cat'])).code, 0)
      const height = (t: string, f: string) => tmux(['display-message', '-p', '-t', t, f]).then(r => Number(r.out.trim()))
      const windowHeight = await height(pane, '#{window_height}')
      assert.ok((await height(pane, '#{pane_height}')) < windowHeight, 'the host pane is the top half')
      const status = await ready(spawnLauncher(w, pane))
      assert.equal(await height(status.tui, '#{pane_height}'), windowHeight)
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
        execFile('tmux', ['-S', socket, ...args], { encoding: 'utf8', env: childEnv, timeout: 20_000 }, (error, stdout, stderr) => {
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

// ── C-lock (plan §1b): `collector.owner` is the core action lock, never taken over ──

const LIB = (f: string) => pathToFileURL(fileURLToPath(new URL(f, import.meta.url))).href

/**
 * One contender as its own OS process: take the launcher lock, hold it `HOLD` ms,
 * release it only when `RELEASE=1` (otherwise exit holding it: a crashed launcher).
 * `CRASH=after-ln`: exit 9 right after the `ln -sn` that took the lock.
 */
const CONTENDER = `
const { takeLauncherLock } = await import(process.env.L)
const { nodeHost } = await import(process.env.H)
const { releaseLock } = await import(process.env.LE)
const base = nodeHost({ log: () => {} })
const host = { ...base, run: async (argv, cwd, ms) => {
  const r = await base.run(argv, cwd, ms)
  if (process.env.CRASH === 'after-ln' && argv[0] === 'ln' && r.exitCode === 0) process.exit(9)
  return r
} }
const say = o => process.stdout.write(JSON.stringify({ ...o, at: Date.now() }) + '\\n')
try {
  const token = await takeLauncherLock(host, process.env.DIR, process.env.S)
  say({ won: token })
  await new Promise(r => setTimeout(r, Number(process.env.HOLD || 0)))
  // releasing is stamped before the unlink: a waiter can win before released is written.
  if (process.env.RELEASE === '1') say({ releasing: true })
  if (process.env.RELEASE === '1') say({ released: (await releaseLock(host, process.env.DIR + '/collector.owner', token)).ok })
} catch (error) {
  say({ busy: error.message })
}
`

type Said = { won?: string; releasing?: boolean; released?: boolean; busy?: string; at: number }

function contender(dir: string, env: Record<string, string> = {}): Promise<{ code: number; said: Said[] }> {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', CONTENDER],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, L: LIB('./launcher.node.ts'), H: LIB('./host.node.ts'), LE: LIB('./ledger.ts'), DIR: dir, S: 'lock-s', ...env },
      },
      (error, stdout) => {
        const said = stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Said)
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, said })
      },
    )
  })
}

function lockDir(): { root: string; dir: string; lock: string } {
  const root = mkdtempSync(join(tmpdir(), 'clock-'))
  const dir = sessionDirOf(v3Of(root), 'lock-s')
  mkdirSync(dir, { recursive: true })
  return { root, dir, lock: `${dir}/collector.owner` }
}

const holderOf = (lock: string) => JSON.parse(readlinkSync(lock)) as Holder
/** The lock is a symlink to a JSON string, never a real path: `existsSync` follows it and says false. */
const linked = (path: string) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function maintenance(root: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, [LAUNCHER, ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, TMUX_AGENT_DIR: root } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, out: `${stdout}${stderr}` })
    })
  })
}

test('C-lock: 6 concurrent acquires, exactly one wins; its crash leaves busy + the unlock command, never a steal', { timeout: 60_000 }, async () => {
  const w = lockDir()
  try {
    const runs = await Promise.all(Array.from({ length: 6 }, () => contender(w.dir, { HOLD: '1500' })))
    const said = runs.flatMap(r => r.said)
    const winners = said.filter(s => s.won)
    assert.equal(winners.length, 1, JSON.stringify(said))
    const busy = said.filter(s => s.busy)
    assert.equal(busy.length, 5)
    for (const b of busy) {
      assert.match(b.busy!, /gone/, 'the losers waited while it ran, then saw it gone')
      assert.match(b.busy!, /--unlock-launcher 'lock-s' --yes/)
    }
    assert.equal(holderOf(w.lock).token, winners[0]!.won, 'nobody took the dead holder\'s lock over')
    const again = await contender(w.dir)
    assert.match(again.said[0]?.busy ?? '', /gone/)
    assert.equal(holderOf(w.lock).token, winners[0]!.won)
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('C-lock: crash right after the ln -sn publish → busy (no steal); unlock needs --yes; then acquire succeeds', { timeout: 60_000 }, async () => {
  const w = lockDir()
  try {
    const crashed = await contender(w.dir, { CRASH: 'after-ln' })
    assert.equal(crashed.code, 9)
    const dead = holderOf(w.lock)
    assert.match((await contender(w.dir)).said[0]?.busy ?? '', /gone/)
    const ask = await maintenance(w.root, ['--unlock-launcher', 'lock-s'])
    assert.equal(ask.code, 1, ask.out)
    assert.match(ask.out, /--unlock-launcher 'lock-s' --yes/)
    assert.equal(holderOf(w.lock).token, dead.token, 'without --yes nothing is removed')
    const done = await maintenance(w.root, ['--unlock-launcher', 'lock-s', '--yes'])
    assert.equal(done.code, 0, done.out)
    assert.ok(!linked(w.lock))
    const next = await contender(w.dir, { RELEASE: '1' })
    assert.ok(next.said[0]?.won, JSON.stringify(next.said))
    assert.equal(next.said.find(s => 'released' in s)?.released, true)
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('C-lock: a holder alive for more than 10s is never stolen; a delayed release lets the waiter in after it', { timeout: 60_000 }, async () => {
  const w = lockDir()
  try {
    // HOLD leaves 3.5s after the 10.5s check for a slow runner to start the unlock while
    // the holder still holds (CI: 0.5s was too little, the unlock ran after the release).
    const holder = contender(w.dir, { HOLD: '14000', RELEASE: '1' })
    await until(() => linked(w.lock), 'the holder to take the lock')
    const token = holderOf(w.lock).token
    const waiter = contender(w.dir, { RELEASE: '1' })
    await sleep(10_500)
    assert.equal(holderOf(w.lock).token, token, 'still the first holder after 10.5s')
    const unlock = await maintenance(w.root, ['--unlock-launcher', 'lock-s', '--yes'])
    assert.equal(unlock.code, 1)
    assert.match(unlock.out, /still running/)
    const [h, x] = await Promise.all([holder, waiter])
    const releasing = h.said.find(s => s.releasing)!
    assert.ok(h.said.find(s => s.released), JSON.stringify(h.said))
    const won = x.said.find(s => s.won)
    assert.ok(won, JSON.stringify(x.said))
    assert.ok(won.at >= releasing.at, 'the waiter won only after the release began')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

/** A node host whose holder probes answer as given (`ps` exit/out, `kill -0` exit/err). */
function probing(ps: { exitCode: number; stdout: string }, kill?: { exitCode: number; stderr: string }): Host {
  const base = nodeHost({ log: () => {} })
  return {
    ...base,
    run: async (argv, cwd, ms) => {
      if (argv[0] === '/bin/sh' && argv[3] === 'ps') return { ...ps, stderr: '' }
      if (argv[0] === '/bin/sh' && argv[3] === 'kill') return kill ? { exitCode: kill.exitCode, stdout: '', stderr: kill.stderr } : base.run(argv, cwd, ms)
      return base.run(argv, cwd, ms)
    },
  }
}

test('R6.0 holderProvablyAlive: only ESRCH or another lstart is dead; EPERM and a failed ps are unknown', async () => {
  const me = await processId(nodeHost())
  const h = { host: me.host, pid: me.pid, pidStart: me.pidStart }
  assert.equal(await holderProvablyAlive(nodeHost(), h), true)
  assert.equal(await holderProvablyAlive(nodeHost(), { ...h, pidStart: 'Thu Jan  1 00:00:00 1970' }), false, 'pid reuse')
  assert.equal(await holderProvablyAlive(probing({ exitCode: 1, stdout: '' }, { exitCode: 1, stderr: 'sh: kill: (1) - Operation not permitted' }), h), undefined, 'EPERM')
  assert.equal(await holderProvablyAlive(probing({ exitCode: 1, stdout: '' }, { exitCode: 0, stderr: '' }), h), undefined, 'ps failed, the pid exists')
  assert.equal(await holderProvablyAlive(probing({ exitCode: 2, stdout: '' }, { exitCode: 127, stderr: 'sh: kill: not found' }), h), undefined, 'ps error')
  assert.equal(await holderProvablyAlive(probing({ exitCode: 1, stdout: '' }, { exitCode: 1, stderr: 'sh: kill: (9) - No such process' }), h), false, 'ESRCH')
  assert.equal(await holderProvablyAlive(nodeHost(), { ...h, host: `${me.host}-other` }), undefined, 'another host')
})

test('C-lock: EPERM or a ps error on the holder → busy at once, and --unlock-launcher refuses', async () => {
  const w = lockDir()
  try {
    const me = await processId(nodeHost())
    symlinkSync(JSON.stringify({ token: 'other', session: 'lock-s', activation: 'launcher', ...me }), w.lock)
    for (const host of [
      probing({ exitCode: 1, stdout: '' }, { exitCode: 1, stderr: 'sh: kill: (1) - Operation not permitted' }),
      probing({ exitCode: 2, stdout: '' }, { exitCode: 127, stderr: 'kill: not found' }),
    ]) {
      const t0 = Date.now()
      await assert.rejects(takeLauncherLock(host, w.dir, 'lock-s'), /busy: .*not provably alive or dead.*--unlock-launcher/)
      assert.ok(Date.now() - t0 < 5_000, 'an unprovable holder is reported, not waited for')
      const out = await unlockLauncher(host, w.root, 'lock-s', true)
      assert.equal(out.ok, false)
      assert.equal(holderOf(w.lock).token, 'other')
    }
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('C-lock: pid reuse (same pid, another pidStart) is provably dead: unlock is allowed', async () => {
  const w = lockDir()
  try {
    const me = await processId(nodeHost())
    symlinkSync(JSON.stringify({ token: 'old', session: 'lock-s', activation: 'launcher', ...me, pidStart: 'Thu Jan  1 00:00:00 1970' }), w.lock)
    await assert.rejects(takeLauncherLock(nodeHost(), w.dir, 'lock-s'), /gone/)
    const out = await unlockLauncher(nodeHost(), w.root, 'lock-s', true)
    assert.equal(out.ok, true, out.text)
    assert.ok(!linked(w.lock))
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('C-lock: an old holder\'s late finally never deletes the new lock', async () => {
  const w = lockDir()
  try {
    const host = nodeHost({ log: () => {} })
    const me = await processId(host)
    symlinkSync(JSON.stringify({ token: 'old', session: 'lock-s', activation: 'launcher', ...me, pidStart: 'Thu Jan  1 00:00:00 1970' }), w.lock)
    assert.equal((await unlockLauncher(host, w.root, 'lock-s', true)).ok, true)
    const fresh = await acquireLock(host, w.lock, { token: 'new', session: 'lock-s', activation: 'launcher', ...me })
    assert.equal(fresh.ok, true)
    assert.equal((await releaseLock(host, w.lock, 'old')).ok, false, 'the old holder\'s finally')
    assert.equal(holderOf(w.lock).token, 'new')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

// ── §1c S2 legacy migration and R6.2 collector identity, on private tmux servers ──

/** A process whose full args name `script` and the session, as an old launcher's or collector's would. */
function fake(w: Live, script: string, extra: string[] = []): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', script, '--session', w.session, ...extra], { stdio: 'ignore' })
  w.children.push(child)
  return child
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const record = (w: Live) => JSON.parse(readFileSync(`${sessionDirOf(v3Of(w.root), w.session)}/collector.json`, 'utf8'))
const hasRecord = (w: Live) => existsSync(`${sessionDirOf(v3Of(w.root), w.session)}/collector.json`)

async function busyLaunch(w: Live, pane: string): Promise<string> {
  const child = spawnLauncher(w, pane)
  await until(() => child.closed, 'the launcher to stop', 20_000)
  assert.equal(child.exitCode, 1, child.out + child.err)
  return child.err
}

test('S2: launcher holds the legacy lock dir, no pid yet — busy + migrate; migrate refuses while it runs, then moves', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('s2a')
      const dir = sessionDirOf(v3Of(w.root), w.session)
      mkdirSync(`${dir}/collector.lock`, { recursive: true })
      const old = fake(w, 'launcher.node.ts')
      const pane = await hostPane(w.session)
      const err = await busyLaunch(w, pane)
      assert.match(err, /busy: .*collector\.lock.*--migrate-launcher/)
      assert.ok(!hasRecord(w), 'no fake readiness')
      assert.equal(collectors(w.session).length, 0, 'nothing started')
      const refused = await maintenance(w.root, ['--migrate-launcher', w.session, '--yes'])
      assert.equal(refused.code, 1, refused.out)
      assert.match(refused.out, new RegExp(`busy: .*pid ${old.pid}`))
      assert.ok(existsSync(`${dir}/collector.lock`), 'nothing moved while the old launcher runs')
      assert.ok(alive(old.pid!), 'migrate kills nothing')
      old.kill('SIGTERM')
      await until(() => !alive(old.pid!), 'the old launcher to exit')
      const dry = await maintenance(w.root, ['--migrate-launcher', w.session])
      assert.equal(dry.code, 1)
      assert.match(dry.out, /would move collector\.lock/)
      const moved = await maintenance(w.root, ['--migrate-launcher', w.session, '--yes'])
      assert.equal(moved.code, 0, moved.out)
      const legacy = readdirSync(dir).filter(n => n.startsWith('legacy-'))
      assert.equal(legacy.length, 1)
      assert.ok(existsSync(`${dir}/${legacy[0]}/collector.lock`), 'moved, not deleted')
      assert.ok(!existsSync(`${dir}/collector.lock`))
      const status = await ready(spawnLauncher(w, pane))
      assert.equal(status.how, 'started')
      assert.equal(record(w).pid, status.pid)
    } finally {
      await cleanup(w)
    }
  }),
)

test('S2: legacy collector dead but its launcher alive — busy; no reuse, no kill', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('s2b')
      const dir = sessionDirOf(v3Of(w.root), w.session)
      const gone = spawn(process.execPath, ['-e', ''])
      await new Promise(r => gone.on('exit', r))
      const pane = await hostPane(w.session)
      mkdirSync(dir, { recursive: true })
      writeFileSync(`${dir}/collector.pid`, `${gone.pid} ${pane}\n`)
      const old = fake(w, 'launcher.node.ts')
      assert.match(await busyLaunch(w, pane), /busy: .*collector\.pid.*--migrate-launcher/)
      assert.ok(!hasRecord(w))
      const refused = await maintenance(w.root, ['--migrate-launcher', w.session, '--yes'])
      assert.equal(refused.code, 1)
      assert.ok(alive(old.pid!))
      assert.ok(existsSync(`${dir}/collector.pid`))
      old.kill('SIGTERM')
      await until(() => !alive(old.pid!), 'the old launcher to exit')
      const moved = await maintenance(w.root, ['--migrate-launcher', w.session, '--yes'])
      assert.equal(moved.code, 0, moved.out)
      assert.ok(!existsSync(`${dir}/collector.pid`))
    } finally {
      await cleanup(w)
    }
  }),
)

test('S2: a live legacy collector whose pid file names this pane number on another socket — busy, not reused, not killed', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('s2c')
      const dir = sessionDirOf(v3Of(w.root), w.session)
      const pane = await hostPane(w.session)
      const old = fake(w, 'collector.node.ts', ['--pane', pane, '--socket', '/elsewhere/other.sock'])
      mkdirSync(dir, { recursive: true })
      writeFileSync(`${dir}/collector.pid`, `${old.pid} ${pane}\n`)
      assert.match(await busyLaunch(w, pane), /busy: .*--migrate-launcher/)
      assert.ok(!hasRecord(w), 'no reuse by pane number')
      const refused = await maintenance(w.root, ['--migrate-launcher', w.session, '--yes'])
      assert.equal(refused.code, 1)
      assert.match(refused.out, /SIGTERM/)
      assert.ok(alive(old.pid!), 'not killed')
    } finally {
      await cleanup(w)
    }
  }),
)

test('S2: a legacy collector without state — the launcher starts its own (readiness from its own pid), the old one untouched', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('s2d')
      const pane = await hostPane(w.session)
      const old = fake(w, 'collector.node.ts', ['--pane', pane])
      const status = await ready(spawnLauncher(w, pane))
      assert.equal(status.how, 'started')
      assert.notEqual(status.pid, old.pid)
      assert.equal(record(w).pid, status.pid)
      assert.ok(alive(old.pid!), 'no wrong kill')
      const nothing = await maintenance(w.root, ['--migrate-launcher', w.session, '--yes'])
      assert.equal(nothing.code, 0)
      assert.match(nothing.out, /nothing to migrate/)
    } finally {
      await cleanup(w)
    }
  }),
)

test('R6.2: another pane of the same session → the old collector is stopped, a new one started for that pane', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('r62p')
      const pane = await hostPane(w.session)
      const first = await ready(spawnLauncher(w, pane))
      const split = await tmux(['split-window', '-d', '-t', pane, '-P', '-F', '#{pane_id}', 'cat'])
      const other = split.out.trim()
      assert.match(other, /^%\d+$/)
      const child = spawnLauncher(w, other)
      const second = await ready(child)
      assert.equal(second.how, 'started')
      assert.notEqual(second.pid, first.pid)
      assert.match(child.out, new RegExp(`replaced collector ${first.pid}`))
      await until(() => !alive(first.pid), 'the old collector to exit')
      assert.equal(record(w).pane, other)
      assert.equal(collectors(w.session).length, 1)
    } finally {
      await cleanup(w)
    }
  }),
)

test('R6.2: the same pane number on another tmux socket is not the same collector', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    const other = `${SOCK}-b`
    const tmuxB = (args: string[]) => {
      const env = { ...process.env }
      delete env.TMUX
      delete env.TMUX_PANE
      return new Promise<string>(resolve => execFile('tmux', ['-L', other, ...args], { encoding: 'utf8', env, timeout: 20_000 }, (_e, out) => resolve((out ?? '').trim())))
    }
    try {
      w = await live('r62s')
      const pane = await hostPane(w.session)
      const first = await ready(spawnLauncher(w, pane))
      await tmuxB(['kill-server'])
      await tmuxB(['new-session', '-d', '-s', 'b', '-x', '200', '-y', '40', 'cat'])
      const paneB = await tmuxB(['display-message', '-p', '-t', 'b', '#{pane_id}'])
      const socketB = await tmuxB(['display-message', '-p', '-t', 'b', '#{socket_path}'])
      const pidB = await tmuxB(['display-message', '-p', '-t', 'b', '#{pid}'])
      assert.equal(paneB, pane, 'both fresh servers number their first pane alike')
      const second = await ready(spawnLauncher(w, paneB, { env: { ...w.env, TMUX: `${socketB},${pidB},0` } }))
      assert.equal(second.how, 'started', 'not reused across sockets')
      assert.notEqual(second.pid, first.pid)
      assert.equal(record(w).socket, socketB)
      assert.notEqual(socketB, w.socketPath)
      await until(() => !alive(first.pid), 'the old collector to exit')
    } finally {
      await cleanup(w)
      await tmuxB(['kill-server'])
    }
  }),
)

test('R6.2: a relaunch with another cwd starts a collector for that cwd', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('r62c')
      const pane = await hostPane(w.session)
      const first = await ready(spawnLauncher(w, pane))
      assert.equal(record(w).cwd, w.cwd)
      const moved = join(w.root, 'repo2')
      mkdirSync(moved)
      const second = await ready(spawnLauncher(w, pane, { cwd: moved }))
      assert.equal(second.how, 'started')
      assert.notEqual(second.pid, first.pid)
      assert.equal(record(w).cwd, moved)
      const third = await ready(spawnLauncher(w, pane, { cwd: moved }))
      assert.equal(third.how, 'reused')
      assert.equal(third.pid, second.pid)
    } finally {
      await cleanup(w)
    }
  }),
)

test('R6.2: an install path with a space runs, and its collector is found again', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('r62sp')
      const launcher = install(w, 'install dir')
      const pane = await hostPane(w.session)
      const first = await ready(spawnLauncher(w, pane, { launcher }))
      assert.equal(first.how, 'started')
      assert.ok(collectors(w.session).some(l => l.includes('install dir/scripts/lib/collector.node.ts')))
      const version = /^AGENT_TMUX_VERSION='([^']+)'$/m.exec(readFileSync(join(SCRIPTS, 'agent-tmux'), 'utf8'))![1]
      assert.equal(record(w).coreVersion, version, 'the version of the wrapper in that install')
      const second = await ready(spawnLauncher(w, pane, { launcher }))
      assert.equal(second.how, 'reused')
      assert.equal(second.pid, first.pid)
    } finally {
      await cleanup(w)
    }
  }),
)

test('R6.2: an unwritable collector.log or a collector that exits before ready is an error, with no record left', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('r62e')
      const dir = sessionDirOf(v3Of(w.root), w.session)
      mkdirSync(dir, { recursive: true })
      const pane = await hostPane(w.session)
      writeFileSync(`${dir}/collector.log`, '')
      chmodSync(`${dir}/collector.log`, 0o000)
      assert.match(await busyLaunch(w, pane), /could not open .*collector\.log.*no collector started/)
      assert.ok(!hasRecord(w))
      assert.equal(collectors(w.session).length, 0)
      chmodSync(`${dir}/collector.log`, 0o644)
      writeFileSync(`${dir}/act`, 'not a directory')
      assert.match(await busyLaunch(w, pane), /the collector exited \(code 1\) before it was ready; collector\.log: .*not ready/s)
      assert.ok(!hasRecord(w), 'no fake readiness')
      assert.ok(!linked(`${dir}/collector.owner`), 'the lock is released on the error path')
      assert.equal(collectors(w.session).length, 0)
    } finally {
      await cleanup(w)
    }
  }),
)

// ── Sol r6 review (sol-review-r6.json items 1–6, 14): one named fixture per failure ──

const DEAD_START = 'Thu Jan  1 00:00:00 1970'

test('Sol#1 launcher unlock: A and B unlock one dead holder, C acquires at A\'s rm cut point — C\'s lock survives', async () => {
  const w = lockDir()
  try {
    const base = nodeHost({ log: () => {} })
    const me = await processId(base)
    symlinkSync(JSON.stringify({ token: 'old', session: 'lock-s', activation: 'launcher', ...me, pidStart: DEAD_START }), w.lock)
    const fresh: Holder = { token: 'new', session: 'lock-s', activation: 'launcher', ...me }
    let armed = true
    let b: { ok: boolean; text: string } | undefined
    let c = false
    const a: Host = {
      ...base,
      run: async (argv, cwd, ms) => {
        if (armed && argv[0] === 'rm' && argv[1] === w.lock) {
          armed = false
          b = await unlockLauncher(base, w.root, 'lock-s', true)
          c = (await acquireLock(base, w.lock, fresh)).ok
        }
        return base.run(argv, cwd, ms)
      },
    }
    const outA = await unlockLauncher(a, w.root, 'lock-s', true)
    assert.equal(armed, false, 'the cut point was reached')
    assert.equal(outA.ok, true, outA.text)
    assert.equal(b?.ok, false, `B unlocked while A's unlock ran: ${b?.text}`)
    assert.match(b!.text, /collector\.owner\.unlock/)
    if (!c) c = (await acquireLock(base, w.lock, fresh)).ok
    assert.equal(c, true, 'C acquires once A removed the dead holder')
    const late = await unlockLauncher(base, w.root, 'lock-s', true)
    assert.equal(late.ok, false, late.text)
    assert.equal(holderOf(w.lock).token, 'new', 'C\'s lock survives both unlocks')
    assert.ok(!linked(`${w.lock}.unlock`), 'the unlock lock is released')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('Sol#1 launcher unlock: a dead unlock holder is never taken over — busy, and how to clear it', async () => {
  const w = lockDir()
  try {
    const base = nodeHost({ log: () => {} })
    const me = await processId(base)
    symlinkSync(JSON.stringify({ token: 'old', session: 'lock-s', activation: 'launcher', ...me, pidStart: DEAD_START }), w.lock)
    symlinkSync(JSON.stringify({ token: 'u', session: 'lock-s', activation: 'unlock', ...me, pidStart: DEAD_START }), `${w.lock}.unlock`)
    const out = await unlockLauncher(base, w.root, 'lock-s', true)
    assert.equal(out.ok, false, out.text)
    assert.match(out.text, /busy: .*collector\.owner\.unlock.*gone.*rm /)
    assert.equal(holderOf(w.lock).token, 'old', 'nothing removed')
    assert.equal(holderOf(`${w.lock}.unlock`).token, 'u', 'the dead unlock holder is not taken over')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('Sol#3 launcher unlock: a readlink error (EACCES) is busy with the errno, never "not held"', async () => {
  const w = lockDir()
  try {
    const base = nodeHost({ log: () => {} })
    const me = await processId(base)
    symlinkSync(JSON.stringify({ token: 'old', session: 'lock-s', activation: 'launcher', ...me, pidStart: DEAD_START }), w.lock)
    const denied: Host = {
      ...base,
      run: async (argv, cwd, ms) =>
        argv[0] === 'readlink' && argv[1] === w.lock ? { exitCode: 1, stdout: '', stderr: '' } : base.run(argv, cwd, ms), // BSD readlink is silent
      list: async path => {
        if (path === w.dir) throw Object.assign(new Error(`EACCES: permission denied, scandir '${path}'`), { code: 'EACCES' })
        return base.list(path)
      },
    }
    const out = await unlockLauncher(denied, w.root, 'lock-s', true)
    assert.equal(out.ok, false, out.text)
    assert.doesNotMatch(out.text, /not held/)
    assert.match(out.text, /busy: .*EACCES/)
    assert.equal(holderOf(w.lock).token, 'old')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

/** The scripts dir of this checkout: `lib/` and the `agent-tmux` wrapper beside it. */
const SCRIPTS = fileURLToPath(new URL('..', import.meta.url))

/**
 * A copy of the install tree a collector needs (`scripts/lib` and `scripts/agent-tmux`)
 * under `<root>/<name>`; `collector` replaces `lib/collector.node.ts`. Returns the launcher.
 */
function install(w: Live, name: string, opts: { collector?: string; wrapper?: boolean } = {}): string {
  const scripts = join(w.root, name, 'scripts')
  cpSync(fileURLToPath(new URL('.', import.meta.url)), join(scripts, 'lib'), { recursive: true, filter: src => !src.includes('/fixtures') })
  if (opts.wrapper !== false) cpSync(join(SCRIPTS, 'agent-tmux'), join(scripts, 'agent-tmux'))
  if (opts.collector) {
    renameSync(join(scripts, 'lib', 'collector.node.ts'), join(scripts, 'lib', 'collector.real.node.ts'))
    writeFileSync(join(scripts, 'lib', 'collector.node.ts'), opts.collector)
  }
  return join(scripts, 'lib', 'launcher.node.ts')
}

/**
 * A stand-in collector: publishes a record for this pane, socket and cwd at once
 * (`STUB_MODE` bends it), writes its pid to `stub.pid`, and exits 0 after 4s. The
 * launcher's imports come from the real module, renamed beside it.
 */
const STUB = `
export { paneAlive, readCollectorRecord, serverSocket } from './collector.real.node.ts'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { sessionDirOf, v3Of } from './workers.ts'
// Imported by the launcher, nothing runs; run as the collector, it publishes.
if (process.argv[1]?.endsWith('collector.node.ts')) {
  const { values: v } = parseArgs({ options: { session: { type: 'string' }, cwd: { type: 'string' }, pane: { type: 'string' }, socket: { type: 'string' }, nonce: { type: 'string' } } })
  const dir = sessionDirOf(v3Of(process.env.TMUX_AGENT_DIR), v.session)
  const run = (cmd, args, env = {}) => execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } }).trim()
  const rec = {
    pid: process.pid,
    pidStart: run('ps', ['-o', 'lstart=', '-p', String(process.pid)], { TZ: 'UTC', LC_ALL: 'C' }),
    host: run('hostname', []),
    session: v.session, pane: v.pane, cwd: v.cwd,
    socket: run('tmux', ['display-message', '-p', '-t', v.pane, '#{socket_path}']),
    coreVersion: 'stub', token: 'stub', nonce: v.nonce,
  }
  const mode = process.env.STUB_MODE
  if (mode === 'stale-start') rec.pidStart = 'Thu Jan  1 00:00:00 1970'
  if (mode === 'no-nonce') delete rec.nonce
  writeFileSync(dir + '/stub.pid', String(process.pid))
  writeFileSync(dir + '/collector.json', mode === 'malformed' ? '{"pid": ' + process.pid : JSON.stringify(rec))
  setTimeout(() => process.exit(0), 4000)
}
`

test('Sol#2 a malformed or incomplete collector.json is unknown, not absent: busy with the reason, nothing started', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('sol2')
      const dir = sessionDirOf(v3Of(w.root), w.session)
      mkdirSync(dir, { recursive: true })
      const pane = await hostPane(w.session)
      for (const text of ['{"pid": 4', '{"pid": 4}']) {
        writeFileSync(`${dir}/collector.json`, text)
        assert.match(await busyLaunch(w, pane), /busy: .*collector\.json/)
        assert.equal(readFileSync(`${dir}/collector.json`, 'utf8'), text, 'left as it was')
        assert.equal(collectors(w.session).length, 0, 'no second collector')
      }
    } finally {
      await cleanup(w)
    }
  }),
)

test('Sol#2 readiness polling: a malformed record from the started child is an error at once, and the child is stopped', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('sol2p')
      const dir = sessionDirOf(v3Of(w.root), w.session)
      const launcher = install(w, 'stub', { collector: STUB })
      const pane = await hostPane(w.session)
      const child = spawnLauncher(w, pane, { launcher, env: { ...w.env, STUB_MODE: 'malformed' } })
      const t0 = Date.now()
      await until(() => child.closed, 'the launcher to stop', 20_000)
      assert.equal(child.exitCode, 1, child.out + child.err)
      assert.match(child.err, /could not read .*collector\.json/)
      assert.ok(Date.now() - t0 < 3_500, 'reported before the child exits on its own')
      const stub = Number(readFileSync(`${dir}/stub.pid`, 'utf8'))
      await until(() => !alive(stub), 'the child to be stopped', 2_000)
    } finally {
      await cleanup(w)
    }
  }),
)

test('Sol#4 a first beat that cannot be written blocks readiness: no collector.json, the launch fails', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('sol4')
      const dir = sessionDirOf(v3Of(w.root), w.session)
      mkdirSync(`${dir}/act/1.beat`, { recursive: true }) // the beat file of activation 1 cannot be written (EISDIR)
      const pane = await hostPane(w.session)
      assert.match(await busyLaunch(w, pane), /exited \(code 1\) before it was ready; collector\.log: .*could not beat.*not ready/s)
      assert.ok(!hasRecord(w), 'no fake readiness')
      assert.equal(collectors(w.session).length, 0)
    } finally {
      await cleanup(w)
    }
  }),
)

test('Sol#5 migrate: a live old launcher that is the maintenance process\'s own parent is busy; nothing moves', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mig-'))
  const session = `sol5-${process.pid}-p`
  const dir = sessionDirOf(v3Of(root), session)
  mkdirSync(`${dir}/collector.lock`, { recursive: true })
  const PARENT = `
const { execFile } = require('node:child_process')
execFile(process.execPath, [process.env.L, '--migrate-launcher', process.env.S, '--yes'], { encoding: 'utf8' }, (e, out, err) => {
  process.stdout.write(JSON.stringify({ code: e ? e.code : 0, out: out + err, parent: process.pid }))
})`
  try {
    const r = await new Promise<{ code: number; out: string; parent: number }>((resolve, reject) =>
      execFile(
        process.execPath,
        ['-e', PARENT, 'launcher.node.ts', '--session', session],
        { encoding: 'utf8', timeout: 30_000, env: { ...process.env, TMUX_AGENT_DIR: root, L: LAUNCHER, S: session } },
        (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout))),
      ),
    )
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, new RegExp(`busy: .*pid ${r.parent}\\b`))
    assert.ok(existsSync(`${dir}/collector.lock`), 'nothing moved')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Sol#5 migrate: the busy answer names the descendants of a live old launcher', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mig-'))
  const session = `sol5-${process.pid}-d`
  const dir = sessionDirOf(v3Of(root), session)
  mkdirSync(`${dir}/collector.lock`, { recursive: true })
  const pidFile = join(root, 'child.pid')
  const OLD = `
const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
require('node:fs').writeFileSync(process.env.CHILD, String(c.pid))
setInterval(() => {}, 1000)`
  const old = spawn(process.execPath, ['-e', OLD, 'launcher.node.ts', '--session', session], { stdio: 'ignore', env: { ...process.env, CHILD: pidFile } })
  let kid = 0
  try {
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 'the old launcher\'s child')
    kid = Number(readFileSync(pidFile, 'utf8'))
    const out = await maintenance(root, ['--migrate-launcher', session, '--yes'])
    assert.equal(out.code, 1, out.out)
    assert.match(out.out, new RegExp(`busy: .*pid ${old.pid}\\b`))
    assert.match(out.out, new RegExp(`pid ${kid}\\b`), 'its child is named too')
    assert.ok(existsSync(`${dir}/collector.lock`))
  } finally {
    old.kill('SIGTERM')
    if (kid > 0) {
      try {
        process.kill(kid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
})

for (const [mode, what] of [
  ['stale-start', 'the child\'s pid with another start time (a reused pid\'s stale record)'],
  ['no-nonce', 'the child\'s pid and start time but not this start\'s nonce'],
] as const) {
  test(`Sol#6 readiness: a record with ${what} is not this start's handshake; the child's exit is the error`, { timeout: 60_000 }, () =>
    exclusive(async () => {
      let w: Live | undefined
      try {
        w = await live(`sol6${mode[0]}`)
        const launcher = install(w, 'stub', { collector: STUB })
        const pane = await hostPane(w.session)
        const child = spawnLauncher(w, pane, { launcher, env: { ...w.env, STUB_MODE: mode } })
        await until(() => child.closed, 'the launcher to stop', 20_000)
        assert.equal(child.exitCode, 1, child.out + child.err)
        assert.doesNotMatch(child.out, /started|reused/)
        assert.match(child.err, /the collector exited \(code 0\) before it was ready/)
      } finally {
        await cleanup(w)
      }
    }),
  )
}

/**
 * ensureCollector in its own process (env selects the private tmux and the state
 * root). `DIE=1`: the liveness probe of the started child (a `ps -o lstart=` for a
 * pid not this process) gets its real answer, then the child is killed and the
 * answer held until the kill shows, so the child ends inside that await.
 */
const READINESS = `
const { ensureCollector } = await import(process.env.L)
const { nodeHost } = await import(process.env.H)
const base = nodeHost({ log: () => {} })
const host = { ...base, run: async (argv, cwd, ms) => {
  const r = await base.run(argv, cwd, ms)
  const pid = Number(argv[4])
  if (process.env.DIE === '1' && argv[3] === 'ps' && pid > 0 && pid !== process.pid && r.exitCode === 0) {
    process.kill(pid, 'SIGKILL')
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0) } catch { break }
      await new Promise(res => setTimeout(res, 20))
    }
    await new Promise(res => setTimeout(res, 300))
  }
  return r
} }
const say = o => process.stdout.write(JSON.stringify(o) + '\\n')
try {
  say({ pid: (await ensureCollector(host, { session: process.env.S, cwd: process.env.C, pane: process.env.P, root: process.env.TMUX_AGENT_DIR })).pid })
} catch (error) {
  say({ error: error.message })
}
`

test('Sol-r2#N3 readiness: a child that exits while its liveness probe is awaited is the early-exit error; the healthy start is ready', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('solr2n3')
      const launcher = install(w, 'stub', { collector: STUB })
      const pane = await hostPane(w.session)
      const run = (die: boolean) =>
        new Promise<{ pid?: number; error?: string }>(resolve => {
          execFile(
            process.execPath,
            ['--input-type=module', '-e', READINESS],
            { encoding: 'utf8', timeout: 30_000, env: { ...w!.env, L: pathToFileURL(launcher).href, H: pathToFileURL(join(dirname(launcher), 'host.node.ts')).href, S: w!.session, C: w!.cwd, P: pane, DIE: die ? '1' : '' } },
            (_error, stdout) => resolve(JSON.parse(stdout.trim().split('\n').pop() || '{}')),
          )
        })
      const dying = await run(true)
      assert.equal(dying.pid, undefined, `a dead pid was returned as ready: ${JSON.stringify(dying)}`)
      assert.match(dying.error ?? '', /the collector exited \(SIGKILL\) before it was ready/)
      rmSync(`${sessionDirOf(v3Of(w.root), w.session)}/collector.json`, { force: true })
      const healthy = await run(false)
      assert.ok((healthy.pid ?? 0) > 0, JSON.stringify(healthy))
      process.kill(healthy.pid!, 0) // alive: throws if not
    } finally {
      await cleanup(w)
    }
  }),
)

test('Sol#14 a missing or unreadable agent-tmux wrapper is not a ready collector: the error names it, no record', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('sol14')
      const pane = await hostPane(w.session)
      const missing = install(w, 'nowrap', { wrapper: false })
      const child = spawnLauncher(w, pane, { launcher: missing })
      await until(() => child.closed, 'the launcher to stop', 20_000)
      assert.equal(child.exitCode, 1, child.out + child.err)
      assert.match(child.err, /before it was ready; collector\.log: .*not ready.*nowrap\/scripts\/agent-tmux.*ENOENT/s)
      assert.ok(!hasRecord(w))
      const locked = install(w, 'locked')
      chmodSync(join(w.root, 'locked', 'scripts', 'agent-tmux'), 0o000)
      const second = spawnLauncher(w, pane, { launcher: locked })
      await until(() => second.closed, 'the launcher to stop', 20_000)
      assert.equal(second.exitCode, 1, second.out + second.err)
      assert.match(second.err, /before it was ready; collector\.log: .*not ready.*locked\/scripts\/agent-tmux.*EACCES/s)
      assert.ok(!hasRecord(w))
      assert.equal(collectors(w.session).length, 0)
    } finally {
      await cleanup(w)
    }
  }),
)

// ── Sol r6 re-review (sol-rereview-r6.json N1, N4) ──

test('Sol r6 N1: a dead holder\'s orphan release child (rm still pending) cannot delete a newer holder\'s lock', { timeout: 60_000 }, async () => {
  const w = lockDir()
  try {
    const shim = join(w.root, 'shim')
    mkdirSync(shim)
    const mark = join(w.root, 'rm-started')
    writeFileSync(join(shim, 'rm'), `#!/bin/sh\n: > "${mark}"\nsleep 1.5\n/bin/rm "$@"\ncode=$?\n: > "${mark}.done"\nexit $code\n`, { mode: 0o755 })
    const url = (f: string) => pathToFileURL(join(dirname(LAUNCHER), f)).href
    // The parent takes the lock and starts a normal release; its `rm` child is the shim, which stalls before the unlink.
    const code =
      `const { nodeHost } = await import(${JSON.stringify(url('host.node.ts'))});` +
      `const { acquireLock, releaseLock } = await import(${JSON.stringify(url('ledger.ts'))});` +
      `const { processId } = await import(${JSON.stringify(url('workers.ts'))});` +
      `const host = nodeHost({ log: () => {} }); const me = await processId(host);` +
      `await acquireLock(host, ${JSON.stringify(w.lock)}, { token: 'old', session: 'lock-s', activation: 'launcher', ...me });` +
      `await releaseLock(host, ${JSON.stringify(w.lock)}, 'old')`
    const parent = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, PATH: `${shim}:${process.env.PATH}` }, stdio: 'ignore' })
    const exited = new Promise(r => parent.once('exit', r))
    await until(() => existsSync(mark), 'the release child to start')
    parent.kill('SIGKILL')
    await exited
    const base = nodeHost({ log: () => {} })
    const me = await processId(base)
    const fresh: Holder = { token: 'new', session: 'lock-s', activation: 'launcher', ...me }
    // B proves the holder dead and unlocks; C acquires. While the orphan rm is pending, B must be refused.
    const b = await unlockLauncher(base, w.root, 'lock-s', true)
    let c = (await acquireLock(base, w.lock, fresh)).ok
    await until(() => existsSync(`${mark}.done`), 'the orphan rm to finish', 10_000)
    if (!c) c = (await acquireLock(base, w.lock, fresh)).ok
    assert.equal(b.ok, false, `B unlocked while the release child was pending: ${b.text}`)
    assert.match(b.text, /pending|rm child/, 'the busy text tells how to confirm no mutation child runs')
    assert.equal(c, true, 'C acquires once the old lock is gone')
    assert.equal(holderOf(w.lock).token, 'new', 'the orphan rm deleted C\'s lock')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('Sol r6 N4: unlock removed the lock but the guard rm failed — not ok, says the guard is left, with path and errno', async () => {
  const w = lockDir()
  try {
    const base = nodeHost({ log: () => {} })
    const me = await processId(base)
    symlinkSync(JSON.stringify({ token: 'old', session: 'lock-s', activation: 'launcher', ...me, pidStart: DEAD_START }), w.lock)
    const denied: Host = {
      ...base,
      run: async (argv, cwd, ms) =>
        argv[0] === 'rm' && argv[1] === `${w.lock}.unlock` ? { exitCode: 1, stdout: '', stderr: `rm: ${argv[1]}: Permission denied` } : base.run(argv, cwd, ms),
    }
    const out = await unlockLauncher(denied, w.root, 'lock-s', true)
    assert.equal(out.ok, false, `ok despite a guard left behind: ${out.text}`)
    assert.ok(!linked(w.lock), 'the unlock itself ran')
    assert.ok(linked(`${w.lock}.unlock`), 'the guard is left')
    assert.match(out.text, /unlocked .*collector\.owner/)
    assert.match(out.text, /collector\.owner\.unlock.*left/s)
    assert.match(out.text, /Permission denied/)
    assert.match(out.text, /rm '.*collector\.owner\.unlock'/)
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('S3: a session whose channel is mcp gets the TUI and a status line, no node collector (not started, refused, exited)', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('chan')
      const pane = await hostPane(w.session)
      const dir = sessionDirOf(v3Of(w.root), w.session)
      mkdirSync(dir, { recursive: true })
      symlinkSync(JSON.stringify({ channel: 'mcp', token: 't' }), `${dir}/channel`)
      const l = spawnLauncher(w, pane)
      await until(() => /no collector started/.test(l.out + l.err), 'launcher status')
      assert.match(l.out, /tui %\d+ beside host %\d+; no collector started: this session is collected by its mcp channel/)
      assert.match(l.out, /tmux-agent-tui --handover-channel '.*' node --yes/)
      await sleep(500)
      assert.equal(collectors(w.session).length, 0)
      assert.ok(!existsSync(`${dir}/collector.json`) && !existsSync(`${dir}/act`), 'no record, no registration')
      assert.ok(!linked(`${dir}/collector.owner`), 'the launcher lock is released')
      assert.equal(l.closed, false, 'the launcher keeps watching the host pane')
    } finally {
      await cleanup(w)
    }
  }),
)

test('S3: an unreadable channel record is unknown — busy, nothing started', { timeout: 60_000 }, () =>
  exclusive(async () => {
    let w: Live | undefined
    try {
      w = await live('chanbad')
      const pane = await hostPane(w.session)
      const dir = sessionDirOf(v3Of(w.root), w.session)
      mkdirSync(dir, { recursive: true })
      writeFileSync(`${dir}/channel`, 'not a symlink')
      const l = spawnLauncher(w, pane)
      await until(() => l.closed, 'launcher exit')
      assert.match(l.err, /busy: .*the channel of this session is unknown, so no collector is started/)
      assert.equal(collectors(w.session).length, 0)
    } finally {
      await cleanup(w)
    }
  }),
)
