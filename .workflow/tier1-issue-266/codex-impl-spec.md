# Codex implementation spec — next-plan packets

You are the implementer. Repo: `/Users/paul.yeh/github/tmux-agent-tools` (branch `tier1-issue-266`).

**Authoritative plan (READ IT FIRST, it has exact line numbers + every codex correction):**
`.workflow/tier1-issue-266/next-plan.md`

Target file for all code: `skills/tmux-agent-tools/scripts/agent-tmux` (zsh, `set -euo pipefail`).

## Already applied by the orchestrator (DO NOT redo — build on these)
Packet 0a seed edits, all `zsh -n` clean:
1. case arm `*)` now sets `HEURISTIC_FAMILY=generic` (was codex).
2. `cli_provider_env_keys()` is now a 3-way `case`: `claude)` anthropic keys, `codex)` openai+codex keys, `generic|*)` inherits NO provider keys.
3. probe metric set is now a `case`: `claude)` claude metrics, `codex|generic|*)` generic metrics.

## Constraint
- agy/cursor/grok.conf stay UNCHANGED (deliberate named arms — next-plan.md 0a item 3).
- Match existing code style. Surgical edits only. Tools: `rg` (not grep), `fd` (not find), `ast-grep` for structured edits, `jq` for JSON.
- Every non-trivial branch/parser/loop leaves a self-test in the existing self-test region (the `self_test_*` functions). Self-tests for watch/quorum MUST use LIVE tmux sessions (a missing session counts as done-by-exit, so fake paths pass for the wrong reason).

## BATCH 1 (do first, in this order — 0b rides 0a)

### 0a edit #4 — probe parsers (the `if [[ HEURISTIC_FAMILY == claude ]] ... else ... fi` around line 5044)
Convert the OUTER `if/else` to an explicit `case "$HEURISTIC_FAMILY"`: arm `claude)` keeps the claude parser block (context_percent/goal_active/active_spinner); arm `codex|generic|*)` keeps the generic parser block (progress/tool_active/approval_pending). Do not touch the inner per-metric `case "$metric"`.

### 0a docs
- `scripts/profiles/README.md`: `heuristic_family` row says "`claude` or `codex`" → make it "`claude`, `codex`, or `generic`".
- `SKILL.md`: the "Custom CLIs and profiles" section says unknown CLIs get "codex-family heuristics" → change to "generic-family heuristics (no provider-key inheritance, no --yolo, result-path-via-prompt on)". The inline gemini profile example uses `heuristic_family=codex` → change to `generic` and stop teaching codex-for-new-CLI.
- `scripts/profiles/gemini.conf.example`: `heuristic_family=codex` → `heuristic_family=generic`.
- Add a short back-compat/migration note (next-plan.md 0a item 5): demoting `*)` from codex→generic changes unlisted-CLI behavior (no --yolo, no provider-key inheritance, result-path-via-prompt on). Put it where a reader configuring a custom CLI will see it (SKILL.md custom-CLI section and/or profiles/README.md).

### 0b — result-path prompt contract (next-plan.md Packet 0b)
- Add declarative profile key `result_path_via_prompt` to the profile parser (the `case "$key"` near line 108-132). Establish per-family DEFAULTS (applied after preset/profile load, profile value wins if set): `claude=false`, `codex=true`, `generic=true`. Pick a clean global var name (e.g. `RESULT_PATH_VIA_PROMPT`).
- At the four prompt-send boundaries — `start` initial text (~2768), `send` (~3238), `send-wait` (~3347), `send-wait-literal` (~3410) — when the flag is true, prepend a line `Write final JSON to this exact path: <absolute result_path>` to the prompt text, BEFORE any nonce/literal marker (so send-wait last-line nonce matching still works).
- `result_path` = `$(agent_root_dir)/<name>/result.json` (same value `result --path <name>` prints; path source ~1227-1228 / ~2465-2472).
- Out of scope: start-ssh remote placement, resume, new schema.
- Update `references/contracts.md` (~75-83) and `SKILL.md` (~196): the "agents can't expand $TMUX_AGENT_RESULT, pass literal path manually" workaround is now AUTOMATIC for `result_path_via_prompt=true` families. Keep `result --path` as the debug surface.
- Self-check: start two NON-exact workers with the flag on in the SAME cwd; assert each got a DISTINCT path equal to `result --path <its-name>`; assert a `send-wait` augmented prompt carries the path without breaking nonce matching.

## BATCH 2 (after Batch 1 gates green)

### Packet A — watch --count N (next-plan.md Packet A)
In `watch_session()` (~5125) add an EXPLICIT count mode (not default any). Met when `done_count >= N` named agents are done (existing done def: result.json changed OR session exited; from the existing `done_reason` map ~5128-5137/5175-5191). Reject mixing `--count` with `--any`/`--all`. Validate `--count` is a positive integer. JSON adds `required_count`/`done_count`; `--any`/`--all` output unchanged; update usage/help (~218). `self_test_watch_count` MUST use live tmux sessions: start 3 live workers, mark 2 done, assert `--count 2` → met.

### Packet B — team quorum (next-plan.md Packet B)
`team quorum <team> --count N [--field <jq> --value <literal>] --json` at `cmd_team()` dispatch (~5433), helper beside `_team_results` (~5575). Count present+valid worker results (optionally matching predicate); exit 0 when met. **Read each worker's stored row `result_path` directly** (team state preserves it ~5377-5411) — NOT `result --json <name>` (only reads `$(agent_root_dir)/$name/result.json`, would miss differing paths); factor a path-based reader. `--field` is a jq expression (matches `result_session --field` ~3768-3773) so examples use `--field .status`. `self_test_team_quorum`: 3-worker team state, 2× `{"status":"success"}`, assert `--count 2 --field .status --value success` → 0, `--count 3` → 1.

## Gates (run before declaring done)
- `zsh -n skills/tmux-agent-tools/scripts/agent-tmux`
- `scripts/ci-shellcheck`
- `skills/tmux-agent-tools/scripts/agent-tmux codex self-test` and `... claude self-test`

## Result
Write your final JSON result to the exact path the orchestrator gives you (status, summary, artifacts=changed files, errors). Set `status:"success"` only if all gates pass.
