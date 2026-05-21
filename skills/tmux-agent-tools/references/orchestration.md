# Multi-Agent Orchestration

Read this for `tmux-agent-fanout` (parallel run across multiple agents), `tmux-agent-dag` (dependency-ordered execution), and the `--pause-until-file` approval gate (human-in-the-loop). All three produce machine-readable summaries with `schema_version: 1`.

## Fan-out across mixed wrappers

`tmux-agent-fanout run` spawns one agent per `--agent tool:name` (mix `claude:` and `codex:` in one call) or one per `--workdir` (legacy single-tool form). Each child writes its own `result.json` under `--result-dir`; the parent emits a consolidated summary on stdout.

Summary schema: `schemas/fanout-summary.schema.json`.

```bash
tmux-agent-fanout run \
  --prompt-file ./prompt.txt \
  --agent claude:reviewer --workdir ~/repo \
  --agent codex:refactor  --workdir ~/repo \
  --result-dir /tmp/fanout-demo \
  --merge-mode all
```

### Merge modes

- `--merge-mode all` (default): `ok=true` iff every agent succeeds.
- `--merge-mode first-success`: `ok=true` if any agent succeeds. Remaining agents continue (they are **not** killed) and are still recorded in the summary.

### Failure isolation

Each agent's `result.json` is preserved on disk even if a sibling fails or times out. Wrapper exec failures synthesize a result file immediately so the parent fails fast instead of waiting for a never-written file.

### Deferred

Daemon, async, supervisor-tree, cross-agent cancellation: deferred. See `docs/design-issue-184-fanout.md`.

## DAG (dependency-ordered execution)

`tmux-agent-dag <manifest.json>` validates the full graph before executing anything, then runs tasks in topological order.

Manifest shape (JSON; YAML deferred):

```json
{
  "schema_version": 1,
  "fail_fast": true,
  "tasks": [
    {"name": "build",  "depends_on": [],         "command": "...", "result_path": "..."},
    {"name": "test",   "depends_on": ["build"],  "command": "...", "result_path": "..."},
    {"name": "deploy", "depends_on": ["test"],   "command": "...", "result_path": "..."}
  ]
}
```

### Validation (runs before execution)

Fails fast on: missing dependency, duplicate task name, self-dependency, cycle, duplicate dependency within one task.

Task names with spaces or special characters are supported — deps are stored with unit-separator delimiting, not space-split.

### Execution semantics

- `fail_fast: true` (default): on task failure, downstream tasks are marked `skipped`.
- `fail_fast: false`: independent branches continue; only the failed task's dependent subtree is skipped.

Parallel execution within a level: deferred. Full `when:` expression engine: deferred (documented in `docs/design-issue-186-dag-manifest.md`).

### Summary

Final JSON on stdout (and `--summary-out PATH`): `schema_version`, `ordered_tasks`, per-task `results[]` with `status: ok|failed|skipped`, `result_path`, `error`, plus overall `ok` bool.

## Human-in-the-loop approval gate

`wait-and-capture --pause-until-file <path>` blocks until an operator writes a decision file. This is the primitive for human review checkpoints in long agent runs.

```bash
marker=/tmp/agent-7/approve.txt
codex-tmux wait-and-capture --literal --marker '[NEEDS-APPROVAL]' \
  --pause-until-file "$marker" --pause-timeout 1800 worker
# Operator (another shell):
#   echo approve > "$marker"   → exit 0
#   echo reject  > "$marker"   → exit 7
#   (no write before timeout)  → exit 8
```

### Decision file contract

- Content starts with `approve` (case-insensitive, leading whitespace OK) → resume, exit 0.
- Content starts with `reject` → exit 7.
- Any other non-empty content → treated as reject with diagnostic.
- File missing or empty → keep blocking.

### Status while blocked

`$TMUX_AGENT_DIR/<name>/approval-status.json` shows `state: "awaiting_approval"` with the marker path. On resume, it is replaced with the final state.

### Transcript and audit events

When transcript is enabled, the wrapper records an `approval` event with `decision`, `marker_path`, `decided_at`. When audit log is enabled, `approval.approve` / `approval.reject` / `approval.timeout` events are appended to the chain.

See `docs/design-issue-185-approval-gate.md` for the full contract.

## When to use which

| Need | Tool |
| --- | --- |
| Run N independent agents on the same prompt, gather their results | `tmux-agent-fanout` |
| Run a pipeline where step B depends on step A's output | `tmux-agent-dag` |
| Pause one agent until a human approves before continuing | `wait-and-capture --pause-until-file` |
| Two-agent critique/debate | `tmux-agent-dialogue` (see `references/dialogue.md`) |
