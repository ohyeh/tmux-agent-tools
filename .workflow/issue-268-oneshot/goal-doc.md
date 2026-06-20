# #268 — Headless one-shot CLI support in `agent-tmux start` — goal doc

_Authored 2026-06-21. Seeded from codex research worker `issue268-research` (findings in
`research-findings.md`, verdict: feasible). Frozen-plan candidate for GitHub issue #268._

## 1. Goal

Let a profile opt a CLI into a headless one-shot exec mode so `agent-tmux <cli> start ...` wires straight
to a working `<bin> -p "<prompt>"` invocation while keeping the wrapper's status / wait / result contract.
Concrete driver: Antigravity `agy` (Gemini) over SSH only works headless; interactive launch re-triggers an
unanswerable OAuth prompt and hangs.

## 2. Success Criteria

- New profile keys parse + validate: `exec_mode=interactive|oneshot` (default `interactive`),
  `prompt_via=paste|argv` (default `paste`), `prompt_flag=<string>` (**optional, may be empty**).
- Shared v3 Phase 1 ships the parser/default/docs round together with
  `session_id_capture=off|supplied|transcript`; #268 still owns only oneshot behavior and `result.json`.
- `exec_mode=oneshot` runs the CLI **once** inside the tmux pane:
  `<bin> <launch_flags> [prompt_flag] <prompt>`, prompt passed as a single shell-quoted argv (via existing
  `shell_quote`) — never pasted. When `prompt_flag` is empty it is skipped and the prompt is the bare
  positional argv.
- **Generalized headless shape** (build it ready / 備而不用): one code path covers both forms so it is the
  conceptual equivalent of `codex exec` for any CLI —
  - flag form (claude/agy): `prompt_flag=-p` → `agy -p "<prompt>"`, `claude -p "<prompt>"`
  - subcommand form (codex): `launch_flags=exec` + `prompt_flag=` (empty) → `codex exec "<prompt>"`
- A `result.json` is synthesized on exit (status success/failed, exit_code, stdout_path) before the marker
  is printed; it satisfies `result wait-required` (field presence only).
- Deterministic marker `__AGENT_TMUX_ONESHOT_EXIT__<code>` printed after result synthesis.
- Pane stays open on exit (existing `read _` tail preserved) so `wait-and-capture` doesn't hit
  `session_gone` before capture; `status --json` reports `running:false exit_detected:true exit_code:N`.
- Interactive profiles (claude/codex) behave **identically** to today — no regression.
- Tests pass via a fake `-p` CLI fixture (no real agy/codex/claude run, no new dependency).

## 3. Scope / Non-goals

In scope: profile-key surface; one isolated oneshot branch in `start_session` before the current
`tmux new-session`; argv prompt quoting; synthesized result + marker; profile README + doctor text lines;
fake-fixture tests.

Non-goals: do NOT solve general `launch_flags` shell-token parsing (stays a raw fragment); do NOT flip
bundled `agy.conf` to oneshot until verified on a real environment (user-local opt-in first); no
`prompt_via=argv` for interactive mode; no env-override parity for the new keys this increment; do NOT write
or interpret v3 `session-meta.json` beyond sharing the Phase 1 parser/docs round.

## 4. Risks + Mitigations

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Pane closes on exit → `wait-and-capture` returns `session_gone` | Breaks capture contract | Preserve `printf local-exit; read _; exit "$code"` tail in the oneshot branch |
| `status`/`wait` read pane text, not process state | An exited pane can look `stable` even if result synthesis failed | Prefer `result --wait`/`wait-required`; print marker only after result is written |
| Exit code overwritten by result synthesis | Wrong failure signal | `cli_code=$?` first, synthesize best-effort, then exit with `cli_code` |
| `jq` missing → result write fails | No structured result | `require_jq` at top of oneshot branch |
| Stale marker if same `--exact` name reused | False completion | `start --exact` already kills old session; also gate on result mtime |
| Bundled profile safety | One local agy setup ≠ universal default | Keep bundled `agy.conf` interactive; document user-local opt-in only |

## 5. Phased Breakdown

### Phase 1 — Unified profile surface only
Add globals `EXEC_MODE=interactive`, `PROMPT_VIA=paste`, `PROMPT_FLAG=''`; in the shared v3/#268 round, also
parse/validate `session_id_capture=off|supplied|transcript` for v3. Update `scripts/profiles/README.md` key table; profile-parse self-test (no tmux).
Exit: unknown values fail/warn consistently; claude/codex/agy behavior unchanged.

### Phase 2 — Oneshot `start_session` branch
After state/env/result setup, before current `tmux new-session`, branch on `EXEC_MODE`. For oneshot: require
non-empty `initial_text` and `prompt_via=argv` (`prompt_flag` is optional — empty means bare positional
prompt, covering the `codex exec` subcommand shape); build one tmux command that runs the CLI once as
`<bin> <launch_flags> [prompt_flag] <quoted-prompt>`, redirects stdout/stderr to `<agent>/stdout.log`,
synthesizes `result.json`, prints `__AGENT_TMUX_ONESHOT_EXIT__<code>`, then the existing local-exit line +
`read _`.
Exit: `result --json --wait` → present+valid; `status --json` → `running:false exit_detected:true`;
`wait-and-capture --marker __AGENT_TMUX_ONESHOT_EXIT__` matches on retained pane.

### Phase 3 — Targeted tests
zsh/bash syntax gate if repo uses it; fake `-p` CLI fixture proving: prompt with spaces/newlines/metachars
arrives as one argv; **empty `prompt_flag` → bare positional argv (codex-exec shape) also arrives as one
argv**; result synthesized on success; non-zero exit → failed result + matching-code marker; interactive
profiles still paste.
Exit: no real CLI invocation; no new dependency.

### Phase 4 — Optional real agy opt-in (follow-up)
After fixtures pass, document a user-local `agy.conf` example (`exec_mode=oneshot, prompt_via=argv,
prompt_flag=-p, result_path_via_prompt=true`). Bundled `agy.conf` stays unchanged until verified across real
environments.

## Next action

Promote to a frozen implementation plan via the planning pipeline and start Phase 1 (profile surface) — it
is independently shippable and low-risk, with no behavior change to existing CLIs.
