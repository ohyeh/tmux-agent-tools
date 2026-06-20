# Issue #268 Research: headless one-shot `agent-tmux start`

## Feasibility verdict

**Feasible with a small, isolated `start_session` branch.** The current implementation already centralizes profile parsing, result-path setup, status detection, result reads, and watch semantics. The missing piece is a profile-driven launch path that builds the CLI invocation as `<bin> <launch_flags> <prompt_flag> <prompt>` and synthesizes the normal `result.json` on process exit.

This should not be implemented as `launch_flags=-p`: `start_session` currently launches an interactive CLI first, then separately injects the initial prompt into the tmux pane via paste (`skills/tmux-agent-tools/scripts/agent-tmux:2853-2854`, `skills/tmux-agent-tools/scripts/agent-tmux:2880-2885`). A one-shot CLI must receive the prompt in argv before the process starts.

Issue #268 is open and requests: `exec_mode=oneshot`, `prompt_via=argv`, and `prompt_flag` so `agent-tmux agy start ...` can use a working headless `agy -p "<prompt>"` mode while retaining wrapper contracts.

## (a) Exact `start` code paths for oneshot mode

Current interactive path:

- CLI/profile setup happens before command dispatch: the wrapper takes `<cli>` at startup, applies the legacy preset, then pre-parses `--profile` / `--profile-dir` before loading a declarative profile (`skills/tmux-agent-tools/scripts/agent-tmux:8-14`, `skills/tmux-agent-tools/scripts/agent-tmux:23-33`, `skills/tmux-agent-tools/scripts/agent-tmux:35-67`, `skills/tmux-agent-tools/scripts/agent-tmux:83-146`).
- `start` dispatches directly to `start_session` (`skills/tmux-agent-tools/scripts/agent-tmux:6200-6202`).
- `start_session` parses `--attach`, `--exact`, `--dry-run`, sentinel/fuse flags, transcript/result-schema/tag/secret/workdir flags, then consumes `<name> <directory> [initial text]` (`skills/tmux-agent-tools/scripts/agent-tmux:2585-2752`).
- It prepares the agent state dir and env, removes any old result, injects `TMUX_AGENT_NAME` and `TMUX_AGENT_RESULT`, records timestamps/tags/transcript/schema, and kills an existing same-name tmux session (`skills/tmux-agent-tools/scripts/agent-tmux:2809-2849`, `skills/tmux-agent-tools/scripts/agent-tmux:2575-2583`).
- It creates a detached tmux session that runs only the CLI binary and launch flags, then prints `[agent-tmux] local command exited with code ...`, waits for Enter, and exits (`skills/tmux-agent-tools/scripts/agent-tmux:2851-2854`).
- Only after tmux session creation does it paste the initial prompt with `prompt_with_result_path`, `tmux load-buffer`, `paste-buffer`, and `send-keys Enter` (`skills/tmux-agent-tools/scripts/agent-tmux:1781-1789`, `skills/tmux-agent-tools/scripts/agent-tmux:788-801`, `skills/tmux-agent-tools/scripts/agent-tmux:2880-2885`).

Minimal oneshot branch:

- Add profile globals with defaults: `EXEC_MODE=interactive`, `PROMPT_VIA=paste`, `PROMPT_FLAG=''`.
- Extend `load_cli_profile` to parse and validate:
  - `exec_mode`: `interactive|oneshot`
  - `prompt_via`: `paste|argv`
  - `prompt_flag`: string, required when `exec_mode=oneshot && prompt_via=argv`
- In `start_session`, after `initial_text` is known and after existing validation/state setup, branch before the current `tmux new-session`:
  - interactive: keep current path unchanged.
  - oneshot: require non-empty `initial_text`, build a tmux command that invokes the CLI once with prompt argv, writes stdout/stderr to an agent-local log, synthesizes `result.json`, prints `__AGENT_TMUX_ONESHOT_EXIT__<code>`, then prints the existing local-exit line and keeps the pane open with the current `read _`.

## (b) `result.json`, markers, and `wait-and-capture` synthesis

Existing result contract:

- `result init` writes `{schema_version:1,status:"ok",summary:"",artifacts:[],errors:[]}` and seeds `session-meta.json` (`skills/tmux-agent-tools/scripts/agent-tmux:1753-1768`).
- `result --path` resolves `$TMUX_AGENT_DIR/<name>/result.json` (`skills/tmux-agent-tools/scripts/agent-tmux:1770-1779`).
- `result --json --wait N` waits only for file presence, then returns `{present, valid, body, bytes, mtime}`; missing file with `--json` is a structured success payload with `present:false` (`skills/tmux-agent-tools/scripts/agent-tmux:3712-3867`, `skills/tmux-agent-tools/scripts/agent-tmux:3887-3909`).
- `result wait-required` waits for valid JSON and non-empty required fields, with profile fallback via `result_required_fields` (`skills/tmux-agent-tools/scripts/agent-tmux:1836-1921`).

