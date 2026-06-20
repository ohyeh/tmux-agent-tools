# Next implementation packet after #266

## Chosen item(s)

1. **Quorum aggregation for team results**
2. **Tiny `watch --count N` completion threshold**

These are the first wall a real multi-worker workflow hits after #266 because workers can now declare required result fields and dry-run their launch, but the lead still has to manually decide when "enough" workers have completed with usable `result.json` output.

## Why-now evidence

- `watch_session()` already blocks over N worker names and returns machine-readable per-agent completion state, but it only supports `--any` or `--all`. A common review pattern needs "first 2 of 3 reviewers with valid result.json", not first one and not all three.
- `team wait --require-result` already checks every worker for present+valid `result.json`, but it is all-or-nothing. One stuck or approval-blocked worker prevents the team from converging even when a quorum is sufficient.
- `team results --json` already reads each member result path from team state. The missing piece is a small aggregation contract over those existing result payloads, not a new worker model.
- The current team prompt already tells each worker exactly where to write its result. #266 added `result_required_fields`; quorum can reuse that result shape instead of inventing a new status file.

Concrete workflow that hits this first:

```text
lead starts 3 review workers
  ↓
lead broadcasts same packet
  ↓
workers write result.json with verdict/status
  ↓
lead wants to proceed when 2 valid results exist
```

Today the lead must poll `team results --json` or over-wait on `team wait --require-result`. That is exactly the kind of manual supervision #266 was reducing.

## Minimal interface

### Packet A: `watch --count N`

```sh
agent-tmux watch --count 2 --timeout 600 --json worker-a worker-b worker-c
```

Rules:

- `--count N` means the watch condition is met when at least N named agents are done.
- Done keeps the existing definition: `result.json` changed since watch start, or the tmux session exited.
- `--count` is mutually exclusive with `--any` and `--all`.
- JSON keeps the existing shape and adds `required_count` plus `done_count`.

Example JSON:

```json
{
  "schema_version": 1,
  "mode": "count",
  "required_count": 2,
  "done_count": 2,
  "met": true,
  "agents": [
    {"name":"rev-a","done":true,"reason":"result_updated"},
    {"name":"rev-b","done":true,"reason":"result_updated"},
    {"name":"rev-c","done":false,"reason":null}
  ]
}
```

### Packet B: `team quorum`

```sh
agent-tmux team quorum <team> --count 2 --field status --value success --json
```

Rules:

- Reads existing team state and each worker `result.json`.
- Counts only worker results that are present, valid JSON, and match the optional predicate.
- If no predicate is supplied, count present+valid worker results.
- `--field <jq-path>` uses the same simple field style as existing result extraction where practical.
- `--value <literal>` compares the extracted value as a string.
- `--json` emits a compact aggregation result and exits 0 when quorum is met, 1 otherwise.

Example JSON:

```json
{
  "schema_version": 1,
  "team": "review266",
  "required_count": 2,
  "matched_count": 2,
  "met": true,
  "workers": [
    {"name":"review266-w1","present":true,"valid":true,"matched":true},
    {"name":"review266-w2","present":true,"valid":true,"matched":true},
    {"name":"review266-w3","present":true,"valid":true,"matched":false}
  ]
}
```

## Landing points in `agent-tmux`

- `watch_session()` around `agent-tmux:5125`
  - Extend flag parsing with `--count`.
  - Add a `done_count` calculation from existing `done_reason`.
  - Keep current `--any` / `--all` behavior unchanged.

- `cmd_team()` around `agent-tmux:5433`
  - Add subcommand dispatch: `quorum) _team_quorum "$@" ;;`.

- `_team_worker_rows()` / `_team_results()` area around `agent-tmux:5338` and `agent-tmux:5575`
  - Implement `_team_quorum` beside existing team result helpers.
  - Reuse stored `name`, `cli`, and `result_path`; do not rediscover sessions.

- Result helpers around `result_session()` / `result_validate_lightweight`
  - Prefer existing `result --json` behavior for present/valid/body.
  - No new result schema.

## Self-check idea

Add two tiny self-tests in `agent-tmux self-test`:

1. `self_test_watch_count`
   - Create a temp `TMUX_AGENT_DIR`.
   - Start with three fake result paths and baseline signatures.
   - Spawn one short tmux session for the pending worker or use existing self-test tmux pattern.
   - Rewrite two result files after watch starts.
   - Assert `watch --count 2 --json a b c` returns 0 with `.mode=="count"`, `.required_count==2`, `.done_count==2`, `.met==true`.

2. `self_test_team_quorum`
   - Write a minimal team state file with three workers and local result paths.
   - Write two valid `result.json` files with `{"status":"success"}` and one with `{"status":"failed"}`.
   - Assert `team quorum <team> --count 2 --field status --value success --json` returns 0 and reports `matched_count:2`.
   - Assert `--count 3` returns 1.

Run gates:

```sh
scripts/ci-shellcheck
skills/tmux-agent-tools/scripts/agent-tmux codex self-test
skills/tmux-agent-tools/scripts/agent-tmux claude self-test
```

## What stays out of scope

- No worker DAG / `needs:` yet.
- No profile inheritance.
- No TUI dashboard.
- No budget governor.
- No done-webhook or network callback.
- No new team state schema beyond optional fields needed for the quorum response.
- No result schema migration.
- No automatic stopping/cancelling of losing workers after quorum.
- No semantic voting, tie-breaking, or verdict consensus rules beyond exact field/value counting.

<!-- ponytail: quorum is just counting existing result.json files; DAG can wait until a downstream worker actually needs a machine-readable upstream quorum gate. -->
