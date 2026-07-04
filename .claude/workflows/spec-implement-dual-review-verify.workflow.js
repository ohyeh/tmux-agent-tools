// Reusable recipe: implement a spec, dual-review (codex + claude in parallel),
// then apply real in-spec fixes and verify with concrete commands.
// Generalized from the one-off `jenkins-cli-build` / `-trigger-cli` / `-iap-finalize`
// session workflows (standard-portal-app) — they were three instances of this same skeleton.
// Cross-project: fully parameterized via `args`. No hardcoded spec/paths.
//
// Invoke (canonical — use absolute scriptPath, not name):
//   Workflow({ scriptPath: ".claude/workflows/spec-implement-dual-review-verify.workflow.js", args: {
//     repoPath:  "/abs/path/to/repo",
//     spec:      "Full implementation spec (multi-line): what file to write/edit, style to match, exact behavior...",
//     targetFile:"scripts/foo/bar.sh",            // optional: file under review (repo-relative or absolute)
//     reviewFocus:"bash quoting under set -euo pipefail, curl error handling, edge cases",  // optional
//     verifyCommands: [                            // optional: run each in Finalize, paste outputs
//       "bash -n scripts/foo/bar.sh",
//       "shellcheck scripts/foo/bar.sh",
//       "./scripts/foo/bar.sh --help"
//     ],
//     model: "sonnet",                             // optional, default "sonnet" for implement/fix
//     effort: "high", timeoutSec: 600,             // optional, codex reasoning effort + OUT-file poll timeout
//     sessionName: "spec-c1",                       // optional, agent-tmux codex session label
//   }})
//
// PRESET — build from a frozen consensus plan (proven: build-smcs1498-from-frozen-plan).
// When a plan.md already passed consensus (e.g. via plan-pipeline / feature-plan-consensus),
// the spec arg is a PLAN POINTER, not a rewrite:
//   spec: `Implement the frozen plan at ${planPath}. Read it FULLY first; it is the
//          authoritative, consensus-passed spec. Follow its exact file targets, behavior,
//          and verification steps. Key invariants: <top 3-6 restated inline as a drift
//          guard>. Truth = source code and real command output, not memory. Do not modify
//          unrelated files.`
//   verifyCommands: exactly the plan's own verification steps (e.g. analyzer + targeted tests).
// Restating the key invariants inline matters: it protects against the implementer skimming
// the plan file, at ~10 lines' cost. Wrapper shape: an 18-line thin workflow that just calls
// this recipe — no need to save those shells; write them ad hoc.
// Second-model reviewer is codex driven via tmux-agent-tools (agent-tmux codex). If codex/agent-tmux
// are unavailable the driver agent() returns null and dual review degrades to single (codex_available:false).
//
// NOTE: workflow scripts have no FS/shell — only agents do. All file work happens inside agent() prompts.
// NESTING: this is a mid-level stage — do NOT call workflow() here (1-level nesting cap). Drive the
// second model via inline agent() + agent-tmux, never via workflow() or a harness agent type.

export const meta = {
  name: 'spec-implement-dual-review-verify',
  description: 'Implement a spec, dual-review (second model via args.cli + claude), apply in-spec fixes, verify (param via args)',
  whenToUse: 'When a written spec must become code with independent dual review and command-verified evidence — the main build pipeline. When a consensus-frozen plan.md already exists, pass a plan POINTER as the spec (see the frozen-plan preset in the header).',
  phases: [
    { title: 'Implement', detail: 'write/edit the target per spec', model: 'sonnet' },
    { title: 'Review', detail: 'second-model teammate (args.cli) + claude reviewer in parallel' },
    { title: 'Finalize', detail: 'apply real in-spec fixes then run verify commands' },
  ],
}

const a = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return {} } })() : (args || {})
for (const k of ['repoPath', 'spec']) if (!a[k]) return { aborted: true, reason: `missing arg: ${k}` }

