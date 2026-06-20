// Reusable recipe: turn a NEW-FEATURE brief into a first-version implementation PLAN,
// run as a SUPERVISED agent orchestration with an escalation ladder and a hard
// evidence/correctness doctrine, gated by two consensus loops before commit.
//
//   Step 0 Orchestrate  -> establish the operating contract (doctrine below)
//   Decompose -> Discover(parallel read-only) -> Synthesize(v1 draft)
//     -> InternalConsensus   (claude critics, adversarial, loop-until-consensus)    <- internal loop
//     -> ExternalReview        (codex second-model, adversarial, loop-until-consensus) <- external loop
//     -> Commit                (write plan; commit/push ONLY when consensus + approved)
//
// ───────────────────────── OPERATING DOCTRINE (Step 0) ─────────────────────────
// ORCHESTRATION: the workflow runtime ("you", the orchestrator brain) delegates each task to a
//   worker, MONITORS the result, and corrects course. Workers are not trusted blindly.
// ESCALATION LADDER (try cheapest capable tier first; climb on repeated failure):
//   sonnet worker  ->  orchestrator self  ->  codex (second model)  ->  surface to USER
//   Authority/trust ranking (high→low):  USER > CODEX >= ORCHESTRATOR(self) > sonnet/others.
//   If codex (the top automated tier) still cannot satisfy the monitor, DO NOT force-proceed —
//   return needsUser:true and stop short of any commit.
// CORRECTNESS (non-negotiable): truth = source code, logs, and real command output observed THIS run.
//   Memory, existing .md/.html docs, comments, and prior plans are NOT truth — they may be stale;
//   use them only as leads to verify against code. Unverifiable claims become OPEN QUESTIONS, never assertions.
// ───────────────────────────────────────────────────────────────────────────────
//
// Pairs with the `codex-dynamic-workflows` skill: produces a `.workflow/<slug>/` artifact,
// uses disjoint discovery packets, and gates git operations behind explicit args (approval rule).
//
// Invoke (canonical — absolute scriptPath, not name):
//   Workflow({ scriptPath: "~/Desktop/workflows/recipes/feature-plan-consensus.workflow.js", args: {
//     repoPath:   "/abs/path/to/repo",
//     featureBrief: "What the new feature is + goals + product decisions/links (multi-line).",
//     slug:       "coin-wallet-rename",          // .workflow/<slug>/ dir (default 'feature-plan')
//     designRefs: "Figma node-ids / URLs / decisions (optional)",
//     areas:      [{ key, scope }],               // optional: skip auto-decompose
//     maxInternalRounds: 3, maxExternalRounds: 2, // optional
//     sonnetTries: 2, selfTries: 1,               // optional: per-task escalation budget
//     escalateToCodex: true,                      // optional, default true
//     commit:     false, push: false,             // optional: git gate (= the human approval)
//     model:      "sonnet"                        // optional, default worker model
//   }})
//
// NOTE: workflow scripts have no FS/shell — only agents do. All reads, writes, git happen in agent() prompts.

export const meta = {
  name: 'feature-plan-consensus',
  description: 'Supervised orchestration: new-feature brief -> v1 plan via escalation ladder + evidence doctrine + internal/codex consensus, then gated commit',
  phases: [
    { title: 'Orchestrate', detail: 'Step 0: establish supervision doctrine + escalation ladder' },
    { title: 'Decompose', detail: 'split the feature into disjoint discovery areas', model: 'sonnet' },
    { title: 'Discover', detail: 'parallel read-only Explore per area (code/logs are truth)' },
    { title: 'Synthesize', detail: 'merge findings into a v1 plan draft', model: 'sonnet' },
    { title: 'InternalConsensus', detail: 'adversarial claude critics, revise until consensus', model: 'sonnet' },
    { title: 'ExternalReview', detail: 'codex second-model adversarial review, revise until consensus' },
    { title: 'Commit', detail: 'write plan; commit/push only when consensus + approved' },
  ],
}

// NESTING: this is a mid-level stage — do NOT call workflow() here (1-level nesting cap). Drive the
// second model via inline agent() + agent-tmux, never via workflow() or a harness agent type.
const a = args || {}
for (const k of ['repoPath', 'featureBrief']) if (!a[k]) return { aborted: true, reason: `missing arg: ${k}` }

