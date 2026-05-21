# Design: `tmux-agent-fanout` runtime (issue #184)

## Goal

Add real operator controls to the v0.10.0 synchronous `tmux-agent-fanout`:
mixed wrappers per call, deterministic result aggregation, configurable
result directory, machine-readable summary, and merge modes.

## Surface

Canonical entrypoint:

```
tmux-agent-fanout run --prompt-file <prompt> \
    (--agent claude:foo --agent codex:bar ... | --workdir <dir> ...) \
    [--result-dir <path>] [--summary-out <path>] \
    [--merge-mode all|first-success] \
    [--timeout <seconds>] [--name-prefix <p>]
```

Legacy form (`--prompt-file` + `--workdir` only, no `--agent`) is
forwarded to `run` automatically for back-compat.

## Result directory

- Default: `$XDG_STATE_HOME/tmux-agent-tools/fanout/<run-id>/`.
- Each agent gets `<result-dir>/<agent-name>-<i>/result.json`.
- Path is printed to stderr at start so wrappers/callers can find it.

## Summary JSON contract (schema v1)

See `schemas/fanout-summary.schema.json`.

```json
{
  "schema_version": 1,
  "run_id": "<id>",
  "mode": "all|first-success",
  "agents": [
    {"name": "...", "tool": "claude|codex",
     "status": "ok|failed|timeout",
     "result_path": "...", "error": "..."}
  ],
  "ok": true
}
```

## Merge modes

| Mode            | `ok=true` when                  | Behavior on early success |
|-----------------|--------------------------------- |---------------------------|
| `all` (default) | all agents `ok`                  | wait all                  |
| `first-success` | any agent `ok`                   | wait all (do NOT kill)    |

### Explicitly deferred

- `majority` — needs quorum semantics and tie-break policy.
- `weighted` / `custom` — needs a DSL for predicates over agent outputs.
- These are deferred until a concrete operator need lands; ship issue
  + design doc before implementing.

## Failure isolation

Each child's `result.json` is written independently under the result dir
by the wrapper (real or test fake). A failing/timeout child does NOT
delete or overwrite sibling results. The fanout aggregates from disk
after the wait loop.

## Test strategy

`scripts/test-fanout-run-smoke` injects `TMUX_AGENT_FANOUT_FAKE_WRAPPER`
pointing at a stub script that:

- Reads `TMUX_AGENT_RESULT` to know where to write `result.json`.
- Honors a per-name exit/status policy file in the temp dir.

This avoids spinning up tmux sessions, keeping the smoke deterministic.

## Deferred (still)

- Daemon / supervisor tree / async dispatch.
- Cross-agent cancellation in `first-success`.
- Streaming progress (consumers poll `result_path`).
- Per-agent timeout overrides.
- Retry / restart policy.

These remain explicitly out of scope for issue #184.
