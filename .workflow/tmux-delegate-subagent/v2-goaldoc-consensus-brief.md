# Adversarial consensus brief — tmux-delegate v2-goal-doc.md

You are a FRESH, INDEPENDENT adversarial reviewer. You did NOT write this doc. Repo: `/Users/paul.yeh/github/tmux-agent-tools` (current branch `tier1-issue-266`; the doc targets the agent-tmux machinery).

## Framing (anti-bias)
`.workflow/tmux-delegate-subagent/v2-goal-doc.md` was "drafted by brain + codex" but has NEVER had an adversarial consensus pass. Do NOT rubber-stamp. Challenge the PREMISE, not just details.

## Read
- `.workflow/tmux-delegate-subagent/v2-goal-doc.md` (under review)
- `.workflow/tmux-delegate-subagent/plan.md` (v1 context, task 3A-V2 backlog)
- The real committed code: `skills/tmux-agent-tools/scripts/agent-tmux` — verify EVERY current-state claim (does `start` really not emit the UUID? what does `result_init_session` / `result_validate_lightweight` actually do today? is there a `session_id_pattern` profile key? how does `resume` consume the UUID?). Cite file:line.

## Challenge specifically
1. **Premise**: is capturing `cli_session_id` for `resume` the right next step for this track at all, or is it solving a gap that rarely bites? Is the v1 "tmux session supervision only" fallback already good enough? Is there a higher-value or lower-risk v2?
2. **Feasibility of the watcher**: a bounded ~30s best-effort pane-scrape watcher to extract a UUID — is this reliable given screen-clearing TUIs (the doc admits this)? Does the unreliability undermine the whole feature (sometimes-present `cli_session_id` may be worse than never)?
3. **Concurrency/atomicity**: the jq→temp→mv merge into result.json — does it race with the worker writing its own result.json, or with 0b's new result-path-via-prompt contract just shipped? Check the just-merged 0b code.
4. **Schema/validation**: does the proposed optional `cli_session_id` fit the current `result_validate_lightweight` derivation? Verify against code.
5. **Security**: UUID as sensitive — is "keep to local state" sufficient?
6. **Citation integrity**: spot-check the doc's implicit current-state claims against real code; flag any false ones.

## Output
Write verdict JSON to: /Users/paul.yeh/.local/state/tmux-agent-tools/dgreview/result.json
Fields: schema_version:1, status:"success", summary, `verdict` object: `verdict.verdict` = AGREE | AGREE_WITH_CHANGES | DISAGREE; `verdict.premise_ok` (bool); `verdict.blockers` = array (claim/why/fix); `verdict.notes`.
End your pane message with marker line exactly: === DG CONSENSUS DONE ===
