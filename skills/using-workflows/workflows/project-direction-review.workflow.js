export const meta = {
  name: 'project-direction-review',
  description: 'Map a project\'s current state via parallel readers, propose direction options through distinct lenses, synthesize one prioritized roadmap',
  whenToUse: 'When a project needs a "where next" review: quarter planning, post-milestone direction reset, or turning scattered plans/proposals/runtime state into one prioritized roadmap. Pass the project root via args.root; customize readers/lenses when the defaults miss the project\'s shape.',
  phases: [
    { title: 'Understand', detail: 'parallel readers over plans, pending decisions, runtime health, constraints, consumers' },
    { title: 'Design', detail: 'one direction proposal per lens (default: quality / consumer / automation)' },
    { title: 'Synthesize', detail: 'merge into one prioritized roadmap' },
  ],
}

// args:
//   root      (REQUIRED string) absolute path of the project to review.
//   horizon   (optional string) planning window, e.g. "2026-07 → 2026-09"; default "the next quarter".
//   readers   (optional {key,prompt}[]) Understand-phase readers; default 5 generic
//             discovery readers that explore ${root} for plans/decisions/health/lessons/consumers.
//   lenses    (optional {key,angle}[]) Design-phase perspectives; default quality-first /
//             consumer-first / automation-first.
//   synthesisRequirements (optional string) extra requirements for the roadmap document.
//   outputLanguage (optional string) language for the synthesis; default English
//             (pass "繁體中文，台灣用語" for a zh-TW goal doc).
//
// Example:
//   Workflow({ scriptPath: ".../project-direction-review.workflow.js", args: {
//     root: "/Users/me/projects/foo", horizon: "2026-07 → 2026-09",
//   }})

// ── SAFE_LIB (canonical: .claude/workflows/_lib/safe.js — keep byte-identical) ──
const coalesceNull = (arr, fb) => arr.map((r, i) => (r == null ? fb(i) : r))
const nullIndices = (arr) => arr.reduce((a, r, i) => (r == null ? (a.push(i), a) : a), [])
const failClosedRefutes = (votes, total) => { const ok = votes.filter(Boolean); return ok.filter(v => v && v.refuted).length + (total - ok.length) }
// ── /SAFE_LIB ──
void [coalesceNull, failClosedRefutes]

const a = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return {} } })() : (args || {})
if (typeof a.root !== 'string' || !a.root.trim()) {
  throw new Error('project-direction-review requires args.root (absolute project path)')
}
const ROOT = a.root
const HORIZON = a.horizon || 'the next quarter'
const OUTPUT_LANG = a.outputLanguage || 'English, keeping code identifiers/technical terms as-is'
const SYNTH_EXTRA = a.synthesisRequirements ? `\nAdditional requirements: ${a.synthesisRequirements}` : ''

const READERS = (Array.isArray(a.readers) && a.readers.length) ? a.readers : [
  { key: 'plan-status', prompt: `Explore ${ROOT} for its planning docs (look for docs/plans/, docs/notes/, task_plan.md, ROADMAP*, implementation-notes*, milestone docs). Report: (1) the current plan's milestone structure, (2) which milestones are DONE vs IN-PROGRESS vs NOT STARTED, (3) what concrete work remains, (4) any items marked gated/HOLD and why. Be specific with names. Return a compact structured markdown summary.` },
  { key: 'pending-decisions', prompt: `Explore ${ROOT} for pending proposals and open decisions (look under docs/plans/, docs/proposals/, ADR dirs, open TODO/DECISION markers in top-level docs). Report: every pending decision or proposal that has NOT yet been executed, who/what gates it (operator decision, experiment result, evidence), and its expected impact. Compact markdown grouped by theme.` },
  { key: 'runtime-health', prompt: `Inspect the runtime/operational state of the project at ${ROOT}: health/state/status JSON files, logs, CI status, output artifacts, cron/perf records — whatever exists (use jq for JSON, rg/fd to discover). Report: current health posture, degradation or staleness signals, and the 2-3 weakest operational links. Compact markdown. If the project has no runtime surface, say so and report build/test health instead.` },
  { key: 'constraints-lessons', prompt: `Read ${ROOT}/lessons.md and the tail of ${ROOT}/task_plan.md if they exist (else look for CONTRIBUTING, conventions docs, post-mortems). Report: (1) hard constraints and recurring pitfalls future work must respect, (2) recent decisions that shape direction, (3) any explicit operator directives still standing. Compact markdown.` },
  { key: 'consumer-gaps', prompt: `Explore ${ROOT} for who consumes this project's output (README, ARCHITECTURE*, API docs, integration docs, audience/persona docs, audit reports). Report: (1) the consumers/integrations, (2) documented consumer-side gaps or audit findings not yet fixed, (3) opportunities where consumer value is clearly underserved. Compact markdown.` },
]

