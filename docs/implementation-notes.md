# Implementation Notes — Overnight Run (2026-05-20 starting 20:30 CST)

Living doc capturing decisions, deviations, and trade-offs that were NOT in
the original issue text. Update entries chronologically. Latest at bottom.

## Scope reality

- Original goal: "complete all 33 issues + 2 discussions + 3 roadmaps before
  9am". This is not physically achievable in any single agent turn (LLM is
  turn-based, not background-resident). What this run will actually do:
  1. land a real, reviewable slice for #95 (P0/L1 sentinel + on-exit hook);
  2. keep partner codex-tmux session alive with chained tasks;
  3. produce design + notes so user can pick up at 9am with full state.

## Decisions made during #95 implementation

### D1 — Implement codex-tmux local start first; defer claude-tmux + ssh + resume
- Spec lists 6 launch sites (3 per wrapper × 2 wrappers).
- Single-turn risk: each is a shell-quoted one-liner; one bad quote bricks
  every launch path. Landing one site first, validating, then propagating
  is the safer order.
- Mirror to claude-tmux and to resume/start-ssh happens in follow-up commits.

### D2 — Flag names: `--sentinel`, `--on-exit`, `--sentinel-keep`
- Avoided `--exit-hook` to keep "sentinel" as the noun and "on-exit" as the
  action. Matches existing wrapper naming (`exit_detected`, `cli_exited`).
- `--sentinel-keep` is the safer-default opt-out, mirroring git-style
  `--keep` flags.

