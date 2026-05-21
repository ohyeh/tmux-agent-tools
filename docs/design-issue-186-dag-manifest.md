# Design — issue #186: DAG manifest validation + topological execution

Status: shipped
Schema version: 1
Supersedes: issue #113 v1 walker (`tool/prompt/workdir/after` schema)

## Problem

v0.10.0 closed #113 with `tmux-agent-dag` that **trusted manifest order** and
**skipped cycle detection**. A manifest that listed dependents before
dependencies, or contained a cycle, would either execute incorrectly or hang.
The walker provided no dry-run validation — failures only surfaced at runtime
after side effects had begun.

#186 makes the walker a real DAG executor: validate first, then execute in a
computed topological order.

## Goals

1. **Fail fast** on structural manifest errors before launching any task.
   Detect missing dependency references, duplicate task names,
   self-dependencies, and cycles.
2. **Topological execution.** Compute an order via Kahn's algorithm and walk
   tasks in that order, regardless of how they appear in the manifest.
3. **Deterministic skip semantics** under both `fail_fast=true` and
   `fail_fast=false`.
4. **Stable JSON summary** with `schema_version: 1` for downstream consumers.

## Non-goals (explicitly deferred)

- **YAML manifests.** JSON only. Authors who want YAML can pipe through `yq`.
- **Parallel execution.** Walker remains strictly synchronous: one task at a
  time, in topo order. Parallelism is a separate workstream; correctness of
  the validator and ordering must land first.

## Manifest schema (canonical, v1)

```json
{
  "schema_version": 1,
  "fail_fast": true,
  "tasks": [
    {
      "name": "a",
      "depends_on": [],
      "command": "shell command string",
      "result_path": "/path/to/result.json"
    },
    {
      "name": "b",
      "depends_on": ["a"],
      "command": "...",
      "result_path": "..."
    }
  ]
}
```

Field semantics:

| Field | Required | Notes |
| --- | --- | --- |
| `schema_version` | yes | Must be `1` for this contract. |
| `fail_fast` | no (default `true`) | See execution semantics below. |
| `tasks[].name` | yes | Unique within the manifest. |
| `tasks[].depends_on` | no (default `[]`) | List of task names. Alias `after` accepted for compat with #113 v1. |
| `tasks[].command` | yes | Executed via `sh -c`. |
| `tasks[].result_path` | no | If set, file must exist after `command` exits 0 and `result.status` (if present) must equal `"ok"`. |

## Validation rules (pre-execution)

The walker performs all checks **before** running any `command`:

1. Manifest is valid JSON.
2. `tasks` is non-empty.
3. Every task has a non-empty `name`.
4. No two tasks share a `name` (duplicate detection).
5. No task lists itself in `depends_on` (self-dependency).
6. Every entry in any `depends_on` refers to a declared task (missing dep).
7. The dependency graph is acyclic (Kahn's algorithm; on failure, walker
   walks one remaining cycle and reports the path).

Any failure exits non-zero (typically `2`) and emits a JSON summary on stderr
with `ok: false` and an `error` describing the violation.

## Execution semantics

After validation, the walker:

1. Computes a topological order via Kahn (zero-indegree pick, manifest order
   as tiebreaker for stability).
2. Walks `order[]` synchronously. For each task `t`:
   - If any dependency of `t` is not `ok`, `t` is marked `skipped`.
   - Else if `fail_fast=true` and any earlier task in the walk failed, `t` is
     marked `skipped`.
   - Else `sh -c "$command"` runs. Success = exit 0 AND, if `result_path` is
     declared, that file exists AND its `.status` (if any) is `"ok"`.

`fail_fast` modes:

| Mode | Behaviour on failure |
| --- | --- |
| `true` (default) | Every subsequent task in topo order is `skipped`. |
| `false` | Only the failed task's transitive descendants are `skipped`; independent branches keep running. |

The transitive-skip in `fail_fast=false` is implemented by checking each
task's own `depends_on` against accumulated statuses — siblings with no path
to the failure proceed normally.

## JSON summary (stdout, also `--summary-out PATH`)

```json
{
  "schema_version": 1,
  "manifest": "<path>",
  "ordered_tasks": ["a", "b", "c"],
  "results": [
    {"name": "a", "status": "ok", "result_path": "...", "error": null},
    {"name": "b", "status": "failed", "result_path": "...", "error": "command exited with status 7"},
    {"name": "c", "status": "skipped", "result_path": "...", "error": "dependency not ok"}
  ],
  "ok": false,
  "at": "2026-05-21T01:23:45Z"
}
```

`status` is one of `ok | failed | skipped`. Exit code is `0` iff every task
ended `ok`.

## Migration from #113 v1

The v0.10.0 walker accepted `{tool, tasks[{name, workdir, prompt, after}]}`
and dispatched via `claude-tmux` / `codex-tmux`. That schema is **not**
supported in v1 of #186: the new schema is `{command, result_path}` and the
walker invokes `sh -c` directly. Callers that need agent dispatch should
construct `command` to invoke the wrapper themselves, e.g.:

```json
{
  "name": "build",
  "depends_on": [],
  "command": "claude-tmux start --exact build /repo 'build the thing' && sleep 60",
  "result_path": "/state/build/result.json"
}
```

`after` is accepted as an alias for `depends_on` so simple manifests from
#113 v1 continue to validate.

## Verification

`scripts/test-dag-validation-smoke` covers:

- valid out-of-order manifest → executes in topo order, all `ok`
- missing dependency → fails before execution
- cycle → fails before execution with cycle path
- duplicate task name → fails before execution
- self-dependency → fails before execution
- failed dep skips downstream (`fail_fast=true`)
- failed dep skips dependents only (`fail_fast=false`); independent branch
  still runs
