import type {
  EngineInterface,
  Register,
  RenderElement,
} from 'claude-code'
import {
  newGate,
  TOOL as CORE_TOOL,
  TELL_TOOL as CORE_TELL_TOOL,
  STOP_TOOL as CORE_STOP_TOOL,
  PEEK_TOOL as CORE_PEEK_TOOL,
  KEYS_TOOL as CORE_KEYS_TOOL,
  RELOAD_TOOL as CORE_RELOAD_TOOL,
  PANEL_TOOL as CORE_PANEL_TOOL,
  PEEK_DEFAULT,
  STATE_COLOR,
  PEEK_MAX,
  BASH_GATE_RE,
  HELP_RE,
  PANEL_KEY,
  POLL_MS,
  ORPHAN_MS,
  MIRROR_MS,
  MIRROR_ROWS,
  STOP_CONFIRM_MS,
  STOP_REPEAT_MS,
  CLEAR_ID,
  PANEL_ACCENT,
  MIRROR_MIN_ROWS,
  TERMINAL,
  NAME_RE,
  shq,
  type AssignInput,
  type TellInput,
  type StopInput,
  type PeekInput,
  type KeysInput,
  type Host,
  displayCells,
  padCells,
  agentTmuxShown,
  runnableCwd,
  wrapperCall,
  type Panel,
  type PanelRow,
  type Gate,
  parseJson,
  rootOf,
  readOrEmpty,
  type Finished,
  scan,
  outstanding,
  collectorDown,
  elapsed,
  panelRows,
  mirrorOf,
  mirrorProject,
  reconcile,
  type Outcome,
  setRows,
  othersLine,
  fitCells,
  rowGlyph,
  rowLabel,
  clearButtonLabel,
  stopButtonLabel,
  openTuiBeside,
  rememberPanel,
  tellWorker,
  stopAll,
  stopWorker,
  cancelEpisode,
  unlockWorker,
  peekWorker,
  peekProject,
  pressKeys,
  interruptWorker,
  heartbeat,
  reconcileOnce,
  assignWorker,
  resumeWorker,
  KEYS_ALLOWED,
  type TmuxDispatch as CoreDispatch,
  type TmuxStalled as CoreStalled,
} from '../skills/tmux-agent-tools/scripts/lib/workers.ts'
import type { TmuxDispatch, TmuxStalled } from '../types'

/**
 * The mod's own version, printed in the panel title so a session can tell which
 * code it is running. Observed 2026-09-18: a session reloaded after the 0.7.1
 * update and its panel still showed the 0.7.0 bug, and nothing on screen said
 * which code had drawn it. `test-version-sync-smoke` holds this to
 * `.claude-plugin/plugin.json`.
 */
const MOD_VERSION = '0.42.0'

/**
 * A cut stdout (over the engine's 4 MiB limit, 2.1.287 `isStdoutTruncated`) is not an answer:
 * the caller sees a rejection, as for a failed run, so a partial `tmux ls` never replaces the
 * fleet (Sol r9). The mod's captures are one screen, so this only fires on a broken child.
 */
async function wholeRun(argv: readonly string[], ran: Promise<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean }>) {
  const r = await ran
  if (r.isStdoutTruncated) throw new Error(`${argv[0]}: stdout over the 4 MiB output limit was cut; not an answer`)
  return r
}

// Tool names as literals here: the engine resolves a `tool.call` matcher only
// from a constant in this file (imported ones validate as `tool=?`). The core
// keeps its copy for the text it writes; this check fails typecheck on drift.
/** The core's log lines start with `tmux-agent: ` for the node hosts' log files; `$.ui.log` adds the plugin name itself. */
const engineLine = (text: string) => text.replace(/^tmux-agent: /, '')
const TOOL = 'mcp__tmux-agent__assign'
const TELL_TOOL = 'mcp__tmux-agent__tell'
const STOP_TOOL = 'mcp__tmux-agent__stop'
const PEEK_TOOL = 'mcp__tmux-agent__peek'
const KEYS_TOOL = 'mcp__tmux-agent__keys'
const RELOAD_TOOL = 'mcp__tmux-agent__reload'
const PANEL_TOOL = 'mcp__tmux-agent__panel'
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
// The $.tmux contract (types/index.d.ts) must stay self-contained, so it restates
// the record types; these two lines hold it to the core's definitions.
const TOOL_NAMES_MATCH_CORE: Same<
  [typeof TOOL, typeof TELL_TOOL, typeof STOP_TOOL, typeof PEEK_TOOL, typeof KEYS_TOOL, typeof RELOAD_TOOL, typeof PANEL_TOOL],
  [typeof CORE_TOOL, typeof CORE_TELL_TOOL, typeof CORE_STOP_TOOL, typeof CORE_PEEK_TOOL, typeof CORE_KEYS_TOOL, typeof CORE_RELOAD_TOOL, typeof CORE_PANEL_TOOL]
> = true
const CONTRACT_MATCHES_CORE: Same<[TmuxDispatch, TmuxStalled], [CoreDispatch, CoreStalled]> = true
void TOOL_NAMES_MATCH_CORE
void CONTRACT_MATCHES_CORE
const RUNTIME_LINE = /^\s*runtime:\s*tmux\/(\S+)\s*$/m
const WAITER_TYPE = 'tmux-agent:tmux-waiter'
const WAITER_SYSTEM = [
  'You wait for one tmux worker this plugin already launched. You do not do the task.',
  'You have Bash only. Do not edit files and do not talk to the worker.',
  'Follow the user message: one Bash poll at a time, then answer with the worker name, status, summary, and result path. Nothing else.',
].join('\n')

function stripRuntimeLine(prompt: string): string {
  return prompt.split('\n').filter(line => !RUNTIME_LINE.test(line)).join('\n')
}

/** A spawn's description, reduced to a worker base name. Empty or illegal → `worker`. */
function workerBase(description: string): string {
  const raw = description.replace(/[^A-Za-z0-9_.-]/g, '').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64)
  return NAME_RE.test(raw) ? raw : 'worker'
}

/**
 * The waiter's one user turn. Paths are absolute.
 * ponytail: the 60-minute cap is this instruction, not a timer in the mod. A waiter
 * that ignores it stays until the engine ends it; the collector then delivers with prompt.submit.
 */
