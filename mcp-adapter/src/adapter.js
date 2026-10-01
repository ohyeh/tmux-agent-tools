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
  deliveryIdOf,
  episodeMatches,
  heartbeat,
  missingSections,
  newGate,
  observationOf,
  peekWorker,
  processId,
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
// Episode dir → the delivery in flight in this process; held until its ack is settled.
const inFlightDeliveries = new Map();
// JSON-RPC request id → settle(sent) of a `completed` wait response (plan §1c S4).
const pendingAcks = new Map();

function gateFor(sessionId) {
  let gate = gates.get(sessionId);
  if (!gate) {
    gate = newGate();
    // One delivery channel per session (plan §1c S3); also the `act/<n>.state` channel (C-health).
    gate.channel = "mcp";
    gates.set(sessionId, gate);
  }
  return gate;
}

const log = (text) => process.stderr.write(`[mcp-adapter] ${text}\n`);
let ownId;

/**
 * This server's session (plan D-mcp-id, §1b C-mcp-id): `TMUX_AGENT_SESSION`, else
 * `mcp-<hostname>-<pid>-<pidStart>` of this process (pidStart = epoch seconds). Hosts
 * start one stdio server per conversation, so one process is one session; a restart
 * is a new session. No id → the tool call fails; no owner is minted.
 */
function sessionId() {
  if (process.env.TMUX_AGENT_SESSION) return Promise.resolve(process.env.TMUX_AGENT_SESSION);
  if (!ownId) {
    ownId = processId(nodeHost({ log })).then((me) => {
      const start = Date.parse(`${me.pidStart} UTC`) / 1000;
      if (!(me.pid > 0) || !me.host || !Number.isFinite(start)) {
        const err = new Error("could not read this process's pid, host and start time (ps); no session id");
        err.code = "NO_SESSION_ID";
        throw err;
      }
      return `mcp-${me.host}-${me.pid}-${start}`;
    });
    ownId.catch(() => {
      ownId = undefined;
    });
  }
  return ownId;
}

async function getHost(cwd) {
  return nodeHost({ owner: await sessionId(), cwd: cwd || process.cwd(), log });
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

  const host = await getHost(repoPath);
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
    // The launch episode; `wait`/`read` take it to stay on this episode (C-mcp-ack).
    seq: 1,
    wrapper: `agent-tmux ${cli}`,
    cwd: repoPath,
    result_path: resultPath,
  };
}

async function sendTmuxAgent(agentId, message) {
  const host = await getHost();
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
  // The episode this tell opened, also when the send may have arrived (C-mcp-ack).
  const seq = outcome.seq === undefined ? {} : { seq: outcome.seq };
  if (!outcome.ok) {
    const json = parseJsonLoose(outcome.text);
    const blocked = classifyBlocked(json);
    if (blocked) return { ...blocked, ...seq };
    if (outcome.text.includes("login_prompt") || outcome.text.includes("permission_prompt")) {
      const match = outcome.text.match(/(login_prompt|permission_prompt)/);
      return { status: "blocked", blocked_reason: match ? match[1] : "blocked", diagnostic: outcome.text, ...seq };
    }
    if (outcome.text.includes("busy") || outcome.text.includes("held by")) {
      return { status: "blocked", blocked_reason: "busy", diagnostic: outcome.text, ...seq };
    }
    return { status: "unconfirmed", reason: outcome.text, ...seq };
  }

  return {
    status: "submitted",
    completion_source: "result_json",
    ...seq,
  };
}

async function closedAcks(host, episodeDir) {
  const ackDir = `${episodeDir}/acks`;
  if (!(await existsOrThrow(host, ackDir))) return [];
  const entries = await listOrThrow(host, ackDir);
  return entries.filter((e) => e.kind === "dir").map((e) => e.name);
}

/**
 * Deliver one finished episode as this wait's response (plan D-mcp-ack, §1c S4).
 * Delivered = the response bytes were flushed to stdout (the transport's write
 * callback), not "the client processed them". So the ack runs after that flush:
 * `extra` (the tool call's request) parks the ack under its request id until the
 * transport settles it; cancel, a send error, an error response or a transport close
 * settle it unsent (no ack). No `extra` = a direct caller that IS the channel: ack now.
 * The episode stays in flight in this process until the ack is settled, so an
 * overlapping wait waits for it and then sees the closing ack. At-least-once: a crash
 * between flush and ack re-reports the same `delivery_id` on a later wait.
 */
