// tmux-agent-relay: one small HTTP relay per host, reachable only over the tailnet.
// It takes exit pushes from start-ssh workers (POST /v1/exit), messages for local
// workers (POST /v1/message), and answers the host's worker roster (GET /v1/roster).
//
// Trust (README "Relay (tailnet)"): the server binds one of this node's tailnet
// addresses, never a wildcard. Every request is checked against the socket peer (never
// a header) with `tailscale whois`: the peer must be an untagged device of the same
// Tailscale user as this host. An exit push is further bound to the launch: the device
// recorded at launch (launch-meta notify_node) and the current launch_id. The relay
// never runs request text: it writes files and calls `agent-tmux` with argv.
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, link, lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RELAY_VERSION = 1
export const DEFAULT_PORT = 7717
export const MAX_BODY = 16 * 1024
export const MAX_TEXT = 8 * 1024
export const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
export const WHOIS_TTL_MS = 60_000
const WHOIS_MAX_INFLIGHT = 8
const WHOIS_MAX_CACHE = 256
const SEEN_TTL_MS = 24 * 3600_000
const ROSTER_PARALLEL = 16
const ROSTER_STATUS_MS = 3000
/** roster's per-host deadline: one parallel round of status calls plus slack. */
const ROSTER_CLIENT_MS = 5000

/** A worker name the relay accepts: agent-tmux's charset, minus the path names `.` and `..`. */
export const validName = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(s) && s !== '.' && s !== '..'

export type Identity = { node: string; name: string; login: string; tagged: boolean }
export type RunResult = { code: number; stdout: string; stderr: string }
export type RelayDeps = {
  /** State root (TMUX_AGENT_DIR or its default). */
  stateDir: string
  /** whois of an IP; throws when the peer is unknown or the answer is malformed. */
  whois: (ip: string) => Promise<Identity>
  /** agent-tmux with argv; the env never carries TMUX / TMUX_PANE. */
  agentTmux: (args: string[], timeoutMs: number) => Promise<RunResult>
  self: Identity
  now?: () => number
  /** How long one whois answer is reused for its IP (default WHOIS_TTL_MS). */
  whoisTtlMs?: number
}

// ---------------------------------------------------------------- helpers

/** `::ffff:100.1.2.3` → `100.1.2.3`; a zone id is dropped. */
export function normalizePeer(addr: string | undefined): string {
  if (!addr) return ''
  let a = addr.replace(/%.*$/, '')
  if (a.toLowerCase().startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7)
  return a
}

const LOOPBACK = (a: string) => a === '127.0.0.1' || a === '::1'

/**
 * A bind address must be one of this node's tailnet addresses. Loopback is only for
 * tests that bring their own whois (TMUX_AGENT_RELAY_WHOIS); it is not a deployment option.
 */
export function checkBind(addr: string, ownAddrs: readonly string[], testWhois: boolean): string | undefined {
  if (!isIP(addr)) return `--bind must be an IP address, got ${JSON.stringify(addr)}`
  if (addr === '0.0.0.0' || addr === '::' || /^0*:(0*:)*0*$/.test(addr)) return '--bind must not be a wildcard address'
  if (testWhois && LOOPBACK(addr)) return undefined
  if (!ownAddrs.includes(addr)) return `--bind ${addr} is not a tailnet address of this node (${ownAddrs.join(', ') || 'none'})`
  return undefined
}

/** C0 and C1 controls and DEL go; tab and newline stay. A pane must never get escape sequences. */
export function cleanText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

/** Every field the trust rule compares must be present and well-formed; anything else is no identity. */
export function parseWhois(json: string): Identity {
  const w = JSON.parse(json) as {
    Node?: { StableID?: unknown; Name?: unknown; Tags?: unknown }
    UserProfile?: { LoginName?: unknown }
  }
  const node = w?.Node?.StableID, login = w?.UserProfile?.LoginName, tags = w?.Node?.Tags, name = w?.Node?.Name
  if (typeof node !== 'string' || !node) throw new Error('whois answer has no Node.StableID')
  if (typeof login !== 'string' || !login) throw new Error('whois answer has no UserProfile.LoginName')
  if (!(tags === undefined || tags === null || (Array.isArray(tags) && tags.every((t) => typeof t === 'string')))) throw new Error('whois answer has a malformed Node.Tags')
  return { node, name: typeof name === 'string' ? name.replace(/\.$/, '') : '', login, tagged: Array.isArray(tags) && tags.length > 0 }
}

function run(bin: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
      const timedOut = !!error && (error as { killed?: boolean }).killed
      resolve({ code: timedOut ? 124 : code, stdout: String(stdout), stderr: String(stderr) + (timedOut ? `\n${bin}: timed out after ${timeoutMs} ms` : '') })
    })
  })
}

/** The tailscale CLI (TMUX_AGENT_RELAY_TAILSCALE overrides it, for tests). */
const tailscaleBin = () => process.env.TMUX_AGENT_RELAY_TAILSCALE || 'tailscale'

