# Handoff: v0.16.0 released — declarative CLI profiles + watch command

## Session Metadata
- Created: 2026-06-10 13:54:27
- Project: /Users/paul.yeh/github/tmux-agent-tools
- Branch: main
- Session duration: ~2.5 hours

### Recent Commits (for context)
  - d0368f5 chore(plugin): bump plugin manifests to v0.16.0 (#245)
  - 5af999c chore(formula): bump tmux-agent-tools to v0.16.0 (#244)
  - 15526cc agent-tmux: declarative CLI profiles + watch command (v0.16.0) (#243)
  - 6e802bc chore(formula): bump tmux-agent-tools to v0.15.0 (#242)
  - 49c8395 feat(plugin): CLI plugin manifests (Claude/Codex/Cursor) pointing at shared ./skills/ (#241)

## Handoff Chain

- **Continues from**: [2026-05-23-155605-tmux-agent-tools-skill-refactor.md](./2026-05-23-155605-tmux-agent-tools-skill-refactor.md)
  - Previous title: tmux-agent-tools skill — progressive disclosure refactor + description rewrite, shipped as PR #204
- **Supersedes**: None

## Current State Summary

v0.16.0 is fully released and the session goal is COMPLETE. Shipped: (1) declarative CLI profile mechanism so new CLIs / renamed binaries need zero code changes, (2) `watch` subcommand for one-blocking-call multi-worker supervision, (3) SKILL.md rewritten around the unified `agent-tmux` engine. The release went through a 4-round adversarial review by a persistent codex-tmux worker until ACCEPT with zero blockers (PR #243), then tag v0.16.0, Formula bump (PR #244), and plugin-manifest bump (PR #245, initially missed). main = d0368f5, clean, all CI green. No pending work.

## Codebase Understanding

## Architecture Overview

- `skills/tmux-agent-tools/scripts/agent-tmux` is the single ~5k-line zsh engine; `claude-tmux` / `codex-tmux` / `agy-tmux` are 1-line shims (`exec agent-tmux <cli> "$@"`).
- Per-CLI behavior lives in `preset_for_cli()` (case table, ~line 20) and is now overridable by declarative profiles loaded by `load_cli_profile()` right after it. Precedence: env vars (`<NS>_TMUX_*` > `AGENT_TMUX_*`) > profile file > built-in preset.
- Profile search order: `$AGENT_TMUX_PROFILE_DIR` > `~/.config/agent-tmux/profiles` > bundled `scripts/profiles/`. Files are plain `key=value`, never sourced (security boundary).
- Pane heuristics split by `HEURISTIC_FAMILY` (claude|codex) in `probe_session()` and `blocked_reason_for_text()`; profile regexes (`pattern_busy`, `pattern_permission_prompt`, `pattern_approval_prompt`, `pattern_login_prompt`) take priority over the hardcoded families.
- `watch_session()` (near `list_sessions()`): done = result.json signature change (mtime + content cksum + exists) OR tmux session gone; `--any|--all`, exit 0 met / 1 timeout / 2 bad input.

## Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| skills/tmux-agent-tools/scripts/agent-tmux | engine: presets, profiles, watch, probe, blocked detection | all feature work this session |
| skills/tmux-agent-tools/scripts/profiles/README.md | profile key reference | docs for the new mechanism |
| skills/tmux-agent-tools/SKILL.md | skill entry; rewritten for unified engine + profiles + watch | agents load this |
| Formula/tmux-agent-tools.rb | Homebrew formula (url+sha256 per tag) | release step |
| .claude-plugin/, .codex-plugin/, .cursor-plugin/ | plugin manifests with version fields | release step (easy to miss) |
| CHANGELOG.md | release notes | release step |

## Key Patterns Discovered

- `TMUX_AGENT_TOOLS_SOURCE_ONLY=1` + `source agent-tmux <cli>` lets you unit-test internal functions (e.g. `blocked_reason_for_text`) without running the dispatcher.
- Smoke tests live in `scripts/test-*-smoke` using synthetic tmux sessions (`tmux new-session -d -s agent-cli-<name> 'sleep 30'`) + `TMUX_AGENT_DIR` override; no bats framework. CI job is `smoke`.
- Adversarial review loop pattern: codex-tmux worker + per-round `send` with fix commit hash + `watch --any` to block until result.json is rewritten + `result --json | jq .body.verdict`; require reviewer to REWRITE result.json each round.
- Base-branch policy requires resolved PR comments + admin merge (`gh pr merge --squash --admin`); gemini-code-assist bot reviews PRs and its threads must be replied + resolved via GraphQL `resolveReviewThread`.

## Work Completed

### Tasks Finished

- [x] Declarative CLI profile mechanism (`load_cli_profile()`, 11 keys, never-sourced parser)
- [x] Profile pattern overrides wired into `blocked_reason_for_text`, probe `active_spinner`/`tool_active`/`approval_pending`
- [x] `watch [--any|--all] [--timeout] [--interval] [--json]` subcommand + usage + dispatch
- [x] `scripts/profiles/` README + gemini.conf.example
- [x] SKILL.md rewrite (frontmatter triggers, engine mental model, Custom CLIs and profiles section, watch docs)
- [x] 4-round adversarial codex review → ACCEPT (fixed: same-second result rewrite race ×2 iterations, probe approval pattern, --timeout/--interval validation)
- [x] Fixed gemini bot finding: comment-line parsing relied on extendedglob; now strips leading whitespace + plain `\#*` check
- [x] Release: PR #243 merged, tag v0.16.0, Formula bump PR #244, plugin manifests bump PR #245
- [x] Memory updated: release-checklist-tmux-agent-tools

## Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| skills/tmux-agent-tools/scripts/agent-tmux | +load_cli_profile, profile patterns in detection, watch_session, validation | extensibility + token-efficient supervision |
| skills/tmux-agent-tools/scripts/profiles/* | new README + example | document profile keys |
| skills/tmux-agent-tools/SKILL.md | rewrite | reflect unified engine + profiles + watch |
| CHANGELOG.md | v0.16.0 section | release |
| Formula/tmux-agent-tools.rb | v0.16.0 url+sha256 | release |
| .claude-plugin/*, .codex-plugin/*, .cursor-plugin/* | version 0.16.0 | release (post-tag fix) |

## Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Profiles are pure key=value, never sourced | sourceable zsh profile with hook functions | profiles may come from repos/teammates; declarative format cannot execute code; patterns cover ~90% of needs |
| watch uses shell-side polling, not tmux wait-for daemon | wait-for signal bus, Unix socket daemon | result.json is written by the agent inside the worker, so a push signal needs a resident watcher process; shell polling costs zero tokens and one blocking tool call gives the same benefit |
| watch done-signature = mtime + content cksum + exists | mtime only; mtime+size | mtime is 1s resolution (missed same-second rewrites); size missed same-size rewrites; only byte-identical rewrite is undetectable, which carries no new result by definition |
| Do not move tag v0.16.0 after manifest bump | retag | tag published + Formula sha256 locked; plugins install from git main so version lag in tag tarball has zero impact |

## Pending Work

## Immediate Next Steps

1. None — release complete. If the user wants follow-ups, candidates are below in Deferred Items.

### Blockers/Open Questions

- [ ] None.

### Deferred Items

- Smoke test `scripts/test-watch-smoke` and `scripts/test-profile-smoke` were validated manually but not added as CI test files — add if CI coverage for the new features is wanted.
- Optional `tmux wait-for` push/event-bus design and `herdr.dev` backend (see memory) remain future ideas.
- Profile mechanism does not yet expose `cli_provider_env_keys` (provider env list is still family-hardcoded) — extend if a custom CLI needs its own env-doctor key list.

## Context for Resuming Agent

## Important Context

- Release flow for this repo (MUST do in this order, see memory release-checklist-tmux-agent-tools): bump CHANGELOG + ALL FOUR plugin manifests in the feature/release PR → merge → tag → push tag → Formula bump (url + tarball sha256) as separate chore PR. v0.16.0 missed the manifests before tagging; the tag tarball permanently says 0.15.0 in manifests (harmless, documented).
- The adversarial-review-until-ACCEPT workflow is the user's required gate before any PR/release ("review 到沒意見、有共識才能發 PR"). Reuse the exact loop in Key Patterns.
- Codex workers cannot expand `$TMUX_AGENT_RESULT` in sandboxed tool envs — always pass the literal result path (from `result --path <name>`) in worker prompts.

## Assumptions Made

- `agy` binary naming differences across machines are now solved via per-machine profile `bin=agy-local`; no code-side alias was added.
- gemini bot jq-performance comment was judged a false positive (jq runs once per name at output time, not in the poll loop) and resolved with a reply rather than a change.

## Potential Gotchas

- `zstat` requires `zmodload zsh/stat` (done inside watch_session); don't call `_watch_result_sig` outside it.
- `result_path_session` calls `ensure_agent_dir` (creates the dir as a side effect) — same behavior as `result --path`.
- zsh `#` glob repetition needs extendedglob (NOT enabled in agent-tmux); avoid it in patterns — this caused the profile comment-parsing bug.
- shellcheck is not installed locally; `scripts/ci-shellcheck` only runs in CI.
- Base branch policy: PR merge requires all review threads resolved; use `gh api graphql resolveReviewThread`, then `gh pr merge --squash --admin`.

## Environment State

### Tools/Services Used

- tmux (homebrew), zsh, jq, gh CLI (repo ohyeh/tmux-agent-tools), codex-tmux worker (reviewer, now stopped)
- Skill scripts run from repo: `skills/tmux-agent-tools/scripts/…` (codex-tmux not on PATH in this shell)

### Active Processes

- None. The `reviewer` codex worker was stopped; test tmux sessions (agent-cli-w1/w2/w3) were killed.

### Environment Variables

- AGENT_TMUX_PROFILE_DIR (profile search override), TMUX_AGENT_DIR (state dir, used for test isolation), TMUX_AGENT_TOOLS_SOURCE_ONLY (test sourcing) — names only, no secrets involved this session.

## Related Resources

- PRs: https://github.com/ohyeh/tmux-agent-tools/pull/243 /244 /245
- Tag: v0.16.0
- skills/tmux-agent-tools/scripts/profiles/README.md (profile key reference)
- Memory: project-release-checklist.md, feedback-reviewer-agent-pattern.md, codex-worker-sandboxed-env-no-result-path.md

---

**Security Reminder**: Before finalizing, run `validate_handoff.py` to check for accidental secret exposure.
