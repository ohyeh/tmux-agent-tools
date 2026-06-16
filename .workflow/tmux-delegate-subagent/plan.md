# tmux-delegate subagent — v1 Implementation Plan

_Revised: 2026-06-17 (post external review). Internal: claude adversarial consensus reached (4 critic passes). External: genuine Codex (gpt-5.5) second-model review obtained via main-thread `codex-tmux` worker `cxrev` — `consensus=false, verified_against_code=true`, 3 blocking issues, all now resolved in this revision (S3 gate, S4/3A-2 effort). Evidence basis: source files read this run; codex independently re-verified current-state claims against code._

> **External review note:** The earlier in-workflow attempt (`codex-extrev-1`) stalled because the codex worker, spawned from inside a nested workflow agent, hit an interactive hook trust dialog it could not answer. Resolved by driving `codex-tmux` directly from the main thread instead — the worker started clean (no trust prompt) and produced a structured verdict. Codex's 3 blocking findings (all in the doctor-json/setup verification cluster): (1) S3's `PATH=/ …` gate is invalid — wiping PATH breaks the script's own shebang and trips `require_tmux` before the CLI check; replaced with explicit-wrapper-path + only-target-CLI-missing assertion; (2) doctor checks must be independent named checks so CLI-missing is tested separately from tmux-missing; (3) `setup` (3A-2) is not thin — no dispatcher branch exists and `doctor_session()` has no arg parser, so it was promoted S→M and split. Core design (thin tmux-delegate subagent, command-primary/subagent-secondary) was NOT contested.

---

## 1. Goal & Success Criteria

**Goal:** Add a thin `tmux-delegate` subagent that gives a Claude Code host session a single decision point — "should I delegate this task to a background tmux worker, or handle it inline?" — without duplicating any runtime logic already in `agent-tmux`/`claude-tmux`/`codex-tmux`.

**Success criteria (all must be true before release):**

