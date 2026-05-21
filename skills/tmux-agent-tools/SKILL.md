---
name: tmux-agent-tools
description: Use when Codex needs to run, supervise, or coordinate Claude Code or Codex CLI through local tmux sessions using the claude-tmux and codex-tmux wrappers. Triggers include starting named agent sessions, sending prompts to an existing tmux agent, waiting for terminal stability, capturing pane output, listing agent sessions, stopping sessions, or using start-ssh to keep tmux local while running the CLI on a remote host.
---

# Tmux Agent Tools

## Overview

Use `claude-tmux` and `codex-tmux` as the canonical interface for long-running Claude Code or Codex CLI sessions in tmux. Prefer these wrappers over hand-written `tmux send-keys` flows because they provide consistent session naming, capture, wait, status, and cleanup commands.

Use `tmux-agent-dialogue` when the task needs a bounded two-party dialogue with a JSONL transcript. Use `fake` participants for credential-free smoke tests. Run real `codex` and `claude` participants only for explicit manual smoke tests or when the user asks for a real-agent dialogue. Run `tmux-agent-dialogue validate-transcript --transcript <path>` before summarizing, sharing, or posting a transcript. Treat `failure_type` as conservative diagnostic metadata, not proof of root cause.

Use `tmux-agent-sessions list` for a read-only inventory across Claude, Codex, and dialogue sessions. Claude and Codex inventory rows reuse wrapper status fields and add `state` so exited-but-capturable sessions are visible before cleanup. Use `--tool`, `--name`, `--state`, and `--sort <tool|name|session|state>` when a script needs stable list output. Use `tmux-agent-sessions cleanup --preview` before any bulk cleanup, and only use `cleanup --execute --all` or filtered execution when the user has authorized stopping tool-owned sessions.

Local and SSH sessions keep the pane open after the agent CLI exits, showing the exit code so failures can still be captured.

The wrapper scripts are bundled with this skill at:

- `scripts/claude-tmux`
- `scripts/codex-tmux`
- `scripts/tmux-agent-dialogue`
- `scripts/tmux-agent-sessions`

If the commands are not installed on `PATH`, resolve them from the skill directory and run the script path directly.

## Command Choice

- Use `claude-tmux` when the requested worker should run Claude Code.
- Use `codex-tmux` when the requested worker should run Codex CLI.
- Use `start` for a local working directory.
- Use `claude-tmux resume` when an existing Claude Code session ID should continue inside a managed tmux session.
- Use `codex-tmux resume` when an existing Codex session ID should continue inside a managed tmux session.
- Use `start-ssh` when the tmux session should stay local but the agent CLI should run through SSH on another machine.

## When Not To Use

- Do not use tmux for one-off non-interactive shell commands; run those directly.
- Do not start a new tmux agent when a simple file read, search, test, or build command is enough.
- Do not use these wrappers for externally visible, destructive, or privacy-sensitive work unless the user has already authorized that work.

## Core Workflow

1. Start a session with a short stable name:

```bash
codex-tmux start --exact worker ~/github/project 'Read the repo and report the failing test.'
```

Resume an existing Claude Code session inside tmux:

```bash
claude-tmux resume --exact worker ~/github/project ee5aca88-a1af-48d3-af21-54f60d618f22
```

Resume an existing Codex session inside tmux:

```bash
codex-tmux resume --exact worker ~/github/project 019e356f-f95d-7570-9784-ea7b58e404a5
```

2. Send follow-up work without attaching:

```bash
codex-tmux send worker 'Now implement the smallest fix and run the targeted test.'
codex-tmux send-wait-literal worker 'End with the split marker described here.' '[CODEX-01]' 180
```

3. Wait for visible pane stability before reading output:

```bash
codex-tmux wait worker 180
codex-tmux wait-text worker 'Done|Need approval' 180
codex-tmux wait-text --literal worker '[CODEX-01]' 180
codex-tmux wait-literal worker '[CODEX-01]' 180
codex-tmux capture worker 120
```

Use `send-wait-literal` for marker-driven orchestration when stale pane content may already contain an older marker. Keep the literal out of the sent prompt or split it in the prompt instructions so the prompt echo itself cannot satisfy the wait. If multiline prompts remain in a CLI input box instead of submitting, increase `CLAUDE_TMUX_SUBMIT_DELAY` or `CODEX_TMUX_SUBMIT_DELAY`.

4. Inspect status or clean up:

