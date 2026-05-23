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

Agents write `$TMUX_AGENT_RESULT` (path: `$TMUX_AGENT_DIR/<name>/result.json`) with this shape:

```jsonc
{
  "schema_version": 1,
  "status": "ok" | "blocked" | "error",
  "summary": "one-line human-readable summary",
  "artifacts": [{"kind": "pr|file|url", "ref": "PR-1234"}],
  "errors": [{"code": "...", "message": "...", "remediation": "..."}]
}
```

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

If `.present:false`, the agent never wrote the file — re-prompt it explicitly: "Before signaling done, write your conclusion to `$TMUX_AGENT_RESULT` with `schema_version:1`."

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
tmux-agent-sessions list --json
tmux-agent-sessions list --tool claude --state running
tmux-agent-sessions list --sort tool|name|session|state
```

Claude and Codex inventory rows reuse wrapper status fields and add `state` so exited-but-capturable sessions are visible before cleanup.

Bulk cleanup is destructive — always preview first:

```bash
tmux-agent-sessions cleanup --preview
tmux-agent-sessions cleanup --execute --tool claude --state exited   # only with user authorization
```
