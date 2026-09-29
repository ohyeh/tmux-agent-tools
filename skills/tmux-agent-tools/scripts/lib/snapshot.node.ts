// Read-only snapshot of workers-core: the panel status line and dashboard JSON
// (p0-contract.md §6, workers-core plan P4).
//
// Both views use scan(..., { claim: false }) / panelRows: they read the v5
// ledger without making claims, without acquiring action locks, and without
// writing acks. Observing mutates nothing.
//
// Usage: node snapshot.node.ts panel [session] [--session <session>] [--width <n>]
//        node snapshot.node.ts dashboard [--watch] [--interval <s>] [--count <n>]
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeHost } from './host.node.ts'
import {
  episodeMatches,
  hasSession,
  idOf,
  liveSessions,
  parseJson,
  readOrEmpty,
  rootOf,
  scan,
  TERMINAL,
  v3Of,
  type Host,
} from './workers.ts'

export type PanelOptions = {
  host?: Host
  session?: string
  width?: number
  now?: number
}

export type DashboardOptions = {
  host?: Host
  now?: number
}

export type DashboardTotals = {
  running: number
  exited: number
  stopped: number
  total: number
}

export type DashboardSession = {
  schema_version: 1
  tool: string
  name: string
  session: string
  prefix: string
  exists: boolean
  running: boolean
  exit_detected: boolean
  exit_code: number | null
  local_or_remote: string | null
  diagnostic: string | null
  last_capture_lines: string[]
  confirmation_detected: boolean
  blocked_reason: string | null
  blocked_evidence: string | null
  started_at: string | null
  last_change_at: string | null
  idle_seconds: number | null
  bytes_in_pane: number | null
  marker_seen: string[]
  state: 'running' | 'exited' | 'stopped'
  wrapper: string
  agent_name: string
  tmux_session: string
  cwd: string | null
  result_path: string
  created_at: string | null
  created_epoch: number | null
  age_seconds: number | null
  age: string | null
}

export type DashboardSnapshot = {
  schema_version: 1
  at: string
  totals: DashboardTotals
  sessions: DashboardSession[]
}

/** 45s / 12m / 3h. Floor of whole seconds; a since in the future is 0s. */
export function formatElapsed(since: number, now: number): string {
  const delta = Math.floor((now - since) / 1000)
  if (delta < 0) return '0s'
  if (delta < 60) return `${delta}s`
  if (delta < 3600) return `${Math.floor(delta / 60)}m`
  return `${Math.floor(delta / 3600)}h`
}

/**
 * Drop whole entries from the end. Never cut one mid-word; if nothing fits,
 * the line is "+N more".
 */
export function fitPanelLine(entries: readonly string[], width: number): string {
  const n = entries.length
  if (n === 0) return 'tmux-agent: no workers'
  for (let i = n; i >= 0; i--) {
    const dropped = n - i
    let line: string
    if (i === 0) {
      line = `+${dropped} more`
    } else {
      line = entries.slice(0, i).join(' ')
      if (dropped > 0) {
        line += ` +${dropped} more`
      }
    }
    if (line.length <= width) {
      return line
    }
  }
  return `+${n} more`
}

/**
 * One-line panel status for a commander session: active newest-first, then up to
 * three newest delivered. Built from read-only scan(..., { claim: false }).
 */
