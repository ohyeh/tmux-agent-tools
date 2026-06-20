# Implementation Notes — v3 session-id capture + #268 oneshot

Running log of decisions, deviations, and tradeoffs made during implementation.
Orchestration: command-mode. Brain = Claude (inventory/decide/dispatch/verify/rule).
Workers = sonnet subagents (impl) + codex (adversarial review). No product code written by brain.

## Worker priority (user, mid-run): codex >>> sonnet = agy
Routing: P1 (sonnet, already in flight — mechanical, brain verifies hard) finishes on sonnet.
P2/P3/P4 (behavior-changing, race-free sidecar, transcript correlation, oneshot result synthesis) →
**codex** via /tmux-agent-tools skill (not raw tmux). Adversarial review gate → codex. sonnet/agy = backup.

## Ponytail (full) — enforced in every worker brief + review gate
- No speculative abstraction: 4 keys = 4 case arms + 4 defaults; do NOT pre-wire L-phase config.
- P4 oneshot = ONE code path covering flag-form (`-p`) AND subcommand-form (`exec`), not two branches.
- Mutual-exclusion single-writer (not locks) — already the design, matches lazy/native-first.
- One runnable check per non-trivial path (profile-parse self-test; fake-CLI `-p` fixture). No frameworks.
- L default-enablement stays out of scope (ladder rung 1: not needed now → skip).
- Shortest working diff; surgical edits; mark deliberate simplifications with `# ponytail:` where useful.

Branch: `feat/v3-sessionid-268-oneshot` (off main @ 7c37057)
Spec (frozen): `.workflow/v3-structured-session-id/design-proposal.md`, `.workflow/issue-268-oneshot/goal-doc.md`

## Scope decision (brain)
- In scope this increment: **P1 → P2 → P3 → P4**.
- Out of scope BY DESIGN: **L (default enablement)** — design-proposal marks it an explicit later gate
  requiring ≥2 version samples per CLI + live resume proof. All four shipped phases stay default-off.

## Orchestration decision (brain) — why not the heavy Workflow() tool
- Target is ONE 6304-line zsh file (`skills/tmux-agent-tools/scripts/agent-tmux`); all phases edit
  overlapping regions of `start_session`. Parallel worktrees would only manufacture merge conflicts.
- Chosen shape: **sequential worker pipeline** (one sonnet subagent per phase) with a brain verify gate
  (`shellcheck` + `zsh -n` + profile-parse self-test) between phases, then a **codex adversarial review loop
  until no objections**, then commit/push/release. Lazy-correct over ceremony; saves tokens.

## Code-surface map (brain inventory)
| Surface | Location | Phase |
|---|---|---|
| Global default init (PROFILE_APPROVAL/RESULT_PATH_VIA_PROMPT/SESSION_ID_PATTERN) | agent-tmux:75–82 | P1 |
| Profile `case "$key"` parser | agent-tmux:~108–150 | P1 |
| Post-load default resolution | agent-tmux:156 | P1 |
| Preset table (per-CLI defaults) | agent-tmux:25–30 | P1/P4 |
| `start_session()` | agent-tmux:2585 | P2/P3/P4 |
| `tmux new-session` (start) | agent-tmux:2853 | P4 oneshot branch inserts before here |
| `tmux new-session` (resume) | agent-tmux:3163 | P2 (supplied id) |
| profiles/README.md key table | — | P1 |
| profiles/{claude,codex,agy}.conf | — | P2/P3 |

## Post-build scope (user-added mid-run)
- After P1–P4: **local + remote combined testing** (`start` local + `start-ssh` remote path) for the new
  exec_mode/session-id behavior.
- **Fix CD/CI**: the release/CI workflow (ci-shellcheck + GitHub Actions Release). Sandbox here can't run
  ci-shellcheck (`sed` PATH gap) — confirm GitHub CI green and fix anything the new code trips.
- Sequence: P1–P4 build → codex adversarial review (until clean) → local+remote test → CI/CD fix → push → release.

## Phase log
### P1 — unified profile-key surface
- Status: DONE + VERIFIED (sonnet worker p1-parser)
- Diff: agent-tmux +169 (defaults L83–86, parser arms L143–176, self-test L4861–4997, dispatch arm), README +4.
- 4 globals: `EXEC_MODE=interactive`, `PROMPT_VIA=paste`, `PROMPT_FLAG=''`, `SESSION_ID_CAPTURE=off`.
- Validation matches existing `approval)` arm convention (warn to stderr + fallback to default); unknown
  keys still hit the `*)` catch-all. Bundled .conf files untouched (default-off). Zero runtime behavior change
  (diff hunks only: globals / parser case / self_test / command-dispatch — no start_session edits).
- Self-test: `agent-tmux <cli> self-test` → `self-test profile-keys: ok`. Covers defaults, valid values,
  unknown-value warn+fallback (exec_mode/prompt_via/session_id_capture), prompt_flag empty+arbitrary.
