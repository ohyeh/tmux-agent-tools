# Changelog

## Unreleased

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
  (scoped per CLI; `*_TMUX_CONF` overrides are still honoured).

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
