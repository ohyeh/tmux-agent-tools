# Adversarial review brief — v3 session-id + #268 oneshot (full diff)

You are a codex ADVERSARIAL reviewer in repo `/Users/paul.yeh/github/tmux-agent-tools`, branch
`feat/v3-sessionid-268-oneshot`. Your job is to BREAK this change, not bless it. Default to skepticism:
assume there ARE bugs and find them. DO NOT edit code. DO NOT commit. Write result.json (path in your prompt)
with a `verdict` and print a unique end marker.

DO NOT spawn tmux sessions / other workers / background jobs / SSH.

## What to review
The full diff of this branch vs main:
```
git --no-pager diff main...HEAD -- skills/tmux-agent-tools/scripts/agent-tmux scripts/test-session-meta-smoke scripts/test-oneshot-smoke skills/tmux-agent-tools/scripts/profiles/README.md
```
Commits: P1 96e1799 (profile keys), P2 7b87900 (claude supplied-id), P3 3d020a1 (codex/agy transcript), P4 (oneshot).

## Spec to check against (the change MUST conform)
- `.workflow/v3-structured-session-id/design-proposal.md` (frozen impl spec, incl. agy round-3 addendum)
- `.workflow/issue-268-oneshot/goal-doc.md` (success criteria + non-goals)
- `.workflow/v3-structured-session-id/implementation-notes.md` (what each phase claims)

## Adversarial checklist — hunt specifically for
1. **Behavior change leak**: anything that alters claude/codex/agy/cursor/grok behavior when keys are at
   defaults (interactive/paste/empty/off). Default-off MUST be byte-for-byte today's behavior.
2. **Writer race / double-write**: any path where both the structured/supplied writer AND the pane capturer
   could write session-meta.json (TOCTOU). Confirm mutual exclusion holds for supplied/transcript/off.
3. **--session-id leakage to non-claude CLIs**; full UUID printed in banners/logs/result (should be redacted
   except behind AGENT_TMUX_SHOW_SESSION_ID).
4. **Correlation soundness**: codex newest-new selection accepting a decoy/old file; payload.id/cwd checks
   bypassable; agy cache staleness guard wrong (mtime compare off-by-one / timezone / non-existent db). Any
   bail path that does NOT leave null or that emits a secret.
5. **Oneshot ordering**: cli_code captured AFTER result synthesis (wrong code); marker printed BEFORE
   result.json; pane closing early → session_gone; jq missing not failing closed; argv quoting breaking on
   prompts with spaces/quotes/`$`/backticks/newlines.
6. **Shell-injection / quoting** anywhere the prompt, uuid, paths, or profile values enter a command string.
7. **shellcheck/zsh -n** correctness, unset vars under `set -u` if used, subshell exit-code masking.
8. **Spec violations / scope creep**: bundled .conf changed; L-phase default-enablement snuck in; env-override
   parity added; prompt_via=argv applied to interactive.

## Method
Read the diff + spec. Re-run what you need (read-only): `zsh -n`, `scripts/test-session-meta-smoke`,
`scripts/test-oneshot-smoke`, `agent-tmux <cli> self-test`, targeted `start --dry-run` cases. Use fd/rg/jq only.
For each issue: give file:line, why it's a bug, a concrete repro/trigger, severity (blocker/major/minor/nit),
and a suggested fix direction (do not implement).

## Return (result.json + marker)
Write `result.json` with `schema_version:1, status, summary`, and a `verdict` block:
`{ "verdict": "ACCEPT" | "ACCEPT_WITH_CHANGES" | "BLOCK", "blockers": [ {file,line,severity,issue,repro,fix} ], "notes": "..." }`.
Be honest: if it's genuinely clean, ACCEPT and say what you verified. If uncertain, lean toward flagging.
End with a unique marker.