const repo = a.repoPath
const model = a.model || 'sonnet'   // listed on every agent() below (escalation rungs override per-tier)
const effort = a.effort || 'high'   // harness agents' reasoning effort (codexEffort below drives codex itself)
const slug = a.slug || 'feature-plan'
if (!/^[a-zA-Z0-9._-]+$/.test(slug) || slug.includes('..')) return { aborted: true, reason: `invalid slug '${slug}' (alnum/._- only, no path traversal)` }
const outDir = `${repo}/.workflow/${slug}`
const planPath = `${outDir}/plan.md`
const maxInternal = Number.isInteger(a.maxInternalRounds) ? a.maxInternalRounds : 3
const maxExternal = Number.isInteger(a.maxExternalRounds) ? a.maxExternalRounds : 2
const sonnetTries = Number.isInteger(a.sonnetTries) ? a.sonnetTries : 2
const selfTries = Number.isInteger(a.selfTries) ? a.selfTries : 1
const escalateToCodex = a.escalateToCodex !== false
const lenses = Array.isArray(a.internalLenses) && a.internalLenses.length
  ? a.internalLenses
  : ['completeness (missing areas/tasks/edge cases)', 'sequencing & dependencies', 'risk & blast-radius', 'effort realism']
const designRefs = a.designRefs ? `\nDesign refs / decisions (LEADS to verify, not truth):\n${a.designRefs}` : ''

// codex second-model reviewer is driven via tmux-agent-tools (agent-tmux codex), NOT a harness
// agentType. The openai-codex plugin (codex:codex-rescue) is deprecated/disabled in settings;
// agent-tmux works regardless of plugin enablement and across repos. Mirrors plan-pipeline /
// codex-consensus-gate: completion is detected by POLLING an OUT file, never the tmux pane.
const cli = a.cli === 'claude' ? 'claude' : 'codex'   // second-model CLI: codex (default) | claude
const codexEffort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(a.effort) ? a.effort : 'high'  // enum — emitted into a shell env assignment
const codexTimeout = Number.isInteger(a.timeoutSec) ? a.timeoutSec : 900
const codexSession = `fpc-${cli}-${slug}`
const REVIEW_MARKER = '=== SECOND-MODEL REVIEW END ==='
// codex takes --yolo + reasoning-effort; claude's profile already supplies its own launch flags.
const launchEnv = cli === 'codex' ? `CODEX_TMUX_LAUNCH_FLAGS='--yolo -c model_reasoning_effort=${codexEffort}' ` : ''
// POSIX-safe single-quote: wraps in '...' and renders embedded ' as '\'' so any repo path is safe.
const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
const driveCodex = (taskForCodex, outHint) =>
  `Get a genuine SECOND-MODEL (${cli}) verdict by driving a ${cli} session via tmux-agent-tools — do NOT use any harness agent type. ` +
  `If agent-tmux/${cli}-tmux are not on PATH, run them from the tmux-agent-tools skill bundle scripts/ dir.\n` +
  `1. Pick a unique OUT file (${outHint}); instruct ${cli} to WRITE its full response to OUT, ending the file with a final line exactly: ${REVIEW_MARKER}\n` +
  `2. Start/reuse: ${launchEnv}agent-tmux ${cli} start --exact ${codexSession} ${shellQuote(repo)} "review task incoming; read fully before replying".\n` +
  `3. Send via file: write the task below to a temp file, then agent-tmux ${cli} send --from-file <file> --enter-count 1 ${codexSession}.\n` +
  `4. Wait by POLLING OUT (NOT the tmux pane — the marker echoes in the sent prompt), up to ${codexTimeout}s, until OUT exists AND contains "${REVIEW_MARKER}". Then read OUT.\n` +
  `Base your answer STRICTLY on ${cli}'s OUT content (you are a conduit, not the reviewer). Keep raw tmux scrollback out.\n\nTASK FOR ${cli.toUpperCase()}:\n${taskForCodex}`

