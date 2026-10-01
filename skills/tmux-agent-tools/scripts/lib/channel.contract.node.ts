// S3 channel authority (plan §1c S3, R7.3 closure): the `channel.lock` holder record, the
// "unknown / initializing is never free" rule, and `--handover-channel`. Plain node over a
// REAL filesystem, like workers.contract.node.ts; only `ps` is stubbed where a test needs a
// process list the machine cannot be trusted to have (an MCP server).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeHost } from './host.node.ts'
import { handoverChannel, type Proc } from './launcher.node.ts'
import { readActHealth, heartbeat, newGate, processId, sessionDirOf, v3Of, type Host } from './workers.ts'

const LAUNCHER = fileURLToPath(new URL('./launcher.node.ts', import.meta.url))
const SESSION = `chan-${process.pid}-s`
const DEAD_START = 'Thu Jan  1 00:00:00 1970'

/** A node host over a fresh state root, session `me`; `trace` sees every ledger `ln`/`rm`/`mv` in order. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'chan-'))
  process.env.TMUX_AGENT_DIR = root
  const logs: string[] = []
  const trace: string[] = []
  const base = nodeHost({ owner: SESSION, cwd: root, log: t => logs.push(t) })
  let hook: ((argv: readonly string[]) => Promise<void>) | undefined
  const host: Host = {
    ...base,
    run: async (argv, cwd, ms) => {
      if (argv[0] === 'ln' || argv[0] === 'rm') trace.push(`${argv[0]} ${String(argv.at(-1)).split('/').pop()}`)
      await hook?.(argv)
      return base.run(argv, cwd, ms)
    },
  }
  const v3 = v3Of(root)
  const sd = sessionDirOf(v3, SESSION)
  return { host, root, v3, sd, logs, trace, onRun: (h: typeof hook) => (hook = h) }
}
type W = ReturnType<typeof world>

const gateOf = (channel: 'mod' | 'node' | 'mcp') => {
  const g = newGate()
  g.channel = channel
  return g
}
const actsOf = (w: W) => (existsSync(`${w.sd}/act`) ? readdirSync(`${w.sd}/act`).filter(f => /^\d+$/.test(f)).sort() : [])
const channelOf = (w: W) => JSON.parse(readlinkSync(`${w.sd}/channel`)).channel as string
/** A symlink whose target is JSON text dangles: `existsSync` says false, `lstat` the truth. */
const linked = (p: string) => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}
const noProcs = async (): Promise<Proc[]> => []
const proc = (line: string, pid = 424242, ppid = 1): Proc => ({ pid, ppid, line })

