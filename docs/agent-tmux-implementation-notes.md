# agent-tmux — Implementation Notes (running log)

Decisions/deviations not in `docs/agent-tmux-design.md` v3.1.

> **REBASED ONTO `main`.** An earlier attempt built this on the stale
> `refactor/skill-progressive-disclosure` branch, whose `claude-tmux`/`codex-tmux` had been
> stripped of ~660 lines / 21 functions that `main` still carries (color-env, env-doctor,
> `result --path`/`init`/`validate`/`wait-required`, `send-wait`, provider-env inheritance).
> That made CI red and would have regressed `main`. This version is **re-derived from `main`'s
> full `claude-tmux` (4814 lines)**, so all those features are preserved AND unified.

## Method

`agent-tmux` is **generated from `main`'s `claude-tmux`** by a deterministic transform
(`/tmp/gen-agent-tmux.py`, not committed) applying a small, enumerated set of replacements.
The normalized code diff (mask `claude↔codex` tokens, strip comments) collapses `main`'s two
~4.8k-line scripts to **189 lines** — the per-CLI seam. The generator is reproducible and
reviewable as a patch list; the smoke suite + CI inline assertions are the no-behaviour-change gate.

Base = `main`'s `claude-tmux` (canonical, full-featured). codex-family behaviour is added at the
divergent spots, selected by preset.

## Per-CLI seam (the only behaviour-bearing differences)

| Spot | claude | codex/other | agent-tmux mechanism |
|---|---|---|---|
| binary env var | `$CLAUDE` | `$CODEX` | preset `_ENV_NS`; `CLI_BIN` reads `${(P)_ENV_NS}` then `command -v <bin>` |
| config env ns | `CLAUDE_TMUX_*` | `CODEX_TMUX_*` | `_pref KEY def` = `${NS}_TMUX_KEY` > `AGENT_TMUX_KEY` > default |
| launch flags | `--dangerously-skip-permissions` | `--yolo` / none | preset `LAUNCH_FLAGS`, via `_pref_set` (set-wins so `""` clears) |
| resume syntax | `--resume <id>` (flag) | `resume <id>` (subcommand) | preset `RESUME_KEYWORD` |
| status `tool` field | `claude` | `codex` | `--arg tool "$CLI"` |
| dry-run `tool` field | `claude-tmux` | `codex-tmux` | `run_dry_run_checks "${CLI}-tmux"` (wrapper basename — test-dry-run-smoke:47) |
| probe heuristics | `context_percent/goal_active/active_spinner` | `progress/tool_active/approval_pending` | `HEURISTIC_FAMILY` branch (claude vs codex), both metric sets embedded |
| ssh remote launch | bare `claude` | bare `codex` | `${CLI}` (resolved on remote PATH) |

## Decisions made (not in spec, or correcting spec)

1. **`.tool` has two distinct values.** `status --json` → cli identity (`claude`); `dry-run` JSON →
   wrapper basename (`claude-tmux`). Both are CI/smoke-asserted and must be preserved separately.
