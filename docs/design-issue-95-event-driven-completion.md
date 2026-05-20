# Design — Issue #95: Event-driven completion signaling

Status: draft, not implemented.
Owner: pending.
Tracking: https://github.com/ohyeh/tmux-agent-tools/issues/95
Related: RFC #109 L1 Mechanism.

## Problem

Today, callers detect agent CLI completion by polling `status --json` and
matching the printed `local command exited with code N` line in the pane.
This is polling-based, requires capture parsing, and gives no structured
hand-off to external watchers.

## Goal

Add a minimal event-driven completion signal so external automation can:

1. block on a `wait`-able file (cheap inotify/fswatch or simple poll on stat);
2. read the exit code without parsing pane text;
3. run a user-supplied hook command when the agent CLI exits, with stable env.

Non-goals:

- no remote (ssh) hook invocation in v1 — sentinel only writes locally;
- no replay / transcript handling — that is L8 (#126/#127);
- no multi-target fan-out — that is L5 (#112).

## Proposed CLI surface

Three new flags on `start`, `start-ssh`, `resume`:

- `--sentinel <path>`: absolute path to write on exit. Wrapper writes the
  decimal exit code followed by a newline.
- `--on-exit <cmd>`: shell command. Invoked after sentinel write. Receives
  exit code as `$1` and agent name as `$2`. Stdout/stderr captured to
  `<sentinel>.hook.log` to avoid polluting the pane.
- `--sentinel-keep`: do not delete the sentinel when the wrapper is later
  stopped. Default behavior cleans up so reruns do not see stale files.

If `--sentinel` is omitted, behavior is unchanged. The two other flags are
no-ops without `--sentinel` and the wrapper prints a non-fatal warning.

## Sentinel file contract

Explicit name in docs: **exit-code sentinel file**. This wording exists so
future readers do not assume the sentinel is a structured event payload.
Structured telemetry belongs to L3 (#100, #103) as a separate artifact, not
as a format upgrade of this file.

Path: user-supplied. Suggested convention in docs:

```
${XDG_RUNTIME_DIR:-/tmp}/tmux-agent-tools/${prefix}-${name}.exit
```

Content (single line, ASCII):

```
<exit_code>\n
```

Atomic write: write to `<path>.tmp` then `mv -f` so readers never see a
partial file. Permissions: 0644.

## Pane-launch integration

Each wrapper has 3 launch sites that build the inline shell command run
inside `tmux new-session`. Today the suffix is:

```
$(shell_quote "$CLI") ARGS; code=$?; printf 'exited with code %s' "$code"; printf 'press Enter...'; read _; exit "$code"
```

Proposed change — insert two steps between `code=$?` and the exit message:

```
$(shell_quote "$CLI") ARGS; code=$?
[[ -n "$_SENTINEL" ]] && { umask 022; printf '%s\n' "$code" > "$_SENTINEL.tmp" && mv -f "$_SENTINEL.tmp" "$_SENTINEL"; }
[[ -n "$_ON_EXIT" ]] && { ( ON_EXIT_CODE="$code" AGENT_NAME="$name" eval "$_ON_EXIT" "$code" "$name" ) >> "$_SENTINEL.hook.log" 2>&1 || true; }
printf '\n[<tool>-tmux] local command exited with code %s\n' "$code"
printf '[<tool>-tmux] press Enter to close this pane\n'
read _
exit "$code"
```

`_SENTINEL` and `_ON_EXIT` are passed via `session_env_args` (already used
for env propagation). The hook is best-effort — failures never block pane
close.

## status --json additions

Add two best-effort fields when a sentinel is configured for the session:

- `sentinel_path`: absolute path passed at start (or null).
- `sentinel_exit`: integer parsed from the sentinel file at status time, or
  null if the file does not yet exist.

`exit_detected` already exists for pane-text parsing. The two channels can
disagree briefly (sentinel writes after pane text). Document the precedence:
sentinel is authoritative once present, otherwise fall back to pane text.

## Cleanup semantics

- On `stop <name>`, the wrapper unlinks the sentinel unless
  `--sentinel-keep` was set at start.
- The wrapper never overwrites a pre-existing sentinel before launch. If a
  stale sentinel exists, the wrapper aborts start with an error directing
  the user to remove it or pick a fresh path. Rationale: avoids silent
  false-positive completion for an unrelated rerun.

## Test plan

Fake-CLI smoke test (no real Claude/Codex required):

1. Run `start --exact t1 . --sentinel /tmp/t.exit -- /bin/sh -c 'exit 7'`
   (extension: allow `--` passthrough for tests).
2. `wait` for pane stable.
3. Assert `/tmp/t.exit` content is `7\n`.
4. Assert `status --json t1 | jq .sentinel_exit == 7`.
5. Assert hook script ran by inspecting `/tmp/t.exit.hook.log`.

Edge cases worth covering:

- sentinel path not writable → wrapper prints diagnostic but pane still runs;
- hook command exits non-zero → pane unaffected, log captured;
- stale sentinel → start refuses;
- ssh launch site → sentinel writes on remote host; document that pulling
  the file back is the operator's responsibility.

## Rollout

1. Land docs (this file) and CLI flag parsing without behavior change. — DONE
2. Land sentinel write path in `start` (local only). — DONE (codex-tmux + claude-tmux)
3. Extend to `resume`. — DONE (codex-tmux + claude-tmux; smoke pending real session UUID)
4. Extend to `start-ssh`. — DESIGN AGREED (see "SSH semantics" below), implementation pending.
5. Mirror the change in claude-tmux after codex-tmux passes self-tests. — DONE for local start + resume.
6. Add docs section in README under "Event-driven completion". — DONE.
7. Add reusable smoke test runner. — DONE (`scripts/test-sentinel-smoke`).

## SSH semantics (for start-ssh follow-up)

Agreed with partner during the overnight review pass. Implementation is a
follow-up because the wrapper's SSH launch path uses heavy shell quoting and
the change requires its own smoke evidence.

| Concern | Decision |
| --- | --- |
| `--sentinel <abs-path>` semantics | path is on the REMOTE host (where the agent CLI actually runs and exits) |
| Sentinel contents | same as local: plain decimal exit code + newline |
| Atomic write | remote shell uses `${sentinel}.tmp.$$` + `mv -f` |
| Stale policy | wrapper SSHes to target with `test -e "$sentinel"` before launch and aborts if it exists |
| Hook execution | runs on REMOTE host; `$1`=exit code, `$2`=agent name |
| Hook log | remote `<sentinel>.hook.log` |
| Caller passes local-only path as hook | remote exec fails, error captured in remote hook log; agent exit code is preserved (`|| true`) |
| Caller wants local notification | caller's responsibility to provide a remote-reachable command (e.g. ssh back to local host, curl webhook, write to shared mount) — out of `#95` scope |

Rationale: keeping the sentinel co-located with the process whose exit it
records avoids the wrapper claiming to know any local/remote filesystem
mapping. Any cross-host plumbing is a follow-up concern (potentially L3 or
a separate ssh-back helper), not part of the L1 mechanism.

## Open questions

- `--on-exit` is a single shell string. Should we support array-style args
  to avoid quoting headaches? Defer until a real user hits the limitation.
- Should the sentinel encode JSON (exit + duration + timestamp) instead of
  just the exit code? Plain integer keeps shell consumers trivial; JSON is
  better for L3 (#100/#103). Decide when L3 work begins.
