# Cheatsheets

Read this when picking a subcommand for a specific scenario, choosing the right wait/capture pattern, or diagnosing an unexpected wrapper behavior.

## Full script capability table

| Name | One-line purpose | When to reach for it |
| --- | --- | --- |
| `agent-tmux` | Unified engine: manage any AI coding CLI as a tmux worker (`agent-tmux <cli> <command>`), with per-CLI presets, `doctor --json`, `setup`, and declarative profiles. | Use directly for CLIs without a dedicated shim (gemini, cursor, grok, in-house tools), when scripting across multiple CLIs, or when running JSON preflight via `agent-tmux <cli> setup`. |
| `agy-tmux` | Thin shim for the bundled `agy` profile over `agent-tmux agy`. | Use when supervising Antigravity/agy with the same wrapper contract as Claude and Codex. |
| `claude-tmux` | Manage a Claude Code CLI worker in tmux with start/resume, send, wait, capture, status, ping, result, and cleanup helpers. | Use for long-running Claude Code work that needs supervision, structured result files, markers, active liveness, or later diagnostic capture. |
| `codex-tmux` | Manage a Codex CLI worker in tmux with the same wrapper contract as `claude-tmux`. | Use for long-running Codex work that needs supervision, structured result files, markers, active liveness, or later diagnostic capture. |
| `install-bin` | Install or link the bundled scripts into a chosen bin directory. | Use during local setup when the scripts are not already on `PATH`. |
| `tmux-agent-audit` | Query and verify wrapper audit logs. | Use when you need an operator-facing record of wrapper events, secret use, approvals, or posting actions. |
| `tmux-agent-cron` | Run scheduled/periodic tmux-agent-tool jobs from a manifest. | Use for repeatable local automation where a manifest should drive wrapper invocations. |
| `tmux-agent-dag` | Execute a dependency-ordered task manifest and summarize per-task results. | Use when tasks have explicit dependencies and later tasks should wait for prerequisite results. |
| `tmux-agent-dashboard` | Render a terminal dashboard for managed sessions. | Use when you need a live overview instead of inspecting each worker one at a time. |
| `tmux-agent-dialogue` | Run bounded two-party dialogues and presets such as `pair-review`, `critic`, `debate`, and `handoff`. | Use when two participants should exchange a fixed number of turns with a JSONL transcript. |
| `tmux-agent-fanout` | Spawn one prompt across multiple Claude/Codex workers and collect per-agent `result.json` files. | Use for parallel one-to-many work after the user has authorized worker count, tool, model, and effort. |
| `tmux-agent-history` | Inspect stored wrapper/session history. | Use when you need prior local run metadata rather than current tmux state. |
| `tmux-agent-monitor` | Poll read-only evidence commands for a managed agent or repo and emit JSONL observations plus a summary. | Use when you need periodic evidence checks; it does not send prompts unless the manifest commands do so. |
| `tmux-agent-notify` | Send local notifications for wrapper-related events. | Use to alert an operator when a watched condition or job state changes. |
| `tmux-agent-replay` | Replay or diff transcript/audit JSONL runs. | Use to compare runs, debug marker sequences, or inspect previously recorded wrapper events. |
| `tmux-agent-sessions` | Inventory, resolve, diff, and clean up sessions across Claude, Codex, and dialogue wrappers. | Use before adopting an existing worker, after accidental starts, or before any cleanup. |
| `tmux-agent-worktrees` | Manage worktrees created for agent work and apply cleanup policy. | Use when agent runs create isolated git worktrees that need listing or pruning. |

## Scenario → command

Use `claude-tmux help <subcommand>` or `codex-tmux help <subcommand>` for a focused per-subcommand cheatsheet instead of dumping the full usage.

| Scenario | Command |
| --- | --- |
| Bounded one-shot task, no follow-ups | `start --exact --headless <name> <dir> '<task>'` then `result wait-required <name> --fields status,summary --wait <s> --json` — completion = process exit, no pane heuristics |
| Persistent teammate — multi-round tasks / review loop on the SAME worker | interactive `start` (no `--headless`), do NOT `stop` between tasks; reuse via `result init` — protocol: `multi-agent.md#persistent-teammates-worker-reuse` |
| Wait for first/all worker completions | `watch --any|--all --timeout 600 --json <n1> <n2>` |
| Read the agent's structured result | `result --field '.status' --wait 30 --json <name>` |
| Wait until required result fields exist | `result wait-required <name> --fields status,summary --wait 60 --json` |
| Supervise one asynchronous worker without model polling | `supervise --result-required --silent-while-unchanged --json <name>` |
| Validate the structured result contract | `result validate <name> --json` |
| Fleet usage snapshot (adoption/status health) | `stats --json` — add `--exclude-selftest` to drop self-test workers (reports `excluded_selftest` count); top-level `by_task_shape` / `task_shape_coverage` fill in when launches carry `start --task-shape` |
| Launch lifecycle audit (completion coverage, name reuse) | `stats --json` then read `.launches` — `total` launches vs `ended` (`end_coverage_pct`), `by_terminal_reason` (`agent-result`/`process-exit`/`stopped`/`max-runtime`/`unknown`), and `name_reuse`; sourced from the append-only per-worker `usage.jsonl` ledger, so restarts of one name each count as a distinct launch |
| Passive liveness check | `status --json <name>` then read `running`, `idle_seconds`, and `diagnostic` |
| Active liveness check | `ping --json --timeout 5 <name>` |
| Send work and wait on a fresh nonce marker | `send-wait <name> <text> 300` |
| Wait for marker AND get diagnostic tail | `wait-and-capture --marker '[DONE]' --timeout 300 --tail 80 --json` |
| Know when an agent finished across processes | `start --sentinel /tmp/x.exit` + watch the file |
| Run code at agent start | `start --on-start 'cmd'` |
| Run code at agent exit | `start --sentinel ... --on-exit 'cmd'` |
| Get fallback pane evidence | `capture --strip-ansi <name> 80` |
| Record every wrapper event to disk | `start --transcript /tmp/run.jsonl` |
| Hold a worker for a human-controlled next round | `wait-and-capture --marker '[READY]' --timeout 300 --wait-for-human --cancel-file /tmp/cancel <name>` |
| Per-subcommand cheatsheet | `claude-tmux help <subcommand>` |

