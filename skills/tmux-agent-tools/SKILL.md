---
name: tmux-agent-tools
description: Use when Codex needs to run, supervise, or coordinate Claude Code or Codex CLI through local tmux sessions using the claude-tmux and codex-tmux wrappers. Triggers include starting named agent sessions, sending prompts to an existing tmux agent, waiting for terminal stability, capturing pane output, listing agent sessions, stopping sessions, or using start-ssh to keep tmux local while running the CLI on a remote host.
---

# Tmux Agent Tools

## Overview

Use `claude-tmux` and `codex-tmux` as the canonical interface for long-running Claude Code or Codex CLI sessions in tmux. Prefer these wrappers over hand-written `tmux send-keys` flows because they provide consistent session naming, capture, wait, status, and cleanup commands.

Use `tmux-agent-dialogue` when the task needs a bounded two-party dialogue with a JSONL transcript. Use `fake` participants for credential-free smoke tests. Treat real `codex` and `claude` participants as pre-release hardening work unless the user explicitly asks to run a real-agent smoke.

Local and SSH sessions keep the pane open after the agent CLI exits, showing the exit code so failures can still be captured.

The wrapper scripts are bundled with this skill at:

- `scripts/claude-tmux`
- `scripts/codex-tmux`
- `scripts/tmux-agent-dialogue`

If the commands are not installed on `PATH`, resolve them from the skill directory and run the script path directly.

## Command Choice

- Use `claude-tmux` when the requested worker should run Claude Code.
- Use `codex-tmux` when the requested worker should run Codex CLI.
- Use `start` for a local working directory.
- Use `start-ssh` when the tmux session should stay local but the agent CLI should run through SSH on another machine.

## When Not To Use

- Do not use tmux for one-off non-interactive shell commands; run those directly.
- Do not start a new tmux agent when a simple file read, search, test, or build command is enough.
- Do not use these wrappers for externally visible, destructive, or privacy-sensitive work unless the user has already authorized that work.

## Core Workflow

1. Start a session with a short stable name:

```bash
codex-tmux start --exact worker ~/github/project 'Read the repo and report the failing test.'
```

2. Send follow-up work without attaching:

```bash
codex-tmux send worker 'Now implement the smallest fix and run the targeted test.'
codex-tmux send-wait-literal worker 'End with the split marker described here.' '[CODEX-01]' 180
```

3. Wait for visible pane stability before reading output:

```bash
codex-tmux wait worker 180
codex-tmux wait-text worker 'Done|Need approval' 180
codex-tmux wait-text --literal worker '[CODEX-01]' 180
codex-tmux wait-literal worker '[CODEX-01]' 180
codex-tmux capture worker 120
```

Use `send-wait-literal` for marker-driven orchestration when stale pane content may already contain an older marker. Keep the literal out of the sent prompt or split it in the prompt instructions so the prompt echo itself cannot satisfy the wait. If multiline prompts remain in a CLI input box instead of submitting, increase `CLAUDE_TMUX_SUBMIT_DELAY` or `CODEX_TMUX_SUBMIT_DELAY`.

4. Inspect status or clean up:

```bash
codex-tmux status worker
codex-tmux status --json worker
codex-tmux doctor
codex-tmux self-test
codex-tmux stop worker
```

Use `wait-text --literal` or `wait-literal` when the expected text contains regex metacharacters such as `[`, `]`, `(`, `)`, `.`, `*`, or `?`. Use regex `wait-text` only when regex matching is intentional.

5. For bounded two-agent dialogue, write a prompt file and transcript path:

```bash
tmux-agent-dialogue --turns 4 --workdir . --agent-a fake --agent-b fake --prompt-file prompt.md --transcript transcript.jsonl
```

For a manual real-agent smoke after explicit authorization:

```bash
tmux-agent-dialogue --turns 2 --workdir . --agent-a codex --agent-b claude --prompt-file prompt.md --transcript transcript.jsonl
```

Real dialogue prompts use a split marker. The participant must end each turn with one standalone final line containing only the joined marker. If a marker wait times out, inspect the emitted `failure` JSONL event and captured pane tail before treating the run as a protocol failure.

For a local review preset that only writes a transcript and terminal summary:

```bash
tmux-agent-dialogue pair-review --workdir . --prompt-file review.md --transcript review.jsonl
```

`pair-review` does not post comments, merge PRs, or publish externally.

## Session Naming

- Without `--exact`, `start` appends a random suffix to avoid collisions.
- With `--exact`, the session uses the requested name exactly under the tool prefix.
- `send`, `capture`, `wait`, `status`, `attach`, and `stop` take the agent name, not the full tmux session name.

## Remote Sessions

Use `start-ssh` when the target repo is on another host:

```bash
claude-tmux start-ssh --exact review openclaw-macmini ~/github/project 'Review the diff and return findings only.'
```

Requirements:

- local machine has `tmux`;
- remote shell can resolve `claude` or `codex` on `PATH`;
- SSH target is already configured.

## Safety

- These wrappers launch agent CLIs with permissive flags: Claude uses `--dangerously-skip-permissions`; Codex uses `--yolo`.
- Do not use them for destructive, privacy-sensitive, externally visible, payment, or irreversible operations unless the user explicitly authorized that work.
- Prefer `capture` and `status` before assuming a worker is done.
- `claude-tmux status <name>` reports a diagnostic when the pane appears to be waiting for a Claude first-run or permission confirmation. It does not auto-accept that prompt.
- Prefer `doctor` and `self-test` before debugging agent behavior; they verify wrapper dependencies and tmux capture/wait behavior without starting a real agent.

## Environment Overrides

- `TMUX=/path/to/tmux`
- `CLAUDE=/path/to/claude`
- `CODEX=/path/to/codex`
- `CLAUDE_TMUX_PREFIX` / `CODEX_TMUX_PREFIX`
- `CLAUDE_TMUX_STABLE_SECONDS` / `CODEX_TMUX_STABLE_SECONDS`
- `CLAUDE_TMUX_CONF` / `CODEX_TMUX_CONF`
- `CLAUDE_TMUX_MOUSE` / `CODEX_TMUX_MOUSE`
