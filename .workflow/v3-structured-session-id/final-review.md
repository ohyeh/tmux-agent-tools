# Final consistency + readiness review

Verdict: READY to start P1.

Fixes applied:
- Updated v3 goal-doc wording so "two proven mechanisms" explicitly means `supplied` + `transcript` across three CLIs, not two CLIs.
- Updated design-proposal agy rows to reflect round-3 source discovery: agy is `session_id_capture=transcript`, default-off until live resume/version/race gates pass.
- Marked the old write-when-null + tmp->mv rule as rejected, preserving the mutual-exclusion writer model as the only proposed model.
- Updated design P3/P4 wording from Codex-only transcript handling to Codex/agy transcript/store handling.
- Updated #268 goal-doc so shared Phase 1 includes `exec_mode`/`prompt_via`/`prompt_flag` plus v3 `session_id_capture`, while #268 remains owner of oneshot behavior and `result.json`.
- Added #268 non-goal text saying it does not write or interpret v3 `session-meta.json` beyond the shared parser/docs round.

Remaining blockers for development:
- None for P1. The P1 hard gates are concrete: parse/validate profile keys, preserve defaults, update profile docs, and run profile-parse/no-tmux checks.

Deliberately not changed:
- Kept all bundled profiles default-off; default enablement remains the later L gate.
- Kept round-3 agy caveats: live resume, version samples, and ambiguity behavior are post-P1 gates.
- Kept the rejected Round-1 writer-race paragraph because it explains why mutual exclusion replaced two-writer tmp/mv.
- Did not change implementation files or spawn sessions.

Citation spot-check:
- `agent-tmux:25-29` still matches preset resume keywords for claude/codex/agy/cursor/grok.
- `agent-tmux:110-117` still matches profile key parsing for `resume_keyword` and `session_id_pattern`.
- `agent-tmux:1753-1767` still matches result init plus `session-meta.json` sidecar seeding.
- `agent-tmux:3830-3845` still matches `.cli_session_id` sidecar-only field reads.
