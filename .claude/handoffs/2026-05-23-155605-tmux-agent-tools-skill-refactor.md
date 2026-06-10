# Handoff: tmux-agent-tools skill — progressive disclosure refactor + description rewrite, shipped as PR #204

## Session Metadata
- Created: 2026-05-23 15:56:05
- Project: /tmp/tmux-agent-tools
- Branch: refactor/skill-progressive-disclosure
- Session duration: ~3 hours interactive

### Recent Commits (for context)
  - 1d38e7d fix(skill): escape stray colon-space in YAML frontmatter description
  - d90efa0 refactor(skill): progressive disclosure for tmux-agent-tools
  - 36019d7 docs(wiki): seed wiki pages for developer + agent operator audiences (#201)
  - 26de52a release: prepare v0.11.0 — L5/L6 runtime upgrade (#199)
  - 3ad956a fix(lint): widen tied-pair local check to multi-name + bare forms (#196) (#200)

## Handoff Chain

- **Continues from**: [2026-05-21-104513-backlog-cleared-v0100.md](./2026-05-21-104513-backlog-cleared-v0100.md)
  - Previous title: tmux-agent-tools backlog fully cleared, v0.10.0 published
- **Supersedes**: None

> The previous handoff covered backlog completion. This session is a distinct slice: refactoring the user-facing `skills/tmux-agent-tools/SKILL.md` skill spec itself (not the wrapper code).

## Current State Summary

User ran `/skill-creator:skill-creator` to improve the `tmux-agent-tools` skill. We diagnosed two distinct problems with the old SKILL.md: (1) the body was 357 lines with cheatsheets/schemas/audit/secret all mixed together, breaking progressive disclosure, and (2) the description started "Use when **Codex** needs to..." which is single-actor framing that under-triggers when Claude itself drives the workflow or when only a single subcommand is needed. Refactored body to 151 lines + 4 `references/*.md` files, rewrote description as neutral + keyword-dense + negative-scoped, and validated via two iterations of mixed-mode eval (8 prompts × claude-sonnet-4-6 subagents). Committed in two commits, opened PR #204 → main, smoke CI failed on YAML colon-space bug, fixed, **CI green at 1m23s**. PR is awaiting bot reviewers + partner agent review.

## Codebase Understanding

### Architecture Overview

The repo has two kinds of artifacts that look similar but are NOT the same:
1. **Wrapper scripts** (`scripts/claude-tmux`, `scripts/codex-tmux`, `scripts/tmux-agent-dialogue`, `scripts/tmux-agent-sessions`, `scripts/tmux-agent-fanout`) — the actual shell/zsh code that launches and manages agent sessions. Versioned, tested, audited via hash-chained JSONL.
2. **Skill spec** (`skills/tmux-agent-tools/SKILL.md` + `references/`) — the natural-language instructions Claude reads to know **how to drive** the wrappers. This session only touched the skill spec, not the wrapper code.

A change to SKILL.md does not require wrapper changes and vice versa. Skill smoke CI is a separate fast (≤90s) job that only validates frontmatter parseability and a few presence assertions — it is NOT the same CI that runs the wrapper test suite.

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `skills/tmux-agent-tools/SKILL.md` | Skill body (151 lines after refactor) — core workflow + orchestrator playbook + safety + references index | Edited |
| `skills/tmux-agent-tools/references/cheatsheets.md` | Scenario→command, token-efficient patterns, marker pitfalls (incl. alternation worked example), failure-mode triage | New |
| `skills/tmux-agent-tools/references/multi-agent.md` | dialogue/pair-review/critic/debate/fanout, worker→dialogue bridge pattern, participant profiles, github-comment (no posting by default) | New |
| `skills/tmux-agent-tools/references/contracts.md` | `status --json` stable fields, `result.json` schema, approval-gate exit codes, concurrency model, inventory/cleanup | New |
| `skills/tmux-agent-tools/references/security.md` | Secret injection backends, audit log operator surface, full environment-override table | New |
| `skills/tmux-agent-tools/evals/evals.json` | 8 body-quality test prompts (claude+claude pair, codex+claude pair-review, debate, capture, wait-alternation, resume, fanout, approval-gate) | New |
| `skills/tmux-agent-tools/evals/trigger_eval.json` | 20-query description-trigger eval (10 should-trigger, 10 near-miss) | New |
| `skills/tmux-agent-tools-workspace/` | iter-1 + iter-2 plan.md outputs, dry-run transcripts, old SKILL.md snapshot | **Not in git, not gitignored** — keep for re-runs or `rm -rf` to discard |

### Key Patterns Discovered

1. **Skill description as retrieval index, not marketing.** What makes a description trigger reliably is keyword density (`--strip-ansi`, `--pause-until-file`, subcommand names) + explicit negative scoping ("NOT for general tmux config, shell subprocess wrappers, headless `claude -p`, human team coordination"). Long is fine if every clause is searchable.
2. **Progressive disclosure split rule.** SKILL.md keeps core workflow + safety + playbook + index. Everything else (cheatsheets, schemas, audit surfaces, security/env knobs) goes to `references/*.md`. The body should stay under ~150 lines so it fits comfortably alongside other context Claude is juggling.
3. **Subagent hallucination is the silent killer.** When the skill body has a gap, subagents invent plausible-looking but unsafe fallbacks (e.g., race two `wait-literal` calls — would corrupt the unlocked `marker_seen` FIFO). Iter-1 eval surfaced this; iter-2 closed it with an explicit worked example + "do NOT race waiters" forbid. The value of the refactor lives mostly in closing these hallucination doors, not in pass-rate deltas.
4. **Greedy ascent loops have a blind spot.** `scripts/run_loop.py` from skill-creator evolves descriptions by replacement, not by augmentation. It found a great negative-scoping clause in iter-2 but lost the original's subcommand-keyword density. The final shipped description is a **manual hybrid**: my original keyword-rich first half + the loop's evolved "NOT for X / distinctive signal is Y" second half. Loop could not have reached this on its own.

## Work Completed

### Tasks Finished

- [x] Designed 8 mixed-mode test prompts covering 3 agent combinations + 5 partial-function scenarios + 1 approval-gate edge case
- [x] Set up workspace, snapshotted old skill to `skill-snapshot/`
- [x] Ran iteration-1 eval (8 subagents against old SKILL.md, claude-sonnet-4-6) — surfaced alternation-marker hallucination + missing worker→dialogue bridge guidance + zero cascade-spawn discipline
- [x] Refactored SKILL.md from 357 → 151 lines, extracted 4 references/*.md files
- [x] Added Orchestrator playbook (4 bounded-collaboration rules)
- [x] Added alternation-marker worked example to cheatsheets.md
- [x] Rewrote frontmatter description: neutral framing + subcommand keywords + negative scoping
- [x] Ran iteration-2 eval (8 subagents against new SKILL.md + references) — **8/8 cited at least one `references/*.md` as load-bearing**
- [x] Ran `scripts/run_loop.py` description trigger loop ~2–3 iterations before stopping manually
- [x] Manually merged my original description with loop-evolved negative scoping into hybrid
- [x] Committed `d90efa0` refactor + `1d38e7d` YAML colon-space fix
- [x] Opened PR #204 → main
- [x] Fixed CI failure (YAML frontmatter `: ` colon-space inside description) — **CI green**

### Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| `skills/tmux-agent-tools/SKILL.md` | −273 / +68 net (357→151 lines), full rewrite | Progressive disclosure split + neutral description + orchestrator playbook + alternation-marker pointer |
| `skills/tmux-agent-tools/references/cheatsheets.md` | +86 lines new | Cheatsheet tables relocated from SKILL.md, plus new alternation worked example |
| `skills/tmux-agent-tools/references/multi-agent.md` | +124 lines new | Dialogue presets, worker→dialogue bridge pattern (eval-1 gap), participant profiles, github-comment, fanout |
| `skills/tmux-agent-tools/references/contracts.md` | +95 lines new | `status --json`, `result.json` schema with worked example, approval-gate exit codes, concurrency model |
| `skills/tmux-agent-tools/references/security.md` | +83 lines new | Secret injection backends, audit log operator surface, env override table |
| `skills/tmux-agent-tools/evals/evals.json` | +70 lines new | 8 body-quality test prompts |
| `skills/tmux-agent-tools/evals/trigger_eval.json` | +23 lines new | 20 description trigger queries (10 should / 10 should-not) |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Split body, don't just trim | (a) shorten in-place (b) split to references/ | Cheatsheets/schemas need to stay reachable for power users but should not be loaded by default. Progressive disclosure is the documented skill-creator pattern. |
| Eval mode = mixed (plan + fake dry-run) | (a) behavioral only — plan + rg-grade (b) execution only — real tmux (c) mixed | (a) misses real wrapper behavior; (b) clogs tmux server and needs codex/claude auth in subagents; (c) gets real fake-participant dry-run output without environment friction |
| Skip without-skill baseline in eval | Run with-skill AND without-skill (16 subagents) vs with-skill only (8) | User chose 8-only to halve cost. Trade-off: cannot measure "did skill help vs nothing" delta — only "did refactor change behavior". Re-running iter-1 + iter-2 with the same prompts answered the latter. |
| Stop description loop early, hybrid manually | Let loop run all 5 iterations | Loop is replacement-only greedy ascent; cannot combine my original's keyword density with loop's negative scoping. User said "可以收尾了" — diminishing returns vs hybrid synthesis. |
| Branch off main, PR-first | Direct push to main / commit on docs/wiki-pages | Repo workflow is PR-first with bot reviewers + partner agent. Mixing skill changes into the wiki branch would muddy review. |
| Two commits not amend | Amend `d90efa0` with the colon-space fix | Per repo CLAUDE.md: prefer new commits over amend. Hooks already passed on d90efa0; amending re-runs hooks and risks repeat failure mode. |

## Immediate Next Steps

1. **Monitor PR #204 bot reviewer responses.** Per memory, HIGH-priority gemini findings are real-bug merge-blockers. If gemini/codex bots leave HIGH-prio comments, address before merge regardless of partner verdict.
2. **Optional: write rg-based grader assertions to produce a real iter-1 vs iter-2 pass-rate diff.** Without this, we cannot claim a quantitative improvement number — only the qualitative "subagents now cite references as load-bearing" signal. ~30 min of work; worth it only if a reviewer asks for hard numbers.
3. **Optional: re-run description trigger loop to completion** and record the final test score. Loop was interrupted by user at iter 2–3 of 5; the hybrid description shipped is unmeasured against the trigger eval set.
4. **After merge: decide on `skills/tmux-agent-tools-workspace/` fate.** Either `rm -rf` (it served its purpose) or `git ignore` it for future re-runs. Currently sits untracked in the worktree.

## Blockers/Open Questions

- [ ] Whether bot reviewers (gemini/codex) will flag the description length (1410 chars). It's keyword-dense for intentional reasons but might trip a "descriptions should be concise" lint heuristic if one exists.
- [ ] Whether the new `Orchestrator playbook` 4-rule pattern needs sibling-skill propagation. If other skills in this repo also do multi-agent orchestration, they may benefit from the same bounded-collaboration discipline. Not investigated this session.

## Deferred Items

- Grader assertion suite (decision: not needed unless reviewer asks)
- Description trigger loop completion (decision: not needed; hybrid is good enough)
- `.skill` packaging via `scripts.package_skill` (decision: not needed unless distributing outside this repo)
- Writing the "greedy loop mid-flight manual hybrid" lesson to auto-memory (offered to user, no answer yet — should still happen)

## Important Context

The work this session is **scoped to the skill spec only**, not the wrapper code. Do not touch `scripts/claude-tmux`, `scripts/codex-tmux`, etc. — those have their own test suites and review process.

The new SKILL.md `Orchestrator playbook` codifies a strong product opinion: this tool is for **long-running supervised work**, not for unbounded agent sprawl. The 4 rules (ask user for tool/model/effort, declare worker upper bound, write cascade-spawn ban into worker prompts, bound dialogue turns) reflect explicit user requirements from this session — "我希望有上限 是當長任務用 而不是無止盡開新同伴" and "spawn worker 前問使用者 model 以及 effort". If a future reviewer or user pushes back on these rules feeling too restrictive, reground them in this requirement, do not silently relax.

`skills/tmux-agent-tools-workspace/` contains 16 plan.md outputs (iter-1 × 8 + iter-2 × 8) plus dry-run transcripts and the old SKILL.md snapshot. These are the **only evidence** that the refactor changed subagent behavior. If they get deleted before a reviewer asks for proof, the qualitative claims in the PR cannot be reproduced — keep until merge approves or copy interesting plan.md files into a permanent location.

The `evals/` directory was committed deliberately so future maintainers can re-run. This is unusual for this repo (most skills don't ship eval sets) — if a reviewer asks "why is evals/ in the skill folder", the answer is: this skill is now the project's most complex orchestration surface, ship the eval suite so the next refactor has a baseline.

## Assumptions Made

- The repo's smoke CI only validates skill metadata (parseability, name, description length, body keyword presence). Wrapper tests run on a different workflow we didn't touch. Both must still pass for merge; smoke is the one we fixed.
- Bot reviewers (gemini, codex) will auto-trigger on PR open. The partner agent referenced in memory is also expected to pick this up. Did not manually request review.
- The user's `docs/wiki-pages` branch was not affected by this session — only checked out for the initial branch listing. The `CHANGELOG.md` dirty WT state after switching is wiki-branch collateral, not introduced by this session.
- Sonnet-4-6 is the realistic deployment target for this skill, hence used for evals. If skill is also used heavily under opus-4-7 or haiku-4-5, body should be re-validated against those — not done this session.

## Potential Gotchas

1. **YAML frontmatter colon-space.** `description: ` value cannot contain `: ` (colon followed by space) anywhere — YAML plain-scalar parser treats it as nested mapping. Use em-dash `—` instead. CI smoke catches this but the error message is cryptic ("mapping values not allowed in this context, line 3 col N").
2. **`main` is held by a partner agent worktree** at `.claude/worktrees/agent-a59350462dfa2b93d`. `git checkout main` from the primary worktree fails. Work around: branch from `origin/main` via `git reset --mixed origin/main` after creating a new branch off whatever you happen to be on. Don't `git worktree remove` that worktree without checking what the partner agent is doing.
3. **`git status` shows `M CHANGELOG.md` after switching branches.** This is wiki-branch's committed CHANGELOG modification surfacing as working-tree-only after `--mixed reset`. It is NOT this session's work and should not be added to any skill-related commit. The user said they'd handle it separately.
4. **The 16 candidate `tmux-agent-tools-skill-<hash>` entries that appeared in skill listings** are run_loop.py artifacts left over in cache. They should age out / be cleared by skill registry rebuild. If they persist and you see them in `system-reminder` skill lists across sessions, manually clear `~/.claude/plugins/cache/claude-plugins-official/skill-creator/*/skills/skill-creator/output/` or equivalent.
5. **Old SKILL.md description "Use when Codex needs to..."** was loaded into a partner agent's context earlier. If you see the partner agent reference that framing in a review comment, it is using stale context — gently redirect to the new description.

## Environment State

### Tools/Services Used

- `gh` CLI (logged in as `ohyeh`) — for PR ops
- `git` — branch ops, commit, push
- `python` 3.12.9 via pyenv — for `scripts/run_loop.py`
- `ruby` 3.3.11 — what CI uses to validate SKILL.md frontmatter (`Psych` YAML parser)
- `claude-sonnet-4-6` — eval subagent model

### Active Processes

- No running processes left by this session. The `run_loop.py` PID 46225 was manually killed; the two background `gh pr checks` watchers completed.
- `skills/tmux-agent-tools-workspace/iteration-1/` and `iteration-2/` directories exist on disk with plan.md outputs.

### Environment Variables

- None set this session that need preserving. The skill itself documents `TMUX_AGENT_TOOLS_AUDIT_LOG`, `TMUX_AGENT_TOOLS_PARTICIPANTS`, etc., in `references/security.md` but those govern wrapper runtime, not our work.

## Related Resources

- PR: https://github.com/ohyeh/tmux-agent-tools/pull/204
- Previous handoff (this chain): `.claude/handoffs/2026-05-21-104513-backlog-cleared-v0100.md`
- Skill-creator scripts: `/tmp/claude/plugins/cache/claude-plugins-official/skill-creator/unknown/skills/skill-creator/scripts/`
- Auto-memory entry to consider adding: "Greedy description-optimization loops are replacement-only; manually synthesize a hybrid between the original and an evolved candidate when one has clause A and the other has clause B."

---

**Security Reminder**: Before finalizing, run `validate_handoff.py` to check for accidental secret exposure.
