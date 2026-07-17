# Getting Started

For a **human developer** who just installed the tool and wants a working agent in 5 minutes.

## Install

```bash
brew tap ohyeh/tmux-agent-tools
brew install tmux-agent-tools
```

If you cloned the repo directly:

```bash
cd tmux-agent-tools
skills/tmux-agent-tools/scripts/install-bin
```

`install-bin` symlinks the wrappers into `~/.local/bin`. Make sure that directory is on your `PATH`.

## Verify the environment

```bash
codex-tmux doctor
claude-tmux doctor
codex-tmux self-test
```

- `doctor` reports missing dependencies (tmux, jq, the agent CLI itself).
- `self-test` exercises capture/wait round-trip without spawning a real agent. Both should exit 0.

If `doctor` flags anything, fix it before continuing — every later step assumes a clean doctor.

## Hello, agent

```bash
codex-tmux start --exact hello ~ 'Print HELLO from your first agent, then write final JSON to the wrapper-provided result path: {"schema_version":1,"status":"ok","summary":"hello complete","artifacts":[],"errors":[]}'
codex-tmux wait-text hello 'HELLO' 60
codex-tmux capture hello 30
codex-tmux result wait-required hello --fields status,summary --wait 60 --json
codex-tmux stop hello
```

What just happened:

1. `start --exact hello ~ '<prompt>'` — created tmux session `codex-cli-hello` rooted at `~`, fed Codex CLI the prompt.
2. `wait-text` — blocked until the visible pane matched `HELLO` (60s budget).
3. `capture` — read the last 30 lines of pane.
4. `result wait-required` — waited for the structured result fields the agent wrote. Token cost = result body, not scrollback.
5. `stop` — kill the tmux session.

## What just got created on disk

| Path | What |
| --- | --- |
| `$TMUX_AGENT_DIR/hello/` | Per-agent state (default `$XDG_STATE_HOME/tmux-agent-tools/<name>` or `~/.local/state/tmux-agent-tools/<name>`) |
| `$TMUX_AGENT_DIR/hello/result.json` | The structured result the agent wrote |
| `$TMUX_AGENT_DIR/hello/transcript.jsonl` | If you passed `--transcript` |
| tmux session `codex-cli-hello` | Killed by `stop` |

Look around the state directory to understand what the wrapper persists.

## Common next steps

- **A longer agent run that signals completion across processes** — pass `start --sentinel /tmp/x.exit` and watch the sentinel file from another shell.
- **A reusable structured result** — make the agent write the wrapper-provided literal result path and read it via `result --json --wait 30 <name>` or `result wait-required <name> --fields status,summary --wait 60 --json`. See [Recipes](Recipes).
- **Inject a secret without leaking it into the command line** — `--secret KEY=op://Vault/Item/field`. See [Observability and Secrets](Observability-and-Secrets).
- **Run two agents in parallel on the same prompt** — `tmux-agent-fanout run --agent claude:r --agent codex:r --workdir . ...`. See [Recipes](Recipes).

## When to stop using this

If your task is one-off, non-interactive, fits in a single shell command, or doesn't need the agent CLI at all — don't use these wrappers. They are for **long-running, conversational, scriptable** agent sessions.
