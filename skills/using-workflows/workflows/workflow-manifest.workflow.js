export const meta = {
  name: 'workflow-manifest',
  description: 'Fleet workflow snapshot: scan every machine\'s recipes + exhaust scripts, classify exhaust via the 5-way decision tree, render the Workflow Manifest HTML',
  whenToUse: 'Periodic (or post-harvest) regeneration of the Workflow Manifest artifact: inventories ~/.claude/workflows and the one-off exhaust under ~/.claude/projects/*/*/workflows/scripts across all machines, diffs them against the hub source of truth, tags every exhaust base name (已內化/preset/泛化候選/doctrine/一次性), and writes a manifest HTML inheriting the Skill Manifest design system. Output is a FILE — the caller publishes it with the Artifact tool (workflow scripts cannot).',
  phases: [
    { title: 'Scan', detail: 'one agent per machine (ssh for remotes): recipes, _lib, agents dir, exhaust base names' },
    { title: 'Classify', detail: 'apply the Q1–Q5 decision tree to each machine\'s exhaust against the hub recipe set' },
    { title: 'Render', detail: 'write the manifest HTML from the template\'s design tokens; sanity-check the file' },
  ],
}

// args:
//   machines     (REQUIRED {name, ssh}[]) fleet to scan. ssh: null for the local hub,
//                'user@host' for remotes (BatchMode key auth assumed). FIRST entry with
//                ssh:null is treated as the hub whose recipe set is the source of truth.
//   templatePath (REQUIRED string) absolute path to an existing manifest HTML whose CSS
//                token system the render must inherit verbatim (sibling-document look).
//   outPath      (REQUIRED string) absolute path to write the new manifest HTML.
//   hubDir       (optional) recipes dir on every machine; default '~/.claude/workflows'.
//   repoNote     (optional string) one line naming the SoT repo/dir shown in the meta row.
//   priorJudgments (optional string) path or inline text of previous classifications —
//                injected so re-runs stay consistent instead of re-litigating settled tags.
//   outputLanguage (optional) default 'Traditional Chinese (Taiwan), code identifiers as-is'.
//
// Publish step (NOT in this recipe — Workflow scripts can't call Artifact):
//   after the run, the main loop calls Artifact({file_path: outPath, favicon: '🧩', url: <existing manifest url>}).

// ── SAFE_LIB (canonical: .claude/workflows/_lib/safe.js — keep byte-identical) ──
const coalesceNull = (arr, fb) => arr.map((r, i) => (r == null ? fb(i) : r))
const nullIndices = (arr) => arr.reduce((a, r, i) => (r == null ? (a.push(i), a) : a), [])
const failClosedRefutes = (votes, total) => { const ok = votes.filter(Boolean); return ok.filter(v => v && v.refuted).length + (total - ok.length) }
// ── /SAFE_LIB ──
void [coalesceNull, failClosedRefutes]

const a = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return {} } })() : (args || {})
if (!Array.isArray(a.machines) || !a.machines.length) throw new Error('workflow-manifest requires args.machines ({name, ssh}[])')
if (typeof a.templatePath !== 'string' || !a.templatePath.trim()) throw new Error('workflow-manifest requires args.templatePath (HTML whose design tokens to inherit)')
if (typeof a.outPath !== 'string' || !a.outPath.trim()) throw new Error('workflow-manifest requires args.outPath')
const MACHINES = a.machines
const HUB = MACHINES.find(m => !m.ssh) || MACHINES[0]
const HUB_DIR = a.hubDir || '~/.claude/workflows'
const OUT_LANG = a.outputLanguage || 'Traditional Chinese (Taiwan), keeping code identifiers/file names as-is'

// The five-way tree is the manifest's contract — embedded so every run judges the same way.
const DECISION_TREE = `Judge each exhaust BASE NAME (strip the -wf_xxxxxxxx suffix; N files of one base = N runs) in this order, cheapest test first. Tags are labels, NEVER deletions.
Q1 已內化 — does its meta.name/description match a saved recipe in the hub set (same pipeline, the recipe IS its generalization)? → tag 已內化, note which recipe covers it.
Q2 preset — is it ≤20 lines, spawns zero agents itself, and just calls workflow() with baked args? → tag preset (a remembered invocation, candidate for a PRESET comment block on the recipe it wraps).
Q3 泛化候選 — do ≥2 base names share an isomorphic pipeline shape not covered by any hub recipe? First re-check coverage: if an existing recipe covers the shape, reclassify 已內化. Otherwise → tag 泛化候選 with the shared shape named.
Q4 doctrine — is the reusable part not the pipeline but repeated discipline TEXT in the agent prompts (anchoring, tool mapping, scope fences, report contracts)? → tag doctrine, name the _lib/worker-doctrine.md block it feeds.
Q5 真一次性 — everything else: project-specific, single-run, not worth abstracting. → tag 一次性.`

