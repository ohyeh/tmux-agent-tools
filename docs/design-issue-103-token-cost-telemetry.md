# Design — Issue #103: Token / cost telemetry

Status: draft, not implemented.
Tracking: https://github.com/ohyeh/tmux-agent-tools/issues/103
Related: RFC #109 L3 Observability; feeds #105 max-cost fuse and the
v0.6 "machine-readable contracts" theme.

## Problem

Both Claude Code and Codex CLI can emit per-turn token usage and
estimated cost as structured JSON, but the wrappers today do not
capture or aggregate any of it. Operators have no answer to "how much
did this session burn".

## Goal

Capture per-turn usage JSON to a session-local `usage.jsonl`, and add a
`status --usage` aggregator. Stay decoupled from any specific CLI's
schema: the wrapper records whatever the CLI emits and aggregates the
small set of well-known fields.

Non-goals:

- no cost prediction or budgeting (`--max-cost` fuse is #105);
- no cross-session aggregation beyond the `usage --top N` rollup;
- no transmission of usage data to any external service.

## Capture path

Two CLIs, two streams:

| CLI | Mechanism | File written |
|---|---|---|
| Claude Code | `claude --output-format stream-json` (or current equivalent) emits JSON per turn including usage fields. Tee stdout into `usage.jsonl`. | `$TMUX_AGENT_DIR/<name>/usage.jsonl` |
| Codex CLI | Codex emits usage as part of its JSON event stream when run with the appropriate flag. Same tee pattern. | same path |

The exact CLI flag must be probed via the CLI's `--help` at wrapper
load time and stored in `$TMUX_AGENT_DIR/<name>/usage-cmd` so the
wrapper does not need to re-probe per `send`.

If the CLI does not support a stream-JSON flag (older versions), the
wrapper writes a single line:

```json
{"event":"usage_unavailable","reason":"cli_flag_missing","at":"2026-05-20T20:55:00Z"}
```

and `status --usage` returns `{"usage":"unavailable","reason":"cli_flag_missing"}`.

## Aggregation

`status <name> --usage` walks `usage.jsonl` and folds the well-known
fields:

```json
{
  "input_tokens": 12034,
  "output_tokens": 2104,
  "cache_read_tokens": 9000,
  "cache_write_tokens": 1024,
  "cost_usd": 0.0382,
  "turns": 4,
  "schema_version": 1
}
```

`turns` = count of usage events. Fields are nullable: if the CLI never
reported cost, `cost_usd` is null and a `note` array explains which
sources contributed.

`status --usage --json` is the stable machine-readable form. Existing
status fields are not touched; usage is additive.

## `usage` subcommand

```
<wrapper> usage [--top N] [--json] [--since <ISO-8601>]
```

| Flag | Behavior |
|---|---|
| (none) | print a 4-column table of all sessions: name / tokens / cost / turns, sorted by cost descending |
| `--top N` | limit to N rows |
| `--json` | machine-readable, same shape as a JSON array of `status --usage --json` payloads |
| `--since <ts>` | only fold usage events with `at >= ts`; useful for daily/hourly rollups |

Scope: walks all `$TMUX_AGENT_DIR/*/usage.jsonl` files. Does not network.

## `tmux-agent-sessions list` integration

`list --json` already emits per-session rows. Adding usage requires
opening `usage.jsonl` for each row, which is heavier than the current
read-pane-state pattern.

Compromise: add `--with-usage` flag on `list`; off by default.

## Schema (per usage.jsonl line)

```jsonc
{
  "event":"turn_usage",
  "tool":"claude",
  "cli_session_id":"019e4555-...",
  "input_tokens":1024,
  "output_tokens":256,
  "cache_read_tokens":512,
  "cache_write_tokens":0,
  "cost_usd":0.0041,
  "at":"2026-05-20T20:55:01Z",
  "schema_version":1
}
```

All fields except `event`, `tool`, `at`, `schema_version` are optional.
Aggregation treats missing fields as 0 (for tokens) or null (for cost).

## Test plan

Fake CLI emitting two usage lines on stdout:

```sh
#!/bin/sh
printf '%s\n' '{"event":"turn_usage","input_tokens":100,"output_tokens":50,"cost_usd":0.001,"at":"2026-05-20T20:55:01Z","schema_version":1}'
printf '%s\n' '{"event":"turn_usage","input_tokens":200,"output_tokens":80,"cost_usd":0.002,"at":"2026-05-20T20:55:02Z","schema_version":1}'
exit 0
```

| Case | Expected |
|---|---|
| `start` with fake-CLI | `usage.jsonl` contains two lines |
| `status --usage` | input=300, output=130, cost=0.003, turns=2 |
| `usage --top 5` | table includes the session |
| Fake CLI without usage emission | `status --usage` returns `unavailable` |
| Multiple sessions | `usage` rolls up all, sorted by cost desc |

## Risk and trade-offs

- Tee-ing stdout into `usage.jsonl` requires intercepting the CLI's
  output stream BEFORE tmux paints the pane. On platforms where this
  is awkward, the wrapper can run `tee` inside the same inline shell
  command that already handles the launch+exit pattern. Same
  shell-quoting risk as #95 — should land after #95 settles on main.
- Per-turn usage data is sensitive (model name, costs). Document that
  `usage.jsonl` is local-only and should not be auto-uploaded.
- Schema version is independent from the transcript schema in #100.
  Two distinct streams with different ownership: transcript is the
  wrapper's narrative; usage is the CLI's billing record.

## Rollout

1. Land this design.
2. Probe + capture phase: wire stdout tee into `usage.jsonl`.
3. `status --usage` aggregator.
4. `usage` cross-session subcommand.
5. `list --with-usage` integration.
6. README + SKILL.md "cost accounting" section.
