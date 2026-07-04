// Reusable recipe: evidence-driven root-cause audit of a symptom across a codebase.
// Fan-out hypotheses -> gather evidence -> adversarially verify -> synthesize report.
// Maturity: WORKING scaffold (generic; tune dimensions per project).
//
//   Workflow({ scriptPath: ".claude/workflows/root-cause-deep-dive-audit.workflow.js", args: {
//     repoPath: "/abs/repo",
//     symptom: "Discord 早晚報 collector 偶發只跑一半",
//     scopeHints: ["lib/collectors", "cron", "logs"],   // optional search seeds
//     hypotheses: 5,                                      // how many candidate root causes to explore (>=1)
//     verifyVotes: 2                                      // adversarial verifiers per surviving hypothesis (>=1)
//   }})
export const meta = {
  name: 'root-cause-deep-dive-audit',
  description: 'Evidence-driven multi-agent root-cause audit; returns ranked causes + report',
  whenToUse: 'When a bug symptom needs a verified root cause rather than a symptom patch: MECE hypothesis fan-out → evidence per hypothesis (file:line) → fail-closed adversarial verification votes → ranked causal chain with minimal fixes. Tune args.hypotheses/verifyVotes to the stakes.',
  phases: [
    { title: 'Hypotheses', detail: 'enumerate candidate root causes', model: 'sonnet' },
    { title: 'Evidence', detail: 'gather evidence per hypothesis', model: 'sonnet' },
    { title: 'Verify', detail: 'adversarially test each surviving hypothesis', model: 'sonnet' },
    { title: 'Synthesize', detail: 'rank + report', model: 'sonnet' },
  ],
}
const a = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return {} } })() : (args || {})
for (const k of ['repoPath', 'symptom']) if (!a[k]) return { aborted: true, reason: `missing arg: ${k}` }
const repo = a.repoPath
// Clamp to >=1: a 0/negative count would make parallel([]) report 0 refutes OR silently drop
// every hypothesis (refutes < ceil(0/2) is never true), turning a degenerate arg into "no root cause".
const N = Math.max(1, a.hypotheses || 5)
const VOTES = Math.max(1, a.verifyVotes || 2)
const hints = (a.scopeHints || []).join(', ')
// Knobs listed EXPLICITLY on every agent() call below (never omitted) so "no model/effort shown"
// can't be misread as "unsupported". Defaults: sonnet / high.
const model = a.model || 'sonnet'
const effort = a.effort || 'high'
// Official agent() opts, listed on every call (none reads as "unsupported"). Both default OFF:
const isolation = a.isolation === 'worktree' ? 'worktree' : undefined  // spec: only 'worktree' enables; off = omit
const agentType = a.agentType || undefined  // off = default workflow agent (portable; a missing custom agentType is a HARD error #20931)

const HYP = { type: 'object', additionalProperties: false, required: ['hypotheses'],
  properties: { hypotheses: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['id', 'claim'], properties: { id: { type: 'string' }, claim: { type: 'string' }, where: { type: 'string' } } } } } }
const EVID = { type: 'object', additionalProperties: false, required: ['id', 'supported', 'evidence'],
  properties: { id: { type: 'string' }, supported: { type: 'boolean' }, evidence: { type: 'string' }, confidence: { type: 'number' } } }
const VERD = { type: 'object', additionalProperties: false, required: ['id', 'refuted'],
  properties: { id: { type: 'string' }, refuted: { type: 'boolean' }, reason: { type: 'string' } } }

const COMMON = `Repo: ${repo}. Symptom under investigation: "${a.symptom}". ${hints ? `Search seeds: ${hints}.` : ''} Use rg/fd and read real code/logs/tests — cite file:line evidence, never speculate. Keep raw dumps out of the final message.`

// ── SAFE_LIB (canonical: .claude/workflows/_lib/safe.js — keep byte-identical) ──
const coalesceNull = (arr, fb) => arr.map((r, i) => (r == null ? fb(i) : r))
const nullIndices = (arr) => arr.reduce((a, r, i) => (r == null ? (a.push(i), a) : a), [])
const failClosedRefutes = (votes, total) => { const ok = votes.filter(Boolean); return ok.filter(v => v && v.refuted).length + (total - ok.length) }
// ── /SAFE_LIB ──

