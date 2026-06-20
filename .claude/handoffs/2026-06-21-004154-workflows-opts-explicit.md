# Handoff: Workflows — explicit agent() opts (model/effort/isolation/agentType) + docs-vs-code-audit deploy

## Session Metadata
- Created: 2026-06-21 00:41:54
- Project: /Users/paul.yeh/github/tmux-agent-tools
- Branch: main
- Session duration: ~1 long session (workflow grooming round)

### Recent Commits (for context)
  - 52129f3 chore(workflows): list isolation + agentType on every agent() (default off, portable)
  - 1b5a5bc docs(workflows): rewrite 正本 section — snapshot kept in sync via pipeline, no external paths
  - 4252f85 chore(workflows): list model+effort explicitly on every agent() + deploy docs-vs-code-audit
  - 3c9c361 chore(workflows): sync repo snapshot to ~/.claude canonical
  - cdc94f7 docs(workflow): tmux-unify-cleanup — codex-frozen workflow toolbox round (P0–P8)

## Handoff Chain

- **Continues from**: [2026-06-20-144127-v2-cli-session-id-shipped.md](./2026-06-20-144127-v2-cli-session-id-shipped.md)
  - Previous title: v2 cli_session_id resume — SHIPPED (codex AGREE, pushed)
- **Supersedes**: None

## Current State Summary

Groomed the dynamic-workflow toolbox so every `agent()` call EXPLICITLY lists all
supported official opts. Drove three concerns to done: (1) `model`+`effort` made
explicit everywhere with defaults sonnet/high; (2) `isolation`+`agentType` added
explicitly, both default OFF and portable; (3) `docs-vs-code-audit` deployed into
the canonical set. All 7 scripts pass syntax + coverage checks, are committed and
PUSHED to origin/main (HEAD = 52129f3). Working tree is clean; nothing pending to
push. Three smoke tests confirmed the explicit-`undefined` opts run without error.

## Codebase Understanding

### Architecture Overview

Three workflow locations, kept in sync MANUALLY (an independent SYNC pipeline is
planned but NOT built):
- `~/.claude/workflows/` — CANONICAL (personal layer, NOT a git repo). Edit here.
- `<repo>/.claude/workflows/` — team SNAPSHOT (git-tracked). Mirrors canonical;
  slated to be replaced by the SYNC pipeline, kept as backup for now.
- `~/Desktop/workflows/` — OLD, to be deleted, IGNORE. (Does not currently exist.)

Two homes for a planning run's artifacts (separated, linked, not duplicated):
- MANAGEMENT side: `<repo>/.workflow/<slug>/` — codex-dynamic plan prose
  (plan.md / direction.md / final-report.md / ADRs). Source of truth.
