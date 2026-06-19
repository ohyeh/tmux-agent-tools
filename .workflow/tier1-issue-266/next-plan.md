# Next implementation plan (post-#266) — endorsed

Synthesized with fixed teammate **codex**. Full proposal: `next-plan-codex.md` (endorsed as-is).

## Goal
Reduce manual lead supervision when several workers run the same packet: let the lead proceed on a **quorum** of usable results instead of `--any` (too early) or `--all` (one stuck worker blocks convergence).

## Why now (evidence, not speculation)
After #266 workers can declare `result_required_fields` and dry-run launch, but the lead still hand-polls `team results --json` or over-waits on `team wait --require-result` (all-or-nothing). The "first 2 of 3 reviewers with valid result.json" pattern has no primitive.

## Packets (sequenced — A first, B builds on the counting idea)
1. **Packet A — `watch --count N`**: watch met when ≥N named agents done (existing done def: result.json changed or session exited). Mutually exclusive with `--any`/`--all`. JSON adds `required_count`/`done_count`. Landing: `watch_session()` ~`agent-tmux:5125`.
2. **Packet B — `team quorum <team> --count N [--field <jq> --value <literal>] --json`**: count present+valid worker `result.json` (optionally matching a predicate); exit 0 when met. Reuses team state result paths + `result --json` body. Landing: `cmd_team()` dispatch ~`:5433`, helper beside `_team_results` ~`:5575`.

## Self-checks
`self_test_watch_count` (3 fake result paths, rewrite 2, assert `--count 2` → met) and `self_test_team_quorum` (3-worker team state, 2× `{"status":"success"}`, assert `--count 2` →0, `--count 3` →1). Gates: `ci-shellcheck` + `codex`/`claude` self-test.

## Out of scope (YAGNI)
worker DAG/`needs:`, profile inheritance, TUI, budget governor, done-webhook, result-schema migration, auto-cancel losing workers, semantic voting/tie-breaking.

<!-- ponytail: quorum = counting existing result.json; no new worker model, no new schema. DAG waits until a downstream worker actually needs a machine-readable upstream gate. -->

## Re-review corrections (codex, approved_with_changes — fold in before coding)
1. **Quorum predicate must match how fields are actually extracted.** `result_session --field` runs its arg as a **jq expression** (`:3768-3773`), so the example must be `--field .status` (not bare `status`) — OR intentionally adopt the `result wait-required` simple-field style (`status`, `verdict.status`). Pick one and fix examples + self-tests to match.
2. **Quorum must read the stored `result_path`, not `result --json <name>`.** `result --json` only reads `$(agent_root_dir)/$name/result.json` (`:3679-3684`); team state preserves each worker's `result_path` (`:5377-5411`). Read the row `result_path` directly (or factor a path-based result reader) — `result --json <name>` will miss workers whose result path differs.
3. **`watch --count` = explicit count mode**, not the default `mode=any`. Reject mixing `--count` with `--any`/`--all`; compute `done_count` from the existing `done_reason` map and break when `done_count >= required_count` (`:5128-5137,5175-5191`). Validate `--count` is a positive integer; decide `--count > #names` = usage error vs timeout-only.
4. **`self_test_watch_count` must use live tmux sessions** (or guard) — watch treats a **missing** session as done-by-exit (`:5181-5184`), so a pure fake-path test would pass for the wrong reason.
5. Update watch usage/help + JSON docs: `--any`/`--all` output unchanged; only count mode adds `required_count`/`done_count`.

Sequencing confirmed: A-before-B is reasonable but **not a hard code dependency** — B can ship independently.

## Status
#266 DONE: P1/P2/P3 implemented, codex adversarial pass fixed 3 edge cases (`b5d6d60`), gates green, pushed to `origin/tier1-issue-266` (`eabe408`). This file is the agreed starting point for the next branch.
