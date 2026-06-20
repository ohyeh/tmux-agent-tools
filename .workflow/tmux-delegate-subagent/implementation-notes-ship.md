# tmux-delegate v1 — ship session notes (2026-06-20)

Running notes for the verify-and-ship session. Decisions/deviations NOT in the frozen plan.md.

## Headline finding

v1 was **already fully implemented, committed, and pushed** on `tier1-issue-266` in prior sessions
(incl. the v2 `cli_session_id` backlog item 3A-V2, shipped ahead of v1). This session did NOT
re-implement — it was: inventory → re-verify S1–S9 → ship (PR/merge) → branch cleanup → codex gate.

## Decisions / deviations (not in spec)

1. **Interpreter is zsh, not bash.** `skills/.../agent-tmux` uses `} always {` (zsh-only); `bash -n`
   fails at that line, `zsh -n` is clean. S3/S4 MUST run under zsh — running with bash produces false
   failures (`A: unbound variable`, empty doctor output). Re-confirmed the prior handoff gotcha.

2. **Subagent tool-surface wider than plan.** Plan S8 argued `allowed-tools: [Bash]` only and explicitly
   excluded `Read`. Shipped `.claude/agents/tmux-delegate.md` uses `tools: Bash, Read, Glob, Grep`
   (modern Claude Code subagent schema field `tools:`, not `allowed-tools:`). Each tool is justified in
   the body and the mapping is bidirectional (every body tool ⇄ frontmatter). Wider than the plan's
   minimalist intent — surfaced to codex for a ruling.

3. **OQ-1 resolved to `.claude/agents/*.md`.** Not the `agents/openai.yaml` schema, not `.claude/commands/`.
   `.claude/agents/` is gitignored via a `!`-whitelist; the file IS git-tracked (verified `git ls-files`).

4. **`.gitignore` `!`-whitelist.** `!.claude/handoffs/` + `!.claude/workflows/` re-include otherwise-ignored
   dirs. Working-tree copies were accidentally deleted (pre-session state); restored with `git restore`.

5. **Merge constraint.** Repo forbids merge-commit AND rebase-merge (GraphQL rejected both). Only squash
   allowed. PR #267 squash-merged to main → `7b5367b`.

6. **Branch cleanup (keep-branches-clean).** Deleted: `tier1-issue-266` (merged via #267),
   `chore/formula-v0.19.0` (Formula identical to main, superseded by #265),
   `origin/plan/tmux-delegate-subagent` (content 100% on main; main is a strict superset, +4367 lines;
   plan.md identical). Removed the local `huddle` remote to stop `huddle/*` refs from polluting branch
   analysis — the private repo `ohyeh/huddle` is UNTOUCHED. Re-add with
   `git remote add huddle git@github.com:ohyeh/huddle.git`. Recover plan branch (if ever needed):
   `git push origin fcd98bb:refs/heads/plan/tmux-delegate-subagent`.

7. **Docs to main directly.** This notes file + next-plan doc committed straight to main (docs-only; PR
   flow is heavy for notes and the user asked to keep branch count minimal).

## Functional verification (zsh)

- S3 `CLAUDE=/missing zsh agent-tmux claude doctor --json` → `ok:false`, `agent_cli_binary ok:false`,
  rc==1. Independent named checks: tmux, agent_cli_binary, git, git_worktree, approval. PASS.
- S4 `zsh agent-tmux claude setup` → `ok:true`, doctor+self_test both ok, rc==0. PASS.
- `zsh -n` clean. merge-tree vs main rc==0 (no conflicts). 4 manifests + CHANGELOG at 0.19.0.

## Codex adversarial review — CONSENSUS: agree (no blocking issues)

Reviewer: codex gpt-5.5, high effort, session `v1ship`, main@7b5367b. Worked 3m58s. Verdict at
`/tmp/v1ship-verdict.md`. Required changes: **none**.

- doctor --json / setup: PASS (independent named checks, rc semantics correct; codex reran neg/pos/extra-arg).
- Cascade-spawn ban + no-interpolation: PASS — sufficient for a v1 decision gate (guidance, not sandbox).
- v2 resume guidance: PASS — null-by-default, no UUID synthesis, label-anchored capture, RFC-4122 validated.
- Tool-surface deviation (`tools: Bash,Read,Glob,Grep` vs plan's `[Bash]`): **ACCEPT** — Read/Glob/Grep add
  no mutation authority; Bash remains the only high-risk capability. Not a security regression.
- S1–S9: PASS. Codex independently reran: `test-session-meta-smoke` 27/27, `ci-shellcheck` pass, `zsh -n`
  pass, `jq empty` over evals+manifests pass, `git ls-files` confirms all shipped files tracked.

## Release decision (v0.20.0, not re-using 0.19.0)

v0.19.0 is already a published GitHub release (tag ac1d1c3) + Homebrew formula. main is ahead of it by
+2655/-112 incl. real code (agent-tmux +914: v2 cli_session_id resume, doctor --json/setup; new
test-session-meta-smoke +361; profiles session_id_pattern). A published version cannot be re-released with
different content → bump 0.19.0 → **0.20.0**, new tag v0.20.0, new GH release. (`v0.2.0` is an unrelated
old tag.)

