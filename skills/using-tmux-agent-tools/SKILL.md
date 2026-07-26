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
  `start --headless --task-shape bounded`; exactly one `result
  wait-required`, then `stop` unless keepalive was requested. Shell-safe
  name matching `[A-Za-z0-9._-]+`; arrange failure-safe cleanup equivalent
  to `trap cleanup EXIT` (success, wait failure, or interruption).
- **Teammate** (expect a second message to the SAME worker) → interactive
  `start` (no `--headless`); do not `stop` between tasks; reuse via
  `skills/tmux-agent-tools/references/multi-agent.md#persistent-teammates-worker-reuse`.

## NATIVE PROXY (ALL RUNTIMES) — external CLI as a native proxy sub-agent

When an external CLI worker is authorized, asynchronous, and the current
runtime exposes native sub-agents (Codex `spawn_agent`, Claude Code `Agent`
tool), exactly one cheap supervision-only native proxy per external worker is
REQUIRED. The parent MUST NOT run `start`/`send-wait`/`supervise` on that
worker directly — direct driving happens only inside the proxy. This is
supervision hygiene on every runtime; on Codex it is also an ownership and
observability bridge: the Codex App tracks the proxy's native thread while the
existing wrapper remains the execution engine.
Do not claim that the external process itself is a native sub-agent.

- Name the proxy `<cli>_<task>` using lowercase ASCII letters, digits, and
  underscores (`claude_auth_review`, `codex_test_fix`, `agy_ui_audit`).
  `codex_<task>` means `codex-tmux`; reserve `native_<task>` for work performed
  by a Codex in-process sub-agent without an external CLI.
- Before dispatch, pass `model-dispatch.md` and `delegation-templates`. On
  Claude Code the proxy is a `general-purpose` sub-agent on `haiku`
  (model-dispatch §4). On Codex prefer `gpt-5.6-luna` for shell supervision and
  progress summarization, fall back to `gpt-5.6-terra` when luna is
  unavailable, and use `gpt-5.6-sol` only when the
  proxy task itself needs frontier reasoning. Send a self-contained GOAL /
  ACCEPTANCE / REPORT brief. The proxy launches exactly the one named
  worker and MUST NOT edit the target itself, spawn another sub-agent, start any
  additional tmux session, or delegate further.
- After launch or attach, call `supervise --result-required
  --silent-while-unchanged --json` exactly once. Polling remains inside the
  deterministic wrapper process; unchanged state emits nothing and consumes no
  additional model turns. A valid terminal `result.json`, confirmed process
  loss, needs-input/blocker, or the overall supervision deadline ends the call.
- **Headed / persistent**: launch interactive `start`, then use the same blocking
  supervisor. Keep the worker alive when follow-ups were requested; inspect
  detailed liveness fields only after an abnormal supervisor return.
- The normal-call budget is one launch/attach, one blocking `supervise`, and its
  built-in terminal validation. One diagnostic `capture` is allowed only after
  abnormal termination or contradictory evidence; further calls require a new
  blocker hypothesis, not another elapsed interval.
- Keep the proxy brief slim: worker name, wrapper command, result contract,
  terminal states, and the no-concurrent-owner rule. Do not copy the worker's
  production task context into the supervisor prompt.
- Once assigned, all wrapper interaction transfers to the proxy. The parent MUST
  NOT call `status`, `watch`, `capture`, `probe`, `ping`, `result`, or send a
  follow-up unless the proxy reports blocked/lost-liveness, terminates
  unexpectedly, or the user explicitly requests direct inspection. The proxy
  reports only material state changes or its terminal result; periodic
  heartbeats and unchanged `running`/`waiting` narration are prohibited.
- `capture` is diagnostic-only: use it when status/process evidence conflicts,
  liveness is unknown, the worker exits without a valid result, or a blocker
  needs classification. Never capture merely because a wait interval elapsed.

If native sub-agents are unavailable, launch the selected wrapper directly and
report `UNAVAILABLE-NATIVE`: execution still works, but it will not appear in
the Codex App Subagents panel. Provider-specific panel icons and collapsed-card
progress are app behavior, not promises made by this skill.

## SELECT — wrapper by task shape

- Loop-shaped chain (audit / plan→build / consensus / triage) → the
  `using-workflows` skill, not this router.
- ONE coding CLI as a supervised worker (most common) → `claude-tmux` /
  `codex-tmux` / `agy-tmux` / `agent-tmux <cli>` (gemini, cursor, custom).
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
