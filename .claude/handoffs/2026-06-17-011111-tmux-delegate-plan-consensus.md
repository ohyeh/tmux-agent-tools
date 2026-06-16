# Handoff: tmux-delegate subagent — v1 plan (consensus reached)

- **Created:** 2026-06-17
- **Repo:** /Users/paul.yeh/github/tmux-agent-tools (origin = git@github.com:ohyeh/huddle.git — PRIVATE, leads public)
- **Branch:** plan/tmux-delegate-subagent (off main)
- **Status:** v1 PLAN complete — internal (claude) + external (codex gpt-5.5) adversarial consensus both reached.

## Current State Summary

A v1 implementation plan for a new `tmux-delegate` thin subagent was produced via the
`feature-plan-consensus` workflow and finalized. Artifact:
`.workflow/tmux-delegate-subagent/plan.md` (286 lines).

The feature (decided earlier this session, inspired by openai/codex-plugin-cc):
add a **thin `tmux-delegate` subagent** as a "should I delegate to a background
tmux worker, or handle inline?" decision point. Design principle: **command-primary,
subagent-secondary** — runtime logic stays in `agent-tmux`/`claude-tmux`/`codex-tmux`;
the subagent and commands are only entry points (the codex-rescue thin-wrapper pattern).

## Important Context

- **Why the workflow "got stuck":** the in-workflow codex external review spawned a
  `codex-tmux` worker from inside a nested workflow agent; that worker hit an interactive
  context-mode PreToolUse hook trust dialog it could not answer, and blocked ~28 min with
  no result.json. **Fix that worked:** drive `codex-tmux` directly from the MAIN thread —
  worker `cxrev` started clean, no trust prompt. Lesson: summon codex workers from the
  main thread, not from inside a workflow agent's sandboxed tool-call env.
- **Codex verdict (genuine second model):** `consensus=false, verified_against_code=true`,
  3 blocking issues — ALL in the doctor-json/setup verification cluster, core design NOT
  contested. All 3 already resolved in plan.md:
  1. S3 gate `PATH=/ agent-tmux … doctor --json` is invalid (breaks script shebang +
     trips `require_tmux` before CLI check) → replaced with explicit-wrapper-path + only
     target-CLI-missing assertion.
  2. doctor checks must be independent named checks (tmux-missing vs CLI-missing tested
     separately).
  3. `setup` (3A-2) is NOT thin (no dispatcher branch, `doctor_session()` has no arg
     parser) → effort promoted S→M and split.

## Decisions Made

- Adopt command-primary / subagent-secondary dual-entry, not subagent-only.
- External review must use real codex via tmux-agent-tools, launched from main thread.
- git gate kept closed until explicit user approval (now granted: commit + push).

## Critical Files

- `.workflow/tmux-delegate-subagent/plan.md` — the deliverable v1 plan.
- `skills/tmux-agent-tools/scripts/agent-tmux` — `doctor_session()` ~lines 4233-4259
  (needs `--json` + exit-1, M-effort 3A-1); dispatcher ~5449-5453 (needs `setup` branch).
- Four manifests to bump 0.18.1 → 0.19.0: `.claude-plugin/marketplace.json`,
  `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`.

## Immediate Next Steps

1. (This session) Commit plan.md + this handoff on branch `plan/tmux-delegate-subagent`, push to origin (huddle, private). DONE if you are reading this post-push.
2. Resolve OQ-1 (subagent file path/format: `.md` vs `.yaml`, agents dir) before Phase 2.
3. Execute Phase 1: 3A-1 (`doctor --json`, M) → verify S3 via new gate → 3A-2 (`setup`, M).
4. Phase 2: author `tmux-delegate` file + tools audit + SKILL.md auto-delegation section + evals.
5. Phase 3: CHANGELOG + 4 manifest bumps → secrets scan → tag v0.19.0 → Formula bump.

## Gotchas

- Never push public main; origin is the private huddle repo (push there is fine).
- Release checklist: bump CHANGELOG + 4 plugin manifests BEFORE tag, then Formula bump.
- Phase 2+ PRs must pass strict secrets/PII scan (gitleaks) gate.
