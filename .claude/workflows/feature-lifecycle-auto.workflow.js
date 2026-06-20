// feature-lifecycle-auto — THIN SHELL. Zero business logic; only orchestrates the
// already-built stage workflows via workflow() and gates between them.
//
//   PLAN (pick one) ──► [gate: clean?] ──► BUILD (optional) ──► return
//     mode:'explore' → feature-plan-consensus   (discovery + internal/codex consensus)
//     mode:'frozen'  → plan-pipeline            (direction → plan → ADR, codex-frozen)
//                                               BUILD = spec-implement-dual-review-verify
//
// Layering: this shell calls the MID-level stage workflows (one nesting level — the max
// allowed). Those stages drive codex themselves; the shell never touches codex/atoms directly.
//
//   Workflow({ name: 'feature-lifecycle-auto', args: {
//     repoPath:   '/abs/repo',                 // REQUIRED
//     brief:      '<feature brief / topic>',   // REQUIRED (the plan seed)
//     mode:       'explore',                   // 'explore' (default) | 'frozen'
//     slug:       'c1-source-id',              // names plan artifacts
//     autoBuild:  false,                       // DEFAULT false: stop at the gate, let the human read the plan
//     planPath:   '.workflow/c1/plan-c1.md',   // optional; else derived by the stage from slug
//     commit:     false, push: false,          // git gate, forwarded to the plan stage
//     maxInternalRounds, maxExternalRounds, maxReviewRounds, effort, timeoutSec, // optional passthroughs
//   }})
//
// NOTE: workflow scripts have no FS/shell — only agents do. This shell does pure control flow.
export const meta = {
  name: 'feature-lifecycle-auto',
  description: 'Thin all-in-one shell: chains a plan-maker → (gate) → spec-implement build by calling existing workflows',
  phases: [
    { title: 'Plan', detail: 'run plan-maker (explore=feature-plan-consensus | frozen=plan-pipeline)' },
    { title: 'Gate', detail: 'stop unless the plan stage cleared consensus/freeze' },
    { title: 'Build', detail: 'optional: spec-implement-dual-review-verify against the frozen plan' },
  ],
}

// ── ARG CHANNEL ────────────────────────────────────────────────────────────────
// CONFIRMED by probe (wf_dc3b2e66): this env's Workflow TOOL drops `args` into the top
// script (both name AND scriptPath invocation) — a runtime bug we can't patch from here.
// But nested workflow() args DO arrive (wf_61bac362), and agents CAN read files.
// So the working input channel is a JOB FILE read by a 1-shot agent. Precedence:
//   1. args          (works if the harness ever fixes the top-level channel)
//   2. PROJECT_JOB   (PREFERRED: <cwd>/.claude/workflows/... — per-project, version-controlled,
//                     concurrency-safe. The agent reads it relative to YOUR cwd, so being in the
//                     repo is all the disambiguation it needs; repoPath then defaults to '.')
//   3. GLOBAL_JOB    (fallback: drive an arbitrary repo from elsewhere — SINGLE-SLOT, NOT
//                     concurrency-safe; only used when no project-local file exists)
//   4. BUILTIN       (last-resort hardcode; keep {} in the committed copy)
const PROJECT_JOB = '.claude/workflows/feature-lifecycle-auto.job.json'
const GLOBAL_JOB = '$HOME/.claude/workflows/.feature-lifecycle-auto.job.json'
const BUILTIN = {}
let a = { ...(args || {}) }
if (!a.repoPath || !a.brief) {
  const job = await agent(
    `Read a job JSON object. PREFER ${PROJECT_JOB} (relative to your current working directory). ` +
    `If it is absent or unreadable, fall back to ${GLOBAL_JOB} (expand $HOME). ` +
    `Return the parsed object of whichever existed, with an added "_source":"project"|"global". ` +
    `If neither exists, return {}. Return ONLY the object — no prose.`,
    { label: 'read-job', phase: 'Plan', model: 'sonnet', effort: 'high', isolation: undefined, agentType: undefined, schema: { type: 'object', additionalProperties: true } }   // bootstrap: literal defaults (config not read yet)
  )
  const src = job && job._source; if (job) delete job._source
  a = { ...BUILTIN, ...(job || {}), ...a }
  if (src === 'project' && !a.repoPath) a.repoPath = '.'   // you're in the repo → it IS the target
  if (src === 'global') log(`P4 WARNING: inputs came from the SHARED global job file — NOT concurrency-safe; confirm slug=${a.slug || '?'} is THIS run before trusting it.`)
  else if (src === 'project') log(`Inputs from project-local ${PROJECT_JOB} (per-project, concurrency-safe).`)
}
for (const k of ['repoPath', 'brief']) if (!a[k]) return { aborted: true, reason: `missing arg: ${k} — put it in ${PROJECT_JOB} (preferred) or ${GLOBAL_JOB} (top-level Workflow args are dropped by this runtime)` }
const mode = a.mode === 'frozen' ? 'frozen' : 'explore'
const slug = a.slug || 'feature'
// ponytail: slug guard mirrors the stage workflows — keep the shell's own boundary check.
if (!/^[a-zA-Z0-9._-]+$/.test(slug) || slug.includes('..')) return { aborted: true, reason: `invalid slug '${slug}'` }
// model/effort resolved once and forwarded EXPLICITLY to every nested stage + own agent (never
// omitted — "not shown" must not read as "unsupported"). Defaults: sonnet / high.
const model = a.model || 'sonnet'
const effort = a.effort || 'high'
// Official agent() opts, also forwarded to nested stages. Both default OFF:
const isolation = a.isolation === 'worktree' ? 'worktree' : undefined  // spec: only 'worktree' enables; off = omit
const agentType = a.agentType || undefined  // off = default workflow agent (portable; missing custom agentType = HARD error #20931)

