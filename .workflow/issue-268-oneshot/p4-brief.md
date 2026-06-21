# P4 worker brief — #268 headless oneshot exec_mode

You are a codex implementation worker in repo `/Users/paul.yeh/github/tmux-agent-tools`, branch
`feat/v3-sessionid-268-oneshot` (P1+P2+P3 already committed). Implement **Phase 4 ONLY** (#268).

DO NOT spawn additional tmux sessions; do not call claude-tmux/codex-tmux/tmux-agent-fanout/tmux-agent-dialogue;
do not start background jobs; do not SSH out. Reason only from provided context. Write result.json (literal path
in your prompt), then print a unique end marker. DO NOT commit.

## Read first (frozen spec — obey, do not redesign)
- `.workflow/issue-268-oneshot/goal-doc.md` → "2. Success Criteria", "3. Scope / Non-goals",
  "Phase 2 — Oneshot start_session branch", "4. Risks + Mitigations".
- `.workflow/v3-structured-session-id/design-proposal.md` → "Integration with #268 one-shot",
  "P4 - #268 oneshot behavior" hard gates.
- `.workflow/v3-structured-session-id/implementation-notes.md` → P2/P3 surfaces. The interactive local
  `tmux new-session` for `start` is in `start_session` (the banner+`${start_launch_flags}` one, ~line 3072,
  AFTER the P2 supplied-id setup block ~2915 and BEFORE the P3 precedence `case "$SESSION_ID_CAPTURE"` ~3076).

## Goal — add a oneshot execution branch (exec_mode=oneshot) WITHOUT coupling to session-id capture

Add an isolated oneshot branch for the LOCAL `start` path only (not start-ssh, not resume). When
`EXEC_MODE=oneshot`, instead of the interactive `read`-driven pane, run the CLI ONCE:

`<bin> <launch_flags> [prompt_flag] <prompt>`

- The prompt is passed as a SINGLE shell-quoted argv via the existing `shell_quote`, NEVER pasted.
- **ONE generalized code path** covers both forms (do NOT write two branches):
  - flag form (claude/agy): `prompt_flag=-p` → `claude -p "<prompt>"`, `agy -p "<prompt>"`.
  - subcommand form (codex): `launch_flags=exec` + empty `prompt_flag` → `codex exec "<prompt>"`.
  - When `PROMPT_FLAG` is empty it is omitted and the prompt is the bare positional argv.
- Reuse `${start_launch_flags}` from the P2 block so a claude supplied-`--session-id` is already included in
  oneshot too (sidecar written pre-launch by P2 — do not re-implement).

### Inside the oneshot pane command (order matters — from goal-doc Risks)
1. `require_jq` at the top of the branch (fail closed if jq missing).
2. Run the CLI once. Capture `cli_code=$?` FIRST (before any result synthesis can overwrite it).
3. Synthesize `result.json` best-effort at `$TMUX_AGENT_DIR/<name>/result.json` with at least
   `schema_version:1, status:(success|failed by cli_code), exit_code:cli_code, stdout_path:<captured stdout file>`
   — satisfy `result wait-required` (field presence). Reuse existing result-writing helpers if present.
4. Print the deterministic marker `__AGENT_TMUX_ONESHOT_EXIT__<cli_code>` AFTER result.json is written.
5. Preserve the pane-open tail (`printf ... ; read _; exit "$cli_code"`) so `wait-and-capture` doesn't hit
   `session_gone` before capture, and the pane exits with the TRUE cli_code.

## Hard gates (fail review if violated)
- Oneshot fake fixture synthesizes `result.json` BEFORE the marker; marker is `__AGENT_TMUX_ONESHOT_EXIT__<code>`.
- Interactive profiles behave IDENTICALLY when `exec_mode=interactive` (no regression) — the oneshot code is
  reached only when `EXEC_MODE=oneshot`.
- Oneshot with `session_id_capture=off` leaves sidecar `cli_session_id:null`.
- Claude supplied-ID oneshot works (sidecar + `--session-id` present, from P2).
- Codex/agy transcript mode in oneshot stays off/null unless persistence is proven by fixture — otherwise
  null + the P3 bail signal. (Do NOT claim codex/agy oneshot resume works without a fixture proving it.)
- `status --json` on a finished oneshot reports `running:false, exit_detected:true, exit_code:N`.
- Bundled profiles stay interactive — do NOT set `exec_mode=oneshot` in any bundled .conf (agy stays
  interactive; user-local opt-in only). No `prompt_via=argv` for interactive mode. No env-override parity for
  the new keys this increment. Do NOT touch v3 `session-meta.json` semantics beyond what P2/P3 already do.
- No new dependency (jq only). `fd`/`rg`/`jq` only (never find/grep/sed/awk).

## Tests (fake CLI, no real claude/codex/agy)
- Add a oneshot fixture using a fake `-p` CLI (e.g. a temp script echoing + exiting with a chosen code) via an
  opt-in `--profile` with `exec_mode=oneshot prompt_via=argv prompt_flag=-p bin=<fake>`. Prove:
  (a) result.json synthesized with correct status/exit_code BEFORE marker; (b) marker format; (c) prompt passed
  as single argv (quoting preserved, e.g. a prompt with spaces/quotes); (d) subcommand form
  (`launch_flags=exec`, empty prompt_flag) assembles `<bin> exec "<prompt>"`; (e) interactive profile unchanged
  (no marker, no result synthesis on the launch path). Put tests where they fit best (extend `start --dry-run`
  self-test and/or `scripts/test-session-meta-smoke`, or a small new `scripts/test-oneshot-smoke`) — state which.
  `start --dry-run` should show the resolved oneshot invocation without creating a tmux session.

## Verify before returning
- `zsh -n skills/tmux-agent-tools/scripts/agent-tmux` pass.
- New oneshot test(s) pass; `scripts/test-session-meta-smoke` still 58/0 (or new total); `agent-tmux claude
  self-test` still ok; `agent-tmux <cli> help` works.
- `agent-tmux claude start --dry-run --exact t /tmp 'a b "c"'` with an opt-in oneshot profile shows the single
  argv-quoted oneshot invocation; with default interactive profile shows the unchanged interactive invocation.

Ponytail: ONE code path, shortest working diff, no speculative abstraction, mark simplifications `# ponytail:`.
Surgical edits, match existing style. DO NOT commit.

## Return (result.json + marker)
status, summary; artifacts cover: files+line ranges, the single oneshot code path (flag+subcommand), the
cli_code-first/result-before-marker ordering, test list + invocation + pass output, the verify outputs, and ANY
deviation w/ reason.
