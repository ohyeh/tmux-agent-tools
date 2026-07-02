# Handoff: Skill hardening (engine-only + verified send + cascade clarity) → v0.25.0 released

## Session Metadata
- Created: 2026-06-24 00:51:15
- Project: /Users/paul.yeh/github/tmux-agent-tools
- Branch: main
- Session duration: ~1 long session (profiles → skill edits → 11-round codex review → release)

### Recent Commits (for context)
  - e143331 release(formula): v0.25.0 url + sha256 (#282)
  - 18c0a58 skill: forbid raw-tmux bypass, require verified send, clarify cascade ban (#281)
  - c7cfafe release(formula): v0.24.0 url + sha256 (#280)
  - c4cd18a release: v0.24.0 (#279)
  - 3e3d699 feat(dialogue): support any CLI agent-tmux can drive as a participant (#278)

## Handoff Chain

- **Continues from**: [2026-06-22-201828-dialogue-generic-participants-v0240-released.md](./2026-06-22-201828-dialogue-generic-participants-v0240-released.md)
  - Previous title: tmux-agent-dialogue generic participants → v0.24.0 released
- **Supersedes**: None

> Review the previous handoff for full context before filling this one.

## Current State Summary

Two unrelated threads of work, both fully shipped. (1) Created personal `claude-fable*` agent-tmux profiles under `~/.config/agent-tmux/profiles/` (NOT in the repo — they live in user config and are gitignored by design). (2) Hardened the tmux-agent skill guidance against agents bypassing the engine with raw `tmux` and against the "prompt looks sent but never submitted" failure, then ran an 11-round adversarial codex review until it passed clean, merged as PR #281, released **v0.25.0** (tag + GitHub release), and merged the Formula bump PR #282. main is clean (only untracked handoffs remain, per repo convention). Nothing is pending.

## Codebase Understanding

### Architecture Overview

- `agent-tmux <cli>` is the single engine; `claude-tmux`/`codex-tmux`/`agy-tmux` are one-line `exec agent-tmux <cli>` shims. New CLIs are added as **declarative profiles** (`~/.config/agent-tmux/profiles/<cli>.conf`, plain `key=value`, never sourced), not code.
- Profile resolution precedence: env (`<NS>_TMUX_*` > `AGENT_TMUX_*`) > `--profile`/`--profile-dir` > `$AGENT_TMUX_PROFILE_DIR` > `~/.config/agent-tmux/profiles` > bundled `scripts/profiles/` > frozen legacy preset.
- Release is GitHub Actions only (`.github/workflows/release.yml`, `workflow_dispatch`): inputs `version` (vX.Y.Z), `prerelease`, `dry_run` (defaults **true**). It must run from `main`, requires a matching `## vX.Y.Z` CHANGELOG section, runs validation (zsh -n on scripts, ruby -c + brew style on Formula, self-tests, a fake/fake dialogue smoke), then on `dry_run=false` tags + creates the release and prints the Homebrew SHA-256 in the step summary.

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `skills/tmux-agent-tools/SKILL.md` | Main skill: Fast paths, Overview Non-negotiable rules, send/verify section | Edited this session |
| `skills/using-tmux-agent-tools/SKILL.md` | Meta-router skill: router-level gates | Edited this session |
| `.claude/agents/tmux-delegate.md` | Subagent that decides inline-vs-worker + builds wrapper calls | Edited this session (tracked despite `.claude/*` ignore) |
| `skills/tmux-agent-tools/scripts/agent-tmux` | The engine. `paste_and_submit` ~L829-841; SUBMIT_DELAY resolve ~L200-220; send-wait nonce ~L3754-3792; send-wait-literal count ~L3826-3845; probe metrics ~L5874-5903 | Source of truth for every doc claim |
| `Formula/tmux-agent-tools.rb` | Homebrew formula (url + sha256) | Bumped to v0.25.0 (#282) |
| `CHANGELOG.md` | Release notes; release.yml greps `## vX.Y.Z` | v0.25.0 section added |
| `~/.config/agent-tmux/profiles/claude-fable*.conf` | Personal profiles (NOT in repo) | See "Important Context" |

### Key Patterns Discovered

- `probe` is the ONLY busy/progress surface: `agent-tmux probe --metric <metric> <name>` — `tool_active` (codex/generic), `active_spinner` (claude). `status --json` has NO busy field; `ping` only returns ok/timeout/dead.
- `send-wait` auto-generates a fresh nonce (safe default). `send-wait-literal` waits for a NEW occurrence vs a pre-send count — existing pane text won't false-positive, but a non-unique literal that unrelated later output emits will. Bare `send` is fire-and-forget (`paste_and_submit`: Enter after SUBMIT_DELAY, a SECOND Enter for multi-line prompts).
- The literal cascade-ban string `"Do not spawn additional tmux sessions or delegate further."` is asserted by `skills/tmux-agent-tools/evals/evals.json` — **do not reword it**.

## Work Completed

### Tasks Finished

- [x] Created `claude-fable.conf` (standalone Fable-5), `claude-fable-opus.conf` (opus 4.8 1M), `claude-fable-sonnet.conf` (sonnet 4.6 1M) in `~/.config/agent-tmux/profiles/`.
- [x] Reconciled with pre-existing `claude-fable-gate.conf`; added `claude-fable-gate-gpt.conf` (gpt-5.5) and `claude-fable-gate-glm.conf` (glm-5.2[1m]) — gateway routes by `--model`, provider via `CC_SWITCH_PROVIDER` env (default "LLM-GATE GPT-PRO").
- [x] Live-tested opus, glm, gpt (all returned `pong`); deleted a redundant gateway-conflated `claude-fable.conf` I first wrote.
- [x] Hardened 3 skill/agent docs with engine-only / verified-send / cascade-clarity rules.
- [x] 11-round adversarial codex review → pass, 0 findings.
- [x] PR #281 merged; v0.25.0 released; Formula PR #282 merged.

### Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| `skills/tmux-agent-tools/SKILL.md` | +Fast-path STOP rule, +3 Non-negotiable rules, +"Sending so it actually submits", cascade clarification | Stop raw-tmux bypass + verified send |
| `skills/using-tmux-agent-tools/SKILL.md` | +engine-only, +verify-send router gates, cascade clarification | Same, at router layer |
| `.claude/agents/tmux-delegate.md` | +Engine-Only Rule, +Send Must Be Verified, ban clarification | Same, for the delegating subagent |
| `CHANGELOG.md` | +v0.25.0 section | Required by release.yml |
| `Formula/tmux-agent-tools.rb` | url/sha256 → v0.25.0 | Post-release Homebrew bump |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Cascade ban = orthogonal to native Agent nesting | (a) total ban incl. native, (b) orthogonal (tmux-only) | Settled on orthogonal AFTER ping-ponging; native `Agent` tool is CC-supervised/depth-capped, so the ban only targets unsupervised tmux/engine workers. Eval-locked literal kept; ambiguity resolved by an explicit "delegate further means tmux/engine workers" clause. |
| Version v0.25.0 (minor) | patch v0.24.1 vs minor | Repo has only `.0` tags; this is substantive behavioral guidance, not a typo |
| Dogfood codex via the engine for review | inline / oracle skill / consensus-gate | Proves the engine-only workflow the docs now mandate |
| `bin=claude` + flags in `launch_flags` for claude-fable | `bin=claude-fable` | `claude-fable` is a shell alias, not a binary; aliases don't exist in tmux panes' non-interactive shell |

## Pending Work

## Immediate Next Steps

1. **Nothing required** — v0.25.0 is fully released, main clean, Homebrew bumped. This is a clean stopping point.
2. (Optional) `claude-fable-sonnet` profile was never live-tested (dry-run only; identical mechanism to opus). Run `agent-tmux claude-fable-sonnet start s1 . 'ping'` if you want full coverage.
3. (Optional) Consider documenting the `claude-fable*` profile family in `skills/tmux-agent-tools/scripts/profiles/README.md` IF you decide a sanitized/generic version belongs in the repo (current ones are personal/user-config and reference `~/.cc-switch` + CLAUDE-FABLE-5.md paths — keep them out of git).

### Blockers/Open Questions

- [ ] None blocking.

### Deferred Items

- Bumping the default `SUBMIT_DELAY` (0.2s) for claude in a bundled profile was discussed but NOT done — the skill now documents `<NS>_TMUX_SUBMIT_DELAY` as the per-CLI knob instead. Revisit only if non-submission recurs in practice; would need a new `submit_delay` profile key in agent-tmux (one-line code change).

## Context for Resuming Agent

## Important Context

- **The `claude-fable*` profiles are personal and live ONLY in `~/.config/agent-tmux/profiles/`, NOT in the repo.** They are intentionally gitignored (`scripts/profiles/*.conf` is ignored; user-config dir is outside the repo). They reference machine-specific paths (`~/.cc-switch/cc-switch.db`, `~/.claude/CLAUDE-FABLE-5.md`). Two families: `claude-fable*` = standalone (no sqlite3/gateway); `claude-fable-gate*` = routes through the `claude-fable-gate` binary (`~/.local/bin/claude-fable-gate`) which does sqlite3→mktemp→`claude --settings`, provider via `CC_SWITCH_PROVIDER`.
- **Every technical claim in the 3 edited docs was verified against `agent-tmux` source over 11 codex rounds.** If you edit these docs again, re-verify against the script — the review repeatedly caught plausible-but-wrong claims (busy fields, double-Enter, env namespace, probe `--metric` syntax, nonce non-idempotency). Don't write from memory.

### Assumptions Made

- LLM-GATE is a single router-gateway: `CC_SWITCH_PROVIDER="LLM-GATE GPT-PRO"` + `--model X` selects the model (confirmed live: gpt-5.5 and glm-5.2[1m] both routed through it). No separate provider row per model.
- v0.25.0 as minor bump matches repo convention (all tags are X.Y.0).

### Potential Gotchas

- **NEVER `git add -A`** in this repo — untracked handoffs and personal profiles must not be committed. Stage explicit paths.
- The `[1m]` model suffix is glob-sensitive in zsh panes — single-quote it inside `launch_flags` (`--model 'glm-5.2[1m]'`) or the pane shell errors "no matches found".
- `.claude/agents/tmux-delegate.md` IS tracked even though `.gitignore` has `.claude/*` (committed before the rule; whitelist only covers handoffs/workflows). `git add` warns "ignored" but succeeds for the already-tracked file.
- release.yml `dry_run` defaults **true** — always run dry-run first; only `dry_run=false` creates the tag/release.
- The cascade-ban literal string is eval-asserted; reword its surrounding prose, never the quoted sentence itself.

## Environment State

### Tools/Services Used

- `agent-tmux` engine (run from bundle: `./skills/tmux-agent-tools/scripts/agent-tmux`; not on PATH in non-interactive shell).
- `codex` CLI (`~/.local/bin/codex`) for the review workers.
- `gh` CLI (authed as `ohyeh`) for PRs/releases/workflow dispatch.
- GitHub Actions `release.yml` for the actual tag/release.

### Active Processes

- None. All review workers (rev–rev11) were stopped. Pre-existing stale codex sessions `revr33/revr35/revr35b/rvw1/rvw2` belong to earlier sessions, were NOT created here, and were intentionally left alone.

### Environment Variables

- `CC_SWITCH_PROVIDER`, `CC_SWITCH_DB`, `CLAUDE_FABLE_SYSFILE` (read by `claude-fable-gate` binary — names only).
- `<NS>_TMUX_SUBMIT_DELAY` / `AGENT_TMUX_SUBMIT_DELAY` (per-CLI submit-delay knob).

## Related Resources

- PR #281 (skill changes): https://github.com/ohyeh/tmux-agent-tools/pull/281
- PR #282 (formula bump): https://github.com/ohyeh/tmux-agent-tools/pull/282
- Release v0.25.0: https://github.com/ohyeh/tmux-agent-tools/releases/tag/v0.25.0
- `skills/tmux-agent-tools/scripts/profiles/README.md` — profile key reference
- `skills/tmux-agent-tools/scripts/profiles/profile.conf.example` — generic profile template

---

**Security Reminder**: Before finalizing, run `validate_handoff.py` to check for accidental secret exposure.
