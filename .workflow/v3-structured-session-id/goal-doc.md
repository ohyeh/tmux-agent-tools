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
