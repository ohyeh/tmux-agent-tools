# Design — Issue #98: Extend `status --json` with liveness fields

Status: draft, not implemented.
Tracking: https://github.com/ohyeh/tmux-agent-tools/issues/98
Related: RFC #109 L3 Observability; feeds #105 max-idle fuse and #96
capture-mode selection.

## Problem

`status --json` today answers "does the session exist and is the CLI
still running" but not "is the CLI actually doing anything, and what
has it produced so far". Callers therefore over-capture or poll blindly.

## Goal

Add five additive fields that let callers reason about liveness without
breaking the stable contract:

| New field | Type | Meaning |
|---|---|---|
| `started_at` | string \| null | ISO-8601 UTC when the wrapper created the tmux session. Null if the session is gone. |
| `last_change_at` | string \| null | ISO-8601 UTC of the most recent pane content change observed by the wrapper. |
| `idle_seconds` | number \| null | Wall-clock seconds since `last_change_at`. Null if pane is not yet created. |
| `bytes_in_pane` | integer \| null | Approximate byte size of the live pane buffer; null if the session does not exist. |
| `marker_seen` | string[] | Distinct markers the wrapper has observed via `wait-literal` / `send-wait-literal` / `--register-marker`. Order = first-seen. |

Non-goals:

- no per-marker count yet (defer to `marker_counts` if a caller needs it);
- no historical timeline (that is `#100` JSONL transcript);
- no removal or rename of existing fields.

## Storage model

State that needs to survive across subcommand invocations lives in
`$TMUX_AGENT_DIR/<name>/`:

| File | Owner | Contents |
|---|---|---|
| `started_at` | start_session | single ISO-8601 line, written at session create |
| `marker_seen` | wait/send-wait variants | newline-separated marker tokens (deduped on read) |

`last_change_at`, `idle_seconds`, and `bytes_in_pane` are computed at
`status` invocation time:

- `last_change_at` = hash the current pane via `capture-pane -p`; compare
  with a stored hash + timestamp pair under `pane-hash`; update if the
  hash changed; otherwise inherit the stored timestamp.
- `idle_seconds` = `now - last_change_at`.
- `bytes_in_pane` = `wc -c` of the captured pane buffer (live, not
  scrollback).

This keeps `status` cheap and stateless across the rest of the system.

## CLI surface additions

A single new optional flag on `wait-literal` / `send-wait-literal`:

```
--register-marker <text>   # forces the marker into marker_seen even if wait timed out
```

`wait-text` does not auto-register because regex markers are not
unique enough; only literal markers go into `marker_seen`. Document
this explicitly.

## status command implementation sketch

```bash
status_session() {
  # ... existing fields ...
  local agent_dir="$TMUX_AGENT_DIR/$name"
  local started_at marker_file pane_hash_file
  started_at="$(cat "$agent_dir/started_at" 2>/dev/null || true)"
  marker_file="$agent_dir/marker_seen"

  if "$TMUX" has-session -t "$session" 2>/dev/null; then
    local pane bytes_in_pane new_hash now last_hash last_at
    pane="$("$TMUX" capture-pane -p -t "$session")"
    bytes_in_pane=$(printf '%s' "$pane" | wc -c | tr -d ' ')
    new_hash=$(printf '%s' "$pane" | shasum -a 256 | awk '{print $1}')
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    pane_hash_file="$agent_dir/pane-hash"
    if [[ -f "$pane_hash_file" ]]; then
      last_hash="$(awk '{print $1}' "$pane_hash_file")"
      last_at="$(awk '{print $2}' "$pane_hash_file")"
    fi
    if [[ "$new_hash" != "$last_hash" ]]; then
      printf '%s %s\n' "$new_hash" "$now" > "$pane_hash_file"
      last_at="$now"
    fi
    local idle_seconds=0
    if [[ -n "$last_at" ]]; then
      idle_seconds=$(( $(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$now" "+%s") - \
                       $(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$last_at" "+%s") ))
    fi
    # ... build jq invocation with new fields ...
  else
    bytes_in_pane="null"
    last_change_at="null"
    idle_seconds="null"
  fi
}
```

`date -j -f` is macOS BSD; Linux requires `date -d` — wrap in a helper.

## Backward compatibility

Field additions only. No existing field type or name changes. Callers
that parse the current contract with `jq -e .running` continue to work.
The README `status --json` table must add stability annotations for the
new fields ("stable").

## Test plan

| Case | Expected |
|---|---|
| New session, no pane | `started_at` present, `idle_seconds=null`, `bytes_in_pane=null`, `marker_seen=[]` |
| After wait-literal succeeds with `[T01]` | `marker_seen` contains `[T01]`, `idle_seconds` matches wall clock |
| Repeated marker hits | `marker_seen` still distinct (single `[T01]` entry) |
| `wait-text` regex match | `marker_seen` unchanged |
| `--register-marker [T99]` with timeout | `marker_seen` includes `[T99]` |
| Long idle pane | `idle_seconds` grows monotonically until next pane change |

## Risk and trade-offs

- Hash + timestamp model assumes `status` is called periodically. If
  `status` is never called, `last_change_at` is also never updated; the
  reported value is "as of last status check", not "right now". Acceptable
  because callers polling `status` will refresh; document the caveat.
- `marker_seen` grows unbounded over a long session. Mitigation: cap at
  the last 100 entries; FIFO eviction. Most callers care about recent
  markers. Document the cap.
- `bytes_in_pane` is approximate (capture-pane may include trailing
  blanks). Document as best-effort.
