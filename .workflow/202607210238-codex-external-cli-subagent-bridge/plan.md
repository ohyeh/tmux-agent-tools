# Codex external CLI sub-agent bridge

## Goal

Make external CLI workers visible and traceable as Codex native sub-agents while
keeping `agent-tmux` as the execution engine.

## Approved behavior

- One Codex native proxy sub-agent represents exactly one external CLI worker.
- Proxy task names use `<cli>_<task>` in lowercase snake case.
- `codex_<task>` means an external `codex-tmux` worker; `native_<task>` means a
  Codex in-process sub-agent; inline work creates no sub-agent.
- Headless workers emit concise summaries on material progress changes and a
  heartbeat at least every 60 seconds while running.
- Headed workers report passive pane liveness and latest progress; `ping` is
  reserved for stale or unclear sessions.
- A valid external `result.json` remains the terminal evidence.

## Success criteria

1. The router selects native proxy supervision for an authorized external CLI
   worker when Codex native sub-agents are available.
2. The hub documents naming, progress, failure, and fallback contracts.
3. Routing evals cover external CLI proxy, headless, headed, native, and inline
   paths.
4. Existing packaging and smoke checks pass.
5. No new wrapper, daemon, dependency, or Codex App protocol patch is added.

## Constraints and limits

- The Codex App panel represents the native proxy, not the external process.
- Provider-specific icons and collapsed-card progress are not guaranteed by the
  current public app-server protocol and remain `UNCONFIRMED` until an App smoke.
- If native sub-agents are unavailable, launch the wrapper directly and report
  `UNAVAILABLE-NATIVE`; that worker will not appear in the Subagents panel.

## Approval

Approved by the user on 2026-07-21 with the requested CLI naming and separate
headless/headed progress policies.
