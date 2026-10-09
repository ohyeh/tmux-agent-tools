// Contract of the tailnet relay (relay.node.ts): auth at the socket peer, the exit
// push bound to device + launch, message delivery through agent-tmux argv, roster.
// Real HTTP on 127.0.0.1 with injected whois / agent-tmux; no tailscale, no tmux.
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { checkBind, cleanText, createRelay, normalizePeer, parseWhois, systemAgentTmux, validName, writeOnce, type Identity, type RunResult } from './relay.node.ts'

const SELF: Identity = { node: 'nSELF', name: 'mbp', login: 'me@example.com', tagged: false }
const MINI: Identity = { node: 'nMINI', name: 'mini', login: 'me@example.com', tagged: false }

type World = {
  dir: string
  url: string
  close: () => Promise<void>
  peer: { id?: Identity; error?: string }
  calls: string[][]
  running: Record<string, boolean>
  sendResult: RunResult
}

async function world(): Promise<World> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'relay-contract-'))
  const w = { dir, peer: { id: MINI }, calls: [] as string[][], running: {} as Record<string, boolean>, sendResult: { code: 0, stdout: '', stderr: '' } } as World
  const { server } = createRelay({
    stateDir: dir,
    self: SELF,
    whoisTtlMs: 0,
    whois: async () => {
      if (w.peer.error) throw new Error(w.peer.error)
      return w.peer.id!
    },
    agentTmux: async (args) => {
      w.calls.push(args)
      if (args[1] === 'status') {
        const name = args[3] ?? ''
        const live = w.running[name]
        return { code: 0, stdout: JSON.stringify({ exists: live !== undefined, running: !!live }), stderr: '' }
      }
      return w.sendResult
    },
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  w.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  w.close = () => new Promise((r) => server.close(() => r()))
  return w
}

async function meta(w: World, name: string, m: Record<string, unknown>) {
  await mkdir(join(w.dir, name), { recursive: true })
  await writeFile(join(w.dir, name, 'launch-meta.json'), JSON.stringify(m))
}
const post = (w: World, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${w.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const exists = (p: string) => readFile(p, 'utf8').then(() => true, () => false)

describe('relay helpers', () => {
  it('normalizes IPv4-mapped peers and drops zone ids', () => {
    assert.equal(normalizePeer('::ffff:100.64.0.20'), '100.64.0.20')
    assert.equal(normalizePeer('fe80::1%en0'), 'fe80::1')
    assert.equal(normalizePeer('fd7a:115c:a1e0::1'), 'fd7a:115c:a1e0::1')
  })
  it('binds only one of this node\'s tailnet addresses; loopback only with a test whois', () => {
    const own = ['100.64.0.10', 'fd7a:115c:a1e0::1']
    assert.match(checkBind('0.0.0.0', own, false) ?? '', /wildcard/)
    assert.match(checkBind('::', own, true) ?? '', /wildcard/)
    assert.match(checkBind('host.ts.net', own, false) ?? '', /must be an IP/)
    assert.match(checkBind('192.168.1.27', own, false) ?? '', /not a tailnet address/)
    assert.match(checkBind('127.0.0.1', own, false) ?? '', /not a tailnet address/)
    assert.equal(checkBind('127.0.0.1', [], true), undefined)
    assert.equal(checkBind('100.64.0.10', own, false), undefined)
    assert.equal(checkBind('fd7a:115c:a1e0::1', own, false), undefined)
  })
  it('accepts only the worker names agent-tmux makes, never . or ..', () => {
    for (const n of ['a', 'job-1', 'x.y_z', 'a'.repeat(64)]) assert.equal(validName(n), true, n)
    for (const n of ['.', '..', '', 'a/b', 'a b', 'a'.repeat(65), 1]) assert.equal(validName(n), false, String(n))
  })
  it('strips control characters but keeps tab and newline', () => {
    assert.equal(cleanText('a\u001b[31mb\u0007\tc\nd\u009be\u007f'), 'a[31mb\tc\nde')
  })
  it('parses whois and flags tagged devices', () => {
    const id = parseWhois(JSON.stringify({ Node: { StableID: 's1', Name: 'mini.tail.ts.net.', Tags: ['tag:ci'] }, UserProfile: { LoginName: 'me@x' } }))
    assert.deepEqual(id, { node: 's1', name: 'mini.tail.ts.net', login: 'me@x', tagged: true })
    assert.throws(() => parseWhois('{"Node":{}}'), /StableID/)
    assert.equal(parseWhois('{"Node":{"StableID":"s","Tags":null},"UserProfile":{"LoginName":"me"}}').tagged, false)
    assert.throws(() => parseWhois('{"Node":{"StableID":"s"},"UserProfile":{}}'), /LoginName/)
    assert.throws(() => parseWhois('{"Node":{"StableID":"s"},"UserProfile":{"LoginName":""}}'), /LoginName/)
    assert.throws(() => parseWhois('{"Node":{"StableID":"s","Tags":"tag:ci"},"UserProfile":{"LoginName":"me"}}'), /Tags/)
    assert.throws(() => parseWhois('{"Node":{"StableID":"s","Tags":[1]},"UserProfile":{"LoginName":"me"}}'), /Tags/)
  })
  it('runs agent-tmux without TMUX and TMUX_PANE', async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'relay-env-'))
    const fake = join(dir, 'agent-tmux')
    await writeFile(fake, '#!/bin/sh\nprintf "TMUX=[%s] PANE=[%s] DIR=[%s] ARGS=[%s]" "${TMUX-unset}" "${TMUX_PANE-unset}" "$TMUX_AGENT_DIR" "$*"\n')
    await chmod(fake, 0o755)
    const saved = { ...process.env }
    Object.assign(process.env, { TMUX: '/tmp/s,1,0', TMUX_PANE: '%3', TMUX_AGENT_DIR: '/state', TMUX_AGENT_RELAY_AGENT_TMUX: fake })
    try {
      const r = await systemAgentTmux(['codex', 'send', 'w', 'hi there'], 5000)
      assert.equal(r.stdout, 'TMUX=[unset] PANE=[unset] DIR=[/state] ARGS=[codex send w hi there]')
    } finally {
      process.env = saved
    }
  })
})

