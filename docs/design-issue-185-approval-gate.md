# Approval Gate Runtime Contract (issue #185)

`wait-and-capture --pause-until-file <path>` provides a synchronous
human-in-the-loop approval gate for `claude-tmux` and `codex-tmux`.
v0.10.0 (issue #114) shipped only the argv-parsing surface; #185 wires
in real polling, decision parsing, status surface, transcript event,
audit event, and exit codes.

## Flow

1. `wait-and-capture` runs as normal: poll the tmux pane for `--marker`
   until either matched or `--timeout` fires.
2. If `--pause-until-file <path>` is set AND the marker matched, the
   wrapper enters the approval gate:
   - Writes `awaiting_approval` to the per-agent status file
     (`$TMUX_AGENT_DIR/<name>/approval-status.json`).
   - Polls `<path>` every 1s.
3. Decision is read from the file content (case-insensitive, leading
   whitespace tolerated, only the first token matters):
   - starts with `approve` → resume, exit 0
   - starts with `reject` → exit 7, remaining content captured as reason
   - any other non-empty content → treated as reject with diagnostic
   - file missing or empty → keep waiting
4. If `--pause-timeout <seconds>` is set and elapses before any decision
   is written, the wrapper resolves the gate with `timeout` and exits 8.
   When `--pause-timeout` is unset (default), the wrapper waits forever.
5. On resolution, the status file is overwritten with the final
   `state: "resolved"` record (including `decision` and `reason`).

The wrapper never deletes the marker file — the operator owns its
lifecycle.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | matched + approved (or no gate configured) |
| 7 | gate decision = reject |
| 8 | gate decision = pause-timeout |

These are additive to the existing `wait-and-capture` exit semantics
(non-zero on `timeout` unless `--no-timeout-error`). See
`docs/ci-mode-exit-codes.md`.

## Status surface

`$TMUX_AGENT_DIR/<name>/approval-status.json` is a single JSON object,
rewritten on each transition:

```json
{
  "schema_version": 1,
  "state": "awaiting_approval",
  "marker_path": "/tmp/agent-7/approve.txt",
  "decision": null,
  "reason": null,
  "at": "2026-05-21T01:30:00Z"
}
```

On resolution, `state` becomes `resolved` and `decision` is one of
`approve` / `reject` / `timeout`.

## Transcript event

When a transcript is configured, a single line is appended:

```json
{
  "schema_version": 1,
  "kind": "approval",
  "name": "worker",
  "decision": "approve",
  "marker_path": "/tmp/agent-7/approve.txt",
  "decided_at": "2026-05-21T01:30:00Z"
}
```

## Audit event

When `TMUX_AGENT_TOOLS_AUDIT_LOG` (#119) is set, a chained event is
appended:

```json
{
  "schema_version": 1,
  "event": "approval.approve",
  "tool": "claude",
  "name": "worker",
  "marker_path": "/tmp/agent-7/approve.txt",
  "at": "2026-05-21T01:30:00Z",
  "prev_chain_hash": "...",
  "chain_hash": "..."
}
```

`event` is one of `approval.approve`, `approval.reject`,
`approval.timeout`.

## Out of scope (deferred)

- Webhook / exec decision handlers (still deferred).
- Multi-approver / quorum gating.
- Markdown-rich reasons.
