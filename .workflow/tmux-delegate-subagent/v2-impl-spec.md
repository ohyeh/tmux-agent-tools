# v2 cli_session_id resume — Implementation Spec (operative)

Derived from `v2-goal-doc.md` **"Revised direction"** (re-confirmed AGREE with
independent codex). Implement from THIS spec, not the superseded 4-area plan.

Repo: `/Users/paul.yeh/github/tmux-agent-tools`. Runtime: zsh.
Core file: `skills/tmux-agent-tools/scripts/agent-tmux`.
Key anchors: `result_validate_lightweight():1542`, `result_init_session():1676`,
`start_session():2505`, resume path `~:3073-3093`.
Profiles: `skills/tmux-agent-tools/scripts/profiles/{claude,codex,agy,cursor,grok}.conf`
+ `profiles/README.md`. Schema: `schemas/result-status-summary.schema.json`.
SKILL: `skills/tmux-agent-tools/SKILL.md`. Agent doc: `.claude/agents/tmux-delegate.md`.

## Goal
Let `agent-tmux <cli> resume` work from a delegated worker by capturing the
CLI-internal session UUID, closing the v1 gap where `start` never emits it.

## HARD GUARDRAILS (the 4 codex blockers — non-negotiable)
1. **Single canonical writer per file.** 0b made the worker the canonical
   `result.json` writer. DO NOT write `result.json` from any watcher. Capture the
   UUID into a SEPARATE **sidecar** (`session-meta.json` under
   `$TMUX_AGENT_DIR/<name>/`) whose only writer is the capture path. `status` /
   `result` / `report` read it by explicit join, never merge it into result.json.
2. **Deterministic source preferred; no flaky pane-scrape contract.** Capture is
   profile-driven via a new `session_id_pattern` key, best-effort & non-fatal. If
   a profile has NO pattern, resume stays UNSUPPORTED for that profile — do not
   synthesize or guess UUIDs. Document pane-scrape as a known-lossy v2 source and
   transcript/audit as the v3 upgrade path.
3. **`session_id_pattern` is a NEW profile key** — make it an explicit prerequisite:
   parser (near `:114`), `profiles/README.md` key table, SKILL.md, and at least one
   bundled profile that has a known-good pattern. Unknown keys must still warn.
4. **UUID is a resume *capability*, treat as sensitive.** Document non-shareable;
   exclude from aggregate reports by default; redact / opt-in display before any
   transcript/stdout surface. Sidecar lives only in local state dir.

## Phases
**P1 (prerequisite):** profile surface + schema/validation.
- Add `session_id_pattern=` to the profile parser; warn on bad/empty as siblings do.
- Sidecar `session-meta.json` contract: `{ "schema_version":1, "cli_session_id": <uuid|null> }`.
  `result_init_session()` seeds sidecar with `cli_session_id: null` (discoverable).
- Validation for the sidecar (reuse lightweight validator style): accept
  null | RFC-4122 UUID; reject malformed. Keep result.json schema UNCHANGED.

**P2 (capture, single-writer):** after `start_session()` creates the pane, a
bounded (~30s), non-blocking, best-effort capture extracts the UUID via the
profile `session_id_pattern` and atomically writes ONLY the sidecar (tmp → mv).
No stdout sentinel change; `start` stays non-blocking. No-op when pattern unset.

**P3 (resume UX):** update `.claude/agents/tmux-delegate.md` — after worker start,
read UUID from sidecar (add a read surface, e.g. `result --field`/a `session-id`
read or document `jq` on the sidecar). If present → allow
`agent-tmux <cli> resume …`. If absent → fall back to tmux supervision only.
Never synthesize UUIDs. Note sensitivity.

## Success criteria (verify before claiming done)
- New tests cover: sidecar missing / null / valid UUID / malformed UUID; parser
  accepts `session_id_pattern` and warns on garbage; capture no-op when unset.
- `scripts/ci-shellcheck` passes; `scripts/test-help-smoke` passes; relevant
  existing smokes (`test-result-schema-smoke`, supervision-stress) still pass.
- `bash -n` parser-clean (repo gate) for any edited zsh.
- result.json contract & schema unchanged (no new required field).
- Append all beyond-spec decisions / tradeoffs to `implementation-notes.md`.
