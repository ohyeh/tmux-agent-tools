# codex-tmux-agent-adapter

Small MCP server exposing a Codex-shaped lifecycle over `tmux-agent-tools` workers:

- `spawn_tmux_agent`
- `send_tmux_agent`
- `wait_tmux_agent`
- `read_tmux_agent`
- `close_tmux_agent`

This is a managed external-worker adapter with a sub-agent-like lifecycle. It is not a native Codex `spawn_agent` provider. Codex's host-owned `spawn_agent` / `wait_agent` / `send_input` / `close_agent` surface is separate, and this package does not register as one of those providers. As of this writing, there is no known Codex extension point that lets this package become a host-native provider.

## Integration Depth

| Option | Status | Notes |
| --- | --- | --- |
| MCP server | Shipped here | Codex or another MCP client can call these tools, while `agent-tmux` remains the execution backend. |
| Codex plugin tools | Not shipped | Could wrap the same lifecycle as plugin-facing tools if that is the desired packaging surface. |
| Host-native provider | Not shipped | Only viable if Codex exposes an official provider extension point. |

## Backend Contract

The adapter does not invent a second orchestration model. Each operation shells out to existing commands:

- `agent-tmux <cli> doctor --json`
- `agent-tmux <cli> start --exact ...`
- `agent-tmux <cli> send-wait ...`
- `agent-tmux <cli> status --json ...`
- `agent-tmux <cli> result --json ...`
- `agent-tmux <cli> result wait-required ...`
- `agent-tmux <cli> watch --any|--all|--count ...`
- `agent-tmux <cli> stop ...`
- `tmux-agent-sessions resolve/list/diff/cleanup ...`

Every spawned worker prompt appends the literal wrapper result path and:

```text
Do not spawn additional tmux sessions or delegate further.
```

Completion is based on `result.json` via `result wait-required`, not pane scraping.

## Multi-Worker Pattern

Spawn several workers with `spawn_tmux_agent`, keep their returned `agent_id` values, then call `wait_tmux_agent` for each id. This is the MCP equivalent of a watch-style fan-in while keeping the adapter at exactly five lifecycle tools.

## Run

```sh
npm install
npm test
node src/server.js
```

Set `TMUX_AGENT_TMUX_BIN=/path/to/agent-tmux` when `agent-tmux` is not on `PATH`.
