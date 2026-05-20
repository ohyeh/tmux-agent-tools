# Design — Issue #102: Advisory lock around pane operations

Status: draft, not implemented.
Tracking: https://github.com/ohyeh/tmux-agent-tools/issues/102
Related: RFC #109 L1 Mechanism; "safety hardening" group with #105.

## Problem

Two callers invoking `send` against the same session race on
`tmux paste-buffer`. Interleaved keystrokes can corrupt commands or —
in the worst case — execute partial command fragments that look harmless
in isolation but compose into something destructive when combined with
`--dangerously-skip-permissions` / `--yolo` already passed by the
wrapper.

Today nothing prevents this. The wrapper documentation is silent.

## Goal

Add advisory file lock around every subcommand that mutates the pane:

- `send`
- `send-wait-literal`
- `wait`, `wait-text`, `wait-literal` (read-only pane access but they
  also call `paste-buffer` for cursor placement on some platforms)
- `capture` (read-only; included to avoid mid-capture interleaving)

Non-goals:

- no kernel-level mandatory locking;
- no cross-machine locking (lockfile is local; ssh callers see local
  locks only);
- no reentrancy in the same process group — callers must serialize
  their own multi-step flows externally.

## Lock model

| Property | Value |
|---|---|
| Lock file | `$TMUX_AGENT_DIR/<name>.lock` |
| Mechanism | `flock(1)` exclusive |
| Default timeout | 30 seconds |
| On timeout | exit code `75` (`EX_TEMPFAIL`), stderr fixed string `lock contended on <name> after <N>s` |
| `--no-lock` opt-out | available everywhere a lock would be taken; stderr warning printed |
| Lock scope | one subcommand invocation; released on process exit |

`flock` on macOS does not ship in the base system. Provide a tiny
zsh-only fallback using `mkdir` (atomic on POSIX filesystems) when
`flock` is missing.

## CLI surface

| Existing subcommand | New flags |
|---|---|
| `send` | `--lock-timeout <s>`, `--no-lock` |
| `send-wait-literal` | `--lock-timeout <s>`, `--no-lock` |
| `wait*` | `--lock-timeout <s>`, `--no-lock` |
| `capture` | `--lock-timeout <s>`, `--no-lock` |

The flags must come BEFORE positional args to match the established
flag-ordering convention (`--sentinel`, `--strip-ansi`, etc.).

## Doctor check

`doctor` already inspects `tmux`, `claude`/`codex`, prefix, mouse,
clipboard. Add one line:

```
flock: /opt/homebrew/bin/flock (coreutils 9.5)
```

When `flock` is missing, print:

```
flock: missing — using mkdir fallback (works but slower under contention)
```

## Implementation sketch

```bash
lock_around() {
  local agent_name="$1"
  local timeout="$2"
  shift 2
  local lock_file="$TMUX_AGENT_DIR/$agent_name.lock"
  mkdir -p "$(dirname "$lock_file")"

  if command -v flock >/dev/null 2>&1; then
    flock -w "$timeout" -x "$lock_file" "$@"
    local rc=$?
    [[ $rc -eq 1 ]] && {
      echo "lock contended on $agent_name after ${timeout}s" >&2
      return 75
    }
    return $rc
  fi

  # mkdir fallback
  local end=$(( EPOCHSECONDS + timeout ))
  while ! mkdir "$lock_file.d" 2>/dev/null; do
    [[ $EPOCHSECONDS -ge $end ]] && {
      echo "lock contended on $agent_name after ${timeout}s" >&2
      return 75
    }
    sleep 0.1
  done
  trap "rmdir $lock_file.d" EXIT INT TERM
  "$@"
}
```

Each entry point becomes:

```bash
send_session() {
  local lock_timeout=30 use_lock=1
  while [[ "${1:-}" == --* ]]; do
    case "$1" in
      --lock-timeout) lock_timeout="${2:-}"; shift 2 ;;
      --no-lock) use_lock=0; echo "[wrapper] warning: --no-lock; concurrent sends will interleave" >&2; shift ;;
      --) shift; break ;;
      *) break ;;
    esac
  done
  local name="$1"; shift
  if (( use_lock )); then
    lock_around "$name" "$lock_timeout" _send_session_impl "$name" "$@"
  else
    _send_session_impl "$name" "$@"
  fi
}
```

## Test plan

| Case | Expected |
|---|---|
| Single sender | identical to today |
| Two parallel `send` calls | second waits, both complete in order |
| Lock timeout reached | exit 75, stderr fixed message |
| `--no-lock` | warning printed once, no lock taken |
| `flock` missing | mkdir fallback used; same outcomes |

Smoke test addition: extend `scripts/test-sentinel-smoke` or sibling
runner with a "two parallel sends" case that confirms no interleaving.

## Risk and trade-offs

- Locking adds a small latency to every pane operation. Measured cost
  on macOS with `flock`: ~5ms uncontended. Acceptable.
- `--no-lock` exists so power users can avoid the overhead in single-
  caller automations. Default-on is the safe choice; the issue
  acceptance explicitly required this default.
- mkdir fallback under contention scales poorly past ~5 concurrent
  callers. Document as known limitation; recommend installing `flock`
  via `coreutils` on macOS for serious concurrency.
- 30s default timeout is long enough to ride out a slow `paste-buffer`
  but short enough that a stuck lock surfaces quickly. Tune via
  `--lock-timeout` per call.
