# Cheatsheets

Read this when picking a subcommand for a specific scenario, choosing the right wait/capture pattern, or diagnosing an unexpected wrapper behavior.

## Scenario → command

Use `claude-tmux help <subcommand>` or `codex-tmux help <subcommand>` for a focused per-subcommand cheatsheet instead of dumping the full usage.

| Scenario | Command |
| --- | --- |
| Wait for first/all worker completions | `watch --any|--all --timeout 600 --json <n1> <n2>` |
| Read the agent's structured result | `result --field '.status' --wait 30 --json <name>` |
| Wait until required result fields exist | `result wait-required <name> --fields status,summary --wait 60 --json` |
| Validate the structured result contract | `result validate <name> --json` |
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

## Token-efficient patterns

Default capture dumps raw scrollback — most of those tokens are ANSI escapes, banners, and pre-marker noise. Prefer the structured paths.

| Pattern | Why it saves tokens |
| --- | --- |
| Agent writes `$TMUX_AGENT_RESULT` (a JSON file), parent reads with `result --wait` | Parent never reads pane scrollback. Token cost = result body, not pane history. |
| `watch --any|--all --timeout 600 --json w1 w2` | One blocking call supervises many workers; no orchestrator polling loop. |
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
| `result.json` missing after agent says "done" | agent never wrote `$TMUX_AGENT_RESULT` | re-prompt with explicit "write $TMUX_AGENT_RESULT before signaling done" |
| Pane shows exit code marker but session lingers | normal — wrapper keeps the pane open for inspection | `stop <name>` to clean up |
| Multiline prompt sits in CLI input box, never submits | submit delay too short for the host | raise `CLAUDE_TMUX_SUBMIT_DELAY` or `CODEX_TMUX_SUBMIT_DELAY` |
