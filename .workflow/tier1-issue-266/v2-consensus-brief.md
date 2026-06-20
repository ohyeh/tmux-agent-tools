# Adversarial consensus brief — next-plan-v2.md

You are a FRESH, INDEPENDENT adversarial reviewer. You did NOT write this plan. Repo: `/Users/paul.yeh/github/tmux-agent-tools` (branch `tier1-issue-266`).

## Important framing (anti-bias)
`.workflow/tier1-issue-266/next-plan-v2.md` was authored by another codex session from a planning brief written by the orchestrator. **The brief may have steered the conclusion.** Your job is NOT to rubber-stamp it. Challenge the PREMISE, not just the details.

## Read
- `.workflow/tier1-issue-266/next-plan-v2.md` (the plan under review)
- `.workflow/tier1-issue-266/next-plan.md` (what already shipped: 0a/0b/A/B)
- The actual current tree (`git -C ... diff` is empty now; read the committed `skills/tmux-agent-tools/scripts/agent-tmux` + SKILL.md directly). Verify the plan's cited file:line claims are TRUE against the real code.

## Challenge these specifically
1. **Premise**: Is `team needs` actually the highest-value next step, or did the brief's candidate framing bias it? Is there a more valuable / more urgent packet the brief under-weighted? Is doing NOTHING next (stop here) defensible?
2. **Bias check**: does the plan's "half-built, just connect quorum→send" narrative overstate readiness? Verify by reading `_team_quorum`, `_team_send`, `_team_result_from_path` in the committed code.
3. **Coupling concern**: `team needs` fuses a gate with a side-effecting send. Is the single-send/idempotency risk real and adequately handled? Is the Unix-composable fallback (`team quorum --wait`, gate-and-send separate) actually the better primitive?
4. **Citation integrity**: spot-check at least 4 of the plan's `file:line` claims against the real committed code; flag any that are wrong/stale (the line numbers were written against the post-merge tree).
5. **Scope/YAGNI**: is the packet genuinely small and surgical, or is there hidden complexity (e.g. `--from` resolution, exit-code semantics, JSON contract) that makes it bigger than claimed?

## Output
Write verdict JSON to: /Users/paul.yeh/.local/state/tmux-agent-tools/v2review/result.json
Fields: schema_version:1, status:"success", summary, and `verdict` object: `verdict.verdict` = AGREE | AGREE_WITH_CHANGES | DISAGREE; `verdict.premise_ok` (bool: is Packet C the right next step?); `verdict.blockers` = array (concrete: claim/why/fix); `verdict.notes`.
End your pane message with marker line exactly: === V2 CONSENSUS DONE ===
