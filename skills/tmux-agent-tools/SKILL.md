---
name: tmux-agent-tools
description: Use when Codex needs to run, supervise, or coordinate Claude Code or Codex CLI through local tmux sessions using the claude-tmux and codex-tmux wrappers. Triggers include starting named agent sessions, sending prompts to an existing tmux agent, waiting for terminal stability, capturing pane output, listing agent sessions, stopping sessions, or using start-ssh to keep tmux local while running the CLI on a remote host.
---

# Tmux Agent Tools

## Overview

`claude-tmux` and `codex-tmux` are the canonical wrappers for long-running Claude Code or Codex CLI sessions inside tmux. They give you consistent session naming, capture, wait, status, and cleanup commands — preferable to hand-written `tmux send-keys` flows, which lose state on every change.

`tmux-agent-sessions list` is a read-only inventory across both tools and dialogue sessions. Exited-but-capturable sessions stay visible (panes are kept open with exit code) until cleanup. Use `cleanup --preview` before bulk cleanup; only use `cleanup --execute --all` or filtered execution when the user has authorized stopping tool-owned sessions.

The wrapper scripts live at `scripts/claude-tmux`, `scripts/codex-tmux`, `scripts/tmux-agent-dialogue`, `scripts/tmux-agent-sessions`, `scripts/tmux-agent-fanout`, `scripts/tmux-agent-dag`, `scripts/tmux-agent-worktrees`, and `scripts/tmux-agent-audit`. If they are not on `PATH`, resolve them from the skill directory and run by path.

## When to use which command

| Situation | Command |
| --- | --- |
| Run a Claude Code worker locally | `claude-tmux start` |
| Run a Codex CLI worker locally | `codex-tmux start` |
| Run the agent CLI on a remote host, tmux local | `<tool>-tmux start-ssh` |
| Continue an existing session ID inside tmux | `<tool>-tmux resume` |
| Bounded two-agent dialogue with transcript | `tmux-agent-dialogue` (see `references/dialogue.md`) |
| Parallel agents on one prompt, mixed wrappers | `tmux-agent-fanout` (see `references/orchestration.md`) |
| Dependency-ordered task graph | `tmux-agent-dag` (see `references/orchestration.md`) |
| Human-in-the-loop approval checkpoint | `wait-and-capture --pause-until-file` (see `references/orchestration.md`) |
| Read-only inventory | `tmux-agent-sessions list` |
| Audit chain / query / rotation | `tmux-agent-audit` (see `references/observability.md`) |

## When not to use

- One-off non-interactive shell commands — run them directly.
- A simple file read, search, test, or build — no agent needed.
- Externally visible, destructive, or privacy-sensitive work, unless the user has authorized it.

## Core workflow

### 1. Start

```bash
codex-tmux start --exact worker ~/github/project 'Read the repo and report the failing test.'
```

`--exact` skips the random suffix. Without it, `start` appends 6 chars to avoid collisions. To continue an existing session ID:

```bash
claude-tmux resume --exact worker ~/github/project ee5aca88-a1af-48d3-af21-54f60d618f22
```

### 2. Send follow-up

```bash
codex-tmux send worker 'Now implement the smallest fix and run the targeted test.'
codex-tmux send-wait-literal worker 'End with the split marker described here.' '[CODEX-01]' 180
```

`send-wait-literal` is the right choice for marker-driven orchestration when stale pane content may already contain an older marker. Keep the literal out of the sent prompt — otherwise the prompt echo itself can satisfy the wait.

### 3. Wait for stability

```bash
codex-tmux wait worker 180
codex-tmux wait-text worker 'Done|Need approval' 180
codex-tmux wait-text --literal worker '[CODEX-01]' 180
codex-tmux wait-literal worker '[CODEX-01]' 180
```

Use `wait-text --literal` or `wait-literal` when the expected text contains regex metacharacters (`[`, `]`, `(`, `)`, `.`, `*`, `?`). Use regex `wait-text` only when regex matching is intentional.

### 4. Read result

Prefer the structured surface over raw scrollback. Agents should write `$TMUX_AGENT_RESULT` (a JSON file); parents read it via:

```bash
codex-tmux result --field '.status' --wait 30 --json worker
```

When scrollback is needed, use `capture --strip-ansi --since-marker '<m>' --tail N` or `wait-and-capture --marker '<m>' --tail N --json` to avoid dumping the full ANSI-laden history. See `references/patterns.md` for the token-efficient and completion-signaling tables, plus the failure-mode cheatsheet.

### 5. Inspect or clean up

```bash
codex-tmux status worker
codex-tmux status --json worker
codex-tmux doctor
codex-tmux self-test
codex-tmux stop worker
```

`status --json` is the stable automation contract. See `references/patterns.md` for the field-by-field guarantee.

## Safety

- These wrappers launch agent CLIs with permissive flags (Claude `--dangerously-skip-permissions`, Codex `--yolo`). Do not use them for destructive, privacy-sensitive, externally visible, payment, or irreversible work unless the user has authorized it.
- `claude-tmux status <name>` reports a `diagnostic` when the pane appears to be waiting for a first-run or permission confirmation. It does not auto-accept that prompt.
- Run `doctor` and `self-test` before debugging agent behavior — they verify wrapper dependencies and tmux capture/wait without starting a real agent.
- For secret injection, prefer `--secret KEY=URI` with `op://` or `keychain:` over plaintext files (see `references/observability.md`).

## Where to find more

| Topic | Reference |
| --- | --- |
| Completion signaling, token-efficient capture, result file contract, status JSON, failure modes, concurrency, cost | `references/patterns.md` |
| Two-agent dialogue + `critic` / `debate` / `pair-review` / `github-comment` presets, profiles, SSH | `references/dialogue.md` |
| `tmux-agent-fanout`, `tmux-agent-dag`, approval gate | `references/orchestration.md` |
| Audit log surface, secret backends, redaction | `references/observability.md` |
| Full environment-variable reference | `references/env-overrides.md` |
