# Remaining Backlog — Designs + v1 Slice Per Issue

Status: design-doc-only batch. Each section names the v1 implementation
slice we propose to ship next, and lists what stays deferred.

Issues covered:
- #103 token / cost telemetry
- #111 checkpoint / restore
- #120 CI mode
- #122 scheduled runs (cron)
- #123 TUI dashboard
- #127 recording fixture for tests
- #129 history search + diff

Each has a corresponding existing GitHub issue with the full spec.
This file is intentionally short — it captures the scope decision so
the next PR per issue has a clear contract to land against.

---

## #103 Token telemetry — `usage.jsonl` skeleton

### v1 slice (next PR)
- `--usage <abs.jsonl>` flag on `start` / `resume` declares the
  per-agent usage stream path. Falls back to
  `$TMUX_AGENT_DIR/<name>/usage.jsonl` when unset.
- `start` always writes a single `{event: "usage_init", at, schema_version: 1}`
  line so consumers can detect the file exists.
- `status --usage` reads the file and emits aggregated counts:
  `{schema_version: 1, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, turns, note: []}`.
  Missing-data fields are null with a note explaining "no usage data
  captured yet".

### Deferred (v2+)
- Tee-ing CLI stdout into the usage stream — the design doc's main
  mechanism but it requires TTY interception that conflicts with the
  CLI's interactive shell.
- `usage --top N` cross-session rollup.
- Cost prediction / `--max-cost` fuse (depends on real usage data).

### Why slice this small
The skeleton establishes the file path + aggregator contract. Future
work can drop in any usage-source (stdio tee, JSON event stream,
explicit agent-side writes) without changing the consumer surface.

---

## #111 Checkpoint / restore

### v1 slice
- `claude-tmux checkpoint <name> <abs.tar.gz>` packages the agent's
  `$TMUX_AGENT_DIR/<name>/` directory + pane scrollback into a tarball.
- `claude-tmux restore <name> <abs.tar.gz>` is read-only: extracts to
  a `/tmp/restore-<name>-<ts>/` directory and prints the contents.
  Does NOT start a new tmux session from the checkpoint in v1.

### Deferred
- Re-spawning a tmux session from the checkpoint (requires re-keying
  the CLI session ID and CLI-specific resume semantics — non-trivial).
- `--auto-checkpoint --interval` background loop (autonomy concern;
  needs the same watcher-amendment as L5).
- Garbage collection of old checkpoints.

### Why slice this small
Checkpoint-as-file is a simple safety net for long runs; restore-as-
spawn is a separate, harder problem that can ship independently.

---

## #120 CI mode

### v1 slice
- `claude-tmux start --ci` (or env `CLAUDE_TMUX_CI=1`) sets the
  process into a CI-friendly profile:
  - all JSON-capable subcommands emit JSON by default
  - prompt-detection in `status --json` becomes a fatal exit (3) so
    CI fails fast on first-run permission walls
  - color / progress bar fully disabled
  - max-runtime defaults to 600s unless overridden
- Exit code table written into the wrapper and documented as a
  stable contract:
  - 0 = ok
  - 1 = generic error
  - 2 = timeout (matches `124` semantics from #105 fuse)
  - 3 = prompt / permission wall
  - 4 = secret-missing (when #116 lands)
  - 5 = schema validation failed (when #125's `--enforce` lands)

### Deferred
- `doctor --ci` (a GH Actions friendly readiness check).
- Pre-baked GitHub Actions workflow example.
- Auto-injection of `--result-schema` for known templates.

### Why slice this small
The exit code contract is the load-bearing piece — once stable,
downstream CI integrations can be built. The `--ci` flag and a few
JSON-defaults are all the wrapper code change.

---

## #122 Scheduled runs (cron)

### v1 slice
- `tmux-agent-cron add <name> --schedule '0 9 * * *' --command '<cmd>'`
  writes a JSONL entry to `~/.tmux-agent/cron/schedules.jsonl`.
- `tmux-agent-cron list / remove / history <name>` are pure JSONL
  operations.
- Actual scheduling integration (launchd / systemd-timer / crontab)
  is OUT of v1. We ship the catalog tool only; the operator wires
  the catalog into their own scheduler via a documented one-liner.

### Deferred
- Platform abstraction (launchd / systemd-timer / crontab) — needs
  per-platform script generation and is the bulk of the work.
- `--no-overlap` enforcement (requires a watcher).
- `--on-success / --on-failure` chained hooks (use the #95 on-exit
  + #121 notify combo today).

### Why slice this small
The catalog half of cron sugar is useful immediately (you can `cron`
add an entry, then read `cron list` from your custom workflow). The
platform wiring is the hard, system-dependent half; ship that after
v1 once the catalog format is stable.

---

## #123 TUI dashboard

### v1 slice
- `tmux-agent-dashboard --json` emits a single JSON snapshot of all
  live sessions with status + tags + last activity + recent markers.
  No interactive UI — JSON only.
- `tmux-agent-dashboard --watch --interval 2` re-emits the JSON
  snapshot every interval seconds. Consumer-side renders.

### Deferred
- Full ncurses / tput TUI (the "dashboard" half of the name). Adds
  significant terminal-handling code that's better done by an
  external consumer reading our JSON.
- Click-to-drill-down interactions.

### Why slice this small
The interactive UI is value-multiplier #2; the JSON-snapshot tap is
value-multiplier #1 and unblocks any external dashboard (htop-style,
tmux statusbar widget, web UI). Ship the data first, render later.

---

## #127 Recording fixture for tests

### v1 slice
- Document that `--transcript <abs>` already produces a recording
  (no flag rename needed — `--record` becomes an alias for
  `--transcript`).
- New `tmux-agent-replay fixture-validate <jsonl>` subcommand that
  checks the transcript is consistent (no duplicate event ordering,
  ISO timestamps strictly monotonic where applicable).
- `self-test --fixture <jsonl>` runs a round-trip: read transcript,
  count event types, ensure the wrapper would accept the schema.

### Deferred
- `TMUX_AGENT_FIXTURE=...` replay mode that drives a fake CLI from
  the fixture (this is the #126 `run` slice we deferred for LLM
  nondeterminism — only useful when fixture replaces the LLM
  entirely, which is the "fake mode" the dialogue tool already has).

### Why slice this small
The recording half is essentially done (#100 transcript). The
hardest part of "replay from fixture" only makes sense after we
have a clear story for what the fake CLI should DO with each event
type — which is a per-CLI question.

---

## #129 History search + diff CLI

### v1 slice
- `tmux-agent-history index <jsonl>...` builds a SQLite database at
  `~/.tmux-agent/history.db` from transcript files. Schema: one row
  per session with `name`, `started_at`, `ended_at`, `pr_link` (from
  result.json), `cost_usd` (from usage.jsonl when present), `tags`.
- `tmux-agent-history search '<term>'` does FTS5 search over the
  indexed corpus and prints matching session names.
- `tmux-agent-history show <name>` dumps the session's transcript
  inline.

### Deferred
- `--since 7d` time filters (just need date math; trivial in v2).
- `diff a b` (already shipped under `tmux-agent-replay diff` — point
  at it from docs).
- `top --by cost --since 30d` cross-session usage rollups (depends
  on #103 v2 having real cost data).

### Why slice this small
Even just the indexed corpus + fts5 search is the load-bearing piece.
Everything else is filtering and aggregation that we can ship once
the data is in place.

---

## Rollout

This file does NOT close any of the listed issues. Each will close
when its v1-slice PR lands and references the slice section in this
document. The intent is to enable parallel v1-slice agent dispatches
with a clear scope contract per issue.
