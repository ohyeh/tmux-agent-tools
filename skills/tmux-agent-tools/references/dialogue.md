# Bounded Two-Agent Dialogue

Read this when the task needs `tmux-agent-dialogue` — a transcript-producing exchange between two participants. The presets (`critic`, `debate`, `pair-review`) are local-only and never post to GitHub. `github-comment` prepares a comment body without publishing unless `--post-github-comment` is passed.

## When dialogue is the right tool

Use dialogue when:

- A critique-and-response pattern is genuinely required (not just "one agent does it").
- A durable JSONL transcript is needed for audit, review, or summary.
- The user wants two perspectives without the cost of running both agents to completion independently.

Use fake participants (`--agent-a fake --agent-b fake`) for credential-free smoke tests. Run real `codex` / `claude` only when the user authorizes it or explicitly asks for real-agent dialogue. Run `tmux-agent-dialogue validate-transcript --transcript <path>` before summarizing or sharing a transcript. Treat `failure_type` as conservative diagnostic metadata, not proof of root cause.

## Core dialogue

```bash
tmux-agent-dialogue --turns 4 --workdir . \
  --agent-a fake --agent-b fake \
  --prompt-file prompt.md --transcript transcript.jsonl
```

Real-agent (after explicit authorization):

```bash
tmux-agent-dialogue --turns 2 --workdir . \
  --agent-a codex --agent-b claude \
  --prompt-file prompt.md --transcript transcript.jsonl
```

Real participants use a split marker. Each turn ends with one standalone final line containing only the joined marker. If a marker wait times out, inspect the emitted `failure` JSONL event and captured pane tail before treating the run as a protocol failure — it is often a prompt-shape issue.

## Presets

All presets default to four turns. Agent A speaks on odd turns, B on even. Custom `--turns` values must be positive even numbers. None of these presets post comments, merge PRs, schedule work, or continue unbounded.

### `pair-review`

Local review preset that writes only a transcript and terminal summary:

```bash
tmux-agent-dialogue pair-review --workdir . --prompt-file review.md --transcript review.jsonl
```

Use `--swap` for B-first ordering. Use `--summary-file <path>` for a local Markdown summary.

### `critic`

Bounded critique/response loop without external action:

```bash
tmux-agent-dialogue critic --workdir . --prompt-file review.md --transcript critic.jsonl
```

### `debate`

Bounded back-and-forth argument without winner selection or arbitration:

```bash
tmux-agent-dialogue debate --workdir . --prompt-file review.md --transcript debate.jsonl
```

## Preparing a GitHub comment

For any existing dialogue/preset transcript, prepare a comment body without posting:

```bash
tmux-agent-dialogue github-comment --transcript review.jsonl --github-pr 123 --github-repo owner/repo
```

Only add `--post-github-comment` when the user explicitly asks to publish. Use `--max-lines`, `--max-bytes`, and repeated `--redact-pattern` on `summarize` or `github-comment` for oversized or sensitive transcripts — the output includes visible truncation and redaction notes.

## Remote participants

When one real agent should run remotely while tmux stays local:

```bash
tmux-agent-dialogue --turns 2 --workdir . \
  --agent-a codex --agent-a-ssh example-host \
    --agent-a-workdir /Users/example/github/project \
  --agent-b claude \
  --prompt-file prompt.md --transcript transcript.jsonl
```

Only real participants can use `--agent-a-ssh` / `--agent-b-ssh`; `fake` is local-only. Remote workdirs must be absolute paths on the target host.

## Participant profiles

Profiles let teams share generic, reusable defaults — they are **not** for personal shortcuts in public docs. Location: `~/.config/tmux-agent-tools/participants.json` by default, or `TMUX_AGENT_TOOLS_PARTICIPANTS` / `--participants-config <path>`.

Each top-level profile may contain only:

- `agent` (codex / claude / fake)
- `ssh` (host)
- `workdir` (absolute on remote when ssh is set)
- `timeout` (positive integer seconds, applies only when `--timeout` is not passed)
- `env` (object of newline-free string values; passed to local wrapper/session process)

Command-line flags override profile values. For SSH participants, remote env behavior depends on the remote shell — do not rely on profile `env` as a secret transport.