const LENSES = (Array.isArray(a.lenses) && a.lenses.length) ? a.lenses : [
  { key: 'quality-first', angle: 'output/core quality: correctness, freshness, dedup, ranking, taxonomy, evidence-gated evolution of the core' },
  { key: 'consumer-first', angle: 'consumer value & UX: the surfaces users actually touch, feedback-loop exploitation, decision-usefulness of the output' },
  { key: 'automation-first', angle: 'ops & automation: reliability, self-healing, validation/audit automation, reducing operator-gated bottlenecks' },
]

phase('Understand')
const rawFindings = await parallel(READERS.map(r => () =>
  agent(r.prompt, { label: `read:${r.key}`, phase: 'Understand' }).then(t => ({ key: r.key, text: t }))
))
const deadReaders = nullIndices(rawFindings)
if (deadReaders.length) log(`Understand: readers failed for [${deadReaders.map(i => READERS[i].key).join(', ')}] — evidence will be PARTIAL`)
const findings = rawFindings.filter(Boolean)
if (!findings.length) throw new Error('project-direction-review: all readers failed — no current-state evidence to plan from')
const gaps = deadReaders.length ? `\n\nWARNING: evidence is PARTIAL — these readers failed and their surfaces are UNKNOWN (do not assume they are fine): ${deadReaders.map(i => READERS[i].key).join(', ')}.` : ''
const ctx = findings.map(f => `## [${f.key}]\n${f.text}`).join('\n\n') + gaps
log(`Understand phase complete: ${findings.length}/${READERS.length} readers`)

phase('Design')
const rawProposals = await parallel(LENSES.map(l => () =>
  agent(`You are designing the direction for ${HORIZON} for the project at ${ROOT}. Current-state evidence below. Through the lens of "${l.angle}", propose a focused direction: 3-5 concrete workstreams, each with goal, why-now (cite evidence from context), rough effort (S/M/L), measurable success criteria, and what gate (experiment/operator/evidence) it needs. Avoid re-proposing work already DONE per the evidence. Respect the constraints listed. Return compact markdown.\n\n=== CURRENT STATE EVIDENCE ===\n${ctx}`,
    { label: `design:${l.key}`, phase: 'Design' }).then(t => ({ key: l.key, text: t }))
))
const proposals = rawProposals.filter(Boolean)
if (!proposals.length) throw new Error('project-direction-review: all lens proposals failed')
log(`Design phase complete: ${proposals.length}/${LENSES.length} proposals`)

phase('Synthesize')
const proposalText = proposals.map(p => `## Proposal [${p.key}]\n${p.text}`).join('\n\n')
const synthesis = await agent(`You are the chief planner for the project at ${ROOT}. Merge the direction proposals below into ONE coherent roadmap for ${HORIZON}. Requirements: (1) pick a primary theme and explain why it wins given the current-state evidence; (2) produce a prioritized workstream list (P0/P1/P2) — dedupe overlapping items across proposals, keep the best framing; (3) for each workstream: name, goal, success criteria, gate/dependency, effort; (4) explicitly list what is operator-gated vs agent-autonomous; (5) list top 5 risks with controls; (6) propose a milestone cut by period.${SYNTH_EXTRA} Write in ${OUTPUT_LANG}. Return well-structured markdown — this becomes the body of a goal document.\n\n=== CURRENT STATE EVIDENCE ===\n${ctx}\n\n=== PROPOSALS ===\n${proposalText}`,
  { label: 'synthesize:roadmap', phase: 'Synthesize' })
if (synthesis == null) throw new Error('project-direction-review: synthesis agent failed — no roadmap produced')

return { findings, synthesis, degraded: { failedReaders: deadReaders.map(i => READERS[i].key), failedLenses: LENSES.filter((l, i) => rawProposals[i] == null).map(l => l.key) } }
