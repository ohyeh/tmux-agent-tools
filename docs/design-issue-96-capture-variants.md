# Design — Issue #96: Token-efficient capture variants

Status: draft, not implemented. Solo work after partner channel went down.
Tracking: https://github.com/ohyeh/tmux-agent-tools/issues/96
Related: RFC #109 L2 Interface; sibling to #95 (event-driven completion)
which now lives at L1.

## Problem

Today, `capture <name> [lines]` returns the last N pane lines verbatim,
including ANSI color escapes and any pre-marker scrollback. For token-
budgeted callers this is wasteful in three ways:

1. Color escapes and box-drawing characters consume tokens and add no
   informational value.
2. Callers often only want output produced after a known marker (e.g.
   after they issued a `send`).
3. Heavy callers want machine-readable JSON rather than raw text glued
   together with `\n`.

## Goal

Add minimal flags to `capture` that let callers trim output BEFORE it
leaves the wrapper, so the conversation context never sees the noise.

Non-goals:

- no transcript-style logging (that is #100);
- no token counting (that is #103);
- no behavior change for the existing positional `[lines]` argument.

## Proposed CLI surface

`<wrapper> capture [--strip-ansi] [--since-marker <text>] [--json] <name> [lines]`

| Flag | Type | Semantics |
| --- | --- | --- |
| `--strip-ansi` | switch | Remove ANSI CSI/SGR sequences from captured output before printing. Implementation: `sed 's/\x1b\[[0-9;?]*[A-Za-z]//g'` after the existing `capture-pane`. |
| `--since-marker <text>` | string | After capture-pane, drop everything up to and including the LAST line that contains the literal `<text>`. If marker not found, output is empty (not the full pane). |
| `--json` | switch | Wrap output as `{"name": ..., "session": ..., "lines_requested": N, "lines": [...], "marker_found": bool, "stripped_ansi": bool}` via `jq -n`. Keeps the same stripped+sliced text. |

Flag ordering: must come BEFORE positional `<name>`. This matches the
`start` flag-ordering convention we established for `--sentinel`.

Default behavior with no new flags is unchanged.

## Why these three and not `--tail`

The existing positional `[lines]` is already `--tail`. Adding `--tail`
would be a synonym with two failure modes (which wins when both passed?).
Better to keep the positional and document it. If clarity is a problem
later, the positional can be deprecated to `--tail` in a separate slice.

## Schema versioning

`schema_version: 1` is the first stable contract for `--json` output.
Aligned with `#100` transcript and `#103` telemetry conventions in the
same repo so every L3 JSON surface follows the same rule:

- Additive fields do NOT bump `schema_version` — existing consumers keep
  working as long as they ignore unknown keys.
- Renaming or removing a field bumps `schema_version` to `2` and the
  README contract table lists the prior shape for one release.

This is intentionally inserted in the v0 release surface; adding it
later forces every consumer to write `if .schema_version == null then 1
else .schema_version end` fallback forever. Same convention as #100 /
#103.

## Implementation sketch

```bash
capture_session() {
  require_tmux
  local strip_ansi=0 since_marker="" output_json=0
  while [[ "${1:-}" == --* ]]; do
    case "$1" in
      --strip-ansi) strip_ansi=1; shift ;;
      --since-marker) since_marker="${2:-}"; shift 2 ;;
      --json) output_json=1; shift ;;
      --) shift; break ;;
      *) echo "Unknown capture flag: $1" >&2; exit 2 ;;
    esac
  done
  local name="${1:-}"
  local lines="${2:-80}"
  # ... existing validation ...

  local raw
  raw="$("$TMUX" capture-pane -J -t "$session" -p -S "-$lines")"

  if (( strip_ansi )); then
    # POSIX-compatible ANSI stripper
    raw="$(printf '%s' "$raw" | sed $'s/\x1b\\[[0-9;?]*[A-Za-z]//g')"
  fi

  local marker_found=0
  if [[ -n "$since_marker" ]]; then
    # Find last line containing marker; keep everything after
    local last_idx
    last_idx="$(printf '%s\n' "$raw" | grep -nF "$since_marker" | tail -1 | cut -d: -f1)"
    if [[ -n "$last_idx" ]]; then
      marker_found=1
      raw="$(printf '%s\n' "$raw" | tail -n +"$((last_idx + 1))")"
    else
      raw=""
    fi
  fi

  if (( output_json )); then
    jq -n \
      --arg name "$name" \
      --arg session "$session" \
      --argjson lines_requested "$lines" \
      --argjson marker_found "$marker_found" \
      --argjson stripped_ansi "$strip_ansi" \
      --arg body "$raw" \
      '{name: $name, session: $session, lines_requested: $lines_requested,
        marker_found: ($marker_found == 1), stripped_ansi: ($stripped_ansi == 1),
        lines: ($body | split("\n"))}'
  else
    printf '%s\n' "$raw"
  fi
}
```

## Test plan

Synthetic pane: spawn `tmux new-session -d 'printf "\x1b[31mHELLO\x1b[0m\nMARKER\nafter1\nafter2\n"; sleep 60'`, then:

| Case | Command | Expected |
| --- | --- | --- |
| Baseline | `capture syn 10` | raw includes ANSI + all lines |
| Strip | `capture --strip-ansi syn 10` | `HELLO` without color, full body |
| Since marker | `capture --since-marker MARKER syn 10` | `after1\nafter2` only |
| Combined | `capture --strip-ansi --since-marker MARKER syn 10` | stripped + sliced |
| JSON | `capture --json syn 10` | parseable; `.lines` is array |
| Marker not found | `capture --since-marker NOPE syn 10` | empty output |

## Rollout

1. Land design (this file).
2. Implement in `codex-tmux`, then mirror to `claude-tmux`.
3. Extend `scripts/test-sentinel-smoke` into a generic
   `scripts/test-capture-smoke` (or inline these cases) so both #95 and
   #96 stay covered.
4. README: add a "Token-efficient capture" section pointing to the flag
   table.

## Risk and trade-offs

- `--since-marker` semantics: "last occurrence" vs "first occurrence".
  Chose LAST because callers usually send a fresh marker each turn; the
  most recent occurrence is what matters. Document explicitly.
- `--json` adds a `jq` runtime dependency to this command path. The
  wrapper already uses `jq` for `status --json`, so no new dependency.
- ANSI regex is permissive (matches CSI + ESC[?]) — may strip something
  unintended. Acceptable because the alternative is no stripping at all
  and the caller has the `--strip-ansi` switch to opt out.
- **Coverage extended in #135 (PR landed after #96):** the strip pass
  now covers CSI/SGR plus OSC (BEL or ST terminated), DCS, APC, PM,
  and SOS in a single sed pipeline. Only out-of-scope category is the
  8-bit C1 control codes (`\x9b` etc.) — modern panes rarely emit those
  and they require terminal-dependent handling. Smoke
  (`scripts/test-capture-smoke`) emits one synthetic example of each
  category and asserts both the introducer is removed and the visible
  body around it survives.
