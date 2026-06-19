# Adversarial review brief

You are an ADVERSARIAL reviewer. Repo: `/Users/paul.yeh/github/tmux-agent-tools` (branch `tier1-issue-266`). Be skeptical — try to BLOCK. Default to finding real defects, not rubber-stamping.

## What to review
The uncommitted diff implementing 4 packets. Get it yourself:
- `git -C /Users/paul.yeh/github/tmux-agent-tools diff -- skills/` (the product code + docs)

## Authoritative spec
`.workflow/tier1-issue-266/next-plan.md` — the SINGLE SOURCE OF TRUTH. Every requirement, line-landing, and codex correction is there. Review the diff for FIDELITY to it.

## Focus areas (find concrete defects)
1. **0a family model**: are `cli_provider_env_keys`, probe metric set, and probe parsers all explicit 3-way (claude / codex / generic|*)? Does `generic` (and unknown family) inherit NO provider keys (no silent OpenAI/Codex credential leak)? Did agy/cursor/grok.conf stay UNCHANGED (they must)?
2. **0b result-path contract**: is `result_path_via_prompt` defaulted per family (claude=false, codex=true, generic=true), profile-overridable? Is the result-path line prepended BEFORE any nonce/marker at ALL four send sites (start/send/send-wait/send-wait-literal) so send-wait nonce matching is preserved? Do two non-exact workers in the same cwd get DISTINCT paths? Is the path == `result --path <name>`?
3. **Packet A watch --count**: explicit mode (not default any)? Rejects mixing `--count` with `--any`/`--all`? Validates positive integer? JSON adds `required_count`/`done_count` without changing `--any`/`--all` output?
4. **Packet B team quorum**: reads each worker row `result_path` directly (NOT `result --json <name>`)? `--field` is a jq expression? Correct count semantics + exit codes?
5. **`set -euo pipefail` safety**: any unbound-variable risk (all parser locals initialized before the parse loop)? any `$(cmd)` capturing an intentional non-zero exit without `|| true`?
6. **Self-tests**: do `self_test_watch_count` / `self_test_team_quorum` use LIVE tmux sessions (not fake paths that pass for the wrong reason)? Are they wired into the runner?
7. **Back-compat**: is the unlisted-CLI behavior change (codex→generic) documented?

## Output
Write your verdict JSON to this EXACT path: /Users/paul.yeh/.local/state/tmux-agent-tools/review/result.json
Fields: schema_version:1, status ("success"), summary, plus a `verdict` object:
`verdict.verdict` = ACCEPT | BLOCK | ACCEPT_WITH_CHANGES; `verdict.blockers` = array of concrete defects (file:line + why + fix); `verdict.notes` = anything else.
End your final pane message with the marker line exactly: === REVIEW DONE ===
