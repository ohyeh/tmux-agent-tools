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
  WAIT_CAP_SEC,
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
    const waited = await waitTmuxAgent(args[0], 1, args[1] ? { seq: Number(args[1]) } : {});
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
      process.stdout.write(JSON.stringify({ threw: false, code: null, owner: (await getHost(repo)).owner() }));
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

// D-mcp-id: no provable process id (ps fails) → the tool call fails; no owner is minted.
async function testNoProcessIdIsToolError() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-noid-"));
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-ps-shim-"));
  fs.writeFileSync(path.join(shim, "ps"), "#!/bin/sh\necho 'ps: injected failure' >&2\nexit 1\n", { mode: 0o755 });
  const out = runAdapterChild(dir, ["persist"], { PATH: `${shim}${path.delimiter}${process.env.PATH}` });
  assert.equal(out.threw, true, `no session id must fail the tool call, owner=${out.owner} code=${out.code}`);
  assert.equal(out.code, "NO_SESSION_ID");
  assert.equal(out.owner, null);
  assert.equal(fs.existsSync(path.join(dir, ".v3")), false, "nothing was written without an owner");
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

// ── R7.3 fixtures: D-mcp-id, D-mcp-ack (plan §1c S1 (c), S3, S4) ─────────────────

const REPO = path.resolve(__dirname, "..");
const FIXTURE_BIN = path.join(__dirname, "fixtures/bin");
const sessionHex = (id) => Buffer.from(id, "utf8").toString("hex");
const workerOwner = (dir, agent) => JSON.parse(fs.readFileSync(path.join(dir, ".v3", agent, "worker.json"), "utf8")).owner;
const doneAck = (dir, agent, seq = 1) => fs.existsSync(path.join(dir, ".v3", agent, "episodes", String(seq), "acks", "done"));
const actsOf = (dir, session) => {
  const act = path.join(dir, ".v3", ".sessions", sessionHex(session), "act");
  return fs.existsSync(act) ? fs.readdirSync(act).filter((f) => /^\d+$/.test(f)).sort() : [];
};
const channelOf = (dir, session) =>
  JSON.parse(fs.readlinkSync(path.join(dir, ".v3", ".sessions", sessionHex(session), "channel"))).channel;
// The ack lands after the server's write callback, so a client may read the response first.
async function eventually(p, what) {
  for (let i = 0; i < 150 && !p(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(p(), `timed out waiting for ${what}`);
}
const writeResult = (file, o = {}) =>
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, status: "success", summary: "ok", artifacts: [], errors: [], episode: 1, ...o }));

