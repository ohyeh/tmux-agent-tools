# Codex adversarial review + convergence task — issue #266

You are the ADVERSARIAL REVIEWER and you OWN the convergence loop. Do not just give opinions — find real defects, FIX them in place, re-verify, and iterate until YOU have zero remaining objections.

Repo: /Users/paul.yeh/github/tmux-agent-tools  (branch `tier1-issue-266`, already checked out)
Under review: the last 3 commits (`git diff f7ea4b1..HEAD`) on ONE zsh script `skills/tmux-agent-tools/scripts/agent-tmux`.

## What was implemented (3 disjoint packets)
- P1 `08f32ca`: profile key `approval=auto|prompt` (default `prompt`) parsed into `PROFILE_APPROVAL`; `doctor_session --json` emits an `approval` readout via `add_doctor_check`.
- P2 `ec2df1d`: profile key `result_required_fields=a,b`; used as DEFAULT fields for `result wait-required` when `--fields` not passed (explicit `--fields` still wins); reuses existing `missing_fields` jq path.
- P3 `ab02c2d`: `--dry-run` already existed (`run_dry_run_checks`, exits without spawning); added a backward-compatible top-level `invocation{}` object (session, launch_flags, env_namespace, cli_bin) to its output.

Context: `.workflow/tier1-issue-266/plan.md` and `.workflow/tier1-issue-266/implementation-notes.md` (read both).

## Adversarial focus — hunt for these
1. **Correctness/edge cases:** approval value validation (unknown value → must warn + default to `prompt`, must NOT change behaviour); empty/whitespace `result_required_fields`; CSV with spaces; `--fields` vs profile precedence actually correct; dry-run `invocation` fields populated when bin is unresolved.
2. **Regression:** the unknown-profile-key `*)` arm still works; existing `doctor --json` consumers not broken by the new check; existing `result wait-required --fields` callers unchanged; existing dry-run `checks[]` shape unchanged.
3. **zsh correctness:** quoting, `set -euo pipefail` interactions, subshell var visibility, `${(j:,:)}` joins, no SC* shellcheck regressions.
4. **Self-test quality:** do the new self-checks actually fail if the feature breaks? (mutation-test mentally). Are they hermetic (no leftover tmux sessions / temp dirs)?
5. **Security/secrets:** dry-run invocation preview must not leak secret values; no profile value sourced/eval'd.

## Your loop (repeat until clean)
1. Review the diff + read the touched regions of the script.
2. For each real defect: FIX it directly in the file (surgical, ponytail-minimal), and if a self-check is weak, strengthen it.
3. Re-run BOTH gates: `scripts/ci-shellcheck` and `skills/tmux-agent-tools/scripts/agent-tmux codex self-test` (and `claude self-test`). Both must be RC=0.
4. If you changed code, commit with a conventional message referencing #266 (amend is fine only for trivial fixups to the same packet; otherwise a new `fix(...)` commit). End each commit body with:
   Claude-Session: https://claude.ai/code/session_019MRqpnLhJSsz4Ucbq5kMn5
5. Repeat until you have NO further objections.

Do NOT push. Do NOT bump version/CHANGELOG/manifests.

## Output — write your final verdict as JSON to this EXACT path
/Users/paul.yeh/github/tmux-agent-tools/.workflow/tier1-issue-266/codex-review-result.json

JSON shape:
{
  "verdict": "clean" | "changes_made" | "blocked",
  "objections_remaining": 0,
  "fixes_applied": [ {"commit": "<hash>", "summary": "..."} ],
  "findings": [ {"severity":"high|med|low", "where":"file:line", "issue":"...", "resolution":"fixed|wontfix|note"} ],
  "shellcheck_rc": 0,
  "selftest_rc": 0,
  "final_head": "<git rev-parse HEAD>",
  "notes": "anything the orchestrator must know"
}
verdict must be "clean" only when objections_remaining == 0 and both RC == 0.
