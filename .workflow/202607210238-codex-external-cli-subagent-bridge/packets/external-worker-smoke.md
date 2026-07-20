GOAL: Verify the external Codex CLI worker path for the native proxy bridge in
`/Users/paul.yeh/github/tmux-agent-tools`. This proves that a Codex App native
sub-agent can supervise one external `codex-tmux` worker without doing the
worker's task itself.

CONTEXT: This is a read-only smoke test. Run
`skills/tmux-agent-tools/scripts/agent-tmux --version` from the repo root.

ACCEPTANCE:
- The command exits 0 and prints exactly `0.36.0`.
- No repository files are changed.
- Write a valid schema-version-1 `result.json` to the literal result path
  injected by the wrapper, with `status` set to `success` and a concise
  `summary` containing the command, exit code, and version output.

VERIFY BEFORE REPORTING: run `git status --short` and confirm this worker added
no changes beyond the pre-existing worktree state.

REPORT: return ONLY short conclusion bullets + `file:line` per claim +
verification evidence if you changed anything. Hard cap 30 lines. Long
artifacts -> write to the wrapper-provided result artifact path and return the
path. Do not paste file contents or logs.
If you cannot meet an acceptance criterion, say which one and why - do not
fake it.

Do not spawn additional tmux sessions or delegate further.
When done, write the structured completion (result.json contract,
schema_version 1) to the literal result path injected into this prompt - do
not rely on `$TMUX_AGENT_RESULT` inside tool sandboxes. Put the REPORT bullets
in its `summary` field.
