# Issue Batch Plan — #216–#228 (one efficient pass)

Source: all 13 issues originate from one real TradingView supervision session.
Strategy decided with operator: **2 PRs** (PR-1 code = waves W1–W4; PR-2 docs = wave W5).
Breaking change: **#227 flips `wait-text` to literal-by-default** (hard switch, new `--regex`).

## Architectural facts driving the plan

- `claude-tmux` (~4390 lines) and `codex-tmux` (~4353 lines) are **parallel twins**, no
  shared lib. They are mostly brand-swap (`CLAUDE↔CODEX`) but — per Codex review, after
  normalizing branding there remain real non-branding differences — so treat "twins" as a
  **risk to manage, not a fact to exploit**: every wrapper subcommand change = one logical
  edit applied to BOTH files + brand swap + `zsh -n` + smoke, plus a parity smoke to catch drift.
- Existing infra to extend, not rebuild: result validation (`claude-tmux:1292-1356`),
  `result --json` present/valid/errors, `schemas/`, `tmux-agent-sessions` list/cleanup/watch,
  `wait-text`/`wait-literal`/`send-wait-literal`, `wait-and-capture --marker`.
- Tests: bash smoke scripts in `scripts/test-*-smoke`, wired into `.github/workflows/ci.yml`.
- Docs: `skills/tmux-agent-tools/SKILL.md` + `references/{cheatsheets,contracts,multi-agent,security}.md`.

## Issue clusters (MECE) by shared code surface

| Cluster | Issues | Files | Essence |
|---|---|---|---|
| A. Marker/wait reliability | #227 #223 #221 | both wrappers + docs | kill echo/stale silent mismatch |
| B. Result contract | #218 #224 #220 | both wrappers + schemas/ | verdict + decision blocks + validate subcommands |
| C. Session lifecycle | #216 #222 | tmux-agent-sessions | resolve/adopt + accidental-session cleanup |
| D. New runtime capability | #219 #225 | new tmux-agent-monitor + wrappers | monitor mode + human-in-loop wait |
| E. Docs / discoverability | #226 #228 #217 (+#221) | SKILL.md + references/ | capability table, peer-review recipe, listen-before-send |

## Dependency order

- #223 nonce + #224 verdict  → enable #228 peer-review recipe (composes both)
- #227 + #223 settled        → then write #221 marker-pitfalls docs
- #216 resolve               → #217 listen-before-send starts with resolve
- #218 validate              → referenced by #217/#228 ("validate before complete")
- #220 decision + #224 verdict → ONE result-schema revision (avoid 2 migrations)
=> A, B, C are foundation; D semi-independent; E last (docs reference final command names).

## Execution waves (commit boundaries inside PR-1, except W5)

### PR-1 (code) — commit per wave

- **W1 Marker core** (#227, #223)
  - `wait-text`: literal-by-default; add `--regex` to opt into zsh extended regex. BREAKING.
  - new `send-wait <name> <text> [timeout]`: auto-generates nonce (e.g. `MARK-7f3a9c`),
    injects "end with <nonce>", waits on nonce. Keep `--marker` for semantic markers.
  - Tests: new `test-marker-nonce-smoke`; update `test-wait-and-capture-smoke` + wait smokes.
  - **W1 migration acceptance gate (per Codex review)**: CHANGELOG `BREAKING:` entry + version
    bump + `--regex` tests + audit ALL existing `wait-text` smokes and convert any relying on
    the old regex default to explicit `--regex`. Do not close W1 until this gate is green.

- **W2 Result contract** (#218, #224, #220) — revise schema ONCE
  - Schema: add optional `verdict` (`ACCEPT|BLOCK|ACCEPT_WITH_CHANGES` + `blockers[]` + `marker`)
    and optional `decision` (`decision_by/delegate_name/authority/scope/decision/evidence/limits`).
  - Subcommands (both wrappers): `result init`, `result validate --json`,
    `result wait-required --fields ... --wait N --json`. `validate` lightly checks verdict/decision if present.
  - Tests: extend `test-result-schema-smoke` + `test-result-smoke`.
  - Update `references/contracts.md`.

- **W3 Session lifecycle** (#216, #222) — single file `tmux-agent-sessions`
  - `resolve --name <partial|full> --json` → wrapper/agent_name/tmux_session/running/cwd/result_path/
    recommended_next_commands; ambiguous → non-zero + candidates; never creates/stops.
  - `list --created-after <ts>`, `diff --since <ts>`, `cleanup --created-after <ts> [--dry-run|--confirm]`;
    dry-run default; refuse dirty-worktree stop without `--force`; filter by cwd/repo.
  - Tests: new `test-sessions-resolve-smoke` (+ cleanup window cases).

- **W4 New capability** (#219, #225) — parallelizable
  - new `tmux-agent-monitor --name --every --until --commands <manifest> --stop-on-change --summary-out`;
    never sends prompts unless configured; emits JSONL + final summary; distinct from wait-and-capture.
  - wrapper `--wait-for-human` heartbeat mode: holds without treating idle as completion until
    marker appears or cancelled; `awaiting_next_round` state file mirroring `approval-status.json`.
  - Tests: new smokes for each.

### PR-2 (docs) — wave W5 (#226, #228, #217, #221 + W1–W4 doc updates)

- #226 one-line-per-script capability table (all 13/14 scripts) in SKILL.md.
- #228 "Peer-review loop" Core Workflow recipe composing pair-review + nonce (#223) + verdict (#224).
- #217 "Supervising an existing worker: listen before send" state machine (discover→observe→wait→consume→send).
- #221 marker-pitfalls (stale pane vs prompt-echo as separate hazards; when to prefer wait-and-capture --marker).
- Reflect literal-by-default (#227) and new subcommands everywhere examples appear.

## Cross-cutting discipline & risks

- Every wrapper edit: apply to both twins + brand swap + `zsh -n` both + run affected smoke.
- Optional but recommended: add `test-wrapper-parity` to prevent the twins from drifting.
- #227 is the only breaking change — needs CHANGELOG BREAKING + version bump; verify no existing
  smoke relies on `wait-text` regex default.
- Verify CI (`.github/workflows/ci.yml`) picks up new `test-*-smoke` scripts.

## Acceptance roll-up

Each issue's original acceptance criteria must pass; PR-1 green CI on all new+changed smokes;
PR-2 examples are copy-paste runnable against the final command names.

## Issue-closure rule (per Codex review)

#218 / #220 / #222 acceptance criteria explicitly include SKILL.md / references/contracts.md
docs. PR-1 (code only) must NOT claim to fully close these — either land the minimal required
doc stub in PR-1, or defer closing them until PR-2 ships the full recipes. Avoid name/intent
mismatch where a code PR closes a doc-bearing issue.

## Consensus record

Pairing partner: codex-tmux worker `planpair` (gpt-5.5, skill defaults).
Verdict: **ACCEPT, zero blockers.** 5 non-blocking suggestions raised; all accepted and folded
in above (twins-as-risk, W1 migration gate, issue-closure rule, one-shot result schema confirmed,
W5 docs-after-command-names ordering confirmed). Marker `[CODEX-REVIEW-01]` received.
