# Handoff: profile template + gitignore personal-profile guard (PR #270 MERGED)

## Session Metadata
- Created: 2026-06-22 00:46:35
- Project: /Users/paul.yeh/github/tmux-agent-tools
- Branch: main (feature branch `chore/profile-template-and-gitignore` squash-merged)
- Session duration: ~1.5h

### Recent Commits (for context)
  - 6cd0196 chore(profiles): add generic template + gitignore personal .conf (#270)
  - d359180 feat: v3 structured session-id capture + #268 headless oneshot (default-off) (#269)

## Handoff Chain

- **Continues from**: None (fresh start)
- **Supersedes**: None

## Current State Summary

PR #270 merged to `main`: added a canonical generic profile template (`profile.conf.example`) and a `.gitignore` rule that blocks personal/local `.conf` profiles from the repo while whitelisting `.conf.example` templates. The work was driven by a user question about "universal profiles" — through engine source analysis + an independent codex review pass, we established that `agent-tmux` profiles are NOT universal (the env-var override swaps only the binary, not flags/heuristics/pipeline), deleted a dead misleading `mycli.conf` local profile, and shipped the template + gitignore guard. A `claude-fable-gate` wrapper+profile was also created locally (cc-switch provider launcher) but lives in `~/.config` + `~/.local/bin`, NOT in the repo.

## Codebase Understanding

### Architecture Overview

`agent-tmux <cli> <command>` is a single zsh engine (`scripts/agent-tmux`, ~6747 lines) that runs any AI coding CLI as a managed tmux worker. Per-CLI behavior is driven by **declarative profiles** (`key=value`, never sourced → cannot execute code). The profile parser is a flat `case "$key" in` block (engine ~line 114-170); there is **NO profile include/inherit/extends mechanism** by design. Key resolution precedence: env vars (`<NS>_TMUX_*` > `AGENT_TMUX_*` > bare `<NS>`) > `--profile` > `$AGENT_TMUX_PROFILE_DIR` > user config dir (`~/.config/agent-tmux/profiles/`) > bundled defaults (`scripts/profiles/`) > legacy preset (engine line 25-30).

Two critical engine facts established this session:
1. **Binary override** (engine line 209-211): `CLI_BIN="${(P)_ENV_NS}"` — the bare `${ENV_NS}` env var overrides `bin`. For a profile with `env_ns=AGENT`, the override var is `AGENT=<path>`. This swaps ONLY the binary, not launch_flags/heuristic_family/resume_keyword (those are independent keys, parsed separately at ~line 115-170).
2. **Profile file match** (engine line 101): `[[ -f "$dir/$cli.conf" ]]` — engine reads ONLY `<cli>.conf`, never `.example`. Templates are inert.

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `skills/tmux-agent-tools/scripts/agent-tmux` | the engine (~6747 lines, zsh) | profile parser at ~line 100-170; bin override at ~209-211; preset table at 25-30 |
| `skills/tmux-agent-tools/scripts/profiles/profile.conf.example` | NEW canonical generic template (this PR) | documents all 19 engine keys; the "universal template" users copy from |
| `skills/tmux-agent-tools/scripts/profiles/README.md` | supported-keys table + examples | authoritative key reference; PR added a "start from template" section |
| `.gitignore` | repo ignore rules | PR added `scripts/profiles/*.conf` ignore + `!*.conf.example` whitelist |
| `skills/tmux-agent-tools/scripts/profiles/*.conf` | bundled defaults (agy/claude/codex/cursor/grok) | ship in repo, stay tracked (gitignore does not untrack already-committed files) |
| `~/.local/bin/claude-fable-gate` | LOCAL wrapper (cc-switch provider launcher) | NOT in repo; sqlite3→mktemp→claude --settings pipeline |
| `~/.config/agent-tmux/profiles/claude-fable-gate.conf` | LOCAL profile | NOT in repo; bin=claude-fable-gate, heuristic_family=claude |

### Key Patterns Discovered

- **Engine key set = 19 keys**: bin, env_ns, prefix, launch_flags, resume_keyword, session_id_pattern, heuristic_family, usage_kind, pattern_{busy,permission_prompt,approval_prompt,login_prompt}, approval, result_required_fields, result_path_via_prompt, exec_mode, prompt_via, prompt_flag, session_id_capture. Verified via `sed` + `comm -23` set-diff against the template (zero omissions/typos).
- **`.example` suffix convention**: templates ship in repo (tracked), real `.conf` files are local/personal (gitignored). Matches the pre-existing `gemini.conf.example` pattern.
- **`result_path_via_prompt` family defaults** (engine line 180-186): claude=false, codex/generic=true.
- **codex worker env trap**: `$TMUX_AGENT_RESULT` is empty inside codex's sandboxed tool env. Always pass the **literal result path** in prompts to codex workers, never the `$`-variable. `result_path_via_prompt=true` families (codex/generic) auto-inject the literal path; do NOT also write `$TMUX_AGENT_RESULT` in the prompt (causes `no matches` glob errors).

## Work Completed

### Tasks Finished

- [x] Established profiles are NOT universal (engine source + independent codex review, double-verified)
- [x] Deleted dead/misleading `~/.config/agent-tmux/profiles/mycli.conf` (codex decided: delete, high confidence)
- [x] Created `claude-fable-gate` wrapper + profile (cc-switch provider launcher) locally
- [x] Added `scripts/profiles/profile.conf.example` canonical template (all 19 keys documented)
- [x] Updated README.md with template entry-point section
- [x] Added `.gitignore` rule: ignore `*.conf`, whitelist `*.conf.example`
- [x] Reviewed PR (claude inline after codex rate-limit): found + fixed inaccurate gitignore comment
- [x] PR #270 squash-merged to main, CI smoke pass, branch deleted

### Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| `skills/tmux-agent-tools/scripts/profiles/profile.conf.example` | NEW (55 lines) | canonical template covering all engine keys |
| `skills/tmux-agent-tools/scripts/profiles/README.md` | +12 lines | template entry-point section |
| `.gitignore` | +9 lines | block personal `.conf`, whitelist `.example`, accurate comment |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Delete `mycli.conf` (local) | delete / repurpose / keep | codex final call: file is dead (bin→/tmp gone), duplicative (gemini.conf.example exists), demonstrably misleading (caused wrong "universal" mental model twice) |
| template goes in repo (tracked) | repo vs local-only | template is FOR sharing/copying; must ship. Real profiles stay local via gitignore |
| gitignore `*.conf` + `!*.conf.example` | — | belt-and-suspenders: personal profiles live in `~/.config` (already outside repo), this guards accidental copies into repo |
| squash merge | squash vs merge commit | 2 commits (PR + review fix) → clean single commit on main |
| inline review (claude) after codex rate-limit | wait for codex vs inline | review needed heavy engine-source tracing + git verification; inline faster than worker round-trip for tool-heavy tasks |

## Pending Work

### Immediate Next Steps

1. (optional) `claude-fable-gate` wrapper writes a live `ANTHROPIC_AUTH_TOKEN` to `/tmp` via mktemp. Could be hardened to stdin injection (`claude --settings /dev/stdin`) if claude supports it. Not urgent — wrapper already rm's the temp file.
2. (optional) Clean up 15 stale codex tmux sessions from 6/21 (`codex-cli-revr31`, `codex-cli-fix1`, etc.) — they're idle, consuming resources. `tmux-agent-sessions cleanup --created-after <ts>`.
3. No other pending work — task fully closed.

### Blockers/Open Questions

- None. PR merged, main synced.

### Deferred Items

- Profile "sharing" across CLIs (DRY for repeated keys like `heuristic_family=claude`): engine has no include mechanism by design. Defer any generator/template-system until ≥4 same-family profiles exist (currently 2: agy, claude-fable-gate). YAGNI.

## Context for Resuming Agent

### Important Context

- **Repo topology**: `origin = ohyeh/tmux-agent-tools` (public). Memory rule: NEVER push public main directly; always branch + PR + merge. This session followed that (branched off `origin/main`, PR #270, squash merge).
- **Profiles are local-first**: personal profiles live in `~/.config/agent-tmux/profiles/` (home, outside repo). gitignore is belt-and-suspenders, not the primary boundary. The repo's `scripts/profiles/*.conf` are SHIPPED DEFAULTS (agy/claude/codex/cursor/grok) and must stay tracked.
- **The "universal profile" question is settled**: NO. Engine's env-var override (line 209-211) swaps only the binary, not flags/heuristic/resume/pipeline. If asked again, point to engine lines 115-170 (independent keys) + 209-211 (bin-only override).
- **Local artifacts created this session (NOT in repo)**: `~/.local/bin/claude-fable-gate` (wrapper), `~/.config/agent-tmux/profiles/claude-fable-gate.conf` (profile). These reference `~/.cc-switch/cc-switch.db` (contains live provider tokens).

### Assumptions Made

- `claude-fable` is a shell alias (`claude --dangerously-skip-permissions --system-prompt-file ~/.claude/CLAUDE-FABLE-5.md`), NOT a binary — aliases don't expand in tmux panes' non-interactive shell, so a wrapper binary was needed.
- `cc-switch.db` provider names with spaces (`LLM-GATE GPT-PRO`) must go through env/wrapper, not `launch_flags` (flags are shell-split).

### Potential Gotchas

- **`git check-ignore -v` misleads on negated rules**: it prints the last matching rule (even a `!` negate), looking like "ignored". Use `git add -n` (dry-run) to test real git behavior.
- **`--dry-run` flag position**: `agent-tmux <cli> start --exact --dry-run <name> <dir> 'prompt'` — `--dry-run` MUST come before positionals, else it's swallowed as prompt text and a real session starts (happened once this session, cleaned up).
- **codex `$TMUX_AGENT_RESULT` glob error**: see Key Patterns above. Always literal paths to codex workers.
- **15 stale codex tmux sessions** from prior work still listed in `tmux ls` — not from this session, but clutter.

## Environment State

### Tools/Services Used

- `agent-tmux` engine at `~/.claude/skills/tmux-agent-tools/scripts/agent-tmux` (skill bundle, same source as repo)
- `gh` CLI for PR #270 create/checks/merge
- codex worker `decide-mycli` (completed, stopped) and `review-pr270` (stopped early — rate limited)

### Active Processes

- None. All codex workers stopped. No background jobs.

### Environment Variables

- `CC_SWITCH_PROVIDER`, `CC_SWITCH_DB`, `CLAUDE_FABLE_SYSFILE` — knobs read by the local `claude-fable-gate` wrapper (names only; values contain no secrets, but the db they point at does).

## Related Resources

- PR: https://github.com/ohyeh/tmux-agent-tools/pull/270
- Engine profile parser: `skills/tmux-agent-tools/scripts/agent-tmux:100-170`
- Profile key reference: `skills/tmux-agent-tools/scripts/profiles/README.md`
- Local wrapper: `~/.local/bin/claude-fable-gate`

---

**Security Reminder**: Before finalizing, run `validate_handoff.py` to check for accidental secret exposure.
