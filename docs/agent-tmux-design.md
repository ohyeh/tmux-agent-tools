# agent-tmux: Unified CLI Design

_v3.1 — final. Adds team collaboration primitives, fills PR B spec gaps, resolves prefix-awareness contradiction. Round-1 review (codex) corrections applied: no `result --path` flag, explicit `team wait`/`results` semantics, hardened lock + atomic-write contract, member state-schema fields. Round-2 review confirmed all five blockers resolved with no new contradictions._

## Motivation

`claude-tmux` and `codex-tmux` are ~4400-line scripts with only ~600 lines of difference — all mechanical prefix substitution (variable names, binary name, session prefix). `agy-tmux` was already added as a thin preset shim on top of `codex-tmux` (PR #234). As more CLIs appear (cursor, grok, etc.), maintaining N near-identical scripts is unsustainable.

**Goal**: single `agent-tmux` entrypoint, CLI identity as a preset, all existing behaviour preserved, plus first-class multi-agent `pair`/`team` workflow with collaboration primitives (broadcast / send / wait / gather).

---

## CLI Syntax

```
agent-tmux <cli> <command> [args...]
```

Where `<cli>` is one of: `claude`, `codex`, `agy`, `cursor`, `grok`, or any custom binary name.

Examples:
```bash
agent-tmux claude start --attach pr5 ~/path
agent-tmux codex send pr5 'implement the feature'
agent-tmux agy wait pr5 180
agent-tmux claude doctor
```

### Backwards compatibility

`claude-tmux`, `codex-tmux`, and `agy-tmux` become 1-line shims:
```bash
#!/usr/bin/env zsh
exec agent-tmux claude "$@"   # claude-tmux
exec agent-tmux codex "$@"    # codex-tmux
exec agent-tmux agy "$@"      # agy-tmux
```

All shims remain registered in `install-bin` (they are still installed as symlinks; they just delegate to `agent-tmux`). No callers break.

---

## Preset Table

Each CLI maps to a preset. Presets are **hardcoded in the script** (YAGNI — no external preset file). All fields are overridable via env vars (see Env Precedence below).

| cli    | binary  | default launch flags                | session prefix | env namespace   |
|--------|---------|-------------------------------------|----------------|-----------------|
| claude | claude  | `--dangerously-skip-permissions`    | claude-cli     | CLAUDE_TMUX_*   |
| codex  | codex   | `--yolo`                            | codex-cli      | CODEX_TMUX_*    |
| agy    | agy     | `--dangerously-skip-permissions`    | agy-cli        | AGY_TMUX_*      |
| cursor | cursor  | (none)                              | cursor-cli     | CURSOR_TMUX_*   |
| grok   | grok    | (none)                              | grok-cli       | GROK_TMUX_*     |

Unknown CLI: binary = the name, flags = none, prefix = `<cli>-cli`, env namespace = `AGENT_TMUX_*`.

> **Note**: `claude-cli` / `codex-cli` prefixes match the **current** values in `claude-tmux:7` (`CLAUDE_TMUX_PREFIX:-claude-cli`) and `codex-tmux:7`. No session-visibility migration risk — existing in-flight sessions remain resolvable after upgrade.

### Env Precedence (highest → lowest)

```
CLI-specific env  (e.g. CLAUDE_TMUX_STABLE_SECONDS)
  > AGENT_TMUX_*  (e.g. AGENT_TMUX_STABLE_SECONDS)
  > preset default
```

This preserves full backwards compatibility: existing callers using `CLAUDE_TMUX_*` or `CODEX_TMUX_*` continue to work unchanged. `AGENT_TMUX_*` is the new universal override namespace for scripts that need to work across CLIs.

```bash
# CLI-specific override (highest priority):
CLAUDE_TMUX_STABLE_SECONDS=5 agent-tmux claude start myagent ~/path

# Universal override (works for any CLI):
AGENT_TMUX_LAUNCH_FLAGS="--model opus" agent-tmux claude start myagent ~/path

# Explicitly clear launch flags for a custom CLI:
AGENT_TMUX_LAUNCH_FLAGS="" agent-tmux mycli start myagent ~/path
```

### TMUX_CONF path

Scoped per CLI to avoid concurrent-session file collisions:

```
${TMPDIR:-/tmp}/agent-tmux-<cli>.tmux.conf
```

e.g. `agent-tmux claude ...` → `/tmp/agent-tmux-claude.tmux.conf`
     `agent-tmux codex ...`  → `/tmp/agent-tmux-codex.tmux.conf`

This replaces the current per-script defaults (`claude-tmux.tmux.conf`, `codex-tmux.tmux.conf`) with a consistent pattern that scales to arbitrary CLIs.

### State dir fallback ($TMUX_AGENT_DIR)

For callers that are not themselves managed sessions (the main brain running outside tmux), `$TMUX_AGENT_DIR` may be unset. `agent-tmux` falls back to:

```
${TMUX_AGENT_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/tmux-agent-tools}
```

This matches the existing default in `claude-tmux`/`codex-tmux`, so team state files and per-session dirs land in the same place whether invoked from inside or outside a managed session.

### INHERIT / CLEAR env flags

Named CLIs keep their existing per-CLI variables:

| cli    | inherit var            | clear var            | inherit default | clear default |
|--------|------------------------|----------------------|-----------------|---------------|
| claude | `INHERIT_CLAUDE_ENV`   | `CLEAR_CLAUDE_ENV`   | 0               | 1             |
| codex  | `INHERIT_CODEX_ENV`    | `CLEAR_CODEX_ENV`    | 0               | 1             |
| agy    | `INHERIT_AGY_ENV`      | `CLEAR_AGY_ENV`      | 0               | 1             |

For unknown CLIs, `INHERIT_<CLI>_ENV` / `CLEAR_<CLI>_ENV` fall back to `AGENT_TMUX_INHERIT_ENV` / `AGENT_TMUX_CLEAR_ENV`, which default to `0` and `1` respectively (matching existing per-CLI defaults).

---

## Role System

Sessions carry a `role` tag stored in the existing `tags.json` infrastructure (`$TMUX_AGENT_DIR/<name>/tags.json`). `--tag` is already implemented in both `start_session` (line 2033) and `resume_session` (line 2323) of `claude-tmux`.

```bash
agent-tmux claude start --role lead   my-project ~/path
# internally: --tag role=lead

agent-tmux codex start --role worker my-project-w1 ~/path
# internally: --tag role=worker
```

`--role` is **free-form** syntactic sugar for `--tag role=<value>`. Any string is accepted (`lead`, `worker`, `reviewer`, `critic`, `debater`, ...), so pair-review / critic / debate roles need no new infrastructure. All existing `tmux-agent-sessions --tag` filters work unchanged.

### Lead auto-tag from pair

`pair --role lead` writes to the calling session's `tags.json` **only if** a managed session name can be determined (i.e. `$TMUX_AGENT_DIR` is set and a `tags.json` file for a session is detectable via `$TMUX_AGENT_RESULT`). For callers that are not managed sessions (main brain running outside tmux), the flag is silently accepted but no tag is written. The user can tag themselves manually with `agent-tmux claude start --role lead` when starting their own session.

---

## pair command

Solves the common scenario: main brain is already running (not necessarily in tmux), needs to bootstrap persistent workers without a multi-step manual flow.

```
agent-tmux pair <cli> <team-name> <dir> [--workers N] [--worker-cli <cli>] [--role lead]
```

**`--worker-cli` default**: same as lead `<cli>`. `agent-tmux pair claude my-project ~/path` spawns claude workers unless `--worker-cli codex` is specified.

### Idempotency and reconciliation

1. Read `$TMUX_AGENT_DIR/teams/<team-name>.json` (team state file)
2. For each listed worker: check live tmux session existence first
   - Session alive → `resume`
   - Session gone (manual kill, crash) → `start` fresh; update team state file
3. Workers not yet in state file → `start` and append to state file
4. **Scale-down (conservative)**: if the state file lists more workers than `--workers N` requests, the surplus workers are **not stopped**. Each is printed as `orphan` with a warning; the operator stops them explicitly via `team stop` / `agent-tmux <cli> stop`. This avoids accidentally killing in-flight work.
5. Print each worker name + action (`started` / `resumed` / `orphan`) to stdout

This reconciliation logic prevents stale-state failures when workers are killed manually.

### Exit code contract

```
0  all requested workers started or resumed successfully
1  one or more workers failed to start/resume
```

On failure, `pair` lists each failed worker on **stderr** (`name  cli  FAILED: <reason>`). Workers that succeeded before the failure are left running (no rollback) — re-running `pair` reconciles them to the desired state.

### Concurrency

**Atomic write**: the state file is written by creating `teams/<team>.json.tmp.$$` **in the same directory** (`teams/`, guaranteeing same filesystem so `mv` is atomic — a cross-filesystem rename would be a non-atomic copy), then `mv`-ing it into place. The temp write is `fsync`'d before rename so a crash cannot leave a truncated file.

**Per-team lock**: `pair` acquires `teams/<team>.json.lock` via `mkdir` (atomic create-or-fail) around the read-reconcile-write cycle, with:

- **Owner record**: the lock dir holds a `pid` file with the holder's PID so staleness can be judged.
- **Stale-lock detection**: if the lock exists but its `pid` is not a live process (`kill -0` fails), the lock is reclaimed. A lock with no readable `pid` older than a grace window (default 60s) is also treated as stale.
- **Timeout**: a competing `pair` retries acquisition for up to `AGENT_TMUX_LOCK_TIMEOUT` (default 30s); on expiry it exits non-zero with `team busy: <team> locked by pid <n>` rather than racing.
- **Cleanup**: the holder removes the lock via a `trap '...' EXIT INT TERM` so it is released even on interrupt or error.

### team stop guard

`team stop <team-name>` detects if any member session matches the current process's own session. The rule: compare each member `name` against `basename "$(dirname "$TMUX_AGENT_RESULT")"` (the managed session name encoded in the result path). If a match is found, that member is skipped with a warning:

```
warning: skipping self (my-project) — stop it from outside the session
```

```bash
# First call — creates workers
agent-tmux pair claude my-project ~/path --workers 2 --worker-cli codex
# → my-project-w1  codex  started
# → my-project-w2  codex  started

# Subsequent calls — reconciles
agent-tmux pair claude my-project ~/path --workers 2 --worker-cli codex
# → my-project-w1  codex  resumed
# → my-project-w2  codex  started   (was killed, restarted)
```

---

## team commands

```bash
agent-tmux team list                   # all teams + member status
agent-tmux team list my-project        # single team detail
agent-tmux team workers my-project     # worker names only (for scripting)
agent-tmux team lead my-project        # lead name only
agent-tmux team stop my-project        # stop all members (skips self with warning)
agent-tmux team rm my-project          # delete the team state file (sessions must already be stopped)
```

`team list` output:
```
team: my-project
  lead    claude  my-project        running
  worker  codex   my-project-w1     running
  worker  codex   my-project-w2     idle
```

### Authoritative source: team state file (no prefix scan)

`team list` / `team results` treat the **team state file as the authoritative member list**, then perform a live check on each member **by its exact session name** (`status --json <name>`). This deliberately avoids needing `tmux-agent-sessions` to be prefix-aware for arbitrary CLIs — the previously-deferred "prefix-aware inventory" work is **not** a dependency. Mixed-CLI teams work naturally because each member's `cli` is read from the state file and queried individually.

### team stop / team rm semantics

- `team stop` stops all member sessions (skipping self) but **retains** the state file, so the team can be `pair`-resumed later.
- `team rm` deletes the state file only. It refuses to run if any member session is still live (prevents orphaning running workers); stop them first.

### Team state file

`$TMUX_AGENT_DIR/teams/<team-name>.json`:
```json
{
  "schema_version": 1,
  "team": "my-project",
  "lead_cli": "claude",
  "members": [
    {"name": "my-project",    "role": "lead",   "cli": "claude", "result_path": "<dir>/my-project/result.json"},
    {"name": "my-project-w1", "role": "worker", "cli": "codex",   "result_path": "<dir>/my-project-w1/result.json"},
    {"name": "my-project-w2", "role": "worker", "cli": "agy",     "result_path": "<dir>/my-project-w2/result.json"}
  ]
}
```

Each member persists enough to make `broadcast` / `send` / `results` deterministic after reconcile or scale-down:

| field | purpose |
|---|---|
| `name` | exact tmux session name (no prefix scan needed) |
| `role` | free-form role tag (`lead`/`worker`/...) |
| `cli` | **per-member** binary — so mixed-CLI teams (e.g. 2 codex + 1 agy) are first-class |
| `result_path` | resolved `$TMUX_AGENT_DIR/<name>/result.json`; cached at write time so `results` need not re-derive it |

Live status (`running`/`idle`/`orphan`) is **not** stored — it is computed on read by merging this file with live `status --json` per member (see below). `team list` merges static + live to show current state.

---

## Collaboration primitives

The point of a `team` is multi-agent collaboration, not just lifecycle. These commands let a lead fan work out to workers and gather results without hand-writing loops over worker names. All operate on the team state file's member list (workers only; lead is excluded unless `--include-lead`).

```bash
agent-tmux team broadcast my-project '<prompt>'          # send same prompt to every worker
agent-tmux team send my-project w1 '<prompt>'            # send to one worker by short suffix or full name
agent-tmux team wait my-project [timeout]                # block until all workers idle (or timeout)
agent-tmux team results my-project [--json]              # gather each worker's result.json
```

### broadcast

`team broadcast` iterates workers and calls the per-CLI `send` for each, dispatching the correct binary per member `cli`. Each worker's prompt is suffixed with the standard "write your result to `<literal result path>` when done" instruction and the cascade-spawn ban from the orchestrator playbook.

The literal result path comes from the member's stored `result_path` (cached in the state file). There is **no `result --path` flag** — the wrapper's `result --json` payload contains a `.path` field, so when `result_path` is not yet cached, `agent-tmux` derives it via `result --json <name> | jq -r .path` (equivalently `$TMUX_AGENT_DIR/<name>/result.json`). Exit code: `0` if all sends succeed, `1` if any send fails (failures listed on stderr).

### send

`team send <team> <worker> <prompt>` resolves `<worker>` against the member list (accepts the short suffix `w1` or the full name `my-project-w1`) and dispatches one `send` with the member's `cli`. Errors if the worker is not a team member.

### wait

`team wait <team> [timeout] [--require-result]` defines completion explicitly, because the wrapper's `wait` only means "visible pane bytes were stable for `STABLE_SECONDS`" — it does **not** imply task completion or `result.json` presence.

- **Default (idle)**: returns once every worker's `status --json` reports `running:false`.
- **`--require-result`**: in addition to idle, requires each worker's `result.json` to be `present:true && valid:true`. Use this before `team results` to avoid gathering empty/partial results.
- **Blocked handling**: if any worker reports `confirmation_detected:true`, a non-null `blocked_reason`, or a `diagnostic` (awaiting approval/first-run prompt), `team wait` returns **exit 7** immediately and names the blocked worker(s) on stderr — it does not silently wait out the timeout.
- Exit codes: `0` all done per the chosen mode; `7` a worker is blocked on input; `8` timeout (still-busy workers listed on stderr).

### results

`team results <team>` reads each worker's `result.json` via `result --json <name>` and emits a combined view. Because `result --json` reports a missing file as `present:false` with **exit 0** (not a non-zero exit), `team results` branches on the payload's `.present` → `.valid` → `.body`, never on command success.

`--json` returns an array keyed by worker name, each entry `{name, cli, present, valid, body}`. Exit policy: `0` if every member is `present && valid`; `1` if any member is missing or invalid (the offending members are named on stderr). Missing/invalid results are reported, never silently dropped.

---

## Implementation Plan

### PR A — agent-tmux core (no behaviour change)

- New script: `skills/tmux-agent-tools/scripts/agent-tmux`
  - `preset_for_cli()`: maps cli name → binary, flags, prefix, TMUX_CONF path, env_ns
  - Env precedence: CLI-specific > AGENT_TMUX_* > preset default
  - `$TMUX_AGENT_DIR` fallback to `${XDG_STATE_HOME:-$HOME/.local/state}/tmux-agent-tools`
  - `--role <value>` flag (free-form) in `start` and `resume` (sugar for `--tag role=<value>`)
  - All other commands: delegate to shared logic, parameterised by preset vars
- Convert `claude-tmux`, `codex-tmux`, `agy-tmux` to 1-line shims
- Keep all three shims registered in `install-bin` (symlinks still created)
- **Test gate before merge**: run existing smoke tests via shims to confirm behaviour is identical

### PR B — pair + team (lifecycle + collaboration)

- `pair` command with reconciliation logic, conservative scale-down (orphan warning), exit-code contract, atomic write + per-team lock
- `team` subcommand group: `list`, `workers`, `lead`, `stop` (self-guard), `rm`
- Collaboration primitives: `team broadcast`, `team send`, `team wait`, `team results`
- Per-member `cli` in team state schema (mixed-CLI teams)
- `team list` / `results` authoritative from state file + per-member exact-name live check (no prefix-aware dependency)
- New smoke tests (fake tmux binary, same pattern as `test-sessions-watch-smoke` after fix #231):
  - `test-agent-tmux-pair-smoke`: first pair (start), second pair (resume), reconcile after manual kill, scale-down orphan warning
  - `test-agent-tmux-team-smoke`: list, stop self-guard, rm refusal while live, mixed-CLI member dispatch
  - `test-agent-tmux-collab-smoke`: broadcast dispatches per-member cli, wait-all idle, results gather + missing-result reporting

---

## Future Directions (out of scope for PR A/B)

These are explicitly **deferred** until the tmux backend (PR A + PR B) ships and stabilises. Captured here so the current design keeps the seams clean enough to extend later.

### Runtime / backend adapter seam (tmux today, herdr next)

The vision is "CLI ⨯ terminal-runtime": `agent-tmux` already abstracts the **CLI identity** as a preset. A second, orthogonal seam is the **terminal runtime** that hosts the session. Today that is hardcoded to `tmux` (send-keys / capture / pane scraping to infer state). A future `agent-runtime` abstraction could treat the runtime as pluggable:

- **Backend #1 — tmux** (current): state inferred from pane capture + `status --json`.
- **Backend #2 — [herdr](https://herdr.dev/)**: a terminal-native agent runtime (single Rust binary) that provides tmux-style persistence, mouse-native panes, a **native agent state machine** (`idle` / `working` / `blocked` / `done`), and **an API agents can drive**. herdr's native states map almost 1:1 onto our `running` / `idle` / `blocked_reason` model, and its API would replace brittle `send-keys`/pane-scraping with a structured contract.

Implication for current work: keep the state model (`status --json` fields, `result.json` schema, `wait`/marker semantics) **runtime-agnostic** so a herdr adapter can satisfy the same contract without changing `pair`/`team` logic. No herdr code in PR A/B — just don't bake tmux-only assumptions into the public contract.

---

## Resolved Design Questions

| Question | Decision |
|---|---|
| Shim longevity | Keep as shims indefinitely — zero maintenance cost |
| `--worker-cli` default | Same CLI as lead |
| Lead auto-tag | Explicit `--role lead` required; no-op if not a managed session |
| Env namespace for unknown CLIs | `AGENT_TMUX_*` as fallback; CLI-specific takes precedence |
| `TMUX_CONF` collision | Scoped to `/tmp/agent-tmux-<cli>.tmux.conf` |
| `--tag` availability | Confirmed implemented in `start_session` (line 2033) and `resume_session` (line 2323) |
| Collaboration primitives | Full set in PR B: `broadcast`, `send`, `wait`, `results` |
| Scale-down | Conservative — surplus workers warned as `orphan`, never auto-stopped |
| Team cleanup | `team stop` retains state file; `team rm` deletes it (refuses while members live) |
| `role` values | Free-form string; no enum constraint |
| Preset extensibility | Hardcoded in script (YAGNI); unknown-CLI fallback covers ad-hoc cases |
| Prefix migration risk | None — `claude-cli`/`codex-cli` already current values |
| Mixed-CLI teams | In scope; `cli` is per-member in state schema |
| `team list` prefix-awareness | Resolved via state-file-authoritative + exact-name live check; deferred inventory work not required |
| Concurrency | Atomic state-file write + per-team `mkdir` lock |
| `$TMUX_AGENT_DIR` fallback | `${XDG_STATE_HOME:-$HOME/.local/state}/tmux-agent-tools` |
