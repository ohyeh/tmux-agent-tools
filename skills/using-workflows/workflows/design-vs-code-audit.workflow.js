export const meta = {
  name: 'design-vs-code-audit',
  description: 'Design-spec-vs-code drift audit: one finder per section, every finding adversarially verified, design-WIP-aware',
  whenToUse: 'When implementation must be reconciled against a design source of truth (Figma export, mockups, a frozen spec doc) and you need a verified drift list, not impressions. Sister of docs-vs-code-audit: there truth=code vs stale docs; here target=design vs current code. Audit-only (scout) — feed confirmed findings to a partitioned fix run (see header notes).',
  phases: [
    { title: 'Audit', detail: 'one finder per section: design spec vs code, component by component' },
    { title: 'Verify', detail: 'adversarially verify each finding against code truth; drop false positives, flag design-WIP' },
  ],
}

// args:
//   root         (REQUIRED string) absolute repo path being audited.
//   designSource (REQUIRED string) how agents access the design truth. Examples:
//                "The Figma file X is indexed in context-mode; ctx_search(queries) for node
//                 trees — do NOT re-fetch" / "Design exports live in docs/design/*.png +
//                 spec.md" / "The frozen spec is docs/specs/foo.md". Injected verbatim.
//   sections     (REQUIRED {key, wip, designRefs, files}[]) audit partitions:
//                key: section name; wip: false | 'partial' | true (design-WIP state —
//                unfinished design frames must NOT count missing components as code bugs);
//                designRefs: string[] of queries/paths locating this section's design truth;
//                files: string[] of code files owning this section.
//   categories   (optional string[]) drift taxonomy; default 7 UI categories
//                (MISSING/HALF_DONE/STATE_MACHINE/OVERLAP/ORDER/TEXT/STYLE).
//   extraRules   (optional string) appended to the audit rules (domain conventions).
//   outputLanguage (optional string) language for finding text; default English.
//
// Example:
//   Workflow({ scriptPath: ".../design-vs-code-audit.workflow.js", args: {
//     root: "/Users/me/git/healthgo-mobile",
//     designSource: "Figma '2026/06/15 健康幣版位' is ctx-indexed; use ctx_search, do not re-fetch.",
//     sections: [{ key: "健康幣主版位", wip: false,
//                  designRefs: ["健康幣 WalletCard 餘額卡片"],
//                  files: ["lib/main/coin/page/coin_home_page.dart"] }],
//   }})
//
// Follow-up fix run (proven pattern from health-coin-figma-fixes, not part of this recipe):
//   curate confirmed findings into an audit doc (🟢-now table with 位置/修法), then dispatch
//   one agent per DISJOINT file-group with hard ownership rules: edit only assigned files,
//   no new deps, missing asset/field → SKIP+report (never invent), locate by described code
//   not stale line numbers, no build commands (orchestrator verifies after). Or route the
//   curated spec through spec-implement-dual-review-verify.

// ── SAFE_LIB (canonical: .claude/workflows/_lib/safe.js — keep byte-identical) ──
const coalesceNull = (arr, fb) => arr.map((r, i) => (r == null ? fb(i) : r))
const nullIndices = (arr) => arr.reduce((a, r, i) => (r == null ? (a.push(i), a) : a), [])
const failClosedRefutes = (votes, total) => { const ok = votes.filter(Boolean); return ok.filter(v => v && v.refuted).length + (total - ok.length) }
// ── /SAFE_LIB ──
void [coalesceNull, failClosedRefutes]

const a = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return {} } })() : (args || {})
if (typeof a.root !== 'string' || !a.root.trim()) throw new Error('design-vs-code-audit requires args.root (absolute repo path)')
if (typeof a.designSource !== 'string' || !a.designSource.trim()) throw new Error('design-vs-code-audit requires args.designSource (how to access the design truth)')
if (!Array.isArray(a.sections) || !a.sections.length) throw new Error('design-vs-code-audit requires args.sections ({key, wip, designRefs, files}[])')
const ROOT = a.root
const DESIGN_SOURCE = a.designSource
const SECTIONS = a.sections
const OUTPUT_LANG = a.outputLanguage || 'English, keeping code identifiers/design-node names as-is'
const CATEGORIES = (Array.isArray(a.categories) && a.categories.length) ? a.categories : ['MISSING', 'HALF_DONE', 'STATE_MACHINE', 'OVERLAP', 'ORDER', 'TEXT', 'STYLE']

