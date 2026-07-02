---
name: tmux-agent-tools
description: Use when running or supervising AI coding CLIs as managed tmux workers via agent-tmux, claude-tmux, codex-tmux, agy-tmux, or tmux-agent-sessions. Covers start/send-wait/status/result/stop, structured result.json completion, multi-worker watch, profiles for custom CLIs, and bounded dialogue/fanout. Not for general tmux config, theming, non-tmux headless CLI use, or human team debate.
---

# Tmux Agent Tools

## Fast paths (read this first)

Non-negotiable rules:

1. **Engine-only — never type raw `tmux` at a worker.** Drive every worker through `agent-tmux <cli>` subcommands (`send-wait`, `status`, `result`, `capture`, `stop`). Raw `tmux` bypasses naming, redaction, result contracts, and cleanup. Before concluding the engine lacks a command, check the capability table below; plain shell is a last resort for genuine gaps — say why.
2. **A `send` is not done until submission is verified.** Bare `send` can leave text unsent in the input box. Default to `send-wait`: it appends a fresh nonce and waits for it, confirming the prompt landed.
3. **Every blocking wait takes a timeout — never hand-roll `sleep`/polling loops.** Multiple workers: one bounded `watch --any|--all|--count <n> --timeout <s> --json …`. Mixed-engine fleets: trust `reason:result_updated` or resolve with `tmux-agent-sessions`.

Fast answers:

- **Wrapper not on PATH?** Run it from this bundle: `<skill-dir>/scripts/codex-tmux …`.
- **Auto-delegate substantial work?** Use `tmux-delegate`; details live in `references/core-workflow.md`.
- **New or renamed CLI?** Add a profile with `bin=…`, then prove it with `doctor --json` and `start --dry-run`; see `references/profiles.md`.

## Overview

`agent-tmux <cli> <command>` runs any AI coding CLI as a managed tmux worker. `claude-tmux`/`codex-tmux`/`agy-tmux` are shims for common CLIs (`claude-tmux start …` = `agent-tmux claude start …`). Other CLIs use `agent-tmux <cli>` plus an optional profile.

## When to use

- Long-running Claude/Codex/agy/custom CLI work that needs later supervision.
- A worker must write structured `result.json` for a parent agent or wrapper.
- You need verified follow-up sends, liveness/status checks, bounded waits, or cleanup.
- Multiple workers need first/all/N completion via one wrapper `watch` call.

## Command choice

| Need | Use |
| --- | --- |
| Run Claude Code / Codex / agy as a worker | `claude-tmux` / `codex-tmux` / `agy-tmux` |
| Any other CLI (gemini, cursor, grok, custom) | `agent-tmux <cli>` (+ optional profile) |
| Local working directory | `start` |
| Repo on another host, tmux stays local | `start-ssh` |
| Pin a model for one run | `start --model <m>` |
| Continue an existing CLI session UUID | `resume` (opt-in, off by default) |
| Don't know which wrapper owns a session | `tmux-agent-sessions resolve --name <n> --json` first |
| Two-party exchange / one-to-many work | `tmux-agent-dialogue` / `tmux-agent-fanout` |
| Read-only inventory or evidence polling | `tmux-agent-sessions` / `tmux-agent-monitor` |

Full capability table (every subcommand + when to use it): `references/cheatsheets.md`.

## When not to use

- A one-off shell command or a simple file read, search, test, or build — run it directly instead of spawning a worker.
- Externally visible, destructive, or privacy-sensitive work unless the user has already authorized it.

## The 6 commands you need most

```bash
# Normal one-worker flow: start -> send-wait -> status/result -> stop.
codex-tmux start --exact worker ~/repo 'Task. Write final JSON to the wrapper-provided result path when done.'
codex-tmux send-wait worker 'Follow-up instruction.' 180
codex-tmux status --json worker
codex-tmux result --json --wait 30 worker
codex-tmux stop worker

# Multiple workers: block on first/all/N completion with one bounded call.
codex-tmux watch --any --timeout 600 --json w1 w2 w3
```

Full walkthrough: `references/core-workflow.md`.

## result.json completion contract

Agents write `$TMUX_AGENT_DIR/<name>/result.json` with `schema_version: 1`, `status`, `summary`, `artifacts`, and `errors` (optional `verdict`/`decision`). Codex/generic prompt sends inject the literal result path once per session; the worker cannot rely on `$TMUX_AGENT_RESULT` inside tool sandboxes. Branch in this order — never scrape the pane when a valid result exists: `.present -> .valid -> .body`.

```bash
codex-tmux result --json --wait 30 worker
codex-tmux result wait-required worker --fields status,summary --wait 60 --json
```

If `.present:false`, the agent never wrote the file — re-prompt with the literal path from `result --path <name>`. Full schema, worked example, `status --json` fields, approval-gate exit codes, concurrency model: `references/contracts.md`.

## Safety

- Wrappers use permissive CLI flags by default (`--dangerously-skip-permissions` for Claude, `--yolo` for Codex). Never use for destructive, privacy-sensitive, externally visible, payment, or irreversible work without explicit user authorization.
- `status --json` reports `confirmation_detected:true` plus `blocked_reason` when a pane appears to wait for confirmation. It does **not** auto-accept; answer only after you trust it.
- Before spawning more than one worker: ask the user for tool+model+effort per worker, set a worker upper bound, and forbid cascade spawning in every prompt. Details: `references/multi-agent.md`.
- Secret injection (`--secret KEY=URI`, fail-closed) and audit log (`TMUX_AGENT_TOOLS_AUDIT_LOG`): `references/security.md`.

## References

Load these only when you hit the relevant scenario — they are not needed for routine use:

- `references/core-workflow.md` — full single-worker workflow, session naming, remote sessions, peer-review, approval gates, tmux-delegate.
- `references/profiles.md` — custom CLI profile keys, precedence, examples, detection overrides.
- `references/cheatsheets.md` — full capability table, scenario commands, marker pitfalls, failure triage.
- `references/multi-agent.md` — dialogue/fanout rules, bridge pattern, SSH participants, github-comment behavior.
- `references/contracts.md` — `status --json`/`result.json` schemas, approval exit codes, concurrency, inventory/cleanup.
- `references/security.md` — secret injection, audit log, environment overrides, pre-flight checks.