describe('relay auth (socket peer + whois)', () => {
  let w: World
  before(async () => { w = await world() })
  after(async () => { await w.close() })
  beforeEach(() => { w.peer = { id: MINI } })

  it('answers health to a device of the same user', async () => {
    const r = await fetch(`${w.url}/v1/health`)
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { host: 'mbp', node: 'nSELF', version: 1 })
  })
  it('refuses another user, a tagged device, and an unknown peer (fail closed)', async () => {
    w.peer = { id: { ...MINI, login: 'other@example.com' } }
    assert.equal((await fetch(`${w.url}/v1/health`)).status, 403)
    w.peer = { id: { ...MINI, tagged: true } }
    assert.equal((await fetch(`${w.url}/v1/health`)).status, 403)
    w.peer = { error: 'no such peer' }
    assert.equal((await fetch(`${w.url}/v1/health`)).status, 403)
  })
  it('ignores forwarding headers: the socket peer decides', async () => {
    w.peer = { error: 'no such peer' }
    const r = await fetch(`${w.url}/v1/health`, { headers: { 'x-forwarded-for': '100.64.0.10', 'tailscale-user-login': 'me@example.com' } })
    assert.equal(r.status, 403)
  })
  it('reuses one whois answer per IP for the TTL, and never caches a failure', async () => {
    let n = 0, fail = true, t = 0
    const r = createRelay({ stateDir: w.dir, self: SELF, now: () => t, whoisTtlMs: 1000, agentTmux: async () => ({ code: 0, stdout: '', stderr: '' }),
      whois: async () => { n++; if (fail) throw new Error('unknown'); return MINI } })
    await new Promise<void>((ok) => r.server.listen(0, '127.0.0.1', ok))
    const u = `http://127.0.0.1:${(r.server.address() as AddressInfo).port}/v1/health`
    assert.equal((await fetch(u)).status, 403)
    fail = false
    assert.equal((await fetch(u)).status, 200)
    assert.equal((await fetch(u)).status, 200)
    assert.equal(n, 2)
    t = 1001
    assert.equal((await fetch(u)).status, 200)
    assert.equal(n, 3)
    await new Promise<void>((ok) => r.server.close(() => ok()))
  })
  it('answers 405 with Allow for a known path and a wrong method', async () => {
    const r = await fetch(`${w.url}/v1/exit`)
    assert.equal(r.status, 405)
    assert.equal(r.headers.get('allow'), 'POST')
    assert.equal((await fetch(`${w.url}/v1/roster`, { method: 'POST' })).status, 405)
  })
  it('refuses invalid UTF-8 and caps a chunked body after decoding', async () => {
    const raw = (body: Buffer, chunked: boolean) => new Promise<number>((resolve, reject) => {
      const u = new URL(`${w.url}/v1/exit`)
      const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': body.length }) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      if (chunked) for (let i = 0; i < body.length; i += 1024) req.write(body.subarray(i, i + 1024))
      else req.write(body)
      req.end()
    })
    await meta(w, 'utf', { cli: 'codex', launch_id: 'U1', notify_node: 'nMINI' })
    // Valid except one byte in an ignored field: only a fatal decoder refuses it.
    assert.equal(await raw(Buffer.concat([Buffer.from('{"name":"utf","launch_id":"U1","code":0,"pad":"'), Buffer.from([0xff]), Buffer.from('"}')]), false), 400)
    assert.equal(await exists(join(w.dir, 'utf', 'remote.exit')), false)
    assert.equal(await raw(Buffer.from(`{"pad":"${'x'.repeat(17 * 1024)}"}`), true), 413)
  })
  it('caps whois work in flight at 8 distinct peers (503), sharing one lookup per IP', async () => {
    const pending: Array<() => void> = []
    let n = 0
    const r = createRelay({ stateDir: w.dir, self: SELF, agentTmux: async () => ({ code: 0, stdout: '', stderr: '' }),
      whois: (ip) => { n++; return new Promise((ok) => pending.push(() => ok({ ...MINI, node: ip }))) } })
    const fake = (ip: string) => {
      const res = { statusCode: 0, headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v }, end() { done(this.statusCode) } }
      let done!: (s: number) => void
      const p = new Promise<number>((ok) => { done = ok })
      void r.handle({ socket: { remoteAddress: ip }, url: '/v1/health', method: 'GET', headers: {}, complete: true } as never, res as never)
      return p
    }
    const live = Array.from({ length: 8 }, (_, i) => fake(`100.64.0.${i + 1}`))
    const twin = fake('100.64.0.1')
    assert.equal(await fake('100.64.0.99'), 503)
    assert.equal(n, 8)
    for (const go of pending) go()
    assert.deepEqual(await Promise.all([...live, twin]), Array(9).fill(200))
  })
  it('answers 404 for an unknown route, after auth', async () => {
    assert.equal((await fetch(`${w.url}/v1/nope`)).status, 404)
    w.peer = { error: 'x' }
    assert.equal((await fetch(`${w.url}/v1/nope`)).status, 403)
  })
  it('logs every decision without the message text', async () => {
    await post(w, '/v1/message', { to: 'nobody', from: 'a', id: 'log-1', text: 'SECRET-TEXT' })
    const log = await readFile(join(w.dir, 'relay', 'relay.log.jsonl'), 'utf8')
    assert.match(log, /"route":"POST \/v1\/message"/)
    assert.doesNotMatch(log, /SECRET-TEXT/)
  })
})