test('S3 holder: channel.lock records this process (pid, start, host); a crashed holder is reported with liveness, never taken over', async () => {
  const w = world()
  let held: Record<string, unknown> | undefined
  w.onRun(async argv => {
    if (argv[0] === 'ln' && String(argv.at(-1)).endsWith('/channel.lock')) held = JSON.parse(argv[2]!)
  })
  try {
    assert.equal(await heartbeat(w.host, gateOf('mod')), true)
    assert.ok(held, 'registration took channel.lock')
    assert.equal(held.pid, process.pid, 'the pid of the process that registered')
    assert.ok(typeof held.pidStart === 'string' && held.pidStart, 'and its start time')
    assert.ok(typeof held.host === 'string' && held.host, 'and its host')
    assert.ok(!linked(`${w.sd}/channel.lock`), 'released by its holder')
    rmSync(`${w.sd}/channel`)
    const me = await processId(w.host)
    const lockHeldBy = (h: object) => {
      rmSync(`${w.sd}/channel.lock`, { force: true })
      symlinkSync(JSON.stringify({ token: 'other', session: 'gone', activation: '', ...h }), `${w.sd}/channel.lock`)
    }
    const g = gateOf('mod')
    // Dead (pid reused: another start time): busy, with the rm that clears it. Never stolen.
    lockHeldBy({ ...me, pidStart: DEAD_START })
    assert.equal(await heartbeat(w.host, g), false)
    assert.match(g.waiting ?? '', /held by pid \d+ on \S+ \(session gone\): gone\. It is never taken over/)
    assert.match(g.waiting ?? '', /rm '.*channel\.lock'/)
    assert.equal(g.paused, undefined)
    assert.ok(linked(`${w.sd}/channel.lock`), 'not taken over')
    // Running: busy, and no rm advice.
    lockHeldBy(me)
    assert.equal(await heartbeat(w.host, g), false)
    assert.match(g.waiting ?? '', /: still running\. It is never taken over/)
    assert.doesNotMatch(g.waiting ?? '', /rm '/)
    // Unprovable (another host): unknown liveness is busy, not dead.
    lockHeldBy({ ...me, host: 'some-other-host' })
    assert.equal(await heartbeat(w.host, g), false)
    assert.match(g.waiting ?? '', /not provably alive or dead/)
    assert.deepEqual(actsOf(w), ['1'], 'nothing registered meanwhile (act/1 is the first registration)')
    rmSync(`${w.sd}/channel.lock`)
    assert.equal(await heartbeat(w.host, g), true)
    assert.equal(g.waiting, undefined)
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('S3 unknown: an unreadable channel record registers nothing, says why (waiting, not paused), and creates no channel', async () => {
  const w = world()
  try {
    mkdirSync(w.sd, { recursive: true })
    writeFileSync(`${w.sd}/channel`, 'not a symlink')
    const g = gateOf('node')
    assert.equal(await heartbeat(w.host, g), false)
    assert.match(g.waiting ?? '', /the channel state is unknown \(.*channel/)
    assert.match(g.waiting ?? '', /this node channel does not register this tick/)
    assert.equal(g.paused, undefined, 'unknown is retried, never a refusal')
    assert.deepEqual(actsOf(w), [])
    rmSync(`${w.sd}/channel`)
    symlinkSync(JSON.stringify({ token: 'x' }), `${w.sd}/channel`)
    assert.equal(await heartbeat(w.host, g), false)
    assert.match(g.waiting ?? '', /names no channel/)
    assert.deepEqual(actsOf(w), [])
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

/** Channel `mcp` is registered (act/1) but publishes no state and no beat. */
async function mcpRegisteredNoState(w: W) {
  const { registerOnChannel } = await import('./ledger.ts')
  const me = { token: 'mcp-tok', session: SESSION, activation: '', ...(await processId(w.host)) }
  const r = await registerOnChannel(w.host, w.sd, 'mcp', me, { pid: 0, pidStart: '', host: '', token: 'mcp-tok' })
  assert.deepEqual(r, { n: 1 })
}

test('S3 fixture: MCP registered, state not yet published — no other channel registers, and the handover does not read it as dead', async () => {
  const w = world()
  try {
    await mcpRegisteredNoState(w)
    assert.ok(!existsSync(`${w.sd}/act/1.state`) && !existsSync(`${w.sd}/act/1.beat`))
    assert.equal((await readActHealth(w.host, w.v3, SESSION, Date.now())).kind, 'initializing')
    for (const ch of ['mod', 'node'] as const) {
      const g = gateOf(ch)
      assert.equal(await heartbeat(w.host, g), false)
      assert.match(g.paused ?? '', /collected by its mcp channel/)
      assert.equal(g.activation, undefined)
    }
    assert.deepEqual(actsOf(w), ['1'], 'no one fenced it')
    const busy = await handoverChannel(w.host, w.root, SESSION, 'node', true, async () => [proc('node /opt/tmux-agent/lib/mcp-server.mjs')])
    assert.equal(busy.ok, false)
    assert.match(busy.text, new RegExp(`busy: a mcp channel caller for session ${SESSION} still runs: pid 424242`))
    assert.equal(channelOf(w), 'mcp')
    assert.ok(!linked(`${w.sd}/channel.lock`) && !linked(`${w.sd}/collector.owner`), 'both locks released')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('S3 fixture: heartbeat stale but the process still alive — not dead: no registration, and the handover is busy', async () => {
  const w = world()
  try {
    // A node collector registered, wrote state and a beat, then the beat went stale (an hour old).
    const first = gateOf('node')
    assert.equal(await heartbeat(w.host, first), true)
    const old = Date.now() / 1000 - 3600
    utimesSync(`${w.sd}/act/1.beat`, old, old)
    assert.equal((await readActHealth(w.host, w.v3, SESSION, Date.now())).kind, 'stale')
    const mod = gateOf('mod')
    assert.equal(await heartbeat(w.host, mod), false)
    assert.match(mod.paused ?? '', /collected by its node channel/)
    assert.deepEqual(actsOf(w), ['1'])
    // The real ps: a process whose args name the launcher and this session is a caller.
    const alive: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'launcher.node.ts', '--session', SESSION], { stdio: 'ignore' })
    try {
      await new Promise(r => setTimeout(r, 300))
      const busy = await handoverChannel(w.host, w.root, SESSION, 'mod', true)
      assert.equal(busy.ok, false, busy.text)
      assert.match(busy.text, new RegExp(`busy: a node channel caller for session ${SESSION} still runs: pid ${alive.pid}\\b`))
      assert.match(busy.text, /A stale heartbeat is not quiescence/)
      assert.equal(channelOf(w), 'node', 'nothing switched')
    } finally {
      alive.kill('SIGKILL')
    }
    await new Promise(r => setTimeout(r, 300))
    const done = await handoverChannel(w.host, w.root, SESSION, 'mod', true)
    assert.equal(done.ok, true, done.text)
    assert.equal(channelOf(w), 'mod')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('handover: a dry run changes nothing; --yes switches under channel.lock then collector.owner (released in reverse); the new channel registers, the old one is refused', async () => {
  const w = world()
  try {
    await mcpRegisteredNoState(w)
    w.trace.length = 0
    const dry = await handoverChannel(w.host, w.root, SESSION, 'node', false, noProcs)
    assert.equal(dry.ok, false)
    assert.match(dry.text, new RegExp(`would switch session ${SESSION} from its mcp channel to node`))
    assert.match(dry.text, new RegExp(`tmux-agent-tui --handover-channel '${SESSION}' node --yes`))
    assert.equal(channelOf(w), 'mcp')
    w.trace.length = 0
    const out = await handoverChannel(w.host, w.root, SESSION, 'node', true, noProcs)
    assert.equal(out.ok, true, out.text)
    assert.equal(channelOf(w), 'node')
    const seq = w.trace.filter(t => /^(ln|rm) (channel\.lock|collector\.owner)$/.test(t))
    assert.deepEqual(seq, ['ln channel.lock', 'ln collector.owner', 'rm collector.owner', 'rm channel.lock'], 'lock order channel.lock → action lock, never reversed')
    assert.ok(!linked(`${w.sd}/channel.lock`) && !linked(`${w.sd}/collector.owner`))
    const mcp = gateOf('mcp')
    assert.equal(await heartbeat(w.host, mcp), false)
    assert.match(mcp.paused ?? '', /collected by its node channel/)
    const node = gateOf('node')
    assert.equal(await heartbeat(w.host, node), true)
    assert.deepEqual(actsOf(w), ['1', '2'])
    assert.equal((await handoverChannel(w.host, w.root, SESSION, 'node', true, noProcs)).text, `session ${SESSION} is already collected by its node channel`)
    assert.match((await handoverChannel(w.host, w.root, SESSION, 'bogus', true, noProcs)).text, /one of mod, node, mcp/)
    assert.match((await handoverChannel(w.host, w.root, 'nobody-here', 'node', true, noProcs)).text, /does not exist/)
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('handover: a mod channel cannot be seen by ps — the dry run says so; a held channel.lock is busy and never taken over', async () => {
  const w = world()
  try {
    assert.equal(await heartbeat(w.host, gateOf('mod')), true)
    const dry = await handoverChannel(w.host, w.root, SESSION, 'node', false, noProcs)
    assert.match(dry.text, /Claude Code process that ps cannot tie to a session/)
    const me = await processId(w.host)
    for (const [h, want] of [
      [{ ...me, pidStart: DEAD_START }, /gone.*rm '/s],
      [me, /still running/],
      [{ ...me, host: 'elsewhere' }, /not provably alive or dead/],
    ] as const) {
      rmSync(`${w.sd}/channel.lock`, { force: true })
      symlinkSync(JSON.stringify({ token: 'other', session: 'x', activation: 'handover', ...h }), `${w.sd}/channel.lock`)
      const r = await handoverChannel(w.host, w.root, SESSION, 'node', true, noProcs)
      assert.equal(r.ok, false)
      assert.match(r.text, /busy: .*channel\.lock is held by pid/)
      assert.match(r.text, want)
      assert.ok(linked(`${w.sd}/channel.lock`), 'not taken over')
      assert.equal(channelOf(w), 'mod')
    }
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('S3 cut point: A read channel=mcp outside the lock, B hands over to node, A registers late — A re-reads inside the lock, is refused, and fences nothing', async () => {
  const w = world()
  try {
    await mcpRegisteredNoState(w)
    let release!: () => void
    const parked = new Promise<void>(r => (release = r))
    let atCut!: () => void
    const reached = new Promise<void>(r => (atCut = r))
    let first = true
    const a: Host = {
      ...w.host,
      run: async (argv, cwd, ms) => {
        // A is past its (outside) channel read and is about to take channel.lock.
        if (first && argv[0] === 'ln' && String(argv.at(-1)).endsWith('/channel.lock')) {
          first = false
          atCut()
          await parked
        }
        return w.host.run(argv, cwd, ms)
      },
    }
    const late = gateOf('mcp')
    const aBeat = heartbeat(a, late)
    await reached
    const b = await handoverChannel(w.host, w.root, SESSION, 'node', true, noProcs)
    assert.equal(b.ok, true, b.text)
    const node = gateOf('node')
    assert.equal(await heartbeat(w.host, node), true)
    assert.deepEqual(actsOf(w), ['1', '2'], 'node holds the max activation')
    release()
    assert.equal(await aBeat, false)
    assert.equal(late.activation, undefined)
    assert.match(late.paused ?? '', /collected by its node channel/)
    assert.deepEqual(actsOf(w), ['1', '2'], 'A registered nothing, so it fenced nothing')
    assert.equal(await heartbeat(w.host, node), true, 'the new authority still collects')
    assert.equal(channelOf(w), 'node')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('Sol-r3 R3-3: a failed channel publish leaves the old channel in place — no instant without an authority, no third registrant', async () => {
  for (const step of ['ln', 'mv'] as const) {
    const w = world()
    try {
      await mcpRegisteredNoState(w)
      const bad: Host = {
        ...w.host,
        run: async (argv, cwd, ms) =>
          argv[0] === step && String(argv.at(-1)).startsWith(`${w.sd}/channel`) && !String(argv.at(-1)).startsWith(`${w.sd}/channel.lock`)
            ? { exitCode: 1, stdout: '', stderr: `EIO injected channel ${step}` }
            : w.host.run(argv, cwd, ms),
      }
      const out = await handoverChannel(bad, w.root, SESSION, 'node', true, noProcs)
      assert.equal(out.ok, false, step)
      assert.ok(linked(`${w.sd}/channel`), `${step}: a channel record still exists`)
      assert.equal(channelOf(w), 'mcp', `${step}: the old channel keeps its authority`)
      assert.ok(!linked(`${w.sd}/channel.lock`), `${step}: nothing is left held`)
      assert.deepEqual(readdirSync(w.sd).filter(f => f.startsWith('channel.') && f !== 'channel.lock'), [], `${step}: no temp record is left`)
      const mod = gateOf('mod')
      assert.equal(await heartbeat(w.host, mod), false, `${step}: an unrelated channel is refused, not first-writer`)
      assert.match(mod.paused ?? '', /collected by its mcp channel/)
      assert.equal(channelOf(w), 'mcp')
      assert.match(out.text, /the mcp channel is unchanged/, `${step}: the message matches the state kept`)
    } finally {
      rmSync(w.root, { recursive: true, force: true })
    }
  }
})

test('Sol-r3 R3-6: a handover whose lock release leaves a guard says so and exits not-ok, though the switch happened', async () => {
  const w = world()
  try {
    await mcpRegisteredNoState(w)
    const bad: Host = {
      ...w.host,
      run: async (argv, cwd, ms) =>
        argv[0] === 'rm' && argv[1] === `${w.sd}/channel.lock.unlock` ? { exitCode: 1, stdout: '', stderr: 'EACCES injected guard' } : w.host.run(argv, cwd, ms),
    }
    const out = await handoverChannel(bad, w.root, SESSION, 'node', true, noProcs)
    assert.equal(out.ok, false)
    assert.match(out.text, /mcp → node/, 'the switch is reported')
    assert.match(out.text, /release of .*channel\.lock is incomplete: its guard .*channel\.lock\.unlock remains/)
    assert.equal(channelOf(w), 'node')
    assert.ok(linked(`${w.sd}/channel.lock.unlock`))
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('handover CLI: the maintenance command runs from the entry, dry run exits 1, --yes exits 0 and switches', async () => {
  const w = world()
  try {
    assert.equal(await heartbeat(w.host, gateOf('mod')), true)
    const run = (args: string[]) =>
      new Promise<{ code: number; out: string }>(resolve =>
        execFile(process.execPath, [LAUNCHER, ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, TMUX_AGENT_DIR: w.root } }, (e, so, se) =>
          resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out: `${so}${se}` }),
        ),
      )
    const dry = await run(['--handover-channel', SESSION, 'node'])
    assert.equal(dry.code, 1, dry.out)
    assert.match(dry.out, new RegExp(`would switch session ${SESSION} from its mod channel to node`))
    assert.equal(channelOf(w), 'mod')
    assert.equal((await run(['--handover-channel', SESSION])).code, 2, 'a target channel is required')
    const done = await run(['--handover-channel', SESSION, 'node', '--yes'])
    assert.equal(done.code, 0, done.out)
    assert.match(done.out, new RegExp(`session ${SESSION}: mod → node`))
    assert.equal(channelOf(w), 'node')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})
