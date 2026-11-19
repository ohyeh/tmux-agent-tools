// P7 launcher, on a private tmux socket `tac-test-<pid>` (never the user's server).
// (a) fails if the collector is started with the TUI pane id: paste-buffer -t that
// id would put the marker on the TUI capture, the host capture would miss it, and
// the collector command line would not contain `--pane <host>`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { nodeHost } from './host.node.ts'
import { acquireLock, releaseLock, type Holder } from './ledger.ts'
import { takeLauncherLock, unlockLauncher } from './launcher.node.ts'
import { processId, sessionDirOf, v3Of, type Host } from './workers.ts'

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

test('a second launch reuses the one collector bound to the host pane, and killing the TUI pane leaves it alive', { timeout: 20_000 }, () =>
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
      assert.match(collectors(w.session)[0]!, new RegExp(`--pane ${pane}( |$)`), 'the collector is bound to the host pane, never the TUI pane')
      // (c) killing the TUI pane leaves the collector alive
      assert.equal((await tmux(['kill-pane', '-t', second.tui])).code, 0)
      await sleep(1_000)
      assert.doesNotThrow(() => process.kill(second.pid, 0))
      assert.equal(collectors(w.session).length, 1)
    } finally {
      await cleanup(w)
    }
  }),
)

// ── C-lock (plan §1b): `collector.owner` is the core action lock, never taken over ──

const LIB = (f: string) => pathToFileURL(fileURLToPath(new URL(f, import.meta.url))).href

/**
 * One contender as its own OS process: take the launcher lock, hold it `HOLD` ms (or until
 * the file `HOLD_UNTIL` exists), release it only when `RELEASE=1` (otherwise exit holding
 * it: a crashed launcher).
 * `CRASH=after-ln`: exit 9 right after the `ln -sn` that took the lock.
 */
const CONTENDER = `
const { takeLauncherLock } = await import(process.env.L)
const { nodeHost } = await import(process.env.H)
const { releaseLock } = await import(process.env.LE)
const { existsSync } = await import('node:fs')
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
  while (process.env.HOLD_UNTIL && !existsSync(process.env.HOLD_UNTIL)) await new Promise(r => setTimeout(r, 50))
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

test('C-lock: a live holder is never stolen; its release lets the waiter in after it', { timeout: 60_000 }, async () => {
  const w = lockDir()
  try {
    // The holder holds until the test publishes `go`: no timer decides when it lets go.
    const go = join(w.root, 'go')
    const holder = contender(w.dir, { HOLD_UNTIL: go, RELEASE: '1' })
    await until(() => linked(w.lock), 'the holder to take the lock')
    const token = holderOf(w.lock).token
    const waiter = contender(w.dir, { RELEASE: '1' })
    const unlock = await maintenance(w.root, ['--unlock-launcher', 'lock-s', '--yes'])
    assert.equal(unlock.code, 1)
    assert.match(unlock.out, /still running/)
    assert.equal(holderOf(w.lock).token, token, 'still the first holder while it runs')
    writeFileSync(go, '')
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

// ── §1c S2 legacy migration and R6.2 collector identity, on private tmux servers ──

/** A process whose full args name `script` and the session, as an old launcher's or collector's would. */
function fake(w: { session: string; children: ChildProcess[] }, script: string, extra: string[] = []): ChildProcess {
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

// --migrate-launcher reads only the session dir and ps: its refusals are fixtures, no tmux.
test('S2 migrate: refuses while a legacy launcher or collector runs, moves (never deletes) after it stops, nothing to migrate when clean', { timeout: 60_000 }, async () => {
  const w = { ...lockDir(), session: 'lock-s', children: [] as ChildProcess[] }
  try {
    // A legacy lock dir, its launcher still running (no pid file yet).
    mkdirSync(`${w.dir}/collector.lock`)
    let old = fake(w, 'launcher.node.ts')
    let refused = await maintenance(w.root, ['--migrate-launcher', w.session, '--yes'])
    assert.equal(refused.code, 1, refused.out)
    assert.match(refused.out, new RegExp(`busy: .*pid ${old.pid}`))
    assert.ok(existsSync(`${w.dir}/collector.lock`), 'nothing moved while the old launcher runs')
    assert.ok(alive(old.pid!), 'migrate kills nothing')
    old.kill('SIGTERM')
    await until(() => !alive(old.pid!), 'the old launcher to exit')
    const dry = await maintenance(w.root, ['--migrate-launcher', w.session])
    assert.equal(dry.code, 1)
    assert.match(dry.out, /would move collector\.lock/)
    let moved = await maintenance(w.root, ['--migrate-launcher', w.session, '--yes'])
    assert.equal(moved.code, 0, moved.out)
    const legacy = readdirSync(w.dir).filter(n => n.startsWith('legacy-'))
    assert.equal(legacy.length, 1)
    assert.ok(existsSync(`${w.dir}/${legacy[0]}/collector.lock`), 'moved, not deleted')
    assert.ok(!existsSync(`${w.dir}/collector.lock`))

    // A legacy pid file whose collector is dead, its launcher alive.
    const gone = spawn(process.execPath, ['-e', ''])
    await new Promise(r => gone.on('exit', r))
    writeFileSync(`${w.dir}/collector.pid`, `${gone.pid} %1\n`)
    old = fake(w, 'launcher.node.ts')
    refused = await maintenance(w.root, ['--migrate-launcher', w.session, '--yes'])
    assert.equal(refused.code, 1, refused.out)
    assert.ok(alive(old.pid!))
    assert.ok(existsSync(`${w.dir}/collector.pid`))
    old.kill('SIGTERM')
    await until(() => !alive(old.pid!), 'the old launcher to exit')
    moved = await maintenance(w.root, ['--migrate-launcher', w.session, '--yes'])
    assert.equal(moved.code, 0, moved.out)
    assert.ok(!existsSync(`${w.dir}/collector.pid`))

    // A live legacy collector named by the pid file, on another socket: refused, not killed.
    old = fake(w, 'collector.node.ts', ['--pane', '%1', '--socket', '/elsewhere/other.sock'])
    writeFileSync(`${w.dir}/collector.pid`, `${old.pid} %1\n`)
    refused = await maintenance(w.root, ['--migrate-launcher', w.session, '--yes'])
    assert.equal(refused.code, 1, refused.out)
    assert.match(refused.out, /SIGTERM/)
    assert.ok(alive(old.pid!), 'not killed')
    old.kill('SIGTERM')
    await until(() => !alive(old.pid!), 'the old collector to exit')
    rmSync(`${w.dir}/collector.pid`)

    const nothing = await maintenance(w.root, ['--migrate-launcher', w.session, '--yes'])
    assert.equal(nothing.code, 0, nothing.out)
    assert.match(nothing.out, /nothing to migrate/)
  } finally {
    for (const child of w.children) child.kill('SIGTERM')
    rmSync(w.root, { recursive: true, force: true })
  }
})

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