### D3 — Sentinel content is plain decimal exit code + newline
- RFC L3 (#100 transcript, #103 telemetry) would benefit from JSON, but the
  L1 mechanism issue (#95) was explicitly about a minimal signal.
- Keeps consumers to one line of shell: `[[ "$(cat $f)" == 0 ]] && ok`.
- JSON migration path: add `--sentinel-format=json` later, default stays
  plain. No breaking change forced now.

### D4 — Stale sentinel aborts start
- Risk: silent reruns thinking a previous run completed. Aborting forces
  the operator to choose between cleanup and a different path.
- Alternative considered: timestamp-suffix the sentinel automatically. Rejected
  because then the path is not predictable for external watchers.

### D5 — Hook invocation: `eval` inside a subshell, env-injected (revised post-review)

**Original design (broken):** Subshell + `eval "$HOOK" "$code" "$name"`
so `$1`=exit_code, `$2`=name. Looked clean for single-binary hooks.

**Partner-caught bug (PR #130 review):** for COMPOSITE hook commands the
trailing positional args land in the wrong place. The original issue's
own example `--on-exit 'curl -X POST $WEBHOOK'` eval'd as
`curl -X POST https://... 7 worker` — the `7` and `worker` became curl
arguments, not what the docs claimed. The issue's example didn't work.

**Revised design:** subshell with explicit `export` of two named env vars,
then `eval` the hook with no extra positional args:

```sh
( export ON_EXIT_CODE="$code" ON_EXIT_NAME="$name"; eval "$HOOK" ) \
  >> "$SENTINEL.hook.log" 2>&1 || true
```

Hooks now read `$ON_EXIT_CODE` and `$ON_EXIT_NAME` from the environment.
Works for both single-binary hooks (env exported to child process) AND
composite shell strings (variables resolve in eval's context).

**Sub-subtlety discovered during the fix:** `VAR=val eval "cmd"` sets
`VAR` only for eval-as-builtin and does NOT export to children. Smoke
caught this — single-script hook saw `MISSING` while composite hook
worked. Fix is explicit `export` inside the subshell so children inherit
it; subshell scope guarantees nothing leaks outside.

### D6 — Sentinel write strategy: tmp + rename
- POSIX-atomic on same filesystem. Readers see either no file or full
  content, never a partially-written `42` truncated to `4`.

### D7 — Defer `status --json` sentinel fields
- Adding `sentinel_path` + `sentinel_exit` to JSON status is described in
  the design doc, but means touching the status command paths which are
  jq-shape-tested. Doing it after the launch-path change lands keeps the
  blast radius smaller.

## Partner coordination

### Partner switch attempt (20:42 CST)

- User requested switch from codex-tmux partner to claude-tmux partner
  ("codex-cli-partner 改走 claude-tmux 喔 我先刪除了").
- Created `claude-cli-partner` via `claude-tmux start --exact partner ...`.
- Initial prompt remained in input box (Claude UI did not auto-submit);
  required two manual `tmux send-keys Enter` to dispatch.
- Partner reached Claude API with "Claude Opus limit reached, now using
  Sonnet 4" → API 404 ("model: claude-sonnet-4-20250514" not found).
- Tried `/model haiku`; Claude reported "Set model to haiku
  (claude-3-5-haiku-20241022)"; next prompt also returned 404 for the same
  model ID.
- Conclusion: this machine's Claude CLI does not currently have access to
  any working model. Partner session stays alive (`claude-cli-partner`)
  but produces no replies until the model situation is resolved.
- Solo mode continues. Original codex-tmux partner was deleted by the user;
  the design review on #95 captured before deletion is already preserved
  in this file (D1–D10 + SSH semantics table in the design doc).

### Original codex partner notes (preserved)

- codex-tmux partner session: `codex-cli-partner` (deleted by user before
  partner switch)
- First task sent: design proposal for #95.
- Marker mistake #1: I embedded `[PARTNER-95]` in the prompt text itself, so
  `wait-literal` matched the echo and returned before the partner actually
  produced output. Fix: split-marker pattern (`[PART` + `NER-95]`) in prompt
  text, wait for joined `[PARTNER-95]`.
- Marker mistake #2: For the review pass I asked the partner to OUTPUT the
  marker split as `[REV` + newline + `IEW-95]`. `tmux capture` showed both
  fragments on separate rows; `wait-literal '[REVIEW-95]'` cannot match
  across newlines and timed out. Fix going forward: the partner must
  OUTPUT the joined marker `[REVIEW-95]` on a single line; only the PROMPT
  description should split it.
- Partner review of #95 concluded:
  - Keep `--sentinel <abs-path>` (single file). Do not switch to
    `--sentinel-dir`.
  - Keep plain decimal exit code + newline. JSON belongs to L3.
  - Rename in docs to "exit-code sentinel file" so future readers do not
    assume structured payload. Applied to design doc.

## Smoke test evidence (2026-05-20 20:36 CST)

Edited script: `skills/tmux-agent-tools/scripts/codex-tmux` (NOT the brew
v0.3.0 binary at `/opt/homebrew/bin/codex-tmux`). To reproduce the test
results below, invoke via the absolute source path; brew install must be
re-bottled separately.

Fake CLI used:
```sh
#!/bin/sh
sleep 1
exit 7
```

Test results:

| Case | Command (abbrev) | Expected | Got |
|---|---|---|---|
| Happy path | `start --exact --sentinel /tmp/t95.exit --on-exit /tmp/hook-runner.sh t95c /tmp` | sentinel=`7\n`, hook log `code=7 name=t95c` | exact match at t=3s |
| Stale sentinel | repeat with existing `/tmp/t95.exit` | refuse with diagnostic | refused, exit ≠ 0 |
| Hook without sentinel | `start --exact --on-exit ... t95e /tmp` | warn, ignore hook, start session | warned, started OK |
| Relative path | `start --exact --sentinel relative.exit t95f /tmp` | refuse | refused, exit ≠ 0 |

### D8 — CLI flag ordering (decided post-impl)
- `--sentinel`/`--on-exit`/`--sentinel-keep` must come BEFORE positional
  `<name> <directory>` because the second flag-parsing loop runs before
  positional binding. This matches existing `--attach`/`--exact` style.
- An earlier smoke attempt put `--sentinel` after the name; wrapper
  correctly treated it as `<directory>=--sentinel` and failed with
  "Directory not found". Documented in usage line; user error not a bug.

### D9 — Test invocation requires source path, not brew binary
- The brew-installed binary is v0.3.0 and does not know the new flags.
- For overnight work, all sentinel-related testing uses
  `skills/tmux-agent-tools/scripts/codex-tmux` directly.
- Releasing this change requires the standard Formula bump path (still
  gated on operator go/no-go per v0.4–v0.6 roadmap convention).

## Post-review extensions in this run

- codex-tmux `resume` launch site (line ~385): mirrored. Same flag parsing,
  stale check, env propagation, and inline sentinel/hook block as local
  `start`. Verified by `zsh -n` and visual pattern parity. NOT
  end-to-end smoke tested because that needs a real Codex session UUID.
- claude-tmux `start` launch site: mirrored. End-to-end smoke tested with
  fake claude via `CLAUDE=/tmp/fake-claude.sh`; sentinel content `3`, hook
  log line matched. Same flag surface as codex-tmux.
- claude-tmux `resume` launch site: mirrored. `zsh -n` PASS, pattern parity
  with claude-tmux `start`. Still needs real Claude session UUID smoke.
- README "Event-driven completion" section added with flag table and
  contract rationale.
- CHANGELOG: added `## Unreleased` section documenting the new flags and
  the intentional non-coverage (start-ssh, JSON, status fields).
- `scripts/test-sentinel-smoke`: new reusable smoke runner that exercises
  both wrappers against fake CLIs. 4 cases / 8 sub-assertions, all pass.
  Reviewer can wire it into CI as a non-credential smoke check.

### D11 — Remove the `${SENTINEL:-/tmp/...}.hook.log` fallback (partner)

Original code had a defensive fallback when `TMUX_AGENT_TOOLS_SENTINEL`
was empty:

```sh
>> "${TMUX_AGENT_TOOLS_SENTINEL:-/tmp/tmux-agent-tools-hook}.hook.log"
```

Partner correctly pointed out this path is dead (we already clear
`on_exit_cmd` if no sentinel was given), but the dead-but-tempting
fallback would let a future refactor silently route every agent's hook
output into a single shared `/tmp/tmux-agent-tools-hook.hook.log` file.

Fix: hard-gate the hook block on BOTH variables being set:

```sh
if [ -n "$TMUX_AGENT_TOOLS_ON_EXIT" ] && [ -n "$TMUX_AGENT_TOOLS_SENTINEL" ]; then ...
```

If anyone ever wires `--on-exit` without `--sentinel` again, the hook
block is provably unreachable rather than silently writing to a shared
file. Belt-and-suspenders against future-self.

### D12 — Smoke runner now covers the composite hook case

Added two cases in `scripts/test-sentinel-smoke`:
- `codex-composite`: composite shell command using `$ON_EXIT_CODE` and
  `$ON_EXIT_NAME` with `&&` chain and redirect.
- `claude-composite`: same against claude-tmux.

Total 12 sub-assertions across 6 cases, all green. The composite case is
the regression test for partner's PR #130 finding — if anyone re-introduces
the positional `eval "$HOOK" "$code" "$name"` form, the composite case will
fail because the trailing args break the user's `&&` chain.

### D10 — Self-test stays untouched, smoke is a separate script
- Partner suggested adding sentinel coverage to `self-test`. Considered:
  embedding into `self_test_session()` adds risk of hangs (real `start`
  path now lives inside what was a synthetic-only routine).
- Decided to ship as `scripts/test-sentinel-smoke` instead so:
  - existing `self-test` semantics are unchanged;
  - the smoke can run from CI without overloading the in-binary self-test;
  - the test exercises BOTH wrappers in the same run.
- Self-test integration can still happen later by calling the script.

## Deliberate non-actions in this run

- codex-tmux `start-ssh` and claude-tmux `start-ssh`: not done. SSH remote
  launch needs a separate decision on whether the sentinel lives on the
  remote host (default and most natural) or whether the wrapper pulls a
  copy back. Partner and I agree this is a follow-up, not part of #95
  minimum. The flag could be parsed locally but written remotely; that is
  one design pass away.
- Formula bump and release tag: explicitly NOT in scope. v0.4–v0.6 roadmap
  convention requires reviewed release workflow + operator go/no-go.
- `git commit` / `git push` / PR creation: not done. Roadmap policy is
  "every mainline change goes through PR merge; no direct push to main",
  and these are review-required actions that should happen after the
  operator reviews the diff awake.
- README/CHANGELOG updates: not done. Pending review of the flag surface.
- Self-test integration: not done. `self-test` doesn't exercise sentinel;
  adding requires careful temp-file cleanup, deferred to its own slice.

## Trade-offs the reviewer should know

- The wrapper script tests (`self-test`, `doctor`) do not exercise sentinel.
  A follow-up test slice is required before claiming #95 complete.
- The design assumes local same-filesystem sentinel. SSH remote launches
  write the sentinel on the remote host; the operator must pull it back.
  We did NOT add a sync-pull helper. Listed as out-of-scope to keep #95
  small; consider a follow-up issue if remote pull becomes common.