// ── Phase 1: PLAN — delegate to the chosen mid-level workflow ──────────────────
phase('Plan')
let plan, planPath, planClean
if (mode === 'explore') {
  plan = await workflow('feature-plan-consensus', {
    repoPath: a.repoPath, featureBrief: a.brief, slug,
    maxInternalRounds: a.maxInternalRounds, maxExternalRounds: a.maxExternalRounds,
    cli: a.cli, model, effort, isolation, agentType, timeoutSec: a.timeoutSec,   // forward model/effort/isolation/agentType EXPLICITLY
    commit: a.commit === true, push: a.push === true,
  })
  // success path returns planPath + internal/external; any abort sets aborted/needsUser.
  planClean = !!plan && !plan.aborted && !plan.needsUser
  planPath = plan?.planPath || a.planPath
} else {
  plan = await workflow('plan-pipeline', {
    repoPath: a.repoPath, brief: a.brief, slug, planPath: a.planPath,
    maxReviewRounds: a.maxReviewRounds, model, effort, isolation, agentType, timeoutSec: a.timeoutSec,   // model/effort/isolation/agentType explicit
    commitPush: a.commit === true || a.push === true,
  })
  planClean = !!plan && plan.passed === true && plan.ready_for_build === true
  planPath = a.planPath || plan?.plan?.outPath || plan?.artifacts?.plan
}

// ── Persist the EXECUTION-side run config into the project (Claude-format) ──────
// Two consumers, two homes: the MANAGEMENT side (codex-dynamic) owns the plan prose
// at <repo>/.workflow/<slug>/; here we drop a machine-readable job that POINTS at it
// via planPath. Config and plan stay separate — one source of truth, linked, not copied.
// Only when the plan is clean (a real frozen/consensus plan worth recording).
if (planClean && planPath) {
  const execJob = {
    repoPath: a.repoPath, slug, brief: a.brief, mode,
    autoBuild: a.autoBuild === true, commit: a.commit === true, push: a.push === true,
    planPath, generatedBy: 'feature-lifecycle-auto',
  }
  await agent(
    `Under repo ${a.repoPath}, write this JSON to .claude/workflows/${slug}/job.json ` +
    `(mkdir -p the parent dir; overwrite if present), then confirm the written path. ` +
    `Do NOT git add/commit it. JSON:\n${JSON.stringify(execJob, null, 2)}`,
    { label: `write-exec-job:${slug}`, phase: 'Plan', model, effort, isolation, agentType }
  )
  log(`Execution-side job recorded at <repo>/.claude/workflows/${slug}/job.json (planPath → ${planPath})`)
}

// ── Phase 2: GATE — never barge into build on an unfrozen / non-consensus plan ──
phase('Gate')
if (!planClean) {
  log(`Gate: plan stage NOT clean (mode=${mode}) — stopping before build, surfacing to user.`)
  return { stage: 'plan', mode, passed: false, needsUser: true, plan }
}
if (a.autoBuild !== true) {
  log('Gate: plan is clean. autoBuild=false → stopping for human review (commander mode).')
  return { stage: 'plan', mode, passed: true, needsUser: false, builtNext: false, planPath, plan }
}
if (!planPath) return { stage: 'gate', mode, passed: true, needsUser: true, plan, note: 'plan clean but planPath unknown — pass planPath arg to enable autoBuild' }

// ── Phase 3: BUILD — only reached when plan is clean AND autoBuild opted in ─────
// P6 cost guard: don't start an expensive build pass on a near-exhausted token budget.
if (budget?.total && budget.remaining() < 80_000) {
  log(`P6: token budget low (~${Math.round(budget.remaining() / 1000)}k left) — stopping before build to avoid a half-finished expensive pass.`)
  return { stage: 'gate', mode, passed: true, needsUser: true, planPath, plan, note: 'plan clean but token budget too low to start build safely' }
}
phase('Build')
const build = await workflow('spec-implement-dual-review-verify', {
  repoPath: a.repoPath,
  spec: `Implement the frozen plan at ${planPath}. Read it fully first; it is the authoritative spec (codex-frozen / consensus-passed). Follow its file targets, behavior, and verification steps. Truth = source code and real command output, not memory.`,
  targetFile: a.targetFile,
  cli: a.cli, model, effort, isolation, agentType, timeoutSec: a.timeoutSec, slug,   // forward model/effort/isolation/agentType + slug
})
const built = !!build && !build.aborted
return { stage: 'build', mode, passed: built, needsUser: !built, planPath, plan, build }
