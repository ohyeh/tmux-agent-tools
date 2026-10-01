// P7 launcher, on a private tmux socket `tac-test-<pid>` (never the user's server).
// (a) fails if the collector is started with the TUI pane id: paste-buffer -t that
// id would put the marker on the TUI capture, the host capture would miss it, and
// the collector command line would not contain `--pane <host>`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const started = await tmux(['new-session', '-d', '-s', session, '-x', '200', '-y', '40', 'cat'])
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
  if (process.env.RELEASE === '1') say({ released: await releaseLock(host, process.env.DIR + '/collector.owner', token) })
} catch (error) {
  say({ busy: error.message })
}
`

type Said = { won?: string; released?: boolean; busy?: string; at: number }

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
    assert.equal(next.said[1]?.released, true)
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('C-lock: a holder alive for more than 10s is never stolen; a delayed release lets the waiter in after it', { timeout: 60_000 }, async () => {
  const w = lockDir()
  try {
    const holder = contender(w.dir, { HOLD: '11000', RELEASE: '1' })
    await until(() => linked(w.lock), 'the holder to take the lock')
    const token = holderOf(w.lock).token
    const waiter = contender(w.dir, { RELEASE: '1' })
    await sleep(10_500)
    assert.equal(holderOf(w.lock).token, token, 'still the first holder after 10.5s')
    const unlock = await maintenance(w.root, ['--unlock-launcher', 'lock-s', '--yes'])
    assert.equal(unlock.code, 1)
    assert.match(unlock.out, /still running/)
    const [h, x] = await Promise.all([holder, waiter])
    const released = h.said.find(s => s.released)!
    const won = x.said.find(s => s.won)
    assert.ok(won, JSON.stringify(x.said))
    assert.ok(won.at >= released.at, 'the waiter won only after the release')
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
    assert.equal(await releaseLock(host, w.lock, 'old'), false, 'the old holder\'s finally')
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
      const lib = join(w.root, 'install dir', 'scripts', 'lib')
      cpSync(fileURLToPath(new URL('.', import.meta.url)), lib, { recursive: true, filter: src => !src.includes('/fixtures') })
      const launcher = join(lib, 'launcher.node.ts')
      const pane = await hostPane(w.session)
      const first = await ready(spawnLauncher(w, pane, { launcher }))
      assert.equal(first.how, 'started')
      assert.ok(collectors(w.session).some(l => l.includes('install dir/scripts/lib/collector.node.ts')))
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
