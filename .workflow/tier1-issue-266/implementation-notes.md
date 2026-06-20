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

---

# Next-plan packets (0a / 0b / A / B) — post-#266

Authoritative spec = `.workflow/tier1-issue-266/next-plan.md`. Same target file.

## Operating mode
- Commander mode: orchestrator (Claude) = brain (inventory/decide/dispatch/verify/gate). **All product code + review dispatched to codex** via `tmux-agent-tools` wrappers (`skills/tmux-agent-tools/scripts/codex-tmux`). Orchestrator does not hand-write product code beyond the 3 seed edits below.
- Gates per batch: `zsh -n` + `scripts/ci-shellcheck` + codex/claude self-test. Final: codex adversarial review until AGREE, then commit + push.

## Decisions / deviations

### D1 — profile files agy/cursor/grok.conf left UNCHANGED (codex final verdict)
next-plan.md 0a item 3: these are deliberate named arms (`delete_safe=false`; shipped shim + install-bin + stress-smoke refs). Being named ≠ being the silent default. The bug is the `*)` catch-all + docs, not the named arms. → No edit. Less surface, matches consensus.

### D2 — orchestrator pre-applied 3 of 4 Packet-0a code edits (seed)
Applied directly to `agent-tmux` (all `zsh -n` clean) before commander mode declared:
1. case arm `*)` → `HEURISTIC_FAMILY=generic` (was codex). Unknown CLI no longer silently codex.
2. `cli_provider_env_keys()` → 3-way `case`: claude (anthropic) / codex (openai+codex) / `generic|*)` inherits NO provider keys (worst credential-leak branch closed).
3. probe metric set → `case`: claude metrics / `codex|generic|*)` generic metrics.
codex picks up edit #4 (probe parsers) + docs + 0b/A/B.

### D3 — `generic|*)` catch in non-credential branches is intentional
For probe metric/parser (codex==generic behavior), `*)` folds unknown `heuristic_family` into SAFE generic parser. codex's "never via else" rule targets the *credential* branch (silent-codex = leak); parsers' catch-all maps to safe-generic, not codex.

## Status log
- (init) Plan re-read post-/clear. 3 seed edits applied + `zsh -n` clean. codex + tmux available. Dispatching remainder to codex worker.
- (batch1) codex implemented 0a edit#4 (probe parsers if→case) + 0a docs + 0b result-path contract. Orchestrator-verified gates: `zsh -n` OK, `ci-shellcheck` rc0, codex+claude self-test ok (new `result-path-prompt` self-check). Tasks 0a/0b done.
- (batch2) codex implemented Packet A (`watch --count N`) + Packet B (`team quorum --count`) with `self_test_watch_count` + `self_test_team_quorum` (live tmux). Orchestrator-verified: `zsh -n` OK, `ci-shellcheck` rc0, codex+claude self-test ok (`watch-count: ok`, `team-quorum: ok`). agent-tmux +521 lines total.

### Adversarial review outcome
- Round 1: codex (independent reviewer session, high effort) returned **BLOCK** — 2 blockers: probe metric set + probe parsers still used a folded `codex|generic|*)` branch instead of the explicit 3-way the plan (0a item 2) mandates. This overruled orchestrator decision **D3** (the lazy fold). Plan is SoT → complied.
- Fix: implementer split both into explicit `claude)` / `codex)` / `generic|*)`; the ~30-line generic parser was factored into a helper called by both the `codex)` and `generic|*)` arms (avoids duplication while staying explicit peers).
- Round 2: codex returned **ACCEPT**, no blockers, with extra independent verification (ci-shellcheck, zsh -n, git diff --check, generic provider-key check = 0 keys / codex = 2 hits, codex+claude self-test, probe smoke, test-help-smoke 42 passed/0 failed).

### Verification caveat — worker self-reports were NOT trusted
codex reported "gates passed" in result.json on BOTH batches while a transient mid-edit state still showed a runtime `team: parameter not set` at the quorum parser. Brain re-ran every gate independently; the error was a race during codex's own editing and was gone once codex went idle. Lesson: always re-run gates from the orchestrator; never accept a worker's "success" at face value, especially while `status --json` shows `running:true`.
