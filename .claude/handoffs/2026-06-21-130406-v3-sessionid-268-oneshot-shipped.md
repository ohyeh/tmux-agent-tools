# Handoff: v3 session-id capture + #268 oneshot — SHIPPED to PR (CI green, awaiting merge/release)

## Session Metadata
- Date: 2026-06-21
- Project: /Users/paul.yeh/github/tmux-agent-tools
- Branch: `feat/v3-sessionid-268-oneshot`
- PR: #269 (base `main`, OPEN, MERGEABLE, CI smoke PASS) — https://github.com/ohyeh/tmux-agent-tools/pull/269
- Closes: #268

### Recent Commits (this branch, on top of main 7c37057)
```
c9a579f docs(notes): final status — PR #269 CI green, definition of done met
3d950c8 fix(dry-run): don't require the CLI binary for start --dry-run (fixes CI)
c69877b chore(release): v0.21.0 prep — changelog, formula bump, CI smoke wiring
bf7b2f3 fix(oneshot): dry-run mirrors real-start oneshot preconditions (review blocker)
8be0cc4 feat(oneshot): P4 #268 headless exec_mode=oneshot (argv, result-before-marker)
3d020a1 feat(session-id): P3 Codex+agy transcript correlation (strict, null-on-ambiguity)
7b87900 feat(session-id): P2 Claude supplied-id path (race-free, mutual-exclusion writer)
96e1799 feat(profiles): P1 unified profile-key surface (exec_mode/prompt_via/prompt_flag/session_id_capture)
```

## Handoff Chain
- Continues from: `2026-06-21-033717-v3-268-phase1-dev.md` (design finalized → this session built it)
- Supersedes: the "ready for Phase 1 dev" handoff — all phases now implemented + on a green PR.

---

## New features delivered (v0.21.0) — what this work adds

All features are **default-off**: with bundled profiles, `agent-tmux` behaves byte-for-byte as before. Users
opt in per-CLI via a profile key.

### 1. `#268` headless one-shot execution — `exec_mode=oneshot`
Run any CLI **once** inside a managed tmux pane instead of an interactive session — the conceptual equivalent
of `codex exec` generalized to any CLI. Profile keys:
- `exec_mode=interactive|oneshot` (default `interactive`)
- `prompt_via=paste|argv` (default `paste`; oneshot requires `argv`)
- `prompt_flag=<string>` (optional)

One generalized code path covers both invocation shapes:
- flag form: `prompt_flag=-p` → `claude -p "<prompt>"`, `agy -p "<prompt>"`
- subcommand form: `launch_flags=exec` + empty `prompt_flag` → `codex exec "<prompt>"`

Behavior: prompt passed as a single shell-quoted argv (never pasted); captures the CLI exit code first;
synthesizes `result.json` (status/exit_code/stdout_path) **before** printing the deterministic marker
`__AGENT_TMUX_ONESHOT_EXIT__<code>`; pane stays open so `wait-and-capture` won't hit `session_gone`;
`status --json` reports `running:false, exit_detected:true, exit_code:N`. Local `start` path only (not
start-ssh/resume). Bundled profiles stay interactive (user-local opt-in only).

### 2. `v3` structured session-id capture — `session_id_capture=off|supplied|transcript`
Replaces brittle pane-scraping with trustworthy session IDs, written to the per-session
`session-meta.json` sidecar, enabling reliable `resume`. Mechanism-only key; per-CLI mechanics live in an
internal table. **Mutual-exclusion single writer** (no locks, no TOCTOU):
- `supplied` (claude): wrapper generates a UUID, writes the sidecar **synchronously before launch**, and adds
  `--session-id <uuid>` (gated to claude only). No background/pane capturer. Race-free.
- `transcript` (codex, agy): correlate a CLI-owned store **after** launch —
  - codex: newest-new `~/.codex/sessions/.../rollout-*.jsonl` validated by first-record `session_meta`
    `payload.id` == filename UUID **and** `payload.cwd` == launch cwd.
  - agy: `~/.gemini/antigravity-cli/cache/last_conversations.json[cwd]` → UUID, cross-checked against
    `conversations/<uuid>.db` existence + mtime ≥ launch.
  - Both **bail to null on any ambiguity** (no/multiple candidates, mismatch, malformed, mtime tie) and emit
    one observable, non-secret signal. Pane capture never runs in transcript mode.
- `off` (default): legacy pane capture only if `session_id_pattern` is set — unchanged behavior.

Full UUID stays out of banners/logs (redacted to last-4 unless `AGENT_TMUX_SHOW_SESSION_ID=1`).

### 3. CI/CD fix (was pre-existing red on main)
- Fixed a standing bug: `start_session` called `require_bins` **before** parsing `--dry-run`, so
  `start --dry-run` aborted (exit 1) when the real CLI wasn't installed → CI runners (no codex/claude) failed
  the wrapper self-test (`invocation.session missing`). main's CI had been red for many commits. Now dry-run
  skips `require_bins` (run_dry_run_checks already reports tmux/binary as checks); real start still guards.