const RULES = `Compare the design spec against the code COMPONENT BY COMPONENT. Report drift in these categories:
- MISSING: a component/element present in the design is absent in code.
- HALF_DONE: component started but incomplete (placeholder, TODO, hardcoded stub, commented-out, mock standing in for real data).
- STATE_MACHINE: the code's state enum/switch does not cover all design variants (locked/unlocked/error/empty...), or maps a state to the wrong visual.
- OVERLAP: z-order / stacking problems — elements drawn on top of each other, duplicated layers.
- ORDER: layout/children order differs from the design.
- TEXT: wrong, missing, or hardcoded copy vs the design text.
- STYLE: obviously-off spacing/size/color/radius (only clear deviations, not 1-2px nits).
Use only these category codes: ${CATEGORIES.join(', ')} (categories above not in this list are disabled).
For EACH finding give: component name, category, designExpectation, codeReality, location (file:line or file), confidence 1-5.
IMPORTANT: if the design frames for this section are marked work-in-progress, note that in wipNote and do NOT report missing components as bugs for those frames — the design itself is unfinished. Only audit fully-drawn frames. Skip pure nitpicks. Be concrete and cite code. Write finding text in ${OUTPUT_LANG}.${a.extraRules ? '\nAdditional domain rules: ' + a.extraRules : ''}`

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['section', 'findings'],
  additionalProperties: false,
  properties: {
    section: { type: 'string' },
    wipNote: { type: 'string', description: 'which design frames are WIP, or "none"' },
    framesAudited: { type: 'string', description: 'which design frames/refs you actually compared' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['component', 'category', 'designExpectation', 'codeReality', 'location', 'confidence'],
        additionalProperties: false,
        properties: {
          component: { type: 'string' },
          category: { type: 'string' },
          designExpectation: { type: 'string' },
          codeReality: { type: 'string' },
          location: { type: 'string' },
          confidence: { type: 'integer' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['isReal', 'isDesignWip', 'severity', 'reason'],
  additionalProperties: false,
  properties: {
    isReal: { type: 'boolean', description: 'true if the drift genuinely exists in code after re-checking' },
    isDesignWip: { type: 'boolean', description: 'true if this is design-side WIP, not a code bug' },
    severity: { type: 'string', enum: ['high', 'med', 'low'] },
    reason: { type: 'string', description: 'what you re-checked and why the verdict' },
    fixHint: { type: 'string', description: 'one line: what code change would close it' },
  },
}

const wipHint = (wip) => wip === true
  ? 'the WHOLE section is flagged WIP in the design — expect the design itself to be unfinished; only flag code issues you are confident are NOT just missing design.'
  : wip === 'partial'
    ? 'SOME design frames are WIP — identify which and audit only the complete ones.'
    : 'design frames are complete — audit fully.'

const results = await pipeline(
  SECTIONS,
  (s) => agent(
    `${DESIGN_SOURCE}\n\nYou are auditing the "${s.key}" section of the project at ${ROOT}.\n\nStep 1 — pull the design spec for this section using these refs/queries (add your own follow-ups as needed): ${JSON.stringify(s.designRefs)}.\nStep 2 — Read these code files (use Read/Grep; follow into view-models/state files if you need to confirm a state machine): ${JSON.stringify(s.files)}.\nStep 3 — ${RULES}\n\nDesign-WIP hint for this section: ${wipHint(s.wip)}\n\nReturn structured findings.`,
    { label: `audit:${s.key}`, phase: 'Audit', schema: FINDINGS_SCHEMA }
  ),
  (res, s) => {
    if (res == null) return { section: s.key, finderFailed: true, verified: [] }
    if (!res.findings || !res.findings.length) return { section: s.key, wipNote: res.wipNote, verified: [] }
    return parallel(res.findings.map(f => () =>
      agent(
        `Adversarially verify ONE design-vs-code drift finding for the "${s.key}" section of the project at ${ROOT}. Default to skeptical — only confirm if you can prove it in the code.\n\n${DESIGN_SOURCE}\n\nFinding:\n- component: ${f.component}\n- category: ${f.category}\n- design says: ${f.designExpectation}\n- code reality (claimed): ${f.codeReality}\n- location: ${f.location}\n- reporter confidence: ${f.confidence}/5\n\nRe-Read the cited code (${f.location}) and related files in ${JSON.stringify(s.files)}. Check: (a) is the claimed code-reality actually true, or is it implemented somewhere the finder missed? (b) is this just design-WIP (design unfinished), not a code bug? (c) how severe is it for a user? You may re-check the design refs (${JSON.stringify(s.designRefs)}) to confirm the expectation. Return your verdict.`,
        { label: `verify:${s.key}:${f.component}`.slice(0, 60), phase: 'Verify', schema: VERDICT_SCHEMA }
      ).then(v => ({ ...f, section: s.key, verdict: v }))
    )).then(vs => vs.map((v, i) => v || { ...res.findings[i], section: s.key, verdict: null }))
  }
)

const failedSections = []
const all = []
for (const r of results) {
  if (r == null) continue
  if (Array.isArray(r)) all.push(...r)
  else if (r.finderFailed) failedSections.push(r.section)
}
const deadPipelines = nullIndices(results)
if (deadPipelines.length) failedSections.push(...deadPipelines.map(i => SECTIONS[i].key))

const confirmed = all.filter(f => f.verdict && f.verdict.isReal && !f.verdict.isDesignWip)
const designWip = all.filter(f => f.verdict && f.verdict.isDesignWip)
const dropped = all.filter(f => f.verdict && !f.verdict.isReal && !f.verdict.isDesignWip)
const unverified = all.filter(f => !f.verdict)

if (failedSections.length) log(`WARNING: finder failed for sections [${failedSections.join(', ')}] — those surfaces are UNAUDITED, not clean`)
if (unverified.length) log(`WARNING: ${unverified.length} finding(s) lost their verifier — reported as unverified, not dropped`)
log(`audit done: ${confirmed.length} confirmed real, ${designWip.length} design-WIP, ${dropped.length} false-positive, ${unverified.length} unverified`)

const bySection = {}
for (const f of confirmed) (bySection[f.section] ||= []).push(f)

return {
  summary: {
    confirmedReal: confirmed.length,
    designWip: designWip.length,
    falsePositive: dropped.length,
    unverified: unverified.length,
    bySectionCounts: Object.fromEntries(Object.entries(bySection).map(([k, v]) => [k, v.length])),
  },
  confirmed: confirmed.map(f => ({ section: f.section, component: f.component, category: f.category, severity: f.verdict.severity, design: f.designExpectation, code: f.codeReality, location: f.location, fixHint: f.verdict.fixHint })),
  designWipNotes: designWip.map(f => ({ section: f.section, component: f.component, note: f.verdict.reason })),
  unverified: unverified.map(f => ({ section: f.section, component: f.component, category: f.category, location: f.location, note: 'verifier died — treat as PLAUSIBLE, re-check manually' })),
  degraded: { unauditedSections: failedSections, unverifiedCount: unverified.length },
}
