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
the wrapper, then read its row in the canonical capability table (see below).
Never paraphrase that capability table from memory.

## Inline-vs-worker gate (decide FIRST)

This gate used to live in a dedicated `tmux-delegate` subagent def. That def
is retired (see CHANGELOG) — the decision logic below is what it carried,
unchanged, now living directly in this router instead of a separate file.

**This is a forcing gate, not ambient advice.** Before spawning anything,
running any wrapper command, or answering a "should this be a worker"
question, name the specific trigger below that fired (or that none did).
"It looks substantial" without naming a bullet is not a valid gate pass —
the requirement is an observable, checkable decision, not a vibe.

1. **Delegate or inline? Name which trigger fired.** Delegate when ANY of
   these are true:
   - Estimated wall time is more than 30s.
   - The task modifies 2 files or more.
   - The task needs an independent context window.
   - The task requires a multi-step read-plan-write cycle.
   - The task runs tests, builds, or lint across the codebase.
   - It is a follow-up task in the same repo/domain as an existing worker
     with clean context: prefer sending to that worker (after `result init`)
     over starting a new one.

   Handle inline when any of these are true instead:
   - The task is a single file read, search, or formatting request.
   - The task is a one-liner with immediate output.
   - The caller says "quick" or "inline".
   - The case is marginal or unclear; trivial is the safe default.

   Boundary: a single already-known command (test, build, lint) runs inline
   even when it touches many files — the delegate triggers above target
   multi-step work that needs reasoning, not one known command.

2. **If delegating, one-shot or teammate? State which, and why.**
   - Teammate (expect a follow-up message to the SAME worker — task series,
     review loop, cross-turn collaboration) → interactive `start` (no
     `--headless`); do not `stop` between tasks; reuse via the protocol in
     `references/multi-agent.md#persistent-teammates-worker-reuse`.
   - One-shot (one bounded task, no follow-up of any kind) →
     `start --headless --task-shape bounded`. This used to run inside a
     separate `codex-oneshot` / `claude-oneshot` forwarder subagent
     (also retired); run the same bounded sequence yourself now — start,
     exactly one `result wait-required`, then `stop` unless keepalive was
     requested — per the headless examples in
     `skills/tmux-agent-tools/references/core-workflow.md` and the Fast
     answers in `skills/tmux-agent-tools/SKILL.md`. Still inject the
     no-cascade guard verbatim in the worker prompt: "Do not spawn
     additional tmux sessions or delegate further."

## Decision tree — task shape → wrapper

```
What does the task need?
│
├─ Not sure a worker is even warranted?
│   └─ Inline-vs-worker gate above — decide FIRST
│
├─ Loop-shaped work — a whole audit / plan→build / consensus / triage chain?
│   └─ go to the `using-workflows` skill first (closed-loop recipes)
│
├─ Run ONE coding CLI as a supervised worker  (most common)
│   ├─ Expect to say a SECOND thing to the SAME worker — task series,
│   │    review loop, cross-turn collaboration → persistent teammate:
│   │    interactive `start` (no --headless); lifecycle & reuse follow the
│   │    worker-reuse protocol (do not improvise it):
│   │    references/multi-agent.md#persistent-teammates-worker-reuse
│   ├─ Continue a prior CLI session across worker restarts → `resume`
│   ├─ Certain ONE answer closes it, no follow-up of any kind
│   │    → add `start --headless`
│   │    (headless one-shot: `claude -p` / `codex exec`; completion = process
│   │     exit; no TUI quirks, no pane-heuristic WAITING stalls — DEFAULT here)
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
`skills/tmux-agent-tools/references/cheatsheets.md` → section **Full script
capability table** (linked from SKILL.md → `Command choice`). Once the tree
points you at a wrapper, read that row for its exact contract. This router
intentionally does not restate it — one source of truth, zero drift.

## After the result returns

- Success → collect it (`result --json`) → `stop` — or, in a teammate setting,
  keep the worker for the next round (worker-reuse protocol:
  `references/multi-agent.md#persistent-teammates-worker-reuse` in the
  tmux-agent-tools skill).
- Failure / blocked → follow up on the same worker (same reuse protocol), or
  escalate to the `findings-triage` recipe via the `using-workflows` skill.
- Next task in a series → reuse the same worker per that protocol — do NOT
  start a new one.

## Router-level gates (do not skip)

- **Multi-agent authorization.** Never reach for `tmux-agent-fanout` or
  `tmux-agent-dialogue` without explicit user authorization for worker count,
  tool, model, and effort. Multi-agent sprawl is the biggest risk here.
- **Prompt shape.** Fill every delegated worker prompt from the
  `delegation-templates` skill (GOAL / ACCEPTANCE / REPORT + common footer;
  its tmux addendum carries the no-cascade ban and the result-path line).
- **No cascade spawning.** Every delegated worker prompt MUST carry the literal
  ban: "Do not spawn additional tmux sessions or delegate further." A delegated
  worker that spawns its own workers creates fan-out the parent engine cannot
  supervise. "Delegate further" here means more tmux/engine workers
  (`agent-tmux`, fanout, dialogue) — not the worker's own in-process Claude Code
  `Agent` tool, a separate CLI-supervised, depth-capped mechanism that stays
  allowed.
- **Engine-only, never raw tmux.** Drive workers exclusively through
  `agent-tmux <cli>` subcommands. Never hand-roll `tmux send-keys` /
  `capture-pane` / `new-session` to start, message, read, or kill a worker —
  raw tmux skips session naming, redaction, and cleanup and leaves no
  verified-send path (`send-wait`), a common cause of lost prompts and
  orphaned sessions. Plain shell is a last resort for genuine gaps; say so when
  you fall back.
- **Verify every send.** Prefer `send-wait`, which generates a fresh nonce and
  waits for it (`send-wait-literal` waits for a *new* occurrence of your literal
  vs a pre-send count — pick a unique one, since unrelated later output emitting
  the same literal would false-positive). A timeout means submission is
  *unconfirmed* (unsent,
  or the worker is slow/stuck) — check liveness (`status --json` for `running`,
  `probe --metric tool_active <name>` (or `--metric active_spinner` for claude)
  for the busy signal, since `status`/`ping` expose none) and resend only if
  idle. Never "nudge" with a raw `tmux send-keys Enter`.

For wait/supervise/marker mechanics, follow the Fast paths in
`skills/tmux-agent-tools/SKILL.md` and its `references/core-workflow.md` — not
duplicated here.

## When NOT to route here

- A one-off shell command, single file read/search, or trivial inline work —
  do it directly. Spawning a worker for a 10-second job is the failure mode
  this router exists to prevent.
- Another skill already owns the task (commit workflow, PR-review skill, …).
- The user explicitly said "inline" / "quick" / "don't spawn a worker".

## Reference

- `skills/tmux-agent-tools/SKILL.md` — the hub: fast-path rules, command
  choice, the result.json contract, safety, plus links into `references/`
  (core-workflow, cheatsheets incl. the capability table, profiles,
  multi-agent, contracts, security, troubleshooting, recipes).
