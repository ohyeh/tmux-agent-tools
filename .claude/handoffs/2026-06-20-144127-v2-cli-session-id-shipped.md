# Handoff: v2 cli_session_id resume — SHIPPED (codex AGREE, pushed)

## Session Metadata
- Created: 2026-06-20 14:41:27
- Project: /Users/paul.yeh/github/tmux-agent-tools
- Branch: tier1-issue-266
- Session duration: ~1 session (commander mode: brain dispatched workers, did not write product code)

### Recent Commits (for context)
  - f0740cc docs(workflow): v2 cli_session_id impl spec, 5-round codex review trail
  - 807418f feat(agent-tmux): v2 cli_session_id resume via single-writer sidecar
  - 0da5df0 docs(plan): tmux-delegate v2 goal-doc — adversarial consensus revision
  - 05693fc docs(workflow): revise next-plan v2 to team quorum --wait
  - 2ffa739 docs(workflow): next-plan v2 — Packet C team needs

## Handoff Chain

- **Continues from**: [2026-06-17-011111-tmux-delegate-plan-consensus.md](./2026-06-17-011111-tmux-delegate-plan-consensus.md)
  - Previous title: tmux-delegate subagent — v1 plan (consensus reached)
- **Supersedes**: None

## Current State Summary

The v2 `cli_session_id` resume feature is COMPLETE, codex-AGREE'd (premise_ok=true,
0 blockers after a 5-round adversarial review), committed (807418f + f0740cc), and
pushed to `tier1-issue-266`. This was the only remaining unimplemented plan from the
tmux-delegate-subagent track. No open work remains for this feature. All prior plans
(plan.md #266, next-plan 0a/0b/A/B, next-plan-v2, tmux-delegate v1, v2-goal-doc) were
already implemented/consensus'd before this session.

## Codebase Understanding

### Architecture Overview

`agent-tmux` (zsh) supervises AI CLIs as tmux workers. v2 adds CLI session-UUID
capture for `resume`, closing the v1 gap (start never emitted the UUID). The 0b
contract makes the worker the SOLE writer of `result.json`; v2 therefore keeps the
UUID in a SEPARATE `session-meta.json` sidecar (single-writer per file).

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `skills/tmux-agent-tools/scripts/agent-tmux` | core zsh tool | `_is_rfc4122_uuid`(~1680), `spawn_session_id_capture`(~1710), `result_init_session`(~1753), `result_session` cli_session_id intercept(~3806), `start_session`(~2505), resume redaction(~3152) |
| `skills/tmux-agent-tools/scripts/profiles/{claude,codex}.conf` | bundled profiles | `session_id_pattern` UNSET (opt-in only) |
| `skills/tmux-agent-tools/scripts/profiles/README.md`, `SKILL.md` | docs | session_id_pattern key + canonical "unset by default" |
| `.claude/agents/tmux-delegate.md` | subagent resume UX | reads sidecar, falls back to supervision |
| `scripts/test-session-meta-smoke` | tests | 27 cases (gitignore: file is under scripts/, tracked) |
| `.workflow/tmux-delegate-subagent/v2-impl-spec.md` | operative spec | 4 guardrails |

### Key Patterns Discovered

- Single canonical writer per state file (0b contract). New metadata → sidecar, not result.json.
- New CLI behavior = declarative profile key + non-fatal best-effort, never hardcoded.
- Defense-in-depth UUID validation: validate at capture-write AND at read.
- Label-anchored two-stage extraction beats broad regex (avoids capturing a decoy UUID).
- `.claude/agents/` is gitignored but `tmux-delegate.md` is tracked → `git add -f` to stage edits.
- `bash -n` fails on this repo's zsh `always` blocks (pre-existing); use `zsh -n` as the parse gate.

## Work Completed

### Tasks Finished

- [x] P1: `session_id_pattern` profile key + `session-meta.json` sidecar + `_is_rfc4122_uuid` validation
- [x] P2: bounded/non-blocking/label-anchored capture (no-op when unset)
- [x] P3: `result --field .cli_session_id` read decoupled from result.json existence; resume UX in tmux-delegate.md
- [x] Sensitivity: redact UUID by default (AGENT_TMUX_SHOW_SESSION_ID=1 to show); excluded from status/team aggregates
- [x] 27-case smoke test; codex AGREE; committed + pushed

### Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| agent-tmux | +128 | capture/validate/read/redact |
| test-session-meta-smoke | +361 (new) | full coverage incl decoy + no-result-json |
| profiles/{claude,codex}.conf, README, SKILL.md, tmux-delegate.md | docs+profiles | unset-by-default, opt-in |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Sidecar not result.json | watcher merge into result.json | 0b single-writer; avoid race/clobber |
| Profiles ship UNSET | broad RFC-4122 pattern (round-1, reverted) | determinism guardrail — broad pattern captured wrong UUID; no verified deterministic label for claude/codex |
| cli_session_id read decoupled from result.json | create skeleton at start | field never in result.json body; sidecar is sole source; surgical |

## Pending Work

## Immediate Next Steps

1. None for this feature — shipped. If a PR is desired for `tier1-issue-266`, open it (branch is pushed).
2. Optional v3: deterministic transcript/audit source so bundled profiles can ship a verified live pattern.

### Blockers/Open Questions

- [ ] None blocking. Open: actual claude/codex session-banner label format is unknown → resume stays operator-opt-in until verified.

### Deferred Items

- Transcript/audit-based UUID source (v3) — more reliable than pane-scrape.

## Context for Resuming Agent

## Important Context

Feature is DONE and pushed; do not re-implement. codex consensus = AGREE (0 blockers).
If extending: keep the single-writer invariant (UUID only in session-meta.json), keep
UUID validation at both write and read, and never synthesize UUIDs — fall back to tmux
supervision when the sidecar is absent.

### Assumptions Made

- pane-scrape is acceptable best-effort for v2; screen-clearing CLIs simply fall back (resume unsupported).

### Potential Gotchas

- `git add .claude/agents/tmux-delegate.md` is refused (gitignored dir); use `-f`.
- Use `zsh -n` not `bash -n` for parse checks (pre-existing `always`-block incompatibility).
- Do not add cli_session_id to `status --json` or `team results` (sensitivity).

## Environment State

### Tools/Services Used

- agent-tmux / tmux-agent-tools; codex via tmux-agent-tools (codex-consensus-gate workflow, gpt-5.5 high).
- context-mode (ctx) for analysis.

### Active Processes

- None persistent. codex consensus tmux sessions (consensus, consensus2..5) may linger; `tmux kill-session` to clean.

### Environment Variables

- `AGENT_TMUX_SHOW_SESSION_ID` (opt-in full UUID display), `TMUX_AGENT_DIR`, `SESSION_ID_PATTERN` (profile-driven).

## Related Resources

- `.workflow/tmux-delegate-subagent/v2-impl-spec.md`, `v2-impl-review-brief.md`, `implementation-notes.md` (## v2)
