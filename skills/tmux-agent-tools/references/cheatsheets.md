# Cheatsheets

Read this when picking a subcommand for a specific scenario, choosing the right wait/capture pattern, or diagnosing an unexpected wrapper behavior.

## Scenario → command

Use `claude-tmux help <subcommand>` or `codex-tmux help <subcommand>` for a focused per-subcommand cheatsheet instead of dumping the full usage.

| Scenario | Command |
| --- | --- |
| Know when an agent finished across processes | `start --sentinel /tmp/x.exit` + watch the file |
| Run code at agent start | `start --on-start 'cmd'` |
| Run code at agent exit | `start --sentinel ... --on-exit 'cmd'` |
| Get the last 80 lines of pane | `capture --tail 80` |
| Strip ANSI for token-efficient capture | `capture --strip-ansi --since-marker '[T02]'` |
| Wait for marker AND get tail in one call | `wait-and-capture --marker '[DONE]' --tail 80 --json` |
| Read the agent's structured result | `result --field '.status' --wait 30 --json <name>` |
| Check if agent is stuck | `status --json <name>` then read `idle_seconds` |
| Record every wrapper event to disk | `start --transcript /tmp/run.jsonl` |
| Per-subcommand cheatsheet | `claude-tmux help <subcommand>` |

## Token-efficient patterns

Default capture dumps raw scrollback — most of those tokens are ANSI escapes, banners, and pre-marker noise. Prefer the structured paths.

| Pattern | Why it saves tokens |
| --- | --- |
| Agent writes `$TMUX_AGENT_RESULT` (a JSON file), parent reads the file | Parent never reads pane scrollback. Token cost = result body, not pane history. |
| `capture --strip-ansi --since-marker '[T02]' --tail 80` | Strips CSI/SGR + trims pre-marker noise BEFORE returning. |
| `wait-and-capture --marker '[DONE]' --tail 80 --strip-ansi --json` | One round-trip for "is it done + here is the relevant tail". |
| `status --json` + `idle_seconds` / `marker_seen[]` | Liveness without reading any pane bytes. |
| `--transcript /tmp/run.jsonl` | All wrapper events go to disk; replay later without re-capture. |

## Completion signaling matrix

| Need | Use | Cost | Cross-process |
| --- | --- | --- | --- |
| "Is pane idle?" | `status --json` → `idle_seconds` | 1 capture-pane | yes |
| "Did marker appear?" | `wait-literal <text>` | poll until found | no (in-process) |
| "Marker + tail in one call" | `wait-and-capture --marker ... --tail N` | poll + 1 capture | no |
| "Notify when CLI exits" | `start --sentinel /path`; watch the file | filesystem-event | yes |
| "Run code on CLI exit" | `start --sentinel ... --on-exit 'cmd'` | hook runs in pane shell | yes |
| "Run code on CLI start" | `start --on-start 'cmd'` | detached subshell | yes |
| "Aggregate inventory state" | `tmux-agent-sessions list --json` | one pass over sessions | yes |

## Marker pitfalls (very common cause of timeouts)

The skill body lists the basic regex-vs-literal rule. The two patterns below are the ones that bite hardest in real use.

### Pitfall 1: Bracketed marker treated as regex character class

A bare `wait-text 'worker' '[DONE]' 300` does NOT wait for the literal string `[DONE]`. `[DONE]` is a regex character class matching any one of D / O / N / E, which fires on almost any output.

Fix one of two ways:

- `wait-literal worker '[DONE]' 300` — literal match, no regex.
- `wait-text --literal worker '[DONE]' 300` — same, explicit `--literal` flag.

### Pitfall 2: Alternation marker like `[DONE]` OR `Need approval`

When you need to wait for one of several markers and one of them contains regex metacharacters, you cannot use `wait-literal` (no alternation) and you cannot use plain `wait-text '[DONE]|Need approval'` (the `[...]` is still a character class).

Correct approach:

```bash
codex-tmux wait-and-capture \
  --marker '\[DONE\]|Need approval' \
  --tail 40 --strip-ansi --json \
  worker 300
```

Escape every regex metacharacter (`\[`, `\]`, `\.`, `\(`, etc.) and use real regex alternation `|`. Then grep the returned tail to identify which marker actually fired.

Do NOT race two `wait-literal` calls in parallel and pick the first to return. Wrapper state under `$TMUX_AGENT_DIR/<name>/` is not lock-protected and the marker_seen FIFO is shared; concurrent waiters on the same agent can corrupt each other.

## Failure mode

| Symptom | Likely cause | First action |
| --- | --- | --- |
| `wait-text` times out but pane has the text | regex metachar in marker | switch to `wait-literal` or `wait-text --literal` |
| `wait-literal` returns immediately | stale marker from previous turn | use `send-wait-literal` instead |
| `status --json` says `running:true` but no progress | CLI sitting on a permission prompt | check `diagnostic` field (`confirmation_detected`); attach + answer |
| `--on-exit` hook never logged | `--on-exit` set without `--sentinel` | the wrapper warns and ignores; add `--sentinel <path>` |
| `result.json` missing after agent says "done" | agent never wrote `$TMUX_AGENT_RESULT` | re-prompt with explicit "write $TMUX_AGENT_RESULT before signaling done" |
| Pane shows exit code marker but session lingers | normal — wrapper keeps the pane open for inspection | `stop <name>` to clean up |
| Multiline prompt sits in CLI input box, never submits | submit delay too short for the host | raise `CLAUDE_TMUX_SUBMIT_DELAY` or `CODEX_TMUX_SUBMIT_DELAY` |