const repo = a.repoPath
const model = a.model || 'sonnet'   // listed on every agent() below (never omitted)
const effort = a.effort || 'high'   // the harness agents' reasoning effort
// Official agent() opts, listed on every call. Both default OFF:
const isolation = a.isolation === 'worktree' ? 'worktree' : undefined  // spec: only 'worktree' enables; off = omit
const agentType = a.agentType || undefined  // off = default workflow agent (portable; missing custom agentType = HARD error #20931)
// Second-model reviewer driven via tmux-agent-tools (agent-tmux <cli>), NOT a harness agentType:
// the openai-codex plugin (codex:codex-rescue) is deprecated/disabled. agent-tmux works regardless
// of plugin enablement and across repos. Mirrors plan-pipeline / consensus-gate (file-polled).
// cli is REQUIRED and neutral — NO built-in default (codex/claude are just the common ones). Each CLI's
// launch flags come from its own agent-tmux profile (codex→--yolo, claude→--dangerously-skip-permissions);
// EXTRA flags pass raw via a.launchEnv. charset guard blocks shell injection (cli is interpolated into commands).
if (!/^[a-z0-9][a-z0-9._-]*$/i.test(a.cli || '')) return { aborted: true, reason: "missing/invalid arg: cli ('codex' | 'claude' | any agent-tmux profile name)" }
const cli = a.cli
const cliTimeout = Number.isInteger(a.timeoutSec) ? a.timeoutSec : 600
// sanitize sessionName (emitted into a shell command, like slug) — fall back to a derived safe label
const cliSession = (typeof a.sessionName === 'string' && /^[A-Za-z0-9._-]+$/.test(a.sessionName))
  ? a.sessionName
  : `spec-${cli}-${(a.slug || 'review').replace(/[^a-zA-Z0-9._-]/g, '_')}`
const REVIEW_MARKER = '=== SECOND-MODEL REVIEW END ==='
// Extra launch-flag env prefix — raw passthrough, caller-owned (profile already supplies each CLI's defaults).
// e.g. a.launchEnv = "CODEX_TMUX_LAUNCH_FLAGS='--yolo -c model_reasoning_effort=high' "
const launchEnv = typeof a.launchEnv === 'string' ? a.launchEnv : ''
// POSIX-safe single-quote: wraps in '...' and renders embedded ' as '\'' so any repo path is safe.
const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
const driveCli = (taskForCli, outHint) =>
  `Get a genuine SECOND-MODEL (${cli}) review by driving a ${cli} session via tmux-agent-tools — do NOT use any harness agent type. ` +
  `If agent-tmux/${cli}-tmux are not on PATH, run them from the tmux-agent-tools skill bundle scripts/ dir.\n` +
  `1. Pick a unique OUT file (${outHint}); instruct ${cli} to WRITE its full review to OUT, ending the file with a final line exactly: ${REVIEW_MARKER}\n` +
  `2. Start/reuse: ${launchEnv}agent-tmux ${cli} start --exact ${cliSession} ${shellQuote(repo)} "review task incoming; read fully before replying".\n` +
  `3. Send via file: write the task below to a temp file, then agent-tmux ${cli} send --from-file <file> --enter-count 1 ${cliSession}.\n` +
  `4. Wait by POLLING OUT (NOT the tmux pane — the marker echoes in the sent prompt), up to ${cliTimeout}s, until OUT exists AND contains "${REVIEW_MARKER}". Then read OUT and return ${cli}'s review (you are a conduit). Keep raw tmux scrollback out.\n\nTASK FOR ${cli.toUpperCase()}:\n${taskForCli}`
const target = a.targetFile ? `\nTarget file: ${a.targetFile}` : ''
const focus = a.reviewFocus || 'correctness, error handling, edge cases, anything that could silently corrupt state or data'
const verifyCommands = Array.isArray(a.verifyCommands) ? a.verifyCommands : []
const verifyClause = verifyCommands.length
  ? `Then VERIFY by running each of these and pasting the outputs:\n${verifyCommands.map(c => `  - ${c}`).join('\n')}`
  : `Then VERIFY with the narrowest relevant checks for this change (syntax check, linter, a smoke invocation) and paste the outputs.`

const SPEC = `Repo: ${repo}.${target}\n\nSPEC:\n${a.spec}`

phase('Implement')
const impl = await agent(
  `You are implementing per the spec below. Use the Write/Edit tools to make the change in the repo, then make any produced script executable if applicable. Keep it minimal — no features beyond the spec, do not modify unrelated files.\n${SPEC}`,
  { label: 'implement', phase: 'Implement', model, effort, isolation, agentType }
)
if (!impl) return { aborted: true, stage: 'implement', reason: 'implementation agent failed (returned null) — nothing to review' }
log('implementation done, starting dual review')

phase('Review')
const reviewPrompt = (who) =>
  `Review the change just implemented against the spec below. Focus (${who}): ${focus}. ` +
  `Return a concise list of CONCRETE issues with file/line references and suggested fixes. If none, say "no issues".\n${SPEC}`