> **Timeout layering rule**: any outer execution limit (agent Bash-tool timeout, CI step timeout, `timeout(1)`) must be LONGER than the `--timeout`/`--wait` you pass to `watch`/`wait`/`result`. If the outer layer kills the call first you get a generic "execution timed out" with no wrapper diagnostics — seen in the field as `watch --timeout 600` dying inside a 120s outer shell.

## Token-efficient patterns

Default capture dumps raw scrollback — most of those tokens are ANSI escapes, banners, and pre-marker noise. Prefer the structured paths.

| Pattern | Why it saves tokens |
| --- | --- |
| Agent writes the wrapper-injected literal result path, parent reads with `result --wait` | Parent never reads pane scrollback. Token cost = result body, not pane history. |
| `watch --any|--all --timeout 600 --json w1 w2` | One blocking call supervises many workers; no orchestrator polling loop. |
| `supervise --result-required --silent-while-unchanged --json worker` | One blocking call waits for a valid terminal result or confirmed process loss; unchanged state emits nothing. |
| `status --json` + `ping --json --timeout 5` | Passive + active liveness without reading pane history. |
| `send-wait worker '...' 300` | Generates a fresh nonce marker and waits for it, so old pane text cannot satisfy the new turn. |
| `wait-and-capture --marker '[DONE]' --timeout 300 --tail 80 --strip-ansi --json` | Diagnostic fallback when branch logic needs nearby pane text. |
| `capture --strip-ansi --since-marker '[T02]' <name> 80` | Last-resort evidence only; structured result/status/watch come first. |
| `--transcript /tmp/run.jsonl` | All wrapper events go to disk; replay later without re-capture. |

## Completion signaling matrix

| Need | Use | Cost | Cross-process |
| --- | --- | --- | --- |
| "Which worker finished first/all?" | `watch --any|--all --timeout <s> --json` | one bounded watcher | yes |
| "Did this worker complete?" | `result --json --wait <s>` | structured file wait | yes |
| "Are required result fields ready?" | `result wait-required --fields ... --wait <s> --json` | structured file wait | yes |
| "Is pane passively alive?" | `status --json` → `running`, `idle_seconds`, `diagnostic` | 1 capture-pane | yes |
| "Does pane respond to input?" | `ping --json --timeout <s>` | benign active probe | yes |
| "Send and wait for this turn's completion" | `send-wait <name> <text> <timeout>` | send + nonce wait | no |
| "Marker + diagnostic tail in one call" | `wait-and-capture --marker ... --timeout <s> --tail N` | bounded pane wait + capture | no |
| "Notify when CLI exits" | `start --sentinel /path`; watch the file | filesystem-event | yes |
| "Run code on CLI exit" | `start --sentinel ... --on-exit 'cmd'` | hook runs in pane shell | yes |
| "Run code on CLI start" | `start --on-start 'cmd'` | detached subshell | yes |
| "Aggregate inventory state" | `tmux-agent-sessions list --json` | one pass over sessions | yes |

Bare waits, shell `sleep`, and `while status ...` polling loops are not orchestration patterns. Use one bounded wrapper call.

## Engine-agnostic resolution & mixed fleets

Result paths, status checks, and watches are resolved by session name:
- **Result paths:** Resolved by BARE session name (`$TMUX_AGENT_DIR/<name>/result.json`), meaning `result` and result-based `watch` triggers are fully engine-agnostic.
- **Tmux session checks:** Prefix-dependent (prepending `$PREFIX`, e.g., `codex-cli-`, `claude-cli-`, `agy-cli-`). Running `agent-tmux <cli> watch` against a different engine's session will immediately report `exited` if it is still running due to mismatched prefixes.
- **Preferred neutral entrypoint:** For mixed fleets (heterogeneous Claude, Codex, and Agy workers), `tmux-agent-sessions` is the preferred engine-neutral inventory and supervision surface (resolve/list/watch by name across all wrappers).

