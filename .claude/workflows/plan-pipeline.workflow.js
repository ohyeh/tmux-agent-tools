// Generic, project-agnostic PLANNING pipeline. Prepares the planning artifacts ONLY —
// it deliberately STOPS before implementation/build. Encodes the four-layer model:
//
//   ① direction (goal_doc)  →  ② frozen plan (plan-<slug>.md)  →  ③ ADR design (docs/adr/NNNN-*)
//   └ then: review → commit → push the prepared DOCS.    ④ build is NOT part of this workflow.
//
// Each artifact is drafted by codex and frozen only after codex adversarial review reaches
// CLEAN (0 Critical / 0 Major). Output = "all PLAN | TASK | GOAL docs ready for build".
//
// NOTHING is hardcoded to a project: slug, brief, output paths, review settings all come from
// `args`. Drives codex via agent-tmux; completion is detected by POLLING an output file, never
// by matching a marker in the tmux pane (the marker echoes in the sent prompt — a real bug).
//
//   Workflow({ scriptPath: ".claude/workflows/plan-pipeline.workflow.js", args: {
//     repoPath: "/abs/repo",
//     slug: "<slug>",                               // names the plan/direction files
//     brief: "<the topic / feature idea to plan>",  // REQUIRED seed for the direction doc
//     directionPath: ".workflow/<slug>/direction.md",  // ① output (default derives from slug)
//     planPath: ".workflow/<slug>/plan.md",            // ② output (default derives from slug)
//     adrDir: "docs/adr",                           // ③ output dir (default "docs/adr")
//     maxReviewRounds: 6,                           // codex freeze rounds per artifact (default 6)
//     sessionName: "plan-<slug>", effort: "high", timeoutSec: 1200,
//     skipDirection: false,                         // true → directionPath already exists, start at ②
//     adrs: [{ slug: "external-idp", title: "..." }],// OPTIONAL: force these ADRs; else ② decides which are needed
//     commitPush: true, commitMessage: "docs(plan): freeze <slug> planning artifacts"
//   }})
export const meta = {
  name: 'plan-pipeline',
  description: 'Planning-only pipeline: direction → frozen plan → ADRs (codex-frozen) → commit/push docs. No build.',
  phases: [
    { title: 'Direction', detail: '① draft/refine goal_doc; codex review → ACCEPT', model: 'sonnet' },
    { title: 'Plan', detail: '② draft plan-<slug>.md; codex multi-round review → FROZEN', model: 'sonnet' },
    { title: 'ADRs', detail: '③ draft each needed ADR; codex review → FROZEN', model: 'sonnet' },
    { title: 'Integrate', detail: 'commit + push the prepared docs (no build)', model: 'sonnet' },
  ],
}

// NESTING: this is a mid-level stage — do NOT call workflow() here (1-level nesting cap). Drive
// codex/claude via inline agent() + agent-tmux, never via workflow() or a harness agent type.
//
// BUILTIN: arg-channel fallback. This env's Workflow tool drops `args` for scriptPath runs
// (documented gotcha — see .claude handoffs). Keep this {} in the committed/generic copy; to run a
// specific job either fix the arg channel or TEMPORARILY fill BUILTIN, run, then revert to {}.
const BUILTIN = {}
const a = { ...BUILTIN, ...(args || {}) }
const repo = a.repoPath || '.'
const slug = a.slug || 'next'
const brief = a.brief || ''
if (!brief && a.skipDirection !== true) return { aborted: true, reason: 'need brief (the topic to plan) or skipDirection:true with an existing directionPath' }
const directionPath = a.directionPath || `.workflow/next-direction/${slug}-direction.md`
const planPath = a.planPath || `.workflow/next-direction/plan-${slug}.md`
const adrDir = a.adrDir || 'docs/adr'
const maxRounds = a.maxReviewRounds || 6
const session = a.sessionName || `plan-${slug}`
const effort = a.effort || 'high'   // codex model_reasoning_effort AND the driving agent's effort
const model = a.model || 'sonnet'   // driving Claude agent's model (listed on every agent() below)
const timeout = a.timeoutSec || 1200

const FROZEN = { type: 'object', additionalProperties: false,
  required: ['ok', 'frozen', 'path', 'rounds', 'summary'],
  properties: {
    ok: { type: 'boolean' },
    frozen: { type: 'boolean', description: 'true iff codex review reached CLEAN (0 Critical / 0 Major)' },
    path: { type: 'string' },
    rounds: { type: 'integer', description: 'how many draft→review rounds it took' },
    requiredAdrs: { type: 'array', items: { type: 'object', additionalProperties: true,
      properties: { slug: { type: 'string' }, title: { type: 'string' }, brief: { type: 'string' } } },
      description: 'ADRs the plan says are needed (plan stage only)' },
    summary: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
  } }

const STATUS = { type: 'object', additionalProperties: false,
  required: ['ok', 'summary'], properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, detail: { type: 'string' } } }

