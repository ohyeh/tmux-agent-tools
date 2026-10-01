const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function resolveCoreModule(moduleRelPath) {
  // The bundle (src/entry.mjs → scripts/lib/mcp-server.mjs) imports the core that
  // ships beside it and hands it over here before this file runs.
  const bundled = globalThis.__tmuxAgentCore;
  if (bundled) return bundled[moduleRelPath];
  // src/ runs (adapter-smoke, `node mcp-adapter/src/server.js`): the checkout's skill tree.
  return require(path.resolve(__dirname, "../../skills/tmux-agent-tools/scripts/lib", moduleRelPath));
}

const {
  CLOSED_ACKS,
  POLL_MS,
  REQUIRED_RESULT_LINE,
  TERMINAL,
  ackFinished,
  assignWorker,
  episodeMatches,
  heartbeat,
  missingSections,
  newGate,
  observationOf,
  payloadOf,
  peekWorker,
  rootOf,
  stillOurs,
  stopWorker,
  tellWorker,
  v3Of,
} = resolveCoreModule("workers.ts");

const {
  claim,
  currentOwner,
  numericChildren,
  readDescriptor,
  readWorker,
} = resolveCoreModule("ledger.ts");

const { nodeHost } = resolveCoreModule("host.node.ts");

const REQUIRED_RESULT_FIELDS = ["schema_version", "status", "summary", "artifacts", "errors"];
const NO_CASCADE_GUARD = "Do not spawn additional tmux sessions or delegate further.";
const NO_BACKGROUND_JOBS_GUARD = "Do not start background jobs unless explicitly requested.";
const NO_EXTERNAL_SIDE_EFFECTS_GUARD = "Do not create external side effects unless explicitly authorized.";

const gates = new Map();
const beatTimers = new Map();
let cachedSessionId = null;
let deliveryCount = 0;
const inFlightDeliveries = new Map();

function gateFor(sessionId) {
  let gate = gates.get(sessionId);
  if (!gate) {
    gate = newGate();
    gates.set(sessionId, gate);
  }
  return gate;
}

function deliveries() {
  return deliveryCount;
}

function getStateRoot() {
  const dir = process.env.TMUX_AGENT_DIR || path.join(os.homedir(), ".local/state/tmux-agent-tools");
  return path.resolve(dir);
}

function readPersistedSessionId(idFile) {
  try {
    return fs.readFileSync(idFile, "utf8").trim();
  } catch (err) {
    // ENOTDIR: `.v3` is a file. Fall through so mkdir reports that EEXIST.
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return "";
    throw err;
  }
}

