# tmux-agent-tools

Small tmux wrappers for running Claude Code and Codex CLI as controllable named sessions.

This repository is both:

- a `skills.sh` compatible skill package;
- a Homebrew formula source for installing `claude-tmux`, `codex-tmux`, `tmux-agent-dialogue`, and unreleased `--HEAD` tools on macOS or Linuxbrew.

## Inspired By

This project is inspired by two tmux skills in the `skills.sh` ecosystem:

- [mitsuhiko/agent-stuff/tmux](https://www.skills.sh/mitsuhiko/agent-stuff/tmux), especially the pattern of pairing a compact `SKILL.md` with shell helpers under `scripts/`.
- [steipete/clawdis/tmux](https://www.skills.sh/steipete/clawdis/tmux), especially the practical guidance around using tmux for long-running interactive agent sessions instead of one-off shell commands.

`tmux-agent-tools` keeps that skill-first layout, but adds installable wrapper commands for Claude Code and Codex CLI.

## Tools

- `claude-tmux`: starts Claude Code in tmux with `--dangerously-skip-permissions`.
- `codex-tmux`: starts Codex CLI in tmux with `--yolo`.
- `tmux-agent-dialogue`: runs a bounded two-party tmux dialogue, writes a JSONL transcript, and validates transcript artifacts.
- `tmux-agent-sessions`: lists and safely cleans up tmux-agent-tools owned sessions.

The `claude-tmux` and `codex-tmux` wrapper tools support:

- `start`
- `resume`
- `start-ssh`
- `attach`
- `send`
- `send-wait-literal`
- `wait`
- `wait-text`
- `wait-literal`
- `capture`
- `list`
- `status`
- `doctor`
- `self-test`
- `stop`
- `help`

`tmux-agent-sessions list [--json]` gives a read-only cross-tool inventory for `claude-tmux`, `codex-tmux`, and `tmux-agent-dialogue` sessions. Claude and Codex inventory rows reuse the wrapper `status --json` contract and add `state` (`running`, `exited`, `stopped`, or wrapper-reported `missing`), so a pane that remains capturable after an exit-code marker is not reported as still running. Dialogue rows are tmux inventory rows and use conservative `running` state while the session exists. Use `--tool`, `--name`, `--state`, and `--sort <tool|name|session|state>` to make list output script-friendly without changing cleanup behavior. `tmux-agent-sessions list --watch --json --count <n> [--interval <seconds>]` polls that inventory for a finite number of snapshots and emits one JSON array per poll; `--count 0` exits successfully without polling, and list filters/sorting apply to each snapshot. `tmux-agent-sessions cleanup --preview` is also read-only and includes the same state in JSON mode; combine `--preview --json` with `--tool` or `--name` for scriptable cleanup decisions before executing. `cleanup --execute` is required before it stops tool-owned sessions, execution must include `--all`, `--tool`, or `--name`, and `--json` is only accepted for preview. It never stops tmux sessions outside the known tmux-agent-tools prefixes.

`tmux-agent-sessions` is included in the stable Homebrew install starting with `v0.3.0`.

Local and SSH sessions keep the pane open after the agent CLI exits, showing the exit code so failures can still be captured.

Resume an existing Claude Code conversation inside a managed tmux session:

```bash
claude-tmux resume --exact resume /Users/paul.yeh/github/tmux-agent-tools ee5aca88-a1af-48d3-af21-54f60d618f22
```

This launches Claude as `claude --dangerously-skip-permissions --resume <session-id>` while preserving the usual `claude-tmux status`, `capture`, `send`, `attach`, and `stop` controls.

Resume an existing Codex conversation inside a managed tmux session:

```bash
codex-tmux resume --exact resume /Users/paul.yeh/github/tmux-agent-tools 019e356f-f95d-7570-9784-ea7b58e404a5
```

This launches Codex as `codex --yolo resume <session-id>` while preserving the usual `codex-tmux status`, `capture`, `send`, `attach`, and `stop` controls.

`tmux-agent-dialogue` is included in the stable Homebrew install starting with `v0.2.0`. Its credential-free `fake` participants are covered by CI; real `codex`/`claude` participants are accepted by the command and should still use manual smoke evidence rather than default CI.

## Install Skill With skills.sh

```bash
npx skills add ohyeh/tmux-agent-tools --skill tmux-agent-tools
```

Install globally for all projects:

```bash
npx skills add ohyeh/tmux-agent-tools --skill tmux-agent-tools --global
```

## Install Commands With Homebrew

This repository intentionally uses the project name `tmux-agent-tools` instead of Homebrew's `homebrew-` prefix. Because of that, tap it with the explicit Git URL.

macOS or Linuxbrew:

```bash
brew tap ohyeh/tmux-agent-tools https://github.com/ohyeh/tmux-agent-tools.git
brew install tmux-agent-tools
```

Install the latest unreleased commit:

```bash
brew install tmux-agent-tools --HEAD
```

## Install Commands Without Homebrew

For Linux VMs without Homebrew, install prerequisites first:

```bash
sudo apt-get update
sudo apt-get install -y zsh tmux
```

Then symlink the bundled scripts into `~/.local/bin`:

```bash
skills/tmux-agent-tools/scripts/install-bin ~/.local/bin
```

## Local Formula Validation

Before publishing, validate the checkout as a local tap:

```bash
brew tap ohyeh/tmux-agent-tools "file://$PWD"
brew style ohyeh/tmux-agent-tools/tmux-agent-tools
```

## Release Process

Releases go through a focused release PR, the manual `Release` GitHub Actions workflow, and a follow-up Formula bump PR. See [docs/release-process.md](docs/release-process.md).

## Roadmaps

- [v0.4.0 roadmap](docs/v0.4.0-roadmap.md)
- [v0.5.0 roadmap](docs/v0.5.0-roadmap.md)
- [v0.6.0 roadmap](docs/v0.6.0-roadmap.md)

## Usage

```bash
codex-tmux start --exact worker ~/github/project 'Read the repo and report status.'
codex-tmux send worker 'Run the targeted tests.'
codex-tmux send-wait-literal worker 'Reply with the marker described in this prompt.' '[CODEX-01]' 180
codex-tmux wait worker 180
codex-tmux wait-text worker 'Done|Need approval' 180
codex-tmux wait-text --literal worker '[CODEX-01]' 180
codex-tmux wait-literal worker '[CODEX-01]' 180
codex-tmux capture worker 120
codex-tmux status --json worker
codex-tmux stop worker
```

Use regex `wait-text` for alternatives such as `Done|Need approval`. Use `wait-text --literal` or `wait-literal` for exact markers that contain regex metacharacters such as `[CODEX-01]`. Use `send-wait-literal` when a prompt should only count a marker that appears after the send operation; the dialogue runner uses this to avoid stale marker matches. The wrappers pause briefly between paste and submit for multiline prompts; tune this with `CLAUDE_TMUX_SUBMIT_DELAY` or `CODEX_TMUX_SUBMIT_DELAY` when a local CLI needs more time.

Captured pane text joins tmux soft-wrapped screen lines before matching or writing transcripts. This keeps long model output, markers, and summaries from changing shape just because the tmux pane is narrow.

### Token-efficient capture variants

`capture` supports three optional post-processing flags that let the wrapper trim output BEFORE returning it, so the caller does not pay token cost for boilerplate or pre-marker scrollback:

```bash
codex-tmux capture --strip-ansi --since-marker '[T02]' --json worker 200
```

| Flag | Behavior |
| --- | --- |
| `--strip-ansi` | Remove ANSI CSI/SGR escape sequences from the captured text. Known gap: OSC, DCS, APC, PM, SOS terminators are NOT stripped (see `docs/design-issue-96-capture-variants.md`). |
| `--since-marker <text>` | Keep only the lines AFTER the LAST occurrence of the literal `<text>`. The marker line itself is NOT retained. Multi-line marker text is not supported — use a single-line literal. If the marker is missing, the body is empty (text mode) or `marker_found: false` (JSON mode). |
| `--json` | Wrap output as `{schema_version, name, session, lines_requested, marker_found, stripped_ansi, lines}`. `schema_version` is `1` for this contract; additive field changes will not bump it. Composable with the other flags. |

All flags must come BEFORE the positional `<name> [lines]`. Without any flag the behavior is identical to today.

### `status --json` liveness fields

In addition to the existing stable fields, `status --json` now reports
five liveness-oriented fields so callers can answer "is the agent
actually doing something":

| Field | Type | Meaning |
| --- | --- | --- |
| `started_at` | ISO-8601 UTC \| null | When the wrapper created the tmux session. |
| `last_change_at` | ISO-8601 UTC \| null | When `status` last observed the pane content change. Computed via a per-session pane hash so the value reflects "as of the last status call" — there is no daemon. |
| `idle_seconds` | integer \| null | `now - last_change_at`. Null when the session is gone. |
| `bytes_in_pane` | integer \| null | Approximate byte size of the visible pane buffer. |
| `marker_seen` | string[] | Distinct literal markers the wrapper has observed via `wait-literal` / `send-wait-literal`. First-seen order; FIFO-capped at 100. Regex `wait-text` does NOT add to this set — only literal markers. |

All five are ADDITIVE; existing fields (`exists`, `running`,
`exit_detected`, etc.) keep their shape and meaning. Calling
`status --json` periodically is how `last_change_at` and
`idle_seconds` stay current; without periodic polling the value
reports "as of the last call".

### Single-agent JSONL transcript

`start` and `resume` accept `--transcript <abs-path>`. Subsequent
`send`, `capture`, and `stop` invocations append a JSONL event to that
file so single-agent sessions get the same audit-trail shape as
`tmux-agent-dialogue`:

```bash
codex-tmux start --exact --transcript /tmp/worker.jsonl worker ~/proj
codex-tmux send worker 'do step 1'
codex-tmux capture worker 20
codex-tmux stop worker
cat /tmp/worker.jsonl
# {"schema_version":1,"event":"start","tool":"codex","name":"worker", ...}
# {"schema_version":1,"event":"send","name":"worker","text":"do step 1","at": ...}
# {"schema_version":1,"event":"capture","name":"worker","lines_requested":20, ...}
# {"schema_version":1,"event":"stop","name":"worker","stopped":true, ...}
```

All events carry `schema_version: 1`, an `event` discriminator, the
agent `name`, and an ISO-8601 UTC `at` timestamp. The transcript path
is remembered for the session in `$TMUX_AGENT_DIR/<name>/transcript-path`
so subsequent subcommands find it automatically. A pre-existing
transcript file aborts start to avoid mixed runs.

Wait-family events (`wait`, `wait-text`, `wait-literal`,
`send-wait-literal`, `wait-and-capture`) are NOT yet recorded — tracked
as a #100 followup so this PR stays scoped to the most-used surface.

**Large prompt warning**: `send` events embed the full prompt text as a
JSON string. A 100 KB prompt produces a 100 KB-ish JSONL line. If you
expect very large prompts, either redact via the dialogue
`--max-bytes` / `--redact-pattern` pipeline before sharing the transcript,
or watch the followup that adds opt-in truncation to `send` events.

### `wait-and-capture` combined subcommand

The two-step `wait-literal X && capture --strip-ansi --since-marker X`
pattern is so common that the wrappers ship a single `wait-and-capture`
subcommand for it:

```bash
codex-tmux wait-and-capture --literal --marker '[DONE]' --strip-ansi --json worker
```

| Flag | Behavior |
| --- | --- |
| `--marker <text>` (required) | Marker to wait for. |
| `--literal` / `--regex` | Match style. Default is `--literal` — markers like `[DONE]` match exactly. Use `--regex` only when you need zsh ERE. |
| `--timeout <s>` | Wait timeout. Default 180s. |
| `--tail <n>` | Lines of scrollback to capture (default 80). |
| `--strip-ansi` | Forwarded to the capture phase, removes CSI/SGR escapes. |
| `--since-marker <text>` | Slice the body to lines AFTER the marker. Under `--literal` the default is the marker value. Under `--regex` you MUST pass `--since-marker` explicitly — `grep -F` against the raw regex pattern would not match what the regex matched. |
| `--json` | Wrap output as `{schema_version, matched, marker, match_style, since_marker, wait_seconds, timeout, stripped_ansi, reason, lines}`. `reason` is one of `matched`, `timeout`, `session_gone`. |
| `--no-timeout-error` | Decouple soft-timeout from `--json` (partner R3 critique on the original design). With this flag, timeout exits 0 instead of 1. Composable with or without `--json`. |

Without `--no-timeout-error`, timeout exits 1 — keeps `if wait-and-capture ...`
shell-friendly without forcing every caller to write a special case.

### Result-file convention (`result` subcommand)

`start` and `resume` export two env vars into the pane shell so the agent CLI can write its structured result without inventing a path:

```
TMUX_AGENT_NAME=<short-name>
TMUX_AGENT_RESULT=$TMUX_AGENT_DIR/<short-name>/result.json
```

`TMUX_AGENT_DIR` defaults to `$XDG_STATE_HOME/tmux-agent-tools` (or `~/.local/state/tmux-agent-tools` when XDG is unset). The wrapper creates the per-agent subdirectory at start and clears any stale `result.json` to prevent false positives.

Recommended prompt snippet (also tracked in SKILL.md):

> When this skill exits, the agent MUST write its final structured
> result via **atomic rename** so a `result --wait` reader never sees a
> partial file:
>
> ```sh
> cat > "$TMUX_AGENT_RESULT.tmp" <<'JSON'
> {"status": "ok", "summary": "...", "errors": [], "artifacts": []}
> JSON
> mv -f "$TMUX_AGENT_RESULT.tmp" "$TMUX_AGENT_RESULT"
> ```
>
> Do NOT write directly to `$TMUX_AGENT_RESULT`. The wrapper's
> `result --wait` polls at 1Hz and could otherwise observe partial
> content during the agent's final write.

Read the result with the new `result` subcommand:

```bash
codex-tmux result worker                # cat result.json
codex-tmux result --field .status worker
codex-tmux result --wait 180 worker     # block up to 180s for the file
codex-tmux result --json worker         # metadata-wrapped output
```

| Flag | Behavior |
| --- | --- |
| `--field <jq>` | Extract a single value via `jq -r`. Exits non-zero if the path is missing. |
| `--wait <seconds>` | Poll until the file appears or timeout. fswatch / inotifywait support is a follow-up; current implementation polls once per second. |
| `--json` | Wrap output as `{schema_version, path, present, bytes, mtime, valid, body}`. `valid` is `true` when the file parsed as JSON (body is the parsed object) and `false` when it did not (body is the raw bytes as a string, so the caller can still inspect). When the file is missing, `--json` exits 0 with `{present: false, valid: false, body: null}` — callers branch on `.present` rather than the exit code. Text mode (no `--json`) keeps the conventional exit 1 + stderr message for missing files. |

### Event-driven completion (sentinel + lifecycle hooks)

`claude-tmux` and `codex-tmux` can write an **exit-code sentinel file** when the underlying CLI exits, and optionally invoke a hook command. This lets external automation wait on a real file instead of polling pane text.

```bash
codex-tmux start --exact --sentinel /tmp/worker.exit --on-exit /usr/local/bin/notify-done worker ~/github/project
# ... later, an external watcher does:
while [[ ! -f /tmp/worker.exit ]]; do sleep 1; done
exit_code=$(cat /tmp/worker.exit)
```

Flags (place before `<name>` and `<directory>`):

| Flag | Meaning |
| --- | --- |
| `--sentinel <abs-path>` | Absolute path; wrapper writes the CLI exit code (decimal + newline) atomically after the CLI returns. Pre-existing file aborts start to prevent stale-completion false positives. |
| `--on-exit <shell-cmd>` | Hook command run after the sentinel is written. The hook reads `$ON_EXIT_CODE` (decimal exit code) and `$ON_EXIT_NAME` (agent name) from its environment. The wrapper does NOT append positional args, so composite shell strings such as `'curl -X POST "$URL?code=$ON_EXIT_CODE"'` work correctly. Stdout/stderr go to `<sentinel>.hook.log`. Ignored with a warning if `--sentinel` is omitted. |
| `--on-start <shell-cmd>` | Hook command run after `tmux new-session` returns (issue #101a). The hook reads `$TMUX_AGENT_NAME` and `$TMUX_AGENT_SESSION` from its environment and runs detached so wrapper return is not blocked. Stdout/stderr captured to `<sentinel>.hook.log` (when `--sentinel` is set) or `$TMUX_AGENT_DIR/<name>/hook.log`. Non-zero hook exit is logged but never fails the agent. Best-effort timing: the pane is created but the CLI may not yet have rendered its first prompt when the hook fires. |
| `--sentinel-keep` | Keep the sentinel file on `stop`. Default removes it during cleanup. |

The sentinel format is intentionally minimal — a single decimal integer plus newline — so shell consumers can rely on `cat`/`[[ ]]` without parsing. Structured telemetry belongs to a separate JSON artifact (see roadmap L3 issues #100/#103); the sentinel will not grow into a JSON payload.

Currently the sentinel is wired into local `start` and `resume` paths for both wrappers. `start-ssh` and the SSH variant are pending a design decision on where remote sentinels should live (remote host by default, with operator-pulled retrieval).

Interactive sessions keep mouse support on by default. Copy-mode `y`, `Enter`, and mouse drag release use the first available system clipboard command (`pbcopy`, `wl-copy`, `xclip`, or `xsel`); when none exists, they fall back to tmux's internal selection so keyboard copy does not fail just because a platform clipboard helper is missing. Set `CLAUDE_TMUX_CLIPBOARD=internal` or `CODEX_TMUX_CLIPBOARD=internal` to force tmux internal selection, or set either variable to a custom copy command when a terminal needs a specific clipboard bridge.

`status --json` is a stable machine-readable contract for both wrappers. It is built with `jq` and uses the same fields for Claude and Codex:

| Field | Type | Stability | Meaning |
| --- | --- | --- | --- |
| `tool` | string | stable | `claude` or `codex`. |
| `name` | string | stable | Requested short agent name. |
| `session` | string | stable | Full tmux session name. |
| `prefix` | string | stable | Session prefix used by the wrapper. |
| `exists` | boolean | stable | Whether the tmux session exists. |
| `running` | boolean | stable | `true` only when the session exists and no wrapper exit-code marker is visible. |
| `exit_detected` | boolean | stable | Pane contains `local command exited with code` or `remote command exited with code`; this does not imply failure. |
| `exit_code` | integer or null | stable | Numeric code parsed only from the wrapper exit-code marker; `null` when missing, running, or no marker is visible. |
| `local_or_remote` | string or null | diagnostic | Best-effort mode inferred from pane text; `null` when the session is missing. |
| `diagnostic` | string or null | diagnostic | Optional readiness warning text; callers should not depend on exact wording. |
| `last_capture_lines` | array of strings | diagnostic | Bounded pane tail for human diagnosis in JSON callers; empty when the session is missing. Defaults to 20 lines. |
| `confirmation_detected` | boolean | diagnostic | `true` when the pane appears to be waiting for an interactive permission, approval, SSH, or login prompt. |
| `blocked_reason` | string or null | diagnostic | Best-effort enum-like reason: `permission_prompt`, `approval_prompt`, `ssh_prompt`, `login_prompt`, or `cli_exited`. |

`diagnostic`, `confirmation_detected`, and `blocked_reason` are best-effort hints from bounded pane text. They do not prove root cause and never auto-accept prompts. Tune the JSON tail with `CLAUDE_TMUX_STATUS_TAIL_LINES` or `CODEX_TMUX_STATUS_TAIL_LINES`; invalid values fall back to 20. The tail is diagnostic and bounded by the wrapper's 80-line status capture window.

Reliability checks:

```bash
codex-tmux doctor
codex-tmux self-test
claude-tmux doctor
claude-tmux self-test
```

`claude-tmux status <name>` and `codex-tmux status <name>` report diagnostics when the pane appears to be waiting for known first-run, permission, approval, SSH, or login prompts. They do not auto-accept prompts; attach or capture the pane and make the decision explicitly.

Remote run with local tmux:

```bash
claude-tmux start-ssh --exact review openclaw-macmini ~/github/project 'Review the diff.'
```

Bounded dialogue with JSONL transcript:

```bash
tmux-agent-dialogue \
  --turns 4 \
  --workdir . \
  --agent-a fake \
  --agent-b fake \
  --prompt-file prompt.md \
  --transcript transcript.jsonl
```

Real participants use the same command shape with `--agent-a codex --agent-b claude`. Real turns use a split-marker contract so the prompt echo cannot satisfy the wait; the required final response line must contain only the joined marker. On timeout, the runner writes a `failure` JSONL event with a conservative `failure_type` such as `marker_timeout` or `session_missing`, and prints the captured pane tail for diagnosis. Keep real-agent smoke as manual release evidence, not a default CI check.

Participant profiles can reduce repeated agent, SSH, and workdir flags without adding project-specific shortcuts. By default, `tmux-agent-dialogue` reads `~/.config/tmux-agent-tools/participants.json`; set `TMUX_AGENT_TOOLS_PARTICIPANTS` or pass `--participants-config <path>` to use another file.

```json
{
  "local-reviewer": {
    "agent": "claude",
    "workdir": "/Users/example/github/project",
    "timeout": "240",
    "env": {
      "TMUX_AGENT_MODE": "review"
    }
  },
  "remote-worker": {
    "agent": "codex",
    "ssh": "example-host",
    "workdir": "/Users/example/github/project"
  }
}
```

Use profiles with `--agent-a-profile <name>` or `--agent-b-profile <name>`. Command-line flags such as `--agent-a`, `--agent-a-ssh`, `--agent-a-workdir`, and `--timeout` override profile values. Profiles may only contain `agent`, `ssh`, `workdir`, `timeout`, and `env`; `timeout` must be a positive integer string in seconds, and applies only to that participant when the run does not pass `--timeout`. `env` must be an object of newline-free string values keyed by shell environment names. Profile env is passed to the local wrapper/session process. For SSH participants, remote environment behavior depends on SSH and remote shell configuration; do not rely on profile env as a secret transport. `fake` participants cannot use SSH, and remote workdirs must be absolute paths.

Validate a transcript before sharing or rendering it:

```bash
tmux-agent-dialogue validate-transcript --transcript transcript.jsonl
tmux-agent-dialogue validate-transcript --schema-version 1 --transcript transcript.jsonl
```

The validator is local-only. The default validator behavior is schema version `1`; `--schema-version 1` pins the same contract explicitly, and unsupported schema versions fail without rewriting the transcript. It checks one JSON object per line, required `turn` and `failure` fields, known `failure_type` values when present, and emits line-level diagnostics for invalid JSONL or missing fields. `summarize` and `github-comment` reject invalid transcripts before rendering.

Remote participant:

```bash
tmux-agent-dialogue \
  --turns 2 \
  --workdir . \
  --agent-a codex \
  --agent-a-ssh openclaw-macmini \
  --agent-a-workdir /Users/paul.yeh/github/project \
  --agent-b claude \
  --prompt-file prompt.md \
  --transcript transcript.jsonl
```

Remote mode uses the existing wrapper `start-ssh` path: tmux stays local, while the selected real participant runs through SSH in the remote directory. `fake` participants cannot use SSH mode.
Use an absolute remote workdir such as `/Users/paul.yeh/github/project`; shell-expansion paths like `~/project` are rejected so the local wrapper does not quote them into a non-expanded remote path.

Credential-free smoke:

```bash
tmux-agent-dialogue --turns 2 --workdir . --agent-a fake --agent-b fake --prompt-file prompt.md --transcript transcript.jsonl
```

Pair-review preset:

```bash
tmux-agent-dialogue pair-review --workdir . --prompt-file review.md --transcript review.jsonl
```

`pair-review` defaults to a two-turn Codex-to-Claude exchange, writes the same JSONL transcript, and prints a local terminal summary. Add `--swap` to reverse the speaker order so agent B speaks first and agent A responds, without changing the participant definitions. It does not post GitHub comments, merge PRs, or publish externally by default.

Add `--on-blocked-trigger blocked.json` to a bounded dialogue run, `pair-review`, `critic`, `debate`, or `handoff` to write a local JSON trigger only when a participant appears blocked by a permission prompt, SSH prompt, or CLI exit. Non-blocked runs do not create the file. The artifact includes `event`, `turn`, `participant`, `agent`, `marker`, `blocked_reason`, and `timestamp`; this flag never accepts prompts or posts externally.

Critic preset:

```bash
tmux-agent-dialogue critic --workdir . --prompt-file review.md --transcript critic.jsonl
```

`critic` is a thin four-turn preset over the same bounded dialogue runner. Agent A critiques on odd turns, agent B responds on even turns, and `--turns` may be overridden only with a positive even number. Like `pair-review`, it only writes local transcript/summary output and has no hidden GitHub posting, merging, scheduling, or unbounded loop behavior.

Debate preset:

```bash
tmux-agent-dialogue debate --workdir . --prompt-file review.md --transcript debate.jsonl
```

`debate` is a thin four-turn preset for structured back-and-forth critique. Agent A argues on odd turns, agent B argues on even turns, and `--turns` may be overridden only with a positive even number. It does not pick a winner, arbitrate the result, post GitHub comments, merge PRs, schedule work, or continue unbounded.

Handoff preset:

```bash
tmux-agent-dialogue handoff --workdir . --prompt-file task.md --transcript handoff.jsonl
```

`handoff` is a thin two-turn preset for bounded context transfer. Agent A produces the handoff on turn 1, agent B responds on turn 2 with readiness, risks, or next-action notes. It rejects non-two-turn flows and only writes local transcript/summary output.

Write the local summary to a file:

```bash
tmux-agent-dialogue handoff --workdir . --prompt-file task.md --transcript handoff.jsonl --summary-file handoff-summary.md
```

Post the summary to a GitHub PR only when explicitly requested:

```bash
tmux-agent-dialogue github-comment --transcript review.jsonl --github-pr 123 --github-repo owner/repo --post-github-comment
tmux-agent-dialogue github-comment --summary-file review-summary.md --github-repo owner/repo --edit-existing 123456789 --post-github-comment
```

Without `--post-github-comment`, `github-comment` prints the comment body as a dry run. Posting or editing requires GitHub CLI authentication and never runs unless the flag is present. Use `github-comment --summary-file <path>` to reuse a pre-rendered local summary body instead of re-rendering from a transcript; `github-comment` requires exactly one of `--transcript` or `--summary-file`. By default, posting appends with `gh pr comment` and requires `--github-pr`; pass `--edit-existing <comment-id>` to update a known issue comment through `gh api` instead of appending.

Before sharing a rendered summary, limit or redact the Markdown body:

```bash
tmux-agent-dialogue summarize --transcript review.jsonl --max-lines 80 --redact-pattern 'token_[A-Za-z0-9]+'
tmux-agent-dialogue summarize --transcript review.jsonl --output-format json
tmux-agent-dialogue github-comment --transcript review.jsonl --github-pr 123 --github-repo owner/repo --output-format json
tmux-agent-dialogue github-comment --transcript review.jsonl --github-pr 123 --github-repo owner/repo --max-bytes 60000 --redact-pattern 'secret-[^ ]+'
tmux-agent-dialogue github-comment --summary-file review-summary.md --github-pr 123 --github-repo owner/repo --max-lines 80
```

`--redact-pattern` can be repeated. Redaction and truncation notes are included in the generated Markdown, and the dry-run `github-comment` body is the same body used for `--post-github-comment`. `summarize --output-format json` keeps Markdown as the default format while adding top-level `schema_version: "1"` plus structured `turns`, `failures`, `metadata`, and `rendered_markdown` fields for scripts; `--summary-file` writes the selected format. `github-comment --output-format json` returns a structured local result with `status` (`dry_run`, `posted`, or `edited`), `action`, repository fields, rendered body metadata, and `comment_url` or `comment_id` only when available from `gh`; GitHub writes still require explicit `--post-github-comment`.

## Requirements

- `zsh`
- `tmux`
- `claude` on `PATH` for `claude-tmux`
- `codex` on `PATH` for `codex-tmux`

Override binary paths when needed:

```bash
TMUX=/opt/homebrew/bin/tmux CLAUDE=~/.local/bin/claude claude-tmux help
CODEX=/path/to/codex codex-tmux help
```

## Codex Skill

The reusable Codex skill lives at:

```text
skills/tmux-agent-tools
```

The shell wrappers live inside the skill package:

```text
skills/tmux-agent-tools/scripts/claude-tmux
skills/tmux-agent-tools/scripts/codex-tmux
```

Install it into Codex skill discovery with:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s "$PWD/skills/tmux-agent-tools" "${CODEX_HOME:-$HOME/.codex}/skills/tmux-agent-tools"
```
