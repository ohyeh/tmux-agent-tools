// Canonical silent-failure guards for dynamic-workflow recipes (.claude/workflows/*.workflow.js).
//
// Runtime constraint: workflow scripts are SELF-CONTAINED — the Workflow tool eval's an inline
// script with injected globals (agent/parallel/pipeline/...) and NO module import. So recipes
// cannot `import` from here. Instead each recipe inlines the SAFE_LIB block below VERBATIM; this
// file is the single source of truth + the review target. When a helper changes, edit this block
// and re-sync every inline copy: `grep -rl SAFE_LIB .claude/workflows`.
//
// Why these exist: agent() returns null on failure, parallel() yields a null entry for a failed
// thunk, and a pipeline stage that throws drops its item to a raw null. Downstream filter(Boolean)
// / {...r} then SILENTLY swallow the failure while the run still looks complete. These helpers make
// every failure surface (by index) instead of vanishing. See .claude/memory/lessons.md L1.

// ── SAFE_LIB (canonical: .claude/workflows/_lib/safe.js — keep byte-identical) ──
const coalesceNull = (arr, fb) => arr.map((r, i) => (r == null ? fb(i) : r))
const nullIndices = (arr) => arr.reduce((a, r, i) => (r == null ? (a.push(i), a) : a), [])
const failClosedRefutes = (votes, total) => { const ok = votes.filter(Boolean); return ok.filter(v => v && v.refuted).length + (total - ok.length) }
// ── /SAFE_LIB ──

// Reference so `node --check`/linters don't flag unused (this file is a canonical copy, not imported).
void [coalesceNull, nullIndices, failClosedRefutes]
