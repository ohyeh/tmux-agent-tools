# Handoff: v0.29.0 released — issues #298–#302 fixed via commander-mode workers, full smoke suite wired into CI

## Session Metadata
- Created: 2026-07-03 00:33:44
- Project: /Users/paul.yeh/github/tmux-agent-tools
- Branch: main
- Session duration: ~2 days across compactions (2026-07-01 → 2026-07-03)

### Recent Commits (for context)
  - 0d726cb release(formula): bump to v0.29.0 (#310)
  - b3e161a release: v0.29.0 (#309)
  - d34aa48 ci: run the full smoke suite (+ tied-locals lint) on every push/PR (#308)
  - 0dbc0ff feat(#302): EXTRA_LAUNCH_FLAGS append semantics + first-class start --effort (#307)
  - a9c2114 docs(#301): encode observed operational traps into the skill content (#306)

## Handoff Chain

- **Continues from**: [2026-07-02-021433-issue-293-codex-adapter-v0280-released.md](./2026-07-02-021433-issue-293-codex-adapter-v0280-released.md)
  - Previous title: Issue #293 (Codex sub-agent adapter/provider) fully implemented, adversarially reviewed, released as v0.28.0
- **Supersedes**: None

> Review the previous handoff for full context before filling this one.

## Current State Summary

Everything shipped and cleaned up. Six PRs (#303–#308) merged sequentially to main fixing issues #298–#302 plus full-suite CI wiring, then release PR #309 (CHANGELOG heading + three plugin.json manifests → 0.29.0), tag v0.29.0 + GitHub Release published via workflow_dispatch (dry-run first), and formula bump PR #310 merged. Issues #298–#302 auto-closed via PR "Closes" keywords. Adversarial codex gate on the integrated tree returned AGREE with no blockers (including live hostile-input probes on the #302 launch-flag surface). main's full smoke suite CI run is green. All worktrees, worker branches, and tmux sessions removed; home skill copies (`~/.agents/skills/{tmux-agent-tools,using-tmux-agent-tools}`) synced to main and self-tested.

## Codebase Understanding

## Architecture Overview

- `skills/tmux-agent-tools/scripts/agent-tmux` (~7100-line zsh engine) drives AI CLIs as managed tmux workers; wrappers claude-tmux/codex-tmux/agy-tmux are thin shims. Workers report via result.json contract; sends are nonce-verified; watch is bounded.
- `require_bins()` (engine ~line 620) runs BEFORE arg-validation guards and exits 1 when the provider CLI is unresolvable. Dev machines never see this (CLI always present); a clean runner does. CI now installs `sleep 300` stub codex/claude on GITHUB_PATH so error-path smokes reach their intended exit-2/exit-4 guards.
- `tmux-agent-history` needs an FTS5-capable sqlite3 (`SQLITE` env or PATH); GH macos runner's system sqlite3 lacks FTS5, so CI installs brew sqlite and prepends its keg bin to GITHUB_PATH.
- Release pipeline: release.yml workflow_dispatch validates a `## vX.Y.Z` CHANGELOG section exists on main (so a "release: vX.Y.Z" PR converting `## Unreleased` must merge first), and `scripts/test-version-sync-smoke` requires the three plugin.json manifests to match the latest CHANGELOG version. Formula is intentionally bumped in a separate post-tag PR.

## Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| skills/tmux-agent-tools/scripts/agent-tmux | zsh engine | all #298/#299/#300/#302 fixes live here |
| .github/workflows/ci.yml | CI | now runs full suite via scripts/run-all-smokes + CLI stubs + FTS5 sqlite |
| scripts/run-all-smokes | full-suite runner | 180s/test timeout, retry-once, FLAKY-PASS/TIMEOUT labels |
| skills/tmux-agent-tools/references/profiles.md | profile docs | documents launch-flag env vars as operator-controlled raw shell fragments |
| skills/tmux-agent-tools/scripts/profiles/codex.conf | codex profile | ships `effort_flags=-c model_reasoning_effort=%s` |
| .github/workflows/release.yml | release | requires CHANGELOG version section; dry_run input available |

### Key Patterns Discovered

- Squash-merge-only repo; one logical change per PR; every PR that touches CHANGELOG must be assembled serially from freshly-pulled main.
- `watch --any` only reports results written after arming — always check `result --json .present` per worker before re-arming (now documented in references/multi-agent.md).
- zsh tied specials (`status`, `path`, `lines`) are lint-banned as locals (`scripts/lint-no-path-tied-locals`, now an early CI step).

## Work Completed

### Tasks Finished

- [x] #298: task-scope guard injected once per session (sidecar marker, #283 semantics) — PR #304
- [x] #299: reject flag-looking tokens in positional slots, exit 2 — PR #303
- [x] #300: six-fix hardening batch (tied locals, `$lines`, bounded send-lock fallback, deterministic session env, caller-text transcript send events, `--regex` waits) — PR #305
- [x] #301: skill docs hardening (flag-order rule, tmux-agent-sessions list, commander shrinking-fleet loop) — PR #306
- [x] #302: EXTRA_LAUNCH_FLAGS append semantics + first-class `start --effort` + raw-shell trust-class doc note — PR #307
- [x] Full smoke suite in CI + runner env fixes (CLI stubs, FTS5 sqlite, secret-uri cleanbin tmux symlink) — PR #308
- [x] Release v0.29.0 (PR #309, tag + GitHub Release, dry-run then real) and formula bump (PR #310)
- [x] Issues #298–#302 closed; adversarial gate AGREE; main full-suite CI green; worktrees/branches/sessions cleaned; home skills synced

## Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| skills/tmux-agent-tools/scripts/agent-tmux | #298 sentinel, #299 guard, #300 fixes, #302 flags | issue fixes (worker-implemented) |
| .github/workflows/ci.yml | full suite, lint step, coreutils/sqlite, CLI stubs, 30m timeout | stop recurring regressions |
| scripts/run-all-smokes | new runner | full-suite classification |
| scripts/test-secret-uri-smoke | cleanbin tmux symlink | CI has tmux outside system PATH |
| skills/tmux-agent-tools/SKILL.md + references/*.md | #301 docs + #302 raw-shell note | encode operational traps |
| CHANGELOG.md, .{claude,codex,cursor}-plugin/plugin.json | v0.29.0 | release |
| Formula/tmux-agent-tools.rb | v0.29.0 tarball + sha256 | post-tag formula bump |

## Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| CI-side CLI stubs over engine reordering | move require_bins after arg validation vs stub codex/claude on runner | stubs mirror what every dev machine already has; engine reordering is a bigger behavior change with no user-facing need |
| Serial PR pipeline | parallel PRs | every PR edits CHANGELOG Unreleased; serial avoids conflicts |
| PR order #299→#298→#300→#301→#302→CI | — | transcript residue depends on #298 context; CI last so its merge proves the suite on main |
| EXTRA_LAUNCH_FLAGS stays raw shell | sanitized argv API | same trust class as existing LAUNCH_FLAGS; documented instead (gate recommendation) |

## Pending Work

## Immediate Next Steps

1. Nothing outstanding for this cycle — v0.29.0 is fully shipped.
2. Optional: issue #293 remains OPEN (Codex sub-agent adapter/provider feature) — future work track.
3. Optional: consider tenant-isolating workers that run the full smoke suite (see Gotchas).

### Blockers/Open Questions

- [ ] None.

### Deferred Items

- Engine ordering (arg validation before `require_bins`) — deliberately NOT changed; revisit only if a real user hits confusing exit-1-before-usage-error behavior on a machine without the CLI.

## Context for Resuming Agent

## Important Context

- Commander mode was the standing constraint this session: all product code implemented by isolated codex tmux workers (`codex-tmux start --exact --prompt-file <spec> <name> <worktree>` with `-c model_reasoning_effort=high`); the commander only inventories, dispatches, independently re-verifies, and adjudicates. Release/CI mechanics and two-line env fixes were done directly.
- The full-suite CI's value proved out immediately: it exposed two host-environment assumptions (missing codex/claude CLIs → require_bins exit 1 shadowing guard exits; missing FTS5 sqlite) that no dev machine could surface.
- The adversarial gate's only residual note: `*_TMUX_EXTRA_LAUNCH_FLAGS` / `LAUNCH_FLAGS` are operator-controlled raw shell fragments — documented in profiles.md, never to be populated from untrusted input.

## Assumptions Made

- GH macos-latest runner characteristics (no codex/claude, system sqlite3 without FTS5, tmux via brew) stay stable; the CI install step re-checks each brew package idempotently.

## Potential Gotchas

- A worker running `scripts/run-all-smokes` from inside a codex-cli tmux session gets its own session killed by session-hygiene smokes (this killed worker wkcistub mid-verification). Run full-suite verification outside managed tmux sessions, or give such workers tenant isolation.
- `git add -A` in this repo sweeps `.claude/handoffs/*.md`; stage explicitly.
- `gh pr checks` immediately after `gh pr create` 404s — sleep 15–20s first. `--watch` can also die on transient network resets; just re-arm.
- npx `skills add` can serve a stale registry copy — after releases, rsync the repo's skills/ over `~/.agents/skills/` and run a wrapper self-test.

## Environment State

### Tools/Services Used

- gh CLI (PR/merge/run watch/workflow dispatch), tmux + agent-tmux worker fleet, brew (tmux/jq/rg/shellcheck/coreutils/sqlite on CI)

### Active Processes

- None. All tmux worker sessions stopped; no background watches remain.

### Environment Variables

- CODEX_TMUX_LAUNCH_FLAGS / CODEX_TMUX_EXTRA_LAUNCH_FLAGS (names only; unset in normal shells, set per-dispatch for workers)

## Related Resources

- Release: https://github.com/ohyeh/tmux-agent-tools/releases/tag/v0.29.0
- PRs: #303–#310; Issues: #298–#302 (closed), #293 (open feature track)
- Gate verdict archive: /tmp/codex-consensus-gate-v0290.md (AGREE, no blockers)

---

**Security Reminder**: Before finalizing, run `validate_handoff.py` to check for accidental secret exposure.