phase('Hypotheses')
const hyp = await agent(
  `${COMMON}
Enumerate up to ${N} DISTINCT candidate root causes (MECE where possible). For each: id (slug), claim (one sentence), where (files/area). Return structured.`,
  { label: 'rca:hypotheses', phase: 'Hypotheses', model, effort, isolation, agentType, schema: HYP })
if (!hyp || !(hyp.hypotheses || []).length) return { aborted: true, stage: 'hypotheses', hyp }

// Evidence per hypothesis, then adversarial verify for the supported ones — pipelined.
const results = await pipeline(
  hyp.hypotheses,
  h => agent(`${COMMON}\nGather concrete evidence for hypothesis ${h.id}: "${h.claim}" (look in: ${h.where || hints}). Set supported true/false with file:line evidence + confidence 0..1.`,
    { label: `rca:evidence:${h.id}`, phase: 'Evidence', model, effort, isolation, agentType, schema: EVID }),
  (ev, h) => {
    // Distinguish a FAILED evidence agent (null) from a genuinely-unsupported hypothesis.
    // A null is "couldn't evaluate" — exclude from survivors but surface it; do NOT silently
    // equate "we couldn't look" with "refuted root cause".
    if (!ev) return { h, ev: null, refutes: VOTES, votes: VOTES, evaluable: false }
    if (!ev.supported) return { h, ev, refutes: VOTES, votes: VOTES, evaluable: true }
    return parallel(Array.from({ length: VOTES }, (_, i) => () =>
        agent(`${COMMON}\nAdversarially try to REFUTE root cause "${h.claim}". Evidence so far: ${ev.evidence}. Default refuted=true if the evidence is weak/circumstantial.`,
          { label: `rca:verify:${h.id}#${i + 1}`, phase: 'Verify', model, effort, isolation, agentType, schema: VERD })))
      .then(vs => {
        // FAIL CLOSED: a verifier thunk that failed returns null (parallel contract). Counting only
        // surviving non-refutes would let a hypothesis pass on absent verification — the worst case
        // being all VOTES verifiers failing → refutes 0 → survives with ZERO real verification.
        // So missing verifiers count AS refutations: no verification ⇒ cannot survive.
        const refutes = failClosedRefutes(vs, VOTES) // missing/null verifiers count AS refutations (fail closed)
        return { h, ev, refutes, votes: VOTES, evaluable: true, verifyIncomplete: vs.filter(Boolean).length < VOTES }
      })
  }
)
const ok = results.filter(Boolean)
const survivors = ok.filter(r => r.evaluable && r.refutes < Math.ceil(r.votes / 2))
const unevaluated = ok.filter(r => r.evaluable === false).map(r => r.h.id)
// Survivors whose verification was partial (some verifiers failed) — passed on fewer real votes than intended.
const verifyIncomplete = survivors.filter(r => r.verifyIncomplete).map(r => r.h.id)

phase('Synthesize')
const report = await agent(
  `${COMMON}
Surviving root-cause candidates (passed adversarial verification): ${JSON.stringify(survivors.map(s => ({ id: s.h.id, claim: s.h.claim, evidence: s.ev.evidence, confidence: s.ev.confidence })))}.
${unevaluated.length ? `NOTE: these hypotheses could NOT be evaluated (evidence agent failed) and are neither confirmed nor refuted: ${JSON.stringify(unevaluated)}.\n` : ''}${verifyIncomplete.length ? `CAUTION: these survivors had INCOMPLETE adversarial verification (some verifier agents failed) — treat their survival as lower-confidence: ${JSON.stringify(verifyIncomplete)}.\n` : ''}Rank by likelihood, explain the causal chain for the top cause, and give the smallest fix that addresses the root (not the symptom). State what remains uncertain.`,
  { label: 'rca:synthesize', phase: 'Synthesize', model, effort, isolation, agentType })
return { symptom: a.symptom, hypotheses: hyp.hypotheses.length, survivors: survivors.map(s => s.h.id), unevaluated, verify_incomplete: verifyIncomplete, report }
