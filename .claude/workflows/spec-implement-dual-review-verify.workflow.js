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
//     externalAgentType: "codex:codex-rescue"      // optional, second-model reviewer; if unavailable agent()->null degrades to single review (surfaced as codex_available:false)
//   }})
//
// NOTE: workflow scripts have no FS/shell — only agents do. All file work happens inside agent() prompts.

export const meta = {
  name: 'spec-implement-dual-review-verify',
  description: 'Implement a spec, dual-review (codex + claude), apply in-spec fixes, verify (param via args)',
  phases: [
    { title: 'Implement', detail: 'write/edit the target per spec', model: 'sonnet' },
    { title: 'Review', detail: 'codex teammate + claude reviewer in parallel' },
    { title: 'Finalize', detail: 'apply real in-spec fixes then run verify commands' },
  ],
}

const a = args || {}
for (const k of ['repoPath', 'spec']) if (!a[k]) return { aborted: true, reason: `missing arg: ${k}` }

const repo = a.repoPath
const model = a.model || 'sonnet'
const externalAgentType = a.externalAgentType || 'codex:codex-rescue' // second-model reviewer; if unavailable, agent() -> null and dual review degrades to single (surfaced in return)
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
  { label: 'implement', phase: 'Implement', model }
)
if (!impl) return { aborted: true, stage: 'implement', reason: 'implementation agent failed (returned null) — nothing to review' }
log('implementation done, starting dual review')

phase('Review')
const reviewPrompt = (who) =>
  `Review the change just implemented against the spec below. Focus (${who}): ${focus}. ` +
  `Return a concise list of CONCRETE issues with file/line references and suggested fixes. If none, say "no issues".\n${SPEC}`
const reviews = await parallel([
  () => agent(reviewPrompt('second-model deep pass'), { label: 'review:codex', phase: 'Review', agentType: externalAgentType }),
  () => agent(reviewPrompt('claude reviewer'), { label: 'review:claude', phase: 'Review', model }),
])
// Detect BOTH reviewers symmetrically — each parallel thunk can return null on failure.
// Checking only codex would let a silent claude-side failure (or a total review loss) pass as success.
const codexAvailable = reviews[0] != null
const claudeAvailable = reviews[1] != null
if (!codexAvailable) log(`WARNING: external reviewer (${externalAgentType}) returned null — dual review degraded.`)
if (!claudeAvailable) log(`WARNING: claude reviewer returned null — dual review degraded.`)
if (!codexAvailable && !claudeAvailable) {
  return { aborted: true, stage: 'review', reason: 'both reviewers failed — no review coverage to finalize against', impl, reviews, codex_available: false, claude_available: false }
}

phase('Finalize')
const fixed = await agent(
  `You are finalizing the change in ${repo}. Two reviews are below. Apply ONLY the fixes that are real and in-spec (ignore stylistic nitpicks and out-of-spec feature suggestions). ${verifyClause}\n` +
  `Report what you changed and paste the verification command outputs.\n\n` +
  `REVIEW A (codex):\n${reviews[0] ?? 'unavailable'}\n\nREVIEW B (claude):\n${reviews[1] ?? 'unavailable'}\n\n${SPEC}`,
  { label: 'fix-and-verify', phase: 'Finalize', model }
)
if (!fixed) return { aborted: true, stage: 'finalize', reason: 'finalize agent failed (returned null) — implementation not verified', impl, reviews, codex_available: codexAvailable, claude_available: claudeAvailable }

return { impl, reviews, fixed, codex_available: codexAvailable, claude_available: claudeAvailable }
