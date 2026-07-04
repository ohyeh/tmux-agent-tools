# Changelog

## v0.31.1 - 2026-07-04

### Fixed
- Bumped the three plugin manifests to match the release train so `scripts/test-version-sync-smoke` stays green after the `v0.31.0` workflow bundle release.
- Updated README and wiki first-run docs to prefer the skill-first `send-wait` / wrapper-provided result-path flow instead of steering users toward bare `send` or `$TMUX_AGENT_RESULT` as the primary structured-result path.

## v0.31.0 - 2026-07-04

### Added
- `.claude/workflows/` — 13 saved dynamic-workflow recipes shipped as a team snapshot, `/name`-callable by anyone who clones the repo: drift audits (`docs-vs-code-audit`, `design-vs-code-audit`, `root-cause-deep-dive-audit`), adversarial consensus (`consensus-gate`, `design-consensus`, `feature-plan-consensus`), plan/build pipelines (`plan-pipeline`, `feature-lifecycle-auto`, `spec-implement-dual-review-verify`), `project-direction-review`, the `findings-triage` loop connector (clusters confirmed findings by root cause into mini-PRD briefs / a partitioned-fix list / human intent questions — fail-closed, no finding is ever dropped), and the self-regenerating `workflow-manifest` fleet snapshot; plus shared `_lib/` (fail-closed helpers, findings schema, worker doctrine). Second-model review is neutral throughout: `args.cli` accepts any agent-tmux profile — nothing is hardcoded to codex.
- `skills/using-workflows/` — meta-router skill: routes a described situation to the right recipe via a decision tree with live recipe discovery (never a memorized list), auto-fills args (`cli`/`context`/paths), and chains the closed loop (audit → findings-triage → briefs/direct fixes → re-run the same audit until zero confirmed findings). Optionally co-fires with the `codex-dynamic-workflows` skill (if installed) for `.workflow/<slug>/` run records. Bundles the full recipe set under `workflows/` with `scripts/install.sh` for one-command deployment to `~/.claude/workflows/` or a repo's `.claude/workflows/` (refuses to overwrite files whose content differs unless `--force`).
- `docs/workflow-usage-guide.md` — day-to-day tutorial: 30-second mental model (scheduler / control-flow / executor layers), scenario-to-recipe cheat sheet, zero-install onboarding for new repos, and the feedback loop (wording edits go direct; behavior edits pass `consensus-gate` first).

### Changed
- `codex-consensus-gate` renamed to `consensus-gate` (reviewer = any `args.cli` profile; behavior byte-identical). The old name remains as a deprecated top-level-only forwarding shim. `plan-pipeline` / `feature-plan-consensus` / `spec-implement-dual-review-verify` wording neutralized from codex-specific to second-model-via-`args.cli`.

## v0.30.0 - 2026-07-04

### Added
- Skill payload now ships the delegation policy layer, not just the scripts: `agents/` (tmux-delegate gate + claude/codex one-shot forwarders, installable by copying into `~/.claude/agents/`), `schemas/` (offline `result.json`/fanout validation fallback already resolved by the scripts), `references/troubleshooting.md` and `references/recipes.md` (packaged copies of the wiki pages), and a CI-mode exit-code table in `references/contracts.md`.
- Persistent-teammate worker-reuse policy: new `references/multi-agent.md` section documenting when to reuse one named worker across sequential same-repo tasks vs start fresh, the `result init -> send-wait -> result wait-required` reuse loop, and the stale-`result.json` false-completion trap; mirrored as SKILL.md non-negotiable rule 4 and a Decision Rules line in all four tmux-delegate copies.

### Changed
- `install-bin` links every executable wrapper in `scripts/` via a loop instead of a hand-maintained list, fixing 8 missing symlinks (fanout, dag, cron, monitor, notify, replay, history, dashboard).
- Dev-only eval fixtures moved out of the installable skill payload to `skills/tmux-agent-tools-workspace/evals-archive/`.
- `test-agent-delegate-packaging-smoke` extended: skill-packaged agent/schema/doc copies drift-checked against repo canonicals, CI exit-code table coverage guarded, and evals excluded from the payload (46 checks).

## v0.29.0 - 2026-07-02