Example of watching a mixed fleet (`ios-deliv` started by codex, and `ios-native` started by agy):
```bash
agent-tmux codex watch --all --timeout 900 --json ios-deliv ios-native
```
JSON output shape:
```json
{
  "schema_version": 1,
  "mode": "all",
  "met": true,
  "agents": [
    {
      "name": "ios-deliv",
      "done": true,
      "reason": "result_updated"
    },
    {
      "name": "ios-native",
      "done": true,
      "reason": "exited"
    }
  ]
}
```

## Marker pitfalls (very common cause of false completion)

`wait-text` is literal-by-default. Add `--regex` only when you intentionally want regex matching.

### Hazard 1: stale pane content

Raw waits scan the current pane. If `[DONE]` is still visible from a previous turn, a new wait can return immediately even though the worker has not answered the new prompt.

Bad:

```bash
codex-tmux send worker 'Do the next task and end with [DONE].'
codex-tmux wait-text worker '[DONE]' 300
```

Good:

```bash
codex-tmux send-wait worker 'Do the next task.' 300
```

`send-wait` generates a fresh unique nonce for that turn, injects the "end with <nonce>" instruction, and waits on that nonce. Prefer fresh unique markers per turn; do not reuse `[DONE]` across an orchestration loop.

### Hazard 2: prompt echo

Most CLIs echo the submitted prompt into the pane. If the literal marker appears in the prompt itself, a raw wait can match the echo before the model has done any work.

Bad:

```bash
codex-tmux send worker 'Review the diff and end with [REVIEW-DONE].'
codex-tmux wait-text worker '[REVIEW-DONE]' 300
```

Good options:

```bash
codex-tmux send-wait worker 'Review the diff and write a verdict block.' 300
codex-tmux send worker 'Review the diff and end with the marker formed by joining [REVIEW- and DONE].'
codex-tmux wait-text worker '[REVIEW-DONE]' 300
```

Use the split-marker wording only when you intentionally manage the marker yourself. Otherwise prefer `send-wait`.

### Literal vs regex markers

Literal markers with metacharacters work without escaping:

```bash
codex-tmux wait-text worker '[DONE]' 300
```

Use `--regex` only for actual regular expressions:

```bash
codex-tmux wait-text --regex worker 'DONE|Need approval' 300
```

### Alternation marker like `[DONE]` OR `Need approval`

When you need to wait for one of several markers and one contains regex metacharacters, use `wait-and-capture --regex --marker` with an escaped regex. That returns the relevant tail in the same call, so the caller can decide which branch fired without a second pane read.

Correct approach:

```bash
codex-tmux wait-and-capture \
  --regex \
  --marker '\[DONE\]|Need approval' \
  --timeout 300 \
  --tail 40 --strip-ansi --json \
  worker
```

Escape every regex metacharacter (`\[`, `\]`, `\.`, `\(`, etc.) and use real regex alternation `|`. Then grep the returned tail to identify which marker actually fired.

Prefer `wait-and-capture --marker` over raw `wait-text` when you need immediate evidence from the same capture that satisfied the wait, when the marker is one of several possible states, or when the next branch depends on surrounding pane text.

Do NOT race two wait calls in parallel and pick the first to return. Wrapper state under `$TMUX_AGENT_DIR/<name>/` is not lock-protected and the marker_seen FIFO is shared; concurrent waiters on the same agent can corrupt each other.

## Failure mode

| Symptom | Likely cause | First action |
| --- | --- | --- |
| `wait-text --regex` times out but pane has the text | unescaped regex metachar in marker | remove `--regex`, or escape the regex metacharacters |
| raw marker wait returns immediately | stale marker from previous turn | use `send-wait` with a fresh nonce |
| raw marker wait returns before the worker answers | prompt echo contained the marker | use `send-wait`, or split the marker in prompt wording |
| `status --json` says `running:true` but no progress | CLI sitting on a permission prompt or stalled | check `diagnostic`; if high `idle_seconds`, run `ping --json --timeout 5`; attach only for approval/input |
| `ping` times out while `status --json` says `running:true` | pane is alive but not responsive to benign input | send one bounded `send-wait` asking it to write blocked result; then `result wait-required <name> --fields status,summary --wait 60 --json`; otherwise report stalled |
| `--on-exit` hook never logged | `--on-exit` set without `--sentinel` | the wrapper warns and ignores; add `--sentinel <path>` |
| historically `Directory not found: --flag`; now `unknown or misplaced flag: --flag` | a `start` flag was placed after `<name>`/`<directory>` | move all `start` flags before positionals, e.g. `start --exact --model <m> <name> <dir>` |
| `result.json` missing after agent says "done" | agent never wrote the wrapper result file | re-prompt with the literal path from `result --path <name>` before signaling done |
| Pane shows exit code marker but session lingers | normal — wrapper keeps the pane open for inspection | `stop <name>` to clean up |
| Multiline prompt sits in CLI input box, never submits | submit delay too short for the host | raise `CLAUDE_TMUX_SUBMIT_DELAY` or `CODEX_TMUX_SUBMIT_DELAY` |
