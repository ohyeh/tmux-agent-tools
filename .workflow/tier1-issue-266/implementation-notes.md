# Implementation notes — issue #266 (tier-1)

Running log of decisions that were **not** in the plan, scope corrections, and tradeoffs.
Source of truth for scope: `.workflow/tier1-issue-266/plan.md`. Target file: `skills/tmux-agent-tools/scripts/agent-tmux` (zsh, 5578 lines).

## Scope corrections found during empirical scouting (commander pass)

### P3 dry-run was already ~80% built — NOT a from-scratch packet
- `--dry-run` is already parsed in `start` (line 2447-2461 → `dry_run=1`).
- `run_dry_run_checks()` (line 1077) already runs preflight checks (workdir, tmux, cli binary, session conflict, sentinel, on-exit pairing, transcript) and the caller (2611-2615) does `exit $?` **before** the spawn path → already "exit without spawning".
- **Real gap (the only P3 work):** the dry-run output emits *checks*, but the plan/proposal spec asks to print the **resolved tmux invocation** (session name, launch flags, env namespace). So P3 = extend `run_dry_run_checks` to also emit a resolved-invocation block. Do **not** rewrite the function.
- Tradeoff: keeping the existing checks-JSON shape and *adding* an `invocation` object is backward-compatible; replacing it would break any caller parsing the current contract.

### P1 doctor readout — reuse `add_doctor_check`, don't touch the printf
- `doctor_session --json` (4258-4301) builds checks via `add_doctor_check name ok detail` then prints a fixed `{"ok",...,"checks":[...]}`.
- Decision: surface `approval` as `add_doctor_check "approval" true "$PROFILE_APPROVAL"` (always-ok, detail=resolved value). Reuses existing machinery, zero printf surgery. Semantically a config readout rendered as an always-pass check — acceptable laziness; flagged here so it's intent, not accident.
- Default: `PROFILE_APPROVAL=prompt` (zero behaviour change). Only `auto|prompt` accepted; unknown value → keep existing "unknown profile key" path is NOT triggered (key is known); instead validate value, fall back to `prompt` with a stderr warning. (Worker to confirm warning vs hard-fail — chose warn+default to preserve "zero behaviour change".)

### P2 result_required_fields — feed the existing missing_fields path
- The `missing_fields` jq machinery lives in `result wait-required` (1740+) and is driven by an explicit `--fields <csv>` flag.
- Decision: profile key `result_required_fields=a,b` becomes the **default** fields when `--fields` is not passed on `result wait-required`. Explicit `--fields` still wins (least surprise). This avoids a second validation code path — pure reuse.

## Verification gates
- `scripts/ci-shellcheck` (shellcheck >= 0.9 over all scripts/).
- `agent-tmux <cli> self-test` / `codex-tmux self-test` / `claude-tmux self-test`.
- New minimal self-checks per packet (zsh, matching existing test style).

## Open / to confirm

### Resolved during implementation

**P2 self-test: set -e + result_wait_required_session return 1**
- `result_wait_required_session` returns 1 on timeout/missing-fields (expected path).
- In a `set -euo pipefail` script, `var="$(cmd)"` propagates the non-zero exit to the outer shell, causing silent abort.
- Fix: `result="$(result_wait_required_session ...)" || true` on both case 1 and case 2 calls.
- Rule: always add `|| true` when capturing output from a function that has intentional non-zero exits, inside a `set -e` script.

**P1 self-test: trap + local var**
- `trap 'rm -rf "$tmp_dir"' EXIT` in a function uses a local var that is unset by the time the trap fires in a later function scope.
- Fix: replaced with explicit `rm -rf "$tmp_dir"` at each exit point.

**P2 self-test: TMUX_AGENT_DIR must be exported**
- `$()` subshells only inherit *exported* variables; plain assignment of `TMUX_AGENT_DIR` inside a function is invisible to `agent_root_dir()` called inside `$()`.
- Fix: `export TMUX_AGENT_DIR="$agent_dir"` before the subshell calls, restored after.

**P3 scope: only invocation object added, no rewrite**
- `run_dry_run_checks` output shape is backward-compatible: existing `checks[]` unchanged, new `invocation{}` appended at the top level.
- `session_for_name` called with `req_name` (no exact-name suffix logic needed for a preview).
