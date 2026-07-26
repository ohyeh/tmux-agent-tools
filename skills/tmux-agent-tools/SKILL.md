---
name: tmux-agent-tools
description: Use when running or supervising AI coding CLIs as managed tmux workers via agent-tmux, claude-tmux, codex-tmux, agy-tmux, or tmux-agent-sessions. Covers start/send-wait/status/result/stop, structured result.json completion, multi-worker watch, profiles for custom CLIs, and bounded dialogue/fanout. Not for general tmux config, theming, non-tmux headless CLI use, or human team debate.
---

# Tmux Agent Tools

## Fast paths (read this first)

Non-negotiable rules:

1. **Engine-only — never type raw `tmux` at a worker.** Drive every worker through `agent-tmux <cli>` subcommands (`send-wait`, `status`, `result`, `capture`, `stop`); read-only inventory is `tmux-agent-sessions list`, not raw `tmux ls`. Raw `tmux` bypasses naming, redaction, result contracts, and cleanup. Before concluding the engine lacks a command, check the capability table below; plain shell is a last resort for genuine gaps — say why.
2. **A `send` is not done until submission is verified.** Bare `send` can leave text unsent in the input box. Default to `send-wait`: it appends a fresh nonce and waits for it, confirming the prompt landed.
3. **Every blocking wait takes a timeout — never hand-roll `sleep`/polling loops.** Multiple workers: one bounded `watch --any|--all|--count <n> --timeout <s> --json …`. Mixed-engine fleets: trust `reason:result_updated` or resolve with `tmux-agent-sessions`.
4. **Reusing a worker for a follow-up task?** `result init` first, then `send-wait`, then `result wait-required` — never reuse without `result init`, or the wait returns the stale prior result. Details: `references/multi-agent.md#persistent-teammates-worker-reuse`.

Fast answers:

- **Bounded task with no follow-ups?** Default to `start --headless`: the CLI runs non-interactively (`claude -p` / `codex exec`), completion is the process exit, and `result wait-required` returns immediately at exit (a contract-valid result.json is synthesized from exit code + stdout when the worker didn't write one). No TUI quirks, no pane-heuristic WAITING stalls. Interactive `start` is only for work that needs follow-up sends or mid-run supervision.
- **Wrapper not on PATH?** Run it from this bundle: `<skill-dir>/scripts/codex-tmux …`.
- **Auto-delegate substantial work?** Use the inline-vs-worker gate in the `using-tmux-agent-tools` skill (absorbed there, no longer a separate subagent); details live in `references/core-workflow.md`.
- **Long-running external CLI worker (Codex or Claude Code)?** When native sub-agents are available, MUST spawn exactly one cheap supervision-only proxy named `<cli>_<task>` (on Claude Code: a `general-purpose` sub-agent on `haiku`). The proxy exclusively owns the existing wrapper and makes one blocking `supervise` call; the parent MUST NOT run `start`/`send-wait` or poll that worker directly. See `references/core-workflow.md#native-proxy-for-an-external-cli-worker`.
- **Writing the worker prompt?** Shape it with the `delegation-templates` skill: GOAL / ACCEPTANCE / REPORT + common footer, plus its tmux addendum (no-cascade ban + literal result path).
- **New or renamed CLI?** Add a profile with `bin=…`, then prove it with `doctor --json` and `start --dry-run`; see `references/profiles.md`.

## Overview

`agent-tmux <cli> <command>` runs any AI coding CLI as a managed tmux worker. `claude-tmux`/`codex-tmux`/`agy-tmux` are shims for common CLIs (`claude-tmux start …` = `agent-tmux claude start …`). Other CLIs use `agent-tmux <cli>` plus an optional profile.

## Required preflight and safe invocation

Before the first worker command:

1. Resolve the wrapper bundle instead of assuming PATH. Probe, in order,
   `<repo-dir>/skills/tmux-agent-tools/scripts`,
   `~/.agents/skills/tmux-agent-tools/scripts`,
   `~/.claude/skills/tmux-agent-tools/scripts`, and
   `~/.codex/skills/tmux-agent-tools/scripts`; use bare wrapper names only when
   no bundle exists and PATH lookup succeeds.
2. Run the resolved `agent-tmux <cli> setup` and stop if preflight fails.
3. Pass the raw task as a separately quoted argument or prompt-file content.
   Never interpolate task text into `eval`, `sh -c`, or a constructed shell
   command.
4. Pass task-specific credentials only through `--secret KEY=URI`. Never embed
   credential values in task text or a constructed shell command.

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
| **Bounded task, result only, no follow-ups** | `start --headless` — headless one-shot (`claude -p` / `codex exec`), completion = process exit, no TUI/pane heuristics, no WAITING stalls |
| Interactive worker (follow-up sends, supervision) | `start` |
| Local working directory | `start` |
| Repo on another host, tmux stays local | `start-ssh` |
| Pin a model for one run | `start --model <m> <name> <dir> '<prompt>'` |
| Continue an existing CLI session UUID | `resume` (opt-in, off by default) |
| Don't know which wrapper owns a session | `tmux-agent-sessions resolve --name <n> --json` first |
| Two-party exchange / one-to-many work | `tmux-agent-dialogue` / `tmux-agent-fanout` |
| Read-only inventory or evidence polling | `tmux-agent-sessions` / `tmux-agent-monitor` |

Start flags precede positionals: `start --exact --model <m> <name> <dir>`; a misplaced flag exits 2.

Full capability table (every subcommand + when to use it): `references/cheatsheets.md`.

## When not to use

- A one-off shell command or a simple file read, search, test, or build — run it directly instead of spawning a worker.
- Externally visible, destructive, or privacy-sensitive work unless the user has already authorized it.

## The 6 commands you need most

```bash
# Bounded one-shot (headless, preferred for fire-and-collect tasks):
codex-tmux start --exact --headless job ~/repo 'Task. Write final JSON to the wrapper-provided result path when done.'
codex-tmux result wait-required job --fields status,summary --wait 600 --json   # returns at process exit
codex-tmux supervise --result-required --silent-while-unchanged --json job       # one silent call until terminal event
codex-tmux stop job

# Interactive one-worker flow (only when follow-ups are needed): start -> send-wait -> supervise -> stop.
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

Agents write `$TMUX_AGENT_DIR/<name>/result.json` with `schema_version: 1`, canonical `status` (`success|failed|blocked|needs-input`), `summary`, `artifacts`, and `errors` (optional `verdict`/`decision`). Codex/generic prompt sends inject the literal result path once per session; the worker cannot rely on `$TMUX_AGENT_RESULT` inside tool sandboxes. Branch in this order — never scrape the pane when a valid result exists: `.present -> .valid -> .body`.

```bash
codex-tmux result --json --wait 30 worker
codex-tmux supervise --result-required --silent-while-unchanged --json worker
```

If `.present:false`, the agent never wrote the file — re-prompt with the literal path from `result --path <name>`. Full schema, worked example, `status --json` fields, approval-gate exit codes, concurrency model: `references/contracts.md`.

## Safety

- Wrappers use permissive CLI flags by default (`--dangerously-skip-permissions` for Claude, `--yolo` for Codex). Never use for destructive, privacy-sensitive, externally visible, payment, or irreversible work without explicit user authorization.
- `status --json` reports `confirmation_detected:true` plus `blocked_reason` when a pane appears to wait for confirmation. It does **not** auto-accept; answer only after you trust it.
- Before spawning more than one worker: ask the user for tool+model+effort per worker, set a worker upper bound, and forbid cascade spawning in every prompt. Details: `references/multi-agent.md`.
- Secret injection (`--secret KEY=URI`, fail-closed) and audit log (`TMUX_AGENT_TOOLS_AUDIT_LOG`): `references/security.md`.

## References

Load these only when you hit the relevant scenario — they are not needed for routine use:

- `references/core-workflow.md` — full single-worker workflow, session naming, remote sessions, peer-review, approval gates, the inline-vs-worker gate.
- `references/profiles.md` — custom CLI profile keys, precedence, examples, detection overrides.
- `references/cheatsheets.md` — full capability table, scenario commands, marker pitfalls, failure triage.
- `references/multi-agent.md` — dialogue/fanout rules, bridge pattern, SSH participants, github-comment behavior.
- `references/contracts.md` — `status --json`/`result.json` schemas, approval exit codes, concurrency, inventory/cleanup.
- `references/security.md` — secret injection, audit log, environment overrides, pre-flight checks.
- `references/troubleshooting.md` — failure modes and fixes for stuck/unsent/stale-marker scenarios.
- `references/recipes.md` — copy-pasteable workflows (approval gate, fanout, DAG).

## Bundled schemas

`schemas/` ships `result-status-summary.schema.json` and `fanout-summary.schema.json` — the offline fallback the scripts already resolve for `result.json` validation when no other copy is found on disk.

The `agents/` subagent bundle (`tmux-delegate.md`, `claude-oneshot.md`, `codex-oneshot.md`) is retired — see CHANGELOG. The inline-vs-worker gate and the one-shot forwarding pattern they carried now live in the `using-tmux-agent-tools` skill's decision tree; there is nothing to install into `~/.claude/agents/` anymore.