describe('POST /v1/exit', () => {
  let w: World
  before(async () => { w = await world() })
  after(async () => { await w.close() })
  beforeEach(() => { w.peer = { id: MINI } })

  it('rejects malformed bodies', async () => {
    await meta(w, 'job', { cli: 'codex', launch_id: 'L1', notify_node: 'nMINI' })
    assert.equal((await post(w, '/v1/exit', { name: 'job', launch_id: 'L1', code: 0 }, { 'content-type': 'text/plain' })).status, 415)
    assert.equal((await post(w, '/v1/exit', 'not json')).status, 400)
    assert.equal((await post(w, '/v1/exit', '[1]')).status, 400)
    for (const code of [-1, 256, 1.5, '0', null]) assert.equal((await post(w, '/v1/exit', { name: 'job', launch_id: 'L1', code })).status, 400, `code ${code}`)
    assert.equal((await post(w, '/v1/exit', { name: "it's", launch_id: 'L1', code: 0 })).status, 400)
    assert.equal((await post(w, '/v1/exit', { name: '../job', launch_id: 'L1', code: 0 })).status, 400)
    assert.equal((await post(w, '/v1/exit', { name: 'job', launch_id: 'L1', code: 0, pad: 'x'.repeat(17 * 1024) })).status, 413)
    assert.equal(await exists(join(w.dir, 'job', 'remote.exit')), false)
  })
  it('binds the push to the recorded device and the current launch', async () => {
    await meta(w, 'bind', { cli: 'codex', launch_id: 'N2', notify_node: 'nMINI' })
    await meta(w, 'plain', { cli: 'codex', launch_id: 'P1' })
    assert.equal((await post(w, '/v1/exit', { name: 'ghost', launch_id: 'N2', code: 0 })).status, 404)
    assert.equal((await post(w, '/v1/exit', { name: 'plain', launch_id: 'P1', code: 0 })).status, 409)
    w.peer = { id: { ...MINI, node: 'nOTHER', name: 'laptop' } }
    assert.equal((await post(w, '/v1/exit', { name: 'bind', launch_id: 'N2', code: 0 })).status, 403)
    w.peer = { id: MINI }
    // A late push of launch N1 after N2 started never touches N2's state.
    assert.equal((await post(w, '/v1/exit', { name: 'bind', launch_id: 'N1', code: 9 })).status, 409)
    assert.equal(await exists(join(w.dir, 'bind', 'remote.exit')), false)
  })
  it('records the first push of the launch once, atomically', async () => {
    await meta(w, 'once', { cli: 'codex', launch_id: 'L7', notify_node: 'nMINI' })
    const results = await Promise.all([3, 4, 5, 6, 7].map((code) => post(w, '/v1/exit', { name: 'once', launch_id: 'L7', code })))
    const statuses = results.map((r) => r.status).sort()
    assert.deepEqual(statuses, [204, 409, 409, 409, 409])
    const rec = JSON.parse(await readFile(join(w.dir, 'once', 'remote-exit.json'), 'utf8')) as { code: number; launch_id: string; node: string }
    assert.equal(await readFile(join(w.dir, 'once', 'remote.exit'), 'utf8'), `${rec.code}\n`)
    assert.equal(rec.launch_id, 'L7')
    assert.equal(rec.node, 'nMINI')
    assert.equal((await post(w, '/v1/exit', { name: 'once', launch_id: 'L7', code: 0 })).status, 409)
  })
  it('never follows a symlinked worker dir, and refuses . and ..', async () => {
    await meta(w, 'real', { cli: 'codex', launch_id: 'S1', notify_node: 'nMINI' })
    await symlink(join(w.dir, 'real'), join(w.dir, 'link'))
    assert.equal((await post(w, '/v1/exit', { name: 'link', launch_id: 'S1', code: 0 })).status, 404)
    assert.equal(await exists(join(w.dir, 'real', 'remote.exit')), false)
    for (const name of ['.', '..']) assert.equal((await post(w, '/v1/exit', { name, launch_id: 'S1', code: 0 })).status, 400)
  })
  it('needs a launch_id and notify_node in the meta', async () => {
    await meta(w, 'nolid', { cli: 'codex', notify_node: 'nMINI' })
    assert.equal((await post(w, '/v1/exit', { name: 'nolid', launch_id: 'X', code: 0 })).status, 409)
    await meta(w, 'emptynode', { cli: 'codex', launch_id: 'X', notify_node: '' })
    assert.equal((await post(w, '/v1/exit', { name: 'emptynode', launch_id: 'X', code: 0 })).status, 409)
  })
  it('repair restores remote.exit from a current-launch record, never from an old launch', async () => {
    await meta(w, 'rep', { cli: 'codex', launch_id: 'R1', notify_node: 'nMINI' })
    assert.equal((await post(w, '/v1/exit', { name: 'rep', launch_id: 'R1', code: 5 })).status, 204)
    await unlink(join(w.dir, 'rep', 'remote.exit'))
    const r = createRelay({ stateDir: w.dir, self: SELF, whois: async () => MINI, agentTmux: async () => ({ code: 0, stdout: '', stderr: '' }) })
    assert.ok((await r.repair()).includes('rep'))
    assert.equal(await readFile(join(w.dir, 'rep', 'remote.exit'), 'utf8'), '5\n')
    await unlink(join(w.dir, 'rep', 'remote.exit'))
    await meta(w, 'rep', { cli: 'codex', launch_id: 'R2', notify_node: 'nMINI' })
    assert.ok(!(await r.repair()).includes('rep'))
    assert.equal(await exists(join(w.dir, 'rep', 'remote.exit')), false)
  })
  it('undoes its claim when a new launch replaced the worker during the push', async () => {
    await meta(w, 'swap', { cli: 'codex', launch_id: 'W1', notify_node: 'nMINI' })
    // The exit handler calls now() between its meta read and the claim: the new launch lands right there.
    const r = createRelay({ stateDir: w.dir, self: SELF, whois: async () => MINI, agentTmux: async () => ({ code: 0, stdout: '', stderr: '' }),
      now: () => { if (new Error().stack?.includes('onExit')) writeFileSync(join(w.dir, 'swap', 'launch-meta.json'), JSON.stringify({ cli: 'codex', launch_id: 'W2', notify_node: 'nMINI' })); return Date.now() } })
    await new Promise<void>((ok) => r.server.listen(0, '127.0.0.1', ok))
    const u = `http://127.0.0.1:${(r.server.address() as AddressInfo).port}/v1/exit`
    const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'swap', launch_id: 'W1', code: 3 }) })
    assert.equal(res.status, 409)
    assert.equal(await exists(join(w.dir, 'swap', 'remote-exit.json')), false)
    assert.equal(await exists(join(w.dir, 'swap', 'remote.exit')), false)
    await new Promise<void>((ok) => r.server.close(() => ok()))
    assert.equal((await post(w, '/v1/exit', { name: 'swap', launch_id: 'W2', code: 4 })).status, 204)
  })
  it('writeOnce has one winner among concurrent writers', async () => {
    const p = join(w.dir, 'once-file')
    const wins = await Promise.all(Array.from({ length: 10 }, (_, i) => writeOnce(p, `${i}`)))
    assert.equal(wins.filter(Boolean).length, 1)
  })
})

