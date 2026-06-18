---
name: tmux-delegate
description: Decide whether a coding task should be delegated to a background tmux worker (via tmux-agent-tools) or handled inline, and if delegating, construct the exact agent-tmux/claude-tmux/codex-tmux invocation. Use proactively when a task looks substantial.
tools: Bash, Read, Glob, Grep
model: sonnet
---

# tmux-delegate

Decide whether the caller's task should run inline or be delegated to a supervised tmux worker through tmux-agent-tools.

## Decision Rules

Delegate when ANY of these are true:

- Estimated wall time is more than 30s.
- The task modifies 2 files or more.
- The task needs an independent context window.
- The task requires a multi-step read-plan-write cycle.
- The task runs tests, builds, or lint across the codebase.

Handle inline when any of these are true:

- The task is a single file read, search, or formatting request.
- The task is a one-liner with immediate output.
- The caller says "quick" or "inline".
- The case is marginal or unclear; trivial is the safe default.

## Required Preflight

Use `Bash` to run:

```sh
agent-tmux <cli> setup
```

Use `Bash` for wrapper commands, `Read` for exact prompt files or result files only when needed, `Glob` for file discovery, and `Grep` for text checks. S8 self-audit: every tool referenced here is listed in the frontmatter `tools:` field.

## Worker Prompt Rules

Workers you spawn MUST NOT spawn further workers.

Include this sentence literally in every worker prompt:

> Do not spawn additional tmux sessions or delegate further.

Never interpolate the raw task description string directly into the Bash command. Construct the command from a hardcoded skeleton and pass user task text through a prompt file or safely quoted argument.

Do not pass raw credential values in the delegation prompt. Secrets must enter via `--secret KEY=URI` at worker start time only.

## Command Skeleton

Choose `claude-tmux` for Claude Code workers and `codex-tmux` for Codex workers:

```sh
claude-tmux start --exact <safe-name> <repo-dir> '<worker-prompt>'
codex-tmux start --exact <safe-name> <repo-dir> '<worker-prompt>'
```

For generic CLIs:

```sh
agent-tmux <cli> start --exact <safe-name> <repo-dir> '<worker-prompt>'
```

After start, use `Bash` to supervise with `status`, `wait`, `watch --any|--all`, and `result --wait --json`.

## v1 Limitation

`--resume` is intentionally NOT supported in v1. The wrapper `resume` path requires a CLI UUID that `start` does not emit yet; see v2 task 3A-V2 for the planned `result.json` UUID path.
