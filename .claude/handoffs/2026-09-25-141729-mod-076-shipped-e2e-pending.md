# Handoff: tmux-agent mod 0.7.6 shipped — five-CLI e2e and 0.7.6+ backlog pending

## Session Metadata
- Created: 2026-09-25 14:17:29
- Project: ~/github/tmux-agent-tools
- Branch: main
- Session duration: about 16 hours across three context windows (session 0cf4a438, started in ~/github/agent-scripts)

### Recent Commits (for context)
  - 894bdc5 fix(mod): 0.7.6 fable review of 95f32f0 — mirror no-room guard tested, collector-down line cut to one row, tell usage names only
  - 95f32f0 fix(mod): 0.7.6 cursor review of d20cdcc N-1..N-4 — full-window probe timeout recorded, stop/tell take names only, held key never confirms stop, mirror cut to this render's rows
  - d20cdcc fix(mod): 0.7.5 review of 34e2a1e — identity-fair stall probes, #exited notice ack keeps late results, compact band, verbatim tell, stop repeat guard, hint clipped
  - 34e2a1e feat(mod): 0.7.5 panel UX — two-step stop, /tmux subcommands, [ hide ] clear of [-], row budget
  - 401f1c3 fix(mod): 0.7.5 cursor review O1–O8

## Handoff Chain

- **Continues from**: [2026-09-25-122434-mod-075-release-review.md](./2026-09-25-122434-mod-075-release-review.md)
  - Previous title: tmux-agent mod 0.7.5 — reviews, push, deployed wrapper, e2e
- **Supersedes**: 2026-09-25-122434-mod-075-release-review.md (its steps 1–4 and 6 are done; step 5, the e2e, carries over here)

## Current State Summary

tmux-agent mod 0.7.6 is pushed to origin/main (`d20cdcc..894bdc5  main -> main`) and installed (`installed_plugins.json`: `0.7.6 894bdc538845a22c2c426c9f83ec11b90743dc6a`). The user ran `/reload-plugins` and the panel reads `tmux workers v0.7.6 [ refresh ]  1-9 select · /tmux stop <name> · /tmux tell <name> <text> … [ hide ] [-]`. Gates on 894bdc5: `claude plugin test` 133 pass / 0 fail; mod smokes (permissions, typecheck, version-sync) exit=0; mod mutations 48/48 KILLED; the full `run-all-smokes` ran on 95f32f0 (exit=0, 71/71 PASS, tree unchanged). Reviews: cursor opus on d20cdcc `VERDICT: PASS` (N-1..N-4 fixed in 95f32f0); cursor fable 5.1 on 95f32f0 `VERDICT: PASS` (three P3 fixed in 894bdc5). The deployed wrapper already carries the unsent-paste fix 9b5da45 (unchanged since d20cdcc). All reviewer workers are stopped. Not done: the five-CLI real-session e2e.

## Codebase Understanding

### Architecture Overview

- Reconcile on a 10 s clock: `collect()` (4 s pass budget, resume at `gate.collectFrom`, first worker exempt) then `flagStalls()` (4 s, longest-unprobed first via `gate.probedAt`; a probe counts when answered or when it timed out with its full 3 s window — a budget-cut probe does not).
- Acks per session `tmux-agent.reported.<sid>`; episode `<name>@<since>`; notice-only `#launch` / `#exited` suffixes; `episodeOf()` strips them.
- `/tmux` panel = `AbovePrompt` band. Every drawn row counts against `maxRows` (overflow scrolls and disarms digit hotkeys). `/tmux stop|tell` take a name only (row numbers move with every refresh); `/tmux N` still selects row N.

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| mods/tmux-agent/hooks/register.ts | the whole mod | collect, flagStalls, panel render, /tmux command |
| mods/tmux-agent/tests/register.test.ts | 133 engine tests | each review round is a describe block ('cursor review of d20cdcc', 'fable review of 95f32f0') |
| skills/tmux-agent-tools/scripts/agent-tmux | wrapper | classifier, `_assign_paste_unsent` |
| CHANGELOG.md, mods/tmux-agent/README.md | docs | 0.7.6 entry covers N-1..N-4 and the fable P3s |

### Key Patterns Discovered

- Every finding becomes a ported test plus a mutation in `<scratchpad>/mut/run.py`. GOTCHA: the runner resolves `S` to `<scratchpad>/mut`, so it tests `<scratchpad>/mut/mods` — rsync the repo's `mods/` there (`rsync -a --delete ~/github/tmux-agent-tools/mods/ <scratchpad>/mut/mods/`), not to `<scratchpad>/mods`.
- Multi-line mutation patterns must use `\n` escapes inside one Python string literal.
- `mockWake` and `mockPanel` both register `ui.log`; one test cannot use both.

## Work Completed

### Tasks Finished

