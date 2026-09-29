# codex-tmux-agent-adapter

Small MCP server exposing a Codex-shaped lifecycle over `tmux-agent-tools` workers:

- `spawn_tmux_agent`
- `send_tmux_agent`
- `wait_tmux_agent`
- `read_tmux_agent`
- `close_tmux_agent`

## Installation

Install dependencies, then register the adapter with each host:

```sh
npm install
codex mcp add tmux-agent-adapter -- node <repo>/mcp-adapter/src/server.js
claude mcp add tmux-agent-adapter node <repo>/mcp-adapter/src/server.js
```

Substitute `<repo>/mcp-adapter/src/server.js` with the real absolute path on your machine because MCP registration is stored in the host CLI config and must resolve from any working directory.

That launch path is the install layout. `mcp-adapter/src/adapter.js` loads the core from `../../skills/tmux-agent-tools/scripts/lib/*.ts` (the repo, or a marketplace clone of it). If that file is missing it tries the same two installs `agent-tmux` already uses: `~/.claude/plugins/marketplaces/tmux-agent-tools/skills/tmux-agent-tools/scripts/lib` and `~/.agents/skills/tmux-agent-tools/scripts/lib`. `TMUX_AGENT_CORE_DIR` overrides both.

## Why this is the real native extension point

This is a managed external-worker adapter with a sub-agent-like lifecycle. It is not a native Codex `spawn_agent` provider. In `codex-cli 0.142.5`, `codex app-server generate-json-schema` has no `spawn_agent`, `wait_agent`, `send_input`, `close_agent`, or `multi_agent` protocol surface. The concrete extension mechanisms supported by the installed hosts are `codex mcp add <name> -- <command>` and `claude mcp add <name> <command>`, so this package is shaped as an MCP server instead of a nonexistent host-native agent provider.

## Integration Depth

| Option | Status | Notes |
| --- | --- | --- |
| MCP server | Shipped here | Codex or another MCP client can call these tools, while `agent-tmux` remains the execution backend. |
| Codex plugin tools | Not shipped | Could wrap the same lifecycle as plugin-facing tools if that is the desired packaging surface. |
| Host-native provider | Not shipped | Only viable if Codex exposes an official provider extension point. |

## Backend Contract

The adapter runs on the shared `workers-core` through `nodeHost`:

- `spawn_tmux_agent` → `assignWorker` (reserves v5 `<base>.<5 base36>` worker identity, publishes `worker.json`, opens episode 1 on the producer route `--result-path ... --episode 1`)
- `send_tmux_agent` → `tellWorker` (takes per-worker `.action` lock, allocates episode seq, sends via `--result-path ... --episode <seq>`)
- `wait_tmux_agent` → one delivery of that episode through the core (`claim` when this session is not the owner, `submit`, then `ackFinished`), only while this process's activation is still the session's max (§3, §3.3, §4, §8)
- `read_tmux_agent` → reads `result.json` if available, or pane status/capture via `peekWorker`
- `close_tmux_agent` → `stopWorker` (takes action lock, writes `acks/cancel` for all open episodes, kills pane)

The registry is the durable `.v3` ledger (`<root>/.v3/<name>/worker.json`), not an in-memory Map: a restarted server or independent MCP process discovers the same workers and their episode descriptors.


## Multi-Worker Pattern

Spawn several workers with `spawn_tmux_agent`, keep their returned `agent_id` values, then call `wait_tmux_agent` for each id. This is the MCP equivalent of a watch-style fan-in while keeping the adapter at exactly five lifecycle tools.

## Run

```sh
npm install
npm test
node src/server.js
```

Set `TMUX_AGENT_TMUX_BIN=/path/to/agent-tmux` when `agent-tmux` is not on `PATH`.