// Step 0 — the doctrine, injected into every worker/reviewer prompt.
const EVIDENCE = `CORRECTNESS DOCTRINE (non-negotiable): truth = source code, logs, and real command output you observe THIS run. ` +
  `Do NOT trust memory, existing .md/.html docs, code comments, or prior plans as fact — they may be stale; treat them only as leads to verify against code with rg/fd/Read (and logs/real runs where relevant). ` +
  `If you cannot verify a claim in code/logs, label it an OPEN QUESTION — never assert it.`

const CONTEXT = `Repo: ${repo}.\n${EVIDENCE}\n\nNEW FEATURE BRIEF (a goal to plan toward; verify all "current state" against code):\n${a.featureBrief}${designRefs}`

phase('Orchestrate')
log(`Step 0 doctrine active — ladder: sonnet→self→codex→user (budget: sonnet x${sonnetTries}, self x${selfTries}, codex ${escalateToCodex ? 'on' : 'off'}); truth = code/logs only.`)
if (!a.orchestratorModel) log(`note: orchestratorModel unset — the "self" rung inherits the main-loop model; it is a real capability step above sonnet only if the main loop runs a model above sonnet (else it is a same-model retry).`)

// ───────────────────────── escalation ladder ─────────────────────────
// Delegate a task; MONITOR via verify(); on rejection, climb the ladder, feeding the
// monitor's correction into the next attempt. Returns {result, tier, attempt, ok, needsUser}.
async function runEscalated(label, phaseName, makePrompt, opts = {}) {
  const { schema, verify } = opts
  const rungs = [
    ...Array(sonnetTries).fill({ tier: 'sonnet', model: 'sonnet' }),
    ...Array(selfTries).fill({ tier: 'self', model: a.orchestratorModel }), // undefined -> inherit main-loop (you)
  ]
  if (escalateToCodex) rungs.push({ tier: 'codex', driveCodex: true })
  let feedback = ''
  let last = null
  for (let i = 0; i < rungs.length; i++) {
    const r = rungs[i]
    const o = { label: `${label}:${r.tier}#${i + 1}`, phase: phaseName, effort }
    if (schema) o.schema = schema
    if (r.model) o.model = r.model   // per-tier model (sonnet / self / codex-driven) — intentionally varies
    const p = makePrompt(feedback, r.tier)
    const res = await agent(r.driveCodex ? driveCodex(p, `/tmp/codex-${label.replace(/[^a-zA-Z0-9._-]/g, '_')}-${i + 1}.md`) : p, o)
    const v = verify ? await verify(res) : { ok: res != null, feedback: 'empty result' }
    if (v.ok) { log(`${label}: accepted via ${r.tier} (attempt ${i + 1})`); return { result: res, tier: r.tier, attempt: i + 1, ok: true, needsUser: false } }
    last = res
    feedback = `MONITOR REJECTED the previous attempt (tier=${r.tier}): ${v.feedback}\nCorrect course and fix exactly this; do not drift.`
    log(`${label}: ${r.tier} attempt ${i + 1} rejected — ${v.feedback}`)
  }
  log(`${label}: escalation exhausted (codex could not satisfy monitor) — surfacing to user.`)
  return { result: last, tier: 'exhausted', attempt: rungs.length, ok: false, needsUser: true }
}
// P5 quality gate: enforce PLAN_SECTIONS as SECTION LINES (markdown headings / numbered / bold lead),
// not loose body keywords — a plan that merely mentions the words in prose must NOT pass. Paired
// concepts are checked CONJUNCTIVELY (Goal AND success, Scope AND non-goals, Risks AND open-questions).
const sectionLines = (md) => md.split('\n').filter(l => /^\s{0,3}(#{1,6}\s|\d+[.)]\s|\*\*)/.test(l)).join('\n')
const REQUIRED_SECTIONS = [
  { name: 'Goal & success criteria', ok: h => /goal/i.test(h) && /success/i.test(h) },
  { name: 'Scope / non-goals', ok: h => /scope/i.test(h) && /non-?goal/i.test(h) },
  { name: 'Work breakdown (tasks/effort/files)', ok: h => /breakdown|work|task/i.test(h) },
  { name: 'Risks & open questions', ok: h => /risk/i.test(h) && /open question/i.test(h) },
  { name: 'Phased implementation sequence', ok: h => /sequence|phase/i.test(h) },
]
const planOk = (res) => {
  if (typeof res !== 'string' || res.trim().length < 300)
    return { ok: false, feedback: 'plan must be substantial markdown (>=300 chars), grounded in code (not docs).' }
  const h = sectionLines(res)
  const missing = REQUIRED_SECTIONS.filter(s => !s.ok(h)).map(s => s.name)
  if (missing.length)
    return { ok: false, feedback: `plan missing required SECTION(s) (must be markdown headings/numbered, with paired concepts together): ${missing.join('; ')}.` }
  return { ok: true }
}

// ───────────────────────── schemas ─────────────────────────
const DECOMPOSE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['areas'],
  properties: { areas: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['key', 'scope'],
    properties: { key: { type: 'string' }, scope: { type: 'string' }, rationale: { type: 'string' } },
  } } },
}
const DISCOVERY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['area', 'existing', 'gaps', 'risks'],
  properties: {
    area: { type: 'string' },
    existing: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['item', 'files', 'status'],
      properties: { item: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['done', 'partial', 'stub', 'missing'] } },
    } },
    gaps: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['task', 'effort'],
      properties: { task: { type: 'string' }, effort: { type: 'string', enum: ['S', 'M', 'L'] }, depends_on: { type: 'string' } },
    } },
    risks: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' }, description: 'claims that could NOT be verified in code/logs' },
  },
}
const CRITIQUE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['consensus', 'verified_against_code', 'blocking_issues'],
  properties: {
    consensus: { type: 'boolean' },
    verified_against_code: { type: 'boolean', description: 'MUST be true: you actually checked the plan claims with rg/Read/logs this pass. If you did not verify, set false (and consensus cannot be trusted).' },
    blocking_issues: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['issue', 'evidence', 'fix'],
      properties: { issue: { type: 'string' }, area: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, evidence: { type: 'string', description: 'REQUIRED: file:line or log excerpt proving the issue (no code evidence = not a valid issue)' }, fix: { type: 'string' } },
    } },
    notes: { type: 'string' },
  },
}
const PLAN_SECTIONS = `Sections: (1) Goal & success criteria, (2) Scope / non-goals, (3) Per-area work breakdown — ordered tasks with effort (S/M/L), touched files, dependencies, (4) Cross-cutting risks & OPEN QUESTIONS, (5) Suggested phased implementation sequence. Every "existing" claim must cite real files; unverifiable items go under Open Questions.`