const SCAN_SCHEMA = {
  type: 'object',
  required: ['machine', 'recipes', 'exhaust'],
  additionalProperties: false,
  properties: {
    machine: { type: 'string' },
    recipes: { type: 'array', items: { type: 'object', required: ['name', 'lines', 'hash'], additionalProperties: false, properties: { name: { type: 'string' }, lines: { type: 'integer' }, hash: { type: 'string', description: 'first 8 hex of sha256' } } } },
    libFiles: { type: 'array', items: { type: 'string' } },
    agentsFiles: { type: 'array', items: { type: 'object', required: ['name', 'lines', 'hash'], additionalProperties: false, properties: { name: { type: 'string' }, lines: { type: 'integer' }, hash: { type: 'string' } } } },
    exhaust: { type: 'array', items: { type: 'object', required: ['base', 'runs'], additionalProperties: false, properties: { base: { type: 'string' }, runs: { type: 'integer' }, metaDescription: { type: 'string', description: 'meta.description of the newest file, if readable' } } } },
    notes: { type: 'string' },
  },
}

const JUDGE_SCHEMA = {
  type: 'object',
  required: ['machine', 'judgments'],
  additionalProperties: false,
  properties: {
    machine: { type: 'string' },
    judgments: { type: 'array', items: { type: 'object', required: ['base', 'tag', 'reason'], additionalProperties: false, properties: { base: { type: 'string' }, tag: { type: 'string', enum: ['已內化', 'preset', '泛化候選', 'doctrine', '一次性'] }, coveredBy: { type: 'string', description: 'recipe/doctrine block that covers it, if any' }, reason: { type: 'string' } } } },
  },
}

// ── Phase 1: Scan — one agent per machine ───────────────────────────────────────
phase('Scan')
const scanCmd = (m) => {
  const wrap = (c) => m.ssh ? `ssh -o BatchMode=yes -o ConnectTimeout=10 ${m.ssh} '${c}'` : c
  return `Inventory the workflow assets on machine "${m.name}"${m.ssh ? ` via: ${wrap('<cmd>')}` : ' (this machine)'}.
1. Recipes: for each ${HUB_DIR}/*.workflow.js report name, line count, and first 8 hex of its sha256 (shasum -a 256).
2. _lib: list file names under ${HUB_DIR}/_lib/ (empty array if absent).
3. Agents: for each ~/.claude/agents/*.md report name, lines, sha256[0:8] (empty if dir absent/empty).
4. Exhaust: under ~/.claude/projects/*/*/workflows/scripts/*.js, strip the trailing -wf_[a-z0-9-]* suffix to get base names; report each base with its run count. For each base ALSO try to grep the newest file's meta description line (best-effort; omit if unreadable).
Prefer fd/rg; use ls/shasum via ${m.ssh ? 'a SINGLE ssh invocation per logical step (batch with && / one heredoc script) to avoid dozens of round-trips' : 'local shell'}. If the machine is unreachable or a dir is missing, report what you could and say so in notes — do NOT fabricate. Return structured data only.`
}
const scans = await parallel(MACHINES.map(m => () =>
  agent(scanCmd(m), { label: `scan:${m.name}`, phase: 'Scan', schema: SCAN_SCHEMA })
))
const deadScans = nullIndices(scans).map(i => MACHINES[i].name)
const okScans = scans.filter(Boolean)
if (deadScans.length) log(`WARNING: scan failed for [${deadScans.join(', ')}] — those machines are UNSCANNED, not clean`)
if (!okScans.length) return { aborted: true, reason: 'every machine scan failed — nothing to manifest', degraded: { unscanned: deadScans } }
const hubScan = okScans.find(s => s.machine === HUB.name) || okScans[0]
// barrier justified: classification needs the HUB recipe set + render needs ALL machines for the alignment ledger.

