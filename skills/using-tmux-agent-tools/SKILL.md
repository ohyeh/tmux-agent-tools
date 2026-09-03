---
name: using-tmux-agent-tools
description: Meta-router for the tmux-agent-tools plugin. Invoke BEFORE choosing a wrapper or delegating any tmux-agent work — it decides inline vs worker, picks the right script, and points at the canonical capability table. Even a 1% chance this applies means invoke it.
---

# using-tmux-agent-tools

You decide inline vs worker, pick the wrapper, then defer to the
`tmux-agent-tools` hub skill for mechanics. You are not a wrapper.

## BYPASS — inline is the DEFAULT

Handle the task inline unless a named exception below fires. This is a
forcing gate, not ambient advice: record the winner BY NAME for inline and
worker outcomes alike — "it looks substantial" or "this is trivial" without
naming a bullet is not a valid gate pass.

Overrides (win over everything):
- `explicit-inline` — the caller says "inline" / "quick" / "don't spawn a worker".
- `single-known-command` — the whole task is one already-known command
  (test, build, lint), even when it touches many files.

Delegate ONLY when one of these four exceptions fires:
1. `independent-context` — the read-plan-write volume would flood the main
   context window (the commander does not do grunt work).
2. `parallel-or-background` — work must proceed while the main session
   continues, or several independent tasks run at once.
3. `different-engine` — the stage needs another CLI/model (second-model
   review, imagegen → Codex, profile-specific work).
4. `existing-teammate` — a follow-up in the same repo/domain where a
   persistent worker already holds context: send to THAT worker (after
   `result init`); never start a duplicate.

No exception fired → inline, receipt `no-delegate-trigger`.

## QUESTIONS — if delegating, one-shot or teammate? State which, and why.

- **One-shot** (one bounded answer, no follow-up of any kind) →
  interactive `start --task-shape bounded` (headed; the pane is the debug
  surface — `--headless` only when the user explicitly opted in); exactly one
  `result wait-required`, then `stop` unless keepalive was requested. Shell-safe
  name matching `[A-Za-z0-9._-]+`; arrange failure-safe cleanup equivalent
  to `trap cleanup EXIT` (success, wait failure, or interruption).
- **Teammate** (expect a second message to the SAME worker) → interactive
  `start` (no `--headless`); do not `stop` between tasks; reuse via
  `skills/tmux-agent-tools/references/multi-agent.md#persistent-teammates-worker-reuse`.

## ONE OWNER — `assign` is the supervision boundary

Dispatch one external CLI worker with one blocking `agent-tmux <cli> assign
<name> <directory> <prompt-file>` call. `assign` owns start, result init,
verified send, processing confirmation, and terminal supervision. Do not add a
native supervision proxy: while `assign` runs, no second supervisor may
concurrently call `status`, `capture`, `probe`, `result`, or another wait.
Hosting that one `assign` call inside a sub-agent is not a proxy — see below.

Keep the long supervise off the expensive main context: host that one blocking
`assign` in a cheap general-purpose sub-agent (model override, e.g. Sonnet), or
in a background task. The host still makes exactly one `assign` call — it hosts,
it does not proxy. Exception — a harness that reaps long-running tasks (local
Claude Code moves a foreground call to the background at ~600s; a background
task spawning its own tmux server was killed at ~10 min with exit 144,
2026-08-08) cannot hold the blocking wait in a sub-agent at all: a reaped
sub-agent has no `TaskOutput` to wait on its own task and can only report
in-flight (measured 2026-08-30). There, split dispatch from the wait: the PROXY
sub-agent runs `assign --detach` — a short call that returns as soon as the
worker is started and sent, so nothing can reap it — and the PARENT owns the
wait, harvesting with bounded `result wait-required --fields <csv> --wait <s>
--json` calls it runs itself as background tasks. Never host a BLOCKING
`assign` in a sub-agent under such a harness: it is reaped mid-wait and can
only report in-flight (three times, 2026-09-03). Never run `assign`, with or
without `--detach`, in the parent's own foreground — a dispatch gate blocks
it. Never leave a non-terminal report unattended: only a parent-owned task
re-invokes the session, one orphaned by a terminated
sub-agent notifies nobody. Never pipe a harvest call — a trailing `| tail`
reports `tail`'s status, so the wrapper's `exit 2` reads as success. A single
diagnostic call is allowed only when dispatch or harvest reports an abnormal
result.

