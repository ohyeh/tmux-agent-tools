# Fix brief — dry-run must mirror real-start oneshot preconditions (review blocker, major)

You are a codex worker in `/Users/paul.yeh/github/tmux-agent-tools`, branch `feat/v3-sessionid-268-oneshot`.
Fix ONE review blocker. Surgical. DO NOT commit. Write result.json + unique marker. No new tmux sessions.

## The bug (confirmed)
Real `start` with `EXEC_MODE=oneshot` exits 2 when `PROMPT_VIA != argv` (agent-tmux ~3094-3098) or when
`initial_text` is empty (~3100-3102). But `run_dry_run_checks` (~line 1281) only builds the oneshot command
when `EXEC_MODE==oneshot && PROMPT_VIA==argv && -n initial_text`, and otherwise does NOTHING — so
`start --dry-run` reports `ok:true` for an oneshot config that real start will reject with exit 2. Dry-run must
predict real start.

## Fix (minimal)
In `run_dry_run_checks`, when `EXEC_MODE == oneshot`, mirror the real-start preconditions BEFORE/around the
existing oneshot_command build:
- if `PROMPT_VIA != argv` → `add_check "oneshot_prompt_via" "fail" "exec_mode=oneshot requires prompt_via=argv"`; `ok=0`.
- if `initial_text` empty → `add_check "oneshot_prompt" "fail" "exec_mode=oneshot requires initial text"`; `ok=0`.
- when both hold (argv + non-empty) keep current behavior and optionally `add_check "oneshot_command" "pass"`.
Match the existing `add_check`/`ok=0` style in that function exactly. Do not change real-start logic. Do not
touch interactive dry-run behavior (EXEC_MODE=interactive must stay ok:true as today). Ponytail: smallest diff.

## Test
Add a dry-run assertion (extend the existing dry-run self-test or test-oneshot-smoke, whichever is no-tmux):
- `exec_mode=oneshot` + `prompt_via=paste` → dry-run JSON `ok==false` with the oneshot_prompt_via fail check.
- `exec_mode=oneshot` + `prompt_via=argv` + empty prompt → `ok==false`.
- `exec_mode=oneshot` + `prompt_via=argv` + non-empty prompt → `ok==true` (unchanged happy path).
- `exec_mode=interactive` (default) → `ok==true` (unchanged).

## Verify before returning
- `zsh -n skills/tmux-agent-tools/scripts/agent-tmux` pass.
- `scripts/test-session-meta-smoke` still 58/0; `scripts/test-oneshot-smoke` still passes (+ your new cases).
- `agent-tmux claude self-test` ok.
- Manual: `agent-tmux claude --profile <oneshot+paste> start --dry-run --exact t /tmp hi` → ok:false now.

fd/rg/jq only. DO NOT commit. Return: files+lines, the check additions, test additions, verify outputs, deviations.
