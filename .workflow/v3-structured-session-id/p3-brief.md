# P3 worker brief — Codex + agy transcript correlation

You are a codex implementation worker in repo `/Users/paul.yeh/github/tmux-agent-tools`, branch
`feat/v3-sessionid-268-oneshot` (P1+P2 already committed). Implement **Phase 3 ONLY**.

DO NOT spawn additional tmux sessions; do not call claude-tmux/codex-tmux/tmux-agent-fanout/tmux-agent-dialogue;
do not start background jobs; do not SSH out. Reason only from provided context. Write result.json (the literal
path is in your prompt) with status/summary/artifacts/errors, then print a unique end marker. DO NOT commit.

## Read first (frozen spec — obey, do not redesign)
- `.workflow/v3-structured-session-id/design-proposal.md` → "Approach A: transcript correlation" (Codex source
  rule, race/bail behavior, hardening investigation), "Brain addendum (round 3): agy source FOUND",
  "Writer model and precedence", "P3 - Codex/agy transcript paths" hard gates.
- `.workflow/v3-structured-session-id/implementation-notes.md` → P2 left a transcript no-op stub at the
  precedence `case "$SESSION_ID_CAPTURE"` in `start_session` (marker `# P3:` ~line 2938). You replace that stub.

## Goal — strict, structured transcript/store correlation for `session_id_capture=transcript`

Implement a structured capturer (analogous to the existing pane `spawn_session_id_capture`, but reading a
CLI-owned store, not pane text). It runs post-launch and writes the `session-meta.json` sidecar
(`{schema_version:1, cli_session_id:"<uuid>"}`, reuse P2's `write_session_meta_id` atomic helper) ONLY on a
validated correlation; otherwise leaves it null AND emits ONE observable, non-secret bail signal (e.g. a
single stderr line / audit event — match how existing capture failures signal; never print a partial/secret UUID).

### Codex correlation rule (Approach A)
- Source: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`.
- Snapshot the candidate set BEFORE launch; after launch consider only files NEW since the snapshot within a
  bounded window. Pick the newest-new candidate.
- Validate: first record `type == "session_meta"`, `payload.id == <uuid from filename>`, AND
  `payload.cwd == <launch cwd>`. Only an exact id+cwd match writes the sidecar.
- Bail to null (with the observable signal) on: no candidate, multiple candidates, basename/payload mismatch,
  malformed first record, cwd mismatch, mtime tie.

### agy correlation rule (round-3 addendum — explicit map, cleaner than codex)
1. After launch, read `~/.gemini/antigravity-cli/cache/last_conversations.json[<launch cwd>]` → candidate UUID.
2. Cross-check `~/.gemini/antigravity-cli/conversations/<uuid>.db` exists AND its mtime is at/after the launch
   timestamp (cache-staleness guard).
3. Both agree → write sidecar. Otherwise null + observable bail signal.

### Wiring
- Replace the P2 `# P3:` transcript stub so transcript mode spawns THIS structured capturer (per CLI:
  codex rule for codex, agy rule for agy; other CLIs in transcript mode → null + bail, no pane capture).
- Transcript mode MUST NOT spawn pane capture even if `session_id_pattern` is set (precedence already enforces
  this; keep it true).
- Make the correlation logic a testable helper (e.g. `session_id_correlate_codex <sessions_root> <cwd> <since>`
  and `session_id_correlate_agy <gemini_root> <cwd> <since>`) so fixtures can drive it WITHOUT a real CLI,
  real $HOME, or a tmux session. Allow the store roots to be overridable (env or args) for tests.

## Hard gates (fail review if violated)
- Fixture tests cover, for codex: success, basename/payload mismatch, malformed first record, cwd mismatch,
  no candidates, multiple candidates, mtime tie, decoy UUID. For agy: success, missing cwd key, stale/missing
  .db (mtime before launch), decoy. Add them to `scripts/test-session-meta-smoke` (repo ROOT scripts/; it
  currently reports "27 passed").
- Bail cases leave null and emit exactly ONE observable non-secret signal.
- Pane capture is NOT spawned when `session_id_capture=transcript`.
- Default-off preserved: do NOT set `session_id_capture` in bundled `codex.conf`/`agy.conf`. Mechanism is
  exercised only via fixtures/opt-in profile.
- `scripts/test-session-meta-smoke`, `zsh -n skills/tmux-agent-tools/scripts/agent-tmux`, help smoke pass.
  (ci-shellcheck: run if your env has it; agent-tmux is a zsh script so its gate is `zsh -n`.)
- No new dependency (jq + coreutils only). Use `fd`/`rg`/`jq` (never find/grep/sed/awk/ad-hoc parsers).

## Verify before returning
- `scripts/test-session-meta-smoke` → all pass (state new total).
- `zsh -n skills/tmux-agent-tools/scripts/agent-tmux` pass.
- `agent-tmux codex self-test` still ends ok (no P1/P2 regression).
- `agent-tmux codex help` works.
- Prove transcript mode does NOT spawn pane capture (e.g. a fixture/assertion).

Ponytail: shortest working diff, no speculative abstraction, mark deliberate simplifications with `# ponytail:`.
Surgical edits, match existing style. DO NOT commit.

## Return (result.json + marker)
status, summary; artifacts cover: files+line ranges, the two correlation helpers, how transcript wiring
replaces the stub, fixture list + new pass total, the verify outputs, and ANY deviation w/ reason.
