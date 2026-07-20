# Implementation notes

- Reused the existing `agent-tmux` profiles, liveness fields, `probe`, `capture`,
  `ping`, bounded waits, and `result.json` contract.
- No external-agent registration endpoint exists in the inspected Codex
  app-server schema. A real native proxy thread is therefore required for the
  worker to appear under Subagents.
- `externalAgentConfig/*` imports external product configuration; it does not
  register external processes as sub-agents.
- Detailed progress in the collapsed Codex App card remains `UNCONFIRMED`; the
  proxy child thread is the guaranteed progress surface.
- `gpt-5.6-luna` is present in `codex debug models`, but the current native
  `spawn_agent` allowlist accepts only `gpt-5.6-sol` and `gpt-5.6-terra`.
  Routing therefore prefers luna and falls back to terra; upstream tracking is
  https://github.com/openai/codex/issues/34399.
- Live proxy smokes passed for external Codex CLI (headless), Claude CLI
  (headless), and agy (headed; its profile intentionally has no headless
  invocation). Every passing run returned valid schema-version-1 `result.json`
  and cleaned up its exact tmux session.
- `scripts/run-all-smokes` passed 60/60 on a non-PTY run with exit 0. A prior
  PTY run exposed GNU `timeout` job-control behavior (`SIGTTOU`) and was not used
  as release evidence.
