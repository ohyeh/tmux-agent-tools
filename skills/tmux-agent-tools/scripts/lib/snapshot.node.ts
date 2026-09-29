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
  type TmuxDispatch,
} from './workers.ts'

export type PanelOptions = {
  host?: Host
  session?: string
  width?: number
  now?: number
}

export type DashboardWorkerInfo = {
  name: string
  seq?: number
  owner?: string
  resultStatus?: string
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
  worker?: DashboardWorkerInfo
}

export type DashboardOptions = {
  host?: Host
  now?: number
  sessions?: DashboardSession[]
  sessionsFetcher?: (host: Host) => Promise<DashboardSession[]>
}

export type DashboardTotals = {
  running: number
  exited: number
  stopped: number
  total: number
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

/** Find the absolute path to tmux-agent-sessions or fallback to PATH. */
export async function findSessionsBin(host: Host): Promise<string> {
  const envBin = process.env.TMUX_AGENT_SESSIONS_BIN
  if (envBin && (await host.exists(envBin).catch(() => false))) return envBin
  const scriptDir = resolve(fileURLToPath(import.meta.url), '../..')
  const besideLib = resolve(scriptDir, 'tmux-agent-sessions')
  if (await host.exists(besideLib).catch(() => false)) return besideLib
  return 'tmux-agent-sessions'
}

/** Fetch fleet sessions via tmux-agent-sessions list --json. */
export async function fetchFleetSessions(host: Host): Promise<DashboardSession[]> {
  try {
    const sessionsBin = await findSessionsBin(host)
    const run = await host.run([sessionsBin, 'list', '--json'], (await host.cwd()) ?? process.cwd(), 10000)
    if (run.exitCode !== 0) return []
    const lines = run.stdout.split('\n').map(l => l.trim()).filter(Boolean)
    const sessions: DashboardSession[] = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as DashboardSession
        if (obj && typeof obj === 'object' && obj.schema_version === 1 && typeof obj.name === 'string') {
          sessions.push(obj)
        }
      } catch {}
    }
    return sessions
  } catch {
    return []
  }
}

/**
 * Fleet JSON snapshot for all sessions. Keeps the dashboard's public contract:
 * every live agent session from the sessions list, enriched with ledger worker
 * data from read-only scan(..., { claim: false }), plus stopped ledger workers.
 */
export async function dashboard(opts: DashboardOptions = {}): Promise<DashboardSnapshot> {
  const host = opts.host ?? nodeHost()
  const now = opts.now ?? (await host.now())

  // 1. Fleet sessions: truth of all live sessions on this machine
  const fleetSessions: DashboardSession[] = opts.sessions
    ? [...opts.sessions]
    : opts.sessionsFetcher
      ? await opts.sessionsFetcher(host)
      : await fetchFleetSessions(host)

  // 2. Scan ledger (read-only, claim: false)
  const root = await rootOf(host)
  const dispatchMap = new Map<string, { d: TmuxDispatch; resultStatus?: string }>()

  if (root) {
    const v3 = v3Of(root)
    if (await host.exists(v3).catch(() => false)) {
      const s = await scan(host, { claim: false })
      for (const d of s.visible) {
        let resultStatus: string | undefined
        if (d.resultPath && (await host.exists(d.resultPath).catch(() => false))) {
          const text = await readOrEmpty(host, d.resultPath)
          const raw = parseJson(text) as { status?: unknown; body?: { status?: unknown }; episode?: unknown } | undefined
          const st = typeof raw?.status === 'string' ? raw.status : typeof raw?.body?.status === 'string' ? raw.body.status : undefined
          if (st && TERMINAL.has(st) && episodeMatches(raw?.episode ?? (raw as any)?.body?.episode, d.seq)) {
            resultStatus = st
          }
        }
        dispatchMap.set(d.name, { d, resultStatus })
      }
    }
  }

  // 3. Enrich fleet sessions with matching ledger data
  const matchedLedgerNames = new Set<string>()
  const finalSessions: DashboardSession[] = []

  for (const sess of fleetSessions) {
    let match: { d: TmuxDispatch; resultStatus?: string } | undefined
    if (dispatchMap.has(sess.name)) {
      match = dispatchMap.get(sess.name)
    } else {
      for (const [name, info] of dispatchMap) {
        if (sess.session === `${info.d.profile}-cli-${name}` || sess.session.endsWith(`-${name}`)) {
          match = info
          break
        }
      }
    }

    if (match) {
      matchedLedgerNames.add(match.d.name)
      const workerInfo: DashboardWorkerInfo = {
        name: match.d.name,
        ...(match.d.seq !== undefined ? { seq: match.d.seq } : {}),
        ...(match.d.owner ? { owner: match.d.owner } : {}),
        ...(match.resultStatus ? { resultStatus: match.resultStatus } : {}),
      }
      finalSessions.push({
        ...sess,
        worker: workerInfo,
      })
    } else {
      finalSessions.push({ ...sess })
    }
  }

  // 4. Ledger workers with no live session may be listed as stopped
  for (const [name, info] of dispatchMap) {
    if (!matchedLedgerNames.has(name)) {
      const d = info.d
      const ageSec = d.since ? Math.max(0, Math.floor((now - d.since) / 1000)) : null
      const sessionName = `${d.profile}-cli-${d.name}`
      let exit_detected = false
      let exit_code: number | null = null
      let state: 'running' | 'exited' | 'stopped' = 'stopped'

      if (info.resultStatus) {
        if (info.resultStatus === 'success') {
          exit_code = 0
          state = 'stopped'
        } else {
          exit_detected = true
          exit_code = 1
          state = 'exited'
        }
      }

      finalSessions.push({
        schema_version: 1,
        tool: d.profile,
        name: d.name,
        session: sessionName,
        prefix: `${d.profile}-cli`,
        exists: false,
        running: false,
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
        worker: {
          name: d.name,
          ...(d.seq !== undefined ? { seq: d.seq } : {}),
          ...(d.owner ? { owner: d.owner } : {}),
          ...(info.resultStatus ? { resultStatus: info.resultStatus } : {}),
        },
      })
    }
  }

  const totals: DashboardTotals = {
    running: finalSessions.filter(s => s.state === 'running').length,
    exited: finalSessions.filter(s => s.state === 'exited').length,
    stopped: finalSessions.filter(s => s.state === 'stopped').length,
    total: finalSessions.length,
  }

  return {
    schema_version: 1,
    at: new Date(now).toISOString(),
    totals,
    sessions: finalSessions,
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