// ───────────────────────── 1. Decompose ─────────────────────────
phase('Decompose')
let areas = Array.isArray(a.areas) && a.areas.length ? a.areas : null
if (!areas) {
  const dec = await runEscalated('decompose', 'Decompose',
    (fb) => `${CONTEXT}\nScope this feature for parallel discovery. Read the repo's real entry points / route table / module layout (read-only, verify in code) and split into 3-6 DISJOINT, non-overlapping work-areas. Return key + scope (+ rationale).\n${fb}`,
    { schema: DECOMPOSE_SCHEMA, verify: (r) => (r && (r.areas || []).length >= 2) ? { ok: true } : { ok: false, feedback: 'need >=2 disjoint areas grounded in the real module layout.' } }
  )
  if (!dec.ok) return { aborted: true, stage: 'decompose', needsUser: true, dec }
  areas = dec.result.areas
}
log(`areas: ${areas.map(x => x.key).join(', ')}`)

// ───────────────────────── 2. Discover (parallel, read-only) ─────────────────────────
phase('Discover')
async function discoverArea(area) {
  return runEscalated(`discover:${area.key}`, 'Discover',
    (fb) => `READ-ONLY discovery (do NOT edit; use rg/fd/Read on actual code, and logs if relevant).\n${CONTEXT}\n` +
      `Your area: ${area.key} — ${area.scope}\n` +
      `Map from CODE (not docs): existing (item, files, status), gaps (task, effort, depends_on), risks, and open_questions for anything unverifiable. Return the schema.\n${fb}`,
    { schema: DISCOVERY_SCHEMA, verify: (r) => {
      if (!r || !r.area) return { ok: false, feedback: 'missing result — re-probe this area in code.' }
      const ex = r.existing || [], gp = r.gaps || [], oq = r.open_questions || []
      // EVERY claimed "existing" item MUST cite at least one non-empty real file path — no fileless/empty-path claims.
      if (ex.length && !ex.every(e => (e.files || []).some(f => typeof f === 'string' && f.trim().length))) return { ok: false, feedback: 'EVERY "existing" item must cite at least one non-empty real file path found via rg/Read; fileless or empty-path existing claims are ungrounded — fix each, or move it to open_questions.' }
      // greenfield is allowed: existing may be empty as long as gaps or open_questions explain the work/unknowns.
      if (ex.length || gp.length || oq.length) return { ok: true }
      return { ok: false, feedback: 'all sections empty — actually probe the code (rg/fd/Read) and report existing/gaps, or list explicit open_questions for what you could not verify.' }
    } }
  ).then(x => x.ok ? x.result : null)
}
const findings = (await parallel(areas.map(area => () => discoverArea(area)))).filter(Boolean)
if (!findings.length) return { aborted: true, stage: 'discover', needsUser: true }