- EXECUTION side: `<repo>/.claude/workflows/<slug>/job.json` — machine run config
  that POINTS at the plan via `planPath`. Written by feature-lifecycle-auto after
  the plan freezes.

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| ~/.claude/workflows/*.workflow.js (7) | CANONICAL workflow scripts | edit here, then sync to repo |
| <repo>/.claude/workflows/*.workflow.js (7) | git snapshot (mirror) | what gets committed |
| feature-lifecycle-auto.workflow.js | thin shell: plan→gate→build; job-file bootstrap | entry point |
| feature-plan-consensus.workflow.js | explore-mode planner (consensus); escalation ladder | model is per-tier here |
| plan-pipeline.workflow.js | frozen-mode planner (direction→plan→ADR) | |
| spec-implement-dual-review-verify.workflow.js | build stage (codex+claude dual review) | |
| docs-vs-code-audit.workflow.js | NEW to canonical; audit docs vs code | deployed this session |
| <repo>/.claude/workflows/README.md | discovery rules + 正本/sync section | 正本 section rewritten |

### Key Patterns Discovered

- Every `agent()` opts lists model+effort+isolation+agentType EXPLICITLY so "not
  shown" is never misread as "unsupported" (the bug that made docs-vs-code-audit
  look effort-less). Defaults: model=sonnet, effort=high, isolation=undefined(off),
  agentType=undefined(off).
- `schema` is added per-call only where structured output is needed; its presence/
  absence documents which agents return JSON vs prose.
- Second-model review is driven via `agent-tmux` (codex) INSIDE a normal agent's
  prompt (driveCodex helper), NOT via harness `agentType` — this keeps it portable
  and file-polled (poll an OUT file for a marker, never the tmux pane).
- feature-plan-consensus escalation ladder sets `model` PER-TIER (sonnet→self→codex)
  by design; only there is model not uniform. effort is uniform everywhere.

## Work Completed

### Tasks Finished

- [x] Synced repo snapshot to ~/.claude canonical (commit 3c9c361)
- [x] model+effort explicit on every agent() across 7 workflows (4252f85)
- [x] Deployed docs-vs-code-audit into ~/.claude + wired its effort (4252f85)
- [x] Rewrote README 正本 section, removed all external paths (1b5a5bc)
- [x] isolation+agentType explicit on every agent(), default off, portable (52129f3)
- [x] Added project-local job bootstrap + exec-job write to feature-lifecycle-auto
- [x] Verified ~/.claude ⇄ repo parity (all 7 .workflow.js + _lib SAME)
- [x] 3 smoke tests: undefined opts safe; root-caused the first stall

### Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| 7× *.workflow.js (canonical + repo) | explicit model/effort/isolation/agentType per agent() | visibility + spec compliance |
| feature-lifecycle-auto.workflow.js | project-local job bootstrap; write exec-side job.json | per-project config, concurrency-safe |
| docs-vs-code-audit.workflow.js | deployed + effort wired into 3 agent calls | was missing effort entirely |
| README.md | 正本 section rewrite | drop stale external pointer |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| List all official opts explicitly | rely on defaults vs explicit | "not shown" was being misread as "unsupported" |
| isolation off = omit (undefined) | false / 'none' / omit | official spec only documents 'worktree'; false/'none' undocumented |
| agentType default off, never hardcoded | hardcode tmux subagent vs default | missing custom agentType is a HARD error (#20931) → breaks portability |
| Keep .workflow/<slug>/ for explore outDir | move to .claude/workflows | that IS the codex-dynamic convention |
| Manual cp+diff sync for now | build pipeline now | SYNC pipeline deferred (planned) |

## Pending Work

## Immediate Next Steps

1. (Optional) Decide on agentType ROUTING: build a portable `codex-reviewer`
   subagent in tmux-agent-tools that encapsulates the driveCodex mechanics, and
   have workflows enable it CONDITIONALLY (only if present — else default agent),
   to avoid the #20931 hard-error portability break. User asked to "discuss with
   team + test" before building. NOT built yet.
2. (Optional) Build the independent SYNC pipeline (canonical ~/.claude → repo
   snapshot) promised in the rewritten README. Currently manual cp + diff verify.
3. (Optional) Save the smoke-opts probe as a reusable `/smoke-opts` workflow.

### Blockers/Open Questions

- [ ] None blocking. agentType-routing and SYNC pipeline are user-discretion.

### Deferred Items

- Global `~/.claude/workflows/.feature-lifecycle-auto.job.json` still holds stale
  Aurora data; it is now only a FALLBACK (project-local job is preferred). USER
  will delete it manually — do not touch.
- docs-vs-code-audit parity gap RESOLVED (deployed to canonical this session).

## Context for Resuming Agent

## Important Context

The canonical workflows live in `~/.claude/workflows/` (NOT git). The repo's
`.claude/workflows/` is a SNAPSHOT you keep in sync by copying canonical→repo,
then committing. To change a workflow: edit `~/.claude/workflows/X.workflow.js`,
`cp` it into the repo, syntax-check, commit, push. Verify parity with a per-file
`diff` (exclude README.md, *.job.json, .DS_Store).

### Assumptions Made

- Explicit `isolation: undefined` / `agentType: undefined` == omitted (CONFIRMED
  empirically this session: smoke test ran in 1.5s with no error).
- Repo direct-to-main is the team convention for these docs/workflow changes
  (consistent with prior commits; user pushed each round).

### Potential Gotchas

- **arg-drop runtime bug**: this env's Workflow tool DROPS top-level `args` for
  `name`/`scriptPath` invocations. Inputs must arrive via a JOB FILE read by a
  1-shot agent. feature-lifecycle-auto precedence: args → project-local
  `<cwd>/.claude/workflows/feature-lifecycle-auto.job.json` (preferred) → global
  `~/.claude/workflows/.feature-lifecycle-auto.job.json` (single-slot, NOT
  concurrency-safe) → BUILTIN {}.
- **schema ↔ prompt contradiction**: passing `schema` forces a StructuredOutput
  tool call. A prompt that says "do not use tools" or asks for a non-JSON reply
  DEADLOCKS the agent (this caused the first smoke-test stall — it was the TEST
  script, not infra, not the production files). When using schema, tell the agent
  to produce a result matching the schema and never forbid tools.
- **agentType hard error (#20931)**: pointing agentType at a missing subagent is a
  hard failure, NOT graceful fallback. Never hardcode a custom agentType.
- **Background workflow runner** can stall transiently; `TaskStop` then re-run to
  distinguish "stuck" from "slow" (a trivial probe should finish in ~1–8s).
- feature-plan-consensus escalation ladder: model is per-tier (the `[.eia]` line
  in coverage audits is correct-by-design, not a gap).

### Environment State

### Tools/Services Used

- git (direct commits to main, pushed to origin git@github.com:ohyeh/tmux-agent-tools)
- node --check (harness-wrapped syntax validation of workflow scripts)
- Workflow tool (smoke tests), agent-tmux (codex driving, referenced in scripts)
- claude-code-guide agent (verified official agent() opts spec)

### Active Processes

- None. All smoke-test workflows completed/stopped.

### Environment Variables

- CODEX_TMUX_LAUNCH_FLAGS (referenced inside scripts for codex effort; not set by us)

## Related Resources

- <repo>/.claude/workflows/README.md — discovery rules + 正本/sync section
- Official: code.claude.com/docs/en/workflows ; code.claude.com/docs/en/sub-agents
- platform.claude.com/docs/en/build-with-claude/effort — effort levels
- GitHub issue #20931 — missing agentType is a hard error (portability rationale)
- Skill: /Users/paul.yeh/.claude/skills/codex-dynamic-workflows (plan conventions)

---

**Security Reminder**: validated with validate_handoff.py — no secrets.