| # | Criterion | Verifiable by |
|---|-----------|---------------|
| S1 | `tmux-delegate.md` exists at the path confirmed by OQ-1 resolution, with correct frontmatter schema and delegation decision rules in body | `fd tmux-delegate` in repo |
| S2 | SKILL.md documents the subagent under a new "Auto-delegation" section and Fast paths entry | `rg 'tmux-delegate' skills/tmux-agent-tools/SKILL.md` |
| S3 | `agent-tmux <cli> doctor --json` emits `{"ok":bool,"checks":[{name,ok}...]}` and **exits 1** when any check fails. tmux-missing and CLI-missing must be **independent named checks** — do NOT prove CLI-missing by wiping PATH (it fails on `require_tmux` first, and `PATH=/` breaks the script's own shebang/env). Verified with explicit wrapper path + only the target CLI made missing: `CLAUDE=/definitely/missing skills/tmux-agent-tools/scripts/agent-tmux claude doctor --json >out.json; rc=$?; jq -e '.ok==false and any(.checks[]; .name=="agent_cli_binary" and .ok==false)' out.json; test "$rc" -eq 1` | manual run |
| S4 | `agent-tmux <cli> setup` runs `doctor --json` then `self-test`, exits 0 only when both pass; exits non-zero when binary missing | manual run |
| S5 | Four plugin manifests bumped to `0.19.0` and CHANGELOG updated in huddle private repo before tag | `jq '[.metadata.version,.plugins[0].version] \| unique \| length==1' .claude-plugin/marketplace.json` returns `true`; `jq .version .claude-plugin/plugin.json` == `"0.19.0"` |
| S6 | Secrets/PII scan passes before tag | `gitleaks detect` exits 0 |
| S7 | Substantial-vs-trivial decision criteria are concrete numerical thresholds in subagent body | code review of subagent body |
| S8 | `allowed-tools` whitelist audit: every tool call in subagent body maps to an entry in frontmatter; verified by enumeration checklist (task 3B-3) | review checklist |
| S9 | At least 3 `trigger_eval.json` entries and 1 `evals.json` entry covering the delegation decision path | `rg 'delegate\|tmux-delegate' skills/tmux-agent-tools/evals/` returns matches |

---

## 2. Scope / Non-Goals

**In scope for v1:**

- `tmux-delegate.md` subagent file (frontmatter + body), at the path confirmed by OQ-1 resolution
- `doctor --json` flag addition to `agent-tmux` script (confirmed M-effort refactor — see 3A-1)
- `setup` subcommand (thin alias over `doctor --json` + `self-test`)
- SKILL.md auto-delegation section + Fast paths entry
- Eval entries for delegation decision path (trigger_eval.json + evals.json)
- Four plugin manifest version bumps (`0.18.1 → 0.19.0`) in huddle private repo
- CHANGELOG entry

**Out of scope (v1):**

- `--background` flag on `start`/`resume`: `watch --any` already covers the multi-worker async pattern
- `--resume` support in subagent body: `resume` requires a CLI-internal UUID that `start` never emits (confirmed gap — see Section 3A and OQ-4); deferred to v2
- `huddle`/room cross-machine dispatch: tmux-delegate delegates to local tmux workers only
- Automated CI secrets scan in the _public_ repo: belongs in huddle private repo CI
- Cursor plugin `interface.capabilities` block: v1 bumps version + description string only (OQ-3 unresolved)

---

## 3. Per-Area Work Breakdown

Tasks ordered by dependency. Effort: **S** ≈ <1 hr, **M** ≈ 1–3 hr, **L** ≈ >3 hr.

### 3A. Runtime additions — `agent-tmux` script

Source: `skills/tmux-agent-tools/scripts/agent-tmux` (single-file bash).
Confirmed line ranges (read this run): `doctor_session()` :4233–4259, `start_session()` stdout :2710–2722, `resume_session()` UUID-arg validation :2886–2899.

| # | Task | Effort | Touched files | Depends on |
|---|------|--------|---------------|------------|
| 3A-1 | Add `--json` flag to `doctor` subcommand. **Confirmed code state:** `doctor_session()` (lines 4233–4259) emits ~10 plain-text `echo` lines with no `exit 1` path — CLI binary absence prints a warning string with implicit `return 0`. **Required changes:** restructure all echo statements into JSON check objects `{"name":"...","ok":bool,"detail":"..."}`, aggregate into `{"ok":bool,"checks":[...]}`, add `exit 1` when `ok==false`. **Effort is M** (not S): ~25 echo lines to restructure, exit-code aggregation pattern to add. Zero other behavioural changes. | **M** | `skills/tmux-agent-tools/scripts/agent-tmux` | — |
| 3A-2 | Add `setup` subcommand: runs `doctor --json` then `self-test`; exits 0 only if both pass; prints combined JSON. **NOT thin (codex external review):** no `setup)` branch exists in the dispatcher today, and `doctor_session()` has no arg parser, so `setup` cannot compose `doctor --json` until 3A-1 lands the arg parsing + JSON contract. Split into: (a) add dispatcher + help entries for `setup`; (b) compose the two commands with distinct failure semantics; (c) tests for all-pass, doctor-fail, and self-test-fail. **Hard prerequisite: 3A-1 must ship first.** | **M** | `skills/tmux-agent-tools/scripts/agent-tmux` | **3A-1 (hard gate)** |

**What is NOT changed in v1:** `result --wait --json`, `watch --any`, `status`, `self-test`, `ping`, profiles system, `start` stdout format — all confirmed sufficient as-is. The previously proposed 3A-3 (SESSION_NAME sentinel on `start`) is **removed** — see confirmed gap analysis below.

#### v2 backlog task (out of scope for v1)

| # | Task | Effort | Touched files | Depends on |
|---|------|--------|---------------|------------|
| 3A-V2 | **`--resume` support via `result.json` `cli_session_id` field.** Confirmed new implementation: `result_init()` (line 1625) writes `{schema_version, status, summary, artifacts, errors}` only — `session_id` never written. Required steps: (1) capture CLI UUID after worker session established; (2) write `cli_session_id` into `result.json`; (3) update `result_validate_lightweight()` and result schema; (4) update subagent body to read field via `Bash` (`result --field .cli_session_id`) and pass to `resume`. Not a one-line change. | L | `agent-tmux` (result_init, result_validate, start_session or sentinel path), result schema, SKILL.md, subagent body | v2 planning; hard-blocked on UUID capture design |

#### Confirmed gap: `--resume` UUID vs session name

`start_session()` (line ~2710) emits `"Started $session"` — the tmux session label is on stdout today. **`resume_session()` (lines 2886–2899) does NOT accept a session name for the `--resume` flag; it requires `cli_session_id` as positional arg 3, validated as a UUID regex.** The `start` subcommand never generates or emits a UUID — there is none until the worker CLI itself establishes a session. Therefore:

- **Adding a `SESSION_NAME=` sentinel to `start` stdout does NOT solve the `--resume` problem** — it would only expose what is already on stdout (the tmux session label), not the UUID that `resume` requires.
- The subagent body must not include a `--resume` pattern in v1. This is a confirmed blocker, not an open question.
- **v2 path (new implementation work, not surfacing):** `result.json` is written by `result_init()` (line 1625) with exactly `{schema_version, status, summary, artifacts, errors}` — `session_id` is absent and never written by any current code path. Enabling `--resume` via subagent requires a multi-step schema + runtime change (see task 3A-V2).
- For tmux session reattach (not CLI resume), `tmux attach -t <session>` using the already-available session name is sufficient and requires no code change.

### 3B. Subagent definition file

#### Confirmed path decision

The existing repo uses `skills/tmux-agent-tools/agents/openai.yaml` with schema `{interface: {display_name, short_description, default_prompt}}` — **no triple-dash frontmatter, no `allowed-tools` field** (verified: `cat skills/tmux-agent-tools/agents/openai.yaml`). There is no `subagents/` directory anywhere in the repo and no `.claude/commands/` directory (verified this run).

**The two runtimes use incompatible schemas:**

| Runtime | File format | Schema |
|---------|-------------|--------|
| `agents/` dir (e.g. openai.yaml) | YAML, no frontmatter | `{interface: {display_name, short_description, default_prompt}}` |
| `.claude/commands/` dir | Markdown with YAML frontmatter | `---\ndescription:\nallowed-tools:\n---\n<body>` |

**OQ-1 must be resolved before 3B-2 begins.** Until OQ-1 is resolved:

- The frontmatter design block below applies **only** to `.claude/commands/tmux-delegate.md` and is marked **tentative**.
- If the file ships to `agents/`, it must use the `openai.yaml` schema — `allowed-tools` does not exist in that format.
- Do not assume `subagents/` works; OQ-1's probe task (3B-1) must confirm the discovery mechanism empirically.

**OQ-2 (disable-model-invocation):** design decision taken regardless — do NOT use this flag in v1. The delegation decision (substantial vs trivial) requires LLM reasoning; a dumb relay is inferior to a direct slash command.

| # | Task | Effort | Touched files | Depends on |
|---|------|--------|---------------|------------|
| 3B-1 | Resolve OQ-1: create `.claude/commands/` probe file in huddle private repo, invoke it, confirm discovery mechanism; also check whether `agents/` dir is scanned by Claude Code; determine if `allowed-tools` frontmatter is supported in the discovered path. | S | huddle private repo | — |
| 3B-2 | Author `tmux-delegate.md` (or `.yaml`) using the schema confirmed by OQ-1 resolution; frontmatter and body detail below | S | file path per OQ-1 resolution | **3B-1 (hard gate)**, 3A-1, 3A-2 |
| 3B-3 | **Allowed-tools audit:** enumerate every tool call actually invoked in the subagent body; cross-check against frontmatter whitelist; produce a one-page checklist. Confirm no disallowed tool is needed. Include in PR description before tag. | S | review checklist (doc) | 3B-2 |

**Frontmatter design (TENTATIVE — applies only to `.claude/commands/tmux-delegate.md` format; subject to OQ-1 resolution):**

```yaml
---
description: "Delegation gate: decide whether to delegate a task to a supervised tmux worker or handle it inline. Calls agent-tmux/claude-tmux/codex-tmux via Bash and collects structured result via result --wait --json."
allowed-tools:
  - Bash   # agent-tmux setup/status/watch/result --wait --json, claude-tmux start, codex-tmux start
# disable-model-invocation omitted intentionally — LLM reasoning required for delegation decision
---
```

**Rationale for `allowed-tools` selection:**

- `Bash`: required to invoke `agent-tmux setup`, `claude-tmux start`, `codex-tmux start`, `agent-tmux status`, `agent-tmux watch --any`, `agent-tmux result --wait --json`. All tmux binary access flows through `Bash`.
- `Read`: **NOT required.** Confirmed by code inspection: `result_session()` (line 3533) outputs JSON to stdout when `--json` flag is set; `codex-tmux result --wait --json <name>` streams the full result JSON over stdout. No file read is needed. The subagent collects results via `Bash` stdout capture only. **The previously drafted plan incorrectly cited "SKILL.md line 185" as justification for `Read` — SKILL.md line 185 documents the `result.json` schema fields, not a `Read` tool usage pattern.** `Read` is therefore excluded from `allowed-tools`.
- `Write` / `Edit` / `WebFetch` / `mcp__*`: excluded — workers perform actual work; the subagent only dispatches and collects.
- If future wrappers require additional tools, 3B-3's audit checklist must be re-run.

**Body delegation thresholds (concrete):**

Delegate to tmux worker (substantial) when ANY of:
- Estimated wall time > 30 s
- Task modifies ≥ 2 files
- Task requires independent context window (verbose output, long transcript)
- Task is a multi-step read-plan-write cycle
- Task involves running tests, builds, or lint across the codebase

Handle inline (trivial) — do NOT spawn worker — when:
- Single file read / search / format conversion
- One-liner command with immediate output
- Caller explicitly says "quick" or "inline"
- Marginal / unclear cases (trivial is the safe default)

**Cascade-spawning ban (must appear verbatim in body):**

> Workers you spawn MUST NOT spawn further workers. Include this constraint literally in every worker prompt you send: "Do not spawn additional tmux sessions or delegate further." The subagent must construct worker invocations explicitly (hardcoded command skeleton) — never interpolate the raw task description string directly into the shell command passed to `Bash`. This is the only viable cascade mitigation given the absence of a kernel sandbox.

**`--resume` pattern: NOT included in v1 body.** Subagent must not attempt `--resume`. Confirmed reason: `resume` requires a CLI UUID that `start` never emits. Annotate the body with a comment explaining this gap and pointing to the v2 path (session_id in result.json, task 3A-V2).

### 3C. SKILL.md update

Source: `skills/tmux-agent-tools/SKILL.md` (confirmed present).

| # | Task | Effort | Touched files | Depends on |
|---|------|--------|---------------|------------|
| 3C-1 | Add Fast paths entry: "Want to auto-delegate a substantial task? → call tmux-delegate subagent" | S | `skills/tmux-agent-tools/SKILL.md` | 3B-2 |
| 3C-2 | Add "Auto-delegation via tmux-delegate" section: concrete trigger thresholds (from 3B-2 body), call pattern, cascade ban reference, `--resume` not supported in v1 note | S | same | 3B-2 |
| 3C-3 | Document `doctor --json` and `setup` subcommand in Script capability table | S | same | 3A-1, 3A-2 |
| 3C-4 | Document `status` as the non-blocking query analogue (no code change; discoverability gap only) | S | same | — |

### 3D. Plugin manifests + CHANGELOG

All manifest work executes in the **huddle private repo** (origin). Public repo is a mirror frozen at v0.18.0; do not push to public main.

**Confirmed manifest state (read this run):**
- `.claude-plugin/marketplace.json`: `metadata.version` = `"0.18.1"`, root `.version` = **null** (does not exist), `plugins[0].version` = `"0.18.1"`.
- `.claude-plugin/plugin.json`: `version` = `"0.18.1"`.
- `.codex-plugin/plugin.json`: `version` = `"0.18.1"`, `interface.capabilities` array present.
- `.cursor-plugin/plugin.json`: `version` = `"0.18.1"`, no `interface` block.

| # | Task | Effort | Touched files | Depends on |
|---|------|--------|---------------|------------|
| 3D-1 | CHANGELOG.md: add Unreleased entry for `tmux-delegate` subagent, `doctor --json`, `setup` subcommand | S | `CHANGELOG.md` | 3B-2 finalised |
| 3D-2 | Bump all four manifests to `"0.19.0"`: `.claude-plugin/plugin.json` (`.version`), `.claude-plugin/marketplace.json` (`.metadata.version` AND `.plugins[0].version`), `.codex-plugin/plugin.json` (`.version`), `.cursor-plugin/plugin.json` (`.version`) | S | four manifest files | 3D-1 |
| 3D-3 | Update `.codex-plugin/plugin.json` `interface.capabilities` array: add tmux-delegate delegation entry point | S | `.codex-plugin/plugin.json` | 3B-2 finalised |
| 3D-4 | Update `.claude-plugin/plugin.json` `description` and `.claude-plugin/marketplace.json` `plugins[0].description` to mention tmux-delegate | S | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | 3B-2 finalised |
| 3D-5 | `git tag v0.19.0` on huddle private repo after CI green + secrets scan clean; trigger Formula bump per release checklist | S | git tag, Homebrew formula | 3D-1–3D-4, S6 |

### 3E. Eval coverage

Source: `skills/tmux-agent-tools/evals/evals.json` (8 entries, none mention delegate), `skills/tmux-agent-tools/evals/trigger_eval.json` (20 entries, zero `delegate` matches — verified this run).

| # | Task | Effort | Touched files | Depends on |
|---|------|--------|---------------|------------|
| 3E-1 | Add ≥ 3 entries to `trigger_eval.json` for tmux-delegate auto-delegation trigger decision. Required entries (with `should_trigger` values): (1) `"refactor 5 files across src/ and run the test suite"` → `true`; (2) `"read this file and tell me what the main exported function is called"` → `false`; (3) `"run a multi-step data migration across 3 modules, write a summary when done"` → `true`. Add entries in the same JSON format as existing entries (object with `query` and `should_trigger` keys). | S | `skills/tmux-agent-tools/evals/trigger_eval.json` | 3B-2 finalised (thresholds must be settled) |
| 3E-2 | Add ≥ 1 entry to `evals.json` covering the delegation decision path (object with `id`, `name`, `prompt` keys following existing schema). Example: `"prompt": "My task is to refactor auth/ across 4 files and run all tests. Should I use tmux-delegate or handle this inline? If delegate, show the exact tmux-delegate call."` | S | `skills/tmux-agent-tools/evals/evals.json` | 3B-2 finalised |

**Gate:** Phase 2 completion requires 3E-1 and 3E-2 done. S9 must be verified before Phase 3 begins.

---

## 4. Cross-Cutting Risks & Open Questions

### Risks

| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | **Subagent LLM latency / misclassification**: one inference hop per delegation; trivial misclassified as substantial wastes ~2–5 s + tokens | Medium | Make "trivial" the safe default for marginal cases; use concrete numerical thresholds (30 s, 2 files), not subjective labels |
| R2 | **Cascade spawning via Bash tool**: `allowed-tools: [Bash]` is a Claude-side hint, not a kernel sandbox; crafted prompts could still invoke `claude-tmux start` inside a worker. **No runtime enforcement is possible.** | High | Carry cascade-spawning ban verbatim in subagent body; construct worker calls explicitly with hardcoded command skeleton — never interpolate the raw delegated task string into the Bash invocation |
| R3 | **Secrets leakage through delegate body**: raw credentials in the delegation prompt appear in subagent context — `--secret` redaction only covers `capture`/audit paths | High | Document in subagent body: "Never pass raw credential values in the delegation prompt. Secrets must enter via `--secret KEY=URI` at worker start time only." |
| R4 | **`marketplace.json` version drift**: `.metadata.version` and `.plugins[0].version` must both be bumped; root `.version` does not exist and must NOT be used in gate checks. **Correct gate command:** `jq '[.metadata.version,.plugins[0].version] \| unique \| length==1' .claude-plugin/marketplace.json` must return `true` before tag. | Medium | Use corrected gate in 3D-2; verify manually after bump |
| R5 | **Missing automated secrets scan in CI**: huddle private repo status unknown (OQ-6) | High | Before tagging v0.19.0: run `gitleaks detect` locally; block tag if findings; add CI gate in huddle private repo as follow-up |
| R6 | **doctor exit-code absent — confirmed blocker**: `doctor_session()` (lines 4233–4259) prints CLI-missing as a warning string with implicit exit 0. **3A-1 is a hard prerequisite gate for Phase 1 and Phase 2.** Until 3A-1 ships and S3 is verified, `setup` (3A-2) and the subagent body (3B-2) must not rely on `doctor` exit codes. | High | Treat 3A-1 as Phase 1 entry gate; verify S3 before proceeding to 3A-2 |
| R7 | **`allowed-tools` scope creep**: new wrappers added later silently break subagent dispatch | Low | Add comment in frontmatter: "Update this list when new wrapper scripts are added to scripts/." Run 3B-3 audit before each release. |
| R8 | **`start` stdout format change risk**: `start_session()` already emits 7+ lines to stdout (lines 2710–2722); adding any new sentinel line before existing lines would break callers that parse stdout positionally. v1 adds no sentinel — 3A-3 is removed. | Low | Document constraint in code comment at the stdout block in `start_session()` |
| R9 | **Schema mismatch between `agents/` and `.claude/commands/`**: if OQ-1 resolves to `agents/`, the `allowed-tools` frontmatter field has no effect (the `openai.yaml` schema does not support it). The subagent's tool-use constraints would then be unenforced at the runtime level. | High | OQ-1 probe (3B-1) must determine which path provides `allowed-tools` enforcement. If only `.claude/commands/` supports it, ship there; do not try to fit the `openai.yaml` schema with frontmatter extensions. |

### Open Questions

| ID | Question | Resolution path | Blocks |
|----|----------|-----------------|--------|
| OQ-1 | Does Claude Code scan `agents/` subdirs within a skill, `subagents/` dirs, or only `.claude/commands/`? Existing repo uses `agents/` (confirmed: `skills/tmux-agent-tools/agents/openai.yaml` with `{interface: {display_name, short_description, default_prompt}}` schema). No `subagents/` dir exists. No `.claude/commands/` dir exists. **Critical sub-question:** does `.claude/commands/` format support `allowed-tools` frontmatter? If discovery path is `agents/`, `allowed-tools` has no schema field there. | **Add explicit probe task (3B-1):** create `.claude/commands/` probe file in huddle private repo, invoke it, confirm discovery and `allowed-tools` enforcement. Also test `agents/` dir scanning. | 3B-1, 3B-2 (hard gate) |
| OQ-2 | Does Claude Code frontmatter support `disable-model-invocation: true` at the version in use? | Claude Code release notes | 3B-2 (v1 decision: do not use regardless) |
| OQ-3 | Does Cursor plugin runtime parse `interface.capabilities` if added to `.cursor-plugin/plugin.json`? | Cursor plugin documentation | 3D (v1 decision: skip for cursor) |
| OQ-4 | **Confirmed gap (not just open question):** `resume` requires a CLI-internal UUID (arg 3, UUID-regex validated at line 2886–2899) that `start` never emits. Session name from `"Started $session"` (already on stdout, line 2710) is for tmux attach only, not for `claude --resume`. v1 drops `--resume` from subagent body entirely. v2 path is new implementation work (see task 3A-V2). | No code action in v1. Document in subagent body. | v2 planning |
| OQ-5 | **Resolved by code read:** `doctor_session()` does not exit non-zero when CLI binary missing — confirmed (lines 4233–4259). Classified as R6. 3A-1 is the fix. | — (closed; feeds 3A-1 sizing as M) | 3A-1 |
| OQ-6 | Does the huddle private repo have an automated secrets/PII scan in CI? | Check huddle private `.github/workflows/` | R5 mitigation; Phase 3 cannot close until answered |

---

## 5. Suggested Phased Implementation Sequence

### Phase 0 — Resolve blockers (no code)

1. **Answer OQ-1** (3B-1): create `.claude/commands/` probe file in huddle private repo; confirm discovery mechanism; confirm whether `allowed-tools` is enforced in that format; decide `agents/` vs `.claude/commands/` file path. **(Hard blocks 3B-2.)** (S)
2. **Verify huddle private repo current manifest versions** == `"0.18.1"` in all four files before bumping. (S)
3. **Answer OQ-6**: check huddle private `.github/workflows/` for secrets scan. **(Hard blocks Phase 3 tag.)** (S)

### Phase 1 — Runtime hardening (parallel with Phase 0 OQ resolution)

Execute 3A-1 (`doctor --json`, M-effort) → 3A-2 (`setup` subcommand, **M-effort** after 3A-1 — see codex note in §3A).

**Gate:** Verify S3 via the explicit-wrapper-path command in the S3 row (CLI made missing while tmux stays available, asserting the `agent_cli_binary` check is `ok:false` and rc==1) before starting 3A-2. Verify S4 before proceeding to Phase 2.

Note: Phase 1 is **independent of OQ-1 resolution** and can proceed concurrently.

### Phase 2 — Subagent file + SKILL.md + evals

**Hard-blocked on OQ-1 resolution (3B-1).** Once OQ-1 is resolved:

Execute 3B-2 (`tmux-delegate.md`) using the OQ-1-confirmed path and schema, then 3B-3 (allowed-tools audit checklist), then 3C-1 through 3C-4 (SKILL.md updates), then 3E-1 and 3E-2 (eval entries).

Validate S1, S2, S7, S8, S9. Internal review: cascade-ban language, secrets-handling note, concrete thresholds, `--resume` not-supported annotation, `Read` tool absent from body, all present.

### Phase 3 — Manifests + CHANGELOG + release gate

**Hard-blocked on Phase 2 complete AND OQ-6 resolved.** All work in huddle private repo.

Execute 3D-1 → 3D-2 → 3D-3 → 3D-4. Run corrected `marketplace.json` gate:

```sh
jq '[.metadata.version,.plugins[0].version] | unique | length==1' .claude-plugin/marketplace.json
```

Must return `true`. Run secrets scan (R5). CI green → 3D-5 (tag `v0.19.0`) → Formula bump.

### Dependency graph

```
Phase 0 (parallel tracks):
  OQ-1 probe (3B-1) ──────────────────────────────────► [resolves schema + path for 3B-2]
  OQ-6 check ─────────────────────────────────────────► [resolves CI gate for tag]
  Manifest audit ──────────────────────────────────────► [confirms 0.18.1 baseline]
  │
  └─ Phase 1 (can start immediately, no OQ dependency):
       3A-1 (doctor --json, M) ──► [verify S3] ──► 3A-2 (setup, M) ──► [verify S4]
            │
            ▼
  Phase 2 (hard-blocked on OQ-1 + Phase 1 complete):
       3B-2 (tmux-delegate file, OQ-1-schema) ──► 3B-3 (tools audit)
       ──► 3C-1/3C-2/3C-3/3C-4 ──► 3E-1/3E-2 (evals)
            │
            ▼
  Phase 3 (hard-blocked on Phase 2 + OQ-6 resolved):
       3D-1 (CHANGELOG) ──► 3D-2 (bumps) ──► 3D-3/3D-4 (descriptions)
       ──► marketplace gate ──► secrets scan ──► 3D-5 (tag v0.19.0 ──► Formula bump)
```

### Effort summary

| Phase | Tasks | Effort |
|-------|-------|--------|
| Phase 0 | OQ resolution + audit | 3 × S |
| Phase 1 | 3A-1 + 3A-2 | M + M |
| Phase 2 | 3B-1 + 3B-2 + 3B-3 + 3C-1–3C-4 + 3E-1 + 3E-2 | 9 × S |
| Phase 3 | 3D-1–3D-5 + gates | 5 × S |

**Total:** 1 M + 17 S. Core path (Phases 0–2) is completable in one focused session after OQ-1 resolves. Phase 3 requires huddle private repo access and CI green.
