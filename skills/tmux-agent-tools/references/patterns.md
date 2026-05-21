# Operational Patterns

Read this when picking the right primitive for a recurring task: completion signaling, token-efficient capture, structured agent results, or recovering from common failure modes.

## Completion signaling

Pick the cheapest primitive that meets the need.

| Need | Use | Cost | Cross-process |
| --- | --- | --- | --- |
| "Is pane idle?" | `status --json` → `idle_seconds` | 1 capture-pane | yes |
| "Did marker appear?" | `wait-literal <text>` | poll until found | no (in-process) |
| "Marker + tail in one call" | `wait-and-capture --marker ... --tail N` | poll + 1 capture | no |
| "Notify when CLI exits" | `start --sentinel /path`; watch the file | filesystem-event | yes |
| "Run code on CLI exit" | `start --sentinel ... --on-exit 'cmd'` | hook runs in pane shell | yes |
| "Run code on CLI start" | `start --on-start 'cmd'` | detached subshell | yes |
| "Aggregate inventory state" | `tmux-agent-sessions list --json` | one pass over sessions | yes |

`--on-exit` requires `--sentinel`. The wrapper warns and ignores `--on-exit` without it.

## Token-efficient capture

Default `capture` dumps raw scrollback — mostly ANSI escapes, banners, and pre-marker noise. Prefer the structured paths:

| Pattern | Why it saves tokens |
| --- | --- |
| Agent writes `$TMUX_AGENT_RESULT`, parent reads the file | Parent never reads pane scrollback. Token cost = result body, not pane history. |
| `capture --strip-ansi --since-marker '[T02]' --tail 80` | Strips CSI/SGR + trims pre-marker noise before returning. |
| `wait-and-capture --marker '[DONE]' --tail 80 --strip-ansi --json` | One round-trip for "is it done + here is the relevant tail". |
| `status --json` → `idle_seconds` / `marker_seen[]` | Liveness without reading any pane bytes. |
| `start --transcript /tmp/run.jsonl` | All wrapper events go to disk; replay later without re-capture. |

## Result file contract

Agents write a structured result so the parent never has to parse pane scrollback. Path: `$TMUX_AGENT_RESULT` = `$TMUX_AGENT_DIR/<name>/result.json`.

```jsonc
{
  "schema_version": 1,
  "status": "ok" | "blocked" | "error",
  "summary": "one-line human-readable summary",
  "artifacts": [{"kind": "pr|file|url", "ref": "PR-1234"}],
  "errors": [{"code": "...", "message": "...", "remediation": "..."}]
}
```

Parent reads it via `result --json --wait <seconds> <name>` and branches on `.present` (file existed) then `.valid` (parsed as JSON) before consuming `.body`. This separation matters when the agent crashed before writing.

## Status JSON contract

`status --json` is the stable automation surface. The fields you can rely on:

| Field | Meaning |
| --- | --- |
| `tool` | `claude` or `codex` |
| `name`, `session`, `prefix` | identifiers |
| `exists` | tmux session exists |
| `running` | wrapper sees no local/remote exit marker yet |
| `exit_detected` | wrapper saw the exit-code marker |
| `idle_seconds` | seconds since last pane change |
| `marker_seen[]` | FIFO of seen markers (cap 100, oldest evicted) |

`local_or_remote` and `diagnostic` are best-effort and may change shape. The rest are stable contract.

`running:false` is correct even when the session still exists for capture — the pane is kept open after CLI exit so failures stay inspectable.

## Failure mode cheatsheet

| Symptom | Likely cause | First action |
| --- | --- | --- |
| `wait-text` times out but pane has the text | regex metachar in marker | switch to `wait-literal` or `wait-text --literal` |
| `wait-literal` returns immediately | stale marker from previous turn | use `send-wait-literal` instead |
| `status --json` says `running:true` but no progress | CLI sitting on a permission prompt | check `diagnostic` field; attach + answer |
| `--on-exit` hook never logged | `--on-exit` set without `--sentinel` | add `--sentinel <path>` |
| `result.json` missing after agent says "done" | agent never wrote `$TMUX_AGENT_RESULT` | re-prompt: "write $TMUX_AGENT_RESULT before signaling done" |
| Pane shows exit code marker but session lingers | normal — wrapper keeps the pane open for inspection | `stop <name>` to clean up |

## Concurrency model

- One caller per agent name. Two `start --exact same-name` kills the first session.
- Wrapper state under `$TMUX_AGENT_DIR/<name>/` is **not** lock-protected. Don't share one agent name across two orchestrators.
- `marker_seen` FIFO is capped at 100 entries; oldest evicted first.
- Different agent names are independent; `tmux-agent-sessions list --json` is a safe read across all of them.

## Cost accounting

Per-turn usage capture is roadmap, not implemented. For now, account cost via transcript size as proxy plus the provider's billing dashboard. Once implemented, usage will go to `$TMUX_AGENT_DIR/<name>/usage.jsonl` with `schema_version: 1`.
