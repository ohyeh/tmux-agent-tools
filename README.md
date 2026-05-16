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

`tmux-agent-sessions list [--json]` gives a read-only cross-tool inventory for `claude-tmux`, `codex-tmux`, and `tmux-agent-dialogue` sessions. Claude and Codex inventory rows reuse the wrapper `status --json` contract and add `state` (`running`, `exited`, `stopped`, or wrapper-reported `missing`), so a pane that remains capturable after an exit-code marker is not reported as still running. Dialogue rows are tmux inventory rows and use conservative `running` state while the session exists. `tmux-agent-sessions cleanup --preview` is also read-only and includes the same state in JSON mode; `cleanup --execute` is required before it stops tool-owned sessions, and execution must include `--all`, `--tool`, or `--name`. It never stops tmux sessions outside the known tmux-agent-tools prefixes.

`tmux-agent-sessions` is included in the stable Homebrew install starting with `v0.3.0`.

Local and SSH sessions keep the pane open after the agent CLI exits, showing the exit code so failures can still be captured.

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

`claude-tmux status <name>` reports a diagnostic when the pane appears to be waiting for a Claude first-run or permission confirmation. It does not auto-accept that prompt; attach or capture the pane and make the decision explicitly.

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

Use profiles with `--agent-a-profile <name>` or `--agent-b-profile <name>`. Command-line flags such as `--agent-a`, `--agent-a-ssh`, and `--agent-a-workdir` override profile values. Profiles may only contain `agent`, `ssh`, `workdir`, and `env`; `env` must be an object of newline-free string values keyed by shell environment names. Profile env is passed to the local wrapper/session process. For SSH participants, remote environment behavior depends on SSH and remote shell configuration; do not rely on profile env as a secret transport. `fake` participants cannot use SSH, and remote workdirs must be absolute paths.

Validate a transcript before sharing or rendering it:

```bash
tmux-agent-dialogue validate-transcript --transcript transcript.jsonl
```

The validator is local-only. It checks one JSON object per line, required `turn` and `failure` fields, known `failure_type` values when present, and emits line-level diagnostics for invalid JSONL or missing fields. `summarize` and `github-comment` reject invalid transcripts before rendering.

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

Critic preset:

```bash
tmux-agent-dialogue critic --workdir . --prompt-file review.md --transcript critic.jsonl
```

`critic` is a thin four-turn preset over the same bounded dialogue runner. Agent A critiques on odd turns, agent B responds on even turns, and `--turns` may be overridden only with a positive even number. Like `pair-review`, it only writes local transcript/summary output and has no hidden GitHub posting, merging, scheduling, or unbounded loop behavior.

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
```

Without `--post-github-comment`, `github-comment` prints the comment body as a dry run. Posting requires GitHub CLI authentication and never runs unless the flag is present. Use `github-comment --summary-file <path>` to reuse a pre-rendered local summary body instead of re-rendering from a transcript; `github-comment` requires exactly one of `--transcript` or `--summary-file`.

Before sharing a rendered summary, limit or redact the Markdown body:

```bash
tmux-agent-dialogue summarize --transcript review.jsonl --max-lines 80 --redact-pattern 'token_[A-Za-z0-9]+'
tmux-agent-dialogue github-comment --transcript review.jsonl --github-pr 123 --github-repo owner/repo --max-bytes 60000 --redact-pattern 'secret-[^ ]+'
tmux-agent-dialogue github-comment --summary-file review-summary.md --github-pr 123 --github-repo owner/repo --max-lines 80
```

`--redact-pattern` can be repeated. Redaction and truncation notes are included in the generated Markdown, and the dry-run `github-comment` body is the same body used for `--post-github-comment`.

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
