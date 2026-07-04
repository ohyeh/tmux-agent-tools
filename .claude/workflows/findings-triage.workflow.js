// LOOP CONNECTOR (接頭 1): turns audit output into the next cycle's input.
// Position in the closed loop:
//   docs/design-vs-code-audit | root-cause-audit  →  THIS  →  feature-lifecycle-auto (briefs)
//                                                          →  partitioned fix run    (small fixes)
//                                                          →  the human              (ask-user)
// Routing table = _lib/findings-schema.js semantics (severity × action are orthogonal;
// ask-user is RESERVED for findings that challenge the author's INTENT):
//   ask-user                        → surface to the human, never auto-decide
//   no-op                           → record only
//   auto-fix, singleton root cause  → directFix list (partitioned-fix doctrine: disjoint file
//                                     ownership, SKIP+report on missing assets, never invent)
//   auto-fix, clustered root cause  → one mini-PRD per cluster (problem / why-now / scope /
//                                     non-goals / done-criteria) ready for feature-lifecycle-auto
// Cluster-vs-singleton is the "重複次數 → 抽象層級" rule replayed on fixes: N independent nits
// get N parallel patches; N findings sharing one bad abstraction get ONE plan.
// Re-audit stop condition (接頭 2, lives in the CALLER): after fixes/build, re-run the SAME
// audit with the SAME args — confirmed findings reaching zero = the loop converged.
//
//   Workflow({ scriptPath: ".claude/workflows/findings-triage.workflow.js", args: {
//     findings: [...],            // REQUIRED: confirmed findings from any audit recipe; any shape
//                                 // with at least a description/title + location-ish field. The
//                                 // normalizer maps them onto findings-schema semantics.
//     context: "repo /abs/path, Flutter app, ...",  // RECOMMENDED: injected into every agent
//     clusterMin: 2,              // findings sharing a root cause to justify a PRD (default 2)
//     maxBriefs: 5,               // cap PRDs per run (excess clusters overflow into directFix)
//     outputLanguage: "...",      // default Traditional Chinese (Taiwan)
//   }})
export const meta = {
  name: 'findings-triage',
  description: 'Loop connector: route confirmed audit findings — clustered root causes become mini-PRD briefs, singletons become a partitioned-fix list, intent questions go to the human',
  whenToUse: 'Immediately after any *-audit recipe returns confirmed findings and you want the loop to keep moving without hand-writing briefs: normalizes findings onto the findings-schema action semantics, clusters by root cause, writes one mini-PRD per cluster (feed feature-lifecycle-auto), lists singleton fixes for a partitioned fix run, and surfaces intent-challenging findings to the human. Thin by design — all heavy work is delegated downstream.',
  phases: [
    { title: 'Cluster', detail: 'normalize action per finding + group by shared root cause', model: 'sonnet' },
    { title: 'Brief', detail: 'one mini-PRD per qualifying cluster (problem/why-now/scope/non-goals/done)' },
  ],
}

// ── SAFE_LIB (canonical: .claude/workflows/_lib/safe.js — keep byte-identical) ──
const coalesceNull = (arr, fb) => arr.map((r, i) => (r == null ? fb(i) : r))
const nullIndices = (arr) => arr.reduce((a, r, i) => (r == null ? (a.push(i), a) : a), [])
const failClosedRefutes = (votes, total) => { const ok = votes.filter(Boolean); return ok.filter(v => v && v.refuted).length + (total - ok.length) }
// ── /SAFE_LIB ──
void [coalesceNull, nullIndices, failClosedRefutes]

const a = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return {} } })() : (args || {})
if (!Array.isArray(a.findings) || !a.findings.length) throw new Error('findings-triage requires args.findings (non-empty array from an audit recipe)')
const FINDINGS = a.findings
const CONTEXT = a.context || ''
const CLUSTER_MIN = Number.isInteger(a.clusterMin) && a.clusterMin >= 2 ? a.clusterMin : 2
const MAX_BRIEFS = Number.isInteger(a.maxBriefs) && a.maxBriefs > 0 ? a.maxBriefs : 5
const OUT_LANG = a.outputLanguage || 'Traditional Chinese (Taiwan), keeping code identifiers/paths as-is'

