---
name: using-workflows
description: Meta-router for the closed-loop workflow recipes (audits, consensus gates, plan/build pipelines, findings triage, fleet manifest). Invoke BEFORE picking a workflow whenever the user describes a situation like "docs drifted", "weird bug", "plan this feature", "review this design", "fix this pile of findings", or asks which workflow/recipe to use. It routes the situation to the right recipe, auto-fills args, chains the closed loop, and optionally co-fires with codex-dynamic-workflows (if installed) for run artifacts (.workflow/<slug>/). Even a 1% chance this applies means invoke it.
---

# using-workflows

Meta-router for the workflow recipes living in `~/.claude/workflows/` (personal
layer, usable from ANY repo) and/or the current repo's `.claude/workflows/`.
You are not a recipe yourself — you pick **which** recipe the situation needs,
fill its args, run it, and keep the closed loop moving.

## The Rule

1. **Discover live, never recite from memory.** The installed recipe set changes;
   list what actually exists right now:

   ```bash
   for f in ~/.claude/workflows/*.workflow.js .claude/workflows/*.workflow.js; do
     [ -f "$f" ] && node -e '
       const s=require("fs").readFileSync(process.argv[1],"utf8");
       const m=s.match(/export const meta = \{[\s\S]*?\n\}/);
       const g=k=>(m&&m[0].match(new RegExp(k+":\\s*'\''([^'\'']*)"))||[])[1]||"";
       console.log(process.argv[1].split("/").pop()+"\t"+g("name")+"\t"+g("description"))
     ' "$f"
   done
   ```

   Project layer shadows personal layer on name collisions. Before running a
   candidate, **read its header comment** — that comment block is the args
   contract; never guess args.

2. **Route by situation**, using the decision tree below as the prior — but the
   live `description`/`whenToUse` fields win if they disagree (recipes evolve).

3. **After it returns, chain the loop** (see "Closed loop" below) instead of
   stopping at raw output.

## Decision tree — situation → recipe

```
What is the user actually facing?
│
├─ "X 跟 code 對不上 / 漂移了"                → docs-vs-code-audit | design-vs-code-audit
├─ 詭異 bug、要挖根因                          → root-cause-deep-dive-audit
├─ audit 剛回一堆 confirmed findings          → findings-triage      (接頭① — offer this AUTOMATICALLY)
├─ 有 brief（迷你 PRD），想全自動做到好         → feature-lifecycle-auto
├─ 只要凍結規劃文件，刻意不建置                 → plan-pipeline
├─ 需求 → 實作計畫（監督式雙關共識）            → feature-plan-consensus
├─ 一個設計方案要對抗共識                       → design-consensus
├─ 任意產物要過「第二模型同意」這一關            → consensus-gate       (codex-consensus-gate = 舊名 shim，僅限頂層)
├─ 照 spec 建置＋雙模型 review＋驗證            → spec-implement-dual-review-verify
├─ 「這專案下一步做什麼」                       → project-direction-review
├─ 盤點/快照整個 recipe 艦隊、查三台漂移         → workflow-manifest
│
└─ 只是「一個有邊界的任務丟後台」——不是多階段控制流
    → NOT a workflow. Defer to the using-tmux-agent-tools skill
      (tmux-delegate gate → claude-oneshot / codex-oneshot).
```

## Auto-fill args (the lazy part)

Fill these WITHOUT asking when derivable; ask only what's genuinely the user's call:

- `cli` (REQUIRED by every adversarial-review recipe; no default by design):
  take, in order — the user's words → the repo's `CLAUDE.md` stated preference →
  ask once ("codex? claude-fable-gate-glm? agy?"). Valid values = any
  `~/.config/agent-tmux/profiles` name; verify with `ls` if unsure.
- `context`: compose yourself — one line with the repo abs path + stack +
  anything the user just said about scope. Quality of findings tracks this line.
- `repoPath` / paths: current repo unless told otherwise.
- `outputLanguage`: leave default (Traditional Chinese) unless asked.
- Prefer **name invocation** over `scriptPath`: some environments drop `args`
  on scriptPath runs (symptom: `aborted: missing arg`). If stuck with
  scriptPath, temporarily fill the recipe's `BUILTIN = {}` and revert after.

## Closed loop — what to do after each recipe returns

```
audit → confirmed findings?
  ├─ yes → run findings-triage on them (don't make the user hand-sort)
  │        ├─ askUser[]   → surface to the human verbatim; NEVER auto-decide intent
  │        ├─ briefs[]    → one feature-lifecycle-auto call per brief (plan gate pauses for the human ✋)
  │        └─ directFix[] → one partitioned fix run (disjoint files, SKIP+report on missing assets)
  └─ after fixes/build → re-run the ORIGINATING audit with the SAME args (接頭②)
         confirmed == 0  → loop converged; report and stop
         confirmed  > 0  → back to findings-triage
```

Hard limits while chaining:

- **workflow() nesting cap = 1 level.** Chain recipes from the TOP level
  (you, the main loop), never from inside another recipe. The
  `codex-consensus-gate` shim spends that single level — top-level only.
- Behavior-tier edits to any recipe require a `consensus-gate` pass FIRST;
  wording/docs edits go direct (canonical copy in `~/.claude/workflows/`,
  then cp into the tmux-agent-tools repo — never the reverse).

## Run discipline — optional add-on: `codex-dynamic-workflows`

**This router works standalone** — recipes need nothing beyond
`~/.claude/workflows/`. But IF the `codex-dynamic-workflows` skill is
installed (check the available-skills list; do NOT assume), co-fire it: **this
skill picks the recipe; that one governs the run record.** For any non-trivial
recipe run (anything past a one-shot audit you'll discard), follow its
conventions in the TARGET repo simultaneously:

- Anchor the run in `.workflow/<slug>/` — recipes already lean this way
  (`plan-pipeline` defaults `directionPath`/`planPath` there). Keep
  `plan.md` human-readable, `state.json` for status/approval/verification
  state, `final-report.md` for the integrated outcome.
- Its operating contract applies verbatim: restate goal + success criteria
  before invoking; artifact before delegating; approval before risky/external
  steps; **integrate results — never paste raw recipe output as the answer**;
  verify with checks matched to blast radius.
- Note the directory split (a classic confusion): `.workflow/` = run
  artifacts (that skill's convention, NOT discovered by Claude Code);
  `.claude/workflows/` = the recipes themselves (discovered, `/name`-callable).
- Multi-recipe chains (audit → triage → lifecycle → re-audit) = one slug, one
  `.workflow/<slug>/` dir; each recipe's return value lands in `results/`,
  loop convergence (接頭② confirmed==0) goes in `final-report.md`.

## Canonical references (never paraphrase these from memory)

- Per-recipe reference + args details: `.claude/workflows/README.md`
  (tmux-agent-tools repo).
- Tutorial (scenarios, onboarding a new repo, feedback loop):
  `docs/workflow-usage-guide.md` (same repo).
- Worker mechanics (agent-tmux/profiles/send-wait): the `tmux-agent-tools`
  skill — defer to it for anything about driving the second-model CLI.
- Run-record conventions (`.workflow/<slug>/`, goal mode, packets): the
  `codex-dynamic-workflows` skill — optional add-on; defer to it for run
  discipline only when it's installed.