export async function panel(opts: PanelOptions = {}): Promise<string> {
  const host = opts.host ?? nodeHost({ owner: opts.session })
  const now = opts.now ?? (await host.now())
  const root = await rootOf(host)
  if (!root) return 'tmux-agent: no workers'
  const v3 = v3Of(root)
  if (!(await host.exists(v3).catch(() => false))) return 'tmux-agent: no workers'

  const s = await scan(host, { claim: false })
  const activeEntries: { since: number; entry: string }[] = []
  const deliveredEntries: { since: number; entry: string }[] = []

  for (const d of s.visible) {
    if (opts.session && d.owner && d.owner !== opts.session) continue
    if (opts.session && !d.owner) continue

    const id = idOf(d)
    const isDelivered = s.reported.has(id) || (d.seq !== undefined && s.acked.get(d.name)?.has('done'))

    let mark: string
    if (isDelivered) {
      mark = '✓ delivered'
    } else {
      let resultStatus: string | undefined
      if (d.resultPath && (await host.exists(d.resultPath).catch(() => false))) {
        const text = await readOrEmpty(host, d.resultPath)
        const raw = parseJson(text) as { status?: unknown; body?: { status?: unknown }; episode?: unknown } | undefined
        const st = typeof raw?.status === 'string' ? raw.status : typeof raw?.body?.status === 'string' ? raw.body.status : undefined
        if (st && TERMINAL.has(st) && episodeMatches(raw?.episode ?? (raw as any)?.body?.episode, d.seq)) {
          resultStatus = st
        }
      }
      if (resultStatus) {
        mark = resultStatus === 'success' ? '✓ success' : `✗ ${resultStatus}`
      } else {
        mark = '▶'
      }
    }

    const elapsedStr = formatElapsed(d.since, now)
    const entry = `${d.name} ${d.profile} ${elapsedStr} ${mark}`
    if (isDelivered) {
      deliveredEntries.push({ since: d.since, entry })
    } else {
      activeEntries.push({ since: d.since, entry })
    }
  }

  activeEntries.sort((a, b) => b.since - a.since)
  deliveredEntries.sort((a, b) => b.since - a.since)
  const chosenDelivered = deliveredEntries.slice(0, 3)

  const entries = [...activeEntries.map(e => e.entry), ...chosenDelivered.map(e => e.entry)]
  const width = opts.width ?? 120
  return fitPanelLine(entries, width)
}

/**
 * Fleet JSON snapshot for all sessions. Keeps the dashboard's public contract,
 * built from read-only scan(..., { claim: false }).
 */
