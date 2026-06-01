# Contracts and concurrency

Read this when reading or writing `result.json`, parsing `status --json`, planning a transcript log, or coordinating multiple orchestrators against the same agent name.

## `status --json` stable fields

The shared automation contract for both `claude-tmux status --json` and `codex-tmux status --json`. Stable fields:

- `tool` — `claude` or `codex`
- `name` — agent name
- `session` — full tmux session name
- `prefix` — tmux prefix used
- `exists` — tmux session present
- `running` — false when the pane shows the wrapper's local or remote exit-code marker even if the tmux session still exists for capture
- `exit_detected` — wrapper observed CLI exit
- `local_or_remote` — best-effort
- `diagnostic` — best-effort (e.g. `confirmation_detected`)

Treat `local_or_remote` and `diagnostic` as best-effort; the other fields are stable.

## `result.json` (agent → parent contract)

Agents write `result.json` at `$TMUX_AGENT_DIR/<name>/result.json` with this shape:

```jsonc
{
  "schema_version": 1,
  "status": "ok" | "blocked" | "error",
  "summary": "one-line human-readable summary",
  "artifacts": [{"kind": "pr|file|url", "ref": "PR-1234"}],
  "errors": [{"code": "...", "message": "...", "remediation": "..."}],
  "verdict": {
    "verdict": "ACCEPT|BLOCK|ACCEPT_WITH_CHANGES",
    "blockers": ["blocking issue, if any"],
    "marker": "review marker or completion marker"
  },
  "decision": {
    "decision_by": "agent|user|owner|delegate",
    "delegate_name": "optional delegate name",
    "authority": "why this actor can decide",
    "scope": "decision boundary",
    "decision": "what was decided",
    "evidence": ["supporting artifact or observation"],
    "limits": ["known limitation or excluded scope"]
  }
}
```

`verdict` and `decision` are optional Wave 2 blocks. The lightweight validator checks `verdict.verdict` against `ACCEPT`, `BLOCK`, and `ACCEPT_WITH_CHANGES`; checks `verdict.blockers` is an array; and checks `decision.decision_by` against `agent`, `user`, `owner`, and `delegate`.

Parent reads it via `result --json --wait <seconds> <name>`. Always branch in this order before consuming `.body`:

1. `.present` — file existed
2. `.valid` — parsed as JSON
3. `.body` — the actual payload

Worked example:

```bash
$ codex-tmux result --json --wait 30 worker
{
  "present": true,
  "valid": true,
  "body": {"schema_version": 1, "status": "ok", "summary": "Refactor complete; 3 files changed.", "artifacts": [{"kind": "file", "ref": "src/auth/login.rs"}], "errors": []}
}
```

If `.present:false`, the agent never wrote the file — re-prompt it explicitly with the literal result path.

### Why the worker can't use `$TMUX_AGENT_RESULT`

Agent CLIs run tool commands in a sandboxed environment that does not inherit the tmux session environment, so `$TMUX_AGENT_RESULT` is empty inside the worker. Orchestrators should get the literal absolute path with `result --path <name>`, embed that path in the worker prompt, and optionally run `result init <name>` first.

Result helpers available in both wrappers:

| Command | Behavior |
| --- | --- |
| `result --path <name>` | Prints the literal `$TMUX_AGENT_DIR/<name>/result.json` path and exits `0`, without requiring the file to exist. |
| `result init <name>` | Writes `$TMUX_AGENT_DIR/<name>/result.json` as a valid skeleton: `schema_version:1`, `status:"ok"`, empty `summary`, `artifacts`, and `errors`. Exits `0` after writing the file path. |
| `result validate <name> --json` | Validates `result.json` with the recorded schema path, or the bundled result schema when none was recorded. Valid files exit `0` with `valid:true`; missing files exit `1`; malformed or contract-invalid files exit `2` with `valid:false` and `errors[]`. |
| `result wait-required <name> --fields status,summary,artifacts --wait 60 --json` | Polls until the file exists and every named field is non-empty. Success exits `0` with the normal `result --json` payload; timeout exits `1` with JSON including `timeout:true` and `missing_fields`. Usage errors exit `2`. |

## Approval-gate state file

When `wait-and-capture --pause-until-file` is blocking, `$TMUX_AGENT_DIR/<name>/approval-status.json` shows `state: "awaiting_approval"`. Inspect it from a second shell while the gate is open.

Exit codes from `wait-and-capture --pause-until-file`:

- `0` — operator wrote `approve` (or non-`reject` content)
- `7` — operator wrote `reject`
- `8` — `--pause-timeout` expired

## Concurrency model

- **Single caller per agent name.** Two `start --exact same-name` kills the first session.
- Wrapper state under `$TMUX_AGENT_DIR/<name>/` (`started_at`, `marker_seen`, `transcript-path`, etc.) is NOT lock-protected today. Do not share one agent name across two orchestrators.
- The `marker_seen` FIFO is capped at 100 entries — oldest evicted first.
- Multiple agents under different names are independent. `tmux-agent-sessions list --json` is a safe read across all of them.

## Cost accounting

- Per-turn usage capture is design-only today. When it lands, usage goes to `$TMUX_AGENT_DIR/<name>/usage.jsonl` with `schema_version: 1` and is aggregated via `status --usage` / `usage --top N`.
- `--max-runtime` / `--max-idle` / `--max-cost` fuses are roadmap, not implemented.
- For now: transcript size as proxy + your provider's billing dashboard.

## Inventory across wrappers

`tmux-agent-sessions list` is a read-only aggregate across Claude, Codex, and dialogue sessions. Use it when you don't know which wrapper owns a session name:

```bash
tmux-agent-sessions list --name worker     # which tool owns "worker"?
tmux-agent-sessions resolve --name worker --json
tmux-agent-sessions list --json
tmux-agent-sessions list --created-after 2026-01-01T00:00:00Z --json
tmux-agent-sessions diff --since 2026-01-01T00:00:00Z --json
tmux-agent-sessions list --tool claude --state running
tmux-agent-sessions list --sort tool|name|session|state
```

Claude and Codex inventory rows reuse wrapper status fields and add `state` so exited-but-capturable sessions are visible before cleanup. Wave 3 inventory rows also include `wrapper`, `agent_name`, `tmux_session`, `cwd`, `created_at`, `age`, `running`, and `result_path` for recovery workflows.

`resolve --name <partial-or-full-name> --json` is the adopt-before-start path. It never creates or stops sessions; it returns the owning wrapper plus safe next commands for `status`, `wait-and-capture`, and `result`. Ambiguous and missing names exit non-zero with JSON on stderr.

Bulk cleanup is destructive — always preview first:

```bash
tmux-agent-sessions cleanup --preview
tmux-agent-sessions cleanup --preview --created-after 2026-01-01T00:00:00Z --json
tmux-agent-sessions cleanup --execute --tool claude --state exited   # only with user authorization
```

For accidental worker creation, record a timestamp first, inspect `diff --since <timestamp> --json`, preview with `cleanup --preview --created-after <timestamp>`, then execute only the narrowed filter. `cleanup --execute` refuses dirty managed worktrees unless `--force` is passed.