const CLUSTER_SCHEMA = {
  type: 'object',
  required: ['normalized', 'clusters'],
  additionalProperties: false,
  properties: {
    normalized: {
      type: 'array',
      items: {
        type: 'object',
        required: ['idx', 'action'],
        additionalProperties: false,
        properties: {
          idx: { type: 'integer', description: '0-based index into the input findings array' },
          action: { type: 'string', enum: ['no-op', 'auto-fix', 'ask-user'], description: 'ask-user ONLY for findings challenging the author intent, not routine fixes' },
          askUserWhy: { type: 'string', description: 'required when action=ask-user: what intent question the human must answer' },
        },
      },
    },
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rootCause', 'memberIdxs'],
        additionalProperties: false,
        properties: {
          rootCause: { type: 'string', description: 'the ONE shared defect these findings are symptoms of' },
          memberIdxs: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
  },
}

// ── Phase 1: Cluster — normalize action + group by root cause in one pass ──────
phase('Cluster')
const clustered = await agent(
  `${CONTEXT ? CONTEXT + '\n\n' : ''}You triage confirmed audit findings. For EACH finding below (referenced by its 0-based idx):
1. Assign action per findings-schema semantics: 'ask-user' is RESERVED for findings that challenge the author's INTENT (a design decision the audit disputes) — routine correctness/reliability/style fixes are 'auto-fix'; already-fixed/non-issues are 'no-op'. If the finding already carries an action field, keep it unless clearly wrong.
2. Group the auto-fix findings by ROOT CAUSE: two findings belong together ONLY if they are symptoms of the same underlying defect (same broken abstraction/state machine/contract) such that one fix closes both — NOT merely same file or same category. Findings with a unique root cause simply appear in no cluster.
You may Read cited files to confirm a shared root cause when unsure. Every input idx must appear in normalized exactly once. Write text in ${OUT_LANG}.

Findings (JSON):
${JSON.stringify(FINDINGS)}`,
  { label: 'cluster', phase: 'Cluster', schema: CLUSTER_SCHEMA }
)
// fail-closed: dead clusterer → nothing is lost; every finding degrades to a directFix candidate.
if (clustered == null) {
  log('WARNING: cluster agent died — degrading ALL findings to directFix (no briefs, no ask-user detection this run)')
  return {
    briefs: [], askUser: [], noOp: [],
    directFix: FINDINGS.map((f, i) => ({ idx: i, finding: f })),
    degraded: { clusterFailed: true, note: 'action/cluster judgment unavailable — re-run for PRD routing; directFix list is complete, nothing dropped' },
  }
}

const actionOf = new Map(clustered.normalized.map(n => [n.idx, n]))
const askUser = clustered.normalized.filter(n => n.action === 'ask-user').map(n => ({ idx: n.idx, why: n.askUserWhy || '', finding: FINDINGS[n.idx] }))
const noOp = clustered.normalized.filter(n => n.action === 'no-op').map(n => ({ idx: n.idx, finding: FINDINGS[n.idx] }))
const clusters = (clustered.clusters || [])
  .map(c => ({ ...c, memberIdxs: c.memberIdxs.filter(i => actionOf.get(i)?.action === 'auto-fix') }))
  .filter(c => c.memberIdxs.length >= CLUSTER_MIN)
const briefClusters = clusters.slice(0, MAX_BRIEFS)
const overflow = clusters.slice(MAX_BRIEFS)
if (overflow.length) log(`maxBriefs=${MAX_BRIEFS} hit — ${overflow.length} cluster(s) overflow into directFix (not dropped)`)
const inBrief = new Set(briefClusters.flatMap(c => c.memberIdxs))
const directFix = clustered.normalized
  .filter(n => n.action === 'auto-fix' && !inBrief.has(n.idx))
  .map(n => ({ idx: n.idx, finding: FINDINGS[n.idx] }))

// ── Phase 2: Brief — one mini-PRD per qualifying cluster ────────────────────────
phase('Brief')
const briefs = briefClusters.length ? await parallel(briefClusters.map(c => () =>
  agent(
    `${CONTEXT ? CONTEXT + '\n\n' : ''}Write ONE mini-PRD (a brief for feature-lifecycle-auto's args.brief) that fixes this root cause, in ${OUT_LANG}. Five short sections, prose not headings-heavy: 問題（root cause＋symptoms）｜為什麼現在（severity/user impact）｜範圍（files/components in scope）｜不碰什麼（explicit non-goals）｜完成判準（how a re-audit proves it closed — cite the concrete findings below as the checklist). Ground every claim in the findings; do NOT invent scope beyond them.

Root cause: ${c.rootCause}
Member findings (JSON):
${JSON.stringify(c.memberIdxs.map(i => FINDINGS[i]))}

Return ONLY the brief text — no preamble.`,
    { label: `brief:${c.rootCause}`.slice(0, 60), phase: 'Brief' }
  ).then(text => ({ rootCause: c.rootCause, memberIdxs: c.memberIdxs, brief: text }))
)) : []
const unbriefed = nullIndices(briefs).map(i => briefClusters[i])
const okBriefs = briefs.filter(Boolean)
if (unbriefed.length) log(`WARNING: ${unbriefed.length} brief writer(s) died — those clusters surface in degraded.unbriefedClusters, NOT dropped`)

log(`triage done: ${okBriefs.length} brief(s), ${directFix.length} direct-fix, ${askUser.length} ask-user, ${noOp.length} no-op`)
return {
  briefs: okBriefs,                     // → feature-lifecycle-auto, one call per brief
  directFix,                            // → partitioned fix run (disjoint ownership, SKIP+report, never invent — see design-vs-code-audit header)
  askUser,                              // → the human; the machine never decides intent
  noOp,
  degraded: { clusterFailed: false, unbriefedClusters: unbriefed, overflowClusters: overflow },
  nextStep: 'after fixes: re-run the ORIGINATING audit with the SAME args — zero confirmed findings = loop converged (接頭 2)',
}
