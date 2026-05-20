# Design — Issue #101: Lifecycle hooks (SPLIT into v0.x + future)

Status: draft, not implemented. Split per partner critique into two
separate issues. This file owns the v0.x-eligible subset.
Tracking: https://github.com/ohyeh/tmux-agent-tools/issues/101
Related: RFC #109 L1 Mechanism; #95 sentinel is a special case of
`--on-exit`; #105 max-runtime fuse depends on the deferred watcher work.

## Decision: split into #101a (v0.x) and #101b (future)

The original issue lists four hooks — `--on-start`, `--on-exit`,
`--on-marker`, `--on-idle` — as a symmetric surface. They are NOT
symmetric:

| Hook | Wrapper execution model | "Hidden autonomy" risk |
|---|---|---|
| `--on-start` | one-shot eval right after tmux session create | low — boundary event, single-shot |
| `--on-exit` | one-shot eval after CLI exit | low — landed in #95 with sentinel + hook log |
| `--on-marker` | resident watcher: capture-pane + grep loop + dedup state | HIGH — wrapper grows a daemon operators can't see or stop |
| `--on-idle` | timer loop: poll pane activity + threshold compare | HIGH — same daemon shape; idle is "event when nothing happens" |

The symmetric CLI surface hides a fundamental asymmetry in execution
cost and roadmap fit.

## #101a — v0.x-eligible (this design)

Scope: `--on-start` and `--on-exit` only. `--on-exit` is already shipped
as the `#95` `--on-exit` hook; this issue absorbs it as part of a unified
lifecycle surface, not a re-implementation.

### CLI surface

`<wrapper> start [--on-start <cmd>] [--on-exit <cmd>] [--sentinel <path>] ...`

Both flags are optional. Default behavior is unchanged.

| Flag | Trigger | Receives |
|---|---|---|
| `--on-start` | After `tmux new-session` creates the pane, before the CLI launch completes (best-effort timing — the hook runs alongside the CLI launch, not strictly after first-prompt) | env: `TMUX_AGENT_NAME`, `TMUX_AGENT_SESSION` |
| `--on-exit` | After the wrapped CLI returns, before the pane `read _` blocks | env: `TMUX_AGENT_NAME`, `TMUX_AGENT_SESSION`, `TMUX_AGENT_EXIT_CODE`; positional: `$1=exit_code`, `$2=name` |

### Execution model (both hooks)

- `setsid` (Linux) / `nohup` (mac fallback) detaches the hook from the
  pane's terminal so the hook can outlive a brief pane.
- Hook stdout/stderr captured to `<sentinel>.hook.log` when sentinel is
  set, else `$TMUX_AGENT_DIR/<name>/hook.log`.
- Non-zero hook exit is logged with a `status --json` diagnostic; never
  fails the agent.

### Why not just merge into #95

Could keep `--on-exit` only on #95 and skip the broader "hooks" framing.
But:

- the lifecycle vocabulary (`on-start`, `on-exit`) makes it natural to
  add `on-error`, `on-cancel` later;
- env variable contract (`TMUX_AGENT_*`) is shared between hooks and
  the `--transcript` machinery (#100) — defining it once here helps.

### Test plan

| Case | Expected |
|---|---|
| `--on-start 'echo $TMUX_AGENT_NAME >> /tmp/log'` | log file gets the name within 5s |
| `--on-exit` reuse from #95 | unchanged behavior |
| Hook exits non-zero | agent exit code preserved; diagnostic in `hook.log` |
| Both hooks set | both run; hook.log contains both invocations |

## #101b — future, requires roadmap amendment

Scope: `--on-marker TEXT:CMD` and `--on-idle SECS:CMD`.

These need a resident watcher. The watcher is operator-visible work
that the roadmap currently bans under the "no hidden autonomy" non-goal.
Before this issue can be implemented, the roadmap must be amended with
an explicit clause along the lines of:

> Wrappers MAY own a watcher process when it is started via an
> operator-visible subcommand (e.g. `tmux-agent-watch <name>`), exposes
> its PID, can be stopped explicitly, and writes events to a transcript
> the operator can read.

Required acceptance for #101b:

- watcher is spawned via a separate subcommand, not silently from `start`;
- watcher PID visible via `tmux-agent-sessions list`;
- watcher's marker state and idle threshold are inspectable via
  `status --json`;
- watcher exits cleanly when the wrapped agent session exits;
- documented restart semantics (kill -9, machine reboot — what happens
  to "marker already triggered" state).

Until the roadmap amendment lands, this issue stays open as "blocked
on policy".

## Trade-offs

- Splitting one issue into 1a + 1b loses some CLI symmetry (`--on-start`
  and `--on-marker` look related but ship at different times).
- Caller documentation will need to point at the right issue for each
  hook. Acceptable: the bigger risk is shipping `--on-marker` as a
  silent daemon that operators can't trace.

## Rollout

1. Update issue #101 description on GitHub to reference this split.
2. Open #101b as a new issue tracking the watcher amendment.
3. Land `--on-start` in code (small change, mirrors `--on-exit`
   pre-existing in #95).
4. SKILL.md adds one example: log start + finish via the two hooks.