export async function systemWhois(ip: string): Promise<Identity> {
  const fake = process.env.TMUX_AGENT_RELAY_WHOIS
  const r = fake ? await run(fake, ['--json', ip], 3000) : await run(tailscaleBin(), ['whois', '--json', ip], 3000)
  if (r.code !== 0) throw new Error(`whois ${ip} failed (rc ${r.code}): ${r.stderr.trim().split('\n').pop() ?? ''}`)
  return parseWhois(r.stdout)
}

export function stateRoot(): string {
  const env = process.env
  return env.TMUX_AGENT_DIR || join(env.XDG_STATE_HOME || join(env.HOME ?? '', '.local/state'), 'tmux-agent-tools')
}

const agentTmuxPath = () => process.env.TMUX_AGENT_RELAY_AGENT_TMUX || join(dirname(fileURLToPath(import.meta.url)), '..', 'agent-tmux')

/** agent-tmux without TMUX / TMUX_PANE: run from the relay's own tmux pane, it must not target that server's pane. */
export function systemAgentTmux(args: string[], timeoutMs: number): Promise<RunResult> {
  const env = { ...process.env }
  delete env.TMUX
  delete env.TMUX_PANE
  return run(agentTmuxPath(), args, timeoutMs, env)
}

/** Write <path> only if it does not exist yet: hard link of a private tmp, so a race has one winner. */
export async function writeOnce(path: string, data: string): Promise<boolean> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, data, { flag: 'wx' })
  try {
    await link(tmp, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

async function writeAtomic(path: string, data: string) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, data, { flag: 'wx' })
  await rename(tmp, path)
}

// ---------------------------------------------------------------- server

type Reply = { status: number; body?: unknown }
class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = (String(req.headers['content-type'] ?? '').split(';')[0] ?? '').trim().toLowerCase()
  if (type !== 'application/json') throw new HttpError(415, 'content-type must be application/json')
  const declared = Number(req.headers['content-length'] ?? NaN)
  if (declared > MAX_BODY) throw new HttpError(413, `body over ${MAX_BODY} bytes`)
  // Counted after transfer decoding, so a chunked body has the same cap.
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, `body over ${MAX_BODY} bytes`)
    chunks.push(chunk as Buffer)
  }
  if (!req.complete) throw new HttpError(400, 'body ended early')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new HttpError(400, 'body is not valid UTF-8')
  }
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'body must be one JSON object')
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'body must be one JSON object')
  return v as Record<string, unknown>
}

type LaunchMeta = { launch_id?: unknown; cli?: unknown; exec_mode?: unknown; notify_node?: unknown; remote_target?: unknown }
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0

export type RelayState = ReturnType<typeof stateFns>
/** File access below the state root. A worker directory must be a real directory, never a symlink. */
function stateFns(stateDir: string) {
  const workerDir = async (name: string): Promise<string | undefined> => {
    if (!validName(name)) return undefined
    const dir = join(stateDir, name)
    try {
      const st = await lstat(dir)
      return st.isDirectory() && !st.isSymbolicLink() ? dir : undefined
    } catch {
      return undefined
    }
  }
  const readMeta = async (name: string): Promise<LaunchMeta | undefined> => {
    const dir = await workerDir(name)
    if (!dir) return undefined
    try {
      const st = await lstat(join(dir, 'launch-meta.json'))
      if (!st.isFile()) return undefined
      const m = JSON.parse(await readFile(join(dir, 'launch-meta.json'), 'utf8')) as unknown
      return m && typeof m === 'object' && !Array.isArray(m) ? (m as LaunchMeta) : undefined
    } catch {
      return undefined
    }
  }
  return { workerDir, readMeta }
}

export type Relay = { server: Server; handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>; repair: () => Promise<string[]> }