function waiterPrompt(stateDir: string, name: string): string {
  const result = `${stateDir}/result.json`
  const exit = `${stateDir}/launch.exit`
  const log = `${stateDir}/mod-assign.log`
  // agent-tmux writes result.json as `pending` at launch: only a terminal status ends
  // the wait (live 2026-09-26 a waiter saw the placeholder and answered `pending`).
  const done = `grep -Eq '"status"[[:space:]]*:[[:space:]]*"(${[...TERMINAL].join('|')})"' ${shq(result)} 2>/dev/null`
  const poll = `for i in $(seq 1 108); do ${done} && break; [ -f ${shq(exit)} ] && [ "$(cat ${shq(exit)})" != 0 ] && break; sleep 5; done`
  return [
    `Wait for tmux worker "${name}".`,
    `Result file: ${result}`,
    `Launch exit file: ${exit}`,
    `Launch log: ${log}`,
    'Run ONE Bash call at a time. Each call must finish within 540 seconds. Set the Bash tool timeout to 600000.',
    'The command is:',
    poll,
    'Repeat that Bash call until result.json has a final status (success, failed, blocked, needs-input) or the launch failed. A `pending` status is not final. Stop after 60 minutes regardless.',
    `Then cat ${shq(result)}. If the launch failed (launch.exit exists and is not 0, or result.json is missing), cat the tail of ${shq(log)} instead.`,
    `Answer with only: worker name ${name}, status, summary, and result path ${result}. Nothing else.`,
  ].join('\n')
}
export const register: Register = on => {
  // Per activation, shared by every entry point below.
  const panel: Panel = { open: false, rows: [], all: [], showAll: false, generation: 0, internal: 0, internalMissLogged: false }
  /**
   * The bound world, kept at activation scope because the panel's command hook
   * needs it too and `engine.create` is the only place it can be built.
   */
  let world: Host | undefined
  /**
   * `$.agent.list` is on the session `$`, not on `engine.create`'s `$`
   * (`NoEngineInterface`). The panel's host is built at `engine.create`, so it
   * calls through this slot, which `session.start` fills.
   */
  let listAgents: Host['agentList'] = () => Promise.reject(new Error('tmux-agent: agent.list before the session binds'))
  let sessionCwd: string | undefined
  let sessionId: string | undefined
  /** The session id, asked again when the first read found none: no id, no owner (§3). */
  const idNow = async (ask: () => Promise<string>): Promise<string | undefined> => {
    sessionId ||= (await ask().catch(() => undefined)) || undefined
    return sessionId
  }
  /** False after a failed `$.agent.register`: the spawn hook then denies, as 0.9 did. */
  let waiterReady = false
  let waiterRegisterLogged = false
  const gate: Gate = newGate()
  /**
   * `/workers probe on|off|show`: which surfaces this session's band reaches, for the
   * desktop and mobile live runs (plan-app-surfaces A1). Off unless turned on; the
   * on/off state and epoch live in `$.store` per session id, the events in
   * `<state root>/<session id>/surfaces.jsonl`. `$.fs.write` replaces the whole file,
   * so every step runs on one chain, and a line is kept only once its write landed.
   */
  /** `lost`/`lastError` are kept with the epoch, so a hot reload cannot reset the loss count to 0. */
  type ProbeState = { on: boolean; epoch: string; start: number; lost?: number; lastError?: string }
  // ponytail: one epoch is capped at 1 MiB (the fs limit is 4 MiB per read/write) and a fresh
  // `on` drops older epochs; raise the cap if a live run ever needs more lines.
  const PROBE_MAX_BYTES = 1 << 20
  /** After a failed load, render and attach retry no sooner than this; a command always retries. */
  const PROBE_RETRY_MS = 10_000
  const probe = {
    sid: undefined as string | undefined,
    state: undefined as ProbeState | undefined,
    path: '',
    lines: [] as string[],
    rendered: new Set<string>(),
    /** Every lost observation of this epoch stays counted until a fresh `on`: absence is not proof while it is not 0. */
    errors: 0,
    lastError: '',
    loadError: '',
    loadFailedAt: -Infinity,
    /** Observations dropped while no load had succeeded; charged to the epoch once one does (if it is on). */
    missed: 0,
    /** Set when a loss could not be saved with the epoch: the count shown may be low. */
    lossUnsaved: false,
    chain: Promise.resolve() as Promise<unknown>,
  }
  const probeKey = (sid: string) => `probe:${sid}`
  /** Appends `step` to the chain; the chain itself never rejects. */
  const probeRun = <T>(step: () => Promise<T>): Promise<T> => {
    const done = probe.chain.then(step)
    probe.chain = done.catch(() => undefined)
    return done
  }
  const probeErr = (what: string, error: unknown) => `${what}: ${error instanceof Error ? error.name : typeof error}: ${String(error)}`
  /** The prerequisites, as a blocker sentence; nothing is guessed. */
  const probePrereq = async (): Promise<{ sid: string; root: string } | string> => {
    const w = world
    if (!w) return 'the mod did not bind (prerequisite)'
    if (!sessionId) return 'no session id yet (prerequisite)'
    const root = await rootOf(w)
    if (!root) return 'no state root: TMUX_AGENT_DIR, XDG_STATE_HOME and HOME are all unset (prerequisite)'
    return { sid: sessionId, root }
  }
  /**
   * Binds the probe to this session (again after a hot reload). Only a complete load binds;
   * a failure is a named storage blocker and stays retryable. A file that is there but cannot
   * be read is never taken as empty: rewriting it would erase its evidence.
   */
  const probeLoad = async (): Promise<string> => {
    const pre = await probePrereq()
    if (typeof pre === 'string') return pre
    if (probe.sid === pre.sid) return ''
    const w = world!
    const path = `${pre.root}/${pre.sid}/surfaces.jsonl`
    let saved: unknown
    let text: string
    try {
      saved = await w.storeGet(probeKey(pre.sid))
    } catch (error) {
      return probeErr('probe store read', error)
    }
    try {
      text = await w.read(path)
    } catch (error) {
      if (await w.exists(path).catch(() => true)) return probeErr(`probe read ${path}`, error)
      text = ''
    }
    const st = saved && typeof saved === 'object' ? (saved as ProbeState) : undefined
    const lines = text.split('\n').filter(Boolean)
    probe.sid = pre.sid
    probe.state = st
    probe.path = path
    probe.lines = lines
    probe.rendered = new Set(
      lines.flatMap(l => {
        const j = parseJson(l) as { epoch?: unknown; kind?: unknown; surface?: unknown } | undefined
        return j?.epoch === st?.epoch && j?.kind === 'render' && typeof j?.surface === 'string' ? [j.surface] : []
      }),
    )
    probe.errors = st?.lost ?? 0
    probe.lastError = st?.lastError ?? ''
    if (probe.missed && st?.on) await probeLost(`probe load failed while observing (${probe.missed} dropped): ${probe.loadError}`, probe.missed)
    probe.missed = 0
    probe.loadError = ''
    return ''
  }
  /** Loads for a hook caller: a failed load is retried after PROBE_RETRY_MS, not on every render. */
  const probeLoadQuiet = async (): Promise<boolean> => {
    const w = world
    if (probe.loadError && w && (await w.now()) - probe.loadFailedAt < PROBE_RETRY_MS) {
      probe.missed += 1
      return false
    }
    const blocker = await probeLoad()
    if (!blocker) return true
    probe.missed += 1
    probe.loadError = blocker
    probe.loadFailedAt = w ? await w.now() : 0
    return false
  }
  /** Counts `n` lost observations and saves the count with the epoch; a failed save is shown, never hidden. */
  const probeLost = async (error: string, n = 1): Promise<void> => {
    probe.errors += n
    probe.lastError = error
    const w = world
    if (!w || !probe.sid || !probe.state) return
    probe.state = { ...probe.state, lost: probe.errors, lastError: error }
    try {
      await w.storeSet(probeKey(probe.sid), probe.state)
    } catch {
      probe.lossUnsaved = true
    }
  }
  /** One event, when the probe is on; `once` de-dups within the epoch (a render per surface). */
  const probeNote = (fields: Record<string, unknown>, once?: string): Promise<void> =>
    probeRun(async () => {
      if (!(await probeLoadQuiet())) return
      const w = world
      if (!w || !probe.state?.on || !probe.path) return
      if (once && probe.rendered.has(once)) return
      const line = JSON.stringify({ epoch: probe.state.epoch, at: new Date(await w.now()).toISOString(), ...fields })
      const text = `${[...probe.lines, line].join('\n')}\n`
      if (new TextEncoder().encode(text).length > PROBE_MAX_BYTES) {
        await probeLost(`probe capacity: this epoch is over ${PROBE_MAX_BYTES} bytes; /workers probe on starts a fresh one`)
        return
      }
      try {
        await w.write(probe.path, text)
        probe.lines.push(line)
        if (once) probe.rendered.add(once)
      } catch (error) {
        await probeLost(probeErr('probe write', error))
      }
    })
  /** What `show` prints: the latest epoch's summary (an absence verdict reads this), then its last 20 lines. */
  const probeShow = (): string => {
    const st = probe.state
    const mine = probe.lines.filter(l => (parseJson(l) as { epoch?: unknown } | undefined)?.epoch === st?.epoch)
    const count = new Map<string, number>()
    for (const l of mine) {
      const j = parseJson(l) as { kind?: unknown; surface?: unknown } | undefined
      const k = `${String(j?.kind)}${typeof j?.surface === 'string' ? `:${j.surface}` : ''}`
      count.set(k, (count.get(k) ?? 0) + 1)
    }
    const summary = st ? [...count].map(([k, n]) => `${k}×${n}`).join(' · ') || 'nothing yet' : ''
    return [
      `probe: session ${probe.sid ?? '(none)'} · ${st?.on ? 'on' : 'off'} · epoch ${st?.epoch ?? '(none)'}` +
        `${st ? ` since ${new Date(st.start).toISOString()}` : ''} · mod ${MOD_VERSION}`,
      `lost observations this epoch: ${probe.errors}${probe.lossUnsaved ? '+ (a loss could not be saved; the count may be low)' : ''}` +
        `${probe.errors || probe.lossUnsaved ? ` (last: ${probe.lastError}) — an absence below is not proof` : ''}`,
      ...(st ? [`this epoch, all lines: ${summary}`] : []),
      `file: ${probe.path || '(none)'}`,
      ...(st ? mine.slice(-20) : []),
    ].join('\n')
  }

  on('engine.create', async ($, e, next) => {
    const beneath = await next(e)
    const host: Host = {
      now: () => beneath.clock.now(),
      owner: () => sessionId,
      cwd: () => sessionCwd,
      envTmuxAgentDir: () => beneath.env.get('TMUX_AGENT_DIR'),
      envXdgStateHome: () => beneath.env.get('XDG_STATE_HOME'),
      envHome: () => beneath.env.get('HOME'),
      envPath: () => beneath.env.get('PATH'),
      read: path => beneath.fs.read(path),
      write: (path, text) => beneath.fs.write(path, text),
      stat: path => beneath.fs.stat(path),
      exists: path => beneath.fs.exists(path),
      list: path => beneath.fs.list(path),
      storeGet: key => beneath.store.get(key),
      storeSet: (key, value) => beneath.store.set(key, value),
      storeKeys: () => beneath.store.keys(),
      storeDelete: key => beneath.store.delete(key),
      submit: text => beneath.prompt.submit({ text }),
      toast: text => beneath.ui.toast(text),
      log: text => beneath.ui.log(engineLine(text)),
      run: async (argv, cwd, timeoutMs) => {
        const call = await wrapperCall(host, argv)
        return wholeRun(call.argv, beneath.process.run(call.argv, { cwd: await runnableCwd(host, cwd), timeoutMs, ...(call.env ? { env: call.env } : {}) }))
      },
      agentList: () => listAgents(),
    }
    world = host
    // A hot reload re-runs engine.create but not session.start, so the ids
    // would stay unset until the next session; ask the engine here as well.
    void beneath.session.id().then(id => { sessionId ||= id }).catch(() => undefined)
    void beneath.session.cwd().then(cwd => { sessionCwd ||= cwd }).catch(() => undefined)
    const tmux: EngineInterface['tmux'] = {
      outstanding: () => outstanding(host),
      // The early id read above can land before the engine answers it (a hot reload,
      // a harness that binds hooks late): ask again, since no id means no collecting (§3).
      reconcile: async () => {
        await idNow(() => beneath.session.id())
        return reconcileOnce(host, gate)
      },
      stalled: async () => [...gate.stalled.values()],
    }
    return { ...beneath, tmux }
  })

  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    // The transcript's name. A missing id stays missing: assign and tell refuse,
    // and `idNow` stores the real id when the engine answers (§3). Never mint `local-*`.
    sessionId = (await $.session.id().catch(() => undefined)) || undefined
    listAgents = () => $.agent.list()
    try {
      await $.agent.register({
        name: 'tmux-waiter',
        description: 'tmux-agent internal: waits for one tmux worker result. The mod dispatches it for a `runtime: tmux/<profile>` brief; never call it directly',
        prompt: WAITER_SYSTEM,
        tools: ['Bash'],
        model: 'haiku',
        omitClaudeMd: true,
      })
      waiterReady = true
    } catch (error) {
      if (!waiterRegisterLogged) {
        waiterRegisterLogged = true
        const kind = error instanceof Error ? error.name : typeof error
        try {
          await $.ui.log(`tmux-waiter register failed: ${kind}: ${String(error)}`)
        } catch {
          // The spawn hook still denies. A surface with no log does not take the session down.
        }
      }
    }
    const host: Host = {
      now: () => $.clock.now(),
      owner: () => sessionId,
      cwd: () => sessionCwd,
      envTmuxAgentDir: () => $.env.get('TMUX_AGENT_DIR'),
      envXdgStateHome: () => $.env.get('XDG_STATE_HOME'),
      envHome: () => $.env.get('HOME'),
      envPath: () => $.env.get('PATH'),
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      stat: path => $.fs.stat(path),
      exists: path => $.fs.exists(path),
      list: path => $.fs.list(path),
      storeGet: key => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
      storeKeys: () => $.store.keys(),
      storeDelete: key => $.store.delete(key),
      submit: text => $.prompt.submit({ text }),
      toast: text => $.ui.toast(text),
      log: text => $.ui.log(engineLine(text)),
      run: async (argv, cwd, timeoutMs) => {
        const call = await wrapperCall(host, argv)
        return wholeRun(call.argv, $.process.run(call.argv, { cwd: await runnableCwd(host, cwd), timeoutMs, ...(call.env ? { env: call.env } : {}) }))
      },
      agentList: () => listAgents(),
    }

    await $.command.register({
      name: 'workers',
      description: 'Show or hide the workers panel; /workers N selects row N, /workers stop <name>, /workers tell <name> <text>, /workers cancel <name> <seq>, /workers unlock <name> [confirm], /workers probe on|off|show, /workers hide',
    })

    await $.tool.register({
      name: 'assign',
      description:
        'Dispatch a brief to an agent-tmux worker and treat it as a teammate. profile is any agent-tmux ' +
        'cli or profile name: codex, agy, cursor, grok, claude, or a custom ~/.config/agent-tmux/profiles/<name>.conf ' +
        '(e.g. a second claude started with its own --settings file through a provider gateway). Returns at once; ' +
        'the collector session reconciles result.json and submits a prompt when the worker finishes. ' +
        'Follow up with mcp__tmux-agent__tell, dismiss with mcp__tmux-agent__stop. ' +
        'brief must contain GOAL, ACCEPTANCE and REPORT sections.',
      inputSchema: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'agent-tmux profile or cli name' },
          name: {
            type: 'string',
            description: 'worker base name; a 4-character suffix is added (e.g. review → review-k3x9) — use the name the receipt returns for every later call',
          },
          dir: { type: 'string', description: 'absolute working directory for the worker' },
          brief: {
            type: 'string',
            description:
              'the task, with GOAL, ACCEPTANCE and REPORT sections; the wrapper prepends the result.json path and scope instructions, so do not repeat them',
          },
        },
        required: ['profile', 'name', 'dir', 'brief'],
      },
    })

    await $.tool.register({
      name: 'tell',
      description:
        'Send a follow-up to a worker this session dispatched (the name assign returned, or a /workers row). ' +
        'Starts a new episode: its result.json is reset and the collector wakes you again when the worker ' +
        'answers. Use it to give a teammate its next task or a correction.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'worker name as dispatched (e.g. review-k3x9)' },
          text: { type: 'string', description: 'the message; multi-line is fine' },
        },
        required: ['name', 'text'],
      },
    })

    await $.tool.register({
      name: 'stop',
      description:
        'Stop a worker this session dispatched and drop it from the panel. Nothing further will be ' +
        "delivered for it; read its result.json first if you still need it. `all: true` stops every worker " +
        'of this project that still has a tmux session — the ones you forgot to close.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'worker name as dispatched' },
          all: { type: 'boolean', description: 'stop every live worker of this project instead of one' },
        },
      },
    })

    await $.tool.register({
      name: 'peek',
      description:
        'Look at a worker mid-flight, or at a project tmux session currently listed on /workers: ' +
        'the last N lines of its pane (ANSI stripped). A worker also reports running, idle, gone, or needs input. ' +
        'One call, one snapshot; do not loop on it — the collector wakes this session when a worker finishes. ' +
        'A name that is neither a worker nor a current project row is refused.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'worker name as dispatched' },
          lines: { type: 'number', description: `pane lines to return (default ${PEEK_DEFAULT}, max ${PEEK_MAX})` },
        },
        required: ['name'],
      },
    })

    await $.tool.register({
      name: 'reload',
      description:
        'Reload this session\'s plugins, so an update already installed with `claude plugin update` takes ' +
        'effect without a restart. Runs /reload-plugins once the current turn ends; the panel title then ' +
        'shows the new mod version.',
      inputSchema: { type: 'object', properties: {} },
    })

    await $.tool.register({
      name: 'panel',
      description:
        'Open or close the workers panel above the prompt, the same as the person typing /workers. ' +
        'Open it after assigning workers so the person can watch them.',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['open', 'close'], description: 'default open' } },
      },
    })

    await $.tool.register({
      name: 'keys',
      description:
        'Press keys in a worker pane to answer a trust/permission/login dialog it is parked on. ' +
        `Allowed: ${[...KEYS_ALLOWED].join(' ')}. Peek first; keys is not how you talk to a worker — tell is.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'worker name as dispatched' },
          keys: { type: 'array', items: { type: 'string' }, description: 'tmux key names, pressed in order' },
        },
        required: ['name', 'keys'],
      },
    })

    // The clock is NOT gated on a pane being open: waking a session nobody is
    // watching is the whole point, and `plugin-authoring` ("Work that outlives a
    // dispatch") names session.start + clock.every + prompt.submit as the way.
    //
    // Every session collects (0.7.0): a session that can dispatch but never
    // collects hands the result back to the person, which is the gap this mod
    // exists to close. Per-session acks (0.5.2) and owner-only delivery (0.6.0)
    // keep several collectors from duplicating.
    $.clock.every(POLL_MS, async () => {
      await reconcileOnce(host, gate)
    })
    // The heartbeat on its own clock: reconcileOnce joins an in-flight pass, so
    // one pass slower than ORPHAN_MS (stall probes over a busy fleet) stopped the
    // beat, and a second session in this repo adopted — and took the delivery of
    // — workers this live session dispatched (observed 2026-09-26). A paused
    // collector still goes quiet on purpose, so its workers can be adopted.
    $.clock.every(POLL_MS, async () => {
      if (!gate.paused) await heartbeat(host, gate)
    })

    // Catch up on whatever finished while no collector was alive, through the same
    // gate the tick uses: a slow startup scan is joined, never duplicated.
    // The startup scan does NOT probe for stalls: `session.start` is on the
    // engine's hook budget, and a sweep of subprocesses is exactly what overruns
    // it. The tick picks them up ten seconds later, which is soon enough for a
    // condition measured in quarter-hours.
    await reconcileOnce(host, gate, false)

    // A reload closed this session's panel (the module's state went with it):
    // open it again, through the same code /workers runs.
    const open = await host.storeGet(PANEL_KEY).catch((error: unknown) => {
      host.log(`tmux-agent: panel state unreadable: ${String(error)}`)
      return undefined
    })
    if (Array.isArray(open) && open.includes(sessionId)) {
      $.clock.after(0, async () => {
        if (panel.open) return
        const failed = await openPanel(
          () => void $.ui.invalidate('ui.render'),
          (ms, fn) => $.clock.every(ms, fn),
        ).catch((err: unknown) => String(err))
        if (failed) host.log(`tmux-agent: reopening the panel failed: ${failed}`)
      })
    }

    return next(e)
  })

  /**
   * One action from the panel: runs against the bound world, tells the person
   * how it went in a toast, and redraws. The panel never awaits it — a render
   * hook has no business waiting on a subprocess.
   */
  const act = async (what: string, fn: (host: Host) => Promise<Outcome>) => {
    const host = world
    if (!host) return
    let out: Outcome
    try {
      out = await fn(host)
    } catch (error) {
      out = { ok: false, text: String(error) }
    }
    host.toast(`tmux-agent: ${what} — ${out.ok ? 'ok' : 'FAILED'}: ${out.text.slice(0, 200)}`)
    if (!out.ok) host.log(`tmux-agent: ${what} failed: ${out.text}`)
    panel.mirror = undefined
  }

  // The band above the prompt, NOT a `Pane`. Observed 2026-09-17 on two
  // machines: a Pane docks to the right of the transcript from 110 columns
  // (fullscreen layout) and sits inline under `CLAUDE_CODE_NO_FLICKER=0` or in
  // tmux — the same panel in two places depending on the monitor. Worse, its
  // Buttons only take a mouse click in the fullscreen layout and a `hotkey` is
  // honoured nowhere but the band (claude-code.d.ts: ButtonProps.hotkey), so the
  // inline Pane could not be pressed at all. The band is always above the
  // prompt, in both layouts, and its Buttons press on a digit from an empty
  // composer or a letter while the band is focused (ctrl+x tab).
  // Observe only (no redraw): the probe's proof that a desktop or phone client joined.
  on('session.attach', async ($, e, next) => {
    void probeNote({ kind: 'attach', surface: e.surface, clientId: e.clientId })
    return next(e)
  })
  on('session.detach', async ($, e, next) => {
    void probeNote({ kind: 'detach', surface: e.surface, clientId: e.clientId, reason: e.reason })
    return next(e)
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Before the closed-panel return: a closed band still proves the site is raised.
    // Queued, never awaited: the draw and its one `next(e)` do not wait on a write.
    if (probe.state?.on || probe.sid !== sessionId) {
      void probeNote(
        { kind: 'render', surface: e.surface, bodyColumns: e.props.bodyColumns, maxRows: e.props.maxRows, panelOpen: panel.open },
        e.surface,
      )
    }
    // Closed, or a survey holds the band: whatever the plugins below draw.
    if (!panel.open || e.props.hasSurvey) return next(e)
    const below = await next(e)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // AbovePrompt is raised on the terminal and desktop only (claude-code.d.ts,
    // 2.1.287); both tables carry Input. The guard keeps the union type honest
    // without a cast.
    const Input = 'Input' in elements ? elements.Input : undefined
    const width = e.props.bodyColumns
    // Rows the band may take, less the list: the mirror is the tail that fits.
    // Kept under `maxRows` on purpose: a tree taller than the band scrolls and
    // "a bare digit arms none of its Buttons' hotkeys" (claude-code.d.ts:
    // AbovePrompt.maxRows) — overflow would take the row hotkeys with it.
    const now = await $.clock.now()
    const down = collectorDown(gate)
    // A stop asks twice: one stray press (a letter with the band focused)
    // stopped a worker in the 2026-09-25 live probe.
    const pressTwice = async (id: string, fire: () => void) => {
      const at = await $.clock.now()
      const was = panel.armedStop
      // A second press, not a held key's repeat: the confirm needs a beat.
      if (was?.id === id && at < was.until && at - was.from >= STOP_REPEAT_MS) {
        panel.armedStop = undefined
        fire()
        return
      }
      // A repeat inside the beat slides it: a held key never confirms.
      if (was?.id === id && at < was.until) {
        panel.armedStop = { ...was, from: at }
        return
      }
      panel.armedStop = { id, from: at, until: at + STOP_CONFIRM_MS }
      $.ui.invalidate('ui.render')
    }
    // Every row the tree draws is counted here, so it stays inside `maxRows`: a
    // taller tree scrolls, and a scrolling band arms none of its digit hotkeys.
    // Goals show only in the overview (no row selected); a selected row adds its
    // tell line and a one-line summary. A fleet longer than the band is cut, the
    // selected row kept, with a "+N more" line.
    const others = othersLine(panel.all)
    const selIndex = panel.rows.findIndex(r => r.id === panel.selected)
    const selected = selIndex >= 0 ? panel.rows[selIndex] : undefined
    const layout = (sel: PanelRow | undefined) => {
      // Selected: its tell line, its summary, and one row for the mirror's rule
      // or the "too short to mirror" line, whichever is drawn.
      const fixed = 1 + (panel.adding ? 1 : 0) + (down ? 1 : 0) + (others ? 1 : 0) + (sel ? 2 + (sel.summary ? 1 : 0) : 0) + (panel.rows.length ? 0 : 1)
      // A selection is for watching that worker: the list gives way to the
      // mirror's floor (and its hint line) before it gives way to nothing.
      const reserve = sel ? 1 + MIRROR_MIN_ROWS : 0
      const fitsAt = (perRow: number, n: number) =>
        fixed + n * perRow + (n < panel.rows.length ? 1 : 0) + reserve <= e.props.maxRows
      // Each goal line costs a worker row: goals are drawn only when every
      // worker fits with its goal, so they never push a worker off the band.
      const goals = !sel && fitsAt(2, panel.rows.length)
      const perRow = goals ? 2 : 1
      let shown = panel.rows.length
      while (shown > 1 && !fitsAt(perRow, shown)) shown -= 1
      return { shown, goals, used: fixed + shown * perRow + (shown < panel.rows.length ? 1 : 0) }
    }
    const { shown: shownRows, goals, used } = layout(selected)
    const first = selected ? Math.max(0, Math.min(selIndex - shownRows + 1, panel.rows.length - shownRows)) : 0
    const hidden = panel.rows.length - shownRows
    // The mirror is sized for the layout a selection draws — before the press
    // too, since the clock captures on the height the last render allowed. It
    // takes what is left after its "see it whole" line.
    const room = e.props.maxRows - (selected ? used : layout(panel.rows[0]).used) - 1
    // 0 means "do not mirror", which is the honest answer for a surface that
    // cannot fit even one line of work under the target's own chrome.
    panel.rows_available = room >= MIRROR_MIN_ROWS ? Math.min(MIRROR_ROWS * 2, room) : 0
    const children: RenderElement[] = []
    // Smaller than the least full layout (one row and its controls): only the
    // title bar and, room permitting, what still works — the typed commands.
    // Overflowing would scroll the band and disarm the digits (astra, 34e2a1e:
    // maxRows 3 drew 4).
    const compact = used > e.props.maxRows
    if (compact) panel.rows_available = 0

    if (down && !compact) children.push(Text({ dimColor: true, wrap: 'truncate-end', children: `⚠ ${down}` }))
    // The header names the keys: this is the only place a person learns them.
    // `r`/`x`/`q` press only while the band is focused; digits from an empty
    // prompt. Manual re-read, for when the clock's last answer looks wrong.
    // The hint names the slash commands: they work in any terminal, where a
    // letter hotkey needs the band focused and ctrl+x tab may never arrive.
    // The title, `[ refresh ]` and `[ hide ]`; the hint is padded so the bar
    // spans the row up to the engine's own `[-]` collapse control, which the band
    // draws over its last cells (observed live: it covered `[ hide ]`).
    const tmuxRunning = panel.rows.filter(r => !r.project && !r.terminal).length
    // Which session this panel belongs to, so a row's `@<id>` reads against it
    // (asked 2026-09-26: the 專案 count told less than whose panel it is; the
    // project rows still say 專案 themselves).
    const me = world?.owner()
    const counts = `${me ? `@${me.slice(0, 8)} · ` : ''}tmux ${tmuxRunning} · 內部 ${panel.internal}`
    // `[ clear ]` stops every worker this mod started; drawn only when there is one.
    const clearable = panel.rows.some(r => !r.project)
    const clearArmed = panel.armedStop?.id === CLEAR_ID && now < panel.armedStop.until
    const clearLabel = `✕ ${clearButtonLabel(clearArmed)}`
    // One glyph per action, every glyph one cell (East Asian Width N, so a CJK
    // terminal does not widen it). What goes first when the bar is short: the
    // words beside a glyph, then the name; the counts never.
    const cellsOf = (words: boolean) =>
      displayCells(words ? '[ + new ][ ↻ refresh ][ ⧉ tui ]' : '[ + ][ ↻ ][ ⧉ ]') +
      (clearable ? displayCells(`[ ${clearLabel} ]`) : 0) +
      displayCells('[ hide ]') +
      displayCells(' [-]')
    const full = ` workers v${MOD_VERSION} · ${counts} `
    const words = displayCells(full) + cellsOf(true) <= width
    const addLabel = words ? '+ new' : '+'
    const refreshLabel = words ? '↻ refresh' : '↻'
    const tuiLabel = words ? '⧉ tui' : '⧉'
    const buttonCells = cellsOf(words)
    const titleText = displayCells(full) + buttonCells <= width ? full : ` ${counts} `
    const titleCells = displayCells(titleText) + buttonCells
    const hintRoom = Math.max(0, width - titleCells)
    // Whole pieces, dropped from the right: a sliced hint ended mid-command
    // ("· /workers stop <" at 72 columns).
    let hint = ''
    for (const piece of ['  /workers stop <name>', ' · /workers tell <name> <text>']) {
      if (displayCells(hint) + displayCells(piece) + 1 > hintRoom) break
      hint += piece
    }
    // A coloured title bar marks where the panel starts, so its rows do not read
    // as the session's own output. Background, not a border: a border costs two
    // of the band's few rows, and the mirror needs them.
    children.push(
      Box({
        flexDirection: 'row',
        backgroundColor: PANEL_ACCENT,
        children: [
          Text({ bold: true, color: 'black', backgroundColor: PANEL_ACCENT, children: titleText }),
          // Resume a CLI session by id as a teammate; the field is one row below.
          Button({
            key: 'add',
            label: addLabel,
            hotkey: 'n',
            onPress: () => {
              panel.adding = !panel.adding
              $.ui.invalidate('ui.render')
            },
          }),
          // Refresh returns to the overview: an open row closes, as pressing the row
          // again would (asked 2026-09-29), and a pending confirm is dropped.
          Button({
            key: 'refresh',
            label: refreshLabel,
            hotkey: 'r',
            onPress: () => {
              panel.selected = undefined
              panel.mirror = undefined
              panel.armedStop = undefined
              $.ui.invalidate('ui.render')
              void panel.refresh?.()
            },
          }),
          // The full-screen TUI beside this pane (plan P7); outside tmux the toast
          // names the command to run in another terminal.
          Button({
            key: 'tui',
            label: tuiLabel,
            hotkey: 't',
            onPress: () => void act('tui', async host => openTuiBeside(host, await $.env.get('TMUX_PANE'))),
          }),
          ...(clearable
            ? [
                Button({
                  key: 'clear',
                  label: clearLabel,
                  hotkey: 'c',
                  onPress: () =>
                    pressTwice(CLEAR_ID, () =>
                      void act('clear', async host => {
                        const out = await stopAll(host, gate)
                        void panel.refresh?.()
                        return out
                      }),
                    ),
                }),
              ]
            : []),
          Text({ color: 'black', backgroundColor: PANEL_ACCENT, wrap: 'truncate-end', children: padCells(hint, hintRoom) }),
          // Last and apart from refresh: hiding is undone by /workers, but it should
          // not sit one key away from the button people press most.
          Button({ key: 'close', label: 'hide', hotkey: 'q', dimColor: true, onPress: () => void panel.close?.() }),
        ],
      }),
    )

    if (compact) {
      if (e.props.maxRows >= 2) {
        children.push(
          Text({
            dimColor: true,
            wrap: 'truncate-end',
            children: `${panel.rows.length} worker(s); band too short (${e.props.maxRows} rows) — /workers N · /workers stop <name> · /workers tell <name> <text>`,
          }),
        )
      }
      return Box({ flexDirection: 'column', children: [below, ...children] })
    }
    // Enter resumes; a refusal leaves the field open with a toast saying why;
    // Enter on nothing closes it (grok-bot-watch's `[ + ]`).
    if (panel.adding && Input) {
      children.push(
        Input({
          key: 'resume-input',
          label: '  + ',
          placeholder: '[profile] <session-id> [name]',
          submitLabel: 'resume',
          autoFocus: true,
          onSubmit: (value: string) => {
            if (!value.trim()) {
              panel.adding = false
              $.ui.invalidate('ui.render')
              return
            }
            void act('resume', async host => {
              const out = await resumeWorker(host, value)
              if (out.ok) {
                panel.adding = false
                void panel.refresh?.()
              }
              return out
            })
          },
        }),
      )
    }
    if (!panel.rows.length) {
      children.push(Text({ dimColor: true, children: 'No workers outstanding.' }))
    }
    for (const [i, r] of panel.rows.entries()) {
      if (i < first || i >= first + shownRows) continue
      if (r.project) {
        const label = rowLabel(r, r.id === panel.selected)
        children.push(
          Box({
            flexDirection: 'row',
            children: [
              Text({ color: 'blue', bold: true, children: rowGlyph(r) }),
              Button({
                key: r.id,
                label: label.slice(0, Math.max(10, width - 5)),
                ...(i < 9 ? { hotkey: String(i + 1), plain: true as const } : {}),
                onPress: () => {
                  panel.selected = panel.selected === r.id ? undefined : r.id
                  panel.mirror = undefined
                  panel.armedStop = undefined
                  $.ui.invalidate('ui.render')
                },
              }),
            ],
          }),
        )
        continue
      }
      const label = rowLabel(r, r.id === panel.selected)
      // A Button takes no colour, so the state is coloured beside it: a dot before
      // the row and, on the selected row, its state word restated in that colour.
      const color = STATE_COLOR[r.state]
      children.push(
        Box({
          flexDirection: 'row',
          children: [
            // finished and delivered share cyan; the glyph tells "reported" apart.
            Text({ color, bold: true, children: rowGlyph(r) }),
            Button({
              key: r.id,
              label: label.slice(0, Math.max(10, width - 5)),
              // Rows 1–9 press on a bare digit from an empty prompt; the tenth
              // and later still take focus + Enter. `plain` draws `1: name`.
              ...(i < 9 ? { hotkey: String(i + 1), plain: true as const } : {}),
              onPress: () => {
                // A second press on the selected row deselects, which is also how the
                // mirror is turned off without closing the panel.
                panel.selected = panel.selected === r.id ? undefined : r.id
                panel.mirror = undefined
                panel.armedStop = undefined
                $.ui.invalidate('ui.render')
              },
            }),
          ],
        }),
      )
      if (r.d.goal && goals) {
        children.push(
          Text({
            dimColor: true,
            wrap: 'truncate-end',
            children: `    ${r.d.goal}`.slice(0, Math.max(10, width)),
          }),
        )
      }
      if (r.id !== panel.selected) continue
      const armed = panel.armedStop?.id === r.id && now < panel.armedStop.until
      // The selected row is the one you are working with: a line to type the
      // next message and a way to dismiss it, right here — no tool call, no
      // shell. Both route through the same functions the tools use.
      children.push(
        Box({
          flexDirection: 'row',
          children: [
            ...(Input
              ? [
                  Input({
                    key: `tell:${r.id}`,
                    placeholder: 'message — Enter sends',
                    submitLabel: 'send',
                    onSubmit: (value: string) => {
                      const text = value.trim()
                      if (!text) return
                      void act(`tell ${r.d.name}`, host => tellWorker(host, r.d, text))
                    },
                  }),
                ]
              : []),
            // Interrupt, then type: that is steering. Only a turn in flight has one to stop.
            ...(r.state === 'running' || r.state === 'stalled'
              ? [
                  Text({ children: '  ' }),
                  Button({
                    key: `interrupt:${r.id}`,
                    label: '↯ interrupt',
                    hotkey: 'i',
                    onPress: () => void act(`interrupt ${r.d.name}`, host => interruptWorker(host, r.d)),
                  }),
                ]
              : []),
            Text({ children: '  ' }),
            Button({
              key: `stop:${r.id}`,
              label: `✕ ${stopButtonLabel(r.d.name, armed)}`,
              hotkey: 'x',
              onPress: () => pressTwice(r.id, () => void act(`stop ${r.d.name}`, host => stopWorker(host, gate, r.d))),
            }),
            ...(armed ? [Text({ color: 'red', children: `  ends its tmux session · ${Math.ceil((panel.armedStop!.until - now) / 1000)}s` })] : []),
          ],
        }),
      )
      if (r.summary) {
        // Finished: its own words are what you want to read, not its pane tail.
        children.push(
          // One line, counted in the budget above; the whole text is in result.json.
          Text({ color: r.summary.startsWith('success') ? 'green' : 'yellow', wrap: 'truncate-end', children: `    ${r.summary}`.slice(0, Math.max(10, width)) }),
        )
      }
    }

    // Every fixed line truncates: a wrapped line is a row the budget above
    // never counted, and one row past maxRows scrolls the band and disarms the digits.
    if (hidden) children.push(Text({ dimColor: true, wrap: 'truncate-end', children: `  +${hidden} more — /workers N selects row N` }))
    // Others' workers as one line that is also the filter: `a` lists them row by
    // row and back. Display only — tell, stop and peek reach every row either way.
    if (others) {
      children.push(
        Box({
          flexDirection: 'row',
          children: [
            Text({ color: others.running ? 'green' : undefined, dimColor: !others.running, children: '◌ ' }),
            Button({
              key: 'others',
              // The toggle word leads so a narrow band cuts holders, never the action.
              // `◌ ` and the button's `[ ]` take 6 cells; one more wraps the band.
              label: fitCells(`${panel.showAll ? '只看自己' : '展開'} · ${others.text}`, Math.max(10, width - 6)),
              hotkey: 'a',
              onPress: () => {
                panel.showAll = !panel.showAll
                setRows(panel, panel.all)
                panel.mirror = undefined
                $.ui.invalidate('ui.render')
              },
            }),
          ],
        }),
      )
    }

    // No room this render, no mirror: its rule, lines and hint would overflow.
    const shown = panel.mirror && panel.mirror.id === panel.selected && (panel.rows_available ?? 0) > 0 ? panel.mirror : undefined
    // `selected`, not `panel.selected`: a worker that left the list (stopped,
    // exited) is no selection, and its stale id drew a "too short" line past
    // maxRows (cursor, 34e2a1e).
    if (!shown && selected && panel.rows_available === 0) {
      // The numbers are the message: "too short" alone cannot be acted on, and
      // the first person to hit this asked whether some cap they never set was
      // the cause. Printing both ends the guessing in one look.
      children.push(
        Text({
          dimColor: true,
          wrap: 'truncate-end',
          children:
            `Band too short to mirror — enlarge the window. ` +
            `(band ${e.props.maxRows} rows; needs ${used + 1 + MIRROR_MIN_ROWS})`,
        }),
      )
    }
    if (shown) {
      const row = panel.rows.find(r => r.id === shown.id)
      children.push(Text({ dimColor: true, children: '─'.repeat(Math.max(3, Math.min(width, 60))) }))
      // The capture was sized by an earlier render; this one may have less room.
      for (const line of shown.lines.slice(Math.max(0, shown.lines.length - (panel.rows_available ?? 0)))) {
        children.push(Text({ wrap: 'truncate-end', children: line.slice(0, Math.max(10, width)) || ' ' }))
      }
      if (row) {
        children.push(
          Text({
            dimColor: true,
            wrap: 'truncate-end',
            // The binary the mod itself runs: off PATH, a bare name would not resolve.
            children: row.project
              ? `See it whole: tmux attach -t ${row.d.name}`
              : `See it whole: ${agentTmuxShown} ${row.d.profile} attach ${row.d.name}`,
          }),
        )
      }
    }

    // Ours under whatever the plugins below drew: one band, shared.
    return Box({ flexDirection: 'column', children: [below, ...children] })
  })

  // The one way the panel closes — `/workers` again, `/workers hide` or the `[ hide ]` button. There
  // is no engine close for a band, so the teardown lives here and both paths call
  // it: no route can leave the mirror clock running against rows nobody sees.
  // `$` itself is never passed here: the engine's static rule lets `$` reach
  // only functions declared at the top of the file. The redraw comes as a closure.
  const closePanel = (redraw: () => void) => {
    panel.open = false
    panel.adding = false
    const w = world
    if (w) void rememberPanel(w, false).catch(err => w.log(`tmux-agent: panel state not saved: ${String(err)}`))
    panel.selected = undefined
    panel.mirror = undefined
    panel.generation += 1
    panel.timer?.cancel()
    panel.timer = undefined
    panel.refresh = undefined
    panel.close = undefined
    redraw()
  }

  /**
   * Running in-process agents. A rejection becomes `內部 ?` and one log line;
   * it must not fail the row refresh or the render.
   */
  const readInternal = async (host: Host): Promise<void> => {
    try {
      const listed = await host.agentList()
      panel.internal = listed.filter(a => a.status === 'running').length
      panel.internalMissLogged = false
    } catch (error) {
      panel.internal = '?'
      if (!panel.internalMissLogged) {
        panel.internalMissLogged = true
        const kind = error instanceof Error ? error.name : typeof error
        host.log(`tmux-agent: agent.list failed: ${kind}: ${String(error)}`)
      }
    }
  }

  // Opens the panel: the /workers toggle, and session.start after a reload closed it
  // (a plugin's own $.command.run skips its own command hook, so /workers cannot be
  // replayed). `$` stays out, per the static rule above: its two uses come as closures.
  const openPanel = async (
    redraw: () => void,
    every: (ms: number, fn: () => Promise<void>) => { cancel: () => void },
  ): Promise<string | undefined> => {
    const bound = world
    if (!bound) return 'workers panel unavailable: the mod did not bind.'
    // Mark it open BEFORE the first await. A close landing during that await
    // would otherwise be undone here, and the timer installed below would
    // outlive the panel — a second /workers then installing another one.
    panel.open = true
    panel.close = () => closePanel(redraw)
    redraw()
    void rememberPanel(bound, true).catch(err => bound.log(`tmux-agent: panel state not saved: ${String(err)}`))
    const mine = panel.generation
    const root = await rootOf(bound)
    const [first] = await Promise.all([panelRows(bound, gate, root), readInternal(bound)])
    if (panel.generation !== mine || !panel.open) return 'workers panel closed.'
    setRows(panel, first)
    // The pane drew once, empty, while the rows were being read; without this
    // the first real frame waits for the 2s clock and the person sees
    // "No workers outstanding" over a fleet that is there (observed 2026-09-17).
    redraw()
    // One re-read of the rows, shared by the clock and the [refresh] button.
    // Single-flight: a `tmux ls` slower than the tick is not joined by the next.
    const refresh = async (): Promise<boolean> => {
      if (panel.refreshing) return false
      panel.refreshing = true
      try {
        const root = await rootOf(bound)
        const [rows] = await Promise.all([panelRows(bound, gate, root), readInternal(bound)])
        if (panel.generation !== mine || !panel.open) return false
        setRows(panel, rows)
        return true
      } finally {
        panel.refreshing = false
      }
    }
    // A refresh that throws is logged, never lost: a silent panel is the one
    // failure the person cannot tell from an empty fleet.
    panel.refresh = async () => {
      try {
        if (await refresh()) redraw()
      } catch (error) {
        bound.log(`tmux-agent: panel refresh failed: ${String(error)}`)
      }
    }
    if (panel.timer) panel.timer.cancel()
    panel.timer = every(MIRROR_MS, async () => {
      if (!panel.open || panel.generation !== mine) return
      // Single-flight: a capture slower than the 2s tick must not start a second
      // subprocess on top of itself, and two in-flight captures could land out of
      // order and show older output than what is already on screen.
      if (panel.capturing) return
      let fresh = false
      try {
        fresh = await refresh()
      } catch (error) {
        bound.log(`tmux-agent: panel refresh failed: ${String(error)}`)
      }
      if (!fresh) return
      const row = panel.rows.find(r => r.id === panel.selected)
      // No selection, no capture: the mirror is the only thing here that costs a
      // process, and it costs it for one worker at a time.
      // A zero here is the render telling us the pane is too short to mirror
      // usefully; spending a subprocess on it would buy an empty box.
      if (row && (panel.rows_available ?? MIRROR_ROWS) > 0) {
        panel.capturing = true
        try {
          const lines = row.project
            ? await mirrorProject(bound, row.d.name, panel.rows_available ?? MIRROR_ROWS)
            : await mirrorOf(bound, row.d, panel.rows_available ?? MIRROR_ROWS)
          // The selection may have moved, or the panel closed, while this ran.
          if (panel.generation === mine && panel.open && panel.selected === row.id) {
            panel.mirror = { id: row.id, lines }
          }
        } finally {
          panel.capturing = false
        }
      } else {
        panel.mirror = undefined
      }
      redraw()
    })
    return undefined
  }

  on('command.run', { command: 'workers' }, async ($, e) => {
    const redraw = () => void $.ui.invalidate('ui.render')
    // Typed forms of the panel's controls. They work in any terminal: a letter
    // hotkey presses only while the band is focused, and the chord that focuses
    // it (ctrl+x tab) may never reach the pty — observed 2026-09-25 in Warp.
    const parsed = /^(\S+)(?:\s+(\S+))?(?:\s([\s\S]*))?$/.exec(e.args.trim())
    const verb = parsed?.[1] ?? ''
    const target = parsed?.[2] ?? ''
    // The message as typed: newlines and indentation are the person's.
    const message = parsed?.[3] ?? ''
    if (verb) {
      const bound = world
      if (!bound) return { text: 'unavailable — the mod did not bind.' }
      if (verb === 'probe') {
        await idNow(() => $.session.id())
        if (target !== '' && target !== 'show' && target !== 'on' && target !== 'off') return { text: '/workers probe on|off|show' }
        const text = await probeRun(async () => {
          const blocker = await probeLoad()
          if (blocker) return `probe: blocked — ${blocker}; nothing written.`
          if (target === 'on' || target === 'off') {
            const st: ProbeState =
              target === 'on'
                ? { on: true, epoch: crypto.randomUUID(), start: await bound.now() }
                : { ...(probe.state ?? { epoch: '', start: 0 }), on: false }
            try {
              await bound.storeSet(probeKey(probe.sid!), st)
            } catch (error) {
              return `probe: blocked — ${probeErr('probe store write', error)}; still ${probe.state?.on ? 'on' : 'off'}.`
            }
            probe.state = st
            if (target === 'on') {
              // A fresh epoch: older epochs leave the file (bounded), de-dup and the loss count reset.
              probe.lines = []
              probe.rendered = new Set()
              probe.errors = 0
              probe.lastError = ''
              probe.lossUnsaved = false
            }
          }
          return ''
        })
        if (text) return { text }
        if (target === 'on') await probeNote({ kind: 'loaded', version: MOD_VERSION, session: sessionId, probe: 'on' })
        return { text: await probeRun(async () => probeShow()) }
      }
      if (verb === 'hide') {
        if (panel.open) closePanel(redraw)
        return { text: 'workers panel hidden; /workers shows it again.' }
      }
      if (verb === 'resume') {
        // The `[ + ]` field's typed form: surfaces with no Input (mobile), and
        // terminals where the band's focus chord never arrives.
        const out = await resumeWorker(bound, e.args.trim().slice(verb.length))
        if (out.ok && panel.open) void panel.refresh?.()
        return { text: `resume — ${out.ok ? 'ok' : 'FAILED'}: ${out.text}` }
      }
      if (verb === 'cancel' || verb === 'unlock') {
        // By name, like stop/tell: an episode cancel never touches the pane (§5); unlock is
        // maintenance only and refuses a holder it cannot prove gone.
        if (!target) return { text: verb === 'cancel' ? '/workers cancel <name> <seq> [--force]' : '/workers unlock <name> [confirm]' }
        await idNow(() => $.session.id())
        const word = message.trim()
        const [seqWord = '', flag] = word.split(/\s+/)
        const out =
          verb === 'cancel'
            ? await cancelEpisode(bound, target, /^[0-9]+$/.test(seqWord) && (!flag || flag === '--force') ? Number(seqWord) : NaN, { force: flag === '--force' })
            : await unlockWorker(bound, target, word || undefined)
        if (panel.open) void panel.refresh?.()
        return { text: `${verb} "${target}" — ${out.ok ? 'ok' : 'FAILED'}: ${out.text.slice(0, 400)}` }
      }
      const fresh = panel.open ? undefined : await panelRows(bound, gate, await rootOf(bound))
      // Numbers index what is drawn; names reach every row, folded ones too.
      const rows = fresh ?? panel.rows
      const named = fresh ?? panel.all

      if (/^[0-9]+$/.test(verb)) {
        // Selecting is harmless, so N is simply row N of the current list.
        const row = rows[Number(verb) - 1]
        if (!row) return { text: `no row ${verb} (${rows.length} shown).` }
        panel.selected = row.id
        panel.mirror = undefined
        panel.armedStop = undefined
        if (panel.open) {
          redraw()
          return { text: `row ${verb} "${row.d.name}" selected.` }
        }
      } else if (verb === 'stop' || verb === 'tell') {
        // Names only. Row numbers move whenever the list refreshes — the engine
        // redraws right after — so `stop 2` ended a worker other than the one the
        // person read as row 2 (cursor, 34e2a1e and d20cdcc). A number answers
        // with the name it stands for now, to type back.
        if (/^[0-9]+$/.test(target)) {
          const now = rows[Number(target) - 1]
          const hint = verb === 'tell' ? ' <text>' : ''
          return {
            text: now
              ? `row ${target} is "${now.d.name}" right now — ${verb} takes a name: /workers ${verb} ${now.d.name}${hint}`
              : `no row ${target}; ${verb} takes a name (${rows.map(r => r.d.name).join(', ') || 'none'}).`,
          }
        }
        const row = named.find(r => r.d.name === target)
        if (!row) return { text: `no worker "${target}" (${named.map(r => r.d.name).join(', ') || 'none'}).` }
        if (row.project) return { text: 'read-only project session' }
        let out: Outcome
        if (verb === 'stop') {
          // Typing the row or name is the confirmation; the button asks twice.
          out = await stopWorker(bound, gate, row.d)
        } else {
          const text = message.trim() ? message : ''
          if (!text) return { text: '/workers tell <name> <text> — the message is missing.' }
          out = await tellWorker(bound, row.d, text)
        }
        if (panel.open) void panel.refresh?.()
        return { text: `${verb} "${row.d.name}" — ${out.ok ? 'ok' : 'FAILED'}: ${out.text.slice(0, 300)}` }
      } else {
        return { text: '/workers [N | stop <name> | tell <name> <text> | cancel <name> <seq> | unlock <name> [confirm] | resume [profile] <session-id> [name] | hide]' }
      }
    }
    if (panel.open) {
      closePanel(redraw)
      return { text: 'workers panel closed.' }
    }
    const failed = await openPanel(redraw, (ms, fn) => $.clock.every(ms, fn))
    if (failed) return { text: failed }
    return {
      text:
        'workers panel opened above the prompt. 1-9 on an empty prompt selects a row; ' +
        '/workers stop <name>, /workers tell <name> <text>, /workers hide work anywhere (letter keys r/x/q need the band focused).',
    }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const host = world
    if (!host) return { deny: 'tmux-agent: the mod did not bind' }
    const out = await assignWorker(host, e as unknown as AssignInput, {
      owner: await idNow(() => $.session.id()),
      ownerCwd: sessionCwd,
      down: () => collectorDown(gate),
    })
    if ('deny' in out) return { deny: out.deny }
    return { result: out.receipt }
  })

  /**
   * The worker a `tell`/`stop` names, from the record `assign` wrote. Reported or
   * not does not matter here: a teammate that finished one task is exactly the
   * one you talk to next.
   */
  const dispatchNamed = async (host: Host, name: string) =>
    (await scan(host, { claim: false })).visible.find(d => d.name === name)
  const projectNamed = (name: string) => gate.projects.some(p => p.name === name)
  const READONLY_PROJECT = { deny: 'tmux-agent: read-only project session' }

  on('tool.call', { tool: TELL_TOOL }, async ($, e) => {
    const input = e as unknown as TellInput
    if (!NAME_RE.test(input.name ?? '')) return { deny: 'tmux-agent: name must match [A-Za-z0-9_.-], max 64 chars' }
    const text = (input.text ?? '').trim()
    if (!text) return { deny: 'tmux-agent: text is empty' }
    const host = world
    if (!host) return { deny: 'tmux-agent: the mod did not bind' }
    await idNow(() => $.session.id())
    const d = await dispatchNamed(host, input.name)
    if (!d && projectNamed(input.name)) return READONLY_PROJECT
    if (!d) {
      return { deny: `tmux-agent: no worker "${input.name}" was dispatched by this mod (use the exact name the assign receipt returned, suffix included)` }
    }
    const told = await tellWorker(host, d, text)
    if (!told.ok) return { deny: `tmux-agent: ${told.text}` }
    const down = collectorDown(gate)
    return {
      result:
        `${told.text}. ` +
        (down
          ? `collector: NONE — ${down}. Nothing will wake you: check it with ${PEEK_TOOL}, and once it is idle read the result file named above with the Read tool`
          : 'collector: active — end the turn; a prompt arrives when it answers') +
        '.',
    }
  })

  on('tool.call', { tool: STOP_TOOL }, async ($, e) => {
    const input = e as unknown as StopInput
    const host = world
    if (!host) return { deny: 'tmux-agent: the mod did not bind' }
    if (input.all === true) return { result: `${(await stopAll(host, gate)).text}.` }
    if (!NAME_RE.test(input.name ?? '')) return { deny: 'tmux-agent: name must match [A-Za-z0-9_.-], max 64 chars, or pass all: true' }
    const d = await dispatchNamed(host, input.name!)
    if (!d && projectNamed(input.name!)) return READONLY_PROJECT
    if (!d) return { deny: `tmux-agent: no worker "${input.name}" was dispatched by this mod` }
    return { result: `${(await stopWorker(host, gate, d)).text}.` }
  })

  on('tool.call', { tool: PEEK_TOOL }, async ($, e) => {
    const input = e as unknown as PeekInput
    if (!NAME_RE.test(input.name ?? '')) return { deny: 'tmux-agent: name must match [A-Za-z0-9_.-], max 64 chars' }
    const host = world
    if (!host) return { deny: 'tmux-agent: the mod did not bind' }
    const d = await dispatchNamed(host, input.name)
    if (!d) {
      if (!projectNamed(input.name)) return { deny: `tmux-agent: no worker "${input.name}" was dispatched by this mod` }
      const seen = await peekProject(host, input.name, typeof input.lines === 'number' ? input.lines : PEEK_DEFAULT)
      return seen.ok ? { result: seen.text } : { deny: `tmux-agent: ${seen.text}` }
    }
    // The wrapper says `running` for any live pane; a terminal result.json is
    // the honest word for a worker parked at its prompt after finishing.
    const raw = d.resultPath ? (parseJson(await readOrEmpty(host, d.resultPath)) as { status?: unknown } | undefined) : undefined
    const status = typeof raw?.status === 'string' && TERMINAL.has(raw.status) ? raw.status : undefined
    const out = await peekWorker(host, d, typeof input.lines === 'number' ? input.lines : PEEK_DEFAULT, status)
    return out.ok ? { result: out.text } : { deny: `tmux-agent: ${out.text}` }
  })

  on('tool.call', { tool: KEYS_TOOL }, async ($, e) => {
    const input = e as unknown as KeysInput
    if (!NAME_RE.test(input.name ?? '')) return { deny: 'tmux-agent: name must match [A-Za-z0-9_.-], max 64 chars' }
    const host = world
    if (!host) return { deny: 'tmux-agent: the mod did not bind' }
    const d = await dispatchNamed(host, input.name)
    if (!d && projectNamed(input.name)) return READONLY_PROJECT
    if (!d) return { deny: `tmux-agent: no worker "${input.name}" was dispatched by this mod` }
    const keys = Array.isArray(input.keys) ? input.keys.filter((k): k is string => typeof k === 'string') : []
    const out = await pressKeys(host, d, keys)
    return out.ok ? { result: `${out.text}.` } : { deny: `tmux-agent: ${out.text}` }
  })

  // The panel from the model's side: the same openPanel /workers runs, so it is
  // recorded for reopen after a reload exactly like a typed /workers.
  on('tool.call', { tool: PANEL_TOOL }, async ($, e) => {
    const close = (e as unknown as { action?: unknown }).action === 'close'
    const redraw = () => void $.ui.invalidate('ui.render')
    if (close) {
      if (!panel.open) return { result: 'workers panel is already closed.' }
      closePanel(redraw)
      return { result: 'workers panel closed.' }
    }
    if (panel.open) return { result: 'workers panel is already open.' }
    const failed = await openPanel(redraw, (ms, fn) => $.clock.every(ms, fn))
    return { result: failed ?? `workers panel opened above the prompt (${panel.rows.length} worker row(s)).` }
  })

  // /reload-plugins cannot run inside the tool call (the turn waits on it and
  // $.command.run rejects there); a timer queues it for when the session is idle.
  // Before this, every update waited for the person to type /reload-plugins.
  on('tool.call', { tool: RELOAD_TOOL }, async $ => {
    $.clock.after(0, () =>
      $.command.run({ command: 'reload-plugins' }).then(
        () => undefined,
        err => $.ui.log(`/reload-plugins failed: ${String(err)}`),
      ),
    )
    return { result: `/reload-plugins is queued for when this turn ends (mod ${MOD_VERSION} now).` }
  })

  // While this mod is loaded the wrapper verbs have tools, and the collector owns
  // the wait: a hand-typed `agent-tmux <cli> assign|status|...` from Bash would be
  // a second supervisor (or a dispatch the collector never hears about, because
  // only the tool writes dispatch.json). `--help` is inspection and passes.
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const command = (e as unknown as { command?: unknown }).command
    if (typeof command !== 'string' || !BASH_GATE_RE.test(command) || HELP_RE.test(command)) return next(e)
    const verb = BASH_GATE_RE.exec(command)?.[2] ?? 'assign'
    const route =
      verb === 'assign'
        ? `${TOOL} (only the tool writes the dispatch record the collector reads)`
        : verb === 'send' || verb === 'send-wait'
          ? `${TELL_TOOL}`
          : verb === 'stop'
            ? `${STOP_TOOL}`
            : verb === 'status' || verb === 'capture' || verb === 'probe'
              ? `${PEEK_TOOL} (one snapshot of the pane and its state)`
              : undefined
    return {
      deny:
        `tmux-agent: do not run \`agent-tmux … ${verb}\` from Bash while the tmux-agent mod is loaded — ` +
        (route ? `use ${route}.` : 'the collector wakes this session when the worker finishes; /workers shows its state now.'),
    }
  })

  // The waiter stays offered: `isOffered: false` hides a type at dispatch as
  // well as in the listing, and the rewrite below is a model-facing dispatch —
  // live 2026-09-26 every runtime brief was refused, its worker already started.
  on('agent.spawn', async ($, e, next) => {
    const m = RUNTIME_LINE.exec(e.prompt)
    if (!m) return next(e)
    const profile = m[1] ?? ''
    if (!waiterReady) {
      return {
        deny: `tmux-agent: this brief names runtime tmux/${profile}; call ${TOOL} with profile "${profile}" instead of the Agent tool.`,
      }
    }
    if (e.name) {
      return {
        deny: `tmux-agent: a runtime tmux/${profile} Agent call must not set name (a named spawn becomes an idle teammate); drop name`,
      }
    }
    const host = world
    if (!host) return { deny: 'tmux-agent: the mod did not bind' }
    const brief = stripRuntimeLine(e.prompt)
    let spawned: Awaited<ReturnType<typeof next>> | undefined
    const assigned = await assignWorker(
      host,
      { profile, name: workerBase(e.description), dir: e.cwd ?? sessionCwd ?? '', brief },
      {
        owner: await idNow(() => $.session.id()),
        ownerCwd: sessionCwd,
        down: () => collectorDown(gate),
        // Inside the action lock (§5, §8): the binding record names this lock's
        // token and is on disk before `next()` yields, so a collector tick cannot
        // submit E1 with no waiter. After the lock drops, that record is no waiter.
        bindWaiter: async (stateDir, token) => {
          const waiterPath = `${stateDir}/episodes/1/waiter`
          const name = stateDir.slice(stateDir.lastIndexOf('/') + 1)
          await host.write(waiterPath, JSON.stringify({ binding: true, token }))
          try {
            spawned = await next({
              ...e,
              subagentType: WAITER_TYPE,
              model: 'haiku',
              background: true,
              description: name,
              prompt: waiterPrompt(stateDir, name),
            })
          } catch (error) {
            await host.write(waiterPath, '{}')
            throw error
          }
          if (!spawned || spawned.deny || !spawned.agentId) {
            await host.write(waiterPath, '{}')
            return
          }
          await host.write(waiterPath, JSON.stringify({ agentId: spawned.agentId }))
        },
      },
    )
    if ('deny' in assigned) return { deny: assigned.deny }
    if (!spawned) return { deny: `tmux-agent: waiter did not bind for "${assigned.name}"` }
    // Refused downstream (another plugin's spawn hook): the worker is already
    // running, so say so — a bare deny reads as "nothing started" and invites a
    // second dispatch. Without a waiter the collector delivers it as usual.
    if (spawned.deny) {
      return { deny: `${spawned.deny} — tmux worker "${assigned.name}" was dispatched anyway; the collector will deliver its result. Do not dispatch it again.` }
    }
    return spawned
  })
}