async function deliverEpisode(host, v3, rec, desc, targetSeq, episodeDir, resultPath, text, body, extra) {
  const deliveryId = deliveryIdOf({ name: rec.name, seq: targetSeq, owner: (desc && desc.owner) || rec.owner });
  while (inFlightDeliveries.has(episodeDir)) await inFlightDeliveries.get(episodeDir);
  let notifyDone;
  const inFlight = new Promise((resolve) => {
    notifyDone = resolve;
  });
  inFlightDeliveries.set(episodeDir, inFlight);
  const release = () => {
    inFlightDeliveries.delete(episodeDir);
    notifyDone();
  };
  let out;
  try {
    out = await doDeliverEpisode(host, v3, rec, desc, targetSeq, episodeDir, resultPath, text, body);
  } catch (err) {
    release();
    throw err;
  }
  if (!out.finished) {
    release();
    return out.status === "already_acked" ? { ...out, delivery_id: deliveryId } : out;
  }
  let acked;
  const settle = async (sent) => {
    try {
      if (!sent) {
        host.log(`${deliveryId}: response not sent (cancelled, send error or closed); not acked, a later wait re-reports it`);
        return;
      }
      acked = await ackFinished(host, v3, out.finished);
      if (acked === "unknown") host.log(`${deliveryId}: ack failed after the response was sent; a later wait re-reports the same delivery_id`);
    } catch (err) {
      host.log(`${deliveryId}: ack failed: ${err}`);
    } finally {
      release();
    }
  };
  const completed = { status: "completed", delivery_id: deliveryId, seq: targetSeq, body };
  if (extra && extra.requestId !== undefined) {
    holdAck(extra, settle);
    return completed;
  }
  await settle(true);
  if (acked === "won") return completed;
  if (acked === "lost") return { status: "already_acked", delivery_id: deliveryId };
  return { status: "failed", reason: "ack_failed", detail: `${rec.name}#${targetSeq}`, delivery_id: deliveryId };
}

/** Park `settle` until the transport flushes (or fails) the response to this request. */
function holdAck(extra, settle) {
  // Cancelled while the handler ran: the SDK sends nothing and the abort event is past.
  if (extra.signal?.aborted) {
    void settle(false);
    return;
  }
  const entry = { settle };
  pendingAcks.set(extra.requestId, entry);
  // Cancelled before the send began: the SDK sends nothing (protocol.js), so release here.
  extra.signal?.addEventListener("abort", () => {
    if (pendingAcks.get(extra.requestId) !== entry) return;
    pendingAcks.delete(extra.requestId);
    void settle(false);
  }, { once: true });
}

/**
 * The transport's half of S4: the response to `id` is being written, and `written`
 * resolves true once its bytes are flushed as a success. Taken out of the map first,
 * so a cancel that lands mid-write cannot settle it twice.
 */
async function settleWhenWritten(id, written) {
  const entry = pendingAcks.get(id);
  if (!entry) return;
  pendingAcks.delete(id);
  await entry.settle(await written);
}

/** Transport closed: nothing parked can be sent any more. */
async function settleAllUnsent() {
  const all = [...pendingAcks.values()];
  pendingAcks.clear();
  await Promise.all(all.map((e) => e.settle(false)));
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
    const why = (gate && gate.paused) || "no session activation; refusing to deliver (§3)";
    return { status: "failed", reason: "not_live", detail: why };
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
  return { finished: ours[0] };
}

/**
 * The episode a wait/read is about, fixed once at call time (D-mcp-ack): `seq` when
 * given (it must name an episode with a descriptor), else the max seq now. Its
 * resultPath comes from the immutable descriptor.
 */
async function episodeOf(host, workerDir, agentId, seq) {
  let targetSeq = seq;
  if (targetSeq === undefined) {
    const seqs = await numericChildren(host, `${workerDir}/episodes`);
    if (seqs == null) {
      const err = new Error(`IO error reading episodes for agent_id: ${agentId}`);
      err.code = "IO_ERROR";
      throw err;
    }
    targetSeq = seqs.length ? Math.max(...seqs) : 1;
  } else if (!Number.isInteger(targetSeq) || targetSeq < 1) {
    const err = new Error(`seq must be a positive integer, got ${JSON.stringify(seq)}`);
    err.code = "INVALID_SEQ";
    throw err;
  }
  const episodeDir = `${workerDir}/episodes/${targetSeq}`;
  const desc = await readDescriptor(host, episodeDir);
  if (desc === "unknown") {
    const err = new Error(`IO error reading descriptor for agent_id: ${agentId}`);
    err.code = "IO_ERROR";
    throw err;
  }
  if (seq !== undefined && !desc) {
    const err = new Error(`agent_id ${agentId} has no episode ${seq}`);
    err.code = "INVALID_SEQ";
    throw err;
  }
  const resultPath = (desc && typeof desc === "object" && desc.resultPath) || `${workerDir}/result.json`;
  return { targetSeq, episodeDir, desc, resultPath };
}

/** `opts.seq`: the episode to wait on (default: the max now). `opts.extra`: the MCP request (see deliverEpisode). */
async function waitTmuxAgent(agentId, timeoutSec = 600, opts = {}) {
  const host = await getHost();
  await ensureAdapterLive(host);
  const { rec, name, workerDir, v3 } = await getWorker(host, agentId);
  const { targetSeq, episodeDir, desc, resultPath } = await episodeOf(host, workerDir, agentId, opts.seq);

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
            return await deliverEpisode(host, v3, rec, desc, targetSeq, episodeDir, resultPath, text, body, opts.extra);
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

async function readTmuxAgent(agentId, seq) {
  const host = await getHost();
  await ensureAdapterLive(host);
  const { rec, name, workerDir } = await getWorker(host, agentId);
  const { resultPath } = await episodeOf(host, workerDir, agentId, seq);

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
  const host = await getHost();
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
  ensureAdapterLive,
  getHost,
  getWorker,
  readTmuxAgent,
  resolveCoreModule,
  sendTmuxAgent,
  settleAllUnsent,
  settleWhenWritten,
  spawnTmuxAgent,
  stopHeartbeat,
  waitTmuxAgent,
};