// ───────────────────────── 3. Synthesize v1 draft ─────────────────────────
phase('Synthesize')
const synth = await runEscalated('synthesize', 'Synthesize',
  (fb) => `${CONTEXT}\nSynthesize the discovery findings into a FIRST-VERSION implementation plan. ${PLAN_SECTIONS}\n` +
    `Write it to ${planPath} (mkdir -p ${outDir}) AND return the full markdown.\n${fb}\nFINDINGS:\n${JSON.stringify(findings, null, 2)}`,
  { verify: planOk }
)
if (!synth.ok) return { aborted: true, stage: 'synthesize', needsUser: true, synth }
let plan = synth.result

// ───────────────────────── 4. Internal consensus loop ─────────────────────────
phase('InternalConsensus')
let internalRound = 0, internalConsensus = false
while (internalRound < maxInternal) {
  internalRound++
  const critiques = (await parallel(lenses.map(lens => () =>
    agent(
      `${CONTEXT}\nAdversarially critique this v1 plan through ONE lens: ${lens}. ` +
      `VERIFY each "current state" claim against the actual code (rg/Read) — flag any claim that rests on docs/memory rather than code. Set verified_against_code honestly. ` +
      `Be skeptical; default consensus=false if you find a blocker. Each issue needs concrete evidence (file:line / log) and a fix. Skip nitpicks.\n\nPLAN:\n${plan}`,
      { label: `critic:${String(lens).split(' ')[0]}#${internalRound}`, phase: 'InternalConsensus', model, effort, schema: CRITIQUE_SCHEMA }
    )
  ))).filter(Boolean)
  if (!critiques.length) return { aborted: true, stage: 'internal-critics', needsUser: true, round: internalRound } // all critics died -> can't trust convergence
  const blocking = critiques.flatMap(c => (c.blocking_issues || []).filter(i => i.severity !== 'minor'))
  if (critiques.every(c => c.consensus && c.verified_against_code === true) && blocking.length === 0) {
    internalConsensus = true; log(`internal consensus in round ${internalRound}`); break
  }
  log(`internal round ${internalRound}: ${blocking.length} blocking -> revise`)
  const rev = await runEscalated(`revise-internal#${internalRound}`, 'InternalConsensus',
    (fb) => `${CONTEXT}\nRevise the plan to resolve these critic issues; RE-VERIFY each asserted fact in code. Keep structure (${PLAN_SECTIONS}). Overwrite ${planPath}, return full markdown.\n${fb}\nISSUES:\n${JSON.stringify(blocking, null, 2)}\n\nCURRENT PLAN:\n${plan}`,
    { verify: planOk }
  )
  if (!rev.ok) return { aborted: true, stage: 'internal-revise', needsUser: true, round: internalRound }
  plan = rev.result
}