```bash
codex-tmux status worker
codex-tmux status --json worker
codex-tmux doctor
codex-tmux self-test
codex-tmux stop worker
```

Use `wait-text --literal` or `wait-literal` when the expected text contains regex metacharacters such as `[`, `]`, `(`, `)`, `.`, `*`, or `?`. Use regex `wait-text` only when regex matching is intentional.

`status --json` is the stable automation contract for both wrappers. Expect the shared fields `tool`, `name`, `session`, `prefix`, `exists`, `running`, `exit_detected`, `local_or_remote`, and `diagnostic`. Treat `local_or_remote` and `diagnostic` as best-effort diagnostics; the other fields are stable. `running` is false when the pane shows the wrapper's local or remote exit-code marker even if the tmux session still exists for capture.

5. For bounded two-agent dialogue, write a prompt file and transcript path:

```bash
tmux-agent-dialogue --turns 4 --workdir . --agent-a fake --agent-b fake --prompt-file prompt.md --transcript transcript.jsonl
```

For a manual real-agent smoke after explicit authorization:

```bash
tmux-agent-dialogue --turns 2 --workdir . --agent-a codex --agent-b claude --prompt-file prompt.md --transcript transcript.jsonl
```

Real dialogue prompts use a split marker. The participant must end each turn with one standalone final line containing only the joined marker. If a marker wait times out, inspect the emitted `failure` JSONL event and captured pane tail before treating the run as a protocol failure.

Use participant profiles only for generic, reusable defaults. Profiles live at `~/.config/tmux-agent-tools/participants.json` by default, or at `TMUX_AGENT_TOOLS_PARTICIPANTS` / `--participants-config <path>`. Each top-level profile may contain only `agent`, `ssh`, `workdir`, `timeout`, and `env`; command-line flags override profile values. `timeout` must be a positive integer string in seconds and applies only to that participant when the run does not pass `--timeout`. `env` must be an object of newline-free string values keyed by shell environment names and is passed to the local wrapper/session process. For SSH participants, remote environment behavior depends on SSH and remote shell configuration, so do not rely on profile env as a secret transport. Do not encode personal project shortcuts in public docs or examples.

Use participant SSH options when one real agent should run remotely while tmux stays local:

```bash
tmux-agent-dialogue --turns 2 --workdir . --agent-a codex --agent-a-ssh example-host --agent-a-workdir /Users/example/github/project --agent-b claude --prompt-file prompt.md --transcript transcript.jsonl
```

Only real `codex` or `claude` participants can use `--agent-a-ssh` or `--agent-b-ssh`; `fake` is local-only. Remote workdirs must be absolute paths on the target host.

For a local review preset that only writes a transcript and terminal summary:

```bash
tmux-agent-dialogue pair-review --workdir . --prompt-file review.md --transcript review.jsonl
```

`pair-review` does not post comments, merge PRs, or publish externally. Use `--swap` when agent B should speak first and agent A should respond. Use `--summary-file <path>` for a local Markdown summary.

Use `critic` when the user wants a bounded critique/response loop without any external action:

```bash
tmux-agent-dialogue critic --workdir . --prompt-file review.md --transcript critic.jsonl
```

`critic` defaults to four turns. Agent A speaks on odd turns, agent B speaks on even turns, and custom `--turns` values must be positive even numbers. It is only a preset over the same local transcript flow; it does not post comments, merge PRs, schedule work, or continue unbounded.

Use `debate` when the user wants a bounded back-and-forth argument without winner selection or external action:

```bash
tmux-agent-dialogue debate --workdir . --prompt-file review.md --transcript debate.jsonl
```

`debate` defaults to four turns. Agent A speaks on odd turns, agent B speaks on even turns, and custom `--turns` values must be positive even numbers. It is only a preset over the same local transcript flow; it does not post comments, merge PRs, schedule work, pick a winner, arbitrate the result, or continue unbounded.

For any existing `dialogue`, `pair-review`, `critic`, or `debate` transcript, prepare a GitHub PR comment body without posting:

```bash
tmux-agent-dialogue github-comment --transcript review.jsonl --github-pr 123 --github-repo owner/repo
```

Only add `--post-github-comment` when the user explicitly asks to publish the summary to GitHub.
Use `--max-lines`, `--max-bytes`, and repeated `--redact-pattern` on `summarize` or `github-comment` when transcript content may be too large or sensitive to share raw. The generated Markdown includes visible truncation and redaction notes.

## Scenario → command cheatsheet (issue #106)