A `pending` result is a TERMINATING PROCEDURE, not a verdict: wait out the bound
→ still pending, re-prompt the worker ONCE with the literal path from `result
--path <name>` and wait one more bounded round → only then may a pane capture
stand in, labelled UNCONFIRMED and never shipped as verified. `assign`'s
`result-path delivery UNCONFIRMED` warning is NOT evidence of a delivery
failure: for a profile with `heuristic_family=generic` the sentinel is never
marked by design (`_sentinel_trustworthy`), so the warning fires on every
dispatch while the path instruction is in fact re-injected on every send.
Diagnose a permanent `pending` from the worker's own state dir, never from
that warning — and note that a TUI which collapses pasted input (cursor shows
`[Pasted text #1 +N lines]`) cannot confirm or deny the marker from a pane
capture either. Stand the proxy DOWN BEFORE stopping the worker it
supervises. Never brief a proxy to return the
worker's output verbatim — it may not read that output, so the brief is
unsatisfiable; have the WORKER write to a declared artifact path and read it
yourself.

## SELECT — wrapper by task shape

- Loop-shaped chain (audit / plan→build / consensus / triage) → the
  `using-workflows` skill, not this router.
- ONE coding CLI as a supervised worker (most common) → `agent-tmux <cli>`
  (claude / codex / agy built in; gemini, cursor, custom via profile).
- Same prompt across MANY workers → `tmux-agent-fanout`; bounded TWO-party
  exchange → `tmux-agent-dialogue`. BOTH require the user's explicit
  authorization for count, tool, model, and effort — never assume it.
- Inspect / housekeep existing sessions → `tmux-agent-sessions` (resolve,
  inventory, cleanup) · live overview → `tmux-agent-dashboard`.
- Background & scheduled → `tmux-agent-cron` · dependencies → `tmux-agent-dag`
  · evidence polling → `tmux-agent-monitor` · alerts → `tmux-agent-notify`.
- Records → `tmux-agent-audit` / `tmux-agent-history` / `tmux-agent-replay`
  · worktrees → `tmux-agent-worktrees`.

Then read the chosen wrapper's row in the canonical capability table:
`skills/tmux-agent-tools/references/cheatsheets.md` → **Full script
capability table**. Never paraphrase that table from memory.

## DEFER — non-negotiable gates (mechanics live in the hub skill)

- **Prompt shape**: every worker prompt filled from `delegation-templates`
  (GOAL / ACCEPTANCE / REPORT + common footer + tmux addendum).
- **No cascade**: every worker prompt carries the literal ban
  "Do not spawn additional tmux sessions or delegate further." Only a Claude
  Code worker may still use its own in-process `Agent` tool (CLI-supervised,
  depth-capped); Codex workers have no equivalent exception.
- **Engine-only, never raw tmux**: no hand-rolled `send-keys` /
  `capture-pane` / `new-session`. Plain shell only for genuine gaps — say so.
- **Verify every send**: prefer `send-wait`. A timeout means submission is
  UNCONFIRMED — check liveness (`status --json`; `probe --metric
  tool_active`, or `--metric active_spinner` for claude) and resend only if
  idle. Never nudge with a raw Enter.
- **Preflight & safe invocation**: follow the hub skill's preflight
  contract (resolve the wrapper bundle, run `setup`, prompt-file for task
  text, `--secret KEY=URI` for credentials) before the first worker command.
- **After the result**: collect (`result --json`) → `stop`, or keep the
  teammate per the reuse protocol. Failure/blocked → follow up on the same
  worker, or escalate via `using-workflows` `findings-triage`.

## NOT-FOUND

Another skill already owns the task (commit workflow, PR review, …) →
receipt `other-skill-owner`, route there — no tmux worker. A capability no
wrapper covers → plain shell as a last resort, stated explicitly. Hub
reference: `skills/tmux-agent-tools/SKILL.md` (fast paths, result.json
contract, safety, `references/`).
