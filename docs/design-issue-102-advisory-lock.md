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

  # mkdir fallback: PID-stamped, with stale-holder recovery (PR #131 review)
  local lock_dir="$lock_file.d"
  local end=$(( EPOCHSECONDS + timeout ))
  while ! mkdir "$lock_dir" 2>/dev/null; do
    local holder_pid=""
    [[ -f "$lock_dir/pid" ]] && holder_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
    if [[ -n "$holder_pid" ]] && ! kill -0 "$holder_pid" 2>/dev/null; then
      # Holder is dead — reclaim. rmdir is atomic; concurrent waiters race
      # but only one wins the next mkdir.
      rmdir "$lock_dir" 2>/dev/null || true
      continue
    fi
    if [[ -z "$holder_pid" ]]; then
      # Lock dir exists but PID not written yet (half-init). Brief wait, then
      # treat as stale if still missing.
      sleep 0.2
      [[ -f "$lock_dir/pid" ]] || { rmdir "$lock_dir" 2>/dev/null || true; continue; }
    fi
    [[ $EPOCHSECONDS -ge $end ]] && {
      echo "lock contended on $agent_name after ${timeout}s (holder pid=$holder_pid)" >&2
      return 75
    }
    sleep 0.1
  done
  printf '%s\n' "$$" > "$lock_dir/pid"
  # Subshell-scope the trap so we do NOT clobber caller's process-wide trap.
  (
    trap "rmdir '$lock_dir' 2>/dev/null || true" EXIT INT TERM
    "$@"
  )
}
```

### Stale lock recovery (added per PR #131 review)

Partner critique caught a real bug in the original mkdir fallback: on
`kill -9`, OOM, or machine reboot the `lock_file.d` directory survived,
the `trap` never fired, and every subsequent call hit the 30-second
timeout then exited 75. For a L1 mechanism that would brick the wrapper.

The fix above borrows `flock`'s semantic (process-death-implies-released)
by stamping the holder PID into the lock dir and probing with `kill -0`:

| State of lock dir | Holder PID file | `kill -0 <pid>` | Decision |
|---|---|---|---|
| missing | n/a | n/a | acquire normally |
| exists | matches a live process | success | wait (real contention) |
| exists | refers to a dead PID | EPERM/ESRCH | reclaim (rmdir + retry) |
| exists | no `pid` file (half-init) | n/a | brief wait then reclaim |

This shifts the mkdir fallback from "broken under crash" to "best-effort
stale-cleanup". The fallback's correctness still depends on PID reuse
not happening within a single `lock-timeout` window — acceptable risk;
`flock` remains the preferred path.

### Subshell-scoped trap (also partner critique)

Original sketch used `trap "rmdir $lock_file.d" EXIT INT TERM`, which is
PROCESS-WIDE in zsh. Calling this inside `_send_session_impl` would
overwrite any trap the caller already set. Fix: run the lock body in a
subshell so the trap is scoped to the subshell only.

### `doctor` integration

`doctor` should report lock-holder state for owned sessions when running
the mkdir fallback:

```
lock holder: codex-cli-w pid=8512 (alive)
lock holder: codex-cli-x pid=7811 (dead — will reclaim on next op)
```

Same data also feeds a future `status --json` `lock_holder_pid` field if
needed.

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
| Lock timeout reached | exit 75, stderr fixed message including holder PID |
| `--no-lock` | warning printed once, no lock taken |
| `flock` missing | mkdir fallback used; same outcomes |
| **Stale lock (added per partner critique)**: `mkdir lock.d && echo 99999 > lock.d/pid` then call `send` | next caller acquires lock within ~1s (reclaim path) |
| **Crashed holder mid-operation**: `mkdir lock.d && echo $$ > lock.d/pid && sleep & kill -9 $!` | next caller reclaims within probe interval |
| **Subshell trap scoping**: caller sets its own `trap` then invokes a locked subcommand | caller's trap remains intact after subcommand returns |

Smoke test addition: extend `scripts/test-sentinel-smoke` or sibling
runner with the parallel-send AND stale-lock cases above. Without the
stale-lock case, the regression that motivated the partner critique
could re-enter the codebase undetected.

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
