# Handoff: v0.30.0 released — skill payload policy layer + persistent-teammate reuse, full commander-mode cycle with dual adversarial review

## Session Metadata
- Created: 2026-07-04 03:23:28
- Project: /Users/paul.yeh/github/tmux-agent-tools
- Branch: main
- Session duration: ~1 evening (multi-wake session with background worker waits)

### Recent Commits (for context)
  - 76115ec release(formula): bump to v0.30.0 (#313)
  - 815c47a release: v0.30.0 (#312)
  - 22d63ab feat(skill): ship policy layer in skill payload + persistent-teammate reuse policy (#311)
  - 5b71c16 docs: session handoff for v0.29.0 release cycle (#298-#302, full-suite CI)
  - 0d726cb release(formula): bump to v0.29.0 (#310)

## Handoff Chain

- **Continues from**: [2026-07-03-003344-v0290-released-full-suite-ci.md](./2026-07-03-003344-v0290-released-full-suite-ci.md)
  - Previous title: v0.29.0 released — issues #298–#302 fixed via commander-mode workers, full smoke suite wired into CI
- **Supersedes**: None

> Review the previous handoff for full context before filling this one.

## Current State Summary

v0.30.0 is fully shipped: feature PR #311 (squash-merged, CI green), release PR #312 (CHANGELOG → v0.30.0 + three plugin manifests synced), tag `v0.30.0` + GitHub release published, formula bump PR #313 merged with the real tag-tarball sha256. The session's arc: user diagnosed that orchestration inefficiency (idle polling, disposable workers) traced back to the skill payload shipping only *mechanism* (scripts) without *policy* (agent definitions, contracts, troubleshooting). We repackaged the skill to carry the policy layer and codified a persistent-teammate reuse loop. All implementation was done by tmux workers (commander mode); every wave passed dual adversarial review (internal + codex). Working tree clean on main; nothing in flight except possibly the tail of main-branch CI for #313 (was in_progress at handoff time, #312 already green — change is formula-only, minimal risk).

## Codebase Understanding

### Architecture Overview

The repo distributes one canonical skill (`skills/tmux-agent-tools/`) through several channels: `npx skills add` (skill dir as-is), Claude Code plugin (repo root `agents/` registers subagents), Codex (`.codex/skills` symlink + `.codex/agents/*.toml`), and Homebrew (Formula installs `pkgshare` incl. root `schemas/`). The repo's chosen anti-drift pattern is **copies + smoke drift checks** (not symlinks): `scripts/test-agent-delegate-packaging-smoke` now enforces byte-identity across agents (4 copies: `agents/`, `.claude/agents/`, `skills/tmux-agent-tools/agents/`, plus `.codex` TOML by grep), schemas, and wiki↔references doc pairs (46 checks). Version truth lives in CHANGELOG's first `## vX.Y.Z`; `test-version-sync-smoke` forces `.claude-plugin/.codex-plugin/.cursor-plugin` plugin.json to match; `Formula/` intentionally lags (post-release bump PR pattern).

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `skills/tmux-agent-tools/SKILL.md` | skill hub; non-negotiable rules 1–4 | rule 4 (reuse requires `result init`) added this session |
| `skills/tmux-agent-tools/references/multi-agent.md` | multi-worker policy | new "Persistent teammates (worker reuse)" section |
| `skills/tmux-agent-tools/agents/*.md` | packaged delegation policy | NEW — skill now ships tmux-delegate + oneshot forwarders |
| `skills/tmux-agent-tools/schemas/*.json` | offline result validation fallback | NEW — matches script's `${SELF:h:h}/schemas` lookup |
| `scripts/test-agent-delegate-packaging-smoke` | packaging drift guard | extended: skill copies, doc pairs, exit-code table coverage, evals exclusion |
| `skills/tmux-agent-tools/scripts/install-bin` | PATH symlink installer | rewritten as loop over executables; fixed 8 missing wrappers |
| `skills/tmux-agent-tools/references/contracts.md` | result/status/exit-code contracts | CI exit-code table added (all codes incl. reserved 4/5) |

### Key Patterns Discovered

- **Copies + drift-smoke, never symlinks**, for anything that ships through tarball channels (symlinks out of the skill dir break `npx skills add`).
- `result wait-required` treats empty string/array/object as missing → `result init` writes an empty-summary skeleton, which is exactly what makes it a safe reuse reset.
- `send`/`send-wait` never touch `result.json` (verified in code at agent-tmux send paths) — hence the stale-result false-completion trap when reusing workers without reset.
- Wrapper `start` appends a random 6-char suffix unless `--exact` — always use `--exact` for addressable persistent teammates, and never bake the un-suffixed name into worker prompts.
- Release cycle: feature PR → `release: vX.Y.Z` PR (CHANGELOG + 3 manifests) → tag + GH release → separate `release(formula)` PR with tarball sha256.

## Work Completed

### Tasks Finished

- [x] Audited repo md/html vs installed skill payload; classified ship-vs-stay
- [x] Packaged policy layer into skill: `agents/` (3), `schemas/` (2), `skills/tmux-agent-tools/references/troubleshooting.md`, `skills/tmux-agent-tools/references/recipes.md`, CI exit-code table in contracts.md
- [x] Moved dev-only evals out of payload → `skills/tmux-agent-tools-workspace/evals-archive/`
- [x] Extended packaging smoke to 46 checks (drift guards incl. exit-code table coverage)
- [x] Fixed `install-bin` (loop; 8 wrappers were missing: fanout, dag, cron, monitor, notify, replay, history, dashboard)
- [x] Added persistent-teammate reuse policy (multi-agent.md section + SKILL.md rule 4 + 4-way delegate copies)
- [x] Dual adversarial review every wave: internal (brain) + codex workers; codex reproduced the stale-result trap and exercised install-bin in temp dirs
- [x] Shipped v0.30.0: PR #311, #312, #313; tag; GitHub release; local branches deleted; workers stopped

### Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| (all merged to main via #311–#313) | 20 files, +727/−17 in #311; 4 version files in #312; Formula in #313 | see Tasks Finished |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Copies + smoke drift-check for skill-packaged docs | symlinks; single canonical file | symlinks break tarball installs; repo already had this pattern for agents |
| Exit-code table: code-set parity, wording may differ | byte-identical wording | skill copy drops repo issue narration (#116 etc.); smoke guards the code set (the machine-checkable contract), semantics judged by reviewer |
| Keep `skills/tmux-agent-tools/references/security.md` etc. offline in payload | move docs online (agy suggestion) | offline availability is the point of a skill; tens of KB is not a cost |
| Reject backlog/briefs layer in tmux-delegate | firstmate-style state files | delegate is a stateless routing function; state belongs to orchestrator (`task_plan.md`) |
| evals out of payload | keep (skill-creator convention) | dev-only fixtures; installed agents never run them |

## Pending Work

## Immediate Next Steps

1. Verify main CI for #313 finished green: `gh run list --branch main --limit 2` (was in_progress at handoff; #312 already success; formula-only change)
2. Optionally sync `docs/wiki/` → GitHub wiki remote if that's a manual push in this repo (references copies are canonical-equal by smoke)
3. Consider a follow-up: `tmux-delegate` ship/scout task-typing (discussed, deliberately deferred — it's a Decision-Rules *parameter*, ~4 lines, not a new section)

### Blockers/Open Questions

- [ ] None blocking. Open question: should skill install auto-register `agents/*.md` into `~/.claude/agents/` (agy raised; no standard API — currently a documented manual copy)?

### Deferred Items

- ship/scout task typing in tmux-delegate Decision Rules (user paused on scope-creep concern; verdict was "parameter yes, backlog no")
- Auto-registration of packaged agents on skill install (no clean mechanism today)

## Context for Resuming Agent

## Important Context

- **Session thesis (user's own diagnosis, confirmed)**: perceived inefficiencies (idle waits, disposable workers, delegation drift) all traced to the skill shipping mechanism without policy. That's fixed in v0.30.0; if new inefficiency reports come in, first check whether the relevant *policy* actually reached the machine/agent in question.
- **Commander mode is the user's standing preference**: user talks only to the main session; implementation and review go to tmux workers (claude/codex/agy engines via the repo's own wrappers — dogfooding). Reviews must be dual: internal (main session reads diffs personally) + external (codex worker), both adversarial, evidence-grounded.
- **Worker orchestration efficiency rules** (now also codified in the skill): dispatch → immediately background a single `result wait-required --wait N --json`; never foreground-sleep; reuse a named worker (`start --exact`) across sequential waves with `result init` reset; trust disk (result.json) over pane self-reports — a worker this session *claimed* it wrote result.json and had not.
- The user watches worker panes live (tmux windows). They may type into a worker's input box (e.g. an unsubmitted `commit this` appeared this session). Never submit someone else's pending input; surface it.

### Assumptions Made

- Formula-only #313 CI would pass (same suite passed twice on identical scripts this session); not re-verified at handoff.
- GitHub wiki content is synced from `docs/wiki/` by some existing process (not investigated); references copies are guarded against the in-repo wiki dir, not the remote wiki.

### Potential Gotchas

- Wrapper `start` without `--exact` suffixes the name → prompts telling a worker to `result init <name>` must use the *actual* suffixed name (bit us once this session; correction had to be sent).
- agy (Antigravity CLI) shows a folder-trust prompt on start; `send` returns `blocked_reason:permission_prompt` — answer with `send --key enter`, then use `wait-text` on expected output rather than sleeping.
- `agent-tmux list` with no sessions prints full help usage (noisy); prefer `tmux-agent-sessions list --json` for inventory.
- A worker satisfying `wait-required` is not proof of a *useful* result — first agy run filled `summary` with the init success message. Validate content, not just non-emptiness, for free-text results.
- Running `run-all-smokes` twice in one foreground Bash call exceeds the 2-minute tool timeout; background it and read the log.

## Environment State

### Tools/Services Used

- `gh` CLI (PR create/merge, release create), git, repo's own wrappers at `skills/tmux-agent-tools/scripts/` (not on PATH in this shell — invoked by path; `install-bin` now fixes PATH installs)
- Worker engines: `claude` (fm-impl, fm-impl2, fm-fix), `codex` (fm-review, fm-rereview, fm-reviewer), `agy` (fm-roles, fm-roles2)

### Active Processes

- None. All tmux workers stopped; local feature/release branches deleted; one background `gh run list` watcher may have been reaped with the session (harmless).

### Environment Variables

- `TMUX_AGENT_DIR` (default `~/.local/state/tmux-agent-tools`) — worker state/result location; no secrets involved this session

## Related Resources

- PRs: #311 (feature), #312 (release), #313 (formula) — https://github.com/ohyeh/tmux-agent-tools/pulls?q=is%3Apr+311+312+313
- Release: https://github.com/ohyeh/tmux-agent-tools/releases/tag/v0.30.0
- New policy doc: `skills/tmux-agent-tools/references/multi-agent.md` § Persistent teammates (worker reuse)
- Firstmate reference discussed as architecture parallel: https://x.com/kunchenguid/status/2072102019729613181

---

**Security Reminder**: Before finalizing, run `validate_handoff.py` to check for accidental secret exposure.
