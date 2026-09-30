const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const {
  NO_BACKGROUND_JOBS_GUARD,
  NO_CASCADE_GUARD,
  NO_EXTERNAL_SIDE_EFFECTS_GUARD,
  closeTmuxAgent,
  getHost,
  readTmuxAgent,
  sendTmuxAgent,
  spawnTmuxAgent,
  stopHeartbeat,
  waitTmuxAgent,
} = require("../src/adapter");

function childEnv(dir, extra = {}) {
  const env = {
    ...process.env,
    ...extra,
    TMUX_AGENT_DIR: dir,
    FAKE_AGENT_TMUX_ROOT: dir,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  if (!Object.prototype.hasOwnProperty.call(extra, "TMUX_AGENT_SESSION")) {
    delete env.TMUX_AGENT_SESSION;
  }
  return env;
}

function runAdapterChild(dir, args, extra) {
  const stdout = execFileSync(process.execPath, [__filename, "--child", ...args], {
    encoding: "utf8",
    env: childEnv(dir, extra),
    cwd: path.resolve(__dirname, ".."),
  });
  return JSON.parse(stdout.trim());
}

function runAdapterChildRaw(dir, args, extra) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, "--child", ...args], {
      env: childEnv(dir, extra),
      cwd: path.resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`adapter child ${args.join(" ")} exited ${code}: ${err}`));
        return;
      }
      resolve(out.trim());
    });
  });
}

// Both creators pass the missing-file check, then block inside write until the
// peer is there. That is the concurrent first-create window.
function installIdWriteBarrier() {
  const barrier = process.env.RACE_BARRIER;
  if (!barrier) {
    throw new Error("RACE_BARRIER is required");
  }
  const realWrite = fs.writeFileSync;
  let passed = false;
  fs.writeFileSync = (file, data, options) => {
    const target = typeof file === "string" ? file : "";
    if (!passed && target.endsWith(`${path.sep}.mcp-session-id`)) {
      passed = true;
      realWrite(path.join(barrier, `ready-${process.pid}`), "1");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const ready = fs.readdirSync(barrier).filter((name) => name.startsWith("ready-")).length;
        if (ready >= 2) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      const ready = fs.readdirSync(barrier).filter((name) => name.startsWith("ready-")).length;
      if (ready < 2) {
        throw new Error("session id create barrier timed out");
      }
    }
    return realWrite(file, data, options);
  };
}

function ageSessionBeats(dir) {
  const sessions = path.join(dir, ".v3", ".sessions");
  const old = (Date.now() - 90_000 - 10 * 60 * 1000) / 1000;
  let count = 0;
  const walk = (current) => {
    for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.name.endsWith(".beat")) {
        fs.utimesSync(full, old, old);
        count += 1;
      }
    }
  };
  walk(sessions);
  return count;
}

async function runChild(kind, args) {
  const repo = path.resolve(__dirname, "..");
  if (kind === "spawn-wait") {
    const spawned = await spawnTmuxAgent({
      cli: "fake",
      repoPath: repo,
      task: "deliver once",
      name: "adapter-once",
    });
    fs.writeFileSync(spawned.result_path, JSON.stringify({
      schema_version: 1,
      status: "success",
      summary: "once",
      artifacts: [],
      errors: [],
      episode: 1,
    }));
    const waited = await waitTmuxAgent(spawned.agent_id, 1);
    process.stdout.write(JSON.stringify({ agent_id: spawned.agent_id, waited }));
    return;
  }
  if (kind === "wait") {
    const waited = await waitTmuxAgent(args[0], 1);
    process.stdout.write(JSON.stringify(waited));
    return;
  }
  if (kind === "persist") {
    try {
      await spawnTmuxAgent({
        cli: "fake",
        repoPath: repo,
        task: "persist",
        name: "adapter-persist",
      });
      process.stdout.write(JSON.stringify({ threw: false, code: null, owner: getHost(repo).owner() }));
    } catch (err) {
      process.stdout.write(JSON.stringify({
        threw: true,
        code: err.code || null,
        message: err.message,
        owner: null,
      }));
    }
    return;
  }
  if (kind === "race-id") {
    installIdWriteBarrier();
    process.stdout.write(getHost(repo).owner());
    return;
  }
  throw new Error(`unknown child ${kind}`);
}

async function testSharedSessionDeliversOnce() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-shared-id-"));
  const first = runAdapterChild(dir, ["spawn-wait"]);
  assert.equal(first.waited.status, "completed");
  assert.equal(first.waited.body && first.waited.body.summary, "once");
  const second = runAdapterChild(dir, ["wait", first.agent_id]);
  assert.equal(second.status, "already_acked");
  assert.equal(second.body, undefined);
}

async function testClosedEpisodeNotClaimedByOtherOwner() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-closed-claim-"));
  const first = runAdapterChild(dir, ["spawn-wait"], { TMUX_AGENT_SESSION: "owner-a" });
  assert.equal(first.waited.status, "completed");
  assert.ok(fs.existsSync(path.join(dir, ".v3", first.agent_id, "episodes", "1", "acks", "done")));
  assert.ok(ageSessionBeats(dir) >= 1);
  const second = runAdapterChild(dir, ["wait", first.agent_id], { TMUX_AGENT_SESSION: "owner-b" });
  assert.equal(second.status, "already_acked");
  assert.equal(second.body, undefined);
  assert.equal(fs.existsSync(path.join(dir, ".v3", first.agent_id, "episodes", "1", "claims")), false);
}

async function testPersistFailureIsToolError() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-persist-"));
  fs.writeFileSync(path.join(dir, ".v3"), "not-a-directory\n");
  const out = runAdapterChild(dir, ["persist"]);
  assert.equal(out.threw, true, `persist failure must fail the tool call, owner=${out.owner} code=${out.code}`);
  assert.equal(out.code, "EEXIST");
  assert.equal(out.owner, null);
  assert.doesNotMatch(JSON.stringify(out), /ephemeral/);
}