/** One MCP server process (`--server <cut>`, see serveWithCut) on state root `dir`. */
async function startServer(dir, extra = {}, cut = "none") {
  const client = new Client({ name: `r73-${cut}`, version: "1.0.0" });
  const env = childEnv(dir, { PATH: `${FIXTURE_BIN}${path.delimiter}${process.env.PATH}`, ...extra });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [__filename, "--server", cut],
    cwd: REPO,
    env,
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name} failed: ${JSON.stringify(r)}`);
  return r.structuredContent;
}

/**
 * The server with a cut point on the stdout write of a `completed` wait response:
 * before-write = crash before any byte is written; write-no-cb = the write is issued
 * and the process dies before its callback (S4: write returned, callback pending);
 * flushed-no-ack = the bytes are flushed, then the process dies before the ack.
 */
async function serveWithCut(cut) {
  const { AckingStdioTransport, main: serve } = require("../src/server.js");
  const out = {
    write(chunk, cb) {
      if (cut !== "none" && String(chunk).includes('"status":"completed"')) {
        if (cut === "before-write") process.exit(9);
        if (cut === "write-no-cb") {
          process.stdout.write(chunk);
          process.exit(9);
        }
        if (cut === "flushed-no-ack") return process.stdout.write(chunk, () => process.exit(9));
      }
      return process.stdout.write(chunk, cb);
    },
  };
  await serve(new AckingStdioTransport(process.stdin, out));
}

// D-mcp-id: two different host processes, each with its own session, each assign + wait.
async function testTwoHostProcessesEachAssignAndWait() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r73-two-hosts-"));
  const [h1, h2] = await Promise.all([startServer(dir), startServer(dir)]);
  try {
    const [a, b] = await Promise.all([
      call(h1, "spawn_tmux_agent", { cli: "fake", repoPath: REPO, task: "host one", name: "r73-h1" }),
      call(h2, "spawn_tmux_agent", { cli: "fake", repoPath: REPO, task: "host two", name: "r73-h2" }),
    ]);
    assert.equal(a.seq, 1);
    writeResult(a.result_path, { summary: "one" });
    writeResult(b.result_path, { summary: "two" });
    const [wa, wb] = await Promise.all([
      call(h1, "wait_tmux_agent", { agent_id: a.agent_id, seq: a.seq, timeoutSec: 2 }),
      call(h2, "wait_tmux_agent", { agent_id: b.agent_id, seq: b.seq, timeoutSec: 2 }),
    ]);
    const oa = workerOwner(dir, a.agent_id);
    const ob = workerOwner(dir, b.agent_id);
    assert.match(oa, /^mcp-[^/]+-\d+-\d+$/);
    assert.notEqual(oa, ob, "one session per host process");
    assert.deepEqual([wa.status, wb.status], ["completed", "completed"]);
    assert.equal(wa.delivery_id, `${oa}/${a.agent_id}/1`);
    assert.equal(wb.delivery_id, `${ob}/${b.agent_id}/1`);
    await eventually(() => doneAck(dir, a.agent_id) && doneAck(dir, b.agent_id), "both acks");
    // No false fence (S3): each session has its one mcp registration, nobody superseded it.
    assert.deepEqual([actsOf(dir, oa), actsOf(dir, ob)], [["1"], ["1"]]);
    assert.deepEqual([channelOf(dir, oa), channelOf(dir, ob)], ["mcp", "mcp"]);
    const state = JSON.parse(fs.readFileSync(path.join(dir, ".v3", ".sessions", sessionHex(oa), "act", "1.state"), "utf8"));
    assert.deepEqual([state.channel, state.mode, state.status], ["mcp", "on-request", "collecting"], "C-health MCP writer");
  } finally {
    await Promise.all([h1.close(), h2.close()]);
  }
}

// D-mcp-id restart: a new process is a new session; it waits on the old process's worker
// by agent_id (from disk), claims it once the old beat expired, and keeps gen0 in the id.
async function testRestartWaitsOnWorkerFromBeforeRestart() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r73-restart-"));
  const s1 = await startServer(dir);
  const sp = await call(s1, "spawn_tmux_agent", { cli: "fake", repoPath: REPO, task: "survive restart", name: "r73-restart" });
  await s1.close();
  writeResult(sp.result_path, { summary: "survived restart" });
  const owner1 = workerOwner(dir, sp.agent_id);
  const s2 = await startServer(dir);
  try {
    // s1 closed in order (stdin ended): it retired its beat, so the claim is free at once.
    const w = await call(s2, "wait_tmux_agent", { agent_id: sp.agent_id, seq: 1, timeoutSec: 1 });
    assert.equal(w.status, "completed");
    assert.equal(w.body.summary, "survived restart");
    assert.equal(w.delivery_id, `${owner1}/${sp.agent_id}/1`, "gen0 stays in the id after the claim");
    const claimed = fs.readFileSync(path.join(dir, ".v3", sp.agent_id, "episodes", "1", "claims", "1", "owner"), "utf8").trim();
    assert.notEqual(claimed, owner1);
    await eventually(() => doneAck(dir, sp.agent_id), "the ack");
  } finally {
    await s2.close();
  }
}

// Same host reload (TMUX_AGENT_SESSION unchanged): the newer activation fences the older
// one (S1 (a)); the reload delivers.
async function testSameHostReload() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r73-reload-"));
  const env = { TMUX_AGENT_SESSION: "host-S" };
  const s1 = await startServer(dir, env);
  const s2 = await startServer(dir, env);
  try {
    const sp = await call(s1, "spawn_tmux_agent", { cli: "fake", repoPath: REPO, task: "reload", name: "r73-reload" });
    writeResult(sp.result_path);
    const old = await call(s1, "wait_tmux_agent", { agent_id: sp.agent_id, seq: 1, timeoutSec: 0 });
    assert.deepEqual([old.status, old.reason], ["failed", "not_live"]);
    assert.match(JSON.stringify(old.detail), /superseded/);
    assert.equal(doneAck(dir, sp.agent_id), false);
    const fresh = await call(s2, "wait_tmux_agent", { agent_id: sp.agent_id, seq: 1, timeoutSec: 1 });
    assert.equal(fresh.status, "completed");
    assert.equal(fresh.delivery_id, `host-S/${sp.agent_id}/1`);
    assert.deepEqual(actsOf(dir, "host-S"), ["1", "2"]);
  } finally {
    await Promise.all([s1.close(), s2.close()]);
  }
}

// S4 / S1 (c): a crash before ack (every cut) leaves no ack; the next process re-reports
// the SAME delivery_id; once acked (crash after ack), a later process gets already_acked.
async function testCrashBeforeAndAfterAck() {
  for (const cut of ["before-write", "write-no-cb", "flushed-no-ack"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r73-crash-${cut}-`));
    const s1 = await startServer(dir, {}, cut);
    const sp = await call(s1, "spawn_tmux_agent", { cli: "fake", repoPath: REPO, task: cut, name: "r73-crash" });
    writeResult(sp.result_path, { summary: cut });
    const owner1 = workerOwner(dir, sp.agent_id);
    const first = await s1
      .callTool({ name: "wait_tmux_agent", arguments: { agent_id: sp.agent_id, seq: 1, timeoutSec: 1 } })
      .then((r) => r.structuredContent, () => undefined);
    await s1.close();
    assert.equal(doneAck(dir, sp.agent_id), false, `${cut}: no ack without a flushed response`);
    if (cut === "before-write") assert.equal(first, undefined, "nothing reached the client");
    ageSessionBeats(dir);
    const s2 = await startServer(dir);
    const again = await call(s2, "wait_tmux_agent", { agent_id: sp.agent_id, seq: 1, timeoutSec: 1 });
    await eventually(() => doneAck(dir, sp.agent_id), `${cut}: the ack`);
    await s2.close();
    assert.equal(again.status, "completed", `${cut}: re-reported`);
    assert.equal(again.delivery_id, `${owner1}/${sp.agent_id}/1`);
    if (first) assert.equal(first.delivery_id, again.delivery_id, `${cut}: a re-report carries the same delivery_id`);
    assert.ok(doneAck(dir, sp.agent_id), `${cut}: acked once the response is flushed`);
    // Crash after ack: the process is gone; the next one sees a closed episode.
    ageSessionBeats(dir);
    const s3 = await startServer(dir);
    const after = await call(s3, "wait_tmux_agent", { agent_id: sp.agent_id, seq: 1, timeoutSec: 0 });
    await s3.close();
    assert.equal(after.status, "already_acked");
    assert.equal(after.body, undefined);
    assert.equal(after.delivery_id, again.delivery_id);
  }
}

