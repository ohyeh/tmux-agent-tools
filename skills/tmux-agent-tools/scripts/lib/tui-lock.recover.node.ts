// Process boundary for T2 lock recovery. Not a *.contract.node.ts: the two
// 6s waits would sit in the 90s core lane. scripts/test-tui-lock-recover-smoke runs it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeHost } from './host.node.ts'
import { claimTui, processId, sessionDirOf, TUI_LOCK_RECOVER_MS, v3Of } from './workers.ts'

const SELF = new URL(import.meta.url).pathname

async function runChild(): Promise<void> {
  const mode = process.env.TUI_LOCK_RECOVER_CHILD
  const root = process.argv[2]
  const session = process.argv[3]
  if (!mode || !root || !session) throw new Error('usage: TUI_LOCK_RECOVER_CHILD=a|b|live node tui-lock.recover.node.ts <root> <session>')
  const base = nodeHost({ log: () => {} })
  const host = {
    ...base,
    write: async (path: string, text: string) => {
      if (mode === 'a' && path.includes('/tui.owner.') && !path.includes('/tui.owner.lock.')) {
        process.kill(process.pid, 'SIGKILL')
        await new Promise(() => {})
      }
      await base.write(path, text)
    },
    run: async (argv: readonly string[], cwd: string, ms: number) => {
      if (mode === 'b' && argv[0] === 'rm' && argv.some(a => a.endsWith('/tui.owner.lock/holder'))) {
        process.kill(process.pid, 'SIGKILL')
        await new Promise(() => {})
      }
      if (mode === 'live' && argv[0] === 'rmdir' && String(argv[1]).endsWith('/tui.owner.lock')) {
        writeFileSync(join(root, 'holding'), '1')
        for (let i = 0; i < 80 && !existsSync(join(root, 'release')); i++) await new Promise(r => setTimeout(r, 50))
      }
      return base.run(argv, cwd, ms)
    },
  }
  const me = await processId(host)
  await claimTui(host, root, session, me, { state: 'pending' })
}

if (process.env.TUI_LOCK_RECOVER_CHILD) {
  await runChild()
  process.exit(0)
}

function spawnChild(root: string, session: string, mode: 'a' | 'b' | 'live'): ChildProcess {
  return spawn(process.execPath, [SELF, root, session], {
    env: { ...process.env, TUI_LOCK_RECOVER_CHILD: mode },
    stdio: 'ignore',
  })
}

function lockOf(root: string, session: string): string {
  return `${sessionDirOf(v3Of(root), session)}/tui.owner.lock`
}

async function untilDead(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('child stayed alive')), 5_000)
    child.once('exit', () => { clearTimeout(t); resolve() })
  })
}

async function untilAged(lock: string): Promise<void> {
  const start = Date.now()
  for (;;) {
    const age = Date.now() - statSync(lock).mtimeMs
    if (age > TUI_LOCK_RECOVER_MS) return
    if (Date.now() - start > TUI_LOCK_RECOVER_MS + 5_000) throw new Error(`lock age ${age} did not pass ${TUI_LOCK_RECOVER_MS}`)
    await new Promise(r => setTimeout(r, 200))
  }
}

