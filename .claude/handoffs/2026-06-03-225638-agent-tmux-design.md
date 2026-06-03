# Handoff: agent-tmux unified CLI design — v2 doc approved for PR A

## Session Metadata
- Created: 2026-06-03 22:56:38
- Project: /Users/paul.yeh/github/tmux-agent-tools
- Branch: refactor/skill-progressive-disclosure
- Session duration: ~2h

### Recent Commits (for context)
  - f428c10 fix(test): make sessions-watch-smoke deterministic via fake tmux binary
  - b46cae6 Use portable grep in probe parsing
  - ad41101 Sanitize tmux skill examples
  - f46245b feat(agy-tmux): generic-CLI preset for Antigravity (agy/Gemini) via launch-flags seam (#234)

## Handoff Chain

- **Continues from**: [2026-05-23-155605-tmux-agent-tools-skill-refactor.md](./2026-05-23-155605-tmux-agent-tools-skill-refactor.md)
- **Supersedes**: None

## Current State Summary

This session handled issues/PRs on the ohyeh/tmux-agent-tools repo, then pivoted to designing a major refactor: unifying `claude-tmux`, `codex-tmux`, `agy-tmux` into a single `agent-tmux` entrypoint with CLI-as-preset and a new `pair`/`team` workflow for persistent multi-agent collaboration. A design document was written at `docs/agent-tmux-design.md`, reviewed twice via a `claude-tmux` worker agent, and iterated to v2. PR A (core unification, no behaviour change) is approved by the reviewer. PR B (pair + team) needs 4 more things addressed in the doc before implementation starts.

## Work Completed

### Tasks Finished

- [x] Merged PR #234 (feat: agy-tmux generic-CLI preset) — fixed `${VAR:-default}` → `${VAR-default}`, resolved review threads, squash merged
- [x] Closed issues #232, #233 (feature requests implemented by #234)
- [x] Fixed issue #231: `test-sessions-watch-smoke` flaky timing — replaced real tmux sessions with fake tmux binary via `$TMUX` env-var seam, `--interval 0`, fully deterministic
- [x] Rebased `refactor/skill-progressive-disclosure` onto main (got `agy-tmux`)
- [x] Wrote `docs/agent-tmux-design.md` v1 + v2 (two review rounds via claude-tmux worker)

### Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| `scripts/test-sessions-watch-smoke` | Full rewrite — fake tmux binary, no real sessions | Fix #231 flaky timing race |
| `docs/agent-tmux-design.md` | New file — unified CLI design doc v2 | Design artifact for upcoming refactor |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| `agent-tmux <cli> <command>` syntax | `--cli <cli>` flag alternative | CLI-first is more concise for interactive use |
| `--role` as sugar for `--tag role=<value>` | Separate role field | `--tag` already implemented in start/resume; no new infra |
| `AGENT_TMUX_*` as universal fallback namespace | Per-CLI only | CLI-specific `CLAUDE_TMUX_*` still works; `AGENT_TMUX_*` for cross-CLI scripts |
| `TMUX_CONF` scoped to `/tmp/agent-tmux-<cli>.tmux.conf` | Single shared file | Prevents race when two CLIs run concurrently |
| Shims kept indefinitely | Deprecate after one release | Zero maintenance cost, no caller breakage |
| `--worker-cli` defaults to lead CLI | Default to codex | Symmetric for grok/cursor/agy users |

## Pending Work

## Immediate Next Steps

1. **Add 4 things to design doc** before starting PR B implementation:
   - `$TMUX_AGENT_DIR` fallback path for non-managed callers (`~/.local/state/tmux-agent-tools` — matches existing default)
   - `pair` exit code contract: exit 1 if any worker fails, stderr lists failures
   - Mixed worker CLIs: change `worker_cli` from team-level to per-member in team state schema
   - `team stop` self-detection rule: `basename $(dirname $TMUX_AGENT_RESULT)` compared to member `name`
   - Enumerate actual `INHERIT`/`CLEAR` env var names for claude/codex/agy

2. **Run third review round** with updated doc (reviewer approves PR B in addition to PR A)

3. **Implement PR A**: new `agent-tmux` script + shims for claude-tmux/codex-tmux/agy-tmux

4. **Implement PR B**: pair + team commands

### Blockers/Open Questions

- [ ] PR B design not fully approved yet — 4 spec gaps remain (see above)
- [ ] User hasn't confirmed: are mixed-CLI teams (e.g. 2 codex + 1 agy workers) in scope for PR B?

### Deferred Items

- `start-ssh` still hardcodes `codex --yolo` for remote binary (noted as follow-up in PR #234, not blocking)
- `status --json` / `tmux-agent-sessions` not yet prefix-aware for arbitrary CLI prefixes

## Context for Resuming Agent

## Important Context

- The repo is `ohyeh/tmux-agent-tools` (not `PaulYeh/tmux-agent-tools`). GH CLI is authenticated.
- Current branch `refactor/skill-progressive-disclosure` is pushed and up-to-date with origin.
- `docs/agent-tmux-design.md` is **not committed yet** — it's an untracked file. Commit it before starting PR A.
- `test-sessions-watch-smoke` fix **is committed** (commit f428c10) and pushed.
- The design uses two-phase PRs: PR A (safe, no behaviour change) then PR B (new features). Do not mix them.
- Reviewer agent is reliable: use `claude-tmux start --exact <name> <repo> "<prompt>"` + `result --wait` pattern to get structured JSON feedback.
- `--tag` is confirmed implemented in `start_session` (line 2033) and `resume_session` (line 2323) of claude-tmux. No infra work needed for `--role`.

### Assumptions Made

- `agy-tmux` is now in the repo after rebase from main (confirmed: `skills/tmux-agent-tools/scripts/agy-tmux` exists)
- User wants persistent workers (pair mode is idempotent resume, not ephemeral spawn)
- User confirmed: main brain often runs outside tmux; lead auto-tag is best-effort

### Potential Gotchas

- `refactor/skill-progressive-disclosure` diverged from main and needed rebase. The merge conflict in `claude-tmux`/`codex-tmux` was caused by a sanitize commit — resolved by taking `--theirs` (main's version was correct).
- `team stop` must not stop the calling session — guard is required, otherwise Claude can kill itself mid-task.
- `pair` stale state is the expected failure mode (manual tmux kill). Reconciliation must check live session existence before deciding start vs resume.

## Environment State

### Tools/Services Used

- `gh` CLI — authenticated as `ohyeh` (not `PaulYeh` — different account)
- `claude-tmux` worker pattern for design review (start → result --wait → stop)
- `git rebase --onto origin/main` with `--theirs` conflict resolution

### Active Processes

- None (review sessions stopped)

## Related Resources

- Design doc: `docs/agent-tmux-design.md`
- Flaky test fix commit: f428c10
- PR #234 (merged): agy-tmux feat
- Issues closed: #231 (fixed), #232, #233 (closed as resolved by #234)