const reviews = await parallel([
  () => agent(driveCli(reviewPrompt('second-model deep pass'), `/tmp/${cli}-review-${cliSession}.md`), { label: `review:${cli}`, phase: 'Review', model, effort, isolation, agentType }),
  () => agent(reviewPrompt('claude reviewer'), { label: 'review:claude', phase: 'Review', model, effort, isolation, agentType }),
])
// Detect BOTH reviewers symmetrically — each parallel thunk can return null on failure.
// Checking only codex would let a silent claude-side failure (or a total review loss) pass as success.
const codexAvailable = reviews[0] != null
const claudeAvailable = reviews[1] != null
if (!codexAvailable) log(`WARNING: external reviewer (codex via agent-tmux) returned null — dual review degraded.`)
if (!claudeAvailable) log(`WARNING: claude reviewer returned null — dual review degraded.`)
if (!codexAvailable && !claudeAvailable) {
  return { aborted: true, stage: 'review', reason: 'both reviewers failed — no review coverage to finalize against', impl, reviews, codex_available: false, claude_available: false }
}

phase('Finalize')
// P7 deviation→amendment gate: the finalizer must classify any change that touches the spec's
// EXPLICIT frozen claims (SC-x / ADR Decision lines). within-spec = elaborates (ok); deviation =
// small/reversible (log it, keep going); amendment-needed = CONTRADICTS a frozen line → HARD STOP,
// escalate to an ADR amendment (re-freeze via plan-pipeline) instead of silently editing through.
const FINALIZE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'verified', 'amendment_needed', 'deviations'],
  properties: {
    summary: { type: 'string' },
    verified: { type: 'boolean', description: 'verify commands ran and passed' },
    amendment_needed: { type: 'boolean', description: 'true iff any change contradicts a frozen spec/ADR line' },
    deviations: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['what', 'classification'],
      properties: {
        what: { type: 'string' },
        classification: { type: 'string', enum: ['within-spec', 'deviation', 'amendment-needed'] },
        frozen_ref: { type: 'string', description: 'the frozen SC-x / ADR Decision line it touches, if any' },
        rationale: { type: 'string' },
      },
    } },
  },
}
const fixed = await agent(
  `You are finalizing the change in ${repo}. Two reviews are below. Apply ONLY the fixes that are real and in-spec (ignore stylistic nitpicks and out-of-spec feature suggestions). ${verifyClause}\n` +
  `DEVIATION GATE: before finalizing, list every change that touches an EXPLICIT frozen claim in the spec (an SC-x success criterion or an ADR Decision/Consequence line). Classify each as ` +
  `"within-spec" (only elaborates what the frozen line left open), "deviation" (small/reversible departure — record it, keep going), or "amendment-needed" (CONTRADICTS a frozen line). ` +
  `If ANY item is amendment-needed, do NOT edit through it: set amendment_needed=true, leave that contradiction unimplemented, and stop.\n` +
  `Report what you changed, paste verification outputs, and return the deviations honestly.\n\n` +
  `REVIEW A (${cli}):\n${reviews[0] ?? 'unavailable'}\n\nREVIEW B (claude):\n${reviews[1] ?? 'unavailable'}\n\n${SPEC}`,
  { label: 'fix-and-verify', phase: 'Finalize', model, effort, isolation, agentType, schema: FINALIZE_SCHEMA }
)
if (!fixed) return { aborted: true, stage: 'finalize', reason: 'finalize agent failed (returned null) — implementation not verified', impl, reviews, codex_available: codexAvailable, claude_available: claudeAvailable }
// Gate on BOTH the boolean AND any amendment-needed deviation — a finalizer that sets the flag false
// while classifying a deviation as amendment-needed must NOT slip through (fail closed).
const amendmentNeeded = fixed.amendment_needed === true || (fixed.deviations || []).some(d => d && d.classification === 'amendment-needed')
if (amendmentNeeded) return { aborted: true, stage: 'finalize', reason: 'build contradicts a frozen spec/ADR line — escalate to an ADR amendment (re-freeze via plan-pipeline) before continuing; do not edit through', needsUser: true, deviations: fixed.deviations, impl, reviews, codex_available: codexAvailable, claude_available: claudeAvailable }
// Fail closed on verification: a finalizer that did not get verify passing is not a success.
if (fixed.verified !== true) return { aborted: true, stage: 'finalize', reason: 'verification did not pass (verified!=true) — not finalizing as success', needsUser: true, fixed, impl, reviews, codex_available: codexAvailable, claude_available: claudeAvailable }

return { impl, reviews, fixed, deviations: fixed.deviations, amendment_needed: false, verified: true, codex_available: codexAvailable, claude_available: claudeAvailable }
