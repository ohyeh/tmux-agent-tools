# agent-tmux: Unified CLI Design

_v2 — addresses first-round reviewer concerns_

## Motivation

`claude-tmux` and `codex-tmux` are ~4400-line scripts with only ~600 lines of difference — all mechanical prefix substitution (variable names, binary name, session prefix). `agy-tmux` was already added as a thin preset shim on top of `codex-tmux` (PR #234). As more CLIs appear (cursor, grok, etc.), maintaining N near-identical scripts is unsustainable.

**Goal**: single `agent-tmux` entrypoint, CLI identity as a preset, all existing behaviour preserved.

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

Each CLI maps to a preset. All fields are overridable via env vars (see Env Precedence below).

| cli    | binary  | default launch flags                | session prefix | env namespace   |
|--------|---------|-------------------------------------|----------------|-----------------|
| claude | claude  | `--dangerously-skip-permissions`    | claude-cli     | CLAUDE_TMUX_*   |
| codex  | codex   | `--yolo`                            | codex-cli      | CODEX_TMUX_*    |
| agy    | agy     | `--dangerously-skip-permissions`    | agy-cli        | AGY_TMUX_*      |
| cursor | cursor  | (none)                              | cursor-cli     | CURSOR_TMUX_*   |
| grok   | grok    | (none)                              | grok-cli       | GROK_TMUX_*     |

Unknown CLI: binary = the name, flags = none, prefix = `<cli>-cli`, env namespace = `AGENT_TMUX_*`.

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

### INHERIT / CLEAR env flags for unknown CLIs

For unknown CLIs, `INHERIT_<CLI>_ENV` and `CLEAR_<CLI>_ENV` fall back to `AGENT_TMUX_INHERIT_ENV` and `AGENT_TMUX_CLEAR_ENV`, which default to `0` and `1` respectively (matching existing per-CLI defaults). Named CLIs keep their existing variables.

---

## Role System

Sessions carry a `role` tag stored in the existing `tags.json` infrastructure (`$TMUX_AGENT_DIR/<name>/tags.json`). `--tag` is already implemented in both `start_session` (line 2033) and `resume_session` (line 2323) of `claude-tmux`.

```bash
agent-tmux claude start --role lead   my-project ~/path
# internally: --tag role=lead

agent-tmux codex start --role worker my-project-w1 ~/path
# internally: --tag role=worker
```

`--role` is syntactic sugar for `--tag role=<value>`. All existing `tmux-agent-sessions --tag` filters work unchanged.

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
4. Print each worker name + action (`started` / `resumed`) to stdout

This reconciliation logic prevents stale-state failures when workers are killed manually.

### team stop guard

`team stop <team-name>` detects if any member session matches the current process's own session (via `$TMUX_AGENT_RESULT` path component). If a match is found, that member is skipped with a warning:

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
```

`team list` output:
```
team: my-project
  lead    claude  my-project        running
  worker  codex   my-project-w1     running
  worker  codex   my-project-w2     idle
```

### Team state file

`$TMUX_AGENT_DIR/teams/<team-name>.json`:
```json
{
  "schema_version": 1,
  "team": "my-project",
  "lead_cli": "claude",
  "worker_cli": "codex",
  "members": [
    {"name": "my-project",    "role": "lead",   "cli": "claude"},
    {"name": "my-project-w1", "role": "worker", "cli": "codex"},
    {"name": "my-project-w2", "role": "worker", "cli": "codex"}
  ]
}
```

`team list` merges this static file with live `tmux-agent-sessions` data to show current state.

---

## Implementation Plan

### PR A — agent-tmux core (no behaviour change)

- New script: `skills/tmux-agent-tools/scripts/agent-tmux`
  - `preset_for_cli()`: maps cli name → binary, flags, prefix, TMUX_CONF path, env_ns
  - Env precedence: CLI-specific > AGENT_TMUX_* > preset default
  - `--role <lead|worker>` flag in `start` and `resume` (sugar for `--tag role=<value>`)
  - All other commands: delegate to shared logic, parameterised by preset vars
- Convert `claude-tmux`, `codex-tmux`, `agy-tmux` to 1-line shims
- Keep all three shims registered in `install-bin` (symlinks still created)
- **Test gate before merge**: run existing smoke tests via shims to confirm behaviour is identical

### PR B — pair + team commands

- `pair` command with reconciliation logic
- `team` subcommand group
- `team list` merges team state files + live `tmux-agent-sessions` output
- `team stop` with self-guard
- New smoke test: `test-agent-tmux-pair-smoke`
  - Uses fake tmux binary (same pattern as `test-sessions-watch-smoke` after fix #231)
  - Tests: first pair (start), second pair (resume), reconcile after manual kill

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
