# ADVERSARIAL REVIEW: tmux-delegate subagent v1

You are an adversarial reviewer. Be skeptical. Try to find defects, not approve.
Repo: /Users/paul.yeh/github/tmux-agent-tools. Review the latest commit's diff
(`git show --stat HEAD; git diff HEAD~1 HEAD`). Plan + decisions:
`.workflow/tmux-delegate-subagent/{plan.md,implementation-notes.md}`.

Check hard against these and report each as PASS/FAIL with file:line evidence:
1. `doctor --json`: tmux and agent_cli_binary are INDEPENDENT named checks; `--json`
   path does NOT call require_tmux; exits 1 iff ok==false; default text path unchanged.
   Re-run S3 yourself: `CLAUDE=/definitely/missing .../agent-tmux claude doctor --json`.
2. `setup`: returns nonzero when CLI binary missing; combined JSON well-formed; self-test
   subshell exit does not kill the parent.
3. JSON escaping in doctor/setup detail strings is correct (try a path with a quote/space).
4. `.claude/agents/tmux-delegate.md`: frontmatter valid; every tool used in body is in `tools:`;
   numeric thresholds present (30s, 2 files); cascade-spawning ban verbatim; no `--resume` pattern.
5. evals JSON valid; trigger entries have correct should_trigger polarity.
6. All four manifests == 0.19.0; CHANGELOG has 0.19.0.
7. `bash -n` clean; no unrelated/over-engineered changes (ponytail: smallest diff).

Reply with marker [REVIEW-DONE] then a numbered verdict list and a final
APPROVE / CHANGES-REQUESTED line. If CHANGES-REQUESTED, give exact fixes.
