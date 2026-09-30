# Handoff: workers-core P0–P8 done on origin/workers-core 3f9b89b — P8 delta unreviewed, main/tag/publish pending

## Session Metadata
- Created: 2026-09-30 09:56:10
- Project: ~/git/tmux-agent-tools
- Branch: workers-core
- Session duration: about 2 days (2026-09-29 to 2026-09-30), 10 context compactions

### Recent Commits (for context)
  - 3f9b89b fix(send-lock): retry mkdir when the lock dir vanishes during the no-pid wait
  - 10ecf23 release: 0.42.0 (workers core)
  - aeea11d docs: point the workers-core checklist at this branch and a dated count
  - cdb83de fix(scripts): count -S/-L only on the argv passed to tmux
  - c3a2c29 fix(test): fail the no-mutation stub when status omits --no-write

## Handoff Chain

- **Continues from**: [2026-09-25-141729-mod-076-shipped-e2e-pending.md](./2026-09-25-141729-mod-076-shipped-e2e-pending.md)
  - Previous title: tmux-agent mod 0.7.6 shipped — five-CLI e2e and 0.7.6+ backlog pending
- **Supersedes**: None. Detailed run log: `.workflow/202609291537-workers-core/handoff.md` (untracked, local only).

## Current State Summary

The workers-core plan P0–P8 is complete and pushed to origin/workers-core at `3f9b89b` (version 0.42.0). One workers core (`skills/tmux-agent-tools/scripts/lib/workers.ts`) and the `.v3` ledger (contract v6) now serve the mod, the CLI collector, the commander, the mcp-adapter and the TUI/launcher. All acceptor gates pass at 3f9b89b. `main` is untouched at `6295486`; nothing is tagged or published. The P8 commits (`10ecf23`, `3f9b89b`) and the F1–F9 fixes had no independent review after they landed — only acceptor gates and mutation runs. The user asked "reivew 都過了？" and was told this; the user has not yet decided whether to run a grok review of `aeea11d..3f9b89b`.

## Codebase Understanding

### Architecture Overview

- Ledger `.v3`: claim / submit / ack per episode, activation fencing, "unknown is not absent" (an unprovable state holds delivery, never counts as gone).
- The `.action` lock holder records token, pid, pidStart. The waiter `binding` record (`episodes/<seq>/waiter`) holds delivery only while the holder with the same token is provably alive (`waiterOf` / `holderProvablyAlive` in workers.ts).
- Commander assign/tell/stop run through `workers.cli.node.ts`; panel is `snapshot.node.ts panel` (no shell panel, decision D1). One socket variable: `TMUX_AGENT_TMUX_SOCKET` (D2).
- Legacy import is removed (user choice). A pre-v5 root is not imported.

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| skills/tmux-agent-tools/scripts/lib/workers.ts | shared workers core | delivery, binding, stalls, unlock |
| skills/tmux-agent-tools/scripts/lib/ledger.ts | `.v3` ledger | claim/submit/ack, allocateNext |
| skills/tmux-agent-tools/scripts/lib/snapshot.node.ts | panel/scan | incomplete scan exits 1 |
| mcp-adapter/src/adapter.js | MCP adapter | `already_acked` before claim |
| skills/tmux-agent-tools/scripts/agent-tmux | wrapper | `send_lock_around` (open race, see below) |
| docs/tmux-agent-mod.md | mod doc | "已知邊界" = Known limits |
| scripts/check-tmux-socket-isolation | guard | every tmux test uses a private socket |
| scripts/test-send-lock-smoke | send-lock smoke | now actually runs its case bodies |

### Key Patterns Discovered

- tmux isolation: `$TMUX` outranks `TMUX_TMPDIR`. Every test uses `-S`/`-L` and unsets TMUX/TMUX_PANE. A test killed the default server twice before this rule.
- Use a short `TMUX_TMPDIR=$(mktemp -d)`; long scratchpad paths fail with "File name too long" and give false contract failures.
- Node floor: `/Users/paul.yeh/.npm/_npx/899bf9cc10daad37/node_modules/node/bin/node` (v22.18.0).
- Worktrees live at `~/git/tmux-agent-tools.wt/<x>`; integration is linear ff onto workers-core.
- Sourcing a cli launcher (`exec agent-tmux <cli>`) replaces the shell; tests must source the engine with the cli name.

## Work Completed

### Tasks Finished

- [x] P0–P7 plus all review fixes (astra R1–R14, grok final F1–F9), each fix with a mutation run
- [x] P8: 0.41.0 → 0.42.0, CHANGELOG `## v0.42.0 - 2026-09-30`, Known limits in docs/tmux-agent-mod.md (`10ecf23`)
- [x] P8 round 2: send-lock vanished-dir race fixed (`3f9b89b`)
- [x] Cursor context-mode hook CPU storm (PID 28021): hooks.json in the plugin cache now calls `/opt/homebrew/bin/context-mode` (backup `hooks.json.bak-npx`)

### Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| 7 version sites (plugin/marketplace manifests, agent-tmux, hooks/register.ts) | 0.42.0 | v0.41.0 is already tagged |
| skills/tmux-agent-tools/scripts/agent-tmux | vanished lock dir → retry mkdir | exit 75 only when `$subdir` is not writable |
| scripts/test-send-lock-smoke | vanished-dir case; source engine not launcher | old harness never ran bodies |
| scripts/test-sessions-resolve-smoke | fake tmux accepts `=name:` | matches `session_target` |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Bump to 0.42.0 | reuse 0.41.0 | 0.41.0 already tagged |
| Cut legacy import | keep importer | user chose "砍掉 import (Recommended)" |
| Max 2 rounds per gate | unlimited | user cap; P8 gate used both rounds |
| Grok instead of astra for final review | wait for astra | codex/astra quota out until 2026-10-04 02:10 |

## Pending Work

### Immediate Next Steps

1. Get the user's answers to Q-1..Q-5 below. Q-1 (review) should come before any main/tag step.
2. If Q-1 = yes: dispatch one broad cursor-grok review of `aeea11d..3f9b89b` plus whether F1–F9 are really closed plus the Q-2 race.
3. After the user approves: merge workers-core into main, tag v0.42.0, run release.yml; then re-verify `codex plugin install` with id `tmux-agent` and watch the first release.yml run.

### Blockers/Open Questions

- [ ] Q-1: Run an independent grok review of `aeea11d..3f9b89b` (plus F1–F9 closure) before main/tag? - Suggested: yes
  - ans:
- [ ] Q-2: Open a round 3 for the send-lock no-pid steal? A waiter that sees the lock dir with no pid for 0.2s `rm -rf`s it and steals from a live holder that has not stamped its pid (seen under load: `no such file or directory: .../send.lock.d/pid`, claude-concurrent; `test-send-lock-smoke` FLAKY-PASS). Pre-existing since v0.35.0. - Suggested: yes, atomic acquire (pid written before the lock becomes visible)
  - ans:
- [ ] Q-3: Merge workers-core into main? - Suggested: after Q-1/Q-2
  - ans:
- [ ] Q-4: Tag v0.42.0 and run release.yml (never run on GitHub yet)? - Suggested: after Q-3
  - ans:
- [ ] Q-5: Drop `stash@{0}` in the main worktree (stray 00:30 worker edits re-adding a shell legacy_panel; conflicts with D1; copy saved as `.workflow/202609291537-workers-core/stray-main-worktree-0030.patch`)? - Suggested: drop
  - ans:

### Ruled-Out Paths

- Cursor `claude-sonnet-5-5-medium`: "Weekly usage limit reached". Cursor `gpt-5.6-luna-max`: "command failed unexpectedly". Do not retry before the weekly reset.
- Restarting running grok workers to pick up the hook patch: loses progress; only new sessions matter.

### Deferred Items

- Permanent fix for the Cursor context-mode hook (plugin update overwrites the cache patch): belongs upstream / context-mode-local-insight.

## Context for Resuming Agent

### Important Context

- Role: dispatcher and acceptor only ("你不要自己當 worker"). Workers do the code; use cursor-grok (`grok-4.7-xhigh`).
- Approved without asking: merge + push workers-core after acceptor gates. NOT approved: merge to main, tag, publish, dropping the stash — ask first.
- Acceptor evidence at 3f9b89b: contract `# pass 128 # fail 0 # cancelled 0`; plugin `0 fail` (181); typecheck `1 passed, 0 failed`; version-sync `11 passed, 0 failed`; guard `tmux socket isolation: ok`; `adapter smoke ok`; send-multiline 5x `0 0 0 0 0`; run-all-smokes `RAS_EXIT=0` (76 PASS, 1 FLAKY-PASS test-send-lock-smoke); mutation with fix reverted: `FAIL: claude-vanished-dir on claude`.
- Quotas: codex/astra until 2026-10-04 02:10; agy 5h window tiny; Cursor Claude/fable weekly exhausted; grok works. Do not overuse cursor-fable.
- cursor-grok can take >45s to draw its UI; assign then fails at step "send". Stop the empty worker and re-assign.

### Assumptions Made

- Holder pid = `$PPID` of a `/bin/sh` probe is the engine process (UNCONFIRMED; documented as a Known limit).
- release.yml works on real GitHub (UNCONFIRMED).

### Potential Gotchas

- Hooks can block a foreground `agent-tmux capture`; use `mcp__tmux-agent__peek`.
- Parallel contract runs hung twice in `tui.contract` (not reproduced); run gates sequentially.
- `origin/workers-core` is not a local tracking ref here; confirm with `git ls-remote origin workers-core`.

## Environment State

### Tools/Services Used

- tmux-agent MCP tools (assign/peek/stop/tell), cursor-grok profile, `claude plugin test .`, node 22.18.0.

### Active Processes

- Worktree `~/git/tmux-agent-tools.wt/p8-final` (branch wc-p8-final, merged). Stale worker tmux sessions may remain (e.g. cursor-grok-grok-p8-release-gv6y).

### Environment Variables

- TMUX, TMUX_PANE (unset for tests), TMUX_TMPDIR, TMUX_AGENT_TMUX_SOCKET, ZDOTDIR (empty in commander smoke).

## Related Resources

- `.workflow/202609291537-workers-core/` (handoff.md, grok-wc-review-final.md, astra-wc-review-all.md, stray patch)
- docs/tmux-agent-mod.md "已知邊界"; docs/workers-core-release-checklist.md; CHANGELOG.md `## v0.42.0`
