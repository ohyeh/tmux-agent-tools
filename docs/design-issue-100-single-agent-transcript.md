# Design — Issue #100: Single-agent JSONL transcript

Status: draft, not implemented. Reuses the existing `tmux-agent-dialogue`
transcript machinery for single-agent sessions.
Tracking: https://github.com/ohyeh/tmux-agent-tools/issues/100
Related: RFC #109 L3 Observability; shares schema with the dialogue
transcript work that landed in v0.5.0.

## Problem

`tmux-agent-dialogue` already writes a JSONL transcript with per-turn,
failure, and blocked events. That format passed schema validation in
v0.5.0 and is the canonical audit trail for bounded two-agent runs.

Single-agent sessions started via `claude-tmux start` / `codex-tmux start`
have no equivalent. The only history is the tmux pane scrollback, which
the wrapper truncates with `capture-pane -S -N`. Anything older is gone.

## Goal

Add `--transcript <abs-path>` to `start` / `resume` / `start-ssh`. When
present:

- the wrapper appends a `start` event on launch;
- subsequent `send` / `wait` / `wait-text` / `wait-literal` /
  `send-wait-literal` / `capture` / `stop` subcommands append matching
  events when invoked with the same agent name;
- the file is JSONL (one JSON object per line), append-only, atomic per
  line.

Non-goals:

- no live tail-tooling (`tmux-agent-tools transcript watch` is a
  follow-up);
- no automatic redaction (callers already have
  `tmux-agent-dialogue summarize --redact-pattern`);
- no remote transcript writing on `start-ssh` (transcript stays on the
  host that runs the wrapper subcommands).

## Event schema (v1, shared with dialogue)

Each line is one of:

```jsonc
{"event":"start","tool":"codex","name":"w","session":"codex-cli-w","cwd":"/path","at":"2026-05-20T20:50:00Z","schema_version":1}
{"event":"send","name":"w","text":"...","at":"...","schema_version":1}
{"event":"wait","name":"w","style":"literal","marker":"[T02]","matched":true,"elapsed_seconds":12.4,"at":"...","schema_version":1}
{"event":"wait","name":"w","style":"regex","marker":"Done|Need approval","matched":false,"elapsed_seconds":180,"reason":"timeout","at":"...","schema_version":1}
{"event":"capture","name":"w","lines_requested":80,"lines_returned":42,"flags":{"strip_ansi":false,"since_marker":null},"at":"...","schema_version":1}
{"event":"exit","name":"w","exit_code":0,"sentinel_path":"/tmp/w.exit","at":"...","schema_version":1}
{"event":"stop","name":"w","stopped":true,"at":"...","schema_version":1}
```

Required keys on every event: `event`, `name`, `at`, `schema_version`.
Times are ISO-8601 UTC.

## Sharing with dialogue transcript

The existing dialogue transcript writer should be extracted to a small
helper (`scripts/lib/tmux-agent-transcript.sh` or equivalent) used by
both `tmux-agent-dialogue` and the single-agent wrappers. This avoids
schema drift.

Minimum helper surface:

```
tmux_agent_transcript_append <path> <json-object>
tmux_agent_transcript_init <path>
```

`init` writes the `start` line plus permissions setup; `append` uses
`flock` + `printf >> path` for atomic line append on POSIX systems.

## CLI surface additions

`--transcript <abs-path>` on:

- `start`, `start-ssh`, `resume`: opens transcript and writes the
  `start` event. Stale-file policy: same as `--sentinel`, refuse if the
  file exists (avoid mixing runs).
- `send`, `wait`, `wait-text`, `wait-literal`, `send-wait-literal`,
  `capture`, `stop`: read the transcript path from a per-session env
  cache so subsequent invocations can append without the caller
  re-passing the path. Cache lives at
  `$TMUX_AGENT_DIR/<name>/transcript-path`.

If `--transcript` was never passed to `start`, subsequent subcommands
write nothing. No change from today.

## Validation reuse

`tmux-agent-dialogue validate-transcript --schema-version 1` already
checks the dialogue schema. Extend the validator to accept the new
event types (`send`, `wait`, `capture`, `exit`, `stop`) or — cleaner —
share one schema definition that covers both dialogue and single-agent
events. Either path is acceptable; the second avoids future drift.

## Test plan

Synthetic flow (no real CLI required):

1. `start --exact --transcript /tmp/w.jsonl w /tmp` (with fake CLI).
2. `send w 'hello'`.
3. `wait-literal w '[DONE]' 5` (expect timeout).
4. `capture w 20`.
5. `stop w`.
6. Assert `/tmp/w.jsonl` has 5 lines, each valid JSON, each with
   `schema_version: 1`, and the `wait` event has `matched: false` +
   `reason: "timeout"`.
7. Pipe `/tmp/w.jsonl` through `tmux-agent-dialogue
   validate-transcript --schema-version 1` and expect zero failures.

## Rollout

1. Land this design.
2. Extract dialogue transcript writer into a shared helper.
3. Wire `--transcript` into `start` only.
4. Wire append into `send` / `wait*` / `capture` / `stop`.
5. Add validator coverage for new event types.
6. Mirror to claude-tmux.
7. README: add "Single-agent transcript" subsection.

## Risk and trade-offs

- Per-session env cache (`transcript-path` file) is the simplest way to
  let later subcommands find the path without API change. Alternative
  considered: write the path into a tmux user-option per session;
  rejected because tmux user-options are session-local but read-only
  outside the session and would require shelling into the session.
- Atomic append with `flock` works on macOS and Linux. Without `flock`
  available, fall back to writing through `printf` and accept rare
  races (event ordering may interleave under heavy parallel sends).
  Same compromise dialogue already accepts.
- Schema version stays at 1. Any change to required keys bumps version
  and updates the validator.