// ── Phase 2: Classify — the tree, one judge per scanned machine ─────────────────
phase('Classify')
const recipeCatalog = hubScan.recipes.map(r => r.name).join(', ')
const judgments = await parallel(okScans.map(s => () =>
  s.exhaust.length
    ? agent(
      `${DECISION_TREE}\n\nHub recipe set (source of truth): ${recipeCatalog}.\nRead the hub recipes' meta blocks at ${HUB_DIR}/ (this machine) when a coverage call needs the description, not just the name.${a.priorJudgments ? `\nPrior judgments for consistency (follow unless clearly wrong): ${a.priorJudgments}` : ''}\n\nJudge these exhaust base names from machine "${s.machine}" (runs count in parentheses matters for Q3's ≥2 rule ACROSS names, and high run counts strengthen 已內化 claims):\n${s.exhaust.map(e => `- ${e.base} (${e.runs} runs)${e.metaDescription ? ` — ${e.metaDescription}` : ''}`).join('\n')}\n\nWrite reasons in ${OUT_LANG}. Every base name gets exactly one tag.`,
      { label: `judge:${s.machine}`, phase: 'Classify', schema: JUDGE_SCHEMA }
    )
    : Promise.resolve({ machine: s.machine, judgments: [] })
))
const judged = coalesceNull(judgments, i => ({ machine: okScans[i].machine, judgments: null }))
const unjudged = judged.filter(j => j.judgments === null).map(j => j.machine)
if (unjudged.length) log(`WARNING: classifier died for [${unjudged.join(', ')}] — their exhaust will render UNTAGGED, not hidden`)

// ── Phase 3: Render + sanity check ──────────────────────────────────────────────
phase('Render')
const payload = { generatedFor: MACHINES.map(m => m.name), hub: HUB.name, repoNote: a.repoNote || '', scans: okScans, unscanned: deadScans, judgments: judged, decisionTree: DECISION_TREE }
const rendered = await agent(
  `Render the "Workflow Manifest" HTML.\nDESIGN: Read ${a.templatePath} and inherit its ENTIRE CSS token/component system verbatim (palette vars, light/dark theming incl. data-theme overrides, sheet width, numbered h2, ledger rows, tag chips, copyblock w/ copy button, stamp). This must read as a sibling document — same family, new data. No external resources (strict CSP): inline everything.\nSTRUCTURE (mirror the template's 6-section skeleton): summary head w/ machine badges + recipe-count stamp; meta row (SoT, per-machine recipe counts, exhaust totals); 01 core workflows as cards (hub recipes + _lib, mark any recipe missing from a machine); 02 per-machine alignment ledger (recipe count + hash drift vs hub + agents-file drift); 03 exhaust judgments per machine with color-coded tags (已內化/preset/泛化候選/doctrine/一次性; untagged machines get an "unjudged" warning row); 04 待清理/degraded (unscanned machines, unjudged exhaust, anything the data marks pending); 05 對齊步驟 (concrete rsync/scp commands hub→laggards derived from the diffs); 06 the decision tree full text in a copyblock. Footer: static snapshot, regenerate by re-running the workflow-manifest recipe.\nDATA (embed faithfully, no invention):\n${JSON.stringify(payload)}\n\nWrite the file to ${a.outPath} with the Write tool. Prose in ${OUT_LANG}. Then verify: file exists, contains every machine name and all 6 numbered sections; report byte size. Return a one-line JSON-ish summary: path, bytes, sectionsOk true/false.`,
  { label: 'render-manifest', phase: 'Render', effort: 'high' }
)
if (rendered == null) return { aborted: true, reason: 'render agent died — no manifest written', degraded: { unscanned: deadScans, unjudged }, data: payload }

const totals = Object.fromEntries(judged.filter(j => j.judgments).flatMap(j => j.judgments).reduce((m, x) => m.set(x.tag, (m.get(x.tag) || 0) + 1), new Map()))
log(`manifest rendered: ${a.outPath} | machines ${okScans.length}/${MACHINES.length} | tags ${JSON.stringify(totals)}`)
return {
  outPath: a.outPath,
  render: rendered,
  summary: { machinesScanned: okScans.length, hub: HUB.name, hubRecipes: hubScan.recipes.length, exhaustBases: okScans.reduce((n, s) => n + s.exhaust.length, 0), tagTotals: totals },
  degraded: { unscanned: deadScans, unjudgedMachines: unjudged },
  publishHint: `Artifact({file_path: '${a.outPath}', favicon: '🧩', url: '<existing manifest url to redeploy>'})`,
}