describe('POST /v1/message', () => {
  let w: World
  before(async () => { w = await world() })
  after(async () => { await w.close() })
  beforeEach(() => { w.peer = { id: MINI }; w.calls = []; w.sendResult = { code: 0, stdout: '', stderr: '' } })

  it('delivers to a running worker with provenance, control characters removed', async () => {
    await meta(w, 'lead', { cli: 'claude', launch_id: 'A' })
    w.running.lead = true
    const r = await post(w, '/v1/message', { to: 'lead', from: 'job', id: 'm1', text: 'done\u001b[2J: see log\nline2' })
    assert.equal(r.status, 202)
    assert.deepEqual(w.calls.at(-1), ['claude', 'send', 'lead', '[relay mini/job] done[2J: see log\nline2'])
  })
  it('delivers an id once (also after a relay restart)', async () => {
    assert.equal((await post(w, '/v1/message', { to: 'lead', from: 'job', id: 'm2', text: 'x' })).status, 202)
    const r = await post(w, '/v1/message', { to: 'lead', from: 'job', id: 'm2', text: 'x' })
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { duplicate: true })
    assert.equal(w.calls.filter((c) => c[1] === 'send').length, 1)
    const again = createRelay({ stateDir: w.dir, self: SELF, whois: async () => MINI, agentTmux: async (a) => (a[1] === 'status' ? { code: 0, stdout: '{"exists":true,"running":true}', stderr: '' } : { code: 0, stdout: '', stderr: '' }) })
    await new Promise<void>((r2) => again.server.listen(0, '127.0.0.1', r2))
    const url = `http://127.0.0.1:${(again.server.address() as AddressInfo).port}`
    const r3 = await fetch(`${url}/v1/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'lead', from: 'job', id: 'm2', text: 'x' }) })
    assert.equal(r3.status, 200)
    await new Promise<void>((r4) => again.server.close(() => r4()))
  })
  it('refuses a stopped or unknown worker and bad fields, without sending', async () => {
    await meta(w, 'gone', { cli: 'codex', launch_id: 'G' })
    w.running.gone = false
    assert.equal((await post(w, '/v1/message', { to: 'gone', from: 'a', id: 'g1', text: 'x' })).status, 409)
    assert.equal((await post(w, '/v1/message', { to: 'nobody', from: 'a', id: 'g2', text: 'x' })).status, 404)
    assert.equal((await post(w, '/v1/message', { to: 'lead', from: 'a b', id: 'g3', text: 'x' })).status, 400)
    assert.equal((await post(w, '/v1/message', { to: 'lead', from: 'a', id: 'x'.repeat(129), text: 'x' })).status, 400)
    assert.equal((await post(w, '/v1/message', { to: 'lead', from: 'a', id: 'g4', text: '\u001b\u0007' })).status, 400)
    assert.equal((await post(w, '/v1/message', { to: 'lead', from: 'a', id: 'g5', text: 'é'.repeat(4097) })).status, 413)
    assert.equal(w.calls.filter((c) => c[1] === 'send').length, 0)
  })
  it('answers a failed send with its rc only (stderr can echo the text); the id is spent, never sent twice', async () => {
    w.sendResult = { code: 1, stdout: '', stderr: 'boom: SECRET-TEXT' }
    const r = await post(w, '/v1/message', { to: 'lead', from: 'a', id: 'f1', text: 'SECRET-TEXT' })
    assert.equal(r.status, 502)
    const err = ((await r.json()) as { error: string }).error
    assert.match(err, /rc 1/)
    assert.doesNotMatch(err, /SECRET/)
    w.sendResult = { code: 0, stdout: '', stderr: '' }
    const again = await post(w, '/v1/message', { to: 'lead', from: 'a', id: 'f1', text: 'SECRET-TEXT' })
    assert.equal(again.status, 409)
    assert.match(((await again.json()) as { error: string }).error, /unknown/)
    assert.equal(w.calls.filter((c) => c[1] === 'send').length, 1)
    assert.equal((await post(w, '/v1/message', { to: 'lead', from: 'a', id: 'f1b', text: 'SECRET-TEXT' })).status, 202)
  })
  it('a refusal before the send frees the id, also across a relay restart', async () => {
    await meta(w, 'later', { cli: 'codex', launch_id: 'LT' })
    w.running.later = false
    assert.equal((await post(w, '/v1/message', { to: 'later', from: 'a', id: 'r1', text: 'x' })).status, 409)
    const fresh = createRelay({ stateDir: w.dir, self: SELF, whoisTtlMs: 0, whois: async () => MINI, agentTmux: async (a) => (a[1] === 'status' ? { code: 0, stdout: '{"exists":true,"running":true}', stderr: '' } : { code: 0, stdout: '', stderr: '' }) })
    await new Promise<void>((ok) => fresh.server.listen(0, '127.0.0.1', ok))
    const u = `http://127.0.0.1:${(fresh.server.address() as AddressInfo).port}/v1/message`
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'later', from: 'a', id: 'r1', text: 'x' }) })
    assert.equal(r.status, 202)
    await new Promise<void>((ok) => fresh.server.close(() => ok()))
  })
  it('a torn line in the id file is skipped; the records around it still hold', async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'relay-torn-'))
    await meta({ dir } as World, 'lead', { cli: 'claude', launch_id: 'A' })
    await mkdir(join(dir, 'relay'), { recursive: true })
    const digest = createHash('sha256').update(JSON.stringify(['a', 'x'])).digest('hex')
    const line = (id: string) => `${JSON.stringify({ key: `nMINI|A|${id}`, digest, state: 'done', at: Date.now() })}\n`
    await writeFile(join(dir, 'relay', 'seen-ids.jsonl'), `${line('t1')}{"key":"nMINI|A|t2","dig\n${line('t3')}`)
    const sends: string[][] = []
    const r = createRelay({ stateDir: dir, self: SELF, whoisTtlMs: 0, whois: async () => MINI, agentTmux: async (a) => { if (a[1] === 'send') sends.push(a); return a[1] === 'status' ? { code: 0, stdout: '{"exists":true,"running":true}', stderr: '' } : { code: 0, stdout: '', stderr: '' } } })
    await new Promise<void>((ok) => r.server.listen(0, '127.0.0.1', ok))
    const u = `http://127.0.0.1:${(r.server.address() as AddressInfo).port}/v1/message`
    const send = (id: string) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'lead', from: 'a', id, text: 'x' }) }).then((x) => x.status)
    assert.deepEqual([await send('t1'), await send('t3'), await send('t2')], [200, 200, 202])
    assert.equal(sends.length, 1)
    assert.doesNotMatch(await readFile(join(dir, 'relay', 'seen-ids.jsonl'), 'utf8'), /"dig$/m)
    await new Promise<void>((ok) => r.server.close(() => ok()))
  })
  it('keys an id by sender device and target launch; another body under a used id is 409', async () => {
    assert.equal((await post(w, '/v1/message', { to: 'lead', from: 'a', id: 'k1', text: 'one' })).status, 202)
    assert.equal((await post(w, '/v1/message', { to: 'lead', from: 'a', id: 'k1', text: 'two' })).status, 409)
    w.peer = { id: { ...MINI, node: 'nLAPTOP', name: 'laptop' } }
    assert.equal((await post(w, '/v1/message', { to: 'lead', from: 'a', id: 'k1', text: 'two' })).status, 202)
    w.peer = { id: MINI }
    await meta(w, 'lead', { cli: 'claude', launch_id: 'B' })
    assert.equal((await post(w, '/v1/message', { to: 'lead', from: 'a', id: 'k1', text: 'two' })).status, 202)
    await meta(w, 'lead', { cli: 'claude', launch_id: 'A' })
  })
  it('sends one of two equal requests at once; the other is told it is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slow = createRelay({ stateDir: w.dir, self: SELF, whoisTtlMs: 0, whois: async () => MINI, agentTmux: async (a) => {
      if (a[1] === 'status') return { code: 0, stdout: '{"exists":true,"running":true}', stderr: '' }
      w.calls.push(a); await gate; return { code: 0, stdout: '', stderr: '' }
    } })
    await new Promise<void>((r) => slow.server.listen(0, '127.0.0.1', r))
    const u = `http://127.0.0.1:${(slow.server.address() as AddressInfo).port}/v1/message`
    const body = JSON.stringify({ to: 'lead', from: 'a', id: 'race', text: 'x' })
    const send = () => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    const first = send()
    while (!w.calls.some((c) => c.at(-1)?.endsWith(' x'))) await new Promise((r) => setTimeout(r, 5))
    assert.equal((await send()).status, 409)
    release()
    assert.equal((await first).status, 202)
    assert.equal((await send()).status, 200)
    await new Promise<void>((r) => slow.server.close(() => r()))
  })
  it('a reservation left by a stopped relay answers 409 "unknown", never a second send', async () => {
    const key = `nMINI|A|left`
    await writeFile(join(w.dir, 'relay', 'seen-ids.jsonl'), `${await readFile(join(w.dir, 'relay', 'seen-ids.jsonl'), 'utf8')}${JSON.stringify({ key, digest: createHash('sha256').update(JSON.stringify(['a', 'x'])).digest('hex'), state: 'reserved', at: Date.now() })}\n`)
    const fresh = createRelay({ stateDir: w.dir, self: SELF, whoisTtlMs: 0, whois: async () => MINI, agentTmux: async (a) => { w.calls.push(a); return a[1] === 'status' ? { code: 0, stdout: '{"exists":true,"running":true}', stderr: '' } : { code: 0, stdout: '', stderr: '' } } })
    await new Promise<void>((r) => fresh.server.listen(0, '127.0.0.1', r))
    const u = `http://127.0.0.1:${(fresh.server.address() as AddressInfo).port}/v1/message`
    w.calls = []
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'lead', from: 'a', id: 'left', text: 'x' }) })
    assert.equal(r.status, 409)
    assert.match(((await r.json()) as { error: string }).error, /unknown/)
    assert.equal(w.calls.filter((c) => c[1] === 'send').length, 0)
    await new Promise<void>((r2) => fresh.server.close(() => r2()))
  })
})