export function createRelay(deps: RelayDeps): Relay {
  const now = deps.now ?? Date.now
  const whoisTtl = deps.whoisTtlMs ?? WHOIS_TTL_MS
  const relayDir = join(deps.stateDir, 'relay')
  const logPath = join(relayDir, 'relay.log.jsonl')
  const seenPath = join(relayDir, 'seen-ids.jsonl')
  const { workerDir, readMeta } = stateFns(deps.stateDir)
  const whoisCache = new Map<string, { at: number; id: Identity }>()
  const whoisInflight = new Map<string, Promise<Identity>>()
  type Seen = { digest: string; state: 'reserved' | 'done' | 'unknown'; at: number }
  let seen: Map<string, Seen> | undefined
  let seenLock: Promise<unknown> = Promise.resolve()

  const log = async (entry: Record<string, unknown>) => {
    await mkdir(relayDir, { recursive: true })
    await appendFile(logPath, `${JSON.stringify({ at: new Date(now()).toISOString(), ...entry })}\n`)
  }

  // An expired answer is never reused: a refresh that fails refuses the request,
  // so a removed device loses access within whoisTtl.
  const identify = async (ip: string): Promise<Identity> => {
    const hit = whoisCache.get(ip)
    if (hit && now() - hit.at < whoisTtl) return hit.id
    let job = whoisInflight.get(ip)
    if (!job) {
      if (whoisInflight.size >= WHOIS_MAX_INFLIGHT) throw new HttpError(503, 'too many identity checks in flight; retry')
      job = deps.whois(ip).finally(() => whoisInflight.delete(ip))
      whoisInflight.set(ip, job)
    }
    try {
      const id = await job
      if (whoisCache.size >= WHOIS_MAX_CACHE) whoisCache.delete(whoisCache.keys().next().value!)
      whoisCache.set(ip, { at: now(), id })
      return id
    } catch (error) {
      whoisCache.delete(ip)
      throw new HttpError(403, `peer ${ip} is not a known tailnet device: ${(error as Error).message}`)
    }
  }

  const authorize = (peer: Identity) => {
    if (peer.tagged) throw new HttpError(403, `device ${peer.name || peer.node} is tagged; only the owner's own devices may use this relay`)
    if (peer.login !== deps.self.login) throw new HttpError(403, `device ${peer.name || peer.node} belongs to another user`)
  }

  // ---- message ids: key = sender device + target launch + id
  const loadSeen = async () => {
    if (seen) return seen
    seen = new Map()
    try {
      for (const line of (await readFile(seenPath, 'utf8')).split('\n')) {
        if (!line) continue
        let r: { key: string; state: Seen['state'] | 'released'; digest: string; at: number }
        try {
          r = JSON.parse(line)
        } catch {
          continue  // a line torn by a crash mid-append; the rewrite below drops it
        }
        if (typeof r?.key !== 'string') continue
        // Later lines win: a release deletes the key, a result replaces its reservation.
        if (r.state === 'released' || now() - r.at >= SEEN_TTL_MS) { seen.delete(r.key); continue }
        // A reservation without a result: the relay stopped while a send ran; its outcome is unknown.
        seen.set(r.key, { digest: r.digest, state: r.state === 'reserved' ? 'unknown' : r.state, at: r.at })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await mkdir(relayDir, { recursive: true })
    await writeAtomic(seenPath, [...seen].map(([key, v]) => `${JSON.stringify({ key, ...v })}\n`).join(''))
    return seen
  }
  const seenOp = <T>(fn: (s: Map<string, Seen>) => Promise<T>): Promise<T> => {
    const next = seenLock.then(async () => fn(await loadSeen()))
    seenLock = next.catch(() => {})
    return next
  }
  const persist = (key: string, v: Seen | { state: 'released' }) => appendFile(seenPath, `${JSON.stringify({ key, ...v, at: now() })}\n`)

  const str = (body: Record<string, unknown>, key: string) => (typeof body[key] === 'string' ? (body[key] as string) : undefined)

  const onExit = async (peer: Identity, body: Record<string, unknown>): Promise<Reply> => {
    const name = body.name, launchId = body.launch_id, code = body.code
    if (!validName(name)) throw new HttpError(400, 'name must match [A-Za-z0-9._-]{1,64} and not be . or ..')
    if (!nonEmpty(launchId) || !ID_RE.test(launchId)) throw new HttpError(400, 'launch_id is missing or malformed')
    if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 255) throw new HttpError(400, 'code must be a JSON integer 0..255')
    const dir = await workerDir(name)
    const meta = await readMeta(name)
    if (!dir || !meta) throw new HttpError(404, `no worker ${name} on this host`)
    if (!nonEmpty(meta.notify_node) || !nonEmpty(meta.launch_id)) throw new HttpError(409, `worker ${name} was not started with --notify`)
    if (meta.notify_node !== peer.node) throw new HttpError(403, `worker ${name} runs on another device`)
    if (meta.launch_id !== launchId) throw new HttpError(409, `launch ${launchId} is not the current launch of ${name}`)
    const record = `${JSON.stringify({ launch_id: launchId, code, node: peer.node, node_name: peer.name, received_at: new Date(now()).toISOString() })}\n`
    // The claim: remote-exit.json names the launch; one push wins.
    if (!(await writeOnce(join(dir, 'remote-exit.json'), record))) throw new HttpError(409, `the exit of ${name} was already recorded`)
    // A new launch that replaced this one while we claimed: undo our claim, it is not this launch's file.
    const after = await readMeta(name)
    if (after?.launch_id !== launchId) {
      const cur = await readFile(join(dir, 'remote-exit.json'), 'utf8').catch(() => '')
      if (cur === record) await unlink(join(dir, 'remote-exit.json')).catch(() => {})
      throw new HttpError(409, `launch ${launchId} was replaced while its exit was recorded`)
    }
    await writeAtomic(join(dir, 'remote.exit'), `${code}\n`)
    return { status: 204 }
  }

  const status = async (cli: string, name: string, timeoutMs = 15_000): Promise<{ exists: boolean; running: boolean } | undefined> => {
    const r = await deps.agentTmux([cli, 'status', '--json', name], timeoutMs)
    try {
      const s = JSON.parse(r.stdout) as { exists?: unknown; running?: unknown }
      return { exists: s.exists === true, running: s.running === true }
    } catch {
      return undefined
    }
  }

  const onMessage = async (peer: Identity, body: Record<string, unknown>): Promise<Reply> => {
    const to = body.to, from = body.from ?? 'unknown', id = body.id, raw = str(body, 'text')
    if (!validName(to)) throw new HttpError(400, 'to must match [A-Za-z0-9._-]{1,64} and not be . or ..')
    if (!validName(from)) throw new HttpError(400, 'from must match [A-Za-z0-9._-]{1,64} and not be . or ..')
    if (!nonEmpty(id) || !ID_RE.test(id)) throw new HttpError(400, 'id must match [A-Za-z0-9._:-]{1,128}')
    if (raw === undefined) throw new HttpError(400, 'text must be a string')
    const text = cleanText(raw)
    if (!text.trim()) throw new HttpError(400, 'text is empty')
    if (Buffer.byteLength(text) > MAX_TEXT) throw new HttpError(413, `text over ${MAX_TEXT} bytes`)
    const meta = await readMeta(to)
    if (!meta || !nonEmpty(meta.cli)) throw new HttpError(404, `no worker ${to} on this host`)
    const cli = meta.cli
    const key = `${peer.node}|${nonEmpty(meta.launch_id) ? meta.launch_id : '-'}|${id}`
    const digest = createHash('sha256').update(JSON.stringify([from, raw])).digest('hex')
    // Reserve before the send: two equal requests at once cannot both type into the pane.
    const prior = await seenOp(async (s) => {
      const p = s.get(key)
      if (p) return p
      const v: Seen = { digest, state: 'reserved', at: now() }
      s.set(key, v)
      await persist(key, v)
      return undefined
    })
    if (prior) {
      if (prior.digest !== digest) throw new HttpError(409, `id ${id} was already used for another message`)
      if (prior.state === 'done') return { status: 200, body: { duplicate: true } }
      if (prior.state === 'reserved') throw new HttpError(409, `message ${id} is being delivered now`)
      throw new HttpError(409, `message ${id}: the relay stopped during its delivery; whether it arrived is unknown`)
    }
    const settle = (state: 'released' | 'unknown') => seenOp(async (s) => {
      if (state === 'released') s.delete(key)
      else s.set(key, { digest, state, at: now() })
      await persist(key, state === 'released' ? { state } : { digest, state, at: now() })
    })
    let st: { exists: boolean; running: boolean } | undefined
    try {
      st = await status(cli, to)
    } catch (error) {
      await settle('released')
      throw error
    }
    if (!st?.exists || !st.running) {
      await settle('released')  // nothing was typed: the same id may be sent again
      throw new HttpError(409, `worker ${to} is not running`)
    }
    // From here the pane may have the text even when send fails (submit check, timeout):
    // a failure is an unknown outcome, and the id is never delivered a second time.
    let r: RunResult
    try {
      r = await deps.agentTmux([cli, 'send', to, `[relay ${peer.name || peer.node}/${from}] ${text}`], 120_000)
    } catch (error) {
      await settle('unknown')
      throw error
    }
    if (r.code !== 0) {
      await settle('unknown')
      // No stderr tail: send can echo the text, and the text never goes to a log or a reply.
      throw new HttpError(502, `send to ${to} failed (agent-tmux rc ${r.code}); the text may have arrived, so this id is spent: check the pane, then use a new id`)
    }
    await seenOp(async (s) => {
      const v: Seen = { digest, state: 'done', at: now() }
      s.set(key, v)
      await persist(key, v)
    })
    return { status: 202, body: { delivered: to } }
  }

  const onRoster = async (): Promise<Reply> => {
    let names: string[] = []
    try {
      names = (await readdir(deps.stateDir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.') && validName(d.name)).map((d) => d.name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // Status calls run ROSTER_PARALLEL at a time, each bounded, so a roster answers within the
    // client's deadline for up to ROSTER_PARALLEL workers; a slow one reads as unknown (null).
    const metas = (await Promise.all(names.sort().map(async (name) => ({ name, meta: await readMeta(name) })))).filter((x) => x.meta && nonEmpty(x.meta.cli))
    const states: Array<{ exists: boolean; running: boolean } | undefined> = new Array(metas.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(ROSTER_PARALLEL, metas.length) }, async () => {
      for (let i = next++; i < metas.length; i = next++) states[i] = await status(metas[i]!.meta!.cli as string, metas[i]!.name, ROSTER_STATUS_MS)
    }))
    const workers = metas.map(({ name, meta }, i) => ({ name, cli: meta!.cli, exec_mode: nonEmpty(meta!.exec_mode) ? meta!.exec_mode : null, launch_id: nonEmpty(meta!.launch_id) ? meta!.launch_id : null, remote_target: nonEmpty(meta!.remote_target) ? meta!.remote_target : null, exists: states[i]?.exists ?? null, running: states[i]?.running ?? null }))
    return { status: 200, body: { host: deps.self.name || hostname(), node: deps.self.node, workers } }
  }

  const ROUTES: Record<string, string> = { '/v1/health': 'GET', '/v1/roster': 'GET', '/v1/exit': 'POST', '/v1/message': 'POST' }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const ip = normalizePeer(req.socket.remoteAddress)
    const path = (req.url ?? '').split('?')[0] ?? ''
    const route = `${req.method} ${path}`
    let reply: Reply
    let peer: Identity | undefined
    try {
      peer = await identify(ip)
      authorize(peer)
      const method = ROUTES[path]
      if (!method) reply = { status: 404, body: { error: `no route ${path}` } }
      else if (method !== req.method) reply = { status: 405, body: { error: `${path} takes ${method}` } }
      else if (path === '/v1/health') reply = { status: 200, body: { host: deps.self.name || hostname(), node: deps.self.node, version: RELAY_VERSION } }
      else if (path === '/v1/roster') reply = await onRoster()
      else if (path === '/v1/exit') reply = await onExit(peer, await readBody(req))
      else reply = await onMessage(peer, await readBody(req))
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      reply = { status, body: { error: status === 500 ? 'internal error (see the relay pane)' : (error as Error).message } }
      if (status === 500) process.stderr.write(`tmux-agent-relay: ${route}: ${(error as Error).stack ?? error}\n`)
    }
    // The decision is on disk before the client hears it.
    await log({ route, peer: ip, node: peer?.node ?? null, status: reply.status, error: reply.status >= 400 ? (reply.body as { error?: string })?.error : undefined }).catch((e) => process.stderr.write(`tmux-agent-relay: log write failed: ${e}\n`))
    if (reply.status === 405) res.setHeader('Allow', ROUTES[path] ?? '')
    // A request we refused may still be sending its body; close it rather than read it.
    if (reply.status >= 400 && !req.complete) res.setHeader('Connection', 'close')
    res.statusCode = reply.status
    if (reply.body !== undefined) {
      res.setHeader('Content-Type', 'application/json')
      res.end(`${JSON.stringify(reply.body)}\n`)
    } else res.end()
  }

  /** Startup repair: a current-launch remote-exit.json whose remote.exit is missing or differs gets it rewritten. */
  const repair = async (): Promise<string[]> => {
    const fixed: string[] = []
    let names: string[] = []
    try {
      names = (await readdir(deps.stateDir)).filter((n) => validName(n) && !n.startsWith('.'))
    } catch {
      return fixed
    }
    for (const name of names) {
      const dir = await workerDir(name)
      const meta = await readMeta(name)
      if (!dir || !meta || !nonEmpty(meta.launch_id)) continue
      try {
        const rec = JSON.parse(await readFile(join(dir, 'remote-exit.json'), 'utf8')) as { launch_id?: unknown; code?: unknown }
        if (rec.launch_id !== meta.launch_id || typeof rec.code !== 'number') continue
        const want = `${rec.code}\n`
        const have = await readFile(join(dir, 'remote.exit'), 'utf8').catch(() => '')
        if (have !== want) {
          await writeAtomic(join(dir, 'remote.exit'), want)
          fixed.push(name)
        }
      } catch {
        continue
      }
    }
    return fixed
  }

  const server = createServer((req, res) => { void handle(req, res) })
  // Slow clients are cut: headers within 5 s, the whole request within 10 s.
  server.headersTimeout = 5_000
  server.requestTimeout = 10_000
  server.keepAliveTimeout = 2_000
  return { server, handle, repair }
}

// ---------------------------------------------------------------- CLI

const endpointPath = (stateDir: string) => join(stateDir, 'relay', 'endpoint.json')

type Endpoint = { url: string; pid: number; node: string; login: string; host: string; token: string }
export async function readEndpoint(stateDir: string): Promise<Endpoint | undefined> {
  try {
    return JSON.parse(await readFile(endpointPath(stateDir), 'utf8')) as Endpoint
  } catch {
    return undefined
  }
}

/** The relay at url answers health as the expected node (when given). */
async function healthy(url: string, node?: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const r = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return false
    const h = (await r.json()) as { node?: string }
    return node === undefined || h.node === node
  } catch {
    return false
  }
}

