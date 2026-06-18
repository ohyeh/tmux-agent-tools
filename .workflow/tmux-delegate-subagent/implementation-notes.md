# tmux-delegate subagent v1 — Implementation Notes (running)

Brain: Claude (director). Implementer: codex worker via tmux-agent-tools.

## Decisions taken beyond the spec

- **OQ-1 path RESOLVED → `.claude/agents/tmux-delegate.md`.** Claude Code's real
  subagent discovery is `.claude/agents/*.md` with YAML frontmatter. The repo's
  `skills/tmux-agent-tools/agents/openai.yaml` is the Cursor/OpenAI *interface*
  schema (display_name/short_description/default_prompt) — a different mechanism,
  not a Claude Code subagent. We do NOT reuse it.
- **Frontmatter schema correction.** Spec tentatively wrote `allowed-tools:`.
  Real Claude Code subagent frontmatter uses `name:`, `description:`, `tools:`
  (comma-separated), `model:`. We ship the real schema. S8 audit maps every tool
  used in the body to the `tools:` list.
- **OQ-2:** `disable-model-invocation` NOT used (per spec).
- **OQ-4 / --resume:** dropped from v1 body (confirmed gap: `resume` needs a CLI
  UUID `start` never emits). Body carries a comment pointing to v2 task 3A-V2.
- **doctor --json must bypass `require_tmux`.** require_tmux hard-`exit 1`s before
  any JSON prints. The `--json` path treats tmux as an independent named check
  (`tmux`) alongside `agent_cli_binary`; never proves CLI-missing by wiping PATH.
- **JSON built without hard jq dependency** in the doctor path (manual printf with
  escaped details) so `doctor --json` works even if jq is one of the failing checks.
- **Manifest bump includes `.codex-plugin/plugin.json`.** The brief verification only
  checks Claude/Cursor manifests, but the authoritative plan lists all four plugin
  manifests; v0.19.0 keeps Codex metadata in lockstep.
- **`bash -n` gate required parser-portable cleanup.** The runtime remains zsh, but
  the verification block requires `bash -n`; two empty `if` bodies, zsh numeric
  globs, and a zsh glob qualifier were converted to parser-portable equivalents.

## Status
- Phase 1 (3A-1 doctor --json, 3A-2 setup): dispatched to codex.
- Phase 2 (3B subagent, 3C SKILL.md, 3E evals): dispatched to codex.
- Phase 3 (3D manifests 0.18.1→0.19.0 + CHANGELOG): dispatched to codex.
