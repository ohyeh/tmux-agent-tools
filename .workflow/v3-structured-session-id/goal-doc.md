# v3 — Structured `cli_session_id` Capture — goal doc

_Authored 2026-06-20 by the planning teammate (codex gpt-5.5, high effort, session `v1ship`) as the
next-increment proposal after v0.20.0 shipped. Brain (Claude) framed the brief and recorded the decision.
This is a goal doc / plan_task seed, not yet a frozen implementation plan._

## 1. Goal

Make `cli_session_id` capture prefer a structured transcript/JSONL source over tmux pane scraping, while
keeping pane scraping as an opt-in fallback.

Highest-value next step: v0.20.0 proved the resume contract but deliberately left it default-off — the
remaining blocker is trust in the ID source. A structured source is the prerequisite that can later unlock
default resume for specific CLIs, and gives huddle/cross-machine dispatch a real session-identity contract
instead of brittle pane text.

## 2. Success Criteria

- `start` still seeds `session-meta.json` with `cli_session_id: null`.
- When a supported transcript/JSONL source contains a deterministic session UUID, the sidecar is updated
  with that UUID without reading tmux pane text.
- Extraction accepts only RFC-4122 UUIDs from an explicit per-CLI structured field or label-matched event —
  never the first random UUID in a blob.
- No supported structured source → safe: `cli_session_id` stays `null`, no UUID synthesized, `resume`
  unavailable.
- Pane scraping stays default-off, only when `session_id_pattern` opt-in is configured.
- `result --field .cli_session_id <name>` still works when `result.json` is absent.
- `scripts/test-session-meta-smoke` gains fixtures: structured-source success, malformed rejection, decoy
  rejection, no-source fallback, pane fallback.
- `ci-shellcheck`, `zsh -n agent-tmux`, help smoke pass.
- SKILL.md, `.claude/agents/tmux-delegate.md`, profile docs, CHANGELOG describe precedence: structured
  source first, opt-in pane fallback second, no default resume until a CLI-specific source is verified.

## 3. Scope / Non-goals

In scope: one small extractor for session IDs from local wrapper-owned transcript/JSONL artifacts; keep
sidecar schema `{schema_version:1, cli_session_id:null|string}`; fixture/fake-artifact tests (no real
network run); document source precedence + failure behavior.

Non-goals: do NOT enable resume by default for Claude/Codex this increment; no huddle cross-machine
dispatch yet; no transcript-storage redesign; no daemon/new supervisor/new dependency; don't change
`resume_session()` beyond consuming the same validated UUID; Cursor OQ-3 stays a separate metadata cleanup.

## 4. Risks + Mitigations

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Transcript shape not deterministic across CLI versions | A false default makes resume unsafe | Phase S is an inventory gate; if no deterministic field/label, stop with docs/tests, stay default-off |
| Sensitive UUID leaks into logs/result | `cli_session_id` is a resume capability | Write only to sidecar; keep redacted display; grep-test that result output never prints malformed/non-requested IDs |
| Extractor accepts decoy UUIDs | Same bug class v2 guarded for panes | Require exact source path + field/label match before extraction; decoy fixture tests |
| Race: start / transcript creation / field reads | Resume window is post-start, pre-result | Preserve null seed; best-effort atomic extractor; field read non-zero until UUID available |
| Scope creep into default enablement | Default-on needs real per-CLI proof | Default enablement is an explicit later L-phase gate, not this increment |

## 5. Phased Breakdown

### S — Source Inventory Gate (S)
Identify wrapper-owned transcript/JSONL artifacts created during `start` and whether they can hold CLI
session IDs; capture 2–3 static fixtures; decide canonical source order (1: structured extractor, 2: opt-in
pane capture via `session_id_pattern`, 3: leave null).
Hard gates: source must be wrapper-owned + local (not arbitrary user output); must identify an explicit
field/label boundary before extracting; if no deterministic source for any CLI, STOP here and write the
"no default enablement" conclusion — do not implement a looser heuristic.

### M — Minimal Extractor + Tests (M)
Add a helper near the session-meta functions (e.g. `session_id_extract_from_structured_source <path>
<pattern-or-field>`); run structured extraction before pane capture in the post-start path; extend
`test-session-meta-smoke` (valid writes / malformed rejected / decoy ignored / absent→null / pane fallback
when configured); update SKILL.md, subagent, profile README, CHANGELOG.
Hard gates: S-phase contract accepted; no new dependency (jq only); atomic write unchanged; tests run
without starting real Claude/Codex.

### L — Per-CLI Default Enablement Decision (L, separate follow-up)
Per CLI: collect verified transcript evidence across supported versions; if stable, set bundled profile
default for that CLI's structured source; add an integration smoke proving `start → sidecar UUID → resume`
via a fake CLI fixture before any real run.
Hard gates: M shipped + stable; ≥2 independent version samples show the same deterministic source; security
review agrees the UUID is not logged/surfaced except via explicit `result --field .cli_session_id`.

## 6. Runner-up (rejected for now)

Huddle cross-machine dispatch inside `tmux-delegate`. Loses because it depends on a trustworthy session
identity + dispatch-result contract; building cross-machine delegation while resume identity is still
pane-derived multiplies failure modes (local tmux, remote room state, credentials, resume IDs all coupled).
Do v3 structured capture first; huddle dispatch becomes smaller and less speculative afterward.

## Next action