2. **INHERIT/CLEAR env + `result --path` ARE implemented** (they exist on `main`; the earlier
   stale-branch build had wrongly reported them missing). `INHERIT_<NS>_ENV`/`CLEAR_<NS>_ENV` resolve
   per-CLI via legacy `<NS>_TMUX_INHERIT_<NS>_ENV` → `AGENT_TMUX_INHERIT_ENV` → preset default (0/1);
   the env-inherit function (`apply_cli_env_args`) and per-CLI `cli_provider_env_keys` (ANTHROPIC_* vs
   OPENAI_*/CODEX_*) are unified into agent-tmux. color-env, env-doctor, send-wait, and
   `result init/validate/wait-required/path` are all carried over from `main`.
   **One minor deviation:** agent-tmux `start-ssh` does NOT inject provider env for the codex family
   (it matches claude's main behaviour, which omits it); color env IS injected in ssh for all CLIs.
3. **`HEURISTIC_FAMILY` default for non-claude CLIs = codex.** Unknown CLIs (cursor/grok/custom) get
   the codex metric set. probe is best-effort heuristics; codex's patterns (progress/tool/approval) are
   the more generic terminal-CLI signals. Documented; revisit per-CLI later if needed.
4. **`RESUME_KEYWORD` for unknown CLIs = `resume`** (codex-style positional). claude is the only
   `--resume`-flag CLI observed. Unknown-CLI resume is inherently undefined; positional is the safer
   default for modern CLIs.
5. **`TMUX_CONF` default path changes** from `/tmp/<cli>-tmux.tmux.conf` to
   `/tmp/agent-tmux-<cli>.tmux.conf` (per design §"TMUX_CONF path"). It is a regenerated tmp file;
   no caller persists it. `CLAUDE_TMUX_CONF`/`CODEX_TMUX_CONF` overrides still honoured (CI relies on them).
6. **`agy` `tool` field changes** from `codex` (today agy shims codex-tmux) to `agy` under agent-tmux.
   More correct; no test asserts agy's tool value.
7. **Cosmetic strings generalized** `claude-tmux`→`agent-tmux` in banners/usage. No test asserts them
   (verified). The two load-bearing literals (`run_dry_run_checks claude-tmux`, dry-run `case "$tool"`
   label) were converted to preset-driven first.
8. **Shims** (`claude-tmux`/`codex-tmux`/`agy-tmux`) become `exec "${0:A:h}/agent-tmux" <cli> "$@"`.
   `agy` no longer wraps codex-tmux; it is a first-class preset. Same dir → tests that invoke the shim
   by absolute path still resolve agent-tmux.
9. **CI + install-bin updated** to register/`zsh -n` `agent-tmux`.

## Branch / base

Branched off `refactor/skill-progressive-disclosure` (dev tip, contains the design doc + the
`status probe` heuristic feature), NOT `main` — `main` (1f30b1c) is ~477 lines behind and lacks the
probe feature. PR target decided at PR time (likely after dev branch merges to main).

## Codex review — round 1 (verdict: ACCEPT_WITH_CHANGES)

Reviewed commit 7e3266d via a codex teammate (tmux-agent-tools). Core parity **confirmed with
no defects** in: resume syntax, session prefix, status `tool`, dry-run `tool`, probe metric set,
and fuse-watcher self-reinvocation. The three items it raised are all **intentional, documented
design changes — not regressions**:

1. **LAUNCH_FLAGS override** (`CODEX_TMUX_LAUNCH_FLAGS` / `AGENT_TMUX_LAUNCH_FLAGS`). Pristine
   codex-tmux always launched `--yolo`; agent-tmux lets that be overridden. **Default (no override)
   is byte-identical (`--yolo`)** — the override is opt-in new capability per design §"Env Precedence".
2. **`AGENT_TMUX_*` universal fallback.** New cross-CLI override namespace per design §"Env
   Precedence". With no `AGENT_TMUX_*` set in the environment, behaviour is identical to pristine.
   Caveat acknowledged: an *ambient* `AGENT_TMUX_*` var now influences any CLI — that is the
   intended semantics of a universal namespace, and CLI-specific vars still take precedence.
3. **TMUX_CONF default path** `/tmp/<cli>-tmux.tmux.conf` → `/tmp/agent-tmux-<cli>.tmux.conf`
   (deviation #5 above). Regenerated tmp file; `*_TMUX_CONF` override still honoured.

**Parity contract, stated precisely:** with no `AGENT_TMUX_*` / `*_TMUX_LAUNCH_FLAGS` /
`*_TMUX_CONF` overrides set (the default environment the existing tests and callers run in),
`agent-tmux <cli>` is behaviour-identical to the original `<cli>-tmux`. The new env knobs are
additive opt-in. No code change required from round 1.

## PR B — pair + team + collaboration primitives

Added to `agent-tmux` (now a real editable file, no longer regenerated):

- `--role <value>` in `start`/`resume` — free-form sugar for `--tag role=<value>` (listed under
  PR A in the design but slipped; implemented here since pair/team need it).
- `pair <cli> <team> <dir> [--workers N] [--worker-cli C] [--role lead]` — idempotent worker
  bootstrap: per-worker live-check via `status --json` → `resumed` if alive else `started`;
  conservative scale-down (surplus prior workers printed `orphan`, never auto-stopped);
  exit 0 all-ok / 1 any-failure; per-team `mkdir` lock (pid owner + dead-owner reclaim + pid-less
  grace via mtime + `AGENT_TMUX_LOCK_TIMEOUT` + EXIT/INT/TERM trap); atomic state write
  (same-dir `.tmp.$$` + `sync` + `mv`).
- `team list|workers|lead|stop|rm|broadcast|send|wait|results`. State file
  `$TMUX_AGENT_DIR/teams/<team>.json` (schema_version 1; members[] = {name, role, cli, result_path}).
  `team stop` self-guard via `basename $(dirname $TMUX_AGENT_RESULT)`; `team rm` refuses while any
  member live. `wait` exit 0 idle / 7 blocked / 8 timeout (+`--require-result`). `results` branches
  on `.present`→`.valid`→`.body`, never on command success; missing/invalid named on stderr.

### Architecture decisions

1. **`pair`/`team` are management *modes*, not a `<cli>`** — `$CLI` holds the keyword, intercepted
   before normal command dispatch (preset_for_cli still runs on the keyword: harmless noise).
2. **All per-member ops re-invoke `"$SELF" <member-cli> <subcommand>`**, never the local `$PREFIX`
   (meaningless in pair/team mode). This makes **mixed-CLI teams** first-class and keeps the
   orchestration runtime-agnostic.
3. **`pair` records a `lead` member but does NOT start a lead session** — the lead is the caller
   (possibly unmanaged). `team list` shows it `stopped` when absent; the self-guard covers the case
   where the caller *is* a managed session named `<team>`.
4. **zsh gotcha fixed:** re-declaring `local` inside a loop on a var that previously held a
   *multi-line* value makes zsh echo `name=value` to stdout (corrupted `team results --json`). All
   loop-body `local` declarations were hoisted above their `for` loops.

### Verification

- New smoke tests (real tmux + fake CLI; deterministic status/state-file/exit-code assertions):
  `test-agent-tmux-pair-smoke` (18 checks), `test-agent-tmux-team-smoke` (13, incl. mixed-CLI +
  self-guard), `test-agent-tmux-collab-smoke` (15, incl. wait timeout/idle + results missing/present).
- Full suite = 36 pre-existing + 3 new = **39 pass / 9 unchanged pre-existing fail → zero regressions**.
- `agent-tmux` adds **zero** path-tied-local lint violations.
- New smoke tests are not wired into CI (repo convention: CI runs only `test-color-env-smoke` +
  inline assertions). Left as-is.

## Verification gate

- `zsh -n` on agent-tmux + all shims.
- Full existing smoke suite run **through the shims** (must stay green — that is "no behaviour change").
- Codex teammate (via tmux-agent-tools) reviews the diff for parity; consensus required before PR.
