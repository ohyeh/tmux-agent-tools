# CI Mode Exit Code Contract (issue #120 v1)

Stable contract for `claude-tmux start --ci` / `codex-tmux start --ci`
(or env `CLAUDE_TMUX_CI=1` / `CODEX_TMUX_CI=1`) and downstream tools.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success — agent ran and exited cleanly |
| 1 | generic error (catch-all for misc wrapper failures) |
| 2 | invalid argument / usage error (must be detected before tmux session creation) |
| 3 | prompt / permission wall detected (first-run auth, confirmation, etc.) |
| 4 | secret-missing (when #116 lands — placeholder; never emitted in v1) |
| 5 | schema validation failed (when #125 `--enforce` lands; placeholder) |
| 124 | timeout — `--max-runtime` / `--max-idle` fuse fired (#105) |

CI consumers should branch on these directly:

```bash
claude-tmux start --ci --result-schema schema.json worker ~/proj 'task'
rc=$?
case "$rc" in
  0)   echo "agent ok" ;;
  3)   echo "permission wall — manual intervention required" ;;
  124) echo "agent exceeded its time budget" ;;
  *)   echo "agent failed: rc=$rc" ;;
esac
```

## v1 scope (this PR)

- `--ci` flag and `CLAUDE_TMUX_CI` / `CODEX_TMUX_CI` env are now
  recognized at `start` time
- Per-agent state under `$TMUX_AGENT_DIR/<name>/ci-mode` records whether
  the agent was launched in CI mode (1 = yes, file absent = no)
- Exit code 124 from #105 already aligned

## Deferred to v2

- JSON-by-default flip for all subcommands in CI mode (requires touching
  every subcommand individually; tracked separately)
- `doctor --ci` readiness check
- Pre-baked GitHub Actions workflow example
- Auto-coloring removal in CI mode
- Auto exit-3 when first-run permission wall is detected (depends on
  the existing `confirmation_detected` status diagnostic — wire that
  into the agent's exit in v2)

## Why ship v1 this small

The exit code table is the load-bearing contract. Even without the
JSON-by-default flip or doctor integration, callers can rely on the
documented codes for branching today. The deferred pieces add
convenience but do not require coordination — they can land
independently.