Promote this goal doc to a frozen implementation plan via the planning pipeline (Phase S inventory first —
it is a hard gate that can legitimately halt the increment at docs-only if no deterministic source exists).

## Phase-S Outcome (2026-06-21) — STOP / docs-only

Phase-S inventory was run (codex research worker `v3-research`, full findings in `research-findings.md`).
The gate halted as a docs-only outcome.

Verdict: **STOP the default M-phase extractor.** No wrapper-owned local artifact created during `start`
contains a deterministic RFC-4122 session UUID in an explicit per-CLI field or label-matched event, for
either bundled `claude` or `codex`:

- `session-meta.json` `.cli_session_id` is the destination/read surface, not a source (seeded `null` by
  `result init`; `agent-tmux:1753-1768`).
- `usage.jsonl` start content is only `usage_init` metadata — no session-id field (`agent-tmux:1971-1994`).
- Optional `--transcript` / audit events carry wrapper metadata (`session` = tmux session name), not a CLI
  internal session UUID (`agent-tmux:2861-2869`, `2166-2183`).
- Both bundled profiles ship `session_id_pattern` UNSET; the only documented near-structured source is
  opt-in pane capture, which is pane text, not JSONL (`profiles/claude.conf:9-14`, `profiles/codex.conf:9-14`).

Canonical source order is recorded (structured extractor → opt-in pane capture → leave null) but source 1
stays empty for bundled claude/codex until a real structured source is proven.

Open scope boundary (future L-phase, NOT this increment): the gate's "wrapper-owned + local" rule
deliberately excluded **CLI-owned** transcripts the CLIs write themselves — Claude Code's
`~/.claude/projects/<proj>/<uuid>.jsonl` and Codex's `~/.codex/sessions/` both contain real session UUIDs.
Reopening v3 means deciding whether a CLI-owned (not wrapper-owned) artifact is an acceptable source and
proving its field semantics are stable across ≥2 versions. That is the L-phase gate, not a heuristic
shortcut to take now.

Status: this increment ships no code. The goal doc + findings are the deliverable.

## Phase-S REOPENED → conditional GO (2026-06-21, brain×codex design round)

The STOP above was correct under its own "wrapper-owned only" source definition. A follow-up evidence pass
(brain + codex `v3-design`, two-round design discussion — full design in `design-proposal.md`) reopened the
gate by **widening the source definition to CLI-owned local transcripts, strictly correlated**. The safety
bar is unchanged; only source ownership widened. Verdict: **GO**, with two proven mechanisms only
(`supplied` + `transcript`) across three proven CLIs, and everything default-off until the L gate.

Verified facts (with evidence):
- Claude exposes `claude --session-id <uuid>` at creation → the wrapper can SUPPLY the id (race-free, known
  pre-launch). Confirmed via `claude --help`.
- Codex has NO creation-time id flag; it self-generates a UUIDv7 written to
  `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, first record `type:"session_meta"` with
  `payload.id == filename uuid` and `payload.cwd`. Only transcript correlation is possible.
- Investigated 80 local codex transcripts: no wrapper-controlled token lands in `session_meta.payload`, so
  same-cwd concurrency genuinely bottoms out at null-on-ambiguity (with an observable signal, never silent).

Agreed design (supersedes the STOP for these CLIs):

| CLI | Mechanism | `session_id_capture` | Notes |
| --- | --- | --- | --- |
| claude | wrapper supplies UUID via `--session-id`, sidecar written **synchronously before launch** | `supplied` | no background capturer, no pane fallback, no transcript scan (dead code, deleted) |
| codex | correlate Codex-owned transcript after start (snapshot → newest-new + `payload.id`/`cwd` equality) | `transcript` | null-on-ambiguity + observable bail signal |
| agy | correlate agy-owned store after start (read `~/.gemini/antigravity-cli/cache/last_conversations.json[cwd]` → cross-check `conversations/<uuid>.db` exists + mtime after launch) | `transcript` | **source found** (brain follow-up); resume via `--conversation <uuid>`; null-on-ambiguity, default-off until live resume confirmed |
| cursor/grok | none proven | `off` | binary unavailable locally; stay default-off |

Key design decisions (resolved in discussion):
1. **One writer per session via mutual exclusion, not locks**: if `session_id_capture != off`, the
   structured/supplied path is the only writer; the legacy pane capturer (`session_id_pattern`) is spawned
   ONLY when `session_id_capture=off`. Eliminates the two-writer TOCTOU race by construction.
2. **New profile key `session_id_capture=off|supplied|transcript`** (mechanism-only; per-CLI transcript
   mechanics live in a small internal table, not user-facing enum values; never inferred from
   `heuristic_family`).
3. **Unified Phase 1 with #268**: add #268 keys (`exec_mode`/`prompt_via`/`prompt_flag`) and `session_id_capture`
   in ONE profile-key round (they don't collide), then land two independent `start_session` concerns —
   execution-mode (#268, owns `result.json`) and session-id capture (v3, owns `session-meta.json`) — without
   coupling their outputs.
4. Default-off through P1–P4; default-on is the later L gate (≥2 version samples per CLI + tested ambiguity).

Phases: P1 unified profile-key surface → P2 Claude supplied-id → P3 Codex transcript correlation →
P4 #268 oneshot behavior → L per-CLI default enablement. Hard gates per phase in `design-proposal.md`.

Status: **ready to implement, jointly with #268** (shared P1). No remaining design disagreement.