// S4 in one process: the ack waits for the write callback; cancel before send, a send
// error, an error response, an isError result and a transport close all leave no ack,
// release the episode, and the next wait re-reports the same delivery_id.
async function testAckBoundariesInProcess() {
  const { AckingStdioTransport } = require("../src/server.js");
  const { PassThrough } = require("node:stream");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r73-ack-"));
  process.env.TMUX_AGENT_DIR = dir;
  process.env.FAKE_AGENT_TMUX_ROOT = dir;
  const writes = [];
  const transport = (behave) =>
    new AckingStdioTransport(new PassThrough(), {
      write(chunk, cb) {
        writes.push(String(chunk));
        behave(cb);
        return true;
      },
    });
  let nextId = 100;
  async function finished(name) {
    const sp = await spawnTmuxAgent({ cli: "fake", repoPath: REPO, task: name, name });
    writeResult(sp.result_path, { summary: name });
    return sp;
  }
  const parked = async (sp) => {
    const ac = new AbortController();
    const requestId = nextId++;
    const w = await waitTmuxAgent(sp.agent_id, 1, { seq: 1, extra: { requestId, signal: ac.signal } });
    assert.equal(w.status, "completed");
    assert.equal(doneAck(dir, sp.agent_id), false, "parked: no ack before the response is written");
    return { w, ac, requestId };
  };
  const reReport = async (sp, w, why) => {
    assert.equal(doneAck(dir, sp.agent_id), false, `${why}: no ack`);
    const again = await waitTmuxAgent(sp.agent_id, 1, { seq: 1 });
    assert.equal(again.status, "completed", `${why}: released and re-reported`);
    assert.equal(again.delivery_id, w.delivery_id, `${why}: same delivery_id`);
    assert.ok(doneAck(dir, sp.agent_id));
  };

  // 1. Write issued, callback pending → no ack; an overlapping wait waits; callback → ack.
  let pendingCb;
  const t1 = transport((cb) => (pendingCb = cb));
  const sp1 = await finished("r73-pending");
  const p1 = await parked(sp1);
  const sending = t1.send({ jsonrpc: "2.0", id: p1.requestId, result: { structuredContent: p1.w, content: [] } });
  const overlap = waitTmuxAgent(sp1.agent_id, 1, { seq: 1 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(doneAck(dir, sp1.agent_id), false, "write returned, callback pending: no ack yet");
  pendingCb();
  await sending;
  assert.ok(doneAck(dir, sp1.agent_id), "acked after the write callback");
  const o = await overlap;
  assert.equal(o.status, "already_acked");
  assert.equal(o.delivery_id, p1.w.delivery_id);
  assert.match(p1.w.delivery_id, new RegExp(`/${sp1.agent_id}/1$`));

  // 2. Handler returned, cancelled before the send.
  const sp2 = await finished("r73-cancel");
  const p2 = await parked(sp2);
  p2.ac.abort();
  await reReport(sp2, p2.w, "cancel before send");

  // 2b. Cancelled while the handler ran (the signal is already aborted): released, not parked.
  const sp2b = await finished("r73-cancel-early");
  const early = await waitTmuxAgent(sp2b.agent_id, 1, { seq: 1, extra: { requestId: nextId++, signal: AbortSignal.abort() } });
  assert.equal(early.status, "completed");
  assert.equal(doneAck(dir, sp2b.agent_id), false, "cancel during the handler: no ack");
  const next = await Promise.race([
    waitTmuxAgent(sp2b.agent_id, 1, { seq: 1 }),
    new Promise((r) => setTimeout(() => r({ status: "hung" }), 5000)),
  ]);
  assert.equal(next.status, "completed", "cancel during the handler: the next wait is not stuck");
  assert.equal(next.delivery_id, early.delivery_id);
  assert.ok(doneAck(dir, sp2b.agent_id));

  // 3. Send error.
  const t3 = transport((cb) => setImmediate(() => cb(new Error("EPIPE (injected)"))));
  const sp3 = await finished("r73-senderr");
  const p3 = await parked(sp3);
  await assert.rejects(t3.send({ jsonrpc: "2.0", id: p3.requestId, result: { structuredContent: p3.w, content: [] } }), /EPIPE/);
  await reReport(sp3, p3.w, "send error");

  // 4. Error response and isError result to the parked request.
  const ok = transport((cb) => setImmediate(cb));
  const sp4 = await finished("r73-errresp");
  const p4 = await parked(sp4);
  await ok.send({ jsonrpc: "2.0", id: p4.requestId, error: { code: -32603, message: "x" } });
  await reReport(sp4, p4.w, "error response");
  const sp5 = await finished("r73-iserror");
  const p5 = await parked(sp5);
  await ok.send({ jsonrpc: "2.0", id: p5.requestId, result: { isError: true, content: [] } });
  await reReport(sp5, p5.w, "isError result");

  // 5. Transport close.
  const sp6 = await finished("r73-close");
  const p6 = await parked(sp6);
  await transport(() => {}).close();
  await reReport(sp6, p6.w, "transport close");
  assert.ok(writes.length >= 4);

  const promptly = async (sp, w, why) => {
    const again = await Promise.race([
      waitTmuxAgent(sp.agent_id, 0, { seq: 1 }),
      new Promise((r) => setTimeout(() => r({ status: "hung" }), 3000)),
    ]);
    assert.equal(again.status, "completed", `${why}: next wait(timeoutSec=0) is not stuck`);
    assert.equal(again.delivery_id, w.delivery_id, `${why}: same delivery_id`);
  };
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(String(e));
  process.on("unhandledRejection", onUnhandled);

  // 7. Close while the write callback never returns; abort and a late error callback follow.
  const sp7 = await finished("r73-midwrite-close");
  const p7 = await parked(sp7);
  let cb7;
  const t7 = transport((cb) => (cb7 = cb));
  const sending7 = t7.send({ jsonrpc: "2.0", id: p7.requestId, result: { structuredContent: p7.w, content: [] } });
  await t7.close();
  p7.ac.abort();
  await assert.rejects(
    Promise.race([sending7, new Promise((_, rej) => setTimeout(() => rej(new Error("send hung after close")), 3000))]),
    /closed/,
    "close settles the in-flight send",
  );
  assert.equal(doneAck(dir, sp7.agent_id), false, "mid-write close: no ack");
  await promptly(sp7, p7.w, "mid-write close");
  cb7(new Error("EPIPE late (injected)")); // error callback after close: no double settle
  await new Promise((r) => setTimeout(r, 50));

  // 8. Cancel while the write callback never returns (no close).
  const sp8 = await finished("r73-midwrite-abort");
  const p8 = await parked(sp8);
  const t8 = transport(() => {});
  void t8.send({ jsonrpc: "2.0", id: p8.requestId, result: { structuredContent: p8.w, content: [] } });
  p8.ac.abort();
  await promptly(sp8, p8.w, "mid-write abort");

  // 9. stdout.write throws synchronously.
  const sp9 = await finished("r73-syncthrow");
  const p9 = await parked(sp9);
  const t9 = new AckingStdioTransport(new PassThrough(), { write() { throw new Error("ERR_STREAM_DESTROYED (injected)"); } });
  await assert.rejects(t9.send({ jsonrpc: "2.0", id: p9.requestId, result: { structuredContent: p9.w, content: [] } }), /ERR_STREAM_DESTROYED/);
  assert.equal(doneAck(dir, sp9.agent_id), false, "sync throw: no ack");
  await promptly(sp9, p9.w, "sync write throw");

  await new Promise((r) => setTimeout(r, 50));
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, [], "no unhandled rejection");
}

// D-mcp-ack seq binding: E1 is still waited on while a send opens E2; each wait stays on
// its episode, the ids differ; a late E1 wait after E2 exists gets E1; a late result and
// malformed input or an IO error lose nothing.
async function testCancelParkedResponse() {
  // Sol R3-4 (CANCEL_PARKED_RESPONSE): a completed wait parked before its send holds a
  // `delivering` marker, so a cancel answers in-flight instead of "nothing more is delivered".
  const { AckingStdioTransport } = require("../src/server.js");
  const { PassThrough } = require("node:stream");
  const { cancelEpisode } = require("../../skills/tmux-agent-tools/scripts/lib/workers.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r34-cancel-"));
  process.env.TMUX_AGENT_DIR = dir;
  process.env.FAKE_AGENT_TMUX_ROOT = dir;
  const sp = await spawnTmuxAgent({ cli: "fake", repoPath: REPO, task: "r34", name: "r34" });
  writeResult(sp.result_path, { summary: "r34" });
  const requestId = 900;
  const w = await waitTmuxAgent(sp.agent_id, 1, { seq: 1, extra: { requestId, signal: new AbortController().signal } });
  assert.equal(w.status, "completed");
  const ep = path.join(dir, ".v3", sp.agent_id, "episodes", "1");
  const marker = JSON.parse(fs.readFileSync(path.join(ep, "delivering"), "utf8"));
  assert.match(marker.token, /^[0-9a-z]{12}$/);
  assert.equal(typeof marker.activation, "number");
  assert.ok(marker.session, "the marker names the session");
  // The gate registered its activation under an earlier test's state root; give this root the
  // same registration (its dir) so the marker's activation is the live, authoritative one.
  fs.mkdirSync(path.join(dir, ".v3", ".sessions", sessionHex(marker.session), "act", String(marker.activation)), { recursive: true })
  const cancelled = await cancelEpisode(await getHost(), sp.agent_id, 1);
  assert.equal(cancelled.ok, false, cancelled.text);
  assert.match(cancelled.text, /in-flight/);
  assert.equal(fs.existsSync(path.join(ep, "acks", "cancel")), false, "cancel closed nothing");
  const t = new AckingStdioTransport(new PassThrough(), { write(_c, cb) { setImmediate(cb); return true; } });
  await t.send({ jsonrpc: "2.0", id: requestId, result: { structuredContent: w, content: [] } });
  assert.ok(doneAck(dir, sp.agent_id), "flushed: acked");
  assert.equal(fs.existsSync(path.join(ep, "acks", "cancel")), false);
  assert.equal(fs.existsSync(path.join(ep, "delivering")), false, "marker cleared by its token after the ack");
}

