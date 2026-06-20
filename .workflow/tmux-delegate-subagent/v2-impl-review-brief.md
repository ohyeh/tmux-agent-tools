# Codex adversarial review brief — v2 cli_session_id resume (implementation)

## ROUND 5 — your round-4 blocker (timing: read needs result.json) is fixed
- B1: `result --field .cli_session_id` now intercepts EARLY, before the missing-result.json
  guard. Since `cli_session_id` is never in result.json body (additionalProperties:false),
  the sidecar is its only source — read+`_is_rfc4122_uuid`-validate the sidecar independent
  of result.json existence. Verified: with NO result.json present, the read returns the
  UUID at exit 0 and creates no result.json side-effect (the exact post-start/pre-final
  v2 window). New test Part 6d covers it without calling `result init` first.
- Re-verified: session-meta 27 passed, result-schema 32, ci-shellcheck, zsh -n — all 0.
Final attack. AGREE only with 0 blockers.

---

## ROUND 4 (history) — round-3 blockers fixed
- B1: capture is now LABEL-ANCHORED two-stage (agent-tmux:1737 `grep -m1 -E "$pattern"`
  selects the labeled line, then a fixed RFC-4122 sub-regex extracts + `_is_rfc4122_uuid`
  validates from THAT line only). A decoy UUID on an unlabeled line is ignored. Bundled
  `claude.conf`/`codex.conf` `session_id_pattern` REVERTED to UNSET (commented opt-in
  example) — resume unsupported by default per guardrail #2 (no verified deterministic
  label). New test Part 8 proves decoy-before-label captures the correct labeled UUID.
- B2: `implementation-notes.md ## v2` reconciled to ONE canonical decision (UNSET by
  default), with the round-1 broad-pattern explicitly marked REVERTED as history.
  `SKILL.md` + `tmux-delegate.md` match. No contradiction remains.
- Re-verified: session-meta 24 passed, result-schema 32, ci-shellcheck, zsh -n — all 0.
Attack again. AGREE only with 0 blockers.

---

## ROUND 3 (history) — round-2 blockers fixed
- B1: new `_is_rfc4122_uuid()` helper now gates THREE points — `session_meta_validate`,
  capture-before-write (skips write on non-match, keeps looping), and the
  `result --field .cli_session_id` read (non-UUID → exit 1, value NOT printed).
  Verified: hand-written `Session: not-a-uuid` sidecar → read exits 1 with
  "field not found", does not leak the bad value.
- B2: `SKILL.md:70` and `.claude/agents/tmux-delegate.md:88` now state the bundled
  claude/codex profiles ship a LIVE validated RFC-4122 pattern.
- Re-verified: session-meta 21 passed, result-schema 32, ci-shellcheck, zsh -n — all 0.
Attack again. AGREE only with 0 blockers.

---

## ROUND 2 (history) — round-1 blockers were all fixed
- B1 (read/join): `result --field .cli_session_id <name>` now falls back to joining
  `session-meta.json` (opt-in field read; exits 0 with UUID, 1 when null/missing).
  `status --json` and `team results` deliberately still omit it (sensitivity).
  Live probe now returns the UUID at exit 0.
- B2 (dormant): `claude.conf` + `codex.conf` ship a LIVE RFC-4122 `session_id_pattern`.
  New positive test proves `spawn_session_id_capture()` writes the sidecar when a
  pattern + fake pane UUID are present; validator cases now call `session_meta_validate()`.
  test-session-meta-smoke = 18 passed.
- B3 (sensitivity): resume path now redacts via `_sid_display` — default
  `<redacted:LAST4>`, full UUID only when `AGENT_TMUX_SHOW_SESSION_ID=1`. Pane text,
  transcript `resume_id`, and wrapper stdout all use the redacted form; the actual CLI
  resume invocation still receives the full UUID (required to resume).
- Re-verified: session-meta 18, result-schema 32, ci-shellcheck, help 42, zsh -n — all exit 0.
Attack the fixes. AGREE only with 0 blockers.

---


Review the IMPLEMENTATION of `.workflow/tmux-delegate-subagent/v2-impl-spec.md`
("Revised direction" of v2-goal-doc). Verdict format: `premise_ok` + `blockers[]`
(cite to committed/working-tree code lines). AGREE only with 0 blockers.

## What to attack (cite code)
1. **Single-writer integrity (blocker #1).** Confirm NO watcher path writes
   `result.json`. The UUID must land only in the `session-meta.json` sidecar via
   tmp→mv. Prove `result --field`/`status`/`report` read the sidecar by explicit
   join and cannot return a half-written file or clobber the worker's final write.
2. **Determinism (blocker #2).** Is the capture genuinely non-fatal & bounded? When
   `session_id_pattern` is unset, does resume stay unsupported (no synthesized UUID)?
   Is any bundled pattern actually reliable, or should it be left unset?
3. **Profile surface (blocker #3).** Parser accepts `session_id_pattern`, unknown
   keys still warn, README + SKILL document it. Tests cover accept + garbage-warn.
4. **Sensitivity (blocker #4).** UUID excluded from aggregate reports by default;
   redaction/opt-in before any stdout/transcript surface; sidecar stays in local
   state dir only.
5. **Contract/regression.** result.json schema & required fields UNCHANGED. zsh
   `bash -n` clean, ci-shellcheck + existing smokes green.

## Inputs
Changed files (working tree, uncommitted):
- `skills/tmux-agent-tools/scripts/agent-tmux` — `SESSION_ID_PATTERN` init +
  parser branch (~:115); `session_meta_validate()` (~:1678); `spawn_session_id_capture()`
  (:1710-1733, writes ONLY session-meta.json via tmp→mv, no-op when pattern unset,
  bounded 30s bg subshell); seed sidecar null in `result_init_session()` (:1748);
  hook in `start_session()` (:2840).
- `profiles/claude.conf`, `profiles/codex.conf` — `session_id_pattern` documented
  but UNSET (no reliable deterministic pane pattern; rationale inline).
- `profiles/README.md`, `SKILL.md` — key table + v2 sidecar resume flow.
- `.claude/agents/tmux-delegate.md` — v2 resume: read sidecar, use if non-null,
  fall back to supervision, never synthesize, sensitivity note.
- `scripts/test-session-meta-smoke` (new) — 11 cases.

Brain independent verification (re-run): test-session-meta-smoke 11 passed (exit 0);
test-result-schema-smoke 32 passed (exit 0); ci-shellcheck exit 0; test-help-smoke
42 passed. `zsh -n` clean. `bash -n` fails pre-existing (`always` blocks; same on
baseline — not introduced). result.json schema UNCHANGED.

Beyond-spec decisions: see `implementation-notes.md` `## v2`.

## Specific attack surfaces for codex
- init (:1748) seeds sidecar null AND capture (:1727) overwrites — confirm these
  are sequential (init before pane/capture), not a concurrent double-writer.
- `grep -oE "$pattern"` on pane text: injection / ReDoS / multi-match risk?
- All profiles ship the pattern UNSET → feature is dormant until a user opts in.
  Is shipping a dormant capability with no live profile acceptable, or does it
  need an end-to-end test with a fake pattern proving capture actually fires?
