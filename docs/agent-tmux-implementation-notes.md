# agent-tmux — Implementation Notes (running log)

Decisions/deviations not in `docs/agent-tmux-design.md` v3.1. Kept current as PR A → PR B land.

## Method

PR A `agent-tmux` is **generated from `claude-tmux`** by a deterministic transform
(`/tmp/gen-agent-tmux.py`, not committed) that applies a small, enumerated set of
replacements. Rationale: the normalized diff (mask `claude↔codex` tokens) collapses the two
4.1k-line scripts to **339 lines, almost all comment drift** — so claude-tmux is a faithful
base and the per-CLI seam is tiny. The generator is reproducible and reviewable as a patch
list; the existing smoke suite is the real no-behaviour-change gate.

Base = `claude-tmux` (canonical). codex-family behaviour is added at the ~8 divergent spots,
selected by preset.

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
2. **INHERIT/CLEAR env table (design §"INHERIT / CLEAR env flags") is NOT implemented in PR A.**
   `INHERIT_CLAUDE_ENV`/`CLEAR_CLAUDE_ENV` have **0 occurrences** in the current scripts — env is
   passed via `TMUX_AGENT_TOOLS_SESSION_ENV` + sentinel/result/secret `-e` args; tmux inherits ambient
   env by default. The design table describes behaviour that does not exist in code. Deferred; flagged
   to reviewer. No regression (nothing relied on it).
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

## Verification gate

- `zsh -n` on agent-tmux + all shims.
- Full existing smoke suite run **through the shims** (must stay green — that is "no behaviour change").
- Codex teammate (via tmux-agent-tools) reviews the diff for parity; consensus required before PR.
