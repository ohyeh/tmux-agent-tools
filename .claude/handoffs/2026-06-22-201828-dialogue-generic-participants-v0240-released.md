# Handoff: tmux-agent-dialogue generic participants → v0.24.0 released

## Session Metadata
- Created: 2026-06-22 20:18:28
- Project: /Users/paul.yeh/github/tmux-agent-tools (GitHub: ohyeh/tmux-agent-tools)
- Branch: main (synced with origin/main at c7cfafe)
- Session duration: ~single session (continued from a compacted prior session)

### Recent Commits (for context)
- c7cfafe release(formula): v0.24.0 url + sha256 (#280)
- c4cd18a release: v0.24.0 (#279)
- 3e3d699 feat(dialogue): support any CLI agent-tmux can drive as a participant (#278)
- 90ae1fa release(formula): v0.23.0 url + sha256 (#277)
- 82f9543 release: v0.23.0 (#276)

## Handoff Chain

- **Continues from**: [2026-06-22-004635-profile-template-gitignore-pr.md](./2026-06-22-004635-profile-template-gitignore-pr.md)
  - Previous title: profile template + gitignore PR work (v0.23.0 era)
- **Supersedes**: None

> The previous handoff covers the v0.23.0 work (profile template, heuristic_family
> generic fix, using-tmux-agent-tools meta-router). This handoff covers the v0.24.0
> dialogue generalization that followed.

## Current State Summary

Work is COMPLETE and SHIPPED. The session began by dogfooding the newly-built
`using-tmux-agent-tools` meta-router (a single-agy supervised-worker test, which
passed). Testing then expanded to a claude↔agy `tmux-agent-dialogue` pair-review,
which surfaced a real bug: `tmux-agent-dialogue` hardcoded `codex|claude` as the
only real participants, so agy (and every other CLI) was rejected — the lone
holdout in a suite that otherwise drives any CLI via `agent-tmux <cli>`. The user
asked for full generalization ("agy | claude | codex 或後續其他 coding agent cli
都要可以用"). I generalized the script to drive every real participant directly
through `agent-tmux <cli>` (zero per-CLI code), verified it end-to-end, merged it
(#278), and cut release v0.24.0 (#279 manifest bump → tag → #280 Formula). main is
at c7cfafe with all version strings aligned at 0.24.0. Nothing is pending.

## Codebase Understanding

### Architecture Overview

- `agent-tmux` is the unified engine (~6700-line zsh) that runs any AI coding CLI
  as a managed tmux worker. `claude-tmux`/`codex-tmux`/`agy-tmux` are thin shims
  that are literally `exec agent-tmux <cli> "$@"`. New CLIs are added as declarative
  profiles (key=value, never sourced), NOT code.
- `tmux-agent-dialogue` runs a BOUNDED two-party dialogue (presets: pair-review,
  critic, debate, handoff) with a validated JSONL transcript. It alternates turns,
  waits for a per-turn nonce marker, writes one JSONL object per turn, and
  self-cleans the tmux sessions it created (even on the failure path).
- `using-tmux-agent-tools` is an on-demand meta-router skill: maps task-shape →
  wrapper via a decision tree, then defers to the canonical capability table in
  `skills/tmux-agent-tools/SKILL.md` (single source of truth, no duplication).

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `skills/tmux-agent-tools/scripts/tmux-agent-dialogue` | The two-party dialogue runner | THE file changed this session |
| `skills/tmux-agent-tools/scripts/agent-tmux` | Unified engine driving every CLI | dialogue now calls it directly per participant |
| `skills/tmux-agent-tools/SKILL.md` | Canonical capability table + workflow | unchanged (never restricted participant types) |
| `skills/using-tmux-agent-tools/SKILL.md` | Meta-router | unchanged; was the thing being dogfooded |
| `Formula/tmux-agent-tools.rb` | Homebrew formula | bumped to v0.24.0 url+sha256 |
| `.claude-plugin/{plugin,marketplace}.json` | Version manifests (3 fields) | bumped to 0.24.0 |
| `.github/workflows/release.yml` | workflow_dispatch release pipeline | dry_run defaults TRUE — see Gotchas |

### Key Patterns Discovered

- `$wrapper` is invoked as a single command word followed by a subcommand
  (`"$wrapper" start ...`). To inject the `<cli>` arg (a 2-token prefix
  `agent-tmux <cli>`) the call sites use a zsh array `"${wrapper[@]}"` or the
  inline form `"$SCRIPT_DIR/agent-tmux" "$agent"` — never a space-joined string
  (that would be one quoted arg and fail).
- `fake` participants never route through the engine path: they use
  `start_fake_agent` + per-op `if [[ $agent == fake ]]` guards and live in
  `OWNED_SESSIONS`, not `OWNED_WRAPPERS`. So engine-path changes never touch fake.
- Release order is causal: bump CHANGELOG + 3 manifest fields → merge → trigger
  release workflow (builds tag+release) → THEN compute tarball sha256 → update
  Formula → temp-tap audit/install/test → cleanup tap → merge Formula PR.

## Work Completed

### Tasks Finished

- [x] Dogfounded `using-tmux-agent-tools` router: single agy supervised worker (start→send-wait→wait→result→stop), passed.
- [x] Diagnosed dialogue's hardcoded `codex|claude` whitelist (4 gates: wrapper_for_agent, two `--agent-a/b` validations, transcript jq schema).
- [x] First pass (shim-based) — then, per user, replaced with full engine-direct generalization.
- [x] `engine_cmd_for_agent` returns `[agent-tmux, <cli>]`; all call sites use array/2-token form.
- [x] `--agent-a/--agent-b` accept any non-flag token; transcript `.agent` relaxed to any non-empty string.
- [x] Verified: zsh -n, ci-shellcheck, fake↔fake regression, real claude↔agy (exit 0), real claude↔gemini (no shim; one exit 0, one graceful marker_timeout).
- [x] PR #278 merged. Release v0.24.0: #279 (bump) → tag via workflow → #280 (Formula). main aligned at c7cfafe.

### Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| `skills/tmux-agent-tools/scripts/tmux-agent-dialogue` | engine-direct participant driving + relaxed validation + help/Behavior note | support any CLI as a participant |
| `CHANGELOG.md` | Unreleased → v0.24.0 - 2026-06-22 entry | release notes |
| `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | 0.23.0 → 0.24.0 (3 fields) | version bump |
| `Formula/tmux-agent-tools.rb` | url → v0.24.0, sha256 → 87dadceb…79ff0 | point at released tarball |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Engine-direct `agent-tmux <cli>` | (a) shim-existence whitelist (b) engine-direct | (a) only covered claude/codex/agy (had shims); user wanted ALL future CLIs → (b) is zero-per-CLI-code, matches suite philosophy |
| Relax transcript `.agent` to non-empty string | keep enum / list more values / any string | jq can't know future CLI names; non-empty string is backward compatible and validates agy/gemini |
| `--agent-a/b` validation = non-flag token | shim check / doctor preflight / any non-empty | suite has no CLI whitelist; agent-tmux already fails clearly if a binary is missing — defer to it |
| Did NOT edit router SKILL.md | edit / leave | the limitation lived in code, not the doc; doc never restricted participant types, so the fix removed a limitation rather than needing new wording |
| minor bump 0.23.0 → 0.24.0 | patch / minor | new user-facing capability = minor |

## Pending Work

## Immediate Next Steps

1. Nothing required — v0.24.0 is fully released and main is clean. (`brew upgrade tmux-agent-tools` delivers it.)
2. OPTIONAL: decide whether to commit the two untracked handoff files in `.claude/handoffs/` (this one + the 2026-06-22-004635 one). They are deliberately untracked; the repo's `.gitignore` / prior convention kept handoffs local.
3. OPTIONAL: gemini-as-participant intermittently hits marker_timeout — see Gotchas; raise `--timeout` or resolve gemini's skill-conflict noise if you want it reliable.

### Blockers/Open Questions

- [ ] None blocking. Open question only: should `.claude/handoffs/` be tracked or stay local? (Currently local/untracked.)

### Deferred Items

- Shim-less CLIs other than gemini (cursor, grok) were not live-tested as participants — the generic engine path covers them, but only gemini/agy were exercised end-to-end this session.

## Context for Resuming Agent

## Important Context

The headline change: `tmux-agent-dialogue` no longer restricts real participants
to claude/codex. It drives each via `agent-tmux <cli>` directly, so any CLI the
engine can run (agy, gemini, cursor, grok, in-house) can be a participant with no
new code. If you need to add a brand-new CLI, you do NOT touch dialogue — you add
a profile the same way as anywhere else in the suite. `fake` is untouched and still
works (it bypasses the engine path entirely).

This is COMPLETE work. Do not "continue" it expecting unfinished pieces — there are
none. Resume only if a NEW related task arrives (e.g. a participant bug, or wanting
to track handoffs in git).

### Assumptions Made

- claude↔gemini's marker_timeout was caused by gemini's own noisy startup
  (`⚠ Skill conflict detected` spam from ~/.agents/skills vs ~/.gemini/skills),
  not the dialogue wrapper. Evidenced by: the SAME setup exited 0 on a prior run,
  and the failure was a clean structured marker_timeout event, sessions self-cleaned.
- minor (not patch) version bump is correct for a new capability.

### Potential Gotchas

- **release.yml `dry_run` defaults to TRUE.** Triggering with only
  `-f version=vX.Y.Z` validates but does NOT create the tag (you'll get a 14-byte
  "Not Found" tarball when you try to download it). You MUST pass
  `-f dry_run=false` to actually cut the release. This bit us once this session.
- **Never `git add -A` here.** There are untracked handoff files in the working
  tree; `-A` would sweep them into release commits. Always stage explicit paths.
- **Public repo: never push main directly.** Branch → PR → merge for everything,
  including version bumps and Formula.
- **Formula validation uses a TEMP tap that must be untapped afterward.** Pattern:
  `brew --repository`/Library/Taps/local/homebrew-<tmpname>, copy formula, audit
  --strict --online + install + test, then uninstall + `brew untap`.
- **Don't tear down a worker/dialogue while a background supervise call against it
  is still in flight** — it causes spurious "missing/can't find pane" errors (a
  self-inflicted race seen this session with a single agy worker). Wait for the
  background completion notification first.
- **codex workers**: always pass a literal result path, never `$TMUX_AGENT_RESULT`
  (codex's sandboxed shell can't expand it). (Carryover lesson, not exercised here.)
- **agy single-worker start-prompt is unreliable** (paste timing): use `send-wait`
  to (re)send. Inside dialogue this is handled automatically via send-wait-literal.

## Environment State

### Tools/Services Used

- git + gh CLI (PRs #278/#279/#280, release workflow dispatch, CI watch)
- GitHub Actions: `ci.yml` (macOS smoke: zsh -n, ci-shellcheck, wrapper self-tests),
  `release.yml` (workflow_dispatch; dry_run default true)
- Homebrew (temp-tap audit/install/test, then untapped)
- tmux (worker/dialogue sessions; all self-cleaned, none left running by this work)

### Active Processes

- None left by this session. All tmux dialogue/worker sessions self-cleaned.
- NOTE: there are many unrelated pre-existing `codex-cli-*` tmux sessions from
  Jun 21 still alive (not created by this session) — left untouched.

### Environment Variables

- `AGENT_TMUX_PROFILE_DIR`, `TMUX_AGENT_TOOLS_SESSION_ENV`, `CC_SWITCH_*` (names
  only; no values). cc-switch.db holds a LIVE ANTHROPIC_AUTH_TOKEN — never expose.

## Related Resources

- PR #278: feat(dialogue) generic participants — https://github.com/ohyeh/tmux-agent-tools/pull/278
- PR #279: release v0.24.0 bump — https://github.com/ohyeh/tmux-agent-tools/pull/279
- PR #280: Formula v0.24.0 — https://github.com/ohyeh/tmux-agent-tools/pull/280
- Release: https://github.com/ohyeh/tmux-agent-tools/releases/tag/v0.24.0
- v0.24.0 tarball sha256: 87dadceb563dc8ae9ce4d3034a0b4880f2ec34ed82bf0b119441a803e7879ff0

---

**Security Reminder**: No secrets in this document. cc-switch.db / ANTHROPIC_AUTH_TOKEN referenced by name only.
