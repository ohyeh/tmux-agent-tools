# tmux-agent-tools

Drive long-running **Claude Code** or **Codex CLI** sessions inside tmux — programmatically, with consistent session naming, capture, wait, status, and cleanup.

This wiki teaches **two audiences**:

| Audience | Start here |
| --- | --- |
| **Human developer** opening a terminal | [Getting Started](Getting-Started) |
| **Agent / automation script** treating this as a skill | [Using as a Skill](Using-as-a-Skill) |

## What it is

A set of bash wrappers and helper binaries that turn the agent CLIs into something you can script against. Each agent gets a tmux session you can `send` prompts to and `capture` output from without stealing your terminal. State lives at `$TMUX_AGENT_DIR/<name>/` so multiple agents are independent and inspectable.

**Why not raw `tmux send-keys`?** Because every pane-state edge case (multi-line prompts, ANSI noise, marker echo, exit detection, progress probes, lock around concurrent sends) is already solved here. Raw `tmux` works for one-off demos and breaks the moment you script around it.

## What you get

| Capability | Tool |
| --- | --- |
| Run a Claude/Codex worker in tmux | `agent-tmux claude` / `agent-tmux codex` |
| Resume an existing CLI session inside tmux | `agent-tmux claude resume` / `agent-tmux codex resume` |
| Read-only inventory across all agents | `tmux-agent-sessions list` |
| Bounded two-agent dialogue | `tmux-agent-dialogue` (with `critic` / `debate` / `pair-review` presets) |
| Parallel agents on one prompt | `tmux-agent-fanout` |
| Dependency-ordered task graph | `tmux-agent-dag` |
| Hash-chained operator audit log | `tmux-agent-audit` (verify / query / rotate) |
| Sandboxed `git worktree` lifecycle | `tmux-agent-worktrees` (list / prune) |
| Replay / diff / redact transcripts | `tmux-agent-replay` |
| First-class multi-line paste injection | `send --from-file <abs-path>` |
| CLI-aware progress parsing | `probe --metric <metric> --json` |

All JSON surfaces carry `schema_version: 1`.

## Wiki map

- [Getting Started](Getting-Started) — install, hello-world, doctor
- [Using as a Skill](Using-as-a-Skill) — for agent operators and automation scripts
- [Recipes](Recipes) — single-agent, fanout, DAG, approval-gate, dialogue
- [Observability and Secrets](Observability-and-Secrets) — audit log, transcript, `--secret` backends
- [Troubleshooting](Troubleshooting) — failure mode cheatsheet
- [Contributing](Contributing) — repo layout, smoke tests, release process

## Conventions

- Code, identifiers, commands, filenames, API names remain in English.
- All examples in this wiki are copy-pasteable and tested against `main`.
- `--exact` skips the random suffix `start` normally appends. Use it whenever you need a stable name for later `send` / `capture` / `stop`.

## Non-goals

This project intentionally does **not** ship: resident daemons, hidden async autonomy, supervisor trees, cross-host non-repudiation, parallel DAG execution, or auto merge-back from worktrees. Every surface is operator-explicit and synchronous. See `docs/design-l5-l6-policy-block.md` in the repo for the full non-goal rationale.

## Source of truth

When the wiki and `skills/tmux-agent-tools/SKILL.md` disagree, the SKILL.md in the merged `main` branch wins. File an issue if you spot a drift.