- Verify: `zsh -n` PASS · self-test ok · help smoke PASS.
- ENV LIMIT: `scripts/ci-shellcheck` can't run in this sandbox (`sed` not on child PATH → exit 127);
  reproduced identically on main with P1 stashed → pre-existing env gap, NOT a regression. agent-tmux is a
  zsh script so its gate is `zsh -n` (pass); full shellcheck runs on GitHub CI before release.
- Brain false-alarm caught + cleared: `spawn_session_id_capture` looked like a P2/P3 leak but pre-exists on
  main (1722→1754, shifted by inserted lines above). No scope violation.

### P2 — Claude supplied-id path
- Status: DONE + VERIFIED (codex worker p2sup). Diff: agent-tmux +83/-6.
- New helpers: `supplied_session_id_flag()` (returns `--session-id` ONLY for claude → other CLIs can set
  capture=supplied without an unsupported flag), `new_cli_session_id()` (lowercase uuidgen),
  `write_session_meta_id()` (atomic tmp+mv).
- Precedence (start_session ~2934): supplied → sync sidecar write pre-launch + `--session-id`, spawn nothing;
  transcript → P3 no-op stub (`# P3:` marker @2938), spawn NO pane; off → legacy `spawn_session_id_capture`
  only when SESSION_ID_PATTERN set; else null. One writer per session, no locks.
- Supplied handled in BOTH dry-run preview (~1257) and real start (~2915) so the sidecar is written before
  either launch path (reused by P4 oneshot).
- Brain verify (independent): zsh -n ✓ · self-test profile-keys+dry-run ok · test-session-meta-smoke 27/0 ✓ ·
  default-off dry-run has NO --session-id ✓ · supplied dry-run --session-id == sidecar cli_session_id (MATCH) ✓ ·
  security: start banner omits UUID, resume display redacted to last4 unless AGENT_TMUX_SHOW_SESSION_ID=1 ✓.
- Note: `scripts/test-session-meta-smoke` lives at REPO ROOT scripts/ (not skills/.../scripts) — pre-existing.
- Worker deviation (self-reported, no product impact): used cat/sed early while reading brief before switching
  to fd/rg/jq. Flagged for the codex hard-tool-mapping rule; output unaffected.

### P3 — Codex/agy transcript correlation
- Status: DONE + VERIFIED (codex worker p3tx). Diff: agent-tmux +143, test-session-meta-smoke +161.
- New helpers: `session_id_capture_signal` (one non-secret bail signal), `session_id_codex_snapshot`,
  `session_id_correlate_codex` (snapshot-exclusion + mtime floor + filename UUID + first-record session_meta +
  payload.id match + launch cwd match; ok/wait/bail protocol), `session_id_correlate_agy`
  (last_conversations.json[cwd] → UUID → conversations/<uuid>.db exists + mtime ≥ launch),
  `spawn_transcript_session_id_capture` (background structured writer).
- Precedence case @3076: supplied→noop · transcript→structured capturer · off→legacy pane
  (`spawn_session_id_capture`, internally SESSION_ID_PATTERN-gated = original behavior). Pane never spawned in
  transcript mode.
- Brain verify (independent): zsh -n ✓ · test-session-meta-smoke 58/0 (was 27, +31) ✓ · codex self-test ok ✓ ·
  default-off: no session_id_capture in bundled codex.conf/agy.conf ✓ · precedence case confirmed by eyeball.
- Fixtures: codex {success, basename/payload mismatch, malformed first record, cwd mismatch, no candidates,
  multiple candidates, mtime tie, decoy} + agy {success, missing cwd key, malformed cache UUID, stale db,
  missing db, decoy} + asserts: exactly one bail signal, null sidecar on bail, transcript wiring.

### P4 — #268 oneshot start_session branch
- Status: DONE + VERIFIED (codex worker p4os). Diff: agent-tmux +55/-7, scripts/test-oneshot-smoke NEW.
- Single argv code path: flag form `<bin> <flags> -p "<prompt>"` and subcommand form `<bin> exec "<prompt>"`
  (empty prompt_flag omitted). Prompt is one shell_quoted argv (quotes preserved), never pasted. cli_code=$?
  captured first, result.json synthesized best-effort BEFORE deterministic marker `__AGENT_TMUX_ONESHOT_EXIT__<code>`,
  pane-open `read _` tail preserved, exits with true cli_code.
- Brain verify (independent): zsh -n ✓ · test-oneshot-smoke 20/0 (incl. result-before-marker) ✓ ·
  test-session-meta-smoke 58/0 no regression ✓ · self-test ok ✓ · flag-form dry-run quotes preserved ✓ ·
  subcommand-form dry-run ✓ · interactive dry-run 0 oneshot mentions (unchanged) ✓ · bundled profiles not set
  to oneshot ✓.

## Build complete: P1–P4 all VERIFIED. Next: codex adversarial review (full diff main..HEAD) → local+remote
## test → CI/CD fix → push → release.

### Adversarial review
- Status: DISPATCHED (codex reviewer on full diff main..HEAD)
