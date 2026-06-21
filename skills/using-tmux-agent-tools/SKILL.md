---
name: using-tmux-agent-tools
description: Meta-router for the tmux-agent-tools plugin. Invoke BEFORE choosing a wrapper or delegating agent work — when starting any tmux-agent task including running a Claude/Codex/agy worker, parallel fan-out across multiple workers, bounded two-party dialogue/review/critic/debate, session inventory or cleanup, scheduled or dependency-ordered job manifests, periodic evidence monitoring, audit-log queries, or worktree management. Routes the task to the right script and points at the canonical capability table. Even a 1% chance this applies means invoke it.
---

# using-tmux-agent-tools

Meta-router for the tmux-agent-tools plugin. You are not a wrapper yourself —
you decide **which** wrapper or workflow a task needs, then defer to it.

## The Rule

Before spawning any tmux agent, delegating work, or answering a "how do I run
/ supervise / review / clean up agents" question: run the decision tree below,
pick the wrapper, then follow `skills/tmux-agent-tools/SKILL.md` for usage
details. Do not paraphrase the capability table from memory — read the real
entry.

If a task does NOT need a tmux agent at all (one-off shell command, single file
read/search, trivial inline work), say so and do the work directly. Spawning a
worker for a 10-second job is the failure mode this router exists to prevent.

## Decision tree — task shape → wrapper

```
What does the task need?
│
├─ Run ONE coding CLI as a supervised worker
│   ├─ Claude Code        → claude-tmux
│   ├─ Codex CLI          → codex-tmux
│   ├─ Antigravity/agy    → agy-tmux
│   └─ any other CLI      → agent-tmux <cli>   (gemini, cursor, grok, custom)
│
├─ Same prompt across MANY workers in parallel
│   └─ tmux-agent-fanout   (REQUIRES user-authorized count + tool/model/effort)
│
├─ BOUNDED exchange between TWO participants
│   ├─ pair-review / critic / debate / handoff → tmux-agent-dialogue
│   └─ (fixed turns, JSONL transcript — NOT open-ended N-round)
│
├─ Read-only inspection / housekeeping of EXISTING sessions
│   ├─ which wrapper owns this session?        → tmux-agent-sessions resolve
│   ├─ inventory / diff / cleanup              → tmux-agent-sessions
│   └─ live overview instead of per-worker     → tmux-agent-dashboard
│
├─ Background / scheduled / dependency work
│   ├─ repeatable local automation (manifest)  → tmux-agent-cron
│   ├─ tasks with explicit dependencies        → tmux-agent-dag
│   └─ periodic evidence polling (read-only)   → tmux-agent-monitor
│
├─ Records & artifacts
│   ├─ operator-facing event log (secrets, approvals, posts) → tmux-agent-audit
│   ├─ prior run metadata (not live tmux)      → tmux-agent-history
│   ├─ compare/replay transcript or audit runs → tmux-agent-replay
│   └─ list/prune agent-created git worktrees  → tmux-agent-worktrees
│
└─ Auto-decide inline-vs-worker for a substantial task
    └─ .claude/agents/tmux-delegate.md   (the delegation gate)
```

## Canonical capability table

The authoritative per-wrapper "when to reach for it" table lives in
`skills/tmux-agent-tools/SKILL.md` → section **Script capability table**. When
you have picked a wrapper from the tree above, read that section for its exact
contract rather than relying on memory. This router intentionally does not
duplicate the table — a single source of truth prevents drift.

## Choosing the worker CLI (when the tree points at a worker)

- **claude-tmux** — Claude Code worker (start/resume/send/wait/capture/status/
  ping/result/cleanup). Default for long-running Claude Code work needing
  supervision, structured result files, markers, or liveness.
- **codex-tmux** — same contract, Codex CLI.
- **agy-tmux** — same contract, Antigravity/agy.
- **agent-tmux \<cli\>** — any other binary. Unknown CLIs get generic defaults;
  customize via `~/.config/agent-tmux/profiles/<cli>.conf`. Use `agent-tmux
  <cli> doctor` / `setup` / `start --dry-run` to validate a new profile.

## Anti-patterns this router prevents

- Spawning a tmux worker for a one-off command that `bash`/`fd`/`rg`/`jq` would
  answer in one call.
- Hand-writing a `while status; sleep` polling loop instead of one
  `codex-tmux watch --any|--all|--count` call.
- Reaching for `tmux-agent-fanout` or `tmux-agent-dialogue` without first
  getting explicit user authorization for worker count, tool, model, and
  effort — multi-agent sprawl is the single biggest risk in this plugin.
- Opening a new worker when an existing teammate already fits — always
  `tmux-agent-sessions resolve --name <n> --json` before `start`.
- Letting agents cascade-spawn: every delegated worker prompt MUST carry the
  literal ban "Do not spawn additional tmux sessions or delegate further."

## When NOT to route here

- The task is a knowledge question, an inline edit, or a single-tool lookup —
  answer directly.
- Another skill already owns the task (e.g. a commit workflow, a PR review
  skill). This router only covers tmux-agent-tools capabilities.
- The user explicitly said "inline" / "quick" / "don't spawn a worker".

## Reference

- `skills/tmux-agent-tools/SKILL.md` — full wrapper contracts, the capability
  table, the core workflow (supervise-before-send, wait patterns, approval
  gates), profile system, multi-agent playbook, and references to
  cheatsheets / multi-agent / contracts / security.