Use `claude-tmux help <subcommand>` or `codex-tmux help <subcommand>` for a focused per-subcommand cheatsheet instead of dumping the full usage.

| Scenario | Command |
| --- | --- |
| Know when an agent finished across processes | `start --sentinel /tmp/x.exit` + watch the file |
| Run code at agent start | `start --on-start 'cmd'` (#101a) |
| Run code at agent exit | `start --sentinel ... --on-exit 'cmd'` (#95) |
| Get the last 80 lines of pane | `capture --tail 80` |
| Strip ANSI for token-efficient capture | `capture --strip-ansi --since-marker '[T02]'` (#96) |
| Wait for marker AND get tail in one call | `wait-and-capture --marker '[DONE]' --tail 80 --json` (#99) |
| Read the agent's structured result | `result --field '.status' --wait 30 --json <name>` (#97) |
| Check if agent is stuck | `status --json <name>` then read `idle_seconds` (#98) |
| Record every wrapper event to disk | `start --transcript /tmp/run.jsonl` (#100) |
| Per-subcommand cheatsheet | `claude-tmux help <subcommand>` (#106) |

## Token-efficient patterns (#107)

Default capture dumps raw scrollback — most of those tokens are ANSI escapes, banners, and pre-marker noise. Prefer the structured paths:

| Pattern | Why it saves tokens |
| --- | --- |
| Agent writes `$TMUX_AGENT_RESULT` (a JSON file), parent reads the file (#97) | Parent never reads pane scrollback. Token cost = result body, not pane history. |
| `capture --strip-ansi --since-marker '[T02]' --tail 80` (#96) | Strips CSI/SGR + trims pre-marker noise BEFORE returning. |
| `wait-and-capture --marker '[DONE]' --tail 80 --strip-ansi --json` (#99) | One round-trip for "is it done + here is the relevant tail". |
| `status --json` + `idle_seconds` / `marker_seen[]` (#98) | Liveness without reading any pane bytes. |
| `--transcript /tmp/run.jsonl` (#100) | All wrapper events go to disk; replay later without re-capture. |

## Completion signaling matrix (#107)

| Need | Use | Cost | Cross-process |
| --- | --- | --- | --- |
| "Is pane idle?" | `status --json` → `idle_seconds` (#98) | 1 capture-pane | yes |
| "Did marker appear?" | `wait-literal <text>` | poll until found | no (in-process) |
| "Marker + tail in one call" | `wait-and-capture --marker ... --tail N` (#99) | poll + 1 capture | no |
| "Notify when CLI exits" | `start --sentinel /path` (#95); watch the file | filesystem-event | yes |
| "Run code on CLI exit" | `start --sentinel ... --on-exit 'cmd'` (#95) | hook runs in pane shell | yes |
| "Run code on CLI start" | `start --on-start 'cmd'` (#101a) | detached subshell | yes |
| "Aggregate inventory state" | `tmux-agent-sessions list --json` | one pass over sessions | yes |

## Result file contract (#107, builds on #97)

Agents should write `$TMUX_AGENT_RESULT` (path is `$TMUX_AGENT_DIR/<name>/result.json`) with this shape:

```jsonc
{
  "schema_version": 1,
  "status": "ok" | "blocked" | "error",
  "summary": "one-line human-readable summary",
  "artifacts": [{"kind": "pr|file|url", "ref": "PR-1234"}],
  "errors": [{"code": "...", "message": "...", "remediation": "..."}]
}
```

Parent reads it via `result --json --wait <seconds> <name>` and branches on `.present` (file existed) then `.valid` (parsed as JSON) before consuming `.body`.

## Failure mode cheatsheet (#107)

| Symptom | Likely cause | First action |
| --- | --- | --- |
| `wait-text` times out but pane has the text | regex metachar in marker | switch to `wait-literal` or `wait-text --literal` |
| `wait-literal` returns immediately | stale marker from previous turn | use `send-wait-literal` instead |
| `status --json` says `running:true` but no progress | CLI sitting on a permission prompt | check `diagnostic` field (`confirmation_detected`); attach + answer |
| `--on-exit` hook never logged | `--on-exit` set without `--sentinel` | the wrapper warns and ignores; add `--sentinel <path>` |
| `result.json` missing after agent says "done" | agent never wrote `$TMUX_AGENT_RESULT` | re-prompt with explicit "write $TMUX_AGENT_RESULT before signaling done" |
| Pane shows exit code marker but session lingers | normal — wrapper keeps the pane open for inspection | `stop <name>` to clean up |

## Fan-out across mixed wrappers (#184)

`tmux-agent-fanout run` spawns one agent per `--agent tool:name` (mix
`claude:` and `codex:` in a single call) or one per `--workdir` (legacy
single-tool form). Each child writes its own `result.json` under
`--result-dir`; the parent emits a consolidated summary on stdout
(schema: `schemas/fanout-summary.schema.json`).

```bash
tmux-agent-fanout run \
  --prompt-file ./prompt.txt \
  --agent claude:reviewer --workdir ~/repo \
  --agent codex:refactor  --workdir ~/repo \
  --result-dir /tmp/fanout-demo \
  --merge-mode all
```

- `--merge-mode all` (default): `ok=true` iff every agent succeeds.
- `--merge-mode first-success`: `ok=true` if any agent succeeds.
  Remaining agents continue (they are NOT killed) and are still
  recorded in the summary.
- Failure isolation: each agent's `result.json` is preserved on disk
  even if a sibling fails or times out.

Daemon / async / supervisor-tree / cross-agent cancellation remain
deferred — see `docs/design-issue-184-fanout.md`.

## Concurrency model (#107)

- Single caller per agent name. Two `start --exact same-name` kills the first session.
- Wrapper state under `$TMUX_AGENT_DIR/<name>/` (`started_at`, `marker_seen`, `transcript-path`, etc.) is NOT lock-protected today. Don't share one agent name across two orchestrators.
- The `marker_seen` FIFO is capped at 100 entries (#98) — oldest evicted first.
- Multiple agents under different names are independent; `tmux-agent-sessions list --json` is a safe read across all of them.

## Cost accounting (#107)

- Per-turn usage capture (#103) is design-only today. When it lands, usage goes to `$TMUX_AGENT_DIR/<name>/usage.jsonl` with `schema_version: 1` and is aggregated via `status --usage` / `usage --top N`.
- `--max-runtime` / `--max-idle` / `--max-cost` fuses (#105) are roadmap, not implemented.
- For now, account cost via: transcript size as proxy + your provider's billing dashboard.

## Session Naming

- Without `--exact`, `start` appends a random suffix to avoid collisions.
- With `--exact`, the session uses the requested name exactly under the tool prefix.
- `send`, `capture`, `wait`, `status`, `attach`, and `stop` take the agent name, not the full tmux session name.

## Remote Sessions

Use `start-ssh` when the target repo is on another host:

```bash
claude-tmux start-ssh --exact review example-host ~/github/project 'Review the diff and return findings only.'
```

Requirements:

- local machine has `tmux`;
- remote shell can resolve `claude` or `codex` on `PATH`;
- SSH target is already configured.

## Safety

- These wrappers launch agent CLIs with permissive flags: Claude uses `--dangerously-skip-permissions`; Codex uses `--yolo`.
- Do not use them for destructive, privacy-sensitive, externally visible, payment, or irreversible operations unless the user explicitly authorized that work.
- Prefer `capture` and `status` before assuming a worker is done.
- `claude-tmux status <name>` reports a diagnostic when the pane appears to be waiting for a Claude first-run or permission confirmation. It does not auto-accept that prompt.
- Prefer `doctor` and `self-test` before debugging agent behavior; they verify wrapper dependencies and tmux capture/wait behavior without starting a real agent.

## Environment Overrides

- `TMUX=/path/to/tmux`
- `CLAUDE=/path/to/claude`
- `CODEX=/path/to/codex`
- `CLAUDE_TMUX_PREFIX` / `CODEX_TMUX_PREFIX`
- `CLAUDE_TMUX_STABLE_SECONDS` / `CODEX_TMUX_STABLE_SECONDS`
- `CLAUDE_TMUX_SUBMIT_DELAY` / `CODEX_TMUX_SUBMIT_DELAY`
- `CLAUDE_TMUX_CONF` / `CODEX_TMUX_CONF`
- `CLAUDE_TMUX_MOUSE` / `CODEX_TMUX_MOUSE`
- `CLAUDE_TMUX_CLIPBOARD` / `CODEX_TMUX_CLIPBOARD` (`auto`, `internal`, or a copy command)
- `CLAUDE_TMUX_STATUS_TAIL_LINES` / `CODEX_TMUX_STATUS_TAIL_LINES`
- `TMUX_AGENT_TOOLS_PARTICIPANTS`
