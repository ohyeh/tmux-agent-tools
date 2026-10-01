#!/usr/bin/env node
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { serializeMessage } = require("@modelcontextprotocol/sdk/shared/stdio.js");
const { z } = require("zod");
const {
  closeTmuxAgent,
  ensureAdapterLive,
  getHost,
  readTmuxAgent,
  sendTmuxAgent,
  settleAllUnsent,
  settleWhenWritten,
  spawnTmuxAgent,
  waitTmuxAgent,
} = require("./adapter");

/**
 * stdio with the delivery boundary of plan §1c S4. The SDK's `send` resolves when
 * `write` returns true, before the bytes reach the pipe; this one resolves on the
 * write callback. A parked wait ack (adapter.js `holdAck`) runs once the response to
 * its request is flushed as a success; an error response, a write error or a close
 * settles it unsent.
 */
class AckingStdioTransport extends StdioServerTransport {
  constructor(stdin = process.stdin, stdout = process.stdout) {
    super(stdin, stdout);
    this.out = stdout;
  }

  send(message) {
    const written = new Promise((resolve) => {
      this.out.write(serializeMessage(message), (err) => resolve(err || null));
    });
    const response = message.id !== undefined && ("result" in message || "error" in message);
    const acked = response
      ? settleWhenWritten(message.id, written.then((err) => !err && "result" in message && !message.result?.isError))
      : Promise.resolve();
    return written.then(async (err) => {
      await acked;
      if (err) throw err;
    });
  }

  async close() {
    await settleAllUnsent();
    return super.close();
  }
}

function toolResult(value) {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function createServer() {
  const server = new McpServer({
    name: "codex-tmux-agent-adapter",
    // build.mjs defines this as the release version; src/ runs report the package version.
    version: typeof __TMUX_AGENT_VERSION__ === "string" ? __TMUX_AGENT_VERSION__ : "1.0.0",
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
  // spawn and send answer the episode's `seq`; wait/read with it stay on that episode.

  server.registerTool("wait_tmux_agent", {
    title: "Wait for tmux-agent-tools worker",
    description:
      "Wait for one episode's result (seq from spawn/send; default: the latest at call time). " +
      "At-least-once: a re-report carries the same delivery_id; dedup by it.",
    inputSchema: {
      agent_id: z.string().min(1),
      timeoutSec: z.number().int().nonnegative().optional(),
      seq: z.number().optional(),
    },
  }, async ({ agent_id, timeoutSec, seq }, extra) => toolResult(await waitTmuxAgent(agent_id, timeoutSec, { seq, extra })));

  server.registerTool("read_tmux_agent", {
    title: "Read tmux-agent-tools worker result",
    description: "Read the parsed agent-tmux result body.",
    inputSchema: {
      agent_id: z.string().min(1),
      seq: z.number().optional(),
    },
  }, async ({ agent_id, seq }) => toolResult(await readTmuxAgent(agent_id, seq)));

  server.registerTool("close_tmux_agent", {
    title: "Close tmux-agent-tools worker",
    description: "Stop a tmux-agent-tools worker by managed handle.",
    inputSchema: {
      agent_id: z.string().min(1),
    },
  }, async ({ agent_id }) => toolResult(await closeTmuxAgent(agent_id)));

  return server;
}

async function main(transport = new AckingStdioTransport()) {
  await ensureAdapterLive(await getHost());
  const server = createServer();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { AckingStdioTransport, createServer, main };