Recommended oneshot synthesis:

```json
{
  "schema_version": 1,
  "status": "success|failed",
  "summary": "oneshot exited with code N",
  "artifacts": ["<stdout_path>"],
  "errors": [],
  "oneshot": {
    "done": true,
    "exit_code": 0,
    "stdout_path": ".../stdout.log"
  }
}
```

For non-zero exit, set `status:"failed"` and include one error object or string consistent with existing loose result usage. Keep the required top-level fields because `result_wait_required_session` only checks field presence/non-empty, not a bespoke oneshot schema.

Marker behavior:

- `wait-and-capture` currently requires a live tmux session; if the session is gone, JSON returns `reason:"session_gone"` and exit 1 (`skills/tmux-agent-tools/scripts/agent-tmux:4299-4318`).
- Because the current local command keeps the pane open after exit via `read _`, a oneshot branch should preserve that behavior. Then `wait-and-capture --marker '__AGENT_TMUX_ONESHOT_EXIT__' --regex/--literal ...` can still capture output from the retained pane.
- The deterministic marker should be printed after `result.json` is written:
  - `__AGENT_TMUX_ONESHOT_EXIT__0` for success.
  - `__AGENT_TMUX_ONESHOT_EXIT__1` etc. for failure.
- `status --json` already detects `local command exited with code` and reports `running:false`, `exit_detected:true`, and `exit_code` while the pane still exists (`skills/tmux-agent-tools/scripts/agent-tmux:5165-5264`). It will work unchanged if the oneshot branch also prints the existing local-exit line.
- `watch` already treats either a result rewrite or a gone tmux session as done (`skills/tmux-agent-tools/scripts/agent-tmux:5535-5538`, `skills/tmux-agent-tools/scripts/agent-tmux:5604-5619`). A synthesized result gives the better `result_updated` reason.

## (c) `prompt_via=argv` shell quoting

The existing helper `shell_quote` is already used for binary/session-id interpolation and returns zsh-safe `%q` quoting (`skills/tmux-agent-tools/scripts/agent-tmux:677-679`, `skills/tmux-agent-tools/scripts/agent-tmux:2853-2854`, `skills/tmux-agent-tools/scripts/agent-tmux:3164`). The minimal implementation should reuse it for the prompt argument:

```zsh
oneshot_prompt="$(prompt_with_result_path "$name" "$initial_text")"
cmd="$(shell_quote "$CLI_BIN") ${LAUNCH_FLAGS} $(shell_quote "$PROMPT_FLAG") $(shell_quote "$oneshot_prompt")"
```

Notes:

- Use a single argv for the prompt after `prompt_flag`; do not paste and do not split the prompt.
- `prompt_with_result_path` should still apply when `RESULT_PATH_VIA_PROMPT=true`, unless the chosen CLI profile explicitly disables it. That preserves the current Codex/generic behavior where sandboxed subprocesses may not expand `$TMUX_AGENT_RESULT` (`skills/tmux-agent-tools/scripts/agent-tmux:1781-1789`).
- The result/stdout paths must also be shell-quoted when embedded in the tmux command.
- `LAUNCH_FLAGS` is currently a raw string, including profile-provided values (`skills/tmux-agent-tools/scripts/agent-tmux:110-116`, `skills/tmux-agent-tools/scripts/agent-tmux:190-193`). Do not try to solve general shell-token parsing in this issue; document that `launch_flags` remains the existing raw shell fragment.

## (d) Edge cases and risks