async function ownAddresses(): Promise<string[]> {
  const r = await run(tailscaleBin(), ['ip'], 5000)
  if (r.code !== 0) throw new Error(`cannot read this node's tailnet addresses (tailscale ip rc ${r.code}): ${r.stderr.trim()}`)
  return r.stdout.split('\n').map((s) => s.trim()).filter((s) => isIP(s))
}

function urlFor(host: string, port = DEFAULT_PORT): string {
  if (/^https?:\/\//.test(host)) return host.replace(/\/+$/, '')
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`
}

/**
 * Claim endpoint.json for this process (link: one winner). A claim whose relay does
 * not answer as its node is stale and is replaced once; a live one refuses.
 */
async function claimEndpoint(stateDir: string, ep: Endpoint): Promise<string | undefined> {
  await mkdir(join(stateDir, 'relay'), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await writeOnce(endpointPath(stateDir), `${JSON.stringify(ep)}\n`)) return undefined
    const old = await readEndpoint(stateDir)
    if (old && (await healthy(old.url, old.node))) return `a relay already serves ${old.url} (pid ${old.pid})`
    // Remove only the stale claim we just read: a newer claim is left alone.
    const again = await readEndpoint(stateDir)
    if (again?.token === old?.token) await unlink(endpointPath(stateDir)).catch(() => {})
  }
  return 'another relay claimed endpoint.json at the same time'
}

async function serve(argv: string[]): Promise<number> {
  let bind: string | undefined
  let port = DEFAULT_PORT
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bind') bind = argv[++i]
    else if (argv[i] === '--port') port = Number(argv[++i])
    else return usage(`unknown serve option ${argv[i]}`)
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return usage('--port must be 1..65535')
  const testWhois = !!process.env.TMUX_AGENT_RELAY_WHOIS
  let own: string[] = []
  try {
    if (!(testWhois && bind && LOOPBACK(bind))) own = await ownAddresses()
  } catch (error) {
    process.stderr.write(`tmux-agent-relay: ${(error as Error).message}\n`)
    return 4
  }
  bind ??= own.find((a) => isIP(a) === 4)
  if (!bind) {
    process.stderr.write('tmux-agent-relay: this node has no tailnet IPv4 address\n')
    return 4
  }
  const bad = checkBind(bind, own, testWhois)
  if (bad) return usage(bad)
  let self: Identity
  try {
    self = await systemWhois(bind)
  } catch (error) {
    process.stderr.write(`tmux-agent-relay: cannot identify this host on the tailnet: ${(error as Error).message}\n`)
    return 4
  }
  if (self.tagged) {
    process.stderr.write(`tmux-agent-relay: this node is tagged (${self.name}); a relay runs only on a user-owned device\n`)
    return 4
  }
  const stateDir = stateRoot()
  const url = urlFor(bind, port)
  const ep: Endpoint = { url, pid: process.pid, node: self.node, login: self.login, host: self.name, token: randomBytes(12).toString('hex') }
  const busy = await claimEndpoint(stateDir, ep)
  if (busy) {
    process.stderr.write(`tmux-agent-relay: ${busy}\n`)
    return 1
  }
  const release = async () => {
    const cur = await readEndpoint(stateDir)
    if (cur?.token === ep.token) await unlink(endpointPath(stateDir)).catch(() => {})
  }
  const relay = createRelay({ stateDir, whois: systemWhois, agentTmux: systemAgentTmux, self })
  const listening = await new Promise<string | undefined>((resolve) => {
    relay.server.once('error', (e) => resolve((e as Error).message))
    relay.server.listen(port, bind, () => resolve(undefined))
  })
  if (listening) {
    await release()
    process.stderr.write(`tmux-agent-relay: cannot listen on ${bind}:${port}: ${listening}\n`)
    return 1
  }
  // A racing start can have removed our claim while it replaced a stale one: put it back,
  // and refuse to serve when another relay owns this state dir.
  const cur = await readEndpoint(stateDir)
  if (!cur) await writeOnce(endpointPath(stateDir), `${JSON.stringify(ep)}\n`)
  const owner = await readEndpoint(stateDir)
  if (owner?.token !== ep.token) {
    relay.server.close()
    process.stderr.write(`tmux-agent-relay: another relay (pid ${owner?.pid}) owns ${endpointPath(stateDir)}; this one stops\n`)
    return 1
  }
  for (const name of await relay.repair()) process.stdout.write(`tmux-agent-relay: repaired remote.exit of ${name}\n`)
  process.stdout.write(`tmux-agent-relay: serving ${url} as ${self.name || self.node}\n`)
  const stop = async () => {
    relay.server.close()
    await release()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
  process.on('SIGHUP', () => void stop())
  return new Promise(() => {})
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function ensure(): Promise<number> {
  const stateDir = stateRoot()
  const ep = await readEndpoint(stateDir)
  if (ep && (await healthy(ep.url, ep.node))) {
    process.stdout.write(`${ep.url}\n`)
    return 0
  }
  if (ep && pidAlive(ep.pid)) {
    // Alive but slow (a whois refresh, a busy host): ask again, never kill it on one miss.
    for (let i = 0; i < 2; i++) {
      if (await healthy(ep.url, ep.node, 5000)) {
        process.stdout.write(`${ep.url}\n`)
        return 0
      }
    }
    process.stderr.write(`tmux-agent-relay: relay pid ${ep.pid} (${ep.url}) is alive but does not answer health; look at tmux session tmux-agent-relay, stop it, then run ensure again\n`)
    return 1
  }
  const self = fileURLToPath(new URL('../tmux-agent-relay', import.meta.url))
  const env = { ...process.env }
  delete env.TMUX
  delete env.TMUX_PANE
  const tmux = process.env.TMUX_AGENT_RELAY_TMUX || 'tmux'
  await run(tmux, ['kill-session', '-t', '=tmux-agent-relay'], 5000, env)
  const r = await run(tmux, ['new-session', '-d', '-s', 'tmux-agent-relay', '-e', `TMUX_AGENT_DIR=${stateDir}`, self, 'serve'], 5000, env)
  if (r.code !== 0) {
    process.stderr.write(`tmux-agent-relay: cannot start the relay session: ${r.stderr.trim()}\n`)
    return 1
  }
  for (let i = 0; i < 50; i++) {
    const cur = await readEndpoint(stateDir)
    if (cur && (await healthy(cur.url, cur.node, 1000))) {
      process.stdout.write(`${cur.url}\n`)
      return 0
    }
    await new Promise((r2) => setTimeout(r2, 100))
  }
  const pane = await run(tmux, ['capture-pane', '-p', '-t', '=tmux-agent-relay'], 5000, env)
  process.stderr.write(`tmux-agent-relay: the relay did not come up in 5 s. Its pane:\n${pane.stdout.trim()}\n`)
  return 1
}

/**
 * For `agent-tmux start-ssh --notify`: the live local relay and the tailnet device of
 * <host> (the effective ssh HostName). Prints one JSON line {url, node, addr}; with no
 * <host>, only checks the relay and prints {url}. Exit 2: no live relay here.
 * Exit 4: <host> is not one untagged device of this user.
 */
async function notifyTarget(argv: string[]): Promise<number> {
  const [host] = argv
  if (argv.length > 1) return usage('notify-target [<host>]')
  const ep = await readEndpoint(stateRoot())
  if (!ep || !nonEmpty(ep.login) || !(await healthy(ep.url, ep.node))) {
    process.stderr.write('tmux-agent-relay: no live relay on this host; run tmux-agent-relay ensure first\n')
    return 2
  }
  if (host === undefined) {
    process.stdout.write(`${JSON.stringify({ url: ep.url })}\n`)
    return 0
  }
  const fail = (why: string) => { process.stderr.write(`tmux-agent-relay: ${why}\n`); return 4 }
  let addr = host
  if (!isIP(host)) {
    const r = await run(tailscaleBin(), ['ip', '-4', host], 5000)
    const ips = r.stdout.split('\n').map((x) => x.trim()).filter((x) => isIP(x) === 4)
    if (r.code !== 0 || ips.length !== 1 || !ips[0]) return fail(`${host} is not one device on this tailnet (tailscale ip -4 rc ${r.code}: ${(r.stderr.trim() || r.stdout.trim()).split('\n').pop()})`)
    addr = ips[0]
  }
  let id: Identity
  try {
    id = await systemWhois(addr)
  } catch (error) {
    return fail(`cannot identify ${host} (${addr}) on the tailnet: ${(error as Error).message}`)
  }
  if (id.tagged) return fail(`${host} (${id.name}) is a tagged device; the relay refuses its pushes`)
  if (id.login !== ep.login) return fail(`${host} (${id.name}) belongs to another user; the relay refuses its pushes`)
  process.stdout.write(`${JSON.stringify({ url: ep.url, node: id.node, addr })}\n`)
  return 0
}

async function send(argv: string[]): Promise<number> {
  const [host, to, ...rest] = argv
  if (!host || !to || rest.length === 0) return usage('send <host|url> <worker> <text|->')
  let text = rest.join(' ')
  if (text === '-') {
    const chunks: Buffer[] = []
    for await (const c of process.stdin) chunks.push(c as Buffer)
    text = Buffer.concat(chunks).toString('utf8')
  }
  const from = process.env.TMUX_AGENT_RELAY_FROM || 'cli'
  const id = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`
  const url = `${urlFor(host)}/v1/message`
  let r: Response
  try {
    r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to, from, id, text }), signal: AbortSignal.timeout(130_000) })
  } catch (error) {
    process.stderr.write(`tmux-agent-relay: cannot reach ${url}: ${(error as Error).message}\n`)
    return 4
  }
  const body = await r.text()
  if (r.status >= 400) {
    process.stderr.write(`tmux-agent-relay: ${url} refused (${r.status}): ${body.trim()}\n`)
    return 3
  }
  process.stdout.write(r.status === 200 ? `duplicate id ${id} (already delivered)\n` : `delivered to ${to}\n`)
  return 0
}

