# Adversarial validation: fix the family/default model (Packet 0a)

Repo: /Users/paul.yeh/github/tmux-agent-tools (branch tier1-issue-266). REVIEW ONLY — no code changes, no push. Read `.workflow/tier1-issue-266/next-plan.md` (Packet 0a + 0b).

## Proposed change
The case arms at agent-tmux:25-30 set HEURISTIC_FAMILY. Problem: `codex` family doubles as the default bucket; `*)` (unknown CLI) silently maps to codex. Proposal:
1. Three peer families: claude | codex | generic. codex stops being the default.
2. `*)` unknown -> generic (conservative defaults, NOT codex's).
3. generic picks the SAFEST default per axis (e.g. result_path_via_prompt=true).
4. Delete unverified agy/cursor/grok arms (:27-29); let them fall to generic; re-add as profile files only when verified.
5. result_path_via_prompt: a declarative profile key, default per family (claude=false uses env; codex=true; generic=true). Packet 0b appends the result path to every prompt-send boundary when true.

## Your job — be adversarial, ground every claim in code
1. **Map EVERY site that branches on HEURISTIC_FAMILY** (known: :4402, :5020, :5044 use `== claude` else=codex-behavior). For EACH: what behavior does it gate? If a 3rd `generic` family hits the `else`, does it silently get codex behavior (the bug reappearing)? State the correct generic behavior per site.
2. Are there OTHER places that assume family is binary (claude vs not), e.g. resume keyword, usage kind, prompt heuristics, liveness/idle detection, anything keyed off _USAGE_KIND or RESUME_KEYWORD that correlates with family?
3. Is deleting agy/cursor/grok safe? Any references elsewhere (tests, docs, dialogue/fanout, profiles dir, install)? grep for them.
4. Is generic's `result_path_via_prompt=true` actually safe for a CLI that DOES read env (i.e., is a duplicated path-in-prompt harmless)? Any case where appending it breaks nonce/marker matching or prompt parsing?
5. Sequencing: must 0a fully land before 0b? Any partial-order that's safe?
6. Migration/back-compat: does demoting `*)` from codex to generic change behavior for anyone currently running an unlisted CLI? Is that acceptable or does it need a deprecation note?

Write verdict JSON to EXACT path:
/Users/paul.yeh/github/tmux-agent-tools/.workflow/tier1-issue-266/family-fix-result.json
Shape: {"verdict":"sound|sound_with_changes|flawed","branch_sites":[{"line":"","gates":"","generic_should":""}],"other_binary_assumptions":[...],"delete_agycursorgrok_safe":true|false,"refs_found":[...],"generic_prompt_default_safe":true|false,"sequencing":"...","backcompat":"...","blocking":[...],"notes":"..."}
Then say DONE_FAMILY.