// ───────────────────────── 5. External (codex) review loop ─────────────────────────
phase('ExternalReview')
let externalRound = 0, externalConsensus = false
while (externalRound < maxExternal) {
  externalRound++
  const review = await agent(
    driveCodex(
      `Act as a second-model adversarial reviewer for an implementation PLAN. Repo: ${repo}.\n${EVIDENCE}\n` +
      `INDEPENDENTLY verify the plan's "current state" claims with rg/Read and logs/real runs — do not take the plan's or any doc's word for it. Then judge completeness, sequencing, effort realism, and unverified assumptions. ` +
      `Set verified_against_code + default consensus=false unless genuinely sound. Each issue needs evidence (file:line/log) + fix.\n\nPLAN:\n${plan}`,
      `/tmp/codex-extreview-${slug}-${externalRound}.md`
    ),
    { label: `codex-review#${externalRound}`, phase: 'ExternalReview', model, effort, schema: CRITIQUE_SCHEMA }
  )
  if (!review) return { aborted: true, stage: 'external-review', needsUser: true, round: externalRound } // codex (top automated tier) died -> escalate to user
  const blocking = (review.blocking_issues || []).filter(i => i.severity !== 'minor')
  if (review.consensus && review.verified_against_code === true && blocking.length === 0) {
    externalConsensus = true; log(`external consensus in round ${externalRound}`); break
  }
  log(`external round ${externalRound}: ${blocking.length} blocking -> revise`)
  const rev = await runEscalated(`revise-external#${externalRound}`, 'ExternalReview',
    (fb) => `${CONTEXT}\nCodex raised these issues; resolve each and RE-VERIFY facts in code/logs. Keep structure. Overwrite ${planPath}, return full markdown.\n${fb}\nISSUES:\n${JSON.stringify(blocking, null, 2)}\n\nCURRENT PLAN:\n${plan}`,
    { verify: planOk }
  )
  if (!rev.ok) return { aborted: true, stage: 'external-revise', needsUser: true, round: externalRound }
  plan = rev.result
}

// ───────────────────────── 6. Commit (consensus + approval gated) ─────────────────────────
phase('Commit')
const bothConsensus = internalConsensus && externalConsensus
const wantCommit = a.commit === true && bothConsensus
const wantPush = wantCommit && a.push === true
const COMMIT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['written', 'committed', 'pushed'],
  properties: {
    written: { type: 'boolean', description: 'plan.md + final-report.md actually written' },
    committed: { type: 'boolean' }, pushed: { type: 'boolean' },
    sha: { type: 'string' }, staged_files: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
  },
}
const commit = await agent(
  `${CONTEXT}\nFinalize the plan artifact in ${outDir}.\n` +
  `1) Ensure final plan markdown is at ${planPath} (mkdir -p ${outDir}); write ${outDir}/final-report.md noting internal consensus=${internalConsensus} (rounds ${internalRound}), external consensus=${externalConsensus} (rounds ${externalRound}).\n` +
  (wantCommit
    ? `2) APPROVED: git add ONLY the artifacts under ${outDir} (verify with 'git status --porcelain' that nothing outside ${outDir} is staged; if anything else is staged, unstage it). Commit "docs(plan): ${slug} v1 implementation plan (internal+codex consensus)". ${wantPush ? 'Then push current branch.' : 'Do NOT push.'} Report the staged_files list and commit sha.`
    : `2) Do NOT git add/commit/push — ${bothConsensus ? 'commit not approved (args.commit!=true)' : 'consensus NOT reached; needs user decision'}. Just confirm files written (committed=false, pushed=false).`) +
  `\nReturn the schema honestly (committed/pushed reflect what you actually did).`,
  { label: 'commit-plan', phase: 'Commit', model, effort, schema: COMMIT_SCHEMA }
)
// commit agent died -> we have no trustworthy write/commit result; do not silently report false. Surface to user.
if (!commit) return { aborted: true, stage: 'commit', needsUser: true, planPath, internal: { consensus: internalConsensus, rounds: internalRound }, external: { consensus: externalConsensus, rounds: externalRound } }

return {
  planPath,
  areas: areas.map(x => x.key),
  internal: { consensus: internalConsensus, rounds: internalRound },
  external: { consensus: externalConsensus, rounds: externalRound },
  needsUser: !bothConsensus,
  approved: wantCommit,
  committed: commit?.committed === true,
  pushed: commit?.pushed === true,
  commit,
}