async function testEpisodesLateResultMalformedAndIoError() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r73-e1e2-"));
  process.env.TMUX_AGENT_DIR = dir;
  process.env.FAKE_AGENT_TMUX_ROOT = dir;
  const sp = await spawnTmuxAgent({ cli: "fake", repoPath: REPO, task: "e1", name: "r73-e1e2" });
  const e1 = waitTmuxAgent(sp.agent_id, 5, { seq: sp.seq });
  process.env.FAKE_SEND_RESULT_JSON = "1";
  const sent = await sendTmuxAgent(sp.agent_id, "now e2");
  delete process.env.FAKE_SEND_RESULT_JSON;
  assert.equal(sent.seq, 2);
  writeResult(sp.result_path, { summary: "e1 late" });
  const w1 = await e1;
  const w2 = await waitTmuxAgent(sp.agent_id, 1, { seq: sent.seq });
  assert.deepEqual([w1.status, w1.body.summary, w1.seq], ["completed", "e1 late", 1]);
  assert.deepEqual([w2.status, w2.seq], ["completed", 2]);
  assert.notEqual(w1.delivery_id, w2.delivery_id, "E1 and E2 ids differ");
  assert.match(w2.delivery_id, new RegExp(`/${sp.agent_id}/2$`));
  const late = await waitTmuxAgent(sp.agent_id, 0, { seq: 1 });
  assert.deepEqual([late.status, late.delivery_id], ["already_acked", w1.delivery_id]);
  assert.equal((await readTmuxAgent(sp.agent_id, 1)).summary, "e1 late", "read with seq reads that episode");

  // Late result: a wait that timed out acks nothing; the result is delivered later.
  const lr = await spawnTmuxAgent({ cli: "fake", repoPath: REPO, task: "late", name: "r73-late" });
  assert.equal((await waitTmuxAgent(lr.agent_id, 0, { seq: 1 })).status, "timed_out");
  assert.equal(doneAck(dir, lr.agent_id), false);
  writeResult(lr.result_path, { summary: "late" });
  assert.equal((await waitTmuxAgent(lr.agent_id, 1, { seq: 1 })).status, "completed");

  // Malformed input: a bad or unknown seq is an error, never another episode.
  for (const bad of [0, -1, 1.5, 99]) {
    await assert.rejects(waitTmuxAgent(lr.agent_id, 0, { seq: bad }), (err) => err.code === "INVALID_SEQ");
  }
  await assert.rejects(readTmuxAgent(lr.agent_id, 99), (err) => err.code === "INVALID_SEQ");

  // Malformed result, then an IO error: nothing acked; once readable, delivered.
  const mr = await spawnTmuxAgent({ cli: "fake", repoPath: REPO, task: "bad", name: "r73-malformed" });
  fs.writeFileSync(mr.result_path, "{ torn");
  assert.equal((await waitTmuxAgent(mr.agent_id, 0, { seq: 1 })).reason, "invalid_result");
  writeResult(mr.result_path, { summary: "fixed" });
  fs.chmodSync(mr.result_path, 0o000);
  try {
    await assert.rejects(waitTmuxAgent(mr.agent_id, 0, { seq: 1 }), (err) => err.code === "IO_ERROR");
  } finally {
    fs.chmodSync(mr.result_path, 0o644);
  }
  assert.equal(doneAck(dir, mr.agent_id), false, "malformed / IO error: no ack");
  const fixed = await waitTmuxAgent(mr.agent_id, 1, { seq: 1 });
  assert.deepEqual([fixed.status, fixed.body.summary], ["completed", "fixed"]);
}

