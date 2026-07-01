const { execFile } = require("node:child_process");
const { randomBytes } = require("node:crypto");

const REQUIRED_RESULT_LINE =
  "Result JSON must include schema_version, status, summary, artifacts, and errors.";
const REQUIRED_RESULT_FIELDS = ["schema_version", "status", "summary", "artifacts", "errors"];
const NO_CASCADE_GUARD = "Do not spawn additional tmux sessions or delegate further.";

const sessions = new Map();

function agentTmuxBin() {
  return process.env.TMUX_AGENT_TMUX_BIN || process.env.AGENT_TMUX || "agent-tmux";
}

function safeName(cli, requested) {
  if (requested && /^[A-Za-z0-9._-]+$/.test(requested)) return requested;
  const suffix = randomBytes(4).toString("hex");
  const safeCli = String(cli || "agent").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 24);
  return `tmux-agent-${safeCli}-${suffix}`;
}

function parseJsonLoose(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch (_) {
      // keep walking; agent-tmux often prints human lines before JSON diagnostics
    }
  }
  return null;
}

function runAgentTmux(args, options = {}) {
  return new Promise((resolve) => {
    execFile(agentTmuxBin(), args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === "number" ? error.code : 0,
        signal: error ? error.signal : null,
        stdout: stdout || "",
        stderr: stderr || "",
        json: parseJsonLoose(`${stdout}\n${stderr}`),
      });
    });
  });
}

function buildWorkerPrompt(task, resultPath) {
  return `${task}

Write final JSON to this exact path: ${resultPath}
${REQUIRED_RESULT_LINE}
${NO_CASCADE_GUARD}`;
}

function recordFor(agentId) {
  const record = sessions.get(agentId);
  if (!record) {
    const err = new Error(`unknown agent_id: ${agentId}`);
    err.code = "UNKNOWN_AGENT";
    throw err;
  }
  return record;
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

async function spawnTmuxAgent(request) {
  const cli = String(request.cli || "").trim();
  const repoPath = String(request.repoPath || "").trim();
  const task = String(request.task || "");
  if (!cli || !repoPath || !task) {
    throw new Error("spawn_tmux_agent requires cli, repoPath, and task");
  }

  const name = safeName(cli, request.name);
  const resultPathRun = await runAgentTmux([cli, "result", "--path", name], {
    cwd: repoPath,
    timeoutMs: 30_000,
  });
  if (!resultPathRun.ok) {
    throw new Error(resultPathRun.stderr || resultPathRun.stdout || "failed to resolve result path");
  }

  const resultPath = resultPathRun.stdout.trim();
  const prompt = buildWorkerPrompt(task, resultPath);
  const startRun = await runAgentTmux([cli, "start", "--exact", name, repoPath, prompt], {
    cwd: repoPath,
    timeoutMs: (request.timeoutSec || 120) * 1000,
  });
  const blocked = classifyBlocked(startRun.json);
  if (!startRun.ok && blocked) {
    sessions.set(name, { cli, name, repoPath });
    return { agent_id: name, name, wrapper: `agent-tmux ${cli}`, cwd: repoPath, result_path: resultPath, ...blocked };
  }
  if (!startRun.ok) {
    throw new Error(startRun.stderr || startRun.stdout || "agent-tmux start failed");
  }

  sessions.set(name, { cli, name, repoPath });
  return { agent_id: name, name, wrapper: `agent-tmux ${cli}`, cwd: repoPath, result_path: resultPath };
}

async function sendTmuxAgent(agentId, message) {
  const { cli, name, repoPath } = recordFor(agentId);
  const run = await runAgentTmux([cli, "send-wait", name, String(message || "")], {
    cwd: repoPath,
    timeoutMs: 120_000,
  });
  const blocked = classifyBlocked(run.json);
  if (blocked) return blocked;
  if (run.ok && (run.stdout.includes("matched nonce:") || run.json?.submitted === true)) {
    return {
      status: "submitted",
      completion_source: run.json?.completion_source || (run.json?.submitted ? "result_json" : "nonce"),
    };
  }
  return { status: "unconfirmed", reason: "nonce_not_confirmed" };
}

async function waitTmuxAgent(agentId, timeoutSec = 600) {
  const { cli, name, repoPath } = recordFor(agentId);
  const wait = await runAgentTmux([
    cli,
    "result",
    "wait-required",
    name,
    "--fields",
    REQUIRED_RESULT_FIELDS.join(","),
    "--wait",
    String(timeoutSec),
    "--json",
  ], {
    cwd: repoPath,
    timeoutMs: (Number(timeoutSec) + 10) * 1000,
  });

  const blocked = classifyBlocked(wait.json);
  if (blocked) return blocked;
  if (wait.ok && wait.json?.body) {
    const missingFields = missingResultFields(wait.json.body);
    if (missingFields.length > 0) {
      return { status: "failed", reason: "invalid_result", detail: { ...wait.json, missing_fields: missingFields } };
    }
    return { status: "completed", body: wait.json.body };
  }

  const statusRun = await runAgentTmux([cli, "status", "--json", name], {
    cwd: repoPath,
    timeoutMs: 30_000,
  });
  const statusBlocked = classifyBlocked(statusRun.json);
  if (statusBlocked) return statusBlocked;
  if (!statusRun.ok || isDeadStatus(statusRun.json)) {
    return { status: "failed", reason: "dead_session", detail: statusRun.json || statusRun.stderr || statusRun.stdout };
  }

  if (wait.json?.present === false) {
    return { status: "timed_out", reason: "missing_result", result_path: wait.json.path };
  }
  if (wait.json?.present === true && wait.json?.valid === false) {
    return { status: "failed", reason: "invalid_result", detail: wait.json };
  }
  if (wait.json?.timeout === true) {
    return { status: "timed_out", reason: "timeout", detail: wait.json };
  }
  return { status: "failed", reason: "wait_failed", detail: wait.json || wait.stderr || wait.stdout };
}

async function readTmuxAgent(agentId) {
  const { cli, name, repoPath } = recordFor(agentId);
  const run = await runAgentTmux([cli, "result", "--json", name], {
    cwd: repoPath,
    timeoutMs: 30_000,
  });
  if (!run.ok) {
    throw new Error(run.stderr || run.stdout || "agent-tmux result failed");
  }
  return run.json?.body || run.json;
}

async function closeTmuxAgent(agentId) {
  const { cli, name, repoPath } = recordFor(agentId);
  const run = await runAgentTmux([cli, "stop", name], {
    cwd: repoPath,
    timeoutMs: 30_000,
  });
  sessions.delete(agentId);
  if (!run.ok) {
    throw new Error(run.stderr || run.stdout || "agent-tmux stop failed");
  }
  return { closed: true };
}

module.exports = {
  NO_CASCADE_GUARD,
  REQUIRED_RESULT_LINE,
  buildWorkerPrompt,
  closeTmuxAgent,
  readTmuxAgent,
  sendTmuxAgent,
  spawnTmuxAgent,
  waitTmuxAgent,
};
