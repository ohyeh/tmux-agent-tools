# Re-review task: validate the agreed next-plan against real code

Repo: /Users/paul.yeh/github/tmux-agent-tools (branch tier1-issue-266).
Read `.workflow/tier1-issue-266/next-plan.md` (the synthesized, endorsed plan) and adversarially RE-REVIEW it against the ACTUAL current code. This is your own earlier proposal synthesized by the lead — review it critically, do not rubber-stamp.

Landing points were already grep-verified by the lead as present:
- watch_session() @5125, flag parser @5128-5132 (mode=any; --any/--all), done_reason map @5155/5189/5196
- cmd_team() @5433, dispatch @5445 (results) _team_results), usage @5446
- _team_worker_rows @5338, _team_results @5575, result_session() @3585
- team wait --require-result @5542 (the all-or-nothing pain point)
- no existing `quorum` (no name collision)

Re-review for:
1. Interface correctness: is `watch --count N` mutually-exclusive logic with --any/--all clean given the current `mode=any` default and the early-break at @5189? Any off-by-one in counting done vs required?
2. team quorum: does reading present+valid result.json via existing helpers actually work without a new schema? Is `--field <jq> --value <literal>` consistent with how `result --json`/result_session extracts fields today?
3. Hidden collisions / regressions: does adding `--count` break existing watch JSON consumers? Does the new team subcommand dispatch order matter?
4. Self-check feasibility: are the two proposed self_tests hermetic and actually able to fail if the feature breaks?
5. Sequencing: is A-before-B correct, or does B not actually depend on A?

Write verdict JSON to EXACT path:
/Users/paul.yeh/github/tmux-agent-tools/.workflow/tier1-issue-266/next-plan-rereview-result.json
Shape: {"verdict":"approved|approved_with_changes|rejected","blocking":[...],"nonblocking":[...],"interface_changes":[...],"sequencing_ok":true|false,"notes":"..."}
Then say DONE_REREVIEW. Do NOT modify code. Do NOT push. Review only.
