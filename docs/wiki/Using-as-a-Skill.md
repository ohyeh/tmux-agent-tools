# Using as a Skill

For **agent operators** and **automation scripts** that treat tmux-agent-tools as a programmable substrate.

## Mental model

Every command falls into one of four categories:

| Category | Commands | What it does |
| --- | --- | --- |
| **Lifecycle** | `start`, `resume`, `stop` | Create / continue / kill a tmux-managed agent session |
| **I/O** | `send`, `send --from-file`, `send-wait-literal` | Push prompts into the agent without attaching to the pane |
| **Wait** | `wait`, `wait-text`, `wait-literal`, `wait-and-capture` | Block until the agent reaches a known state |
| **Read** | `capture`, `status`, `probe`, `result` | Surface what the agent has done |

You orchestrate by interleaving these. Most automation looks like: `start → send → wait → result → stop`.

## Stable contracts you can build against

These surfaces have `schema_version: 1` and are safe to script against.

### `status --json <name>`

Stable fields: `tool`, `name`, `session`, `prefix`, `exists`, `running`, `exit_detected`, `idle_seconds`, `marker_seen[]`. `local_or_remote` and `diagnostic` are best-effort.

`running:false` is correct even when the session still exists for capture — the pane is kept open after CLI exit so failures stay inspectable.

### `result --json --wait <seconds> <name>`

Reads `$TMUX_AGENT_DIR/<name>/result.json`. Output keys: `present` (file existed), `valid` (parsed as JSON), `body` (the JSON payload). Always branch on `.present` then `.valid` before consuming `.body`.

### `capture --json --strip-ansi --since-marker '<m>' --tail N`

Token-efficient capture path. Strips CSI/SGR + trims pre-marker noise before returning. Use this instead of raw `capture` when you only need the relevant tail.

### `wait-and-capture --marker '<m>' --tail N --json`

One round-trip for "is the marker present + here is the recent tail". Cheaper than `wait` + separate `capture`.

### `send --from-file <abs-path> --enter-count N <name>`

Use this for large or multi-line prompts. It holds the same send-lock as
`send <text>`, uses tmux paste-buffer, records transcript metadata
(`multiline`, `bytes`, `text_sha256`), and emits a body-free `send.multiline`
audit event when audit logging is enabled.

### `probe --metric <metric> --json <name>`

Wrapper-local parser for CLI progress indicators. Claude metrics:
`context_percent`, `goal_active`, `active_spinner`. Codex metrics: `progress`,
`tool_active`, `approval_pending`. Output carries `value`, `confidence`, and
`parsed_from`, so orchestrators can detect low-confidence parsing instead of
silently trusting stale regexes.

## Marker discipline

Markers are how you teach the agent to signal completion. Three rules:

1. **Use literals, not regex**, when the marker contains `[`, `]`, `(`, `)`, `.`, `*`, `?`. Use `wait-literal` or `wait-text --literal`. Regex `wait-text` is for cases where regex is actually wanted.
2. **Don't let the prompt echo satisfy the wait**. Either keep the literal out of the prompt body, or split it across two lines so the prompt text alone doesn't contain the joined form.
3. **Use `send-wait-literal` after the first turn**. Stale pane content from previous turns may already contain old markers — `send-wait-literal` waits for a *new* occurrence relative to the send.

## Cross-process completion signaling

If your orchestrator is not the same process that called `start`, polling `status --json` is fine but wasteful. Pass `--sentinel /path/to/file` to `start`; the wrapper writes the exit code to that path when the CLI exits. Watch the file with `inotifywait` / `fswatch` / a tight `until` loop. For "run code on CLI exit" use `--sentinel ... --on-exit 'cmd'`; the hook runs in the pane's shell.

`--on-exit` without `--sentinel` is silently ignored. Pair them.

## Result file contract

Make the agent write `$TMUX_AGENT_RESULT` (a path the wrapper sets) with this shape:

```jsonc
{
  "schema_version": 1,
  "status": "ok" | "blocked" | "error",
  "summary": "one-line human-readable summary",
  "artifacts": [{"kind": "pr|file|url", "ref": "PR-1234"}],
  "errors": [{"code": "...", "message": "...", "remediation": "..."}]
}
```

Once the agent writes this file, your orchestrator never has to parse pane scrollback. Token cost = result body, not pane history.

In your prompt, be explicit: **"Write `$TMUX_AGENT_RESULT` before signaling done"**. Agents sometimes forget; the prompt is the contract.

## Concurrency rules

- One caller per agent name. Two `start --exact same-name` kills the first session.
- Wrapper state under `$TMUX_AGENT_DIR/<name>/` is **not** lock-protected today. Don't share one agent name across two orchestrators.
- Different agent names are independent — `tmux-agent-fanout` relies on this.

## Programmatic patterns

| Pattern | Commands |
| --- | --- |
| Fire-and-forget single agent with structured result | `start --transcript ... --sentinel ... ; wait for sentinel ; result --json` |
| Inject large handoff / goal packet | `send --from-file /abs/prompt.md --enter-count 3 <name>` |
| Poll CLI-specific progress | `probe --metric context_percent --json <name>` |
| Long-running agent with mid-run human approval | `wait-and-capture --pause-until-file <marker>` ([approval gate recipe](Recipes#approval-gate)) |
| Parallel agents on one prompt | `tmux-agent-fanout run --agent ... --result-dir ...` ([fanout recipe](Recipes#fanout)) |
| Dependency-ordered pipeline | `tmux-agent-dag <manifest.json>` ([DAG recipe](Recipes#dag)) |
| Two-agent critique | `tmux-agent-dialogue critic ...` |

## What to read next

- [Recipes](Recipes) — concrete copy-pasteable workflows
- [Observability and Secrets](Observability-and-Secrets) — audit log, redaction, secret backends
- [Troubleshooting](Troubleshooting) — failure modes you'll hit