type Peer = { host: string; url: string }
async function peers(): Promise<{ self?: Peer; others: Peer[] }> {
  const r = await run(tailscaleBin(), ['status', '--json'], 5000)
  if (r.code !== 0) throw new Error(`tailscale status failed (rc ${r.code}): ${r.stderr.trim()}`)
  type Node = { HostName?: string; DNSName?: string; Online?: boolean; Tags?: string[]; UserID?: number; TailscaleIPs?: string[] }
  const s = JSON.parse(r.stdout) as { Self?: Node; Peer?: Record<string, Node> }
  const v4 = (n: Node) => n.TailscaleIPs?.find((ip) => isIP(ip) === 4)
  const label = (n: Node) => (n.DNSName ?? '').split('.')[0] || n.HostName || '?'
  const mine = Object.values(s.Peer ?? {}).filter((n) => n.Online && !n.Tags?.length && s.Self?.UserID !== undefined && n.UserID === s.Self.UserID && v4(n))
  const self = s.Self && v4(s.Self) ? { host: label(s.Self), url: urlFor(v4(s.Self)!) } : undefined
  return { self, others: mine.map((n) => ({ host: label(n), url: urlFor(v4(n)!) })) }
}

type HostRow = { host: string; url: string; reachable: boolean; error_kind?: 'timeout' | 'connect' | 'auth' | 'http' | 'malformed'; error?: string; workers: unknown[] }
async function rosterOf(p: Peer): Promise<HostRow> {
  const fail = (error_kind: HostRow['error_kind'], error: string): HostRow => ({ host: p.host, url: p.url, reachable: false, error_kind, error, workers: [] })
  let r: Response
  try {
    r = await fetch(`${p.url}/v1/roster`, { signal: AbortSignal.timeout(ROSTER_CLIENT_MS) })
  } catch (error) {
    const e = error as Error
    return e.name === 'TimeoutError' || e.name === 'AbortError' ? fail('timeout', `no answer in ${ROSTER_CLIENT_MS / 1000} s`) : fail('connect', String((e as { cause?: Error }).cause?.message ?? e.message))
  }
  const text = await r.text().catch(() => '')
  if (r.status === 403) return fail('auth', text.trim())
  if (!r.ok) return fail('http', `HTTP ${r.status}: ${text.trim()}`)
  try {
    const body = JSON.parse(text) as { workers?: unknown }
    if (!Array.isArray(body.workers)) return fail('malformed', 'no workers list')
    return { host: p.host, url: p.url, reachable: true, workers: body.workers }
  } catch {
    return fail('malformed', 'not JSON')
  }
}

