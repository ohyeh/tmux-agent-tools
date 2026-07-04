// Reusable recipe: audit a repo's docs/ tree against code reality, fix in place,
// then a cross-doc consistency + banned-residue sweep.
// Generalized from the one-off `docs-overhaul` session workflow (standard-portal-app).
// Cross-project: fully parameterized via `args`. No hardcoded paths/facts.
//
// Invoke (canonical — use absolute scriptPath, not name):
//   Workflow({ scriptPath: ".claude/workflows/docs-vs-code-audit.workflow.js", args: {
//     repoPath: "/abs/path/to/repo",
//     groups: [                                  // one read-only auditor + one fixer per group
//       { key: "architecture", scope: "docs/architecture/ (all .md + *.html)" },
//       { key: "ops",          scope: "docs/ops/ (all .md + ops-hub.html)" },
//       { key: "meta",         scope: "docs/README.md, docs/index.html, docs/references/" }
//     ],
//     groundTruth: "Code-verified facts the docs MUST reflect (multi-line). Verify in code before trusting any doc claim.",
//     bannedPatterns: ["yunlin", "docs/work", "date_formatter"],  // optional: rg these in the consistency sweep
//     docsRoot: "docs/",                          // optional, default "docs/"
//     model: "sonnet"                             // optional, default "sonnet"
//   }})
//
// NOTE: workflow scripts have no FS/shell — only agents do. All file work happens inside agent() prompts.

export const meta = {
  name: 'docs-vs-code-audit',
  description: 'Audit docs/ against code reality, fix in place, cross-check consistency (param via args)',
  whenToUse: 'When docs/ may have drifted from the code: per-group read-only audit against code truth, in-place fixes, then a cross-doc consistency/banned-residue sweep. Truth = code, never old docs. Sister of design-vs-code-audit (there the design is the target; here the code is).',
  phases: [
    { title: 'Audit', detail: 'one read-only auditor per docs group', model: 'sonnet' },
    { title: 'Fix', detail: 'same-scope fixers apply audited corrections', model: 'sonnet' },
    { title: 'Consistency', detail: 'cross-doc contradiction + link + banned-residue sweep' },
  ],
}

const a = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return {} } })() : (args || {})
for (const k of ['repoPath', 'groups']) if (!a[k]) return { aborted: true, reason: `missing arg: ${k}` }
if (!Array.isArray(a.groups) || !a.groups.length) return { aborted: true, reason: 'args.groups must be a non-empty array of {key, scope}' }

const repo = a.repoPath
const docsRoot = a.docsRoot || 'docs/'
const model = a.model || 'sonnet'   // listed on every agent() below (never omitted)
const effort = a.effort || 'high'   // reasoning effort — "not shown" must not read as "unsupported"
// Official agent() opts, listed on every call. Both default OFF:
const isolation = a.isolation === 'worktree' ? 'worktree' : undefined  // spec: only 'worktree' enables; off = omit
const agentType = a.agentType || undefined  // off = default workflow agent (portable; missing custom agentType = HARD error #20931)
const groundTruth = a.groundTruth || '(no ground-truth facts supplied — verify every claim directly against the code.)'
const banned = Array.isArray(a.bannedPatterns) ? a.bannedPatterns : []