// S3, two processes on one session id: the mod (this process, channel mod) and an MCP
// server (TMUX_AGENT_SESSION = the same id) both try; exactly one channel registers,
// in either start order, and the refused one fences nothing.
async function testChannelAuthorityModAndMcpBothTry() {
  const { heartbeat, newGate } = require("../../skills/tmux-agent-tools/scripts/lib/workers.ts");
  const { nodeHost } = require("../../skills/tmux-agent-tools/scripts/lib/host.node.ts");
  for (const modFirst of [true, false]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r73-channel-${modFirst ? "mod" : "mcp"}-first-`));
    process.env.TMUX_AGENT_DIR = dir;
    const session = "shared-S";
    const modHost = nodeHost({ owner: session, cwd: REPO, log: () => {} });
    const mod = newGate();
    if (modFirst) assert.equal(await heartbeat(modHost, mod), true);
    const s = await startServer(dir, { TMUX_AGENT_SESSION: session });
    try {
      if (!modFirst) {
        assert.equal(await heartbeat(modHost, mod), false);
        assert.match(mod.paused, /collected by its mcp channel/);
      }
      const sp = await call(s, "spawn_tmux_agent", { cli: "fake", repoPath: REPO, task: "S3", name: "r73-channel" });
      writeResult(sp.result_path);
      const w = await call(s, "wait_tmux_agent", { agent_id: sp.agent_id, seq: 1, timeoutSec: 0 });
      if (modFirst) {
        assert.deepEqual([w.status, w.reason], ["failed", "not_live"]);
        assert.match(w.detail, /collected by its mod channel/);
        assert.equal(doneAck(dir, sp.agent_id), false);
        assert.equal(await heartbeat(modHost, mod), true, "the mod is not fenced");
      } else {
        assert.equal(w.status, "completed");
      }
      assert.equal(channelOf(dir, session), modFirst ? "mod" : "mcp");
      assert.deepEqual(actsOf(dir, session), ["1"], "exactly one channel registered");
    } finally {
      await s.close();
    }
  }
}

// ── R8 host-failure fixtures (F1 F2 F3 F4 F7) ────────────────────────────────────

/** Raw newline-delimited JSON-RPC over a server child's stdio (no SDK client). */
function rawRpc(child) {
  let id = 0;
  const pending = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      pending.get(m.id)?.(m);
    }
  });
  const send = (o) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`);
  const request = (method, params) => new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    send({ id, method, params });
  });
  return {
    request,
    async start() {
      await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } });
      send({ method: "notifications/initialized" });
    },
    async tool(name, args) {
      return (await request("tools/call", { name, arguments: args })).result.structuredContent;
    },
  };
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function poll(p, what, ms = 6000) {
  for (let t = Date.now(); Date.now() - t < ms && !(await p());) await new Promise((r) => setTimeout(r, 50));
  assert.ok(await p(), `timed out waiting for ${what}`);
}
const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};
const freshState = (tag) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r8-${tag}-`));
  process.env.TMUX_AGENT_DIR = dir;
  process.env.FAKE_AGENT_TMUX_ROOT = dir;
  return dir;
};

// F2: the brief carries no literal `undefined`.
async function testBriefHasNoUndefined() {
  const dir = freshState("f2");
  const sp = await spawnTmuxAgent({ cli: "fake", repoPath: REPO, task: "plain task", name: "r8-f2" });
  const brief = fs.readFileSync(path.join(dir, ".v3", sp.agent_id, "brief.md"), "utf8");
  assert.ok(!/undefined/.test(brief), `brief has a literal undefined:\n${brief}`);
}

// F1: between spawn and a finished launch an absent session is `starting`, not dead.
async function testSpawnThenWaitIsStartingNotDead() {
  const dir = freshState("f1");
  const sp = await withEnv({ FAKE_ASSIGN_DELAY_MS: "1500", FAKE_STATUS_ABSENT_BEFORE_ASSIGN: "1" }, async () => {
    const spawned = await spawnTmuxAgent({ cli: "fake", repoPath: REPO, task: "slow launch", name: "r8-f1" });
    const early = await waitTmuxAgent(spawned.agent_id, 0, { seq: 1 });
    assert.equal(early.status, "pending", `an immediate wait: ${JSON.stringify(early)}`);
    assert.equal(early.reason, "starting");
    return spawned;
  });
  // A launch that finished with a failure is a failure, with the wrapper's own reason.
  await withEnv({ FAKE_ASSIGN_EXIT: "3", FAKE_DEAD_SESSION: "1" }, async () => {
    const failed = await spawnTmuxAgent({ cli: "fake", repoPath: REPO, task: "bad launch", name: "r8-f1b" });
    await poll(() => fs.existsSync(path.join(dir, ".v3", failed.agent_id, "launch.exit")), "launch.exit");
    const w = await waitTmuxAgent(failed.agent_id, 0, { seq: 1 });
    assert.deepEqual([w.status, w.reason], ["failed", "launch_failed"], JSON.stringify(w));
    assert.match(String(w.detail), /exited 3/);
  });
  assert.ok(sp.agent_id);
}

// F7: one wait call stays under the host's tool-call timeout; same delivery semantics after.
async function testWaitCallIsCapped() {
  const dir = freshState("f7");
  assert.ok(WAIT_CAP_SEC > 0 && WAIT_CAP_SEC <= 45, `WAIT_CAP_SEC=${WAIT_CAP_SEC}`);
  const sp = await spawnTmuxAgent({ cli: "fake", repoPath: REPO, task: "cap", name: "r8-f7" });
  const guard = new Promise((_, rej) => setTimeout(() => rej(new Error("wait outlived the cap")), 5000)).catch((e) => e);
  const capped = await Promise.race([waitTmuxAgent(sp.agent_id, 600, { seq: 1, capSec: 1 }), guard]);
  assert.ok(!(capped instanceof Error), String(capped));
  assert.deepEqual([capped.status, capped.reason, capped.seq], ["pending", "wait_again", 1], JSON.stringify(capped));
  const own = await waitTmuxAgent(sp.agent_id, 1, { seq: 1, capSec: 5 });
  assert.equal(own.status, "timed_out", "the caller's own shorter timeout is not a cap");
  writeResult(sp.result_path, { summary: "after cap" });
  const done = await waitTmuxAgent(sp.agent_id, 600, { seq: 1, capSec: 1 });
  assert.equal(done.status, "completed");
  assert.equal(done.delivery_id, `${workerOwner(dir, sp.agent_id)}/${sp.agent_id}/1`);
}

// F3 host: a stand-in for codex. Spawns the server, spawns a worker, leaves a wait in flight.
async function hostMode(dir, errFile, codeFile) {
  const env = childEnv(dir, { PATH: `${FIXTURE_BIN}${path.delimiter}${process.env.PATH}` });
  const server = spawn("sh", ["-c", '"$0" "$1" --server none 2>"$2"; echo $? >"$3"', process.execPath, __filename, errFile, codeFile], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rpc = rawRpc(server);
  await rpc.start();
  const sp = await rpc.tool("spawn_tmux_agent", { cli: "fake", repoPath: REPO, task: "orphan check", name: "r8-f3" });
  console.log(JSON.stringify(sp));
  void rpc.request("tools/call", { name: "wait_tmux_agent", arguments: { agent_id: sp.agent_id, seq: 1, timeoutSec: 30 } });
  setTimeout(() => console.log("waiting"), 300);
  setInterval(() => {}, 1000);
}

// F3: kill the host; the server must exit cleanly (no EPIPE crash, no orphan) and free its claim.
async function testHostKilledServerShutsDownClean() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r8-f3-"));
  const errFile = path.join(dir, "server.err");
  const codeFile = path.join(dir, "server.code");
  const host = spawn(process.execPath, [__filename, "--host", dir, errFile, codeFile], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  host.stdout.on("data", (c) => (out += c));
  await poll(() => out.includes("waiting"), "host ready");
  const sp = JSON.parse(out.split("\n")[0]);
  const owner = workerOwner(dir, sp.agent_id);
  const pid = Number(owner.split("-").at(-2));
  assert.ok(pidAlive(pid), "the server runs before the host dies");
  host.kill("SIGKILL");
  try {
    await poll(() => !pidAlive(pid), `server pid ${pid} to exit after its host died (orphan)`, 5000);
  } finally {
    if (pidAlive(pid)) process.kill(pid, "SIGKILL");
  }
  await poll(() => fs.existsSync(codeFile), "server exit code");
  const stderr = fs.readFileSync(errFile, "utf8");
  assert.ok(!/EPIPE|Unhandled|Emitted 'error'/.test(stderr), `server crashed:\n${stderr}`);
  assert.equal(fs.readFileSync(codeFile, "utf8").trim(), "0");
  // The next owner takes the claim at once (no 90 s wait) and reports the same delivery_id.
  writeResult(sp.result_path, { summary: "after host death" });
  const next = await startServer(dir);
  try {
    const w = await call(next, "wait_tmux_agent", { agent_id: sp.agent_id, seq: 1, timeoutSec: 1 });
    assert.equal(w.status, "completed", JSON.stringify(w));
    assert.equal(w.delivery_id, `${owner}/${sp.agent_id}/1`);
  } finally {
    await next.close();
  }
}

// F3 transport: a dead stdout or a closed stdin tells the owner; a stdout 'error' never throws.
async function testTransportReportsGoneHost() {
  const { PassThrough } = require("node:stream");
  const { AckingStdioTransport } = require("../src/server.js");
  for (const [what, trip] of [["stdout error", (i, o) => o.emit("error", new Error("write EPIPE"))], ["stdin end", (i) => i.emit("end")], ["stdin close", (i) => i.emit("close")]]) {
    const i = new PassThrough();
    const o = new PassThrough();
    const t = new AckingStdioTransport(i, o);
    let reason;
    t.onhostgone = (r) => (reason = r);
    trip(i, o);
    assert.ok(reason, `${what}: onhostgone not called`);
  }
}

// F4: the launch outlives its host's process group; the brief still goes out.
async function testLaunchSurvivesHostGroupKill() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r8-f4-"));
  const server = spawn(process.execPath, [path.join(REPO, "src/server.js")], {
    detached: true,
    env: childEnv(dir, { PATH: `${FIXTURE_BIN}${path.delimiter}${process.env.PATH}`, FAKE_ASSIGN_DELAY_MS: "1200" }),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const rpc = rawRpc(server);
  await rpc.start();
  const sp = await rpc.tool("spawn_tmux_agent", { cli: "fake", repoPath: REPO, task: "brief must survive", name: "r8-f4" });
  process.kill(-server.pid, "SIGKILL");
  const state = path.join(dir, ".v3", sp.agent_id);
  await poll(() => fs.existsSync(path.join(state, "launch.exit")), "the launch receipt after the host group was killed");
  assert.equal(fs.readFileSync(path.join(state, "launch.exit"), "utf8").trim(), "0");
  assert.ok(fs.existsSync(path.join(state, "assigned")), "assign ran to its end");
  assert.match(fs.readFileSync(path.join(state, "prompt.txt"), "utf8"), /brief must survive/);
}

async function main() {
  if (process.argv[2] === "--host") {
    await hostMode(...process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "--server") {
    await serveWithCut(process.argv[3]);
    return;
  }
  if (process.argv[2] === "--child") {
    await runChild(process.argv[3], process.argv.slice(4));
    stopHeartbeat();
    return;
  }
  if (process.argv[2] === "--findings") {
    const fixtures = path.join(__dirname, "fixtures/bin");
    process.env.PATH = `${fixtures}${path.delimiter}${process.env.PATH}`;
    const which = process.argv[3] || "abc";
    if (which.includes("a")) await testSharedSessionDeliversOnce();
    if (which.includes("b")) await testClosedEpisodeNotClaimedByOtherOwner();
    if (which.includes("c")) await testNoProcessIdIsToolError();
    console.log(`findings ${which} ok`);
    return;
  }

  if (process.argv[2] === "--r8") {
    // One R8 fixture alone: `node test/adapter-smoke.js --r8 testBriefHasNoUndefined`.
    process.env.PATH = `${FIXTURE_BIN}${path.delimiter}${process.env.PATH}`;
    await { testBriefHasNoUndefined, testSpawnThenWaitIsStartingNotDead, testWaitCallIsCapped, testTransportReportsGoneHost, testHostKilledServerShutsDownClean, testLaunchSurvivesHostGroupKill }[process.argv[3]]();
    stopHeartbeat();
    console.log(`${process.argv[3]} ok`);
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
  assert.deepEqual(sent, { status: "submitted", completion_source: "result_json", seq: 2 });
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

  delete process.env.TMUX_AGENT_SESSION;
  await testSharedSessionDeliversOnce();
  await testOverlappingWaitInSameProcessDeliversOnce();
  await testWaitTerminalAndEpisodeChecks();
  await testClosedEpisodeNotClaimedByOtherOwner();
  await testNoProcessIdIsToolError();

  // R7.3 (D-mcp-id, D-mcp-ack; plan §1c S1 (c), S3, S4)
  await testTwoHostProcessesEachAssignAndWait();
  await testRestartWaitsOnWorkerFromBeforeRestart();
  await testSameHostReload();
  await testCrashBeforeAndAfterAck();
  await testAckBoundariesInProcess();
  await testCancelParkedResponse();
  await testEpisodesLateResultMalformedAndIoError();
  await testChannelAuthorityModAndMcpBothTry();

  // R8 host failures
  await testBriefHasNoUndefined();
  await testSpawnThenWaitIsStartingNotDead();
  await testWaitCallIsCapped();
  await testTransportReportsGoneHost();
  await testHostKilledServerShutsDownClean();
  await testLaunchSurvivesHostGroupKill();

  stopHeartbeat();
  console.log("adapter smoke ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