async function roster(argv: string[]): Promise<number> {
  const json = argv.includes('--json')
  let list: Peer[]
  try {
    const p = await peers()
    const ep = await readEndpoint(stateRoot())
    const self = p.self ? { ...p.self, url: ep?.url ?? p.self.url } : undefined
    list = [...(self ? [self] : []), ...p.others]
  } catch (error) {
    process.stderr.write(`tmux-agent-relay: ${(error as Error).message}\n`)
    return 4
  }
  // Every host at once, each bounded by its own deadline.
  const rows = await Promise.all(list.map(rosterOf))
  if (json) process.stdout.write(`${JSON.stringify({ hosts: rows })}\n`)
  else {
    for (const h of rows) {
      process.stdout.write(`${h.host}  ${h.url}  ${h.reachable ? `${h.workers.length} worker(s)` : `unreachable (${h.error_kind}): ${h.error}`}\n`)
      for (const w of h.workers as Array<{ name: string; cli: string; running: boolean | null; remote_target: string | null }>) {
        process.stdout.write(`  ${w.name}  ${w.cli}  ${w.running ? 'running' : w.running === false ? 'stopped' : 'unknown'}${w.remote_target ? `  → ${w.remote_target}` : ''}\n`)
      }
    }
  }
  return 0
}

function usage(error?: string): number {
  if (error) process.stderr.write(`tmux-agent-relay: ${error}\n`)
  process.stderr.write(`Usage:
  tmux-agent-relay serve [--bind <tailnet-ip>] [--port ${DEFAULT_PORT}]   foreground relay on this node's tailnet IP
  tmux-agent-relay ensure                                  start serve in tmux session tmux-agent-relay if none is live; print its URL
  tmux-agent-relay send <host|url> <worker> <text|->       tell a worker on <host> (MagicDNS name or tailnet IP)
  tmux-agent-relay roster [--json]                         workers on this host and on every online device of yours
  tmux-agent-relay notify-target [<host>]                  for start-ssh --notify: {url,node,addr} of the live relay and <host>
`)
  return error ? 2 : 0
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  if (cmd === 'serve') return serve(rest)
  if (cmd === 'ensure') return ensure()
  if (cmd === 'send') return send(rest)
  if (cmd === 'roster') return roster(rest)
  if (cmd === 'notify-target') return notifyTarget(rest)
  if (cmd === undefined || cmd === '-h' || cmd === '--help' || cmd === 'help') return usage()
  return usage(`unknown command ${cmd}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