describe('GET /v1/roster', () => {
  let w: World
  before(async () => { w = await world() })
  after(async () => { await w.close() })

  it('asks the workers\' status in parallel, so a full host answers within the client deadline', async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'relay-roster-'))
    for (let i = 0; i < 16; i++) await meta({ dir } as World, `p${i}`, { cli: 'codex', launch_id: `L${i}` })
    let inFlight = 0, peak = 0
    const r = createRelay({ stateDir: dir, self: SELF, whois: async () => MINI, agentTmux: async () => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise((ok) => setTimeout(ok, 200)); inFlight--
      return { code: 0, stdout: '{"exists":true,"running":true}', stderr: '' }
    } })
    await new Promise<void>((ok) => r.server.listen(0, '127.0.0.1', ok))
    const t0 = Date.now()
    const body = (await (await fetch(`http://127.0.0.1:${(r.server.address() as AddressInfo).port}/v1/roster`)).json()) as { workers: Array<{ name: string; running: boolean }> }
    assert.ok(Date.now() - t0 < 1500, `roster took ${Date.now() - t0} ms`)
    assert.equal(peak, 16)
    assert.equal(body.workers.length, 16)
    assert.ok(body.workers.every((x) => x.running === true))
    await new Promise<void>((ok) => r.server.close(() => ok()))
  })
  it('lists workers with launch-meta and their liveness, skipping state dirs', async () => {
    await meta(w, 'a1', { cli: 'codex', exec_mode: 'tui', launch_id: 'LA' })
    await meta(w, 'b2', { cli: 'claude', exec_mode: 'tui', launch_id: 'LB', remote_target: 'mini' })
    await mkdir(join(w.dir, '.v3', 'x'), { recursive: true })
    await mkdir(join(w.dir, 'relay'), { recursive: true })
    await mkdir(join(w.dir, 'nometa'), { recursive: true })
    w.running.a1 = true
    const r = await fetch(`${w.url}/v1/roster`)
    assert.equal(r.status, 200)
    const body = (await r.json()) as { host: string; workers: Array<{ name: string; running: boolean | null; exists: boolean | null; remote_target: string | null }> }
    assert.equal(body.host, 'mbp')
    assert.deepEqual(body.workers.map((x) => [x.name, x.exists, x.running, x.remote_target]), [['a1', true, true, null], ['b2', false, false, 'mini']])
  })
})
