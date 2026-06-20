# tmux-delegate subagent v1 — Implementation Notes (running)

Brain: Claude (director). Implementer: codex worker via tmux-agent-tools.

## Decisions taken beyond the spec

- **OQ-1 path RESOLVED → `.claude/agents/tmux-delegate.md`.** Claude Code's real
  subagent discovery is `.claude/agents/*.md` with YAML frontmatter. The repo's
  `skills/tmux-agent-tools/agents/openai.yaml` is the Cursor/OpenAI *interface*
  schema (display_name/short_description/default_prompt) — a different mechanism,
  not a Claude Code subagent. We do NOT reuse it.
- **Frontmatter schema correction.** Spec tentatively wrote `allowed-tools:`.
  Real Claude Code subagent frontmatter uses `name:`, `description:`, `tools:`
  (comma-separated), `model:`. We ship the real schema. S8 audit maps every tool
  used in the body to the `tools:` list.
- **OQ-2:** `disable-model-invocation` NOT used (per spec).
- **OQ-4 / --resume:** dropped from v1 body (confirmed gap: `resume` needs a CLI
  UUID `start` never emits). Body carries a comment pointing to v2 task 3A-V2.
- **doctor --json must bypass `require_tmux`.** require_tmux hard-`exit 1`s before
  any JSON prints. The `--json` path treats tmux as an independent named check
  (`tmux`) alongside `agent_cli_binary`; never proves CLI-missing by wiping PATH.
- **JSON built without hard jq dependency** in the doctor path (manual printf with
  escaped details) so `doctor --json` works even if jq is one of the failing checks.
- **Manifest bump includes `.codex-plugin/plugin.json`.** The brief verification only
  checks Claude/Cursor manifests, but the authoritative plan lists all four plugin
  manifests; v0.19.0 keeps Codex metadata in lockstep.
- **`bash -n` gate required parser-portable cleanup.** The runtime remains zsh, but
  the verification block requires `bash -n`; two empty `if` bodies, zsh numeric
  globs, and a zsh glob qualifier were converted to parser-portable equivalents.

## Status
- Phase 1 (3A-1 doctor --json, 3A-2 setup): dispatched to codex.
- Phase 2 (3B subagent, 3C SKILL.md, 3E evals): dispatched to codex.
- Phase 3 (3D manifests 0.18.1→0.19.0 + CHANGELOG): dispatched to codex.

## v2 — session_id_pattern / session-meta.json sidecar (P1–P3)

Implementer: Claude (inline, not a codex worker). Date: 2026-06-20.

### Decisions

