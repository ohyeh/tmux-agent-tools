#!/usr/bin/env bash
# PreToolUse(Bash) hook: mechanical dispatch gate for external tmux workers.
#
# Enforces two kernel routing rules at the tool layer (prompt ceremony -> tooling,
# per kernel v4.10 "Routing index" note):
#   GATE 1 (dispatch-shape enforcement): hand-chained task dispatch
#     (start/send/send-wait) from the parent session is the retired shape —
#     the sanctioned path is ONE blocking `assign` call (which this gate
#     never matches), run as a background task or inside a subagent when the
#     runtime caps foreground waits. Subagent context passes. Detected via the
#     harness-injected stdin field agent_type (probed interface, verified on
#     Claude Code 2.1.220; see agent-scripts harness-diagnosis.md "Interface
#     trust tiers"). The parent's escape hatch is a content-validated receipt
#     quoting the user's explicit direct-dispatch instruction.
#   GATE 2 (workflow escalation): the SECOND review-shaped worker dispatch in
#     one session means a manual review round-loop is forming — that is
#     loop-shaped work and belongs in a workflow recipe (consensus-gate /
#     findings-triage). Denied until the workflow receipt exists. Counted
#     BEFORE the subagent pass-through so proxy-driven review loops are
#     counted too.
#
# Pass-throughs (exit 0, silent):
#   - read-only / lifecycle subcommands (status, result, stop, capture, list...).
#   - non-dispatch commands.
#
# Escape hatches (marker files under the session state dir). A receipt only
# counts if it carries a YYYY-MM-DD date and >= 40 bytes of rationale —
# an empty touch does not open the gate:
#   gate-receipt-parent-dispatch — quotes the user's explicit instruction to
#                                  dispatch directly from the parent (GATE 1).
#   gate-receipt-workflow        — names the chosen workflow recipe or quotes
#                                  the user's direct-dispatch instruction (GATE 2).
# Deny = exit 2 + reason on stderr (Claude Code feeds stderr back to the model).
set -u

IN="$(cat)"
command -v jq >/dev/null 2>&1 || exit 0   # no jq -> never block work

cmd="$(printf '%s' "$IN" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0

# Dispatch = wrapper IMMEDIATELY followed by a task-carrying subcommand
# (optionally with the <cli> word between: `agent-tmux codex send`). The two
# independent greps this replaced fired on any command string that happened
# to contain both tokens anywhere — observed false positives: `help send-wait`
# and a `git commit` whose message quoted the subcommands.
printf '%s' "$cmd" | grep -Eq '(^|[/[:space:]])(agent|agy|claude|codex)-tmux[[:space:]]+([A-Za-z0-9._-]+[[:space:]]+)?(start|send|send-wait)([[:space:]]|$)' || exit 0

session_id="$(printf '%s' "$IN" | jq -r '.session_id // empty' 2>/dev/null)"
agent_type="$(printf '%s' "$IN" | jq -r '.agent_type // empty' 2>/dev/null)"
STATE_DIR="${HOME}/.local/state/agent-hooks/${session_id:-pid-$PPID}"
mkdir -p "$STATE_DIR"

# A receipt must carry a date and real rationale; an empty touch does not count.
valid_receipt() {
  [ -f "$1" ] && grep -Eq '[0-9]{4}-[0-9]{2}-[0-9]{2}' "$1" \
    && [ "$(wc -c < "$1" | tr -d ' ')" -ge 40 ]
}

