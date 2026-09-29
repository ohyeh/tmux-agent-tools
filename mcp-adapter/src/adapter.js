const path = require("node:path");
const {
  REQUIRED_RESULT_LINE,
  assignWorker,
  missingSections,
  newGate,
  peekWorker,
  rootOf,
  stopWorker,
  tellWorker,
  v3Of,
} = require("../../skills/tmux-agent-tools/scripts/lib/workers.ts");
const {
  numericChildren,
  readDescriptor,
  readWorker,
} = require("../../skills/tmux-agent-tools/scripts/lib/ledger.ts");
const { nodeHost } = require("../../skills/tmux-agent-tools/scripts/lib/host.node.ts");

const REQUIRED_RESULT_FIELDS = ["schema_version", "status", "summary", "artifacts", "errors"];
const NO_CASCADE_GUARD = "Do not spawn additional tmux sessions or delegate further.";
const NO_BACKGROUND_JOBS_GUARD = "Do not start background jobs unless explicitly requested.";
const NO_EXTERNAL_SIDE_EFFECTS_GUARD = "Do not create external side effects unless explicitly authorized.";

const gate = newGate();

function getHost(cwd) {
  const sessionId = process.env.TMUX_AGENT_SESSION || `mcp-${process.pid}`;
  return nodeHost({
    owner: sessionId,
    cwd: cwd || process.cwd(),
    log: (text) => process.stderr.write(`[mcp-adapter] ${text}\n`),
  });
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
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch (_) {
      // keep walking
    }
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
  if (!json) return false;
  if (json.dead === true || json.alive === false || json.running === false) return true;
  const text = JSON.stringify(json).toLowerCase();
  return text.includes("dead") || text.includes("no such session") || text.includes("can't find session");
}

function missingResultFields(body) {
  if (!body || typeof body !== "object") return REQUIRED_RESULT_FIELDS;
  return REQUIRED_RESULT_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(body, field));
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
  let workerDir = `${v3}/${name}`;
  let rec = await readWorker(host, workerDir);
  if (!rec || rec === "unknown") {
    if (await host.exists(v3).catch(() => false)) {
      const entries = await host.list(v3).catch(() => []);
      const matches = entries.filter(
        (e) => e.kind === "dir" && (e.name === name || e.name.startsWith(`${name}.`))
      );
      if (matches.length >= 1) {
        matches.sort((a, b) => b.name.localeCompare(a.name));
        name = matches[0].name;
        workerDir = `${v3}/${name}`;
        rec = await readWorker(host, workerDir);
      }
    }
  }
  if (!rec || rec === "unknown") {
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

async function waitTmuxAgent(agentId, timeoutSec = 600) {
  const host = getHost();
  const { rec, name, workerDir } = await getWorker(host, agentId);

  const seqs = (await numericChildren(host, `${workerDir}/episodes`)) || [];
  const targetSeq = seqs.length ? Math.max(...seqs) : 1;
  const desc = await readDescriptor(host, `${workerDir}/episodes/${targetSeq}`);
  const resultPath = (desc && typeof desc === "object" && desc.resultPath) || `${workerDir}/result.json`;

  const deadline = Date.now() + Number(timeoutSec) * 1000;

  for (;;) {
    if (process.env.FAKE_STATUS_BLOCKED === "1") {
      return {
        status: "blocked",
        blocked_reason: process.env.FAKE_STATUS_BLOCKED_REASON || "permission_prompt",
        diagnostic: "session may be waiting for interactive confirmation",
      };
    }
    if (process.env.FAKE_INVALID_RESULT === "1") {
      return { status: "failed", reason: "invalid_result", detail: { path: resultPath, valid: false } };
    }
    if (process.env.FAKE_DEAD_SESSION === "1") {
      return { status: "failed", reason: "dead_session", detail: { name, running: false } };
    }

    if (await host.exists(resultPath).catch(() => false)) {
      let body;
      try {
        const text = await host.read(resultPath);
        body = JSON.parse(text);
      } catch (_) {}
      if (body && typeof body === "object") {
        const missingFields = missingResultFields(body);
        if (missingFields.length > 0) {
          return { status: "failed", reason: "invalid_result", detail: { missing_fields: missingFields, body } };
        }
        return { status: "completed", body };
      }
    }

    const statusRun = await host.run(["agent-tmux", rec.profile, "status", "--json", name], rec.dir, 5000).catch(() => null);
    if (statusRun) {
      const statusJson = parseJsonLoose(statusRun.stdout || statusRun.stderr);
      const statusBlocked = classifyBlocked(statusJson);
      if (statusBlocked) return statusBlocked;
      if (statusRun.exitCode !== 0 || isDeadStatus(statusJson)) {
        return { status: "failed", reason: "dead_session", detail: statusJson || statusRun.stderr || statusRun.stdout };
      }
    }

    if (Date.now() >= deadline) {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!(await host.exists(resultPath).catch(() => false))) {
    return { status: "timed_out", reason: "missing_result", result_path: resultPath };
  }
  return { status: "timed_out", reason: "timeout" };
}

async function readTmuxAgent(agentId) {
  const host = getHost();
  const { rec, name, workerDir } = await getWorker(host, agentId);

  const seqs = (await numericChildren(host, `${workerDir}/episodes`)) || [];
  const targetSeq = seqs.length ? Math.max(...seqs) : 1;
  const desc = await readDescriptor(host, `${workerDir}/episodes/${targetSeq}`);
  const resultPath = (desc && typeof desc === "object" && desc.resultPath) || `${workerDir}/result.json`;

  if (await host.exists(resultPath).catch(() => false)) {
    const text = await host.read(resultPath);
    try {
      const json = JSON.parse(text);
      return json.body || json;
    } catch (_) {}
  }

  const run = await host.run(["agent-tmux", rec.profile, "result", "--json", name], rec.dir, 5000).catch(() => null);
  if (run && run.exitCode === 0) {
    const json = parseJsonLoose(run.stdout);
    if (json?.body || json) return json.body || json;
  }

  const dispatch = {
    profile: rec.profile,
    name: rec.name,
    dir: rec.dir,
    since: rec.since,
    owner: rec.owner,
    ownerCwd: rec.ownerCwd,
  };
  const peek = await peekWorker(host, dispatch, 40).catch(() => null);
  if (peek && peek.ok) {
    return { status: "running", pane: peek.text };
  }
  throw new Error(`failed to read result for agent_id: ${agentId}`);
}

async function closeTmuxAgent(agentId) {
  const host = getHost();
  const { rec, name, workerDir } = await getWorker(host, agentId);

  const dispatch = {
    profile: rec.profile,
    name: rec.name,
    dir: rec.dir,
    since: rec.since,
    owner: rec.owner,
    ownerCwd: rec.ownerCwd,
  };

  const outcome = await stopWorker(host, gate, dispatch);
  if (!outcome.ok) {
    throw new Error(outcome.text || "agent-tmux stop failed");
  }
  return { closed: true };
}

module.exports = {
  NO_BACKGROUND_JOBS_GUARD,
  NO_CASCADE_GUARD,
  NO_EXTERNAL_SIDE_EFFECTS_GUARD,
  REQUIRED_RESULT_LINE,
  buildWorkerPrompt,
  closeTmuxAgent,
  readTmuxAgent,
  sendTmuxAgent,
  spawnTmuxAgent,
  waitTmuxAgent,
};
