# Final report

The Codex integration now represents each authorized external CLI worker with
one native supervision-only proxy sub-agent. Codex App tracks the proxy; the
existing tmux wrapper remains the execution engine and `result.json` remains
terminal evidence.

Verified live with external `codex-tmux` and `claude-tmux` headless workers and
an `agy-tmux` headed worker. All three returned valid successful results and
their exact sessions were removed. The current native runtime does not accept
`gpt-5.6-luna` even though the host catalog lists it, so the documented runtime
fallback is `gpt-5.6-terra`; upstream issue #34399 tracks allowlist parity.

Release verification passed: 60/60 canonical smoke scripts, plus path lint,
shellcheck, both wrapper self-tests, Ruby syntax, and Homebrew style.
