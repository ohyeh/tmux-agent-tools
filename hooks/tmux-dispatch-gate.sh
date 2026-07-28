#!/usr/bin/env bash
# PreToolUse(Bash) hook: mechanical dispatch gate for external tmux workers.
#
# Enforces two kernel routing rules at the tool layer (prompt ceremony -> tooling,
# per kernel v4.10 "Routing index" note):
#   GATE 1 (dispatch receipt): the parent session must have read
#     model-dispatch.md + delegation-templates before driving a tmux worker;
#     proven by the receipt marker file, created once per session.
#   GATE 2 (workflow escalation): the SECOND review-shaped worker dispatch in
#     one session means a manual review round-loop is forming — that is
#     loop-shaped work and belongs in a workflow recipe (consensus-gate /
#     findings-triage). Denied until the workflow receipt marker exists.
#
# Pass-throughs (exit 0, silent):
#   - subagent contexts: stdin JSON carries agent_type (probe-confirmed on
#     Claude Code v2.1.220, see .workflow/202607261830-dispatch-gate-enforcement/);
#     proxies drive workers by design.
#   - read-only / lifecycle subcommands (status, result, stop, capture, list...).
#   - non-dispatch commands.
#
# Escape hatches (marker files under the session state dir):
#   gate-receipt-dispatch  — model writes it after reading the routed rules
#                            (GATE 1), once per session.
#   gate-receipt-workflow  — model writes it citing either the chosen recipe
#                            or the user's explicit direct-dispatch instruction
#                            (GATE 2).
# Deny = exit 2 + reason on stderr (Claude Code feeds stderr back to the model).
set -u

IN="$(cat)"
command -v jq >/dev/null 2>&1 || exit 0   # no jq -> never block work

# Subagent (supervision proxy) -> pass.
agent_type="$(printf '%s' "$IN" | jq -r '.agent_type // empty' 2>/dev/null)"
[ -n "$agent_type" ] && exit 0

cmd="$(printf '%s' "$IN" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0

# Dispatch = wrapper + a task-carrying subcommand. Everything else passes.
printf '%s' "$cmd" | grep -Eq '(^|[/[:space:]])(agent|agy|claude|codex)-tmux[[:space:]]' || exit 0
printf '%s' "$cmd" | grep -Eq '[[:space:]](start|send|send-wait)([[:space:]]|$)' || exit 0

session_id="$(printf '%s' "$IN" | jq -r '.session_id // empty' 2>/dev/null)"
STATE_DIR="${HOME}/.local/state/agent-hooks/${session_id:-pid-$PPID}"
mkdir -p "$STATE_DIR"

# --- GATE 1: dispatch receipt -------------------------------------------------
if [ ! -f "$STATE_DIR/gate-receipt-dispatch" ]; then
  cat >&2 <<EOF
BLOCKED by dispatch gate: read ~/.agents/rules/model-dispatch.md §3/§4 and
~/.agents/skills/delegation-templates/SKILL.md, then write your GATE receipt
(role, model, brief shape) to $STATE_DIR/gate-receipt-dispatch and retry.
External workers are driven via ONE supervision proxy, not from the parent.
EOF
  exit 2
fi

# --- GATE 2: second review-shaped dispatch -> workflow recipe -------------------
if printf '%s' "$cmd" | grep -Eq '[[:space:]]start[[:space:]]' \
   && printf '%s' "$cmd" | grep -Eiq 'start([[:space:]]+--[A-Za-z-]+)*[[:space:]]+[A-Za-z0-9._-]*(review|verify|gate|freeze|audit)'; then
  echo "$(date -u +%FT%TZ) $cmd" >> "$STATE_DIR/review-dispatch.log"
  n="$(wc -l < "$STATE_DIR/review-dispatch.log" | tr -d ' ')"
  if [ "$n" -ge 2 ] && [ ! -f "$STATE_DIR/gate-receipt-workflow" ]; then
    cat >&2 <<EOF
BLOCKED by workflow gate: this is review-shaped worker dispatch #$n this
session — a manual review round-loop is forming. Loop-shaped work runs via a
workflow recipe: read ~/.agents/skills/using-workflows/SKILL.md and use
consensus-gate / findings-triage (or the second-model-consensus skill).
To proceed anyway, write the reason (chosen recipe, or quote the user's
explicit direct-dispatch instruction) to $STATE_DIR/gate-receipt-workflow
and retry.
EOF
    exit 2
  fi
fi

exit 0
