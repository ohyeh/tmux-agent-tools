// ── FINDINGS_LIB (canonical: .claude/workflows/_lib/findings-schema.js) ──
// Canonical finding/verdict shapes for NEW audit/review recipes. Like safe.js,
// workflow scripts can't import — copy the shape you need and keep it byte-close.
// Existing recipes keep their reviewed schemas; retrofit only through a review gate.
//
// Shape rationale (borrowed from no-mistakes' review step, which ships in production):
//   severity  — how bad for the user/system:      error | warning | info
//   action    — what should happen next:          no-op | auto-fix | ask-user
//               ask-user is RESERVED for findings that challenge the author's INTENT,
//               not routine correctness/reliability/security fixes.
//   risk      — blast radius of acting on it:     low | medium | high (+ rationale)
// severity×action are orthogonal: an `info` can be ask-user (intent question),
// an `error` can be no-op (already fixed upstream).

const FINDING_SHAPE = {
  type: 'object',
  required: ['title', 'severity', 'action', 'location', 'description'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'one-line name of the defect/drift' },
    severity: { type: 'string', enum: ['error', 'warning', 'info'] },
    action: { type: 'string', enum: ['no-op', 'auto-fix', 'ask-user'] },
    location: { type: 'string', description: 'file:line or file' },
    description: { type: 'string', description: 'what is wrong + concrete evidence' },
    risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
    risk_rationale: { type: 'string' },
    fix_hint: { type: 'string', description: 'one line: what change would close it' },
  },
}

// Adversarial-verify verdict for one finding. Fail-closed convention: a dead
// verifier is NOT a pass — count it via failClosedRefutes (safe.js) or surface
// the finding in an `unverified` bucket (never silently drop).
const VERDICT_SHAPE = {
  type: 'object',
  required: ['isReal', 'severity', 'reason'],
  additionalProperties: false,
  properties: {
    isReal: { type: 'boolean', description: 'true only if re-proven against ground truth' },
    severity: { type: 'string', enum: ['error', 'warning', 'info'] },
    reason: { type: 'string', description: 'what was re-checked and why the verdict' },
    fix_hint: { type: 'string' },
  },
}
// ── /FINDINGS_LIB ──

module.exports = { FINDING_SHAPE, VERDICT_SHAPE }
