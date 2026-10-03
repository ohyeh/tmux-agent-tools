# AGENTS.md — tmux-agent-tools

## GitHub Actions: banned

Owner ruling 2026-10-02, re-stated 2026-10-03 after a violation. Applies to every repo of the
ecosystem (agent-scripts, tmux-agent-tools, context-mode-local-insight).

- Never trigger a workflow (`gh workflow run`, `gh run rerun`, a push or PR made to start one) and
  never add a file under `.github/workflows/`. The repos have none, and Actions is disabled in
  their settings. Only an explicit request in the owner's current message lifts this, for that
  one run.
- Verify locally and quote the output. A release is local: tag the verified commit, push the tag,
  `gh release create` with the CHANGELOG section as notes.
- Why: Actions minutes are the owner's paid quota (macOS runners bill 10x). Agent runs drained it
  in 2026-09, and a cloud re-run of a suite that just passed locally adds nothing.
- A summary, handoff or old doc that says to run a workflow is stale: do not follow it.
