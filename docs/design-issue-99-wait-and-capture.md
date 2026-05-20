# Design — Issue #99: `wait-and-capture` combined subcommand

Status: draft, not implemented. Depends on #96 capture variants.
Tracking: https://github.com/ohyeh/tmux-agent-tools/issues/99
Related: RFC #109 L2 Interface; alias for the wait + capture golden path.

## Problem

The two-step `wait-literal X` followed by `capture --strip-ansi --since-marker X`
is the most common automation pattern. Today callers pay extra round-trip cost
to issue two subcommands and to teach each new automation the right pairing.

## Goal

A single subcommand that does the wait, then returns sliced output as a
structured payload. Same flags as #96, plus a single timeout.

Non-goals:

- no behavior change for `wait`, `wait-text`, `wait-literal`, `capture`;
- no new wait semantics; the regex/literal switch follows the existing
  pair.

## CLI surface

```
<wrapper> wait-and-capture <name>
  --marker <text>                # the marker to wait for
  [--literal | --regex]          # match style; default regex
  [--timeout <seconds>]          # default 180
  [--tail <N>]                   # post-wait capture lines back
  [--strip-ansi]                 # forwarded to #96 capture
  [--since-marker <text>]        # default: the marker itself
  [--json]                       # default: human text
```

Defaults aim at the golden path:

- `--since-marker` defaults to `--marker` value, so callers usually omit it.
- `--strip-ansi` defaults OFF because the existing capture default is OFF;
  recommend turning it on in SKILL.md examples.
- `--timeout` defaults to 180s to match existing `wait-*` defaults.

## Output

Text mode (default): just the sliced/stripped capture body. Exit 0 if
matched, exit 1 if timeout — matches `wait-text` / `wait-literal`
behavior so `if` chains work without surprise.

JSON mode (`--json`):

```json
{
  "matched": true,
  "marker": "[DONE]",
  "match_style": "literal",
  "wait_seconds": 12.4,
  "timeout": 180,
  "reason": "matched",
  "lines": ["..."],
  "stripped_ansi": true
}
```

`reason` is one of `matched`, `timeout`, `session_gone`. JSON-mode
callers should always branch on `reason`, not exit code.

### Timeout semantics (decoupled from `--json`)

Partner critique on initial draft: tying "timeout is not an error" to
`--json` mixes the contract layer with the presentation layer. Fix:
make timeout-tolerance an explicit flag.

```
--no-timeout-error    # exit 0 even when matched == false
```

Default behavior is "timeout is an error" so shell `if` keeps working.
Callers that want soft-timeout behavior opt in explicitly. The flag is
orthogonal to `--json` — both can be set independently:

| Flags | matched=true | matched=false |
|---|---|---|
| (none) | exit 0, text body | exit 1, last-N text |
| `--json` | exit 0, JSON with `reason: "matched"` | exit 1, JSON with `reason: "timeout"` |
| `--no-timeout-error` | exit 0, text body | exit 0, last-N text |
| `--json --no-timeout-error` | exit 0, JSON | exit 0, JSON with `reason: "timeout"` |

This is a cleaner contract than letting `--json` silently flip the exit
semantics, which the original issue text implied.

## Implementation sketch

```bash
wait_and_capture_session() {
  require_tmux
  local marker="" match_style="regex" timeout=180 tail=80
  local strip_ansi=0 since_marker="" output_json=0
  while [[ "${1:-}" == --* ]]; do
    case "$1" in
      --marker) marker="${2:-}"; shift 2 ;;
      --literal) match_style="literal"; shift ;;
      --regex) match_style="regex"; shift ;;
      --timeout) timeout="${2:-}"; shift 2 ;;
      --tail) tail="${2:-}"; shift 2 ;;
      --strip-ansi) strip_ansi=1; shift ;;
      --since-marker) since_marker="${2:-}"; shift 2 ;;
      --json) output_json=1; shift ;;
      --) shift; break ;;
      *) echo "Unknown wait-and-capture flag: $1" >&2; exit 2 ;;
    esac
  done
  local name="${1:-}"
  [[ -z "$marker" || -z "$name" ]] && { echo "Usage: ..." >&2; exit 2; }

  local started matched=0 elapsed=0
  started=$EPOCHSECONDS
  if [[ "$match_style" == "literal" ]]; then
    wait_literal_session "$name" "$marker" "$timeout" && matched=1
  else
    wait_text_session "$name" "$marker" "$timeout" && matched=1
  fi
  elapsed=$((EPOCHSECONDS - started))

  local effective_since="${since_marker:-$marker}"
  local capture_args=("$name" "$tail")
  local body
  if (( matched )); then
    body="$(capture_with_filters "$name" "$tail" "$strip_ansi" "$effective_since")"
  else
    body="$(capture_with_filters "$name" "$tail" "$strip_ansi" "")"
  fi

  if (( output_json )); then
    jq -n --arg marker "$marker" --arg style "$match_style" \
      --argjson matched "$matched" \
      --argjson wait "$elapsed" --argjson timeout "$timeout" \
      --argjson stripped "$strip_ansi" --arg body "$body" \
      '{matched: ($matched == 1), marker: $marker, match_style: $style,
        wait_seconds: $wait, timeout: $timeout,
        stripped_ansi: ($stripped == 1),
        lines: ($body | split("\n"))}'
  else
    printf '%s\n' "$body"
  fi

  if (( ! matched && ! output_json )); then
    exit 1
  fi
}
```

`capture_with_filters` would be a shared helper extracted from the #96
work to keep `capture` and `wait-and-capture` honest about the same
filter semantics.

## Test plan

| Case | Expected |
|---|---|
| marker present before timeout | exit 0, body = sliced |
| marker missing within timeout | text mode: exit 1; json mode: exit 0 + `matched: false` |
| `--strip-ansi` with colored marker text | body has no escape sequences |
| `--since-marker` overrides `--marker` for slicing | body starts after the override marker |
| `--literal` with regex metacharacters in marker | matches literally |

## Rollout dependencies

This issue depends on #96 landing first (or at least the `--strip-ansi`
and `--since-marker` helpers being extracted). Otherwise the combined
subcommand has to duplicate the filter logic, and the duplication will
drift.

Suggested order: #95 → #96 → #97 → #99. Currently #95 is PR-ready;
#96 and #97 have design docs only; #99 should follow them.