1. **`session_id_pattern` UNSET in bundled profiles (canonical decision — see round-3 note).** No verified deterministic session-label format exists for `claude` or `codex` across versions. Resume is unsupported by default (guardrail #2). Operators opt in per-CLI by setting `session_id_pattern` to a label-anchored ERE in a user-local profile once they confirm the exact label line their version prints.

2. **`session_meta_validate()` returns a plain word, not JSON.** Spec says "reuse lightweight validator style" but the only callers are the smoke test and resume UX documentation. A JSON envelope would add ~30 LOC with no consumer benefit yet. Ponytail: kept it a one-word verdict (`ok`, `null`, `missing`, `malformed:<val>`). If a JSON consumer is added later, this can be upgraded.

3. **`spawn_session_id_capture` uses `grep -oE` not `rg`.** The spec does not require `rg` inside subshell captures (the AGENTS.md rule applies to interactive file search, not to embedded pane-text extraction). `grep -oE` is always available in the pane capture subshell; `rg` may not be on PATH for all users.

4. **Capture subshell uses `date +%s` for deadline arithmetic.** Portable zsh/bash; `$EPOCHSECONDS` is zsh-specific and not safe in all subshells.

5. **Smoke test sources agent-tmux to call `session_meta_validate` and `spawn_session_id_capture`.** This is source-only-safe per spec ("no real tmux sessions needed"). The source side-effects are guarded by setting `CLI=claude` and `_PROFILE_FILE_FLAG=''` so profile loading runs cleanly.

6. **result.json schema and contract are unchanged.** `session-meta.json` is a separate sidecar; `result.json` still matches `result-status-summary.schema.json` exactly. Guardrail 1 satisfied.

### Open questions for codex review

- Should `session_meta_validate` emit structured JSON for forward-compatibility with a `result --field` surface?
- Is `disown 2>/dev/null || true` the right portable pattern to silence "no job control" warnings in non-interactive subshells on all platforms?
- The `spawn_session_id_capture` sleep loop polls every 2s × 15 iterations = 30s max. Should the interval be configurable via profile?

### Round-1 fixes (B1–B3, codex DISAGREE resolution)

**B1 — sidecar read surface:**
- `result --field .cli_session_id` now falls back to `session-meta.json` when absent/null in `result.json`.
- Captured jq output before the exit-code check so null values (which `jq -e` exits 1 for) don't leak to stdout; only the sidecar path prints.
- Only `.cli_session_id` / `cli_session_id` gets the sidecar join — all other fields behave as before.

**B2 — live patterns in bundled profiles (REVERTED in round-3):**
- Round-1 set a broad RFC-4122 ERE in `claude.conf`/`codex.conf`. This was reverted in round-3 as a guardrail-2 violation (shape alone can't distinguish the session UUID from a decoy UUID on a different line).
- Smoke test Part 4 uses an explicit blank-pattern custom profile (not the bundled profile).
- Smoke test Part 5 added: positive capture test with fake pane text containing a UUID.
- Smoke test Part 2 refactored: `call_session_meta_validate()` uses a temp script file.

**B3 — UUID redaction in resume path:**
- `_sid_display` computed before pane/transcript/stdout: `<redacted:XXXX>` (last 4) by default; full UUID only when `AGENT_TMUX_SHOW_SESSION_ID=1`.
- Pane startup printf, transcript `resume_id`, and wrapper stdout `session id:` line all use `$_sid_display`.
- The actual CLI invocation (`${RESUME_KEYWORD} $(shell_quote "$cli_session_id")`) still passes the full UUID to the CLI — only display surfaces are redacted.

**Decision:** `<redacted:last4>` fingerprint chosen over `<redacted>` to help operators correlate sessions without exposing the full UUID.

### Round-2 fixes (B1 value integrity + B2 doc mismatch)

**B1 — defense-in-depth UUID validation:**
- Added `_is_rfc4122_uuid()` as a single canonical shape check (same RFC-4122 regex previously inlined in `session_meta_validate`). All three paths now call it.
- `session_meta_validate()` updated to call `_is_rfc4122_uuid` (removes inline duplicate).
- `spawn_session_id_capture()`: validates `$uuid` via `_is_rfc4122_uuid` before writing sidecar — non-UUID grep matches are silently skipped (loop continues until deadline).
- `result --field .cli_session_id` read fallback: validates sidecar value via `_is_rfc4122_uuid` before returning — non-UUID value → falls through to exit 1 (field-not-found semantics), value never printed.
- Smoke test Part 5 `_run_capture_inline` helper updated to include the validation guard.
- Smoke test Part 7 added: (a) non-UUID pane → sidecar stays null; (b) hand-written non-UUID sidecar → read exits 1 and does not print the value.

**B2 — doc/profile mismatch corrected (superseded by round-3):**
- Round-2 updated docs to match the (now-reverted) live-pattern decision.
- Round-3 re-corrects all three surfaces to the canonical "UNSET by default" statement.

### Round-3 fixes (design pivot: label-anchored capture + revert broad pattern)

**Canonical decision on `session_id_pattern`:** UNSET in bundled profiles. Resume unsupported by default. Guardrail #2: no verified deterministic session-label format for claude/codex. Round-1 broad RFC-4122 ERE reverted — shape alone cannot distinguish session UUID from decoy.

**B1 — two-stage label-anchored capture:**
- `spawn_session_id_capture()` rewritten: stage 1 = `grep -m1 -E "$pattern"` to find the first line matching the label anchor; stage 2 = `grep -oE` of fixed RFC-4122 sub-regex from THAT line only + `_is_rfc4122_uuid` validation.
- Decoy UUIDs on non-matching lines are structurally ignored (not just shape-filtered).
- `profiles/README.md` key table entry for `session_id_pattern` already describes it as an ERE; operators now understand it as a label/line selector, not a UUID shape pattern.

**B2 — single canonical doc statement:**
- `SKILL.md`, `.claude/agents/tmux-delegate.md`, and `implementation-notes.md` all now state: bundled profiles UNSET, capture label-anchored + UUID-validated, operators opt in per-CLI with a label-anchored ERE.

**Smoke test Part 8 added:** decoy UUID on an earlier line + labeled session line; with a label-anchored pattern, asserts capture writes only the labeled UUID (not the decoy).

### Round-4 fix (timing blocker — field read independent of result.json)

**Root cause:** `result --field .cli_session_id` previously reached the sidecar read only after the missing-result.json guard (which exits 1 when result.json is absent). But `start_session` removes result.json — so the primary v2 resume window (post-start, pre-final-result) had no result.json and the read always failed. The smoke test masked this by calling `result init` first.

**Fix:** Added an early intercept in `result_session()` — before the wait/missing-file guard — that handles `.cli_session_id` / `cli_session_id` field reads entirely from `session-meta.json`. Since `cli_session_id` is never in result.json body (schema is `additionalProperties:false`), result.json need not exist. Returns UUID (exit 0) or field-not-found (exit 1); result.json is never touched.

**Cleanup:** Removed the now-unreachable sidecar fallback from the post-result.json `--field` block (kept the block clean for all other field reads).

**New test (Part 6d):** Writes only the sidecar (no `result init`, no result.json) and asserts `result --field .cli_session_id` returns the UUID (exit 0) with no result.json side-effect.
