const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const {
  NO_CASCADE_GUARD,
  closeTmuxAgent,
  readTmuxAgent,
  sendTmuxAgent,
  spawnTmuxAgent,
  waitTmuxAgent,
} = require("../src/adapter");

async function main() {
  const repo = path.resolve(__dirname, "..");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-adapter-smoke-"));
  process.env.FAKE_AGENT_TMUX_ROOT = tmp;
  process.env.PATH = `${path.join(__dirname, "fixtures/bin")}${path.delimiter}${process.env.PATH}`;

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
  await client.close();

  assert.equal(JSON.parse(execFileSync("agent-tmux", ["fake", "doctor", "--json"], { encoding: "utf8" })).ok, true);
  assert.equal(JSON.parse(execFileSync("agent-tmux", ["fake", "start", "--dry-run"], { encoding: "utf8" })).dry_run, true);

  const spawned = await spawnTmuxAgent({
    cli: "fake",
    repoPath: repo,
    task: "write a result",
    name: "adapter-smoke",
  });
  assert.equal(spawned.agent_id, "adapter-smoke");
  assert.equal(spawned.result_path, path.join(tmp, "adapter-smoke", "result.json"));

  const prompt = fs.readFileSync(path.join(tmp, "adapter-smoke", "prompt.txt"), "utf8");
  assert.match(prompt, /Write final JSON to this exact path:/);
  assert.match(prompt, /Result JSON must include schema_version, status, summary, artifacts, and errors\./);
  assert.ok(prompt.includes(NO_CASCADE_GUARD));

  process.env.FAKE_SEND_RESULT_JSON = "1";
  const sent = await sendTmuxAgent("adapter-smoke", "finish now");
  assert.deepEqual(sent, { status: "submitted", completion_source: "result_json" });
  delete process.env.FAKE_SEND_RESULT_JSON;

  const waited = await waitTmuxAgent("adapter-smoke", 1);
  assert.equal(waited.status, "completed");
  assert.equal(waited.body.summary, "ok");

  const read = await readTmuxAgent("adapter-smoke");
  assert.equal(read.status, "done");

  const closed = await closeTmuxAgent("adapter-smoke");
  assert.deepEqual(closed, { closed: true });

  const a = await spawnTmuxAgent({ cli: "fake", repoPath: repo, task: "a", name: "adapter-a" });
  const b = await spawnTmuxAgent({ cli: "fake", repoPath: repo, task: "b", name: "adapter-b" });
  process.env.FAKE_SEND_RESULT_JSON = "1";
  await sendTmuxAgent(a.agent_id, "finish a");
  await sendTmuxAgent(b.agent_id, "finish b");
  const multi = await Promise.all([waitTmuxAgent(a.agent_id, 1), waitTmuxAgent(b.agent_id, 1)]);
  assert.deepEqual(multi.map((r) => r.status), ["completed", "completed"]);
  delete process.env.FAKE_SEND_RESULT_JSON;

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

  process.env.FAKE_INVALID_RESULT = "1";
  const invalid = await waitTmuxAgent(missing.agent_id, 0);
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.reason, "invalid_result");
  delete process.env.FAKE_INVALID_RESULT;

  process.env.FAKE_DEAD_SESSION = "1";
  const dead = await waitTmuxAgent(missing.agent_id, 0);
  assert.equal(dead.status, "failed");
  assert.equal(dead.reason, "dead_session");
  delete process.env.FAKE_DEAD_SESSION;

  console.log("adapter smoke ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