function getStableSessionId(root) {
  if (process.env.TMUX_AGENT_SESSION) {
    return process.env.TMUX_AGENT_SESSION;
  }
  if (cachedSessionId) {
    return cachedSessionId;
  }
  const v3 = v3Of(root);
  const idFile = path.join(v3, ".mcp-session-id");
  const existing = readPersistedSessionId(idFile);
  if (existing) {
    cachedSessionId = existing;
    return existing;
  }
  fs.mkdirSync(v3, { recursive: true });
  const newId = `mcp-session-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(idFile, `${newId}\n`, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if (err && err.code === "EEXIST") {
      const winner = readPersistedSessionId(idFile);
      if (winner) {
        cachedSessionId = winner;
        return winner;
      }
    }
    throw err;
  }
  cachedSessionId = newId;
  return newId;
}

function getHost(cwd) {
  const root = getStateRoot();
  const sessionId = getStableSessionId(root);
  return nodeHost({
    owner: sessionId,
    cwd: cwd || process.cwd(),
    log: (text) => process.stderr.write(`[mcp-adapter] ${text}\n`),
    // The MCP tool result is this host's delivery channel (§8). Accepting is what
    // lets ack close the episode; the default drop would leave it open for a peer (§3).
    submit: async () => ({}),
  });
}

async function ensureAdapterLive(host) {
  const id = host.owner();
  if (!id) return false;
  const gate = gateFor(id);
  if (gate.paused) return false;
  const live = await heartbeat(host, gate);
  if (!beatTimers.has(id)) {
    const timer = setInterval(() => {
      if (!gate.paused) {
        void heartbeat(host, gate).catch((err) => {
          host.log(`heartbeat failed: ${err}`);
        });
      }
    }, POLL_MS);
    if (timer.unref) timer.unref();
    beatTimers.set(id, timer);
  }
  return live;
}

function safeBaseName(cli, requested) {
  if (requested && /^[A-Za-z0-9._-]+$/.test(requested)) {
    return requested.slice(0, 58);
  }
  const safeCli = String(cli || "agent").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 24);
  return `tmux-agent-${safeCli}`;
}

function parseJsonLoose(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  let lastErr = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) {
    process.stderr.write(`[mcp-adapter] JSON parse failed: ${lastErr}\n`);
  }
  return null;
}

function buildWorkerPrompt(task, resultPath) {
  return `${task}

Write final JSON to this exact path: ${resultPath}
${REQUIRED_RESULT_LINE}
${NO_CASCADE_GUARD}
${NO_BACKGROUND_JOBS_GUARD}
${NO_EXTERNAL_SIDE_EFFECTS_GUARD}`;
}

function formatBrief(task) {
  const missing = missingSections(task);
  if (missing.length === 0) return task;
  let brief = task.trim();
  if (missing.includes("GOAL")) {
    brief = `GOAL: ${brief}`;
  }
  if (missing.includes("ACCEPTANCE")) {
    brief += `\n\nACCEPTANCE: Result JSON must include schema_version, status, summary, artifacts, and errors.\n${REQUIRED_RESULT_LINE}\n${NO_CASCADE_GUARD}\n${NO_BACKGROUND_JOBS_GUARD}\n${NO_EXTERNAL_SIDE_EFFECTS_GUARD}`;
  }
  if (missing.includes("REPORT")) {
    brief += `\n\nREPORT: Final status and summary in result.json`;
  }
  return brief;
}

function classifyBlocked(json) {
  if (json && (json.blocked || (json.confirmation_detected === true && json.blocked_reason))) {
    return {
      status: "blocked",
      blocked_reason: json.blocked_reason || "blocked",
      diagnostic: json.diagnostic || "",
    };
  }
  return null;
}

function isDeadStatus(json) {
  if (!json || typeof json !== "object") return false;
  return json.dead === true || json.alive === false || json.running === false || json.exists === false;
}

function missingResultFields(body) {
  if (!body || typeof body !== "object") return REQUIRED_RESULT_FIELDS;
  return REQUIRED_RESULT_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(body, field));
}

async function existsOrThrow(host, target) {
  try {
    return await host.exists(target);
  } catch (err) {
    host.log(`exists(${target}) error: ${err}`);
    const ioErr = new Error(`IO error checking ${target}: ${err}`);
    ioErr.code = "IO_ERROR";
    throw ioErr;
  }
}

async function listOrThrow(host, target) {
  try {
    return await host.list(target);
  } catch (err) {
    host.log(`list(${target}) error: ${err}`);
    const ioErr = new Error(`IO error listing ${target}: ${err}`);
    ioErr.code = "IO_ERROR";
    throw ioErr;
  }
}

async function getWorker(host, agentId) {
  const root = await rootOf(host);
  if (!root) {
    const err = new Error("no state root");
    err.code = "NO_STATE_ROOT";
    throw err;
  }
  const v3 = v3Of(root);
  let name = String(agentId || "").trim();
  if (!name) {
    const err = new Error("agent_id is required");
    err.code = "UNKNOWN_AGENT";
    throw err;
  }
  let workerDir = `${v3}/${name}`;
  let rec = await readWorker(host, workerDir);
  if (rec === "unknown") {
    const err = new Error(`IO error reading worker record for agent_id: ${agentId}`);
    err.code = "IO_ERROR";
    throw err;
  }
  if (!rec) {
    const v3Exists = await existsOrThrow(host, v3);
    if (v3Exists) {
      const entries = await listOrThrow(host, v3);
      const matches = entries.filter(
        (e) => e.kind === "dir" && (e.name === name || e.name.startsWith(`${name}.`))
      );
      if (matches.length > 1) {
        const err = new Error(
          `ambiguous agent_id "${agentId}" matches multiple agents: ${matches.map((m) => m.name).join(", ")}`
        );
        err.code = "AMBIGUOUS_AGENT";
        err.matches = matches.map((m) => m.name);
        throw err;
      }
      if (matches.length === 1) {
        name = matches[0].name;
        workerDir = `${v3}/${name}`;
        rec = await readWorker(host, workerDir);
        if (rec === "unknown") {
          const err = new Error(`IO error reading worker record for agent_id: ${name}`);
          err.code = "IO_ERROR";
          throw err;
        }
      }
    }
  }
  if (!rec) {
    const err = new Error(`unknown agent_id: ${agentId}`);
    err.code = "UNKNOWN_AGENT";
    throw err;
  }
  return { rec, name, workerDir, root, v3 };
}

async function spawnTmuxAgent(request) {
  const cli = String(request.cli || "").trim();
  const repoPath = String(request.repoPath || "").trim();
  const task = String(request.task || "");
  if (!cli || !repoPath || !task) {
    throw new Error("spawn_tmux_agent requires cli, repoPath, and task");
  }

  const host = getHost(repoPath);
  await ensureAdapterLive(host);
  const baseName = safeBaseName(cli, request.name);
  const brief = formatBrief(task);

  const res = await assignWorker(
    host,
    { profile: cli, name: baseName, dir: repoPath, brief },
    { owner: host.owner(), ownerCwd: repoPath }
  );

  if ("deny" in res) {
    throw new Error(res.deny);
  }

  const { name, stateDir } = res;
  const resultPath = `${stateDir}/result.json`;

  return {
    agent_id: name,
    name,
    wrapper: `agent-tmux ${cli}`,
    cwd: repoPath,
    result_path: resultPath,
  };
}

async function sendTmuxAgent(agentId, message) {
  const host = getHost();
  await ensureAdapterLive(host);
  const { rec, name, workerDir } = await getWorker(host, agentId);

  const dispatch = {
    profile: rec.profile,
    name: rec.name,
    dir: rec.dir,
    since: rec.since,
    owner: rec.owner,
    ownerCwd: rec.ownerCwd,
  };

  const outcome = await tellWorker(host, dispatch, String(message || ""));
  if (!outcome.ok) {
    const json = parseJsonLoose(outcome.text);
    const blocked = classifyBlocked(json);
    if (blocked) return blocked;
    if (outcome.text.includes("login_prompt") || outcome.text.includes("permission_prompt")) {
      const match = outcome.text.match(/(login_prompt|permission_prompt)/);
      return { status: "blocked", blocked_reason: match ? match[1] : "blocked", diagnostic: outcome.text };
    }
    if (outcome.text.includes("busy") || outcome.text.includes("held by")) {
      return { status: "blocked", blocked_reason: "busy", diagnostic: outcome.text };
    }
    return { status: "unconfirmed", reason: outcome.text };
  }

  return {
    status: "submitted",
    completion_source: "result_json",
  };
}

async function closedAcks(host, episodeDir) {
  const ackDir = `${episodeDir}/acks`;
  if (!(await existsOrThrow(host, ackDir))) return [];
  const entries = await listOrThrow(host, ackDir);
  return entries.filter((e) => e.kind === "dir").map((e) => e.name);
}

async function deliverEpisode(host, v3, rec, desc, targetSeq, episodeDir, resultPath, text, body) {
  if (inFlightDeliveries.has(episodeDir)) {
    await inFlightDeliveries.get(episodeDir);
    if ((await closedAcks(host, episodeDir)).some((name) => CLOSED_ACKS.includes(name))) {
      return { status: "already_acked" };
    }
  }
  let notifyDone;
  const inFlight = new Promise((resolve) => {
    notifyDone = resolve;
  });
  inFlightDeliveries.set(episodeDir, inFlight);
  try {
    return await doDeliverEpisode(host, v3, rec, desc, targetSeq, episodeDir, resultPath, text, body);
  } finally {
    inFlightDeliveries.delete(episodeDir);
    notifyDone();
  }
}

async function doDeliverEpisode(host, v3, rec, desc, targetSeq, episodeDir, resultPath, text, body) {
  // Closed ack first: never claim, and never hand the body out as a new completion.
  if ((await closedAcks(host, episodeDir)).some((name) => CLOSED_ACKS.includes(name))) {
    return { status: "already_acked" };
  }
  if (!TERMINAL.has(body.status) || !episodeMatches(body.episode, targetSeq)) {
    return { status: "failed", reason: "invalid_result", detail: { body, targetSeq } };
  }
  const me = host.owner();
  const gate = me ? gateFor(me) : undefined;
  if (!me || !gate || gate.activation === undefined) {
    return { status: "failed", reason: "not_live", detail: "no session activation; refusing to deliver (§3)" };
  }
  const gen0 = (desc && desc.owner) || rec.owner;
  let cur = await currentOwner(host, episodeDir, gen0);
  if (!cur) {
    const err = new Error(`IO error reading owner of ${episodeDir}`);
    err.code = "IO_ERROR";
    throw err;
  }
  if (!(cur.complete && cur.session === me)) {
    const claimResult = await claim(host, v3, episodeDir, gen0, me, await host.now());
    if (claimResult === "unknown") {
      const err = new Error(`IO error claiming ${episodeDir}`);
      err.code = "IO_ERROR";
      throw err;
    }
    cur = await currentOwner(host, episodeDir, gen0);
    if (!cur || !cur.complete || cur.session !== me) {
      return { status: "failed", reason: "not_owner", detail: { claim: claimResult, owner: cur && cur.session } };
    }
  }
  const observation = await observationOf(host, resultPath, text);
  const finished = {
    d: {
      profile: rec.profile,
      name: rec.name,
      dir: rec.dir,
      since: (desc && desc.since) || rec.since,
      owner: gen0,
      seq: targetSeq,
      resultPath,
    },
    path: resultPath,
    status: body.status,
    summary: body.summary || "",
    observation,
  };
  const ours = await stillOurs(host, gate, v3, [finished]);
  if (!ours) {
    return { status: "failed", reason: "not_live", detail: "activation superseded or unreadable (§4)" };
  }
  if (ours.length !== 1) {
    return { status: "failed", reason: "not_owner", detail: "episode owner changed before delivery (§3.3)" };
  }
  let answer;
  try {
    answer = await host.submit(payloadOf(ours).text);
  } catch (err) {
    host.log(`submit failed: ${err}`);
    return { status: "failed", reason: "delivery_refused", detail: String(err) };
  }
  if (answer && answer.drop) {
    host.log(`submit refused: ${answer.drop}`);
    return { status: "failed", reason: "delivery_refused", detail: answer.drop };
  }
  const ackResult = await ackFinished(host, v3, ours[0]);
  if (ackResult === "won") {
    deliveryCount += 1;
    return { status: "completed", body };
  }
  if (ackResult === "lost") {
    return { status: "already_acked" };
  }
  host.log(`ackFinished failed for ${rec.name}#${targetSeq}`);
  return { status: "failed", reason: "ack_failed", detail: `${rec.name}#${targetSeq}` };
}

