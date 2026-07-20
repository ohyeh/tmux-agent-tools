GOAL: Verify the external Claude CLI worker path for the Codex native proxy
bridge in `/Users/paul.yeh/github/tmux-agent-tools`.

CONTEXT: This is read-only. Run
`skills/tmux-agent-tools/scripts/agent-tmux --version` from the repo root.

ACCEPTANCE:
- The command exits 0 and prints exactly `0.36.0`.
- No repository files are changed.
- Write schema-version-1 `result.json` to the literal injected result path,
  with `status: success` and a concise command/exit/output summary.

REPORT: return ONLY short conclusion bullets and verification evidence. Hard
cap 30 lines. If a criterion fails, state it; do not fake success.

Do not spawn additional tmux sessions or delegate further.
When done, write the structured completion to the literal result path injected
into this prompt. Put the REPORT bullets in its `summary` field.