### Added
- `<NS>_TMUX_EXTRA_LAUNCH_FLAGS` / `AGENT_TMUX_EXTRA_LAUNCH_FLAGS` append to the effective launch flags (existing `*_LAUNCH_FLAGS` stays full-replacement), and `start --effort <v>` expands a new profile `effort_flags` template with the shell-quoted value (`codex.conf` ships `-c model_reasoning_effort=%s`; profiles without the key reject `--effort` with exit 2). Both surface in `start --dry-run` JSON. Launch-flag env vars are documented as operator-controlled raw shell fragments, not a sanitized argv API (#302).

### Changed
- CI now runs the full smoke suite on every push/PR via new `scripts/run-all-smokes` (per-test 180s timeout, one retry with visible `FLAKY-PASS`/`TIMEOUT` classification, summary table, non-zero exit on residual failure), with `scripts/lint-no-path-tied-locals` as an early step; job timeout raised 10→30 minutes and coreutils added to the runner.
- Skill docs hardened with this round's observed operational traps: the flag-order rule (flags precede positionals), `tmux ls` replaced with `tmux-agent-sessions list`, a cheatsheet triage row, and the commander shrinking-fleet watch loop including the check-`result --json .present`-before-re-arming-`watch --any` nuance (#301).
- writing-great-skills pass over the skill docs: repointed three stale `using-tmux-agent-tools` references that still aimed at SKILL.md's removed "Script capability table" section (the table moved to `references/cheatsheets.md` → "Full script capability table" in v0.28.0), and deduplicated `tmux-agent-tools/SKILL.md` so each rule lives in one place (engine-only ban, PATH fallback, send-wait nonce mechanism, no-polling rule — previously each stated twice). Net −1 line; CI skill-metadata validation still passes and the body stays under the 8KB gate.

### Fixed
- Six #300 hardening fixes to the engine and helper scripts: renamed zsh tied-special locals (`status`, `path`) flagged by `scripts/lint-no-path-tied-locals` — including a runtime-broken `status=` assignment in `tmux-agent-sessions`; `capture_session` no longer reads the undefined `$lines` tied special (renamed to `tail_count`); `send_lock_around`'s mkdir lock fallback is bounded (returns 75 on an unwritable state dir instead of looping forever); `TMUX_AGENT_TOOLS_SESSION_ENV` bare keys deterministically resolve the caller's value and clear-disabled mode (`*_TMUX_CLEAR_*_ENV=0`) explicitly passes provider env through; transcript send events record the caller's text (before task-scope/result-path prepends) via `transcript_emit_send_event`, and liveness/transcript wait-text calls pass `--regex` for regex patterns (#300).
- The task-scope guard preamble is injected once per session (sidecar marker with the #283 semantics: marked inside the send lock right after paste; a wait-timeout still counts as delivered; lock timeout/paste failure/blocked refusal do not mark) instead of on every prompt-bearing send. Fixes the pane-freeze -> false `--max-idle` kill chain against workers that do not consume stdin, and stops re-spending ~330 bytes per follow-up send (#298).
- `start`/`resume`/`start-ssh` and the send family now reject flag-looking tokens that land in positional slots with `unknown or misplaced flag: <tok> (flags must precede positionals; see usage)` and exit 2, instead of silently consuming them as `<name>`/`<directory>` and failing with a misleading `Directory not found: --flag` (#299).
- `codex-oneshot`, `claude-oneshot`, and `tmux-delegate` agents no longer assume `agent-tmux`/`claude-tmux`/`codex-tmux` are on PATH. Wrappers are now resolved from a skill bundle first — probing `<repo-dir>/skills`, `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` in order — with PATH lookup as last-resort fallback, so `npx skills add`-style installs work without `install-bin`/Homebrew. `.claude/agents/*.md` and `.codex/agents/*.toml` mirrors regenerated in sync. Verified end-to-end with a clean PATH: template execution against a real codex worker, plus a haiku-model forwarder run against a real claude worker.

## v0.28.0 - 2026-07-02

### Added
- Added `agents/codex-oneshot.md` and `agents/claude-oneshot.md` as thin one-shot forwarder agents, with matching `.claude/agents/` mirrors for Claude Code discovery (#293).
- Added `mcp-adapter/`, a Node.js `codex-tmux-agent-adapter` MCP server exposing `spawn_tmux_agent`, `send_tmux_agent`, `wait_tmux_agent`, `read_tmux_agent`, and `close_tmux_agent` as an optional programmatic integration path. The primary integration remains native agent/skill discovery through `SKILL.md` and host-local conventions (#293).
- Added Codex-native discovery mirrors: `.codex/agents/*.toml` custom-agent definitions converted from `agents/*.md`, plus a `.codex/skills/tmux-agent-tools` symlink to the canonical skill, so Codex can discover the same local content Claude Code reaches through `agents/` and `.claude/agents/` without MCP registration (#293).

### Changed
- Slimmed `skills/tmux-agent-tools/SKILL.md` from roughly 36KB to under 8KB by moving the full workflow and profile detail into `references/core-workflow.md` and `references/profiles.md`, keeping first-open guidance focused while preserving the deeper reference material (#293).
- Hardened `agent-tmux` against live-worker friction: boot-time trust gates now surface structured `blocked` / `blocked_reason` status instead of hanging, worker prompts get a default task-scope project-config guard with `--allow-project-config` as the opt-out, nonce wait timeouts accept fresh authoritative `result.json` completion, and `send --key enter|up|down` provides explicit key delivery (#293).

### Fixed
- Fixed Codex login-prompt false positives in the boot trust gate by anchoring blocking checks to the pane's current prompt area instead of scanning unrelated scrollback, avoiding matches from old MCP login banners or commit-message text that merely mentioned login prompts (#293).

## v0.27.0 - 2026-06-25

### Added
- File/stdin prompt input for `start`, `start-ssh`, `send`, `send-wait`, `send-wait-literal` (#289): `--from-file <abs>` and its alias `--prompt-file <abs>` (aligns with `tmux-agent-fanout`/`tmux-agent-dialogue` naming), plus `-` to read the prompt from stdin. The file/stdin body becomes the prompt verbatim, so large multi-line packets with shell-special characters (`&`, quotes, `$`, backticks), URLs/deeplinks, and non-ASCII no longer need inline shell-quoting. Flags are position-independent (a shared prepass extracts them from anywhere in the argv), so the documented shapes `start --exact N DIR --prompt-file P` and `send-wait N --prompt-file P <timeout>` work. Verified across two rounds of adversarial codex review (which caught that the first cut only accepted the flag before the positionals).
- `agy` is now a first-class tool in `tmux-agent-sessions` (#290): `--tool agy` is accepted by `list`/`watch`/`cleanup`/`resolve`, the `agy-cli-` prefix is recognized, and all usage/error strings enumerate `claude|codex|agy|dialogue`. This makes `tmux-agent-sessions` a genuine engine-neutral supervision surface for mixed codex+agy+claude fleets.

### Changed
- Documented engine-agnostic name resolution semantics for `watch`/`result`/`status` (#290): result paths resolve by bare session name (`$TMUX_AGENT_DIR/<name>/result.json`, fully engine-independent, so result-based `watch` triggers — `reason:result_updated` — are cross-engine), while `status`/`watch` tmux liveness checks are prefix-tied (a still-running foreign-engine session can read as a false `exited`). For mixed fleets, rely on result-based completion and/or `tmux-agent-sessions`. Added a mixed-fleet example to SKILL.md and references/cheatsheets.md.
- When the wrappers/CLIs are not on `PATH`, the not-found diagnostic now points at `install-bin` (or adding the bundle `scripts/` dir to PATH), saving a discovery step (#290).

## v0.26.1 - 2026-06-24

### Changed

- Unified the version carriers (#286). The three plugin manifests (`.claude-plugin`, `.codex-plugin`, `.cursor-plugin` `plugin.json`) had drifted to `0.24.0`/`0.20.0` while releases were at `v0.26.0`; all three are now bumped in lockstep with the release. A new `scripts/test-version-sync-smoke` guard (wired into CI and the release validation) fails the build if any plugin manifest version diverges from the latest `CHANGELOG.md` `## vX.Y.Z`, so this drift cannot silently recur. The Homebrew formula is intentionally excluded from the guard since it is bumped in a separate post-release PR and lags the tag by design.

## v0.26.0 - 2026-06-24

### Fixed

- Result-path injection is now **once per session** instead of on every send (#283). For `result_path_via_prompt=true` CLIs (codex and generic), the `Write final JSON to this exact path: …` instruction was prepended to *every* `send`/`send-wait`, corrupting follow-up prompts and making it impossible to answer a TUI prompt with a single keystroke. The instruction is now injected only on the first prompt-bearing `start`/`send`, tracked by a per-session sentinel written **inside the send lock right after the prompt reaches the pane** — so a wait-timeout still counts as delivered (the next send won't re-inject), while a lock-acquisition timeout or paste failure correctly does not mark. Verified across two rounds of adversarial codex review, which caught a `set -e` control-flow bug in the first cut (caller-side marking was skipped on a non-zero wait return).

### Added

- `send --raw <name> <keys>` delivers literal keystrokes with no result-path/nonce prefix and no trailing Enter (unless `--enter-count N>0`), under the same send lock and wrapper session resolution (#283). Use it to answer a TUI prompt with a single key, e.g. `send --raw <name> t` for a hook-trust prompt.
- `status --json` now surfaces plugin hook-trust prompts: a new `hook_trust_prompt` `blocked_reason` (with `confirmation_detected:true` and a diagnostic) fires on pane text like "N hooks need review … Press t to trust", using hook/trust-anchored patterns that do not false-trigger on ordinary "needs review" prose (#283).
- `start --model <model>` pins a worker's model for that run, passed through to the CLI as `--model <model>` (shell-quoted, shown in `--dry-run`, not validated per-CLI since env vars like `ANTHROPIC_MODEL` are unreliable). For a durable per-CLI default, set `launch_flags` in the profile (#283).
- The `tmux-delegate` subagent now ships at the plugin root `agents/tmux-delegate.md` so it is registered for installed-plugin users (previously only `.claude/agents/` existed, which only works in a checked-out repo). A smoke test keeps the two copies byte-for-byte in sync (#283).

## v0.25.0 - 2026-06-24

### Changed

- Hardened the tmux-agent skill guidance against two recurring failure modes: agents bypassing the engine with raw `tmux`, and prompts that look sent but never submit. `skills/tmux-agent-tools/SKILL.md`, `skills/using-tmux-agent-tools/SKILL.md`, and the `tmux-delegate` agent now carry three non-negotiable rules. (1) Engine-only: drive workers exclusively through `agent-tmux <cli>` subcommands — never raw `tmux send-keys`/`capture-pane`/`new-session`/`kill-session`. (2) Prefer the managed/Agent path over ad-hoc shell, dropping to shell only for genuine gaps. (3) A `send` is not confirmed until verified — default to `send-wait` (fresh nonce), treat a timeout as *unconfirmed* (check `status --json` + `probe --metric` for the busy signal, since `status`/`ping` expose none; resend only if idle), and raise `<NS>_TMUX_SUBMIT_DELAY` for slow TUIs. Also clarified the cascade-spawn ban covers further tmux/engine workers, not Claude Code's separate in-process `Agent`-tool nesting. Verified across 11 rounds of adversarial codex review against the agent-tmux implementation.

## v0.24.0 - 2026-06-22

### Changed

- `tmux-agent-dialogue` now supports **any** CLI agent-tmux can drive as a real participant (claude, codex, agy, gemini, cursor, grok, in-house CLIs, …), not just claude/codex. Real participants are driven directly through the engine as `agent-tmux <cli>` (the claude-tmux/codex-tmux/agy-tmux shims are themselves only `exec agent-tmux <cli>`), so a new CLI works with zero per-CLI code — no shim required — matching how the rest of the suite generalized. `--agent-a/--agent-b` accept any non-flag CLI name (unknown CLIs get generic defaults and fail clearly at launch if their binary is missing); `fake` is unchanged. The transcript schema's `.agent` field relaxed from the `codex|claude|fake` enum to any non-empty string (backward compatible). Enables e.g. claude↔agy or claude↔gemini pair-review/critic/debate/handoff.

## v0.23.0 - 2026-06-22

### Added

- Added a second skill, `using-tmux-agent-tools`: an on-demand meta-router (modeled on the using-superpowers pattern) that routes a tmux-agent task to the right wrapper via a task-shape → wrapper decision tree, then defers to the canonical capability table in `tmux-agent-tools/SKILL.md` (single source of truth, no duplication). Covers all 17 wrappers plus the inline-vs-worker delegate gate, and encodes the router-level gates (multi-agent authorization, cascade-spawn ban). Auto-discovered via the existing `skills/` plugin scan (#274, #275).

## v0.22.0 - 2026-06-22

### Added

- Added `scripts/profiles/profile.conf.example`: a canonical generic profile template documenting every supported profile key (bin/env_ns/launch_flags/heuristic_family/pattern_*/session_id_pattern/session_id_capture/exec_mode/prompt_via/prompt_flag) with inline guidance. New CLIs now start from one template instead of copy-pasting a CLI-specific example (#270).
- `.gitignore` now blocks `scripts/profiles/*.conf` (personal/local profiles live in `~/.config` and must never ship in the repo) while whitelisting `*.conf.example` templates. Already-tracked bundled defaults (agy/claude/codex/cursor/grok.conf) are unaffected — gitignore does not untrack committed files (#270).

### Changed

- `scripts/profiles/README.md` points users to `profile.conf.example` as the single entry point and removed the redundant inline gemini example.

### Fixed

- `agy`, `cursor`, and `grok` bundled profiles (and the engine preset fallback) switched `heuristic_family` from `codex` to `generic`. The codex family's provider-inheritance gate (`cli_provider_env_keys`) was injecting the full `OPENAI_*`/`CODEX_*` credential set into these CLIs' tmux panes, which is wrong for them (notably agy, which is Anthropic-backed). Generic inherits zero provider keys; each CLI must receive credentials via its own env/cc-switch injection. Pane detection is unchanged because codex and generic share the same `probe_generic_metric_parse` path (#271).

### Removed

- Removed `scripts/profiles/gemini.conf.example`; the generic template supersedes it (#271).

## v0.21.0 - 2026-06-21

### Added

- Added `exec_mode=oneshot` (#268): run any CLI headless once in-pane via one argv path — flag form (`prompt_flag=-p` → `cli -p "<prompt>"`) and subcommand form (`launch_flags=exec`, empty prompt_flag → `cli exec "<prompt>"`). The prompt is passed as a single shell-quoted argv, `result.json` is synthesized, marker `__AGENT_TMUX_ONESHOT_EXIT__<code>` is printed, the pane stays open, and `status --json` reports `exit_detected` / `exit_code`. New profile keys: `exec_mode`, `prompt_via`, and `prompt_flag` (default `interactive` / `paste` / empty). Closes #268.
- Added `session_id_capture=off|supplied|transcript` (v3): Claude supplies a race-free `--session-id` written to the sidecar before launch; Codex and Agy correlate a CLI-owned transcript/store after launch (null-on-ambiguity with one observable signal). A mutual-exclusion single writer protects the sidecar. Bundled profiles remain default-off until per-CLI L-phase enablement.

### Changed

- CI now runs `test-session-meta-smoke` and `test-oneshot-smoke`. Added `scripts/test-oneshot-smoke` (28 checks); `test-session-meta-smoke` expanded 27→58 checks for Codex/Agy correlation plus decoy and ambiguity fixtures.

## v0.20.0 - 2026-06-20

### Added

- Added opt-in v2 session resume: `agent-tmux <cli> resume` can reattach to a prior CLI session via a `cli_session_id` captured into a per-session `session-meta.json` sidecar. Capture is label-anchored then RFC-4122-validated; decoy UUIDs on non-matching lines are ignored.
- Added `scripts/test-session-meta-smoke` (27 checks): null init, UUID validation, blank-pattern no-op, sidecar field reads, invalid-UUID rejection, and label-anchored decoy handling.

### Changed

- `result --field .cli_session_id` now reads the `session-meta.json` sidecar independently of `result.json`, so the post-start / pre-final-result resume window works without an initialized result file.
- `tmux-delegate` subagent and SKILL.md document the v2 resume capability and its default-off guardrail.

### Security

- Bundled `claude.conf` / `codex.conf` ship `session_id_pattern` UNSET — resume is unsupported by default; operators opt in per-CLI with a label-anchored ERE. The session UUID is treated as a non-shareable resume capability (never logged, never synthesized).

## v0.19.0 - 2026-06-19

### Added

- Added the Claude Code `tmux-delegate` subagent for deciding inline vs supervised tmux-worker execution.
- Added `agent-tmux <cli> doctor --json` with independent named checks for tmux, agent CLI binary, git, and git worktree support.
- Added `agent-tmux <cli> setup` as a combined JSON preflight for `doctor --json` plus `self-test`.
- Added delegation-path eval coverage for trigger decisions and exact-call planning.
- Added `scripts/test-supervision-stress-smoke`: adversarial supervision coverage (missing/stale marker, no/malformed result.json, unresponsive stall) across three presets — codex, claude, and agy.

### Changed

- Tightened SKILL.md + references supervision guidance so an agent never idle-waits or hangs: structured `status`/`result`/`watch` first with pane capture as diagnostic fallback only, mandatory timeouts on every blocking wait (no bare `wait`, shell `sleep`, or status-polling loops), `watch --any|--all` for multi-worker, `status --json` + `ping` for liveness, and an explicit bounded fallback when a worker stalls.

### Fixed

- `result wait-required` now reports every requested field in `missing_fields` when `result.json` is absent or malformed (previously returned an empty list), so a non-compliant worker can no longer be misclassified as complete.

## v0.18.1 - 2026-06-11

### Changed

- Removed internal planning/design docs and task_plan.md from the public repo; no functional changes.

## v0.18.0 - 2026-06-10

### Changed

- SKILL.md: new "Fast paths" decision block at the top (bundle-path
  resolution when wrappers are off PATH; resolve → status → result
  supervision quick path; `watch --any|--all` instead of hand-rolled
  polling loops; profile + doctor proof for new/renamed CLIs), and the
  frontmatter description now includes natural-language triggers
  (result.json, watch --any, "which worker finished first",
  "wait for any of these agents"). Driven by a two-iteration
  with-skill/without-skill benchmark: the without-skill baseline
  repeatedly hand-rolled polling loops and omitted orchestration
  guardrails (cascade-spawn ban, literal result paths); iteration-2
  pass rate was 100% with skill vs 68.8% without.

## v0.17.0 - 2026-06-10

### Changed

- Profiles are now the canonical per-CLI configuration. The bundled
  `scripts/profiles/` directory ships default profiles for
  claude/codex/agy/cursor/grok that exactly mirror the legacy in-script
  preset table; `preset_for_cli()` is frozen as a fallback for when the
  profiles directory is missing. New CLIs are added as `.conf` files, not
  code. Equivalence verified: `doctor` output is identical between the
  legacy table and the bundled profiles for all five CLIs.

### Added

- Use-time profile selection flags, recognized between `<cli>` and
  `<command>`: `--profile-dir <dir>` (look up `<cli>.conf` in a
  user-managed directory; highest-priority search location) and
  `--profile <file>` (load an exact file, bypassing the search). They
  compose with the existing leading `--audit-log` flag in either order.

## v0.16.0 - 2026-06-10

### Added

- Declarative CLI profiles: `agent-tmux <cli>` now loads `<cli>.conf` from
  `$AGENT_TMUX_PROFILE_DIR` > `~/.config/agent-tmux/profiles` > the bundled
  `scripts/profiles/` directory. Plain `key=value` files (never sourced) can
  override `bin`, `env_ns`, `prefix`, `launch_flags`, `resume_keyword`,
  `heuristic_family`, `usage_kind`, and detection regexes (`pattern_busy`,
  `pattern_permission_prompt`, `pattern_approval_prompt`,
  `pattern_login_prompt`). Precedence stays env vars > profile > built-in
  preset. `doctor` reports the loaded profile path. Adding a new CLI or
  renaming a binary per machine no longer requires code changes.
- `agent-tmux <cli> watch [--any|--all] [--timeout <s>] [--interval <s>]
  [--json] <name...>`: one blocking call that supervises N workers. A worker
  counts as done when it (re)writes `result.json` after the watch started
  (mtime + content checksum signature, so same-second rewrites are caught) or
  its tmux session exits. Exit 0 when the condition is met, 1 on timeout,
  2 on invalid input.
- `scripts/profiles/README.md` and `gemini.conf.example`; SKILL.md rewritten
  around the unified `agent-tmux` engine and the profile mechanism.

## v0.15.0 - 2026-06-04

### Added

- Plugin-form distribution. The repository now ships CLI plugin manifests, all
  pointing at the same `./skills/` directory (no duplicated content):
  - `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` — installable
    via `/plugin marketplace add ohyeh/tmux-agent-tools` then
    `/plugin install tmux-agent-tools@tmux-agent-tools` in Claude Code.
  - `.codex-plugin/plugin.json` — skills-only manifest for Codex CLI.
  - `.cursor-plugin/plugin.json` — skills-only manifest for Cursor.
  No MCP server or hooks are declared: this project is a skill + shell wrappers,
  so the manifests intentionally expose only the shared skill.

## v0.14.0 - 2026-06-04

### Added

- `agent-tmux <cli> <command>` unified entrypoint: a single engine where the CLI
  identity (`claude`, `codex`, `agy`, `cursor`, `grok`, or any custom binary) is a
  hardcoded preset (binary, env namespace, launch flags, resume syntax, session
  prefix, status `tool` field, pane-scraping heuristic family, provider-env keys).
  `claude-tmux`, `codex-tmux`, and `agy-tmux` are now 1-line shims that delegate to
  it; all existing commands, flags, and env vars behave identically.
- `agent-tmux pair <cli> <team> <dir> [--workers N] [--worker-cli <cli>] [--role lead]`:
  idempotent multi-agent worker bootstrap (resume-if-alive / start-if-gone),
  conservative scale-down (surplus workers are warned `orphan`, never auto-stopped,
  and retained in team state), per-team `mkdir` lock with stale reclaim, and atomic
  team-state writes.
- `agent-tmux team list|workers|lead|stop|rm|broadcast|send|wait|results`: team
  lifecycle plus collaboration primitives over a `teams/<team>.json` state file.
  Mixed-CLI teams are first-class — every per-member operation re-invokes the engine
  with that member's own CLI. `team wait` exits `0` idle / `7` blocked / `8` timeout;
  `team results` branches on `.present`/`.valid` and reports missing results.
- `--role <value>` flag on `start`/`resume` (free-form sugar for `--tag role=<value>`).
- `AGENT_TMUX_*` universal env-override namespace; CLI-specific `<CLI>_TMUX_*`
  variables still take precedence.

### Changed

- Per-CLI `TMUX_CONF` default path is now `${TMPDIR:-/tmp}/agent-tmux-<cli>.tmux.conf`
  (scoped per CLI; `*_TMUX_CONF` overrides are still honored).

## v0.13.0 - 2026-06-01

### Breaking

- BREAKING: `claude-tmux wait-text` and `codex-tmux wait-text` are now
  literal-by-default; pass `--regex` to opt into zsh extended-regex matching.

### Added

- Added `claude-tmux send-wait` and `codex-tmux send-wait`, which append a
  fresh `MARK-<hex>` nonce instruction to each send and wait for that nonce on
  its own line (#223).
- Result contract: optional `verdict` (`ACCEPT|BLOCK|ACCEPT_WITH_CHANGES`,
  `blockers`, `marker`) and `decision` (`decision_by`, `delegate_name`,
  `authority`, `scope`, `decision`, `evidence`, `limits`) blocks in
  `result.json`, plus `result init`, `result validate`, `result wait-required`,
  and `result --path` on both wrappers (#218, #224, #220). The default schema
  path now resolves in both repo and Homebrew layouts; `schemas/` ships in the
  formula.
- `tmux-agent-sessions resolve --name <partial|full> --json` to map any name to
  its owning wrapper and safe next commands, plus `diff --since`,
  `list/cleanup --created-after`, `--cwd`, and `--force` (cleanup refuses dirty
  managed worktrees without `--force`) for accidental-session recovery (#216,
  #222).
- New `tmux-agent-monitor`: polls a manifest of read-only commands on a cadence,
  emits JSONL observations, stops on changed output/exit-code or `--until`, and
  never sends prompts (#219).
- `wait-and-capture --wait-for-human` heartbeat mode: holds without treating
  idle/timeout as completion, returns only on the marker or cancel, and
  maintains `awaiting-next-round.json` (#225).

### Documentation

- SKILL.md: capability table for all 14 scripts, "listen before send"
  supervision recipe, and a peer-review loop recipe; `cheatsheets.md` gains a
  marker-pitfalls section (stale-pane vs prompt-echo). Documented that agent
  CLIs run tool commands in a sandboxed env where `$TMUX_AGENT_RESULT` is empty,
  so orchestrators must pass the literal path from `result --path` (#226, #217,
  #228, #221).

## v0.12.2 - 2026-05-25

`v0.12.2` is a tmux color-environment patch release for managed Claude and
Codex panes.

### Fixed

- `claude-tmux` and `codex-tmux` now normalize color-related environment
  variables immediately before launching the CLI process. When color
  normalization is enabled, managed panes unset leaked caller `NO_COLOR` instead
  of passing `NO_COLOR=`, then set `COLORTERM=truecolor`, `FORCE_COLOR=3`, and
  `CLICOLOR_FORCE=1`. Explicit `TMUX_AGENT_TOOLS_SESSION_ENV` entries still win,
  including deliberate `NO_COLOR` overrides.

- Local `start`, local `resume`, and `start-ssh` now share the same color policy
  instead of hardcoding SSH-only behavior. Setting `CLAUDE_TMUX_COLOR_ENV=0` or
  `CODEX_TMUX_COLOR_ENV=0` disables the wrapper color normalization for both
  local and SSH launches.

- Removed a stale `--workdir-fresh` branch from the SSH launch path that could
  trip `set -u` before creating remote sessions.

### Validation

- Added `scripts/test-color-env-smoke` and wired it into CI. The smoke covers
  default `NO_COLOR` removal, truecolor/force-color defaults, explicit
  environment overrides, and disabled color normalization for SSH command
  generation across both wrappers.

## v0.12.1 - 2026-05-25

`v0.12.1` is a provider-environment isolation patch release for managed tmux
workers.

### Fixed

- `claude-tmux` now clears known Claude provider environment variables by
  default when starting or resuming a managed tmux session, including
  `ANTHROPIC_*` model/base/token settings and `API_TIMEOUT_MS`. This prevents
  stale shell or tmux server environment values from forcing Claude Code onto
  the wrong provider or transport path. Explicit inheritance remains available
  with `CLAUDE_TMUX_INHERIT_CLAUDE_ENV=1`, and explicit
  `TMUX_AGENT_TOOLS_SESSION_ENV` entries still win.

- `codex-tmux` now applies the same default isolation for Codex/OpenAI provider
  variables, including `OPENAI_*`, `CODEX_*`, and `API_TIMEOUT_MS`, with
  opt-in inheritance through `CODEX_TMUX_INHERIT_CODEX_ENV=1`.

### Added

- `claude-tmux env-doctor [name]` and `codex-tmux env-doctor [name]` compare
  caller environment, tmux global environment, and the running CLI child process
  environment with token/key redaction. This makes tmux-side provider pollution
  visible before operators chase shell startup files, app switchers, or CLI
  login state.

### Validation

- Added `scripts/test-claude-env-inherit-smoke` coverage for default provider
  env clearing, explicit opt-in inheritance, explicit `TMUX_AGENT_TOOLS_SESSION_ENV`
  precedence, and bare-key session env preservation.

## v0.12.0 - 2026-05-23

`v0.12.0` is the skill-disclosure and wrapper followup release. It keeps the
existing wrapper contracts backward-compatible while making the skill easier for
agents to load progressively and closing the two post-v0.11 operator gaps:
first-class multi-line send injection (#202) and CLI-aware progress probes
(#203).

### Added

- `claude-tmux send --from-file <abs-path>` and `codex-tmux send --from-file
  <abs-path>` for first-class multi-line / paste injection (#202). The new path
  uses the existing per-agent send-lock, supports `--enter-count N` and
  `--enter-delay S`, records transcript metadata (`multiline`, `bytes`,
  `text_sha256`), and writes a body-free `send.multiline` audit event with size
  and hash metadata. `scripts/test-send-multiline-smoke`: 22 sub-assertions
  across both wrappers, including embedded newlines, payloads larger than 16 KB,
  `--enter-count 3`, and concurrent multi-line + single-line sends under one
  agent name.

- `claude-tmux probe --metric <metric> [--json] <name>` and `codex-tmux probe
  --metric <metric> [--json] <name>` for CLI-aware progress parsing (#203).
  Claude metrics: `context_percent`, `goal_active`, `active_spinner`. Codex
  metrics: `progress`, `tool_active`, `approval_pending`. JSON output carries
  `schema_version: 1`, `name`, `metric`, `value`, `confidence`, and
  `parsed_from`, so downstream watchdogs can depend on one wrapper-local parser
  instead of each consumer shipping its own pane regex. `scripts/test-probe-smoke`:
  10 sub-assertions covering valid metrics, unknown metric exit 2, missing
  session exit 1, and JSON schema fields.

- `skills/tmux-agent-tools/SKILL.md` now uses progressive disclosure: the top
  file is the compact entrypoint, while detailed operator guidance lives under
  `skills/tmux-agent-tools/references/`. New eval manifests under
  `skills/tmux-agent-tools/evals/` cover trigger behavior, multi-agent
  coordination, and safety-boundary expectations for skill consumers.

### Notes

- The new `probe` command complements `ping`: `ping` answers whether a pane is
  responsive; `probe` extracts CLI-specific progress signals from the pane tail
  with an explicit confidence field.
- The new `send --from-file` path does not change existing `send <name> <text>`
  behavior. Existing single-line and inline multi-line callers continue to work.

## v0.11.0 - 2026-05-21

`v0.11.0` upgrades the L5/L6 surfaces from argv-smoke proofs to real runtime contracts. Closes 6 issues (#184–#189) re-opened against the v0.10.0 audit, plus a re-verified fix on #189 (PR #198) that hoists secret-backend preflight to parse-time. Adds two new operator binaries (`tmux-agent-audit`, `tmux-agent-worktrees`). All v0.10.0 callers continue working — every change preserves back-compat.

Total new smoke coverage: ~140 sub-assertions added across this release (fanout 33, approval-gate 20, DAG 32, worktree 18, audit-query 11, audit-rotation 12, audit-tamper 16, secret-uri 26 with 2 timing-bounded). All carry `schema_version: 1` on every JSON surface.

### Added

- L5 fanout runtime controls (#184 / PR #191). `tmux-agent-fanout run` is the canonical entrypoint; bare invocation prints help and forwards to `run` only for the legacy `--workdir`+`--prompt-file` shape (back-compat preserved). New flags: `--agent tool:name` (repeatable, mixes `claude:` and `codex:` in one call), `--result-dir <path>` (default `${XDG_STATE_HOME}/tmux-agent-tools/fanout/<run-id>/`, printed to stderr at start so callers can discover it), `--merge-mode {all|first-success}` (default `all`), `--summary-out PATH`. Consolidated JSON to stdout with per-agent status, result path, error, and final `ok`. Schema: `schemas/fanout-summary.schema.json`. Failure isolation: each child's `result.json` is preserved on disk even when siblings fail or time out — `--merge-mode first-success` does **not** kill remaining children. Wrapper exec failures now synthesize a `status:"error"` `result.json` immediately so the parent fails fast instead of hanging on the wait loop (previously, missing wrapper binaries caused a ~10-minute timeout). `scripts/test-fanout-run-smoke`: 33 sub-assertions covering 4 acceptance cases + legacy back-compat + schema-shape + exec-fail timing bound. Design doc: `docs/design-issue-184-fanout.md`. Daemon / async / supervisor-tree / cross-agent cancellation remain explicit deferrals.

- L5 approval gate runtime (#185 / PR #195). `wait-and-capture --pause-until-file <path>` is now a documented runtime contract, not just an argv smoke. While `<path>` is missing or empty, the wrapper blocks (1s poll). Decision file content: leading `approve` (case-insensitive) → resume + exit 0; leading `reject` → exit 7; other non-empty content → reject with diagnostic. `--pause-timeout <seconds>` triggers exit 8 on deterministic fail. While blocked, `$TMUX_AGENT_DIR/<name>/approval-status.json` reports `state: "awaiting_approval"` with the marker path; on resume it is replaced with the final state. Transcript records an `approval` event (`kind`, `decision`, `marker_path`, `decided_at`). Audit log (when enabled) emits `approval.approve`/`approval.reject`/`approval.timeout`. Existing callers without `--pause-until-file` are unaffected. Exit codes 7 and 8 are documented in `docs/ci-mode-exit-codes.md`. `scripts/test-approval-gate-smoke`: 20 sub-assertions covering all three decision paths plus `awaiting_approval` status visibility on both wrappers. Design doc: `docs/design-issue-185-approval-gate.md`. Webhook / exec handlers remain deferred.

- L5 DAG validation + topological execution (#186 / PR #190). `tmux-agent-dag <manifest.json>` now performs full graph validation before launching any task. Fails fast (exit non-zero) on missing dependency, duplicate task name, self-dependency, cycle (Kahn-based detection), and duplicate dependency within one task. Executes in computed topological order regardless of manifest order. Manifest schema (`schema_version: 1`) supports `fail_fast: true` (default; downstream tasks `skipped` on failure) and `fail_fast: false` (independent branches continue; only the dependent subtree skipped). Task names with spaces and special characters are supported via US (0x1f) / RS (0x1e) delimited dep storage — the v0.10.0 space-joined storage broke task names with whitespace and double-counted duplicate deps in in-degree computation. Final JSON summary on stdout + `--summary-out PATH`: `ordered_tasks`, `results[{name,status,result_path,error}]`, overall `ok`. `scripts/test-dag-validation-smoke`: 32 sub-assertions covering all 7 acceptance cases plus task-name-with-space, duplicate-dep rejection, and special-char names. Design doc: `docs/design-issue-186-dag-manifest.md`. YAML manifest, parallel execution, full `when:` expression engine remain explicit deferrals.

- L6 managed worktree lifecycle (#187 / PR #194). `--workdir-fresh` now uses managed naming `tmux-agent/<sanitized-agent>-<uuid8>` with worktree dirs under `${XDG_STATE_HOME:-$HOME/.local/state}/tmux-agent-tools/worktrees/`. Per-worktree metadata at `.tmux-agent-worktree/meta.json` (schema_version 1) records `source_repo`, `base_ref`, `agent_name`, `tool`, `created_at`, `path`, `branch`, `cleanup_policy` (`no-change-cleanup` default / `has-change-keep` / `always-keep`; override via `TMUX_AGENT_WORKTREE_POLICY`). The wrapper also writes a sibling `worktree.json` under `$TMUX_AGENT_DIR/<name>/` as a machine-readable surface and prints `fresh worktree: <path>` to stderr. New `tmux-agent-worktrees` binary with `list [--json]` and `prune [--dry-run] [--force]` subcommands; `prune` applies the cleanup policies and removes worktrees whose tmux session is dead. `doctor` gains `git` + `git worktree` capability checks. Legacy `fresh-worktree` marker remains for back-compat. `scripts/test-worktree-lifecycle-smoke`: 18 sub-assertions including a `$PATH`-survives regression check. Auto merge-back remains explicit deferral.

- L6 audit operator surface (#188 / PR #193). New `tmux-agent-audit` binary exposes `verify [--log PATH]`, `query [--since ISO] [--until ISO] [--tenant T] [--agent A] [--tool T] [--event E] [--log PATH]`, `rotate [--log PATH] [--force]`, and `path` subcommands. Wrappers gain `--audit-log [PATH]` flag and recognise `AUDIT_LOG=1` env (default path `${XDG_STATE_HOME:-$HOME/.local/state}/tmux-agent-tools/audit.jsonl`); existing `TMUX_AGENT_TOOLS_AUDIT_LOG=<path>` still works. Size-triggered rotation (`TMUX_AGENT_TOOLS_AUDIT_MAX_BYTES` default 10485760, `TMUX_AGENT_TOOLS_AUDIT_RETAIN` default 5). An advisory lock (flock when available, mkdir-fallback otherwise) guards rotate+append against concurrent appenders; an `audit.rotation` HEAD-link record preserves the hash chain across rename so `verify` is rotation-aware and tampering is still detected across rotated segments. Event schema (`schema_version: 1`) covers `wrapper.start`, `wrapper.stop`, `wrapper.send`, `hook.allow`, `hook.reject`, `hook.run`, `secret.read` (records `secret_name` + `backend` only — never the value), `approval.approve`, `approval.reject`, `approval.timeout`, `fuse.max_trigger`. Legacy event names are auto-namespaced to `wrapper.<verb>` for back-compat. Smokes: `test-audit-smoke` 16, `test-audit-query-smoke` 11, `test-audit-rotation-smoke` 12 (including a 2-appender + 1-rotator concurrency stress run). Design doc: `docs/design-issue-188-audit-surface.md`. Cross-host non-repudiation remains explicit deferral.

- L6 `--secret KEY=URI` URI backends + redaction (#189 / PR #192 + PR #198). `--secret` now accepts `file:<path>` (and bare `<path>` for back-compat with the v0.10.0 file-only form), `env-file:<path>` (dotenv loader), `op://<vault>/<item>/<field>` (1Password CLI via `op read`), and `keychain:<account>/<service>` (macOS `security find-generic-password`). **Missing backend CLI exits 4 in under 100ms** before any tmux session is created — preflight is hoisted to immediately after the `--secret` parse loop, so the failure path can never accidentally drift to "after session creation" (PR #198 made this explicit; the regression-proof smoke wraps the case in a 3s alarm assertion). Registered secret values are redacted from `capture` output and transcript events as `[REDACTED:KEYNAME]`. The matcher stores secrets as `KEY<TAB>BASE64(VALUE)<NEWLINE>` so newlines, NULs, and regex metacharacters in the secret cannot corrupt the redactor; substitution runs through `awk RS="\0"` so multi-line values (PEM keys, multi-line tokens) are scrubbed in full. `--secret-redact=false` bypasses redaction for debugging and prints a loud stderr warning. When audit is enabled, `secret.read {secret_name, backend}` is recorded — never the value. `scripts/test-secret-uri-smoke`: 26 sub-assertions including multi-line secret, trailing-newline, regex-meta values, and a `≤3s` timing assertion on the missing-CLI path. README + `skills/tmux-agent-tools/SKILL.md` document the safe `op://` usage example.

### Notes

- Two new binaries are installed by the existing `install-bin` mechanism: `tmux-agent-audit` and `tmux-agent-worktrees`. Both follow the same prefix/install conventions as the wrappers.
- Every new JSON surface carries `schema_version: 1` (fanout summary, fanout per-agent `result.json`, DAG summary, worktree `meta.json` / wrapper `worktree.json`, audit events, approval-gate status).
- Lint coverage gap tracked at #196: `scripts/lint-no-path-tied-locals` does not yet catch the multi-name `local path agent foo` form. Not a runtime issue post-PR #194's rename pass (zero tied-pair locals remain on `main` per a targeted grep) but planned for a separate follow-up.
- This release sits entirely within the v0.10.0 "no hidden autonomy" non-goal: every new surface is operator-explicit, synchronous, and creates no resident daemons or background supervisors.

## v0.10.0 - 2026-05-21

`v0.10.0` closes the entire issue backlog. All 33 GitHub issues from the original list are now closed. This release lands the L5/L6 batch (#112–#119) under the "no hidden autonomy" non-goal: every L5/L6 surface is synchronous, operator-explicit, with no resident daemons or shared cross-session state.

Total smoke coverage: ~440 sub-assertions across 21 smoke runners.



### Added




- L5 batch (#112 #113 #114): `tmux-agent-fanout` spawns N agents synchronously and waits for all to write `result.json` before emitting a consolidated payload (no daemon, no async). `tmux-agent-dag run <manifest.json>` walks a JSON-declared task DAG in topological order, BLOCKING after each task. `wait-and-capture --pause-until-file <path>` blocks after the marker match until the operator writes the gate file. All three respect "no hidden autonomy" — synchronous, operator-explicit, no resident processes. `scripts/test-l5-batch-smoke`: 6 sub-assertions.
- L6 batch (#115 #116 #117): `--on-exit-allow <regex>` rejects hook strings that do not match (#115; exit 3 on policy violation). `--secret KEY=PATH` reads file content into the session env so callers do not embed secrets in command lines (#116; missing file exits 4). `--workdir-fresh` creates a `git worktree add` of the target directory so the agent operates on its own copy (#117; non-git source exits 1). All three respect the "no hidden autonomy" non-goal: no daemons, operator-explicit invocation, synchronous side effects only. `scripts/test-l6-batch-smoke`: 14 sub-assertions.
- `TMUX_AGENT_TOOLS_AUDIT_LOG=<abs.jsonl>` opt-in audit log (issue #119). Each subcommand appends a JSONL event chained via SHA-256 to the previous (`prev_chain_hash` + `chain_hash` + `schema_version: 1`). Chain key derived from `/etc/machine-id` (Linux) / `IOPlatformUUID` (macOS) / `$HOME` (fallback) — no operator-managed key. `audit-verify <log>` walks the chain and reports tamper. No daemon, fully synchronous on each call path — respects "no hidden autonomy". `scripts/test-audit-smoke`: 16 sub-assertions covering append, chain shape, verify-ok, tamper-detection, env-unset no-op.
- `TMUX_AGENT_TOOLS_TENANT=<name>` env var appends a tenant suffix to the session prefix (issue #118). Operators on the same host get isolated session names + state dirs by exporting different tenant names — no shared state, no daemon, fully operator-explicit. New `tenant` subcommand on both wrappers prints the effective prefix. Respects the "no hidden autonomy" roadmap non-goal: tenant scoping is env-var only with no policy machinery. `scripts/test-tenant-smoke`: 6 sub-assertions.
## v0.9.0 - 2026-05-21

`v0.9.0` clears the entire L4/L7/L8 backlog with v1 slices. Closes 7 issues (#103, #111, #120, #122, #123, #127, #129) and lands two design docs (#167 L5/L6 policy-block, #170 v1-slice contracts). Only L5/L6 (#112–#119, policy-blocked per "no hidden autonomy") remain open.



### Added







- `tmux-agent-history` SQLite + FTS5 index tool (issue #129 v1 slice). Subcommands: `index <transcript>...`, `search <query>`, `show <name>`. Stores per-session metadata at `~/.tmux-agent/history.db`; full transcript body indexed via FTS5 unicode61 tokenizer. Time filters (`--since 7d`), cross-session rollups (`top --by cost`), and `diff` are deferred per design batch. `scripts/test-history-smoke`: 9 sub-assertions.
- `tmux-agent-dashboard [--watch] [--interval s] [--count n]` JSON snapshot tool (issue #123 v1 slice). Single JSON object per snapshot with totals + per-session payloads. `--watch` polls bounded by `--count`. Interactive ncurses TUI deferred per design batch. `scripts/test-dashboard-smoke`: 5 sub-assertions.
- `tmux-agent-cron` catalog tool (issue #122 v1 slice). Subcommands: `add`, `list`, `remove`, `show`, `history`. Schedules persist to `~/.tmux-agent/cron/schedules.jsonl`. Platform integration (launchd / systemd-timer / crontab) is deferred to v2 per design batch — operator reads the catalog from their own scheduler. `scripts/test-cron-smoke`: 12 sub-assertions.
- `checkpoint <name> <abs.tar.gz>` and `restore <input.tar.gz>` subcommands on both wrappers (issue #111 v1 slice). `checkpoint` snapshots the per-agent state dir + a 2000-line pane scrollback into a gzip-compressed tarball. `restore` is read-only: extracts to a scratch dir and prints contents. Spawning a fresh session from the checkpoint is deferred to v2 per design batch. `scripts/test-checkpoint-smoke`: 12 sub-assertions.
- `--ci` flag on `start` / `resume` (issue #120 v1 slice). Persists a per-agent marker at `$TMUX_AGENT_DIR/<name>/ci-mode` so future subcommands can branch on it. `docs/ci-mode-exit-codes.md` documents the stable exit code contract: 0/ok, 1/generic, 2/usage-error, 3/permission-wall, 4/secret-missing (placeholder), 5/schema-fail (placeholder), 124/timeout. Deferred to v2: JSON-by-default flip, `doctor --ci`, GH Actions example. `scripts/test-ci-mode-smoke`: 6 sub-assertions.
- `usage.jsonl` skeleton + `status --usage` aggregator (issue #103 v1 slice). `start`/`resume` now write a `{event: "usage_init", at, schema_version: 1}` line under `$TMUX_AGENT_DIR/<name>/usage.jsonl` (or `--usage <abs>` for a custom location). `status --usage <name>` reads the file, folds `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `turns` and emits a structured payload (`schema_version: 1`). v1 has no real CLI-tee mechanism (tracked in design doc) — every aggregate field is 0/null with an explanatory note. `scripts/test-usage-smoke`: 16 sub-assertions covering default path, custom `--usage` path, aggregator output, and relative-path rejection.
- `--record <abs.jsonl>` is now a documented alias for `--transcript` on `start`/`resume` (issue #127 v1 slice). `tmux-agent-replay fixture-validate <jsonl>` sanity-checks a transcript: all lines parse, all entries carry `schema_version:1`, all timestamps match ISO-8601 UTC, and at least one `start` event is present. Exit 0 on valid, exit 2 on validation failure. Output is structured JSON `{schema_version:1, ok, fixture, generated_at, checks[{name,status,detail}]}`. Replay TMUX_AGENT_FIXTURE replay-from-fixture mode remains deferred (depends on a fake-CLI driver — see `docs/design-remaining-backlog.md`). `scripts/test-fixture-validate-smoke`: 10 sub-assertions.
## v0.8.0 - 2026-05-21

`v0.8.0` ships safety + DX surfaces: max-runtime/idle fuses (#105), health-check ping (#128), result-schema validation (#125), session tagging (#124), webhook notify (#121). Also documents the L5/L6 policy-block roadmap amendment proposals (#112–#119 design batch).



### Added





- `tmux-agent-notify --webhook <url> [--format <generic-json|slack>] [--tag k=v]...` standalone tool (issue #121). Reads `$ON_EXIT_NAME` + `$ON_EXIT_CODE` from the calling shell (set by the #95 on-exit hook), POSTs a JSON envelope (`schema_version: 1`) with retry (3 attempts, exponential backoff). Slack format wraps as `{text, attachments[]}`. v1 ships generic-json + slack; discord/mattermost/teams are followups. Always exits 0 — notification is a side channel and must not break the agent contract. `--dry-run` prints the body without POSTing. `scripts/test-notify-smoke`: 16 sub-assertions.
- `--tag key=value` flag (repeatable) on `start` / `resume` (issue #124). Tags persist to `$TMUX_AGENT_DIR/<name>/tags.json` and are queryable via the new `tags <name>` subcommand on both wrappers. `tmux-agent-sessions list --tag key=value` filters the inventory; multiple `--tag` filters AND-combine. Key must match `[A-Za-z0-9_.-]+`; value is free-form. `scripts/test-tagging-smoke`: 10 sub-assertions covering persist+read, invalid-format rejection, and cross-session AND filtering.
- `--result-schema <abs.json>` flag on `start` / `resume` and `result --validate <name>` subcommand (issue #125). Lightweight v1 validator written in shell + jq: top-level `type`, `required` keys, and `additionalProperties: false`. Full JSON Schema draft-07 (refs, oneOf, nested properties) deferred to an ajv-cli followup. Validator output: `{schema_version: 1, present, valid, errors[{path, message}], body}`. Exit 0 on valid, exit 2 on invalid (distinct from exit 1 = file-missing). Ships example schema `schemas/result-status-summary.schema.json` matching the result-file contract from #107. `scripts/test-result-schema-smoke`: 32 sub-assertions covering valid, missing-required, extra-key, non-JSON, missing-file, relative-path rejection, non-existent-schema rejection. Design doc: `docs/design-issue-125-result-schema-validation.md`.
- `claude-tmux ping <name> [--timeout 10] [--json]` and the equivalent on `codex-tmux` actively probe the pane (issue #128). Sends a benign newline + Ctrl-U (which clears the input line — safe against turn-stealing) and waits for pane bytes to change. Exits 0 / 1 / 2 for ok / timeout / dead with rtt_ms reported. JSON output carries `schema_version: 1`. `scripts/test-ping-smoke`: 28 sub-assertions across both wrappers (live → ok, quiet → timeout, missing → dead, --timeout honored, rtt is non-negative int).
- `--max-runtime <seconds>` and `--max-idle <seconds>` safety fuses on `claude-tmux` / `codex-tmux` `start` (issue #105). A detached watcher process polls the pane and force-stops the agent when the threshold trips; sentinel writes `124` and a sidecar `<sentinel>.reason` records `max_runtime` or `max_idle`. `--on-exit` hooks receive `ON_EXIT_REASON` so callers can branch on cause. `stop` kills the watcher PID recorded at `$TMUX_AGENT_DIR/<name>/fuse.pid` to prevent zombies. `scripts/test-max-fuse-smoke`: 20 sub-assertions covering runtime trip, idle trip, idle reset on activity, watcher cleanup, both-flags-runtime-wins, and bad-value rejection. `--max-cost` deferred until #103 token telemetry lands.
## v0.7.0 - 2026-05-21

`v0.7.0` ships the runtime-safety + replay slice: advisory lock around concurrent send (#102), cross-session inventory watch events (#104), and the read-only `tmux-agent-replay` tool (#126 — `diff` + `redact`, with `run` deferred per acceptance).

### Added

- `tmux-agent-replay` tool with two read-only subcommands (issue #126): `diff` and `redact`. `diff <a.jsonl> <b.jsonl> [--json]` reports send delta, wait outcomes, marker sequences. `redact <in.jsonl> --output <out>` strips secrets via default regex set (AWS keys, GitHub tokens, api_key=, password=, Bearer) plus caller `--pattern`. `run` deferred per acceptance. `scripts/test-replay-smoke`: 21 sub-assertions.

- Advisory lock around `send` / `send-wait-literal` to prevent concurrent input races (issue #102). Each agent gets a `$TMUX_AGENT_DIR/<name>/send.lock` mkdir-style lock with stale-PID recovery (dead PID files are reclaimed automatically). Helper `send_lock_around` is shared across both wrappers and supports `--retry N` (default 50) `--retry-delay s` (default 0.1). Smoke `scripts/test-send-lock-smoke` covers: concurrent acquirers serialize, stale PID recovery, missing-agent-dir tolerance, and inner-command return-code propagation across both wrappers (10 sub-assertions).
- `tmux-agent-sessions watch` event subscribe mode (issue #104). Bounded foreground polling loop that diffs successive `inventory_json_array` snapshots and emits one JSONL line per state transition: `session_added`, `session_state_changed` (with `from` / `to`), and `session_removed`. Every event carries `schema_version: 1`, `tool`, `name`, `session`, and ISO-8601 UTC `at`. Flags reuse the existing list filters (`--tool`, `--name`, `--state`) plus `--count <n>` (default 0 = unlimited, Ctrl-C to stop) and `--interval <s>` (default 2). First tick is silent (no prior snapshot); silent ticks emit nothing. Reuses `list --json` state discovery — no new inventory code path. `scripts/test-sessions-watch-smoke`: 10 sub-assertions covering first-tick silence, `session_added` on new session, silent stable ticks, transition events on stop, `--count 0` parsing, and bad-arg rejection. Implementation note: `local foo` on a re-entered scope prints the existing value in zsh, so all scalar locals are declared once outside the polling loop.

## v0.6.0 - 2026-05-21

`v0.6.0` is the contracts + lifecycle + observability release. Closes 17 issues (#95–#101a, #106, #107, #110, #132, #135, #139, #140, #141, #143, #144). Every JSON surface now carries `schema_version: 1`. Total smoke coverage: 308 sub-assertions across 11 runners.

### Added

- Transcript now records `wait_*` events (issue #141 — followup from #100). Each of `wait`, `wait-text`, `wait-literal`, `send-wait-literal`, and `wait-and-capture` emits one JSONL event when it completes with `{schema_version: 1, event, name, outcome, needle, timeout_seconds, at}`. `outcome` is `matched`, `timeout`, `stable` (for `wait`), or `session_gone` (wait-and-capture only). Only fires when `--transcript` is configured. `scripts/test-transcript-smoke`: 38 → 46 sub-assertions covering matched + timeout outcomes for wait-literal / wait-text plus schema_version validation across the new event types.
- `--strip-ansi` now strips OSC, DCS, APC, PM, and SOS escape sequences in addition to CSI/SGR (issue #135 — followup from #96). Single sed pipeline; out-of-scope: 8-bit C1 controls. `scripts/test-capture-smoke` 26 → 48 sub-assertions adding one synthetic example per category and asserting both introducer removal and visible-body survival. README + design doc remove the "known gap" caveat.
- `--transcript-text-truncate <N>` opt-in flag on `start` / `resume` (issue #140). When set and a `send` event's text payload exceeds N bytes, the transcript records `text: "[truncated, original X bytes]"` plus `text_sha256` (hex) and `text_bytes` (integer) instead of the verbatim payload. Default behavior unchanged: text embedded verbatim with `text_sha256: null`. Threshold persists per agent under `$TMUX_AGENT_DIR/<name>/transcript-truncate`. `scripts/test-transcript-smoke` adds 14 sub-assertions (passthrough on short text, hash + bytes on long text, non-integer + zero rejection).
- `status --json` now carries `schema_version: 1` (issue #143). Retrofit only — no field shape change. Aligns `status --json` with the convention established by #96/#97/#99/#100/#142 so consumers can detect contract version on every JSON surface. `scripts/test-liveness-smoke` now asserts the new field per wrapper (34 → 36 sub-assertions).
- Graceful degrade on liveness-state write failures (issue #144). The four `#98` writers (`record_started_at`, `marker_seen_add` append, `marker_seen_add` FIFO cap, `update_pane_hash`) now run inside a subshell with `2>/dev/null || true`. Under read-only `$TMUX_AGENT_DIR/<name>/` (disk-full, permission-denied, NFS read-only mount), `status --json` continues to emit valid JSON with degraded values (null timestamps, stale hash) instead of crashing the caller. The subshell wrapper is necessary because zsh emits redirect-open errors from the SHELL itself (`update_pane_hash:24: permission denied`) which `2>/dev/null` on the printf line alone does NOT catch. `scripts/test-liveness-degrade-smoke` locks this with 4 sub-assertions across both wrappers (status --json exit code + valid JSON under chmod 555 agent dir).
- `claude-tmux start --dry-run` and `codex-tmux start --dry-run` perform pre-flight checks without creating a tmux session or launching the CLI (issue #110). Emits JSON `{schema_version: 1, tool, name, directory, ok, checks[]}` with per-check `{name, status: pass|fail|skip, detail}`. Checks: workdir_exists, tmux_binary, agent_cli_binary (picks correct env var by tool name — no cross-fallback), session_not_in_use (only with `--exact`), sentinel_path (absolute + writable parent + not pre-existing), on_exit_pairing (`--on-exit` requires `--sentinel`), transcript_path (absolute + writable parent + not pre-existing, no file creation). Exit 0 on all-pass, exit 2 on any failure. Side-effect free: `require_bins` and `write_tmux_conf` are gated after dispatch. Scope is `start` only. `scripts/test-dry-run-smoke`: 36 sub-assertions across both wrappers.
- `claude-tmux help <subcommand>` and `codex-tmux help <subcommand>` print a focused per-subcommand cheatsheet instead of the full multi-page usage (issue #106). Topics: start, resume, start-ssh, attach, send, send-wait-literal, wait, wait-text, wait-literal, wait-and-capture, capture, result, status, list, stop, doctor, self-test, help. Unknown topic exits 2 with the topic list. `scripts/test-help-smoke` covers all topics + fallback + unknown-topic dispatch across both wrappers (42 sub-assertions). `skills/tmux-agent-tools/SKILL.md` gains a scenario → command table linking each scenario to the issue that introduced it.
- `--sentinel <abs-path>` and `--on-exit <shell-cmd>` flags on `claude-tmux` and `codex-tmux` `start` / `resume` for event-driven completion signaling (issue #95). After the wrapped CLI exits, the wrapper atomically writes the decimal exit code to the sentinel file and optionally runs the hook with the exit code and agent name as arguments. Hook stdout/stderr is captured to `<sentinel>.hook.log`. Pre-existing sentinel aborts start; relative paths are rejected; `--on-exit` without `--sentinel` warns and is ignored.
- `--sentinel-keep` flag to retain the sentinel file across `stop` (default removes it).
- Docs: `docs/design-issue-95-event-driven-completion.md` and `docs/implementation-notes.md` capture the design and the decisions made during implementation.
- `--strip-ansi`, `--since-marker <text>`, and `--json` flags on `claude-tmux` / `codex-tmux` `capture` for token-efficient post-processing (issue #96). `--strip-ansi` removes CSI/SGR sequences (known gap: does not strip OSC/DCS/APC/PM/SOS — documented in the design doc). `--since-marker` keeps only lines after the LAST occurrence of the literal text, returning empty / `marker_found: false` when missing. `--json` wraps output as `{name, session, lines_requested, marker_found, stripped_ansi, lines}`.
- `scripts/test-capture-smoke` covers the new flags with 24 sub-assertions (raw / strip / since-marker / JSON / missing-marker / missing-value) against both wrappers.
- Result-file convention: `start` and `resume` export `TMUX_AGENT_NAME` and `TMUX_AGENT_RESULT` into the pane so the agent CLI can write a structured result to a conventional path (`$TMUX_AGENT_DIR/<name>/result.json`). Stale `result.json` is cleared at start. (issue #97)
- `result <name>` subcommand on both wrappers. Supports `--field <jq>` for single-value extraction, `--wait <seconds>` for polling until the file appears, and `--json` for metadata-wrapped output (`{schema_version, path, present, bytes, mtime, body}`). Missing file: exits 1 in text mode, `present: false` in JSON mode.
- `scripts/test-result-smoke` covers the new env injection and subcommand with 18 sub-assertions across both wrappers.
- `wait-and-capture` combined subcommand on both wrappers (issue #99). Replaces the two-step `wait-literal X` + `capture --strip-ansi --since-marker X` pattern with a single call. Flags: `--marker <text>` (required), `--literal` / `--regex` (default regex), `--timeout <s>`, `--tail <n>`, `--strip-ansi`, `--since-marker <text>` (defaults to `--marker`), `--json` (schema_version=1 with `reason: matched | timeout | session_gone`), `--no-timeout-error` (decouples soft-timeout from `--json` per partner R3 review).
- `scripts/test-wait-and-capture-smoke` covers literal/regex match, timeout exit-code semantics, JSON reason field, session_gone case, and missing-value rejection across both wrappers — 28 sub-assertions.
- Single-agent JSONL transcript: `--transcript <abs-path>` on `start` / `resume` records `start`, `send`, `capture`, `stop` events (one JSON object per line, `schema_version: 1`, ISO-8601 `at` timestamp). Transcript path is remembered per agent under `$TMUX_AGENT_DIR/<name>/transcript-path`. Pre-existing transcript aborts start to prevent mixed-run noise. (issue #100)
- `scripts/test-transcript-smoke` verifies env-injection + four events + stale rejection + missing-value rejection across both wrappers — 20 sub-assertions.
- `status --json` now reports five additive liveness fields: `started_at`, `last_change_at`, `idle_seconds`, `bytes_in_pane`, and `marker_seen` (string array). Markers from `wait-literal` / `send-wait-literal` are recorded; regex `wait-text` is intentionally not. Existing field shape unchanged. (issue #98)
- `scripts/test-liveness-smoke` covers ISO-8601 timestamps, byte counting, idle growth, marker recording, dedup, and null-on-missing-session — 28 sub-assertions across both wrappers.

### Notes

- Sentinel support is wired into local `start` and `resume` for both wrappers; `start-ssh` sentinel support is pending a separate design decision on remote-vs-local sentinel placement.
- The sentinel format is plain decimal exit code plus newline by design; structured telemetry stays a separate artifact (see roadmap L3 issues).

## v0.5.0 - 2026-05-17

`v0.5.0` is the observability and multi-session composability release.

### Added

- `tmux-agent-sessions list --watch --json --count N --interval S` for bounded inventory polling without creating a daemon.
- Wrapper `status --json` now includes nullable `exit_code` detail parsed from wrapper exit markers.
- `tmux-agent-dialogue validate-transcript --schema-version 1` for explicit transcript contract validation.
- `tmux-agent-dialogue --on-blocked-trigger <path>` for local blocked-session trigger artifacts.
- `tmux-agent-dialogue summarize --output-format json` for structured summary output while keeping Markdown as the default.
- Participant profile `timeout` values for per-agent bounded dialogue waits.
- `github-comment --edit-existing <comment-id>` for explicitly updating a known GitHub issue comment instead of appending.

### Changed

- Cleanup preview JSON coverage now asserts scriptable cleanup decisions for owned sessions, tool filters, name filters, unrelated sessions, and execute-mode rejection.
- Summary-file comment coverage now includes empty summary files and `--max-bytes` truncation behavior.
- GitHub comment helpers remain dry-run by default; posting or editing still requires explicit `--post-github-comment`.

### Notes

- Default CI remains credential-free and uses fake participants.
- Real Codex/Claude runs remain manual release evidence, not default pull-request checks.
- Homebrew Formula stable URL and SHA-256 should be bumped in a follow-up PR after the `Release` workflow creates the `v0.5.0` tag and summary.

## v0.4.0 - 2026-05-16

`v0.4.0` is the automation-readiness release.

### Added

- `tmux-agent-sessions list --json` now reuses wrapper status for Claude/Codex rows and reports a derived `state`.
- `status --json` now includes bounded diagnostic tail lines through `last_capture_lines`.
- `status --json` now includes diagnostic prompt fields: `confirmation_detected` and nullable `blocked_reason`.
- `tmux-agent-dialogue handoff` for bounded two-turn context transfer with local transcript and optional summary output.
- `github-comment --summary-file` for reusing a pre-rendered local Markdown summary body.
- `tmux-agent-dialogue pair-review --swap` for reversing proposal/review speaker order without changing participant definitions.
- Participant profile `env` support for generic per-session environment variables passed into local tmux sessions.

### Changed

- Session inventory and cleanup previews use wrapper-backed running/exited state instead of assuming every owned tmux session is running.
- Status diagnostics remain bounded, best-effort, and non-authoritative; prompt detection never auto-accepts or interacts with prompts.
- Handoff and summary-file flows stay local by default, with GitHub posting still requiring explicit `--post-github-comment`.
- Participant profile env is validated before session start, remains profile-scoped, and is documented with SSH caveats rather than treated as a secret transport.

### Notes

- Default CI remains credential-free and uses fake participants.
- Real Codex/Claude runs remain manual release evidence, not default pull-request checks.
- Homebrew Formula stable URL and SHA-256 should be bumped in a follow-up PR after the `Release` workflow creates the `v0.4.0` tag and summary.

## v0.3.0 - 2026-05-16

`v0.3.0` is the session hygiene and transcript usability release.

### Added

- `tmux-agent-sessions` for inspecting and cleaning up owned tmux-agent-tools sessions with preview-first cleanup.
- `tmux-agent-dialogue validate-transcript` for local JSONL transcript validation before summarizing or sharing.
- Failure classification for dialogue failure events, including conservative `failure_type` values such as `marker_timeout` and `session_missing`.
- Sharing controls for transcript summaries and GitHub comment bodies: `--max-lines`, `--max-bytes`, and repeated `--redact-pattern`.
- Stable `status --json` fields for both `claude-tmux` and `codex-tmux`.
- Participant profiles for reusable local or SSH-backed dialogue participants.
- `critic` preset for bounded critique/response loops.
- Manual `v0.3.0` release evidence for real Codex/Claude wrapper and bounded dialogue smoke checks.

### Changed

- Transcript summary and GitHub comment rendering use a generic `transcript` label unless a preset explicitly sets its own label.
- Wrapper and dialogue capture now join tmux soft-wrapped screen lines before matching or writing transcript text.
- Copy-mode keyboard and mouse-drag copy paths now use the same clipboard selection behavior.
- Clipboard behavior can be forced with `CLAUDE_TMUX_CLIPBOARD` or `CODEX_TMUX_CLIPBOARD` (`auto`, `internal`, or a custom copy command).

### Notes

- Default CI remains credential-free and uses fake participants.
- Real Codex/Claude runs remain manual release evidence, recorded without committing raw real-agent transcripts.
- Homebrew Formula stable URL and SHA-256 should be bumped in a follow-up PR after the `Release` workflow creates the `v0.3.0` tag and summary.

## v0.2.0 - 2026-05-16

`v0.2.0` is the first stable orchestration release.

### Added

- `tmux-agent-dialogue` for bounded two-party tmux dialogues with JSONL transcripts.
- `pair-review` preset for local proposal/review loops.
- `summarize` and `github-comment` helpers for transcript summaries; GitHub posting is dry-run by default and requires `--post-github-comment`.
- Participant-scoped remote dialogue options through existing `start-ssh` wrappers.
- `send-wait-literal` and `wait-text --literal` for stale-marker-safe orchestration.

### Changed

- Stable Homebrew install now includes `tmux-agent-dialogue`.
- CI covers fake dialogue, pair-review, summary rendering, GitHub comment dry-run behavior, and post command shape without real credentials.

### Notes

- Real `codex`/`claude` dialogue runs remain manual release evidence, not default CI.
- GitHub publishing remains explicit opt-in; local transcript and summary generation are the default paths.

## v0.1.0 - 2026-05-16

Initial public MVP.

### Added

- `claude-tmux` and `codex-tmux` wrappers for named local tmux sessions.
- `start-ssh`, `send`, `wait`, `wait-text`, `wait-literal`, `capture`, `status`, `doctor`, `self-test`, and `stop` commands.
- `skills.sh` compatible skill package.
- Homebrew formula for stable and `--HEAD` installs.