async function testOverlappingWaitInSameProcessDeliversOnce() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-overlap-"));
  process.env.TMUX_AGENT_DIR = dir;
  process.env.FAKE_AGENT_TMUX_ROOT = dir;
  const repo = path.resolve(__dirname, "..");

  const spawned = await spawnTmuxAgent({
    cli: "fake",
    repoPath: repo,
    task: "overlap test",
    name: "adapter-overlap",
  });

  fs.writeFileSync(spawned.result_path, JSON.stringify({
    schema_version: 1,
    status: "success",
    summary: "overlap-body",
    artifacts: [],
    errors: [],
    episode: 1,
  }));

  const [w1, w2] = await Promise.all([
    waitTmuxAgent(spawned.agent_id, 2),
    waitTmuxAgent(spawned.agent_id, 2),
  ]);

  const completed = [w1, w2].filter((w) => w.status === "completed");
  const alreadyAcked = [w1, w2].filter((w) => w.status === "already_acked");
  assert.equal(completed.length, 1, "exactly one wait must return completed");
  assert.equal(alreadyAcked.length, 1, "the other wait must return already_acked");
  assert.equal(completed[0].body.summary, "overlap-body");
  assert.equal(alreadyAcked[0].body, undefined, "already_acked must not deliver body");
}

async function testWaitTerminalAndEpisodeChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-terminal-"));
  process.env.TMUX_AGENT_DIR = dir;
  process.env.FAKE_AGENT_TMUX_ROOT = dir;
  const repo = path.resolve(__dirname, "..");

  // Case 1: non-terminal status ("running") does not deliver and does not ack
  const sp1 = await spawnTmuxAgent({
    cli: "fake",
    repoPath: repo,
    task: "running test",
    name: "running-ag",
  });
  fs.writeFileSync(sp1.result_path, JSON.stringify({
    schema_version: 1,
    status: "running",
    summary: "in-flight",
    artifacts: [],
    errors: [],
    episode: 1,
  }));
  const w1 = await waitTmuxAgent(sp1.agent_id, 1);
  assert.ok(w1.status === "timed_out" || w1.status === "failed", "non-terminal status must not complete");
  assert.equal(fs.existsSync(path.join(dir, ".v3", sp1.agent_id, "episodes", "1", "acks", "done")), false);

  // Case 2: episode mismatch (episode 2 for targetSeq 1) does not deliver and does not ack
  const sp2 = await spawnTmuxAgent({
    cli: "fake",
    repoPath: repo,
    task: "mismatch test",
    name: "mismatch-ag",
  });
  fs.writeFileSync(sp2.result_path, JSON.stringify({
    schema_version: 1,
    status: "success",
    summary: "wrong-seq",
    artifacts: [],
    errors: [],
    episode: 2,
  }));
  const w2 = await waitTmuxAgent(sp2.agent_id, 1);
  assert.ok(w2.status === "timed_out" || w2.status === "failed", "mismatched episode must not complete");
  assert.equal(fs.existsSync(path.join(dir, ".v3", sp2.agent_id, "episodes", "1", "acks", "done")), false);

  // Case 3: empty status ("") fails invalid_result and does not turn into "done"
  const sp3 = await spawnTmuxAgent({
    cli: "fake",
    repoPath: repo,
    task: "empty status test",
    name: "empty-status-ag",
  });
  fs.writeFileSync(sp3.result_path, JSON.stringify({
    schema_version: 1,
    status: "",
    summary: "empty-status",
    artifacts: [],
    errors: [],
    episode: 1,
  }));
  const w3 = await waitTmuxAgent(sp3.agent_id, 1);
  assert.equal(w3.status, "failed");
  assert.equal(w3.reason, "invalid_result");
  assert.equal(fs.existsSync(path.join(dir, ".v3", sp3.agent_id, "episodes", "1", "acks", "done")), false);
}

async function testConcurrentSessionId() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-id-race-"));
  const barrier = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-id-barrier-"));
  const [left, right] = await Promise.all([
    runAdapterChildRaw(dir, ["race-id"], { RACE_BARRIER: barrier }),
    runAdapterChildRaw(dir, ["race-id"], { RACE_BARRIER: barrier }),
  ]);
  assert.equal(left, right);
  assert.equal(fs.readFileSync(path.join(dir, ".v3", ".mcp-session-id"), "utf8").trim(), left);
}

async function main() {
  if (process.argv[2] === "--child") {
    await runChild(process.argv[3], process.argv.slice(4));
    stopHeartbeat();
    return;
  }
  if (process.argv[2] === "--findings") {
    const fixtures = path.join(__dirname, "fixtures/bin");
    process.env.PATH = `${fixtures}${path.delimiter}${process.env.PATH}`;
    const which = process.argv[3] || "abcd";
    if (which.includes("a")) await testSharedSessionDeliversOnce();
    if (which.includes("b")) await testClosedEpisodeNotClaimedByOtherOwner();
    if (which.includes("c")) await testPersistFailureIsToolError();
    if (which.includes("d")) await testConcurrentSessionId();
    console.log(`findings ${which} ok`);
    return;
  }

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
  assert.equal(read.status, "success");

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

  delete process.env.TMUX_AGENT_SESSION;
  await testSharedSessionDeliversOnce();
  await testOverlappingWaitInSameProcessDeliversOnce();
  await testWaitTerminalAndEpisodeChecks();
  await testClosedEpisodeNotClaimedByOtherOwner();
  await testPersistFailureIsToolError();
  await testConcurrentSessionId();

  stopHeartbeat();
  console.log("adapter smoke ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