async function waitTmuxAgent(agentId, timeoutSec = 600) {
  const host = getHost();
  await ensureAdapterLive(host);
  const { rec, name, workerDir, v3 } = await getWorker(host, agentId);

  const seqs = await numericChildren(host, `${workerDir}/episodes`);
  if (seqs == null) {
    const err = new Error(`IO error reading episodes for agent_id: ${agentId}`);
    err.code = "IO_ERROR";
    throw err;
  }
  const targetSeq = seqs.length ? Math.max(...seqs) : 1;
  const episodeDir = `${workerDir}/episodes/${targetSeq}`;
  const desc = await readDescriptor(host, episodeDir);
  if (desc === "unknown") {
    const err = new Error(`IO error reading descriptor for agent_id: ${agentId}`);
    err.code = "IO_ERROR";
    throw err;
  }
  const resultPath = (desc && typeof desc === "object" && desc.resultPath) || `${workerDir}/result.json`;

  const deadline = Date.now() + Math.max(0, Number(timeoutSec)) * 1000;

  for (;;) {
    // 1. Result file check
    const exists = await existsOrThrow(host, resultPath);
    if (exists) {
      let text;
      try {
        text = await host.read(resultPath);
      } catch (err) {
        host.log(`read(${resultPath}) error: ${err}`);
        const ioErr = new Error(`IO error reading ${resultPath}: ${err}`);
        ioErr.code = "IO_ERROR";
        throw ioErr;
      }
      if (text !== null) {
        let body;
        try {
          body = JSON.parse(text);
        } catch (err) {
          host.log(`parse JSON error on ${resultPath}: ${err}`);
          return {
            status: "failed",
            reason: "invalid_result",
            detail: { error: String(err), path: resultPath, valid: false }
          };
        }
        if (body && typeof body === "object") {
          const missingFields = missingResultFields(body);
          if (missingFields.length > 0) {
            return {
              status: "failed",
              reason: "invalid_result",
              detail: { missing_fields: missingFields, body, path: resultPath }
            };
          }
          if (typeof body.status !== "string" || !body.status) {
            return {
              status: "failed",
              reason: "invalid_result",
              detail: { error: "status must be a non-empty string", body, path: resultPath }
            };
          }
          if (!TERMINAL.has(body.status)) {
            // Non-terminal status (e.g. "running"); wait until done or deadline
          } else if (!episodeMatches(body.episode, targetSeq)) {
            // Episode does not match; wait until done or deadline
          } else {
            return await deliverEpisode(host, v3, rec, desc, targetSeq, episodeDir, resultPath, text, body);
          }
        }
      }
    }

    // 2. Status check
    const statusRun = await host.run(
      ["agent-tmux", rec.profile, "status", "--json", name],
      rec.dir,
      5000
    ).catch((err) => {
      host.log(`status check failed: ${err}`);
      return { exitCode: -1, stdout: "", stderr: String(err), failed: true };
    });
    if (statusRun) {
      if (statusRun.failed) {
        return { status: "failed", reason: "status_unreadable", detail: statusRun.stderr };
      }
      const rawStatus = `${statusRun.stdout || ""}${statusRun.stderr || ""}`.trim();
      const statusJson = parseJsonLoose(statusRun.stdout || statusRun.stderr);
      if (rawStatus && !statusJson) {
        return { status: "failed", reason: "status_unreadable", detail: "status output was not JSON" };
      }
      const statusBlocked = classifyBlocked(statusJson);
      if (statusBlocked) return statusBlocked;
      if (isDeadStatus(statusJson)) {
        return {
          status: "failed",
          reason: "dead_session",
          detail: statusJson,
        };
      }
    }

    if (Date.now() >= deadline) {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const existsAfter = await existsOrThrow(host, resultPath);
  if (!existsAfter) {
    return { status: "timed_out", reason: "missing_result", result_path: resultPath };
  }
  return { status: "timed_out", reason: "timeout" };
}

async function readTmuxAgent(agentId) {
  const host = getHost();
  await ensureAdapterLive(host);
  const { rec, name, workerDir } = await getWorker(host, agentId);

  const seqs = await numericChildren(host, `${workerDir}/episodes`);
  if (seqs == null) {
    const err = new Error(`IO error reading episodes for agent_id: ${agentId}`);
    err.code = "IO_ERROR";
    throw err;
  }
  const targetSeq = seqs.length ? Math.max(...seqs) : 1;
  const desc = await readDescriptor(host, `${workerDir}/episodes/${targetSeq}`);
  if (desc === "unknown") {
    const err = new Error(`IO error reading descriptor for agent_id: ${agentId}`);
    err.code = "IO_ERROR";
    throw err;
  }
  const resultPath = (desc && typeof desc === "object" && desc.resultPath) || `${workerDir}/result.json`;

  if (await existsOrThrow(host, resultPath)) {
    let text;
    try {
      text = await host.read(resultPath);
    } catch (err) {
      host.log(`read result error: ${err}`);
      const ioErr = new Error(`IO error reading ${resultPath}: ${err}`);
      ioErr.code = "IO_ERROR";
      throw ioErr;
    }
    try {
      const json = JSON.parse(text);
      return json.body || json;
    } catch (err) {
      host.log(`parse JSON error on ${resultPath}: ${err}`);
      const parseErr = new Error(`invalid JSON in ${resultPath}: ${err}`);
      parseErr.code = "INVALID_RESULT";
      throw parseErr;
    }
  }

  let run;
  try {
    run = await host.run(["agent-tmux", rec.profile, "result", "--json", name], rec.dir, 5000);
  } catch (err) {
    host.log(`agent-tmux result error: ${err}`);
    const ioErr = new Error(`IO error running agent-tmux result for ${name}: ${err}`);
    ioErr.code = "IO_ERROR";
    throw ioErr;
  }
  if (run && run.exitCode === 0) {
    const json = parseJsonLoose(run.stdout);
    if (json?.body || json) return json.body || json;
    if (String(run.stdout || "").trim()) {
      const parseErr = new Error(`invalid JSON from agent-tmux result for ${name}`);
      parseErr.code = "INVALID_RESULT";
      throw parseErr;
    }
  }

  const dispatch = {
    profile: rec.profile,
    name: rec.name,
    dir: rec.dir,
    since: rec.since,
    owner: rec.owner,
    ownerCwd: rec.ownerCwd,
  };
  let peek;
  try {
    peek = await peekWorker(host, dispatch, 40);
  } catch (err) {
    host.log(`peekWorker error: ${err}`);
    const ioErr = new Error(`IO error peeking ${name}: ${err}`);
    ioErr.code = "IO_ERROR";
    throw ioErr;
  }
  if (peek && peek.ok) {
    return { status: "running", pane: peek.text };
  }
  const err = new Error(peek && peek.text ? peek.text : `failed to read result for agent_id: ${agentId}`);
  err.code = "READ_FAILED";
  throw err;
}

async function closeTmuxAgent(agentId) {
  const host = getHost();
  await ensureAdapterLive(host);
  const { rec, name, workerDir } = await getWorker(host, agentId);

  const dispatch = {
    profile: rec.profile,
    name: rec.name,
    dir: rec.dir,
    since: rec.since,
    owner: rec.owner,
    ownerCwd: rec.ownerCwd,
  };

  const outcome = await stopWorker(host, gateFor(host.owner()), dispatch);
  if (!outcome.ok) {
    throw new Error(outcome.text || "agent-tmux stop failed");
  }
  return { closed: true };
}

function stopHeartbeat() {
  for (const timer of beatTimers.values()) clearInterval(timer);
  beatTimers.clear();
}

module.exports = {
  NO_BACKGROUND_JOBS_GUARD,
  NO_CASCADE_GUARD,
  NO_EXTERNAL_SIDE_EFFECTS_GUARD,
  REQUIRED_RESULT_LINE,
  buildWorkerPrompt,
  closeTmuxAgent,
  deliveries,
  ensureAdapterLive,
  getHost,
  getWorker,
  readTmuxAgent,
  resolveCoreModule,
  sendTmuxAgent,
  spawnTmuxAgent,
  stopHeartbeat,
  waitTmuxAgent,
};
