# tmux-delegate / agent-tmux v2 — Goal Doc (next iteration)

Drafted by brain + codex teammate after v1 ship. Source backlog: plan.md task 3A-V2.

## Goal
Enable `agent-tmux <cli> resume` from a delegated worker by capturing the CLI-internal
session UUID into `result.json` (`cli_session_id`), closing the v1 gap where `start`
never emits the UUID `resume` requires.

## Plan (4 areas)

1. **Capture CLI UUID** — After `start_session()` creates the pane, spawn a short-lived
   (bounded ~30s, non-blocking, best-effort) watcher that captures the pane and extracts
   the UUID via a profile-configured `session_id_pattern=` regex (Claude/Codex patterns
   defined separately in default profiles). On match, atomically merge
   `{"cli_session_id":"<uuid>"}` into `$TMUX_AGENT_DIR/<name>/result.json` (jq → temp →
   `mv`). `start` stays non-blocking; no stdout sentinel change.

2. **Schema + validation** — `result_init_session()` writes `cli_session_id: null`
   (prefer null over omit for discoverability). Bundled result schema allows optional
   `cli_session_id` = null | UUID string. `result_validate_lightweight()` derives
   allowed extra fields from schema properties (not hardcoded). Tests: missing / null /
   valid UUID / malformed UUID. Canonical consumer:
   `agent-tmux <cli> result --field .cli_session_id --wait N <name>`.

3. **Resume pattern** — Update `.claude/agents/tmux-delegate.md`: after a worker starts,
   collect UUID via `result --field .cli_session_id --wait 30 <name>`. If present, allow
   `agent-tmux <cli> resume --exact <new-name> <repo-dir> <cli_session_id>`. If absent,
   fall back to tmux session supervision only — never synthesize UUIDs from wrapper names.

4. **Risks** — CLI output drift → extractor must be profile-configurable, failure
   non-fatal. Screen-clearing CLIs may hide the ID → transcript/audit hooks are a better
   v3 source. Concurrent writes → atomic jq merge. UUID is sensitive → keep to
   result/transcript surfaces already in local state. Resume semantics differ per CLI →
   enable only for profiles with known-good `resume_keyword` + `session_id_pattern`.

## Effort: L (multi-step schema + runtime + profile + subagent + tests). Sequence after
## v1 main-integration is resolved.