export async function dashboard(opts: DashboardOptions = {}): Promise<DashboardSnapshot> {
  const host = opts.host ?? nodeHost()
  const now = opts.now ?? (await host.now())
  const root = await rootOf(host)
  if (!root) {
    return {
      schema_version: 1,
      at: new Date(now).toISOString(),
      totals: { running: 0, exited: 0, stopped: 0, total: 0 },
      sessions: [],
    }
  }
  const v3 = v3Of(root)
  if (!(await host.exists(v3).catch(() => false))) {
    return {
      schema_version: 1,
      at: new Date(now).toISOString(),
      totals: { running: 0, exited: 0, stopped: 0, total: 0 },
      sessions: [],
    }
  }

  const s = await scan(host, { claim: false })
  const alive = await liveSessions(host, root)
  const sessions: DashboardSession[] = []

  for (const d of s.visible) {
    const exists = hasSession(alive, d)
    let resultStatus: string | undefined
    let done = false
    if (d.resultPath && (await host.exists(d.resultPath).catch(() => false))) {
      const text = await readOrEmpty(host, d.resultPath)
      const raw = parseJson(text) as { status?: unknown; body?: { status?: unknown }; episode?: unknown } | undefined
      const st = typeof raw?.status === 'string' ? raw.status : typeof raw?.body?.status === 'string' ? raw.body.status : undefined
      if (st && TERMINAL.has(st) && episodeMatches(raw?.episode ?? (raw as any)?.body?.episode, d.seq)) {
        resultStatus = st
        done = true
      }
    }

    let running = false
    let exit_detected = false
    let exit_code: number | null = null
    let state: 'running' | 'exited' | 'stopped' = 'stopped'

    if (exists) {
      if (done) {
        if (resultStatus === 'success') {
          running = false
          exit_detected = false
          exit_code = 0
          state = 'stopped'
        } else {
          running = false
          exit_detected = true
          exit_code = 1
          state = 'exited'
        }
      } else {
        running = true
        exit_detected = false
        exit_code = null
        state = 'running'
      }
    } else {
      running = false
      if (done && resultStatus !== 'success') {
        exit_detected = true
        exit_code = 1
        state = 'exited'
      } else {
        exit_detected = false
        exit_code = done && resultStatus === 'success' ? 0 : null
        state = 'stopped'
      }
    }

    const ageSec = d.since ? Math.max(0, Math.floor((now - d.since) / 1000)) : null
    const sessionName = `${d.profile}-cli-${d.name}`
    sessions.push({
      schema_version: 1,
      tool: d.profile,
      name: d.name,
      session: sessionName,
      prefix: `${d.profile}-cli`,
      exists,
      running,
      exit_detected,
      exit_code,
      local_or_remote: 'local',
      diagnostic: null,
      last_capture_lines: [],
      confirmation_detected: false,
      blocked_reason: null,
      blocked_evidence: null,
      started_at: d.since ? new Date(d.since).toISOString() : null,
      last_change_at: null,
      idle_seconds: null,
      bytes_in_pane: null,
      marker_seen: [],
      state,
      wrapper: `agent-tmux ${d.profile}`,
      agent_name: d.name,
      tmux_session: sessionName,
      cwd: d.dir ?? null,
      result_path: d.resultPath ?? '',
      created_at: d.since ? new Date(d.since).toISOString() : null,
      created_epoch: d.since ? Math.floor(d.since / 1000) : null,
      age_seconds: ageSec,
      age: ageSec !== null ? `${ageSec}s` : null,
    })
  }

  sessions.sort((a, b) => (b.created_epoch ?? 0) - (a.created_epoch ?? 0))

  const totals: DashboardTotals = {
    running: sessions.filter(s => s.state === 'running').length,
    exited: sessions.filter(s => s.state === 'exited').length,
    stopped: sessions.filter(s => s.state === 'stopped').length,
    total: sessions.length,
  }

  return {
    schema_version: 1,
    at: new Date(now).toISOString(),
    totals,
    sessions,
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  if (cmd === 'panel') {
    let session: string | undefined
    let width: number | undefined
    for (let i = 3; i < process.argv.length; i++) {
      const arg = process.argv[i]!
      if (arg === '--session' && i + 1 < process.argv.length) {
        session = process.argv[++i]
      } else if (arg === '--width' && i + 1 < process.argv.length) {
        width = Number(process.argv[++i])
      } else if (!arg.startsWith('-') && !session) {
        session = arg
      }
    }
    const line = await panel({ session, width })
    process.stdout.write(`${line}\n`)
  } else if (cmd === 'dashboard') {
    let watch = false
    let interval = 2
    let count = 0
    for (let i = 3; i < process.argv.length; i++) {
      const arg = process.argv[i]!
      if (arg === '--watch') {
        watch = true
      } else if (arg === '--interval' && i + 1 < process.argv.length) {
        interval = Number(process.argv[++i]) || 2
      } else if (arg === '--count' && i + 1 < process.argv.length) {
        count = Number(process.argv[++i]) || 0
      }
    }
    if (!watch) {
      const snap = await dashboard()
      process.stdout.write(`${JSON.stringify(snap)}\n`)
    } else {
      let i = 0
      while (count === 0 || i < count) {
        const snap = await dashboard()
        process.stdout.write(`${JSON.stringify(snap)}\n`)
        i++
        if (count > 0 && i >= count) break
        await new Promise(r => setTimeout(r, interval * 1000))
      }
    }
  } else {
    process.stderr.write(
      'usage: node snapshot.node.ts panel [session] [--session <session>] [--width <n>] | dashboard [--watch] [--interval <s>] [--count <n>]\n',
    )
    process.exit(2)
  }
}

const isEntrypoint =
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1]}` ||
    fileURLToPath(import.meta.url) === resolve(process.argv[1]))

if (isEntrypoint) {
  await main()
}