| Area | Risk | Control |
| --- | --- | --- |
| Pane stays open | If oneshot exits and the tmux session closes, `wait-and-capture` returns `session_gone` before marker capture. | Preserve current `printf local command exited...; read _; exit "$code"` tail in the oneshot branch. |
| `status` semantics | `status --json` detects stopped state by pane text, not process state. | Print the exact existing `local command exited with code N` line after the oneshot marker. |
| `ping` semantics | `ping` sends Enter/C-u and may see timeout/dead for already-exited panes; that is acceptable because `status.running=false` should be authoritative. | Document that callers should not ping when `status.running=false`; this already matches skill guidance. |
| `wait` semantics | `wait` only checks stable pane output, so an exited oneshot pane can quickly become `stable` even if result synthesis failed. | Prefer `result --wait` / `result wait-required` for completion, and print marker only after result synthesis. |
| `wait-and-capture` marker | Prompt echo is not a problem in argv mode, but stale pane content could contain an old marker if the same exact session name is reused. | Existing `start --exact` kills the old session before new-session (`skills/tmux-agent-tools/scripts/agent-tmux:2847-2849`); also use the suffix code marker plus result mtime for automation. |
| Result synthesis | If jq is unavailable, result writing fails. | `start_session` already uses `JQ` for audit/transcript and result paths; explicitly `require_jq` in oneshot mode before new-session. |
| Output capture | Redirecting stdout/stderr only to `stdout.log` can make the pane look empty except wrapper lines. | Use `2>&1 | tee "$stdout_path"` if preserving visible pane output matters; otherwise log path in `result.json` is enough. Minimal path: redirect to log and print tail/summary if needed. |
| Exit code propagation | If result synthesis fails, the CLI exit code can be overwritten. | Store `cli_code=$?`, synthesize result best-effort, then print marker and exit using `cli_code`. |
| Profile precedence | New keys must obey existing profile precedence: use-time `--profile` / `--profile-dir`, env profile dir, user config, bundled defaults, then legacy preset. | Add keys to `load_cli_profile`; do not add new legacy preset branches. Existing search order is documented in code and README (`skills/tmux-agent-tools/scripts/agent-tmux:68-73`, `skills/tmux-agent-tools/scripts/profiles/README.md:9-21`). |
| Env override parity | Existing `_pref` env override only covers fixed uppercase settings, not arbitrary profile keys. | For minimal phase, profile-only keys are acceptable; add env overrides later only if needed. |
| Bundled profiles | Current `agy.conf` is interactive/codex-family-like and has no oneshot keys (`skills/tmux-agent-tools/scripts/profiles/agy.conf:1-8`). | Do not flip bundled `agy.conf` immediately unless tested against real agy; first support user-local opt-in. |
| Help/doctor visibility | `doctor --json` currently reports `approval` but not loaded profile path or new keys (`skills/tmux-agent-tools/scripts/agent-tmux:4435-4488`); text doctor reports profile path only (`skills/tmux-agent-tools/scripts/agent-tmux:4490-4499`). | Add text doctor lines for `exec_mode`, `prompt_via`, `prompt_flag`; add JSON checks later if useful. |

## (e) Minimal phased implementation plan

### Phase 1: profile surface only

- Add globals: `EXEC_MODE=interactive`, `PROMPT_VIA=paste`, `PROMPT_FLAG=''`.
- Parse/validate `exec_mode`, `prompt_via`, and `prompt_flag` in `load_cli_profile`.
- Update `scripts/profiles/README.md` supported-key table.
- Add a small self-test or shell fixture for profile parsing. No tmux session needed.

Exit criteria:

- Unknown values fail or warn consistently with existing profile validation style.
- Existing `claude.conf`, `codex.conf`, and `agy.conf` behavior remains unchanged.

### Phase 2: oneshot `start_session` branch

- In `start_session`, after state/env/result setup and before current `tmux new-session`, branch on `EXEC_MODE`.
- Require `initial_text` for `exec_mode=oneshot`.
- Require `prompt_via=argv` and non-empty `prompt_flag` for the first version.
- Build one tmux command that:
  - prints the normal wrapper header,
  - runs `<CLI_BIN> <LAUNCH_FLAGS> <PROMPT_FLAG> <quoted prompt>`,
  - captures stdout/stderr to `$TMUX_AGENT_DIR/<name>/stdout.log`,
  - writes synthesized `result.json`,
  - prints `__AGENT_TMUX_ONESHOT_EXIT__<code>`,
  - prints the existing local-exit line and keeps pane open.

Exit criteria:

- `result --json --wait` returns `present:true valid:true`.
- `status --json` reports `running:false exit_detected:true exit_code:N` after completion.
- `wait-and-capture --marker __AGENT_TMUX_ONESHOT_EXIT__ --timeout ... --json` can match while pane is retained.

### Phase 3: targeted tests

- Add one zsh/bash syntax gate if the repo already uses it.
- Add a fake CLI fixture that accepts `-p <prompt>`, prints the prompt, exits with configurable code, and proves:
  - prompt with spaces/newlines/shell metacharacters arrives as one argv,
  - `result.json` is synthesized on success,
  - non-zero exit produces failed result and marker with the same code,
  - interactive profiles still use paste path.

Exit criteria:

- No real agy/codex/claude invocation required.
- No new dependencies.

### Phase 4: optional real agy opt-in

- Only after fake fixture passes, document the user-local `agy.conf` example:

```ini
bin=agy-local
launch_flags=--dangerously-skip-permissions
exec_mode=oneshot
prompt_via=argv
prompt_flag=-p
heuristic_family=generic
result_path_via_prompt=true
```

- Keep bundled `agy.conf` unchanged until verified across real environments; the issue report proves one local setup, not universal bundled-default safety.
