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
  retireSession,
  sendTmuxAgent,
  settleAllUnsent,
  settleWhenWritten,
  spawnTmuxAgent,
  waitTmuxAgent,
  WAIT_CAP_SEC,
} = require("./adapter");

/**
 * stdio with the delivery boundary of plan §1c S4. The SDK's `send` resolves when
 * `write` returns true, before the bytes reach the pipe; this one resolves on the
 * write callback. A parked wait ack (adapter.js `holdAck`) runs once the response to
 * its request is flushed as a success; an error response, a write error or a close
 * settles it unsent. A closed stdin or a broken stdout means the host is gone (R8 F3):
 * `onhostgone(reason)` fires once per cause so `main` can shut down in order; a stdout
 * 'error' always has a listener, so a late write to a dead pipe cannot crash the process.
 */
class AckingStdioTransport extends StdioServerTransport {
  constructor(stdin = process.stdin, stdout = process.stdout) {
    super(stdin, stdout);
    this.out = stdout;
    this.closing = new Promise((resolve) => { this.markClosing = resolve; });
    const gone = (reason) => this.onhostgone?.(reason);
    stdin.once("end", () => gone("stdin ended"));
    stdin.once("close", () => gone("stdin closed"));
    stdout.on?.("error", (err) => gone(`stdout error: ${err.message}`));
  }

  send(message) {
    // A write callback that never returns must not outlive close(); a sync throw is a write error.
    const written = Promise.race([new Promise((resolve) => {
      try {
        this.out.write(serializeMessage(message), (err) => resolve(err || null));
      } catch (err) {
        resolve(err);
      }
    }), this.closing]);
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
    this.markClosing(new Error("transport closed"));
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
      `At-least-once: a re-report carries the same delivery_id; dedup by it. One call waits at most ${WAIT_CAP_SEC}s; ` +
      'if it returns {status:"pending"} (reason "wait_again" or "starting"), call it again with the same agent_id and seq.',
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

/**
 * The host going away (stdin end/close, stdout error) is an orderly shutdown, not a crash
 * and not an orphan: settle unsent responses as not-acked (the next owner re-reports the
 * same delivery_id), free this session's claim, exit. Bounded, so a stuck cleanup cannot
 * keep the process alive.
 */
async function main(transport = new AckingStdioTransport(), exit = process.exit) {
  await ensureAdapterLive(await getHost());
  const server = createServer();
  let stopping;
  transport.onhostgone = (reason) => {
    stopping ??= (async () => {
      process.stderr.write(`[mcp-adapter] host gone (${reason}); shutting down\n`);
      const cleanup = transport.close().then(retireSession);
      const bound = new Promise((resolve) => setTimeout(resolve, 5000).unref());
      await Promise.race([cleanup, bound]).catch((err) => process.stderr.write(`[mcp-adapter] shutdown: ${err}\n`));
      exit(0);
    })();
  };
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { AckingStdioTransport, createServer, main };
