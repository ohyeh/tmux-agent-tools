#!/usr/bin/env node
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const {
  closeTmuxAgent,
  readTmuxAgent,
  sendTmuxAgent,
  spawnTmuxAgent,
  waitTmuxAgent,
} = require("./adapter");

function toolResult(value) {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function createServer() {
  const server = new McpServer({
    name: "codex-tmux-agent-adapter",
    version: "1.0.0",
  });

  server.registerTool("spawn_tmux_agent", {
    title: "Spawn tmux-agent-tools worker",
    description: "Start one tmux-agent-tools worker and return its managed handle.",
    inputSchema: {
      cli: z.string().min(1),
      repoPath: z.string().min(1),
      task: z.string().min(1),
      name: z.string().optional(),
      timeoutSec: z.number().int().positive().optional(),
    },
  }, async (request) => toolResult(await spawnTmuxAgent(request)));

  server.registerTool("send_tmux_agent", {
    title: "Send to tmux-agent-tools worker",
    description: "Submit a follow-up message through agent-tmux send-wait.",
    inputSchema: {
      agent_id: z.string().min(1),
      message: z.string(),
    },
  }, async ({ agent_id, message }) => toolResult(await sendTmuxAgent(agent_id, message)));

  server.registerTool("wait_tmux_agent", {
    title: "Wait for tmux-agent-tools worker",
    description: "Wait for required result.json fields through agent-tmux result wait-required.",
    inputSchema: {
      agent_id: z.string().min(1),
      timeoutSec: z.number().int().nonnegative().optional(),
    },
  }, async ({ agent_id, timeoutSec }) => toolResult(await waitTmuxAgent(agent_id, timeoutSec)));

  server.registerTool("read_tmux_agent", {
    title: "Read tmux-agent-tools worker result",
    description: "Read the parsed agent-tmux result body.",
    inputSchema: {
      agent_id: z.string().min(1),
    },
  }, async ({ agent_id }) => toolResult(await readTmuxAgent(agent_id)));

  server.registerTool("close_tmux_agent", {
    title: "Close tmux-agent-tools worker",
    description: "Stop a tmux-agent-tools worker by managed handle.",
    inputSchema: {
      agent_id: z.string().min(1),
    },
  }, async ({ agent_id }) => toolResult(await closeTmuxAgent(agent_id)));

  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { createServer };