# --- GATE 2: second review-shaped dispatch -> workflow recipe -------------------
if printf '%s' "$cmd" | grep -Eq '[[:space:]]start[[:space:]]' \
   && printf '%s' "$cmd" | grep -Eiq 'start([[:space:]]+--[A-Za-z-]+)*[[:space:]]+[A-Za-z0-9._-]*(review|verify|gate|freeze|audit)'; then
  # One tool call counts once: a host that loads this plugin from two places
  # (cursor-agent: --plugin-dir plus the installed Claude plugin) runs the gate
  # once per copy, with the same tool_use_id. mkdir is atomic, so concurrent
  # copies agree on which one records the call.
  log="$STATE_DIR/review-dispatch.log"
  # Every step that counts the call fails closed: an uncounted call must not pass.
  unrecorded() {
    echo "BLOCKED by workflow gate: could not count this review-shaped dispatch ($1). Retry the call; if it repeats, check $STATE_DIR." >&2
    exit 2
  }
  if ! printf '%s' "$IN" | jq -e '(.tool_use_id // "") | length > 0' >/dev/null 2>&1; then
    echo "$(date -u +%FT%TZ) $cmd" >> "$log" || unrecorded "log write failed"
  else
    # sha256 of the id's raw bytes (jq -j, never a shell variable: $(...) drops a
    # trailing newline and bash drops a NUL, so two ids became one): a fixed-length
    # name (a hex of a long id passed NAME_MAX), never . or ..
    id_bytes() { printf '%s' "$IN" | jq -j '.tool_use_id'; }
    if command -v sha256sum >/dev/null 2>&1; then h="$(id_bytes | sha256sum)"
    else h="$(id_bytes | shasum -a 256 2>/dev/null)"; fi
    h="${h%% *}"
    # A failed or missing digest would leave every id on one marker `id-`.
    printf '%s' "$h" | grep -Eq '^[0-9a-f]{64}$' || unrecorded "no sha256 digest (sha256sum or shasum)"
    seen="$STATE_DIR/seen/id-$h"
    mkdir -p "$STATE_DIR/seen"
    if mkdir "$seen" 2>/dev/null; then
      echo "$(date -u +%FT%TZ) $cmd" >> "$log" || unrecorded "log write failed"
      : > "$seen/done"
    elif [ -d "$seen" ]; then
      # Another copy records this call: count after its line is written (max 2 s).
      for _ in $(seq 40); do [ -e "$seen/done" ] && break; sleep 0.05; done
      # No done: the recording copy died or stalled before its line; the log is not trusted.
      [ -e "$seen/done" ] || unrecorded "another copy did not finish recording"
    else
      unrecorded "mkdir $seen failed"
    fi
  fi
  # An unreadable log is no count, not 0.
  n="$(wc -l < "$log" 2>/dev/null)" || unrecorded "log unreadable"
  n="$(printf '%s' "$n" | tr -d ' ')"
  if [ "$n" -ge 2 ] && ! valid_receipt "$STATE_DIR/gate-receipt-workflow"; then
    cat >&2 <<EOF
BLOCKED by workflow gate: this is review-shaped worker dispatch #$n this
session — a manual review round-loop is forming. Loop-shaped work runs via a
workflow recipe: read ~/.agents/skills/using-workflows/SKILL.md and use
consensus-gate / findings-triage (or the second-model-consensus skill).
To proceed anyway, write the reason (today's date plus the chosen recipe, or
a quote of the user's explicit direct-dispatch instruction) to
$STATE_DIR/gate-receipt-workflow and retry.
EOF
    exit 2
  fi
fi

# --- GATE 1: proxy enforcement --------------------------------------------------
# Subagent context (supervision proxy) -> pass; proxies drive workers by design.
[ -n "$agent_type" ] && exit 0

if ! valid_receipt "$STATE_DIR/gate-receipt-parent-dispatch"; then
  cat >&2 <<EOF
BLOCKED by dispatch gate: start/send/send-wait must not run in the PARENT
session — host it in a supervision proxy (ONE general-purpose subagent on
sonnet low) instead. First bring-up of a worker = ONE blocking
  agent-tmux <cli> assign <name> <dir> <prompt-file>
inside the proxy; every FOLLOW-UP task to the SAME persistent worker =
  agent-tmux <cli> send-wait <name> ...
also inside a proxy (send-wait itself is NOT retired — workers are session
teammates, per model-dispatch.md §4 lifecycle ruling 2026-08-18; what is
retired is hand-chaining the bring-up steps and parent-foreground hosting).
Only if the user explicitly instructed hand-chained parent dispatch: write
that quoted instruction plus today's date to
$STATE_DIR/gate-receipt-parent-dispatch and retry.
EOF
  exit 2
fi

exit 0