async function killed(mode: 'a' | 'b', ownerWritten: boolean): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'tui-recover-'))
  const session = 'sess-1'
  const child = spawnChild(root, session, mode)
  try {
    await untilDead(child)
    const lock = lockOf(root, session)
    assert.equal(existsSync(lock), true, `${mode}: the lock is left behind`)
    const owner = `${sessionDirOf(v3Of(root), session)}/tui.owner`
    assert.equal(existsSync(owner), ownerWritten, `${mode}: tui.owner`)
    await untilAged(lock)
    const host = nodeHost({ log: () => {} })
    const me = await processId(host)
    const got = await claimTui(host, root, session, me, { state: 'pending' })
    assert.equal(got.kind, 'won', `${mode}: the next claim recovers a dead holder`)
    assert.equal(existsSync(lock), false, `${mode}: the recovered lock is released`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
}

test('T2 recover: kill after the lock, before tui.owner, and the next claim wins', async () => {
  await killed('a', false)
})

test('T2 recover: kill after tui.owner, before the lock is released, and the next claim wins', async () => {
  await killed('b', true)
})

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

test('T2 recover: a second recoverer does not delete a live holder or overwrite its ready claim (FR-02)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-recover-race-'))
  const session = 'race'
  const base = nodeHost({ log: () => {} })
  const me = await processId(base)
  const dir = sessionDirOf(v3Of(root), session)
  const lock = `${dir}/tui.owner.lock`
  const holderPath = `${lock}/holder`
  const ownerPath = `${dir}/tui.owner`
  mkdirSync(lock, { recursive: true })
  writeFileSync(holderPath, JSON.stringify({ host: me.host, pid: 2147483646, pidStart: 'dead', at: 1 }))
  const old = new Date(Date.now() - 60_000)
  utimesSync(lock, old, old)
  const bReached = gate()
  const aInBody = gate()
  const bFinished = gate()
  let bFirst = true
  let aFirst = true
  let sawLive = false
  let liveRemoved = false
  const touchesHolder = (argv: readonly string[]) =>
    (argv[0] === 'rm' && argv.includes(holderPath)) || (argv[0] === 'perl' && argv.includes(holderPath))
  const bHost = {
    ...base,
    run: async (argv: readonly string[], cwd: string, ms: number) => {
      if (bFirst && touchesHolder(argv)) {
        bFirst = false
        bReached.resolve()
        await aInBody.promise
        if (existsSync(holderPath)) {
          const holder = JSON.parse(readFileSync(holderPath, 'utf8')) as { pid?: number; pidStart?: string }
          sawLive = holder.pid === me.pid && holder.pidStart === me.pidStart
        }
        const result = await base.run(argv, cwd, ms)
        liveRemoved = sawLive && !existsSync(holderPath)
        return result
      }
      if (argv[0] === 'sleep') return { exitCode: 0, stdout: '', stderr: '' }
      return base.run(argv, cwd, ms)
    },
  }
  const aHost = {
    ...base,
    exists: async (path: string) => {
      const got = await base.exists(path)
      if (aFirst && path === ownerPath) {
        aFirst = false
        aInBody.resolve()
        await bFinished.promise
      }
      return got
    },
  }
  try {
    const bRun = claimTui(bHost, root, session, me, { state: 'ready', locator: { kind: 'warp', tabTitle: 'B' } })
    await bReached.promise
    const aRun = claimTui(aHost, root, session, me, { state: 'ready', locator: { kind: 'warp', tabTitle: 'A' } })
    const bResult = await bRun
    bFinished.resolve()
    const aResult = await aRun
    assert.equal(sawLive, true, 'A was holding the lock when B reached the delete')
    assert.equal(liveRemoved, false, 'B deleted the live holder')
    const wins = [aResult, bResult].filter(r => r.kind === 'won')
    assert.equal(wins.length, 1, `${aResult.kind} + ${bResult.kind}`)
    const won = wins[0]
    if (won?.kind !== 'won') throw new Error('no winner')
    const persisted = JSON.parse(readFileSync(ownerPath, 'utf8')) as { token: string; pid: number; pidStart: string }
    assert.equal(persisted.token, won.claim.token)
    assert.equal(persisted.pid, won.claim.pid)
    assert.equal(persisted.pidStart, won.claim.pidStart)
  } finally {
    bFinished.resolve()
    aInBody.resolve()
    rmSync(root, { recursive: true, force: true })
  }
})

test('T2 recover: a live holder is not removed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-recover-live-'))
  const session = 'sess-1'
  const child = spawnChild(root, session, 'live')
  try {
    const holding = join(root, 'holding')
    for (let i = 0; i < 50 && !existsSync(holding); i++) await new Promise(r => setTimeout(r, 50))
    assert.equal(existsSync(holding), true, 'the child is inside the lock')
    const host = nodeHost({ log: () => {} })
    const me = await processId(host)
    const got = await claimTui(host, root, session, me, { state: 'pending' })
    assert.equal(got.kind, 'occupied-unknown')
    assert.equal(existsSync(lockOf(root, session)), true, 'a live holder keeps the lock')
    writeFileSync(join(root, 'release'), '1')
    await untilDead(child)
  } finally {
    writeFileSync(join(root, 'release'), '1')
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})
