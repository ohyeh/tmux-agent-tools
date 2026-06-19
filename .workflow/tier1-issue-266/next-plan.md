# Next implementation plan (post-#266) — endorsed

Synthesized with fixed teammate **codex**. Full proposal: `next-plan-codex.md` (endorsed as-is).

## Goal
Reduce manual lead supervision when several workers run the same packet: let the lead proceed on a **quorum** of usable results instead of `--any` (too early) or `--all` (one stuck worker blocks convergence).

## Why now (evidence, not speculation)
After #266 workers can declare `result_required_fields` and dry-run launch, but the lead still hand-polls `team results --json` or over-waits on `team wait --require-result` (all-or-nothing). The "first 2 of 3 reviewers with valid result.json" pattern has no primitive.

## Packet 0a — fix the family/default model (PREREQUISITE to 0b; root cause)
The taxonomy is wrong: `HEURISTIC_FAMILY=codex` doubles as "codex" AND "default bucket for every non-claude CLI"; `*)` (`:30`) silently maps unknown CLIs to codex. Fix = **three peer families `claude | codex | generic`**, codex demoted from default to named peer, `*)` → `generic`.

**Codex validation verdict: flawed-as-first-written — these corrections MUST be in or the bug survives:**
1. **Provider-key leak is the worst branch (`:4401-4428` `cli_provider_env_keys`):** claude→Anthropic keys, **everything-else→OpenAI/Codex keys**. An unknown CLI silently inherits Codex/OpenAI credentials. `generic` must get an EXPLICIT branch that inherits NO provider keys by default (scrub deliberately, don't imply Codex).
2. **All family branches must become explicit 3-way, not `claude` vs `else`:** `:4401-4428` (provider keys), `:5020-5024` (probe metric set), `:5044-5108` (probe parsers). `generic` should use the generic progress/tool_active/approval_pending parsers + `PROFILE_PATTERN_*` overrides — but named explicitly, never via `else`.
3. **Do NOT delete `agy`/`cursor`/`grok`** (my earlier call was wrong): `delete_safe=false`. They have a shipped `agy-tmux` shim, `install-bin` step, stress-smoke ref, and bundled `agy/cursor/grok.conf` that set `heuristic_family=codex` and are loaded by `load_cli_profile()` BEFORE any fallback. Keep them as explicit named arms — being named ≠ being the silent default. The bug is the `*)` catch-all + docs, not the named arms.
4. **Docs/examples recreate the bug via profiles:** `profiles/README.md` (only documents claude|codex), `SKILL.md:83` (self-contradictory), `gemini.conf.example:7-8` teach `heuristic_family=codex` for new CLIs. Must add `generic` and stop teaching codex-for-new-CLI, or profiles re-seed the default-bucket model.
5. **Back-compat note required:** demoting `*)` codex→generic changes unlisted-CLI behavior (no `--yolo`, no provider-key inheritance, result-path-via-prompt on). Acceptable as a conservative safety correction but needs a migration/deprecation note.

`generic` defaults (safest per axis, NOT copied from codex): `result_path_via_prompt=true`, no `--yolo`, no provider-key inheritance, generic probe parsers.

## Packet 0b — result-path contract for env-strip CLIs (was "Packet 0"; rides 0a)
**Why first:** a sandboxed codex worker cannot read the wrapper-injected `$TMUX_AGENT_RESULT`/`$TMUX_AGENT_NAME` (env set only as tmux session env `:2465-2472`; `contracts.md:75-83`/`SKILL.md:196` already admit this), and with non-exact random-suffix names it cannot derive the path either. So it can't reliably write `result.json` — which means watch/quorum (Packets A/B) would have nothing to consume. Correctness papercut, every codex participant.

**Decision (codex debate):** rejected the cwd-sentinel idea (option A) — a single `<cwd>/.tmux-agent-result` clobbers when multiple workers share one repo cwd (pair/fanout/review norm); per-agent files reintroduce the in-sandbox name-locator problem. Chosen: **auto-append a result contract to every prompt-sending boundary** for codex-family CLIs: `Write final JSON to this exact path: <absolute result_path>`, computed from `agent_root_dir()/name/result.json`. No user flags; keep `result --path <name>` as the debug surface.
- Landing: prompt-send sites — `start` initial text `:2768-2772`, `send` `:3238-3248`, `send-wait` `:3347-3363`, `send-wait-literal` `:3410-3423`. Path source `:1227-1228`/`:2465-2472`.
- Out of scope this packet: `start-ssh` remote result placement (`:3074-3127`, already unresolved), `resume` (no prompt), new schema/sentinel format.
- Self-check: start two non-exact fake codex-family workers in the SAME cwd; assert each received a DISTINCT path equal to `result --path <its-name>`; a `send-wait` check that the augmented prompt carries the path without breaking nonce matching.

## Packets (sequenced — A first, B builds on the counting idea)
1. **Packet A — `watch --count N`**: an EXPLICIT count mode (not the default `mode=any`). Met when `done_count >= N` named agents are done (existing done def: result.json changed or session exited), computed from the existing `done_reason` map (`:5128-5137,5175-5191`). Reject mixing `--count` with `--any`/`--all`; validate `--count` is a positive integer (decide `--count > #names` = usage error vs timeout-only at impl). JSON adds `required_count`/`done_count`; `--any`/`--all` output unchanged; update usage/help. Landing: `watch_session()` ~`agent-tmux:5125`.
2. **Packet B — `team quorum <team> --count N [--field <jq> --value <literal>] --json`**: count present+valid worker results (optionally matching a predicate); exit 0 when met. **Read each worker's stored row `result_path` directly** (team state preserves it, `:5377-5411`) — NOT `result --json <name>`, which only reads `$(agent_root_dir)/$name/result.json` (`:3679-3684`) and would miss workers whose path differs; factor a path-based reader. `--field` is a **jq expression** (matches `result_session --field`, `:3768-3773`) so examples use `--field .status` (leading dot). Landing: `cmd_team()` dispatch ~`:5433`, helper beside `_team_results` ~`:5575`.

## Self-checks
`self_test_watch_count` — **must use live tmux sessions** (a missing session is treated as done-by-exit at `:5181-5184`, so pure fake paths would pass for the wrong reason): start 3 live workers, mark 2 done, assert `--count 2` → met. `self_test_team_quorum` (3-worker team state, 2× `{"status":"success"}`, assert `--count 2 --field .status --value success` →0, `--count 3` →1). Gates: `ci-shellcheck` + `codex`/`claude` self-test.

## Out of scope (YAGNI)
worker DAG/`needs:`, profile inheritance, TUI, budget governor, done-webhook, result-schema migration, auto-cancel losing workers, semantic voting/tie-breaking.

<!-- ponytail: quorum = counting existing result.json; no new worker model, no new schema. DAG waits until a downstream worker actually needs a machine-readable upstream gate. -->

## Review provenance
All codex corrections are now folded into the operative Packet text above (A: explicit count mode + live-session self-test; B: row `result_path` reader + jq `--field .status`; 0a: family-model fixes; 0b: prompt-boundary contract). No separate addenda — the packet text is the single source of truth.

Sequencing: 0a → 0b (0b rides 0a's generic/codex families); A before B is reasonable but **not a hard code dependency** — B can ship independently.

## Status
#266 DONE: P1/P2/P3 implemented, codex adversarial pass fixed 3 edge cases (`b5d6d60`), gates green, pushed to `origin/tier1-issue-266` (`eabe408`). This file is the agreed starting point for the next branch.
