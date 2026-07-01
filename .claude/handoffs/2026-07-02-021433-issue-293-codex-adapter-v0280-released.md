# Handoff: Issue #293 (Codex sub-agent adapter/provider) fully implemented, adversarially reviewed, released as v0.28.0

## Session Metadata
- Created: 2026-07-02 02:14:33
- Project: /Users/paul.yeh/github/tmux-agent-tools
- Branch: main
- Session duration: Long-running `/loop` session, several hours across many dispatch/verify/gate cycles.

### Recent Commits (for context)
  - d0fb6c7 docs(#293): record adapter isolation-guard fix verification
  - 1f45cc3 Fix mcp adapter isolation guards for #293
  - 3ad929a Fix send guard for blocked prompts (#293)
  - c2e3e73 fix(mcp-adapter): require full result fields for #293
  - 3df7945 docs(#293): add running implementation-notes.md for the session
  - 78f3021 release: v0.28.0 (#293)
  - 69234f0 feat(#293): mirror agents/skill into Codex-native .codex/ discovery
  - 2431d10 Anchor status blocking checks to current prompt area (#293)
  - b60d496 Fix Codex login prompt docs and detection (#293)
  - (earlier in the same session, already pushed before this handoff: a1723da, 10cda12, e753e4d, 47fe379, 9badec1, 08cedbc, 6519c19 — see `git log --oneline 8d5fd8b..d0fb6c7` for the full range)

## Handoff Chain

- **Continues from**: [2026-06-25-211846-issues-289-290-v0270-released.md](./2026-06-25-211846-issues-289-290-v0270-released.md)
  - Previous title: Issues #289 + #290 fixed → v0.27.0 released (prompt-file/stdin + agy first-class)
- **Supersedes**: None

> Review the previous handoff for full context before filling this one.

## Current State Summary

GitHub issue #293 ("Codex sub-agent adapter/provider for tmux-managed workers") is **fully
implemented, adversarially reviewed (3 fresh independent codex gate rounds, final verdict: AGREE),
and pushed to `origin/main`** as v0.28.0. All work in this repo's product code (agent-tmux script,
mcp-adapter package, agent/skill definitions) was implemented by codex CLI workers dispatched via
`agent-tmux`/`codex-tmux`, per the user's explicit "commander mode" requirement — the orchestrating
Claude session only planned, dispatched, independently re-verified (never trusted self-reports),
and made final accept/reject calls. Nothing is blocked or in progress; this handoff exists to
preserve the decision trail and the several real bugs that were found and fixed along the way, in
case similar issues resurface or a future session touches this same code.

## Codebase Understanding

## Architecture Overview

`tmux-agent-tools` is a Homebrew-distributed CLI (`agent-tmux`, with `claude-tmux`/`codex-tmux`/
`agy-tmux` thin wrappers) that drives AI coding CLIs as managed tmux workers. Core contract:
`start` / `send` / `send-wait` (nonce-verified) / `status --json` / `result --json` /
`result wait-required` / `watch` / `stop`. Completion is always `result.json`-file-based, never
pane-scraping. The engine script `skills/tmux-agent-tools/scripts/agent-tmux` is a single large zsh
file (~7100+ lines); it is packaged both as a plugin skill (`skills/tmux-agent-tools/`) and mirrored
for native discovery by each CLI host: Claude Code reads `agents/*.md` (repo root) and
`.claude/agents/*.md`; Codex CLI now also reads `.codex/agents/*.toml` and a `.codex/skills/`
symlink (added this session — see below).

Issue #293 asked for a way for Codex (and Claude) to drive tmux-managed workers through a
lifecycle resembling Codex's own hypothetical native `spawn_agent`/`wait_agent`/`send_input`/
`close_agent` surface. Two integration depths were built:
1. **Primary** (per explicit user preference, NOT the issue's original MCP-first framing): native
   skill/agent discovery. `SKILL.md` (same content, same mechanism) is read identically by both
   Claude Code and Codex CLI via the shared `~/.agents/skills` installer convention. `agents/*.md`
   is mirrored to `.claude/agents/*.md` (Claude) and converted to `.codex/agents/*.toml` (Codex's
   own custom-agent TOML format, with a `developer_instructions` field). No MCP registration
   required for either host.
2. **Secondary/optional**: `mcp-adapter/`, a small Node.js MCP server (`codex-tmux-agent-adapter`)
   exposing 5 tools (`spawn_tmux_agent`, `send_tmux_agent`, `wait_tmux_agent`, `read_tmux_agent`,
   `close_tmux_agent`) for callers who specifically want programmatic MCP tool-calling instead of
   relying on a model's own subagent judgment. Explicitly documented as NOT a native Codex
   `spawn_agent` provider (no such extension point exists in the installed `codex-cli 0.142.5`).

## Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `skills/tmux-agent-tools/scripts/agent-tmux` | The core engine (zsh, ~7100+ lines) | Got 3 real fixes this session: boot trust-gate false positives (2 rounds), send-path blocked-prompt guard |
| `skills/tmux-agent-tools/SKILL.md` | Primary skill doc, read identically by Claude Code and Codex CLI | Slimmed from ~36KB to 6.6KB this session; detail moved to `references/` |
| `agents/*.md`, `.claude/agents/*.md`, `.codex/agents/*.toml` | Native subagent definitions for each host | `.codex/agents/*.toml` and `.codex/skills/tmux-agent-tools` symlink are NEW this session |
| `mcp-adapter/src/adapter.js` | The 5-tool MCP server implementation | Had 2 real bugs found by adversarial review, both fixed (see Decisions Made) |
| `mcp-adapter/test/adapter-smoke.js` | Fake-fixture-based test for the adapter | Extended 3 times this session to cover the 2 bug fixes |
| `scripts/test-hook-trust-status-smoke` | Canonical regression test for boot trust-gate / login-prompt / send-guard behavior | Grew from ~9 to 37 assertions this session |
| `scripts/test-agent-delegate-packaging-smoke` | Validates agent/skill mirror consistency across hosts | Extended to check `.codex/` TOML validity + symlink target |
| `implementation-notes.md` (repo root, tracked, committed) | **Full decision/tradeoff/bug log for this session** — read this first for the complete story | 598+ lines; the single source of truth for "why" decisions were made |
| `CHANGELOG.md` | v0.28.0 entry added this session | Cross-checked against real commits before writing, per this repo's version-sync test |

## Key Patterns Discovered

- **"Commander mode" dispatch pattern**: the orchestrating Claude session never edits product code
  directly. It resolves a literal `result.json` path (`agent-tmux codex result --path <name>`)
  *before* starting a worker, injects that path plus a no-cascade-spawn guard into the worker's
  prompt, starts the worker, waits via `agent-tmux codex result wait-required <name> --fields status
  --wait <seconds> --json` (never pane-scraping for completion), and independently re-verifies via
  `git show`, re-running tests itself, and — for anything non-trivial — dispatching a genuinely
  *fresh* codex session (different session, no memory of the work) as an adversarial reviewer, never
  trusting the implementing session's own self-report or a same-session self-review.
- **Two-worker parallel dispatch on disjoint files works fine in the main working tree** (no git
  worktree needed) as long as the files touched are genuinely disjoint. One caveat found this
  session: don't run your OWN verification/polling commands that invoke the very same shell script
  file (`agent-tmux`) a worker is actively mid-editing — this caused one transient
  `command not found` error (harmless, but confusing) from reading a half-written file. Poll via
  `git log` or a separate copy instead when this collision is possible.
- **The Workflow tool's `Workflow({name, args})` top-level `args` param has a known bug**: args
  silently don't arrive in the script. Workaround used repeatedly this session: write a small
  top-level script that internally calls `workflow('some-registered-name', {...})` (nested
  invocation) — nested args DO arrive correctly. Also: nested `workflow()` needs the workflow's
  registry **name** string, not a `scriptPath`.
- **`codex-consensus-gate`'s return shape**: `{ gate: {ok, verdict, consensus, notes}, consensus,
  passed }` — `consensus` and `passed` are top-level siblings of `gate`, NOT nested inside it. Easy
  to get wrong (I did, earlier in this session, before this handoff's timeframe) and silently
  misreport every clean gate round as failed.
- **Root-cause discipline paid off repeatedly**: the login-prompt false positive was "fixed" once
  by narrowing a keyword pattern, which did NOT fix the underlying defect (WHERE the detection
  looked — full 80-line tmux scrollback — was the actual bug, not WHICH keywords it matched). Only
  anchoring detection to the pane's current-prompt-area boundary (`current_prompt_area_for_text()`)
  actually fixed it. Lesson: when a "fix" for a detection/classification bug only narrows a pattern
  without changing the scope/window being matched against, be suspicious it's treating a symptom.

## Work Completed

## Tasks Finished

- [x] Slimmed `SKILL.md` to <8KB (6,660 bytes), moved detail to
      `skills/tmux-agent-tools/references/core-workflow.md` and
      `skills/tmux-agent-tools/references/profiles.md`.
- [x] Added `agents/codex-oneshot.md` + `agents/claude-oneshot.md` thin one-shot forwarder
      subagents, mirrored into `.claude/agents/`.
- [x] Four `agent-tmux` friction fixes: boot trust-gate preflight, task-scope config-hijack guard
      (`--allow-project-config` opt-out), result.json-authoritative completion on nonce timeout,
      `send --key enter|up|down`.
- [x] Built `mcp-adapter/` — Node.js MCP server, 5 tools, documented as secondary/optional.
- [x] Added `.codex/agents/*.toml` + `.codex/skills/tmux-agent-tools` symlink for Codex-native
      discovery (recovered from a background task that kept running after being thought "stopped" —
      independently re-verified before accepting, see `implementation-notes.md` for that story).
- [x] Found, root-caused, and fixed (2 rounds) a login-prompt false-positive in the boot trust-gate.
- [x] Ran 3 rounds of fresh, independent adversarial codex review before push. Round 1 found and
      blocked on 2 real defects (send-path guard bypass, adapter incomplete-result-reported-as-
      completed). Round 2 confirmed both fixes live, found 1 more real gap (adapter missing 2
      spec-required isolation lines). Round 3: AGREE, no further changes, cleared for push.
- [x] Bumped version to v0.28.0 (3 plugin manifests + CHANGELOG, matches this repo's version-sync
      convention/test).
- [x] Pushed all 9 final commits (and the earlier commits in the same session) to `origin/main`.
      Verified `origin/main` HEAD == local HEAD == `d0fb6c7`.

## Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| `skills/tmux-agent-tools/SKILL.md` | Slimmed 36KB→6.6KB | Keep first-open guidance focused |
| `skills/tmux-agent-tools/references/*.md` | New/extended | Progressive disclosure of detail moved out of SKILL.md |
| `skills/tmux-agent-tools/scripts/agent-tmux` | Boot trust-gate, config guard, result.json race fix, `--key`, login-prompt scrollback-anchor fix, send-path blocked-guard | Core engine fixes, see Decisions Made |
| `agents/*.md`, `.claude/agents/*.md` | New one-shot forwarder agents | Requested native sub-agent wrapping for Claude |
| `.codex/agents/*.toml`, `.codex/skills/tmux-agent-tools` (symlink) | New | Native sub-agent/skill wrapping for Codex, no MCP needed |
| `mcp-adapter/` (whole new package) | New Node.js MCP server + tests + README | Secondary/optional integration path |
| `scripts/test-hook-trust-status-smoke` | Grew 9→37 assertions | Regression coverage for every bug found this session |
| `scripts/test-agent-delegate-packaging-smoke` | Extended | Validates 3-way agent mirror + Codex TOML/symlink |
| `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json` | 0.27.0→0.28.0 | Version bump |
| `CHANGELOG.md` | New v0.28.0 section | Release notes |
| `implementation-notes.md` (new, tracked) | 598+ lines | Full session decision/bug log — **read this for anything not covered here** |

## Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Primary integration = native skill/agent discovery, not MCP | (a) MCP server as primary, per issue's original framing; (b) native SKILL.md + agent mirrors as primary, MCP secondary | User explicitly rejected MCP-as-primary mid-session: "可我沒想要用MCP啊，我還是偏好SKILL 然後支援CLI的sub-agent模式". Verified empirically that SKILL.md already loads identically for both hosts via the shared `~/.agents/skills` installer — no new integration layer needed for the core ask. |
| `skills/tmux-agent-tools/agents/openai.yaml` left untouched | Edit it to "teach" Codex about the skill vs. leave it | Empirically verified via `codex debug prompt-input` that this file has ZERO effect on a real codex session's model-visible context — Codex learns from `SKILL.md` frontmatter alone, same as Claude. Editing it would have been a no-op. |
| Login-prompt fix: anchor to current-prompt-area, not narrower keywords | (a) narrow the keyword pattern (tried first, insufficient — commit `b60d496`); (b) anchor detection to the pane's live prompt boundary, ignore historical scrollback | (a) kept producing new false positives (first from an unrelated MCP server's login banner, then from the tool's OWN commit message text scrolling past) because the real bug was WHERE it looked (full 80-line scrollback), not WHICH words. (b) is the actual root-cause fix, commit `2431d10`. |
| `--raw`/`--key` send variants left unguarded against blocked prompts | (a) guard everything including raw/key; (b) guard only the normal task-injection send paths (`send`, `send-wait`, `send-wait-literal`), leave `--raw`/`--key` unguarded | `--raw`/`--key` are the designated mechanism for a human/supervisor to actually ANSWER a detected blocking prompt (e.g. `send --raw "y"` to clear a permission dialog). Guarding them too would create a deadlock: blocked prompt, no way to ever clear it via agent-tmux. Confirmed sound by 2 independent adversarial gate rounds, including live reproduction that `mcp-adapter`'s own `send_tmux_agent()` only exposes the guarded `send-wait` path anyway, so programmatic callers can't bypass the guard via raw/key regardless. |
| mcp-adapter's `wait_tmux_agent()` now requires the FULL result-field contract | (a) keep checking only `status` (original, buggy); (b) require `schema_version,status,summary,artifacts,errors` and report `failed/invalid_result` if any are missing | (a) let an incomplete worker result silently report as `completed`, reproduced live by an adversarial reviewer with a 2-field-only fake result. (b) matches what the adapter's own prompt/README already told workers to produce — commit `c2e3e73`. |
| mcp-adapter's worker prompt now injects 2 more isolation lines (no-background-jobs, no-external-side-effects) | (a) leave as-is (only result-path/required-fields/no-cascade); (b) add the 2 lines the issue text explicitly specifies | Spot-checked the actual issue text myself (`gh issue view 293`) before accepting the reviewer's claim — confirmed genuine, not reviewer overreach. Commit `1f45cc3`. |
| `implementation-notes.md` committed to the repo | (a) leave as an untracked scratch file; (b) commit it as a deliverable | The original task instruction explicitly asked for a running "implementation-notes.md ... with decisions you had to make... tradeoffs... things I should know" — read as a requested deliverable, not scratch work. Committed in `3df7945`. |
| Version bump: v0.27.0 → v0.28.0 (minor) | patch (0.27.1) vs minor (0.28.0) | This session's work is substantial new functionality (MCP adapter, cross-CLI native discovery, SKILL.md restructure), matching this repo's own precedent of minor bumps for feature releases (0.26.1→0.27.0 was also a feature bump; only 0.26.0→0.26.1 was a patch). |
| 3 rounds of fresh adversarial gate before push, not 1 | Stop after round 1's fixes look good vs. keep re-gating with a genuinely fresh session each time | User's original instruction was explicit: only done when a fresh adversarial codex session has NO remaining objections. Round 1 found 2 real bugs; round 2 (after fixing those) found 1 more real, legitimate gap. Round 3 finally agreed. Each round used a DIFFERENT codex session with no memory of prior rounds' conclusions, and each did live reproduction, not just diff-reading — this caught real bugs that same-session self-review would likely have missed. |

## Pending Work

## Immediate Next Steps

Nothing is blocking. If resuming to extend this work, natural next steps would be:
1. Consider whether to close GitHub issue #293 (left for the repo owner to do, not auto-closed).
2. Optional follow-up: apply the `writing-great-skills` meta-skill methodology to `SKILL.md`'s
   description/content as a dedicated quality pass — the user and I agreed this pairs well with the
   session's work but explicitly deferred it to avoid concurrent file-edit races with the friction
   fixes; it was never picked back up before the session ended. Not started.
3. Optional follow-up: the Homebrew formula (`Formula/tmux-agent-tools.rb`) still needs its
   `release(formula): v0.28.0 url + sha256` bump — this is a separate, later PR by this repo's own
   convention (requires a real GitHub release/tag to exist first so the tarball sha256 can be
   computed) and was explicitly out of scope for this session's push.

## Blockers/Open Questions

- [ ] None. All in-scope work for issue #293 is complete, verified, and pushed.

## Deferred Items

- `writing-great-skills` pass on `SKILL.md` (see above) — agreed in principle, not started.
- Homebrew formula sha256 bump — separate post-tag step, not part of this session's scope.
- 5 pre-existing, unrelated test failures found and bisected during verification (see Potential
  Gotchas below) — confirmed out of scope for #293, not fixed, left for a future session.

## Context for Resuming Agent

## Important Context

**Read `implementation-notes.md` at the repo root first** — it is the authoritative, detailed
decision/bug log for this entire session (598+ lines) and is more complete than this handoff for
anything about *why* a specific line of code looks the way it does. This handoff is the summary;
that file is the source.

**This repo's whole workflow for AI-driven changes is dispatch-then-independently-verify.** If you
are a fresh agent picking this up, do not assume a worker's `result.json` self-report is accurate —
every single fix in this session was independently re-verified (git diff read, tests re-run myself,
and for anything substantive, judged by a *separate*, fresh codex session with no memory of the
work). This is not paranoia for its own sake: it caught 3 real bugs across this session's own
work (2 in round-1 adversarial review, 1 more in round 2) that would otherwise have shipped.

**Do not re-litigate the MCP-vs-native-discovery decision** — the repo owner was explicit and
somewhat emphatic about this mid-session (rejected MCP as the primary integration path after it had
already been partly built that way). `mcp-adapter/` stays as a secondary, clearly-labeled-optional
path; do not promote it back to primary without being asked again.

## Assumptions Made

- Assumed "bump version" meant this repo's existing 2-tier release convention (plugin manifests +
  CHANGELOG now; Homebrew formula sha256 later, separately) rather than a full release including
  the formula — confirmed correct by checking git history for the exact same 2-step pattern used in
  prior releases (v0.27.0, v0.26.1).
- Assumed a minor (not patch) version bump was correct given the scope of new functionality —
  reasoned from this repo's own precedent, not explicitly confirmed by the user, but not
  contradicted either.
- Assumed `.claude/handoffs/*.md` files from OTHER, unrelated past sessions (referencing issues
  #283, #289, #290, etc., all present as untracked files throughout this session) were intentionally
  left uncommitted by a prior session and were NOT part of this session's scope — left them
  completely untouched throughout, including telling every dispatched codex worker to ignore them.

## Potential Gotchas

- **`skills/tmux-agent-tools/scripts/agent-tmux` is a single zsh script, not sourced from smaller
  modules.** Any invocation of `agent-tmux`/`codex-tmux`/`claude-tmux` re-execs the whole file fresh
  each time. If you run your own verification commands (e.g. `status --json`, `result
  wait-required`) at the exact moment a dispatched worker is mid-editing that same file (only
  possible when NOT using a git worktree for isolation), you can hit a transient, confusing
  `command not found` error from reading a half-written file. It is not a real bug in the final
  committed code — always re-check against the file AFTER the worker's commit lands, not while it's
  in flight.
- **`scripts/test-liveness-degrade-smoke` genuinely HANGS** (not just slow) on this machine —
  reproduces identically even at the `v0.27.0` baseline commit (`8d5fd8b`), before any of this
  session's changes. Always run it (and the full smoke suite generally) with a `timeout` wrapper
  (e.g. `timeout 90 zsh scripts/test-<name>-smoke`) or it can stall an entire verification pass for
  20+ minutes. Pre-existing, unrelated to #293, not fixed this session.
- **5 pre-existing smoke-test failures found this session, all bisected and confirmed unrelated to
  #293** (identical failure before and after every change made this session):
  `test-claude-env-inherit-smoke` (2 failures), `test-lint-path-smoke` (2 failures),
  `test-liveness-degrade-smoke` (hangs), `test-liveness-smoke` (1 flaky timeout on the `inv-codex`
  case), `test-transcript-smoke` (1 flaky `capture_session:121: lines: parameter not set` on the
  `tr-codex` case). If you see these fail again, they are very likely the same pre-existing issues,
  not something you broke — but re-bisect against `8d5fd8b` to be sure rather than assuming.
- **The `Workflow({name, args})` top-level args-dropping bug** (see Key Patterns Discovered above)
  will silently produce a workflow that ignores your intended parameters if you don't work around
  it with the nested-`workflow()` pattern.
- **`--raw`/`--key` sends bypass the new blocked-prompt guard by design** — this is intentional
  (see Decisions Made), but if you're auditing this code fresh, don't mistake it for a leftover
  vulnerability without first checking why (it's the designated prompt-clearing mechanism).

## Environment State

### Tools/Services Used

- `agent-tmux` / `codex-tmux` / `claude-tmux` (this repo's own CLI, from
  `skills/tmux-agent-tools/scripts/`) — used throughout to dispatch and supervise codex workers.
- `codex-cli` (version 0.142.5 at time of this session) — the actual worker CLI driven via
  `codex-tmux`.
- Claude Code `Workflow` tool — used for the `codex-consensus-gate` adversarial review rounds (3x)
  and one custom cross-CLI investigation script, via the nested-`workflow()` workaround.
- `gh` CLI — used to read the real GitHub issue #293 text/comments directly, multiple times, rather
  than trusting paraphrases (including specifically to spot-check an adversarial reviewer's claim
  about a spec requirement before accepting it).
- `tmux` — underlying session management; several stray sessions were manually cleaned up mid-session
  (`tmux kill-session`) after background tasks were interrupted/stopped.

### Active Processes

- None left running. All dispatched codex-tmux worker sessions from this session were explicitly
  stopped (`agent-tmux codex stop <name>`) after their work was verified and committed.

### Environment Variables

- `TMUX_AGENT_DIR` — used by test scripts to sandbox state into a temp dir; not set globally.
- No secrets or credentials were used or referenced in this session.

## Related Resources

- GitHub issue: https://github.com/ohyeh/tmux-agent-tools/issues/293
- `implementation-notes.md` (repo root) — full session log, read this first.
- Previous handoff: `.claude/handoffs/2026-06-25-211846-issues-289-290-v0270-released.md`
- Final pushed commit: `d0fb6c7` on `origin/main`.

---

**Security Reminder**: Before finalizing, run `validate_handoff.py` to check for accidental secret exposure.
