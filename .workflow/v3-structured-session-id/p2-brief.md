# P2 worker brief — Claude supplied-ID path (race-free)

You are a codex implementation worker in repo `/Users/paul.yeh/github/tmux-agent-tools`, branch
`feat/v3-sessionid-268-oneshot` (already checked out, P1 already committed). Implement **Phase 2 ONLY**.

DO NOT spawn additional tmux sessions, do not call claude-tmux/codex-tmux/tmux-agent-fanout/tmux-agent-dialogue,
do not start background jobs, do not SSH out. Reason only from provided context. Write your result.json (the
literal path is in your prompt) with status/summary/artifacts/errors when done, then print a unique end marker.

## Read first (frozen spec — obey, do not redesign)
- `.workflow/v3-structured-session-id/design-proposal.md` → sections "P2 - Claude supplied-ID path",
  "Writer model and precedence", "Approach B: supplied ID at creation", "Security posture".
- `.workflow/v3-structured-session-id/implementation-notes.md` → code-surface map + ponytail rules.

## Goal (P2 = race-free supplied-ID for claude; mutual-exclusion writer model)

Implement the session-id-capture **precedence** in `start_session()` (skills/tmux-agent-tools/scripts/agent-tmux),
and the `supplied` branch. The existing pane capturer call is `spawn_session_id_capture "$name" "$session"
"$(agent_root_dir)/$name/session-meta.json"` (currently ~line 2890, fires unconditionally for the start path).

Replace that unconditional call with the precedence (from "Writer model and precedence"):
1. `SESSION_ID_CAPTURE=supplied` → generate a lowercase RFC-4122 UUID (`uuidgen | tr 'A-F' 'a-f'`), write the
   sidecar `session-meta.json` `{schema_version:1, cli_session_id:"<uuid>"}` **synchronously BEFORE** the
   `tmux new-session` launch (reuse the atomic tmp+mv pattern already in the file ~L1777), and add
   `--session-id <uuid>` to the claude launch command. Spawn NO capturer (not pane, not transcript).
2. `SESSION_ID_CAPTURE=transcript` → (P3 will fill the transcript capturer) — for P2, route here but it is a
   no-op stub that leaves sidecar null; **must NOT** spawn the pane capturer. Leave a clear `# P3:` marker.
3. `SESSION_ID_CAPTURE=off` AND `SESSION_ID_PATTERN` set → existing `spawn_session_id_capture` (pane) — current behavior.
4. otherwise → leave null, spawn nothing.

This gives ONE writer per session (no locks, no TOCTOU).

### --session-id wiring
- Add `--session-id <uuid>` to the **claude** launch command assembly for the interactive start path only
  (oneshot is P4 and will reuse the same pre-launch sidecar — do not build oneshot here).
- The flag belongs to claude specifically. Other CLIs must not receive it. Gate on the claude case / a
  capability, not on hardcoding everywhere. Keep it surgical.
- Use the existing redacted `_sid_display` mechanism for any pane banner line (do NOT print the full UUID;
  full UUID only behind `AGENT_TMUX_SHOW_SESSION_ID`).

## Hard gates (your work fails review if any is violated)
- `session_id_capture=supplied` generates UUID, writes sidecar BEFORE launch, adds `--session-id`.
- No background session-id capture spawned in supplied mode. No pane capture spawned in supplied mode.
- Default-off preserved: `claude.conf` stays WITHOUT `session_id_capture` → SESSION_ID_CAPTURE defaults `off`
  → with bundled `session_id_pattern` UNSET, nothing is spawned, identical to today. Do NOT edit claude.conf.
- Tests prove interactive command assembly includes the supplied `--session-id <uuid>` AND the sidecar
  contains the SAME id. Use `start --dry-run` (it prints the resolved invocation without a tmux session) with
  an opt-in profile setting `session_id_capture=supplied` as the test vehicle.
- Security test proves normal (non-dry-run, default) output / banners do not print the full UUID.
- No new dependency (uuidgen + jq only; both already used).

## Tests
- `scripts/test-session-meta-smoke` does NOT exist yet. Prefer extending the existing `self-test` subcommand
  (P1 added a `self-test profile-keys: ok` block there) with a `self-test supplied-id` block, OR create
  `scripts/test-session-meta-smoke` if cleaner — pick the lower-friction option and note which in your report.
  Tests must run WITHOUT starting a real claude (use `start --dry-run` + a temp profile).

## Verify before returning
- `zsh -n skills/tmux-agent-tools/scripts/agent-tmux` passes.
- Your new test(s) pass.
- `agent-tmux claude self-test` still ends `profile-keys: ok` (no regression to P1).
- `agent-tmux claude help` still works.
- `agent-tmux claude start --dry-run --exact t /tmp 'hi'` with NO supplied profile shows NO `--session-id`
  (default-off unchanged); with an opt-in `--profile` setting `session_id_capture=supplied` shows `--session-id <uuid>`.

Use `fd`/`rg`/`jq` only (never find/grep/ad-hoc parsers). Surgical edits, match existing style. Ponytail:
shortest working diff, no speculative abstraction, mark deliberate simplifications with `# ponytail:`.
Do NOT commit — leave changes in the working tree.

## Return (write to result.json + print marker)
status, summary, then in summary/artifacts cover: (1) files+line ranges changed, (2) the precedence block you
wrote, (3) how --session-id is gated to claude, (4) test invocation + pass output, (5) the 4 verify outputs,
(6) ANY deviation from this brief/spec with reason.