- [x] 0.7.6: N-1 full-window timeout recorded; N-2 names-only stop/tell (`drawn` removed; usage, compact band, command list texts updated); N-3 repeat beat slides `armedStop.from`; N-4 mirror sliced to `rows_available`, empty list counted
- [x] fable P3s: guard test (4-row band drew 5 without it), collector-down line `truncate-end`, tell usage names only
- [x] Pushed, plugin updated, user confirmed v0.7.6 on the panel
- [x] Reviewers stopped: astra-mod074-review-r2-5mt6 (was on codex quota until 3:36 PM — the wrapper classified it `quota_exhausted`, a live positive for codex), opus-mod075-review-781t, fable-mod076-review-ivsw
- [x] New profile `~/.config/agent-tmux/profiles/cursor-fable51-high.conf` (model `claude-fable-5-1-high`, verified via `cursor-agent --list-models`), user asked for it as the astra replacement

### Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| mods/tmux-agent/hooks/register.ts | N-1..N-4, texts, down-line wrap | cursor + fable reviews |
| mods/tmux-agent/tests/register.test.ts | N-1..N-4 tests, fable describe block | regressions |
| manifests (plugin.json, marketplace.json) | 0.7.6 | version-sync smoke |
| CHANGELOG.md, mods/tmux-agent/README.md | 0.7.6 entry, names-only commands | docs follow code |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| stop/tell take names only | `drawn` snapshot / names only | the snapshot closed only the ms gap; the race is the seconds between reading the panel and Enter |
| Held key slides the stop window | fixed 400 ms beat / sliding | key repeat at 375 then 405 ms confirmed a stop |
| Reviewer for 0.7.6 = cursor fable 5.1 high | wait for astra quota / fable | user: "可以改用 cusor-agent claude fable-5.1 high 代替" |

## Pending Work

### Immediate Next Steps

1. Five-CLI real-session e2e on the installed 0.7.6: cursor, agy, claude, claude-fable-gate, codex (codex quota resets 3:36 PM 2026-09-25). For each: `assign` a tiny brief (e.g. write a file and commit), then `peek` right after to prove the brief was submitted (not sitting in the composer); check the delivered line says `commit <sha12> verified` / `NOT verified` correctly; stop the worker afterwards.
2. Record e2e evidence in CHANGELOG or the next handoff; stop every e2e worker.
3. Decide Q-1 and Q-2 below with the user.

### Blockers/Open Questions

- [ ] Q-1: auto-stop TTL for delivered workers (mod 0.7.7) - Suggested: 30 min idle with no tell
  - ans:
- [ ] Q-2: Warp and `ctrl+x tab` — user to run `cat -v`, press ctrl+x then Tab; `^X^I` printed = the chord reaches the pty - Suggested: rely on `/tmux` subcommands either way
  - ans:

### Ruled-Out Paths

- Border around the panel (costs 2 of 13 rows).
- Hard 10 s cap on collect (reintroduces A1 starvation).
- Position-based probe cursor (astra C1).
- `drawn` snapshot to resolve `/tmux stop N` (cursor N-2: human-scale race).

### Deferred Items

- 0.7.7 lifecycle auto-stop (needs Q-1).
- `login_prompt` dialogs are needs-input with a toast only, no wake.
- Pre-existing UNCONFIRMED: live claude/agy/grok banner layouts for the classifier; whether `tell`'s 15 s worst case aborts inside the hook.
- Tagging v0.42.0 needs explicit user approval.

## Context for Resuming Agent

### Important Context

- The user's recurring complaint: a brief left unsent in a worker's composer. Peek after every assign/tell. 2026-09-25 live: cursor needed two composer nudges; the wrapper pressed them and the worker started.
- Cursor queues a `tell` sent while it is working as a "follow-up" (`○ [Pasted text #N]`); it runs after the current turn, not immediately.
- Announce any ad-hoc CLI session, name it `tmux-agent-UIPROBE-…`, and close it in the same turn. Never touch `cursor-grok47xf-r94-*` or `cursor-opus55h-r94-droid3-rxpr` (other sessions).
- The user wants silent waiting and results only.

### Assumptions Made

- `/reload-plugins` applied 0.7.6 without a restart — confirmed by the user's panel paste (title `v0.7.6`).

### Potential Gotchas

- Full smoke suite ~20 min; do not edit the tree while it runs (`git diff | shasum` before/after).
- The engine prefixes command output with `tmux-agent:`; do not add another.
- The mutation runner's own copy lives at `<scratchpad>/mut/mods` (see Key Patterns).

## Environment State

### Tools/Services Used

- `claude plugin test` / `claude plugin validate` in mods/tmux-agent; `zsh scripts/run-all-smokes`
- `claude plugin marketplace update tmux-agent-tools` + `claude plugin update tmux-agent@tmux-agent-tools`
- profiles: cursor-opus55-high, cursor-fable51-high, codex-astra

### Active Processes

- None from this session: all reviewer workers were stopped.

### Environment Variables

- TMUX_AGENT_DIR, XDG_STATE_HOME, HOME

## Related Resources

- Reviews: ~/.local/state/tmux-agent-tools/opus-mod075-review/review.md; ~/.local/state/tmux-agent-tools/fable-mod076-review/review.md
- Previous handoff: ./2026-09-25-122434-mod-075-release-review.md
