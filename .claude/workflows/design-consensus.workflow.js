export const meta = {
  name: 'design-consensus',
  description: 'N independent design proposals from distinct angles, cross-adversarial critique, judge-synthesized consensus design spec',
  whenToUse: 'When a design/UX/architecture decision has a wide solution space and one-attempt-iterated would anchor too early. Pass the full context+constraints via args.context; optionally override args.angles.',
  phases: [
    { title: 'Propose', detail: 'independent designers pitch one design each from a distinct angle' },
    { title: 'Cross-attack', detail: 'each proposal attacked by the rival camps' },
    { title: 'Synthesize', detail: 'judge merges the strongest surviving ideas into one consensus design' },
  ],
}

// args:
//   context   (REQUIRED string) project background + task + numbered hard constraints +
//             expected output form ("a WRITTEN DESIGN, not code" etc). Everything
//             domain-specific lives here — the workflow itself is domain-agnostic.
//   angles    (optional string[]) one proposal per angle; default 3 generic angles.
//   outputLanguage (optional string) language for the final synthesis; default 繁體中文，台灣用語.
//   synthesisSpec  (optional string) extra requirements for the final spec's structure.
//
// Example:
//   Workflow({ scriptPath: ".../design-consensus.workflow.js", args: {
//     context: "Project: ... Task: redesign the homepage ... Constraints: 1. ... 2. ...",
//     angles: ["MVP-first: ...", "Evidence-first: ...", "Newsroom-desk: ..."],
//   }})

// ── SAFE_LIB (canonical: .claude/workflows/_lib/safe.js — keep byte-identical) ──
const coalesceNull = (arr, fb) => arr.map((r, i) => (r == null ? fb(i) : r))
const nullIndices = (arr) => arr.reduce((a, r, i) => (r == null ? (a.push(i), a) : a), [])
const failClosedRefutes = (votes, total) => { const ok = votes.filter(Boolean); return ok.filter(v => v && v.refuted).length + (total - ok.length) }
// ── /SAFE_LIB ──
void [coalesceNull, failClosedRefutes]

const a = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return {} } })() : (args || {})
if (typeof a.context !== 'string' || !a.context.trim()) {
  throw new Error('design-consensus requires args.context (project background + task + constraints)')
}
const CONTEXT = a.context
const ANGLES = (Array.isArray(a.angles) && a.angles.length >= 2) ? a.angles : [
  'MVP-first: ruthlessly minimal — optimize for the single most common use case; everything else is a secondary click/step away',
  'Power-first: optimize for depth, trust and the expert user — foreground evidence, detail and control; the casual path is a compressed view of the same structure',
  'Fresh-metaphor: reorganize around one strong real-world metaphor (news desk, control room, dashboard, catalog...) so both casual and deep usage feel native to the same layout',
]
const OUTPUT_LANG = a.outputLanguage || 'Traditional Chinese (繁體中文，台灣用語), keeping code identifiers/technical terms in English'
const SYNTH_SPEC = a.synthesisSpec || 'information architecture, how the primary use modes work, the key structural calls (with reasoning), visual/interaction direction, and an explicit list of what was rejected and why'

const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    codename: { type: 'string' },
    core_idea: { type: 'string', description: 'one-paragraph thesis for this design' },
    structure: { type: 'string', description: 'information architecture / module breakdown of the design' },
    key_decisions: { type: 'string', description: 'the concrete opinionated calls this design makes, and why' },
    user_experience: { type: 'string', description: 'how the primary use case(s) actually flow through this design' },
    visual_direction: { type: 'string', description: 'visual / interaction / stylistic direction (if applicable; else the implementation shape)' },
    tradeoffs: { type: 'string', description: 'honest weaknesses of this approach' },
  },
  required: ['codename', 'core_idea', 'structure', 'key_decisions', 'user_experience', 'visual_direction', 'tradeoffs'],
}

const ATTACK_SCHEMA = {
  type: 'object',
  properties: {
    target_codename: { type: 'string' },
    strongest_attacks: { type: 'string', description: '3-5 concrete ways this design fails real usage' },
    what_survives: { type: 'string', description: 'what part of this design is genuinely good and should survive even if the rest dies' },
  },
  required: ['target_codename', 'strongest_attacks', 'what_survives'],
}

phase('Propose')
const rawProposals = await parallel(ANGLES.map((angle, i) => () =>
  agent(`${CONTEXT}\n\nYour design angle: ${angle}\n\nPropose ONE design from this angle. Be concrete and opinionated — this is a pitch, not a survey of options. Give it a short codename.`,
    { label: `propose-${i}`, phase: 'Propose', schema: PROPOSAL_SCHEMA })
))
const deadProposers = nullIndices(rawProposals)
if (deadProposers.length) log(`Propose: ${deadProposers.length}/${ANGLES.length} proposers failed (angles ${deadProposers.join(', ')}) — continuing with survivors`)
const proposals = rawProposals.filter(Boolean)
if (proposals.length < 2) throw new Error(`design-consensus: only ${proposals.length} proposal(s) survived — consensus needs at least 2`)

phase('Cross-attack')
const rawAttacks = await parallel(proposals.map((target, i) => () => {
  const attackers = proposals.filter((_, j) => j !== i)
  return agent(
    `${CONTEXT}\n\nYou are reviewing a rival design proposal adversarially — your job is to find its real weaknesses, not to be polite.\n\nThe proposal to attack (codename: ${target.codename}):\n${JSON.stringify(target, null, 2)}\n\nYour own camp's competing designs for context (do not attack these, just use them to sharpen your critique):\n${JSON.stringify(attackers, null, 2)}\n\nGive your strongest, most concrete attacks — cite specific real usage scenarios where this design fails. Also name what part of it is genuinely good and should survive synthesis even if you don't like the rest.`,
    { label: `attack-${target.codename}`, phase: 'Cross-attack', schema: ATTACK_SCHEMA }
  )
}))
const deadAttacks = nullIndices(rawAttacks)
if (deadAttacks.length) log(`Cross-attack: ${deadAttacks.length}/${proposals.length} attackers failed — those proposals go to synthesis UNATTACKED (flagged)`)
const attacks = rawAttacks.map((a, i) => a || { target_codename: proposals[i].codename, strongest_attacks: '(attacker failed — this proposal was NOT adversarially reviewed; treat its weaknesses as unknown, not absent)', what_survives: '(unreviewed)' })

phase('Synthesize')
const synthesis = await agent(
  `${CONTEXT}\n\n${proposals.length} competing design proposals went through adversarial cross-review. Your job: synthesize ONE consensus design that a reasonable operator would actually ship — grafting the strongest surviving ideas from each proposal and explicitly discarding what got killed in the attacks. Do not just average them; make real calls. If an attack entry says a proposal was NOT adversarially reviewed, weigh that proposal more skeptically.\n\nProposals:\n${JSON.stringify(proposals, null, 2)}\n\nAdversarial attacks on each:\n${JSON.stringify(attacks, null, 2)}\n\nWrite the final consensus design as a clear spec covering: ${SYNTH_SPEC}. Write in ${OUTPUT_LANG}. Be thorough but not padded.`,
  { label: 'synthesis', phase: 'Synthesize' }
)
if (synthesis == null) throw new Error('design-consensus: synthesis agent failed — no consensus produced (do not treat proposals alone as a result)')

return { proposals, attacks, synthesis, degraded: { failedProposerAngles: deadProposers, unattackedProposals: deadAttacks.map(i => proposals[i].codename) } }