// Shared instruction: how to drive codex draft→adversarial-review→freeze, file-polled.
const codexFreeze = (what, outPath, extra) =>
  `Drive codex via agent-tmux to DRAFT then FREEZE ${what}. If agent-tmux/codex-tmux are not on PATH, run them from the tmux-agent-tools skill bundle scripts/ dir.\n` +
  `1. Start codex: CODEX_TMUX_LAUNCH_FLAGS='--yolo -c model_reasoning_effort=${effort}' agent-tmux codex start --exact ${session} ${repo} "planning task incoming; read fully".\n` +
  `2. Have codex write the artifact to ${outPath} (create parent dirs). Ground every claim in real code/files — do NOT trust memory or stale docs.\n` +
  `3. FREEZE LOOP (max ${maxRounds} rounds): drive an ADVERSARIAL codex review of the artifact; codex writes its verdict to a unique OUT file ending with a last line exactly: === PLAN REVIEW END ===. Wait by POLLING that OUT file for the marker (NOT the tmux pane — it echoes in the sent prompt), up to ${timeout}s. If the verdict has any Critical/Major, apply the fix to ${outPath} and review again. Stop when CLEAN (0 Critical / 0 Major) or rounds exhausted.\n` +
  `4. Return frozen=true iff it reached CLEAN; path=${outPath}; rounds=number of rounds used; summary; blockers=[] (or remaining issues if not frozen).${extra || ''}`

const artifacts = []

// ── ① Direction (goal_doc) ──
let direction = { skipped: true, path: directionPath }
if (a.skipDirection !== true) {
  phase('Direction')
  direction = await agent(
    codexFreeze(
      `the DIRECTION goal_doc for "${slug}" at ${directionPath}. Topic/brief:\n<<<\n${brief}\n>>>\n` +
      `It must list candidate workstreams (goal / why-now / effort S·M·L / risk / readiness), a PRIORITIZED in-scope vs explicitly-deferred split (MECE) with one-line rationale each, the FIRST concrete step, and an "ADR vs direct build" flag per item`,
      directionPath
    ),
    { label: `direction:${slug}`, phase: 'Direction', model, effort, schema: FROZEN }
  )
  if (!direction || direction.ok !== true) return { stage: 'direction', passed: false, direction }
  artifacts.push(directionPath)
}

// ── ② Frozen plan ──
phase('Plan')
const plan = await agent(
  codexFreeze(
    `the implementation PLAN at ${planPath}, derived from the direction doc ${directionPath}. ` +
    `Include: goal, success criteria, scope/non-goals, per-area work breakdown (tasks with effort + touched files + deps), risks/open-questions, phased sequence, and an explicit "ADR vs direct build" list`,
    planPath,
    `\nAlso: in requiredAdrs[], list every design decision the plan says NEEDS an ADR (slug + title + one-line brief).`
  ),
  { label: `plan:${slug}`, phase: 'Plan', model, effort, schema: FROZEN }
)
if (!plan || plan.frozen !== true) return { stage: 'plan', passed: false, direction, plan, note: 'plan did not freeze CLEAN' }
artifacts.push(planPath)

// ── ③ ADRs (each frozen) ── prefer explicit args.adrs, else what the plan flagged.
const adrList = Array.isArray(a.adrs) && a.adrs.length ? a.adrs : (Array.isArray(plan.requiredAdrs) ? plan.requiredAdrs : [])
const adrResults = []
if (adrList.length) {
  phase('ADRs')
  for (const adr of adrList) {
    const adrPath = `${adrDir}/${adr.slug}.md`  // caller-provided slug should include the NNNN- prefix if their repo uses it
    const r = await agent(
      codexFreeze(
        `the ADR "${adr.title || adr.slug}" at ${adrPath} (number it per the existing ${adrDir}/ convention if it uses NNNN- prefixes). ` +
        `Decision brief: ${adr.brief || adr.title || adr.slug}. It must follow the format of existing ADRs in ${adrDir}/ and ground every choice in real source line references. This is DESIGN ONLY — no product code`,
        adrPath
      ),
      { label: `adr:${adr.slug}`, phase: 'ADRs', model, effort, schema: FROZEN }
    )
    adrResults.push(r || { ok: false, frozen: false, path: adrPath, summary: 'agent returned null' })
    if (r && r.frozen === true) artifacts.push(adrPath)
  }
  const unfrozen = adrResults.filter(r => !r || r.frozen !== true)
  if (unfrozen.length) return { stage: 'adrs', passed: false, direction, plan, adrResults, note: `${unfrozen.length} ADR(s) did not freeze CLEAN` }
}

// ── Integrate: review→commit→push the prepared DOCS (NO build, NO deploy) ──
let integrate = { skipped: true, reason: 'commitPush !== true' }
if (a.commitPush === true) {
  phase('Integrate')
  integrate = await agent(
    `In ${repo}: stage and commit ONLY these prepared planning docs, then push to the current branch's upstream:\n` +
    artifacts.map(p => `  - ${p}`).join('\n') + '\n' +
    `- Commit message: ${a.commitMessage ? JSON.stringify(a.commitMessage) : `"docs(plan): freeze ${slug} planning artifacts"`}. Match this repo's commit conventions (check recent git log; invent nothing it doesn't show).\n` +
    `- Do NOT add any source/test/build files — this is a planning-only commit. Do NOT deploy. Return ok=true with the pushed range in summary.`,
    { label: 'commit-push-docs', phase: 'Integrate', model, effort, schema: STATUS }
  )
  if (!integrate || integrate.ok !== true) return { stage: 'integrate', passed: false, direction, plan, adrResults, integrate }
}

return {
  passed: true,
  ready_for_build: true,
  stops_before: 'implementation/build (④) — by design',
  artifacts,
  direction, plan, adrResults, integrate,
  note: 'All PLAN | TASK | GOAL docs prepared & codex-frozen. Hand off to a build workflow (e.g. spec-implement-dual-review-verify) for ④.',
}
