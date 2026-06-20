# tmux-delegate / agent-tmux v2 — Goal Doc (next iteration)

Drafted by brain + codex teammate after v1 ship. Source backlog: plan.md task 3A-V2.

## Goal
Enable `agent-tmux <cli> resume` from a delegated worker by capturing the CLI-internal
session UUID into `result.json` (`cli_session_id`), closing the v1 gap where `start`
never emits the UUID `resume` requires.

## Plan (4 areas) — ⚠️ SUPERSEDED (pre-0b draft; see "Revised direction" at bottom)

> The 4-area plan below is the ORIGINAL pre-0b draft, kept for history. It is
> superseded by the "Revised direction" section at the end of this doc (the
> watcher→result.json merge is dropped due to the 0b single-writer conflict).
> Implement from "Revised direction", not from here.

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

---

## Adversarial consensus (independent codex) — REVISION REQUIRED

This doc was drafted before Packet 0b shipped and an independent codex review returned **DISAGREE / premise_ok=false**. The resume *gap* is real, but the plan as written must not proceed. Verified blockers (cited to committed code):

1. **CONFLICTS WITH 0b — fatal.** 0b made the worker the canonical `result.json` writer: `start` exports the path to the pane (`agent-tmux:2499-2502`) and prepends it to the prompt for codex/generic (`agent-tmux:1701-1705`, sent `agent-tmux:2801-2803`). A separate watcher doing `jq→temp→mv` into the SAME file races/clobbers the worker's final write and can make `result --field .cli_session_id` return a half-written watcher file. → **Do NOT write result.json from a watcher. Use a sidecar** (e.g. `session-meta.json` / `cli-session-id`) that status/result/report read by explicit join, **or** require the worker to include `cli_session_id` in its own final result contract. Single canonical writer per file.
2. **Pane-scrape UUID is not a deterministic source.** Screen-clearing TUIs hide it (doc admits). A sometimes-present ID is an unstable resume contract. → Prefer a deterministic CLI-owned source (transcript/audit/log capture, provider metadata). If a profile has no deterministic source, **leave resume unsupported for that profile** rather than best-effort scraping.
3. **`session_id_pattern` does not exist yet.** Profile parser has only `resume_keyword` (`agent-tmux:114`) and `result_path_via_prompt` (`agent-tmux:131-139`); unknown keys warn (`:140`); README lists neither new key (`profiles/README.md:31-34`). → Make profile schema/parser/docs/tests for `session_id_pattern` an **explicit prerequisite packet**, not an assumed capability.
4. **UUID is a resume *capability*, not harmless metadata** (resume echoes it in pane text `:3073`, records transcript `resume_id` `:3083-3086`, prints to stdout `:3091-3093`). → Treat as sensitive: document non-shareable, exclude from aggregate reports by default, add redaction/opt-in display before putting it on result/transcript-facing surfaces.

### Revised direction (re-confirmed AGREE with independent codex)
v2 sequence becomes: **(P1) prerequisite** — design the deterministic `cli_session_id` source + `session_id_pattern` profile surface (schema/parser/docs/tests); **(P2)** capture into a **sidecar** (not result.json) OR into the worker's own result contract, single-writer; **(P3)** resume UX in `tmux-delegate.md` reads the sidecar/field, falls back to tmux supervision when absent, never synthesizes UUIDs; treat the ID as sensitive throughout. The original "watcher merges into result.json" approach is **dropped** (0b conflict).
