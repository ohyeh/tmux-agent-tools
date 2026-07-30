#!/usr/bin/env bash
# PreToolUse(Bash) hook: mechanical dispatch gate for external tmux workers.
#
# Enforces two kernel routing rules at the tool layer (prompt ceremony -> tooling,
# per kernel v4.10 "Routing index" note):
#   GATE 1 (proxy enforcement): task-carrying dispatch (start/send/send-wait)
#     is only allowed from a subagent context — external workers are driven via
#     ONE supervision proxy, never from the parent session. Detected via the
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

# Dispatch = wrapper + a task-carrying subcommand. Everything else passes.
printf '%s' "$cmd" | grep -Eq '(^|[/[:space:]])(agent|agy|claude|codex)-tmux[[:space:]]' || exit 0
printf '%s' "$cmd" | grep -Eq '[[:space:]](start|send|send-wait)([[:space:]]|$)' || exit 0

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
  echo "$(date -u +%FT%TZ) $cmd" >> "$STATE_DIR/review-dispatch.log"
  n="$(wc -l < "$STATE_DIR/review-dispatch.log" | tr -d ' ')"
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
BLOCKED by dispatch gate: external tmux workers are driven via ONE
supervision-proxy subagent, never from the parent session. Read
~/.agents/rules/model-dispatch.md §3/§4 and
~/.agents/skills/delegation-templates/SKILL.md, then spawn a general-purpose
subagent to run this dispatch (the gate passes automatically inside a
subagent context). Only if the user explicitly instructed direct parent
dispatch: write that quoted instruction plus today's date to
$STATE_DIR/gate-receipt-parent-dispatch and retry.
EOF
  exit 2
fi

exit 0
