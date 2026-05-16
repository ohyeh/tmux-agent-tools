# tmux-agent-tools

Small tmux wrappers for running Claude Code and Codex CLI as controllable named sessions.

This repository is both:

- a `skills.sh` compatible skill package;
- a Homebrew formula source for installing `claude-tmux`, `codex-tmux`, and `tmux-agent-dialogue` on macOS or Linuxbrew.

## Inspired By

This project is inspired by two tmux skills in the `skills.sh` ecosystem:

- [mitsuhiko/agent-stuff/tmux](https://www.skills.sh/mitsuhiko/agent-stuff/tmux), especially the pattern of pairing a compact `SKILL.md` with shell helpers under `scripts/`.
- [steipete/clawdis/tmux](https://www.skills.sh/steipete/clawdis/tmux), especially the practical guidance around using tmux for long-running interactive agent sessions instead of one-off shell commands.

`tmux-agent-tools` keeps that skill-first layout, but adds installable wrapper commands for Claude Code and Codex CLI.

## Tools

- `claude-tmux`: starts Claude Code in tmux with `--dangerously-skip-permissions`.
- `codex-tmux`: starts Codex CLI in tmux with `--yolo`.
- `tmux-agent-dialogue`: runs a bounded two-party tmux dialogue and writes a JSONL transcript.

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

Real participants use the same command shape with `--agent-a codex --agent-b claude`. Real turns use a split-marker contract so the prompt echo cannot satisfy the wait; the required final response line must contain only the joined marker. On timeout, the runner writes a `failure` JSONL event and prints the captured pane tail for diagnosis. Keep real-agent smoke as manual release evidence, not a default CI check.

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

`pair-review` defaults to a two-turn Codex-to-Claude exchange, writes the same JSONL transcript, and prints a local terminal summary. It does not post GitHub comments, merge PRs, or publish externally by default.

Write the local summary to a file:

```bash
tmux-agent-dialogue pair-review --workdir . --prompt-file review.md --transcript review.jsonl --summary-file review-summary.md
```

Post the summary to a GitHub PR only when explicitly requested:

```bash
tmux-agent-dialogue github-comment --transcript review.jsonl --github-pr 123 --github-repo owner/repo --post-github-comment
```

Without `--post-github-comment`, `github-comment` prints the comment body as a dry run. Posting requires GitHub CLI authentication and never runs unless the flag is present.

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