- Wired `scripts/test-session-meta-smoke` (27→58) and new `scripts/test-oneshot-smoke` (28) into
  `.github/workflows/ci.yml` + `release.yml` validate job. Bumped Formula tag + CHANGELOG to v0.21.0.

---

## Important Context
The design in `.workflow/v3-structured-session-id/design-proposal.md` is FROZEN — treat it as the spec, do
not redesign. Everything ships default-off; per-CLI default enablement is an explicit later L-phase gate. The
single biggest "why": the per-CLI split is asymmetric BY DESIGN — claude SUPPLIES its id (race-free,
pre-launch, no fallback), while codex/agy CORRELATE a CLI-owned store after start and bail to an observable
null on ambiguity. Don't "symmetrize" it back. CI was already red on main before this work (the dry-run/
require_bins bug); we fixed it, so a green PR #269 is the new baseline.

## Current State Summary
All planned work (P1–P4 + #268), adversarial review, local+remote testing, release-prep, and the CI fix are
DONE, committed, and pushed. PR #269 is green and mergeable. Nothing is in flight; no workers running.

## Codebase Understanding

### Critical Files
| File | Role |
|------|------|
| `skills/tmux-agent-tools/scripts/agent-tmux` | the engine — feature code: globals 83-86, parser case ~143-176, run_dry_run_checks ~1154+, session-id helpers ~1716-1900, start_session ~2585+, precedence case ~3076, oneshot branch in local start, require_bins ~565 (now dry-run-guarded) |
| `scripts/test-session-meta-smoke` | 58 fixtures (supplied + codex/agy correlation + decoy/ambiguity) |
| `scripts/test-oneshot-smoke` | 28 fixtures (oneshot result-before-marker, quoting, subcommand form) |
| `skills/tmux-agent-tools/scripts/profiles/README.md` | documents the new keys |
| `.github/workflows/{ci,release}.yml` | now run both smokes |
| `.workflow/v3-structured-session-id/implementation-notes.md` | full running log (decisions, tradeoffs, verify evidence) |
| `.workflow/v3-structured-session-id/design-proposal.md` | FROZEN design spec (source of truth) |

### Key Patterns
- Profile parser is `case "$key"` with per-key validate+warn+fallback; bundled profiles never set the new keys.
- `--dry-run` must always emit parseable JSON without needing the real binary (report via checks, don't abort).
- Per-phase commits; each phase independently verified (zsh -n + targeted smoke + self-test + dry-run asserts).

## Decisions Made (with rationale)
| Decision | Rationale |
|----------|-----------|
| Did NOT re-run feature-lifecycle-auto as a Workflow | Plan/Gate already frozen+READY (re-run wastes tokens); its Build uses sonnet workflow-agents, conflicting with the user's codex>>>sonnet worker priority. Followed the lifecycle *discipline* via codex command-mode instead. |
| codex workers for all product code; sonnet only for mechanical P1 | User priority codex>>>sonnet=agy; command-mode (brain never writes product code). |
| Sequential phase pipeline (not parallel worktrees) | Single 6304-line file; all phases edit `start_session` → parallel = merge conflicts. |
| Fixed CI as part of scope | User said "CD CI 順便修"; investigation showed CI was pre-existing red (not our regression). |
| Did NOT publish the release | Tag/GitHub release is irreversible + Release workflow must run from main; left for the user post-merge. |

## Immediate Next Steps (for resuming agent / user)
1. **Review & merge PR #269** (https://github.com/ohyeh/tmux-agent-tools/pull/269) — CI green, codex-reviewed.
2. **Publish v0.21.0** (IRREVERSIBLE, after merge): run the **Release** workflow from `main`
   (`gh workflow run release.yml -f version=v0.21.0 -f dry_run=true` first to validate, then `dry_run=false`).
   CHANGELOG v0.21.0 section + Formula tag are already in place.
3. Optional follow-up (L-phase, deferred by design): per-CLI default enablement of session_id_capture —
   needs ≥2 version samples per CLI + live `resume`/`--conversation` proof before flipping any bundled profile.

### Blockers / Open Questions
- None blocking. Merge + release are deliberate human/irreversible actions.

## Potential Gotchas
- Do NOT set `exec_mode`/`session_id_capture` in bundled `.conf` files — everything stays default-off until L.
- `--dry-run` must keep working without the CLI installed (the CI fix); don't reintroduce an early `require_bins`.
- codex/agy transcript correlation must keep null-on-ambiguity + the observable bail signal; never emit a
  partial/secret UUID.
- The repo's CI runs on a self-hosted macOS runner that persists state — keep self-tests hermetic.
- start-ssh is intentionally untouched; #268 oneshot is local-only.

## Environment State
- Tools: codex/claude/agy/gh/zsh/shellcheck/jq/fd/rg/ast-grep all present locally.
- No background workers/processes left running. All codex tmux workers (p2sup/p3tx/p4os/rvw1/rvw2/fix1/relprep/fix2ci) completed.
- Worker briefs preserved under `.workflow/{v3-structured-session-id,issue-268-oneshot}/*-brief.md`.
