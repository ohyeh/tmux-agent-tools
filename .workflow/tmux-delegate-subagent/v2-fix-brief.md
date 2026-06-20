# v2 fix brief — resolve 3 codex blockers (round 1)

codex DISAGREE/premise_ok=false. Fix all 3, keep the confirmed-good parts intact
(single-writer on result.json; init→capture sequencing). Repo
`/Users/paul.yeh/github/tmux-agent-tools`, core `skills/tmux-agent-tools/scripts/agent-tmux`.

## B1 — add sidecar read/join surface (CRITICAL)
The UUID is written to `session-meta.json` but no read path joins it; `result
--field .cli_session_id` exits 1. Fix as an **opt-in field read** (this also
satisfies B3 sensitivity — see design note):
- In `result_session()` `--field` path (~agent-tmux:3868-3870): when the requested
  field is `.cli_session_id` (or `cli_session_id`) AND it is absent from result.json
  body, fall back to reading `cli_session_id` from the sibling `session-meta.json`.
  Return it on stdout, exit 0 when present; exit 1 (field-not-found) when sidecar
  null/missing. ponytail: smallest join — only this one field falls back.
- Do NOT add the UUID to `status --json` plaintext, and do NOT add it to
  `team results` aggregate — those stay UUID-free by default (sensitivity).

## B2 — make capture live + add positive test
- Ship a known-good `session_id_pattern` in `claude.conf` AND `codex.conf` set to
  the RFC-4122 UUID shape: `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`
  (first UUID on the pane after start). Keep the rationale comment but make it ACTIVE
  (uncomment / set). Best-effort + bounded + non-fatal already covers determinism:
  screen-clear → no match → resume falls back. Update README/SKILL to say it ships live.
- Positive capture test in `test-session-meta-smoke`: configure a fake profile with
  a `session_id_pattern`, drive a fake tmux pane whose text contains a UUID, run the
  capture, assert `session-meta.json` ends up with that exact UUID. Also switch the
  existing validator cases to call `session_meta_validate()` directly (not a
  duplicated local regex) so the test exercises real code.

## B3 — gate UUID on stdout/pane/transcript in the resume path
Existing resume path (agent-tmux:3134-3158) leaks the UUID. Redact by default,
full only on explicit opt-in `AGENT_TMUX_SHOW_SESSION_ID=1`:
- pane startup text (~:3134-3137) and wrapper stdout (~:3154-3158): print a redacted
  fingerprint by default (e.g. `session id: …<last4>` or `session id: <redacted>`),
  full UUID only when opt-in set.
- transcript start event `resume_id` (~:3142-3151): store redacted fingerprint by
  default; full only on opt-in. Check existing resume/transcript smokes still pass
  (adjust assertions only if they asserted the plaintext UUID — and if so, keep a
  case for the opt-in full path).

## Verify (paste exit codes)
`zsh -n` edited files; `scripts/ci-shellcheck`; `scripts/test-help-smoke`;
`scripts/test-session-meta-smoke` (incl new positive case); `scripts/test-result-schema-smoke`;
plus any resume/transcript smoke touched. result.json schema/contract UNCHANGED.
Append round-1 fixes to `implementation-notes.md` `## v2` (do not rewrite).
