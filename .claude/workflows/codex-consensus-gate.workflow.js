// Reusable building block: get high-effort codex consensus on a proposal before acting.
// Encodes the "ask codex for architecture consensus" rule as a one-call workflow.
// Maturity: WORKING (drives codex via agent-tmux inside a single agent).
//
//   Workflow({ scriptPath: ".claude/workflows/codex-consensus-gate.workflow.js", args: {
//     repoPath: "/abs/repo",            // cwd for the codex session
//     proposalFile: "/abs/proposal.md", // OR proposalText below
//     proposalText: "....",
//     sessionName: "arch1",             // agent-tmux session name
//     effort: "high",                   // low|medium|high (high => model_reasoning_effort=high)
//     marker: "=== CODEX VERDICT END ===",
//     timeoutSec: 600
//   }})
export const meta = {
  name: 'codex-consensus-gate',
  description: 'Get high-effort codex consensus on a proposal; returns the captured verdict',
  phases: [{ title: 'Consult', detail: 'drive codex via agent-tmux, capture verdict', model: 'sonnet' }],
}
const a = args || {}
if (!a.proposalFile && !a.proposalText) return { aborted: true, reason: 'need proposalFile or proposalText' }
const repo = a.repoPath || '.'
const session = a.sessionName || 'consensus'
const effort = a.effort || 'high'   // also the codex model_reasoning_effort (shell env below)
const model = a.model || 'sonnet'   // the driving Claude agent's model
// Official agent() opts, listed on every call so none reads as "unsupported". Both default OFF:
const isolation = a.isolation === 'worktree' ? 'worktree' : undefined  // spec: only 'worktree' enables; off = omit (NOT false/'none')
const agentType = a.agentType || undefined  // off = default workflow agent. NEVER hardcode a custom one — a missing agentType is a HARD error (#20931), breaks portability
const marker = a.marker || '=== CODEX VERDICT END ==='
const timeout = a.timeoutSec || 600
// Second-model CLI is REQUIRED and neutral — NO built-in default (this workflow is named for codex, but
// the mechanism drives any agent-tmux profile). Launch flags come from the CLI's own profile; EXTRA flags
// pass raw via a.launchEnv. charset guard blocks shell injection (cli is interpolated into commands).
if (!/^[a-z0-9][a-z0-9._-]*$/i.test(a.cli || '')) return { aborted: true, reason: "missing/invalid arg: cli ('codex' | 'claude' | any agent-tmux profile name)" }
const cli = a.cli
// e.g. a.launchEnv = "CODEX_TMUX_LAUNCH_FLAGS='--yolo -c model_reasoning_effort=high' " — caller-owned passthrough.
const launchEnv = typeof a.launchEnv === 'string' ? a.launchEnv : ''

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ok', 'verdict', 'consensus', 'notes'],
  properties: {
    ok: { type: 'boolean' },
    verdict: { type: 'string', description: 'codex verdict text, trimmed' },
    consensus: { type: 'string', enum: ['agree', 'agree_with_changes', 'disagree', 'unclear'] },
    notes: { type: 'string' },
  },
}

phase('Consult')
const r = await agent(
  `Drive a ${cli} session via agent-tmux to get a high-effort architecture/decision consensus, then return its verdict.
If the agent-tmux / ${cli}-tmux wrappers are not on PATH, run them from the tmux-agent-tools skill bundle (its scripts/ dir).
Steps:
1. Ensure the proposal text is available. ${a.proposalFile ? `Proposal file: ${a.proposalFile}.` : `Proposal text:\n<<<\n${a.proposalText}\n>>>\n(write it to a temp file to send via --from-file).`}
   Pick a unique output path OUT (e.g. /tmp/${cli}-consensus-${session}.md). Append an instruction to the proposal so ${cli}, when done, WRITES its full verdict to OUT and ENDS that file with a line exactly: ${marker}
2. Start (or reuse) a ${cli} session: ${launchEnv}agent-tmux ${cli} start --exact ${session} ${repo} "I will send a consensus request; read fully before replying."
3. Send the proposal: agent-tmux ${cli} send --from-file <file> --enter-count 1 ${session}
4. Wait for completion by POLLING the output file OUT, NOT by matching the marker in the tmux pane. The marker also appears in the prompt you just sent, so a pane/wait-text match would false-trigger on the echo (a bug hit repeatedly in practice). Poll: every few seconds check that OUT exists AND contains "${marker}", up to ${timeout}s. Only then read OUT. (agent-tmux ${cli} wait ${session} ${timeout} may be used as a secondary idle signal, but the file is the authoritative completion signal.)
5. Return: verdict = the verdict text read from OUT (trimmed, drop the trailing marker line); consensus = your classification (agree / agree_with_changes / disagree / unclear); notes = key objections or required changes.
Keep raw tmux scrollback out of the final message; return only the structured fields.`,
  { label: `${cli}:${session}`, phase: 'Consult', model, effort, isolation, agentType, schema: SCHEMA }
)
// `passed` is a strict allow-list: only genuine consensus clears the gate.
// agree_with_changes / unclear / disagree / missing all fall through to false;
// callers wanting a looser gate can inspect `consensus` directly.
return { gate: r, consensus: r?.consensus, passed: r?.ok === true && r?.consensus === 'agree' }
