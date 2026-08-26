#!/usr/bin/env bash
# Cursor preToolUse → Claude-shaped stdin for tmux-dispatch-gate.sh.
# Cursor treats empty stdout as an invalid hook response, so this wrapper
# always emits JSON. Deny = permission JSON + exit 2.
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
GATE="${ROOT}/tmux-dispatch-gate.sh"
IN="$(cat)"

emit_ok() { printf '%s\n' '{"agent_message":""}'; }

if [ ! -x "$GATE" ]; then
  printf '%s\n' '{"agent_message":"cursor-pretooluse: missing tmux-dispatch-gate.sh"}'
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' '{"agent_message":"cursor-pretooluse: python3 missing"}'
  exit 1
fi

mapped="$(python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    src = json.loads(raw) if raw.strip() else {}
except json.JSONDecodeError:
    src = {}
if not isinstance(src, dict):
    src = {}
ti = src.get("tool_input")
if not isinstance(ti, dict):
    ti = {}
event = str(src.get("hook_event_name") or "")
st = str(src.get("subagent_type") or src.get("agent_type") or "")
if src.get("agent_type"):
    agent_type = str(src.get("agent_type"))
elif src.get("subagent_id") or event in ("subagentStart", "subagentStop"):
    agent_type = st or "subagent"
else:
    agent_type = ""
out = {
    "tool_name": "Bash",
    "tool_input": {"command": ti.get("command") or ""},
    "session_id": src.get("session_id") or src.get("conversation_id") or "",
    "agent_type": agent_type,
}
json.dump(out, sys.stdout, separators=(",", ":"))
' <<<"$IN")" || {
  printf '%s\n' '{"agent_message":"cursor-pretooluse: remap failed"}'
  exit 1
}

stderr_file="$(mktemp)"
stdout_file="$(mktemp)"
trap 'rm -f "$stderr_file" "$stdout_file"' EXIT
set +e
printf '%s' "$mapped" | "$GATE" >"$stdout_file" 2>"$stderr_file"
ec=$?
set -e

if [ "$ec" -eq 2 ]; then
  msg="$(cat "$stderr_file")"
  python3 -c 'import json,sys; m=sys.argv[1]; print(json.dumps({"permission":"deny","agent_message":m,"user_message":m}))' "$msg"
  exit 2
fi
if [ "$ec" -ne 0 ]; then
  msg="$(cat "$stderr_file")"
  python3 -c 'import json,sys; m=sys.argv[1]; print(json.dumps({"agent_message":m or "cursor-pretooluse: gate failed"}))' "$msg"
  exit "$ec"
fi
emit_ok
exit 0