const CONTEXT = `Repo: ${repo}. Docs live under ${docsRoot}.
Ground truth the docs MUST reflect (verify in code before trusting any doc claim):
${groundTruth}
Verification tools: use rg / Read against the code (lib/, src/, packages/, android/, ios/, config/, scripts/, .github/) to confirm or refute every factual claim you touch.`

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'verdict', 'issues'],
        properties: {
          path: { type: 'string' },
          verdict: { type: 'string', enum: ['clean', 'minor-fixes', 'major-fixes', 'rewrite', 'delete-candidate'] },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              required: ['type', 'detail', 'fix'],
              properties: {
                type: { type: 'string', enum: ['stale-fact', 'broken-link', 'contradiction', 'dead-reference', 'missing-coverage', 'structure', 'wording'] },
                detail: { type: 'string' },
                evidence: { type: 'string' },
                fix: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  required: ['edited', 'skipped', 'summary'],
  properties: {
    edited: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

// ── SAFE_LIB (canonical: .claude/workflows/_lib/safe.js — keep byte-identical) ──
const coalesceNull = (arr, fb) => arr.map((r, i) => (r == null ? fb(i) : r))
const nullIndices = (arr) => arr.reduce((a, r, i) => (r == null ? (a.push(i), a) : a), [])
const failClosedRefutes = (votes, total) => { const ok = votes.filter(Boolean); return ok.filter(v => v && v.refuted).length + (total - ok.length) }
// ── /SAFE_LIB ──

phase('Audit')
const results = await pipeline(
  a.groups,
  (g) => agent(
    `You are a READ-ONLY documentation auditor. Do not edit any file.\n${CONTEXT}\n` +
    `Your scope (audit EVERY file in it): ${g.scope}\n` +
    `For each file: read it fully, then verify every factual claim against the actual code/config using rg and Read. ` +
    `Check: stale facts, broken relative links (target file must exist), references to deleted/renamed files, ` +
    `contradictions with the ground truth above, missing coverage where the doc's topic demands it, ` +
    `and structural problems (duplicated sections, orphan headings). ` +
    `Do NOT report stylistic preferences as issues; 'wording' only for genuinely confusing or wrong statements. ` +
    `Return findings for every file in scope (verdict 'clean' with empty issues when fine).`,
    { label: `audit:${g.key}`, phase: 'Audit', schema: FINDINGS_SCHEMA, model, effort, isolation, agentType }
  ),
  (findings, g) => {
    // Bind the group key into every return path so the final map never relies on
    // post-filter index alignment with a.groups (a dropped/null item would misalign labels).
    // Guard BOTH null paths: a null audit (agent failed) would otherwise throw on
    // findings.files and silently drop the whole group; a null fix would spread to {}
    // and lose edited/skipped/summary. Mark such groups failed instead of swallowing them.
    if (!findings || !Array.isArray(findings.files)) {
      return { group: g.key, edited: [], skipped: [], summary: `${g.key}: AUDIT FAILED (auditor returned null) — not audited, not fixed`, failed: true, findings: null }
    }
    const actionable = findings.files.filter(f => f.issues.length > 0)
    if (actionable.length === 0) return { group: g.key, edited: [], skipped: [], summary: `${g.key}: all clean`, failed: false, findings }
    return agent(
      `You are a documentation fixer with EXCLUSIVE ownership of: ${g.scope}. Other agents own other docs directories — do NOT edit anything outside your scope, and do not touch code.\n${CONTEXT}\n` +
      `Apply these audited findings by editing the files directly. Re-verify each claimed issue against the code before fixing (the auditor may have erred); skip and record any finding you can refute. ` +
      `Keep edits surgical: fix the facts, repair the links, remove dead references. Match each file's existing language and tone. Do not pad, do not add new sections unless a finding says coverage is missing. ` +
      `For 'delete-candidate' verdicts: do NOT delete; note it in your summary instead.\n` +
      `FINDINGS:\n${JSON.stringify(actionable, null, 2)}\n` +
      `Return the list of files you edited, findings you skipped (with reason), and a 2-3 sentence summary.`,
      { label: `fix:${g.key}`, phase: 'Fix', schema: FIX_SCHEMA, model, effort, isolation, agentType }
    ).then(r => r
      ? { ...r, group: g.key, failed: false, findings }
      : { group: g.key, edited: [], skipped: [], summary: `${g.key}: FIX FAILED (fixer returned null) — audited findings NOT applied`, failed: true, findings })
  }
)
// A pipeline stage that THROWS (not just an agent returning null) drops its item to a
// raw null in results. Detect those BY INDEX before filtering, else they vanish from the
// report and `ok` would stay true — the very silent-failure class this guards against.
const droppedGroups = nullIndices(results).map(i => (a.groups[i] && a.groups[i].key) || `group#${i}`)
const failedGroups = [
  ...results.filter(Boolean).filter(r => r.failed).map(r => r.group),
  ...droppedGroups,
]

phase('Consistency')
const bannedClause = banned.length
  ? `3) Banned residue: rg for ${banned.map(b => `'${b}'`).join(', ')} across ${docsRoot}; fix or remove every violation.\n`
  : ''
const failedClause = failedGroups.length
  ? `WARNING: these groups did NOT complete (auditor or fixer failed): ${JSON.stringify(failedGroups)}. Their docs may still be stale — do NOT assume they are clean; re-check those scopes yourself where feasible.\n`
  : 'All groups completed their audit+fix pass.\n'
const consistency = await agent(
  `${CONTEXT}\n${failedClause}You own the FINAL cross-doc pass over the whole ${docsRoot} tree and may edit any file under it.\n` +
  `1) Link integrity: for every relative link in every .md and .html under ${docsRoot}, verify the target exists; fix or remove broken ones.\n` +
  `2) Cross-doc contradictions: the same fact stated differently in two docs — reconcile to the code-verified truth.\n` +
  bannedClause +
  `${banned.length ? '4' : '3'}) Index accuracy: the docs index (README / index.html) accurately lists what exists.\n` +
  `Group summaries from the fixers: ${JSON.stringify(results.filter(Boolean).map(r => r.summary))}\n` +
  `Return a summary of what you changed plus any remaining risks you could not resolve.`,
  { label: 'consistency-sweep', phase: 'Consistency', model, effort, isolation, agentType }
)

return {
  ok: failedGroups.length === 0,
  groups: coalesceNull(results, i => ({ group: (a.groups[i] && a.groups[i].key) || `group#${i}`, summary: 'PIPELINE ERROR (stage threw — group dropped to null)', edited: [], skipped: [], failed: true }))
    .map(r => ({ group: r.group, summary: r.summary, edited: r.edited, skipped: r.skipped, failed: !!r.failed })),
  failed_groups: failedGroups,
  consistency,
}
