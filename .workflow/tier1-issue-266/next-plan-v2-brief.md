# Planning brief — what ships next (v2)

Context: packets 0a/0b/A/B from `.workflow/tier1-issue-266/next-plan.md` are now MERGED on `tier1-issue-266` (commit 83b05eb). So we now HAVE: three-peer family model, auto result-path contract, `watch --count N`, `team quorum --count`.

You are my fixed planning teammate. Propose the SINGLE highest-value NEXT packet, evidence-first.

## Doctrine (hard)
- Truth = code/log/actual output, NOT memory or old .md. Cite concrete `file:line` from the CURRENT tree for every claim about what exists / what's missing.
- MECE the candidate set, then pick ONE primary with a fallback. No speculative scope (YAGNI).
- The plan must be implementable as a small surgical packet on `skills/tmux-agent-tools/scripts/agent-tmux` (+ docs/self-test), same style as 0a/0b/A/B.

## Candidate set to weigh (from next-plan.md "Out of scope (YAGNI)" — now reconsider given quorum/watch --count exist)
worker DAG / `needs:` gate, profile inheritance, TUI, budget governor, done-webhook, result-schema migration, auto-cancel losing workers, semantic voting/tie-breaking.

Key question to answer with evidence: now that `watch --count` and `team quorum` exist, is a downstream worker DAG `needs:` gate (block a worker until N upstream results are present/valid) the natural next primitive? Is anything in the current code ALREADY half-built toward it (cite lines)? Or is a different candidate higher-value?

## Output
Write a v1 plan to `.workflow/tier1-issue-266/next-plan-v2.md` with: Goal, Why-now (evidence w/ file:line), the ONE chosen packet (landing sites + exact behavior + self-test + gates), fallback, and explicit Out-of-scope. Then write your result JSON to /Users/paul.yeh/.local/state/tmux-agent-tools/review/result.json (status, summary, artifacts=[next-plan-v2.md]) and end your pane message with marker line exactly: === PLAN DONE ===
