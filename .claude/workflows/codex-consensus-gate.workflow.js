// Q2 PRESET SHIM — muscle-memory alias for the renamed consensus-gate (28 historical runs).
// Zero logic: forwards args verbatim. The gate was always CLI-neutral; the codex- prefix was
// branding, and branding is API — hence the rename. See consensus-gate.workflow.js for docs
// and the multi-round push-gate preset.
//
// NESTING WARNING: workflow() nests ONE level only. This shim spends that level, so it is for
// TOP-LEVEL invocation only — other workflows must call 'consensus-gate' directly, never this.
export const meta = {
  name: 'codex-consensus-gate',
  description: 'DEPRECATED alias → consensus-gate (verbatim forward). Top-level use only.',
  whenToUse: 'Only for muscle memory / old notes that say codex-consensus-gate. New callers and all workflow() nesting use consensus-gate directly.',
  phases: [{ title: 'Consult', detail: 'forward to consensus-gate' }],
}
const a = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return {} } })() : (args || {})
log('codex-consensus-gate is a deprecated alias — forwarding to consensus-gate')
return await workflow('consensus-gate', a)
