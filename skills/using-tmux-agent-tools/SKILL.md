---
name: using-tmux-agent-tools
description: Meta-router for the tmux-agent-tools plugin. Invoke BEFORE choosing a wrapper or delegating any tmux-agent work — it picks the right script and points at the canonical capability table, so it fires ahead of the tmux-agent-tools skill itself. Even a 1% chance this applies means invoke it.
---

# using-tmux-agent-tools

Meta-router for the tmux-agent-tools plugin. You are not a wrapper yourself —
you decide **which** wrapper a task needs (or whether to spawn one at all),
then defer to it.

## The Rule

Before spawning any tmux agent, delegating work, or answering a "how do I run
/ supervise / review / clean up agents" question: run the decision tree, pick
the wrapper, then read its real entry in `skills/tmux-agent-tools/SKILL.md`.
Never paraphrase that capability table from memory.

## Decision tree — task shape → wrapper

```
What does the task need?
│
├─ Not sure a worker is even warranted?
│   └─ .claude/agents/tmux-delegate.md   (inline-vs-worker gate — decide FIRST)
│
├─ Run ONE coding CLI as a supervised worker  (most common)
│   ├─ Claude Code        → claude-tmux
│   ├─ Codex CLI          → codex-tmux
│   ├─ Antigravity/agy    → agy-tmux
│   └─ any other CLI      → agent-tmux <cli>   (gemini, cursor, grok, custom)
│   (all four share one contract — read the exact row in the canonical table)
│
├─ Same prompt across MANY workers in parallel
│   └─ tmux-agent-fanout   (REQUIRES user-authorized count + tool/model/effort)
│
├─ BOUNDED exchange between TWO participants
│   └─ tmux-agent-dialogue   (pair-review / critic / debate / handoff;
│                             fixed turns + JSONL transcript, NOT open-ended)
│
├─ Read-only inspection / housekeeping of EXISTING sessions
│   ├─ which wrapper owns this session?        → tmux-agent-sessions resolve
│   ├─ inventory / diff / cleanup              → tmux-agent-sessions
│   └─ live overview instead of per-worker     → tmux-agent-dashboard
│
├─ Background / scheduled / dependency work
│   ├─ repeatable local automation (manifest)  → tmux-agent-cron
│   ├─ tasks with explicit dependencies        → tmux-agent-dag
│   ├─ periodic evidence polling (read-only)    → tmux-agent-monitor
│   └─ alert operator on a watched condition    → tmux-agent-notify
│
└─ Records & artifacts
    ├─ operator-facing event log (secrets, approvals, posts) → tmux-agent-audit
    ├─ prior run metadata (not live tmux)       → tmux-agent-history
    ├─ compare/replay transcript or audit runs  → tmux-agent-replay
    └─ list/prune agent-created git worktrees    → tmux-agent-worktrees
```

(Setup-only: `install-bin` links the wrappers onto PATH — not a task router target.)

## Canonical capability table

The authoritative per-wrapper "when to reach for it" table lives in
`skills/tmux-agent-tools/SKILL.md` → section **Script capability table**. Once
the tree points you at a wrapper, read that row for its exact contract. This
router intentionally does not restate it — one source of truth, zero drift.

## Router-level gates (do not skip)

- **Multi-agent authorization.** Never reach for `tmux-agent-fanout` or
  `tmux-agent-dialogue` without explicit user authorization for worker count,
  tool, model, and effort. Multi-agent sprawl is the biggest risk here.
- **No cascade spawning.** Every delegated worker prompt MUST carry the literal
  ban: "Do not spawn additional tmux sessions or delegate further."

For wait/supervise/marker mechanics, follow the Fast paths and Core Workflow in
`skills/tmux-agent-tools/SKILL.md` — not duplicated here.

## When NOT to route here

- A one-off shell command, single file read/search, or trivial inline work —
  do it directly. Spawning a worker for a 10-second job is the failure mode
  this router exists to prevent.
- Another skill already owns the task (commit workflow, PR-review skill, …).
- The user explicitly said "inline" / "quick" / "don't spawn a worker".

## Reference

- `skills/tmux-agent-tools/SKILL.md` — wrapper contracts, the capability table,
  the core workflow (supervise-before-send, wait patterns, approval gates),
  the profile system, the multi-agent playbook, and cheatsheets / multi-agent
  / contracts / security references.
