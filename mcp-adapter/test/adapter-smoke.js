const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const {
  NO_BACKGROUND_JOBS_GUARD,
  NO_CASCADE_GUARD,
  NO_EXTERNAL_SIDE_EFFECTS_GUARD,
  closeTmuxAgent,
  deliveries,
  ensureAdapterLive,
  getHost,
  readTmuxAgent,
  resolveCoreModule,
  sendTmuxAgent,
  spawnTmuxAgent,
  stopHeartbeat,
  waitTmuxAgent,
} = require("../src/adapter");

const { newGate, reconcileOnce } = resolveCoreModule("workers.ts");
const { nodeHost } = resolveCoreModule("host.node.ts");

async function main() {
  const repo = path.resolve(__dirname, "..");
  assert.ok(
    fs.existsSync(path.resolve(repo, "../skills/tmux-agent-tools/scripts/lib/workers.ts")),
    "repo launch path must resolve the core next to mcp-adapter"
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-adapter-smoke-"));
  process.env.TMUX_AGENT_DIR = tmp;
  process.env.FAKE_AGENT_TMUX_ROOT = tmp;
  process.env.PATH = `${path.join(__dirname, "fixtures/bin")}${path.delimiter}${process.env.PATH}`;

  // 1. tools/list + tools/call over stdio JSON-RPC
  const client = new Client({ name: "adapter-smoke-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, "src/server.js")],
    cwd: repo,
    env: process.env,
    stderr: "pipe",
  });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    "close_tmux_agent",
    "read_tmux_agent",
    "send_tmux_agent",
    "spawn_tmux_agent",
    "wait_tmux_agent",
  ]);

  // tools/call over stdio JSON-RPC
  const rpcSpawnResult = await client.callTool({
    name: "spawn_tmux_agent",
    arguments: { cli: "fake", repoPath: repo, task: "stdio rpc worker", name: "adapter-rpc" },
  });
  assert.ok(!rpcSpawnResult.isError);
  const rpcSpawned = rpcSpawnResult.structuredContent;
  assert.match(rpcSpawned.agent_id, /^adapter-rpc\.[0-9a-z]{5}$/);
  assert.equal(rpcSpawned.result_path, path.join(tmp, ".v3", rpcSpawned.agent_id, "result.json"));

  fs.writeFileSync(rpcSpawned.result_path, JSON.stringify({
    schema_version: 1,
    status: "done",
    summary: "rpc ok",
    artifacts: [],
    errors: [],
  }));

  const rpcReadResult = await client.callTool({
    name: "read_tmux_agent",
    arguments: { agent_id: rpcSpawned.agent_id },
  });
  assert.ok(!rpcReadResult.isError);
  assert.equal(rpcReadResult.structuredContent.status, "done");

  const rpcCloseResult = await client.callTool({
    name: "close_tmux_agent",
    arguments: { agent_id: rpcSpawned.agent_id },
  });
  assert.ok(!rpcCloseResult.isError);
  assert.equal(rpcCloseResult.structuredContent.closed, true);

  await client.close();

  // 2. Doctor and dry-run checks
  assert.equal(JSON.parse(execFileSync("agent-tmux", ["fake", "doctor", "--json"], { encoding: "utf8" })).ok, true);
  assert.equal(JSON.parse(execFileSync("agent-tmux", ["fake", "start", "--dry-run"], { encoding: "utf8" })).dry_run, true);

  // 3. spawn_tmux_agent assertion mapping
  const spawned = await spawnTmuxAgent({
    cli: "fake",
    repoPath: repo,
    task: "write a result",
    name: "adapter-smoke",
  });
  assert.match(spawned.agent_id, /^adapter-smoke\.[0-9a-z]{5}$/);
  assert.equal(spawned.result_path, path.join(tmp, ".v3", spawned.agent_id, "result.json"));

  const brief = fs.readFileSync(path.join(tmp, ".v3", spawned.agent_id, "brief.md"), "utf8");
  assert.match(brief, /GOAL: write a result/);
  assert.match(brief, /Result JSON must include schema_version, status, summary, artifacts, and errors\./);
  assert.ok(brief.includes(NO_CASCADE_GUARD));
  assert.ok(brief.includes(NO_BACKGROUND_JOBS_GUARD));
  assert.ok(brief.includes(NO_EXTERNAL_SIDE_EFFECTS_GUARD));

  // 4. send_tmux_agent
  process.env.FAKE_SEND_RESULT_JSON = "1";
  const sent = await sendTmuxAgent(spawned.agent_id, "finish now");
  assert.deepEqual(sent, { status: "submitted", completion_source: "result_json" });
  delete process.env.FAKE_SEND_RESULT_JSON;

  // 5. wait_tmux_agent
  const waited = await waitTmuxAgent(spawned.agent_id, 1);
  assert.equal(waited.status, "completed");
  assert.equal(waited.body.summary, "ok");

  // 6. read_tmux_agent
  const read = await readTmuxAgent(spawned.agent_id);
  assert.equal(read.status, "done");

  // 7. incomplete result handling
  const incomplete = await spawnTmuxAgent({
    cli: "fake",
    repoPath: repo,
    task: "write an incomplete result",
    name: "adapter-incomplete",
  });
  fs.writeFileSync(incomplete.result_path, JSON.stringify({ schema_version: 1, status: "done" }));
  const incompleteWaited = await waitTmuxAgent(incomplete.agent_id, 1);
  assert.equal(incompleteWaited.status, "failed");
  assert.equal(incompleteWaited.reason, "invalid_result");
  assert.deepEqual(incompleteWaited.detail.missing_fields, ["summary", "artifacts", "errors"]);

  // 8. close_tmux_agent
  const closed = await closeTmuxAgent(spawned.agent_id);
  assert.deepEqual(closed, { closed: true });

  // 9. multiple concurrent workers
  const a = await spawnTmuxAgent({ cli: "fake", repoPath: repo, task: "a", name: "adapter-a" });
  const b = await spawnTmuxAgent({ cli: "fake", repoPath: repo, task: "b", name: "adapter-b" });
  process.env.FAKE_SEND_RESULT_JSON = "1";
  await sendTmuxAgent(a.agent_id, "finish a");
  await sendTmuxAgent(b.agent_id, "finish b");
  const multi = await Promise.all([waitTmuxAgent(a.agent_id, 1), waitTmuxAgent(b.agent_id, 1)]);
  assert.deepEqual(multi.map((r) => r.status), ["completed", "completed"]);
  delete process.env.FAKE_SEND_RESULT_JSON;

  // 10. edge cases: missing, timed out, blocked, invalid, dead
  const missing = await spawnTmuxAgent({ cli: "fake", repoPath: repo, task: "no result", name: "adapter-missing" });
  const timedOut = await waitTmuxAgent(missing.agent_id, 0);
  assert.equal(timedOut.status, "timed_out");
  assert.equal(timedOut.reason, "missing_result");

  process.env.FAKE_STATUS_BLOCKED = "1";
  const blocked = await waitTmuxAgent(missing.agent_id, 0);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocked_reason, "permission_prompt");
  process.env.FAKE_STATUS_BLOCKED_REASON = "login_prompt";
  const loginBlocked = await waitTmuxAgent(missing.agent_id, 0);
  assert.equal(loginBlocked.status, "blocked");
  assert.equal(loginBlocked.blocked_reason, "login_prompt");
  delete process.env.FAKE_STATUS_BLOCKED;
  delete process.env.FAKE_STATUS_BLOCKED_REASON;

  process.env.FAKE_SEND_BLOCKED = "1";
  const sendBlocked = await sendTmuxAgent(missing.agent_id, "are you there?");
  assert.equal(sendBlocked.status, "blocked");
  assert.equal(sendBlocked.blocked_reason, "login_prompt");
  delete process.env.FAKE_SEND_BLOCKED;

  process.env.FAKE_DEAD_SESSION = "1";
  const dead = await waitTmuxAgent(missing.agent_id, 0);
  assert.equal(dead.status, "failed");
  assert.equal(dead.reason, "dead_session");
  delete process.env.FAKE_DEAD_SESSION;

  process.env.FAKE_STATUS_DEADLINE = "1";
  const deadline = await waitTmuxAgent(missing.agent_id, 0);
  assert.equal(deadline.status, "timed_out");
  assert.notEqual(deadline.reason, "dead_session");
  delete process.env.FAKE_STATUS_DEADLINE;

  const invalid = await spawnTmuxAgent({ cli: "fake", repoPath: repo, task: "invalid result", name: "adapter-invalid" });
  fs.writeFileSync(invalid.result_path, "{ corrupt json");
  const invalidWaited = await waitTmuxAgent(invalid.agent_id, 0);
  assert.equal(invalidWaited.status, "failed");
  assert.equal(invalidWaited.reason, "invalid_result");

  // 11. Prefix matching ambiguity check (Finding 6)
  const prefixA = await spawnTmuxAgent({ cli: "fake", repoPath: repo, task: "prefix 1", name: "adapter-multi" });
  const prefixB = await spawnTmuxAgent({ cli: "fake", repoPath: repo, task: "prefix 2", name: "adapter-multi" });
  assert.notEqual(prefixA.agent_id, prefixB.agent_id);
  await assert.rejects(
    async () => {
      await waitTmuxAgent("adapter-multi", 0);
    },
    (err) => {
      assert.equal(err.code, "AMBIGUOUS_AGENT");
      assert.ok(err.message.includes("ambiguous agent_id"));
      assert.ok(Array.isArray(err.matches) && err.matches.length >= 2);
      return true;
    }
  );

  // 12. IO error vs unknown agent check (Finding 3: unknown ≠ absent)
  await assert.rejects(
    async () => {
      await waitTmuxAgent("nonexistent-worker", 0);
    },
    (err) => {
      assert.equal(err.code, "UNKNOWN_AGENT");
      return true;
    }
  );

  // 13. Server restart test: spawn with server 1, kill it, read with fresh server 2 from ledger
  delete process.env.TMUX_AGENT_SESSION;
  const restartClient1 = new Client({ name: "restart-client-1", version: "1.0.0" });
  const restartTransport1 = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, "src/server.js")],
    cwd: repo,
    env: process.env,
    stderr: "pipe",
  });
  await restartClient1.connect(restartTransport1);
  const restartSpawn = await restartClient1.callTool({
    name: "spawn_tmux_agent",
    arguments: { cli: "fake", repoPath: repo, task: "survive restart", name: "adapter-restart" },
  });
  const restartId = restartSpawn.structuredContent.agent_id;
  const restartResultPath = restartSpawn.structuredContent.result_path;
  fs.writeFileSync(restartResultPath, JSON.stringify({
    schema_version: 1,
    status: "done",
    summary: "survived restart",
    artifacts: [],
    errors: [],
  }));

  // Verify stable session id was recorded on disk
  const stableIdPath = path.join(tmp, ".v3", ".mcp-session-id");
  assert.ok(fs.existsSync(stableIdPath), "stable session id must be persisted");
  const session1Id = fs.readFileSync(stableIdPath, "utf8").trim();
  assert.ok(session1Id.startsWith("mcp-session-"));

  // Kill server process 1 by closing client transport
  await restartClient1.close();

  // Start fresh server process 2
  const restartClient2 = new Client({ name: "restart-client-2", version: "1.0.0" });
  const restartTransport2 = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, "src/server.js")],
    cwd: repo,
    env: process.env,
    stderr: "pipe",
  });
  await restartClient2.connect(restartTransport2);

  // Verify server 2 reuses the same stable session id
  const session2Id = fs.readFileSync(stableIdPath, "utf8").trim();
  assert.equal(session2Id, session1Id, "server 2 must reuse the same stable session id across restart");

  const restartRead = await restartClient2.callTool({
    name: "read_tmux_agent",
    arguments: { agent_id: restartId },
  });
  assert.equal(restartRead.structuredContent.status, "done");
  assert.equal(restartRead.structuredContent.summary, "survived restart");
  await restartClient2.close();

  // 14. Dual-install test: two adapter processes on one root do not both own or double-deliver
  process.env.TMUX_AGENT_SESSION = "adapter-session-alpha";
  const alphaHost = getHost(repo);
  await ensureAdapterLive(alphaHost);
  const alphaSpawned = await spawnTmuxAgent({
    cli: "fake",
    repoPath: repo,
    task: "dual-install worker",
    name: "adapter-dual",
  });
  const dualId = alphaSpawned.agent_id;
  const workerJsonPath = path.join(tmp, ".v3", dualId, "worker.json");
  const dispatchJsonPath = path.join(tmp, ".v3", dualId, "episodes", "1", "dispatch.json");
  const workerRec = JSON.parse(fs.readFileSync(workerJsonPath, "utf8"));
  const dispatchRec = JSON.parse(fs.readFileSync(dispatchJsonPath, "utf8"));
  assert.equal(workerRec.owner, "adapter-session-alpha");
  assert.equal(dispatchRec.owner, "adapter-session-alpha");

  // Write valid result
  fs.writeFileSync(alphaSpawned.result_path, JSON.stringify({
    schema_version: 1,
    status: "success",
    summary: "dual ok",
    artifacts: [],
    errors: [],
    episode: 1,
  }));

  // Alpha waits and completes delivery into ledger
  const before = deliveries();
  const alphaWaited = await waitTmuxAgent(dualId, 1);
  assert.equal(alphaWaited.status, "completed");
  const alphaDeliveries = deliveries() - before;
  assert.equal(alphaDeliveries, 1);

  // Verify acks/done was written by waitTmuxAgent
  const ackDoneDir = path.join(tmp, ".v3", dualId, "episodes", "1", "acks", "done");
  assert.ok(fs.existsSync(ackDoneDir), "acks/done must exist in ledger after waitTmuxAgent completes");

  // Process beta with distinct session and its own submission tracker
  process.env.TMUX_AGENT_SESSION = "adapter-session-beta";
  let betaDeliveries = 0;
  const betaHost = nodeHost({
    owner: "adapter-session-beta",
    cwd: repo,
    log: () => {},
    submit: async () => {
      betaDeliveries += 1;
      return {};
    },
  });
  const betaGate = newGate();

  // A claim lands on the first pass and the delivery on the next (§3). Two passes
  // are what shows a second install delivering the same episode.
  await reconcileOnce(betaHost, betaGate);
  await reconcileOnce(betaHost, betaGate);

  assert.equal(alphaDeliveries + betaDeliveries, 1, "exactly one delivery of one finished episode across two sessions");
  assert.equal(betaDeliveries, 0, "Beta must not deliver episode already acknowledged and closed by Alpha");

  // Also verify beta reading does not alter original ownership
  const betaRead = await readTmuxAgent(dualId);
  assert.equal(betaRead.status, "success");
  const dispatchCheck = JSON.parse(fs.readFileSync(dispatchJsonPath, "utf8"));
  assert.equal(dispatchCheck.owner, "adapter-session-alpha");
  delete process.env.TMUX_AGENT_SESSION;

  stopHeartbeat();
  console.log("adapter smoke ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
