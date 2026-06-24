---
name: tmux-agent-tools
description: Use when running or supervising AI coding CLIs (Claude Code, Codex, or any custom CLI) as managed tmux workers via agent-tmux, claude-tmux, codex-tmux, or tmux-agent-sessions. Covers start/resume, send, wait, capture, status/doctor/self-test, list, stop/cleanup, reading structured result.json files, watching multiple workers for the first/all completions (watch --any, no hand-rolled polling loops), human approval gates, declarative per-CLI profiles for adding new or renamed CLIs, and multi-agent pair-review, critic, debate, dialogue, or fanout. Also use for questions like "which worker finished first", "wait for any of these agents", or "supervise this long-running agent". Trigger on tmux as the execution layer for managed AI agent sessions; not for general tmux config, theming, shell wrappers, non-tmux headless claude/codex, or human team debate.
---

# Tmux Agent Tools

## Fast paths (read this first)

- **STOP — never type raw `tmux` at a worker.** Every interaction goes through an `agent-tmux <cli>` subcommand: message with `send-wait`, read with `capture`/`status`/`result`, end with `stop`. Raw `tmux` (`send-keys`/`capture-pane`/`new-session`/`kill-session`) bypasses the wrappers and is the #1 cause of prompts that look sent but never submit — last resort only, and say so when you use it. Full rationale: Non-negotiable rule #1.
- **Wrapper not on PATH?** Run it from the skill bundle directly: `<skill-dir>/scripts/codex-tmux …` (this file's directory). Don't waste steps on `which`/`find`/`tmux ls` discovery.
- **Supervising an existing worker?** `tmux-agent-sessions resolve --name <n> --json` → `codex-tmux status --json <n>` → `codex-tmux result --json --wait 30 <n>` → `codex-tmux ping --json --timeout 5 <n>` only if liveness is unclear. Pane capture is diagnostic fallback only.
- **Multiple workers, need first/all/quorum completions?** One blocking call: `codex-tmux watch --any|--all|--count <n> --timeout <s> --json <n1> <n2> …` — do **not** write a shell polling loop. Parse the JSON `agents[].done/reason` for the winner/quorum, then `codex-tmux result --json <winner>`.
- **Want to auto-delegate a substantial task?** Use the `tmux-delegate` subagent (shipped at plugin-root `agents/`; `.claude/agents/` in a checked-out repo) to decide inline vs worker, then run its exact wrapper command.
- **New or renamed CLI?** Write a profile (`~/.config/agent-tmux/profiles/<cli>.conf` with `bin=…`), then prove it with `agent-tmux <cli> doctor --json` / `agent-tmux <cli> setup` and a `start --dry-run` before starting a real session.

## Overview

`agent-tmux <cli> <command>` is the single engine: it runs **any** AI coding CLI as a managed tmux worker. `claude-tmux` and `codex-tmux` are one-line shims for the two most common CLIs (`claude-tmux start … ` ≡ `agent-tmux claude start …`). These wrappers provide consistent session naming, capture, wait, status, secret injection, and cleanup.

### Non-negotiable rules

1. **Engine-only — never bypass with raw tmux.** Drive every worker through `agent-tmux <cli>` subcommands (`start`/`send`/`send-wait`/`wait*`/`status`/`result`/`stop`). Do **not** hand-roll `tmux new-session`, `tmux send-keys`, `tmux capture-pane`, or any raw `tmux` call to start, message, read, or kill a worker. Raw tmux skips session naming, secret redaction, result contracts, and cleanup, and leaves you no verified-send path (`send-wait`) — a common source of lost prompts, stale-pane misreads, and orphaned sessions. If a capability seems missing, it almost always exists as a subcommand; check the capability table before reaching for tmux. Raw `tmux` is a last resort for genuine gaps only, and when truly unavoidable, say so explicitly and explain why no subcommand covered it.
2. **Prefer the managed/Agent path over shell.** When a managed subcommand or an Agent-tool delegation can do the job, use it instead of ad-hoc shell. Drop to plain shell only when no engine command covers the need — and call that out when you do.
3. **A `send` is not done until submission is verified.** Bare `send` is fire-and-forget: it pastes then fires an Enter, and on a TUI that has not settled the Enter is dropped and **the prompt sits in the input box unsent** — the recurring "it never actually sent" failure. Never fire `send` and assume it landed; default to `send-wait` (fresh nonce, waits for it) and confirm liveness before resending. Full mechanics, including the busy-signal probe, in **Sending so it actually submits** below.

Any other CLI works without code changes: `agent-tmux gemini start …` uses generic defaults, and a declarative profile file (`~/.config/agent-tmux/profiles/<cli>.conf`) can customize the binary, launch flags, resume keyword, and busy/blocked detection patterns. See "Custom CLIs and profiles" below.

Use `tmux-agent-dialogue` (and its `pair-review` / `critic` / `debate` presets) when the task is a bounded two-party exchange with a JSONL transcript. Use `tmux-agent-fanout` for parallel one-to-many work. Use `tmux-agent-sessions` for read-only inventory across all wrappers.

Local and SSH sessions keep the pane open after the agent CLI exits, showing the exit code so failures can still be captured.

The wrapper scripts are bundled at:

- `scripts/agent-tmux` (engine; `agent-tmux <cli> <command>`)
- `scripts/agy-tmux`
- `scripts/claude-tmux`
- `scripts/codex-tmux`
- `scripts/profiles/` (built-in profile dir + README and examples)
- `scripts/tmux-agent-dialogue`
- `scripts/tmux-agent-sessions`
- `scripts/tmux-agent-monitor`
- `scripts/tmux-agent-fanout`

If the commands are not on `PATH`, resolve them from the skill directory and run the script path directly.

## Script capability table

| Name | One-line purpose | When to reach for it |
| --- | --- | --- |
| `agent-tmux` | Unified engine: manage any AI coding CLI as a tmux worker (`agent-tmux <cli> <command>`), with per-CLI presets, `doctor --json`, `setup`, and declarative profiles. | Use directly for CLIs without a dedicated shim (gemini, cursor, grok, in-house tools), when scripting across multiple CLIs, or when running JSON preflight via `agent-tmux <cli> setup`. |
| `agy-tmux` | Thin shim for the bundled `agy` profile over `agent-tmux agy`. | Use when supervising Antigravity/agy with the same wrapper contract as Claude and Codex. |
| `claude-tmux` | Manage a Claude Code CLI worker in tmux with start/resume, send, wait, capture, status, ping, result, and cleanup helpers. | Use for long-running Claude Code work that needs supervision, structured result files, markers, active liveness, or later diagnostic capture. |
| `codex-tmux` | Manage a Codex CLI worker in tmux with the same wrapper contract as `claude-tmux`. | Use for long-running Codex work that needs supervision, structured result files, markers, active liveness, or later diagnostic capture. |
| `install-bin` | Install or link the bundled scripts into a chosen bin directory. | Use during local setup when the scripts are not already on `PATH`. |
| `tmux-agent-audit` | Query and verify wrapper audit logs. | Use when you need an operator-facing record of wrapper events, secret use, approvals, or posting actions. |
| `tmux-agent-cron` | Run scheduled/periodic tmux-agent-tool jobs from a manifest. | Use for repeatable local automation where a manifest should drive wrapper invocations. |
| `tmux-agent-dag` | Execute a dependency-ordered task manifest and summarize per-task results. | Use when tasks have explicit dependencies and later tasks should wait for prerequisite results. |
| `tmux-agent-dashboard` | Render a terminal dashboard for managed sessions. | Use when you need a live overview instead of inspecting each worker one at a time. |
| `tmux-agent-dialogue` | Run bounded two-party dialogues and presets such as `pair-review`, `critic`, `debate`, and `handoff`. | Use when two participants should exchange a fixed number of turns with a JSONL transcript. |
| `tmux-agent-fanout` | Spawn one prompt across multiple Claude/Codex workers and collect per-agent `result.json` files. | Use for parallel one-to-many work after the user has authorized worker count, tool, model, and effort. |
| `tmux-agent-history` | Inspect stored wrapper/session history. | Use when you need prior local run metadata rather than current tmux state. |
| `tmux-agent-monitor` | Poll read-only evidence commands for a managed agent or repo and emit JSONL observations plus a summary. | Use when you need periodic evidence checks; it does not send prompts unless the manifest commands do so. |
| `tmux-agent-notify` | Send local notifications for wrapper-related events. | Use to alert an operator when a watched condition or job state changes. |
| `tmux-agent-replay` | Replay or diff transcript/audit JSONL runs. | Use to compare runs, debug marker sequences, or inspect previously recorded wrapper events. |
| `tmux-agent-sessions` | Inventory, resolve, diff, and clean up sessions across Claude, Codex, and dialogue wrappers. | Use before adopting an existing worker, after accidental starts, or before any cleanup. |
| `tmux-agent-worktrees` | Manage worktrees created for agent work and apply cleanup policy. | Use when agent runs create isolated git worktrees that need listing or pruning. |

## When Not To Use

- One-off non-interactive shell commands — run them directly.
- A simple file read, search, test, or build command — don't spawn a tmux agent for it.
- Externally visible, destructive, or privacy-sensitive work unless the user has already authorized it.

## Auto-delegation via tmux-delegate

Claude Code can use the `tmux-delegate` subagent as the decision gate for substantial work. Discovery depends on how this bundle is loaded: installed as a plugin, the subagent ships at the plugin root `agents/tmux-delegate.md` and is addressable as `tmux-delegate` (qualified `tmux-agent-tools:tmux-delegate`); in a checked-out repo, the same agent is at `.claude/agents/tmux-delegate.md`. The two files are kept byte-for-byte in sync (a smoke test fails on drift). Note the lifecycle: editing a subagent file requires a session restart to re-register it, and changing other plugin components requires `/reload-plugins` — adding the agent mid-session does not take effect. It delegates when the task is likely to take more than 30s, modifies 2 files or more, needs an independent context window, requires a multi-step read-plan-write cycle, or runs tests/builds/lint across the codebase. It handles inline for single-file reads/searches/formatting, one-liners with immediate output, explicit "quick"/"inline" requests, and marginal cases.

`tmux-delegate` must include this literal worker constraint in every delegated prompt: "Do not spawn additional tmux sessions or delegate further." It uses a hardcoded wrapper command skeleton instead of interpolating raw task text into Bash. Resume (v2): after `start`, a background capture may populate `session-meta.json` with a `cli_session_id` UUID — read it with `jq -r .cli_session_id "$TMUX_AGENT_DIR/<name>/session-meta.json"` or `result --field .cli_session_id`, then use it with `resume` if non-null. Bundled `claude.conf` and `codex.conf` ship `session_id_pattern` UNSET — resume is unsupported by default (guardrail: no verified deterministic session-label format confirmed across versions). Operators opt in per-CLI by setting `session_id_pattern` to a label-anchored ERE (e.g. `session_id_pattern=Session ID:`) in a user-local profile once they know the exact label line their version prints. Capture is label-anchored + UUID-validated (decoy UUIDs on non-matching lines are ignored).

## Command Choice

- `claude-tmux` when the worker should run Claude Code; `codex-tmux` when it should run Codex CLI; `agy-tmux` for agy; `agent-tmux <cli>` for any other CLI (gemini, cursor, grok, custom binaries).
- `start` for a local working directory; `start-ssh` when tmux stays local but the CLI runs over SSH.
- `start --model <m>` pins a worker's model for that run (passed through as `--model <m>`; not validated per-CLI, since `ANTHROPIC_MODEL`/env are unreliable). For a durable per-CLI default set `launch_flags` in the profile instead.
- `resume` when an existing CLI session UUID should continue inside a managed tmux session. v2 `cli_session_id` capture is opt-in and default-off unless the active profile sets a label-anchored `session_id_pattern`.
- The subcommands `send`, `send-wait`, `capture`, `wait*`, `status`, `ping`, `attach`, `stop`, and `result` all take the **agent name** you chose, not the full tmux session name.
- If you don't know which wrapper owns a session, use `tmux-agent-sessions resolve --name <partial-or-full-name> --json` before any `start`. It accepts a full tmux session name, wrapper-prefixed partial, or short agent name and returns the owning wrapper, short `agent_name`, full tmux session, cwd, result path, running state, and safe next commands for `status`, `wait-and-capture`, and `result`. Ambiguous or missing names exit non-zero and return JSON candidates/errors.
- Use `tmux-agent-monitor --name <agent> --every <duration> --commands <manifest.json> --stop-on-change --summary-out <path> --json` when you need read-only periodic evidence checks against a managed session/repo. It polls manifest commands and emits JSONL observations plus a summary; it is distinct from `wait-and-capture`, which watches a tmux pane for a marker and captures pane output.

## Custom CLIs and profiles

`agent-tmux <cli>` works for any binary out of the box: unknown CLI names get generic defaults (binary = the CLI name, generic-family heuristics, no provider-key inheritance, no `--yolo`, result-path-via-prompt on, no launch flags). Profiles are the canonical per-CLI configuration: the bundled `scripts/profiles/` directory ships the defaults for claude/codex/agy/cursor/grok (the in-script preset table is a frozen legacy fallback), and new CLIs are added as profiles, not code. To customize, write a declarative profile at `~/.config/agent-tmux/profiles/<cli>.conf`, set `AGENT_TMUX_PROFILE_DIR`, or pass it at use time: `agent-tmux <cli> --profile-dir <your-managed-dir> …` / `--profile <file>`. Profiles are plain `key=value` files — never sourced, so they cannot execute code. Precedence: env vars (`<NS>_TMUX_*` > `AGENT_TMUX_*`) > `--profile`/`--profile-dir` > `$AGENT_TMUX_PROFILE_DIR` > user config dir > bundled defaults > legacy preset.

Migration note: unlisted CLIs now use `generic` instead of Codex-family behavior. If a custom CLI intentionally needs Codex/OpenAI provider-key inheritance or `--yolo`, set those explicitly in its profile.

Profile contract keys that affect safety and structured results:

- `approval=prompt|auto` controls the profile approval mode; read the active value from `agent-tmux <cli> doctor --json`.
- `result_required_fields=status,summary,...` becomes the default field list for `result wait-required` when `--fields` is omitted; explicit `--fields` still wins.
- `session_id_pattern=<label-anchored ERE>` enables v2 `cli_session_id` capture. Leave it unset unless the CLI's session-label line is verified for that version.

Use `agent-tmux <cli> setup` as the JSON preflight (`doctor --json` + `self-test`). Use `agent-tmux <cli> start --dry-run ...` to inspect the resolved invocation/profile without creating a tmux session.

```ini
# ~/.config/agent-tmux/profiles/gemini.conf
bin=gemini
env_ns=GEMINI
launch_flags=
resume_keyword=resume
heuristic_family=generic
# Optional detection overrides (extended regex, case-insensitive):
pattern_busy=(thinking|generating|esc to cancel)
pattern_approval_prompt=allow this (command|action)\?
approval=prompt
result_required_fields=status,summary
# session_id_pattern=Session ID:
```

Common cases:

- **Same CLI, different binary name per machine** (e.g. `agy` installed as `agy-local`): a one-line profile `bin=agy-local` — no code change, no env var to remember.
- **Brand-new CLI**: write the profile, then `agent-tmux gemini start --exact worker ~/repo 'prompt'`. All subcommands (`send`, `wait*`, `status`, `result`, approval gates) work identically.
- **Detection mismatch**: if `status`/`probe` misreads the new CLI's busy/approval output, set `pattern_busy` / `pattern_permission_prompt` / `pattern_approval_prompt` / `pattern_login_prompt`.

`agent-tmux <cli> doctor` shows which profile file was loaded (`profile: <path>` or `<none>`). Supported keys: see `scripts/profiles/README.md`.

## Core Workflow

### Supervising an existing worker: listen before send

Use an existing teammate when one already exists; resolve it before creating another session. Status/result/watch are the automation contract.

```text
resolve
  -> status --json
  -> result --json --wait 30
  -> ping only if status is running but progress is unclear
  -> capture only for diagnostic tail
  -> send only if idle, blocked on input, or explicitly asked
```

Copyable flow:

```bash
tmux-agent-sessions resolve --name worker --json
codex-tmux status --json worker
codex-tmux result --json --wait 30 worker
codex-tmux ping --json --timeout 5 worker
```

Only send after those checks show the teammate is idle, stalled, or explicitly blocked on human input. Repeated prompts while the teammate is thinking usually create duplicate work, prompt echoes, and stale-pane confusion.

1. **Start** with a short stable name:

```bash
codex-tmux start --exact worker ~/github/project 'Read the repo and report the failing test. Write $TMUX_AGENT_RESULT when done.'
claude-tmux resume --exact worker ~/github/project ee5aca88-a1af-48d3-af21-54f60d618f22
```

Use `start --dry-run` first when validating a new profile, `--result-schema`, or launch flags; it prints the resolved invocation and exits without creating a tmux session.

2. **Send** follow-up work without attaching:

```bash
codex-tmux send worker 'Now implement the smallest fix and run the targeted test.'
codex-tmux send-wait worker 'Summarize the current blocker in result.json.' 180
```

Use `send-wait <name> <text> <timeout>` for marker-driven orchestration. It generates a fresh nonce, appends the instruction to end with that nonce, sends the text, and waits for that unique marker. Fresh nonce markers avoid both stale pane matches and prompt-echo matches.

#### Sending so it actually submits

Bare `send` pastes the text and fires an `Enter` after the submit delay — and a second `Enter` after another delay when the prompt contains a newline (`paste_and_submit`) — using `<NS>_TMUX_SUBMIT_DELAY` (e.g. `CODEX_TMUX_SUBMIT_DELAY`, falling back to `AGENT_TMUX_SUBMIT_DELAY`; default `0.2s`). On a busy or slow-rendering TUI that Enter can land before the input box is ready — it inserts a newline or is swallowed, and the prompt stays in the box **unsent**. This is the "I sent it but nothing happened" failure; it is silent unless you verify.

Make submission verifiable, never assumed:

- **Default to `send-wait`.** It generates a *fresh nonce*, appends "end with this nonce" to your prompt, sends, and waits for that unique marker — so the marker only appears once the prompt is accepted and the worker answers. Marker arrives → it submitted and ran. No marker by the timeout means submission is *unconfirmed* — not proven failed; the worker may simply be slow or stuck. Distinguish before resending: `status --json` (still `running`?) plus `probe --metric <metric> <name>` for the busy signal (`--metric tool_active` for codex/generic, `--metric active_spinner` for claude) — `status` and `ping` expose none. Resend the same `send-wait` only if it is idle or not progressing — that liveness check, not the nonce, is what keeps this safe (the fresh nonce only stops a stale marker from matching; it does not make the worker's action idempotent, so a resend after a prompt that *did* land would run it twice). If it is actively working, keep waiting.
- **`send-wait-literal` needs a *unique* literal.** Unlike `send-wait`, it does not generate a marker — it records the literal's occurrence count before sending and waits for that count to rise, so existing pane content cannot satisfy it. The real caveat is a non-unique literal: if unrelated later output also emits it, that counts as the new occurrence and false-positives. Choose a literal unlikely to appear except in the worker's reply.
- **If you must use bare `send`, verify with a capture.** `capture --strip-ansi <name> 20`: if your prompt text still sits on the input line, it was not submitted — resend. `status --json` has **no** busy field and `ping` only proves the pane responds (`ok`/`timeout`/`dead`); for a positive "is it working" signal use the busy-signal `probe` described above.
- **Tune the delay for heavy TUIs.** If non-submission keeps happening for a given CLI, raise its submit delay per that CLI's namespace or universally: `CODEX_TMUX_SUBMIT_DELAY=0.6` (or `CLAUDE_TMUX_SUBMIT_DELAY=0.6`, or `AGENT_TMUX_SUBMIT_DELAY=0.6` for all CLIs). Slower is more reliable; trade latency for landing the prompt.
- **Never re-fire raw `tmux send-keys Enter` to "nudge" it.** That is the bypass rule #1 forbids and it desyncs the engine's view of the pane. Resend through `send-wait` instead.

3. **Wait with a bounded wrapper call**. Every blocking wait needs a timeout; never write shell `sleep`, `while status ...`, or hand-rolled capture polling loops.

```bash
codex-tmux wait worker 180                                # idle stability
codex-tmux wait-literal worker '[CODEX-01]' 180           # literal marker
codex-tmux wait-text worker '[CODEX-01]' 180              # literal-by-default
codex-tmux wait-text --regex worker 'DONE|Need approval' 180
codex-tmux wait-and-capture --marker '[DONE]' --timeout 180 --tail 80 --strip-ansi --json worker
```

To supervise **multiple workers with one blocking call** (no per-worker polling from the orchestrator), use `watch`. A worker counts as done when it (re)writes `result.json` after the watch started, or when its tmux session exits:

```bash
codex-tmux watch --any --timeout 600 --json w1 w2 w3   # first completion wins
codex-tmux watch --all --timeout 600 --json w1 w2 w3   # block until all done
codex-tmux watch --count 2 --timeout 600 --json w1 w2 w3 # proceed on 2 done
```

Exit 0 when the condition is met, 1 on timeout. The JSON lists per-agent `done` and `reason` (`result_updated` | `exited`); `--count` also includes `required_count` and `done_count`. Polling happens inside the shell call, so the supervising agent spends one tool call instead of a status loop — this is the token-efficient pattern for fanout supervision.

For team state, `team quorum <team> --count N [--field <jq> --value <literal>] --json` counts present, valid worker results using each worker row's stored `result_path`. Use `--field .status --value success` to require a specific result value.

If `watch` times out, run one structured liveness pass per worker: `status --json`, then `ping --json --timeout 5` for workers with `running:true` and high `idle_seconds`, then `result --json --wait 30`. If `diagnostic` shows an approval/permission prompt, attach and answer only with authorization. If ping fails and no result appears, report the worker as stalled with status JSON and one `capture --strip-ansi <name> 80` diagnostic tail.

`wait-text` is literal-by-default. Add `--regex` only when you intentionally want regex matching. Literal markers may contain regex metacharacters like `[`, `]`, `(`, `)`, `.`, `*`, or `?` without escaping.

For **alternation markers** (e.g. wait for `[DONE]` OR `Need approval`), use `wait-and-capture --regex --marker` with an escaped regex; do not race two raw wait calls. See `references/cheatsheets.md` for worked marker pitfalls.

4. **Inspect, probe liveness, or clean up**:

```bash
codex-tmux status worker
codex-tmux status --json worker
codex-tmux ping --json --timeout 5 worker
codex-tmux env-doctor worker
codex-tmux doctor
codex-tmux self-test
codex-tmux stop worker
```

`status --json` is the passive liveness contract. Treat `running:false` as authoritative even if the tmux session still exists for capture. `ping --json --timeout <s>` is the active liveness check; it proves the pane responds to benign input, not that the agent has completed.

Use `env-doctor [name]` before deeper debugging when an agent CLI uses the wrong provider, model, base URL, token, timeout, login state, or behaves differently inside tmux than outside tmux. It compares the caller environment, tmux global environment, and the running agent child process environment, redacting token/key values. This catches tmux-side provider pollution before chasing shell startup files, app switchers, or CLI login state.

5. **Read the agent's structured result** instead of scraping the pane:

```bash
codex-tmux result --field '.status' --wait 30 --json worker
codex-tmux result --field '.cli_session_id' --wait 30 worker
codex-tmux result validate worker --json
codex-tmux result wait-required worker --fields status,summary --wait 60 --json
```

Agents should write `result.json` at `$TMUX_AGENT_DIR/<name>/result.json` with `schema_version: 1`, `status`, `summary`, `artifacts`, `errors`; review workflows may also include optional `verdict` and `decision` blocks. For `result_path_via_prompt=true` families (Codex and generic by default), the **first** prompt-bearing start/send injects the literal path **once per session** (sandboxed tool envs cannot expand `$TMUX_AGENT_RESULT`); follow-up sends and `send --raw` keystrokes are never prefixed, so answering a TUI prompt with a single key stays clean (#283). Use `result --path <name>` as the debug surface. Parent branches on `.present` → `.valid` → `.body` in that order. See `references/contracts.md`.

`cli_session_id` is not stored in `result.json`; `result --field .cli_session_id` reads the per-session `session-meta.json` sidecar so resume can work before the worker writes a final result. `--result-schema <abs.json>` on `start`/`resume` persists a schema path for `result validate`; profile `result_required_fields` supplies the default required-field contract for `result wait-required`.

Stall fallback: if `status --json` reports `running:true` with high `idle_seconds` and `ping` times out, send one bounded recovery prompt with `send-wait`: "Write result.json now with status blocked and the current blocker." Then read `result wait-required worker --fields status,summary --wait 60 --json`. If that also times out, stop waiting and report stalled with structured status plus one diagnostic capture tail.

### Peer-review loop

Use this when a human wants an open-ended N-round review cycle and will decide each round's content between rounds. The dialogue preset gives you the bounded review transcript; `send-wait` gives each follow-up a fresh completion marker; the `verdict` block gives the reviewer a structured decision.

```bash
# Round 1: produce a local two-turn review transcript.
tmux-agent-dialogue pair-review \
  --workdir ~/github/project \
  --prompt-file /tmp/review-round-1.md \
  --transcript /tmp/review-round-1.jsonl \
  --turns 2 \
  --summary-file /tmp/review-round-1.md

# Between rounds, the human decides what should change next.
codex-tmux send-wait reviewer 'Review the updated diff. Write result.json with verdict.verdict as ACCEPT, BLOCK, or ACCEPT_WITH_CHANGES, blockers as an array, and marker set to the nonce you end with.' 600
codex-tmux result wait-required reviewer --fields status,summary,verdict --wait 60 --json

# Repeat the send-wait/result pair for rounds 2..N until the human stops.
```

Do not let the agents decide how many rounds to run. The human chooses each next prompt based on the previous transcript, summary, and `verdict`.

For accidental session creation recovery, capture a timestamp before the risky operation and then use the session inventory helpers:

```bash
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
tmux-agent-sessions diff --since "$since" --json
tmux-agent-sessions list --created-after "$since" --json
tmux-agent-sessions cleanup --preview --created-after "$since" --json
tmux-agent-sessions cleanup --execute --created-after "$since"   # only after operator authorization
```

Rows include wrapper, short agent name, tmux session, cwd, age, running state, and result path. Combine `--created-after` with `--tool`, `--name`, `--state`, or `--cwd` to narrow cleanup. `cleanup --execute` refuses dirty managed worktrees unless `--force` is passed.

## Approval gates

To pause a worker until a human writes a decision file:

```bash
marker=/tmp/agent-7/approve.txt
codex-tmux wait-and-capture --literal --marker '[NEEDS-APPROVAL]' \
  --timeout 300 --pause-until-file "$marker" --pause-timeout 1800 worker
# Operator (another shell): echo approve > "$marker"  → exit 0
#                           echo reject  > "$marker"  → exit 7
# Timeout fires             →                            exit 8
```

While blocked, `$TMUX_AGENT_DIR/<name>/approval-status.json` reports `state: "awaiting_approval"`. Use this gate for any destructive/irreversible action a worker is about to take.

## Orchestrator playbook (multi-agent collaboration)

These tools are for **long-running supervised work**, not for unbounded agent sprawl. Before spawning more than one worker — including any `dialogue` / `pair-review` / `critic` / `debate` / `fanout` — apply all four rules:

1. **Ask the user up front: tool (claude or codex), model tier, and effort/reasoning level per worker.** Never assume defaults.
2. **Declare an explicit worker upper bound** (e.g., "I will run at most 3 workers; if that is insufficient I will stop and report, not spawn helpers").
3. **Forbid cascade spawning** by writing a literal ban into each worker's prompt body: "Do not call `claude-tmux`, `codex-tmux`, `tmux-agent-fanout`, or `tmux-agent-dialogue`. Do not start background jobs. Do not SSH out. Reason only from provided context and write your result to <the literal path from `result --path <name>`> when done." The wrappers have no kernel-level sandbox; this prompt-level barrier is the only stopgap. Here "delegate further" means spawning more tmux/engine workers (`agent-tmux`/`claude-tmux`/`codex-tmux`, `tmux-agent-fanout`, `tmux-agent-dialogue`) — it does **not** forbid the worker's own in-process Claude Code `Agent` tool, a separate mechanism the CLI supervises and depth-caps at 5 levels, which stays allowed.
4. **Bound dialogue length.** `critic` and `debate` require positive even `--turns`. Pick a small number (2–6).

For credential-free smoke tests of any preset, use `--agent-a fake --agent-b fake`. Real `codex` / `claude` participants only after explicit user authorization.

Cross-review pattern (workers produce → dialogue reviews): see `references/multi-agent.md`. Fanout details, dialogue presets, SSH participants, participant profiles, and `github-comment` (which never posts without `--post-github-comment`): same file.

Always run `tmux-agent-dialogue validate-transcript --transcript <path>` before summarizing, sharing, or posting a transcript.

## Safety

- The wrappers run their CLIs with permissive flags by default (`--dangerously-skip-permissions` for Claude, `--yolo` for Codex; profiles may set their own `launch_flags`). Do not use them for destructive, privacy-sensitive, externally visible, payment, or irreversible operations without explicit user authorization.
- `agent-tmux <cli> status --json <name>` sets `confirmation_detected:true` with a `blocked_reason` (`permission_prompt`, `approval_prompt`, `login_prompt`, `hook_trust_prompt`, …) when the pane looks like it is waiting for confirmation — including a plugin hook-trust prompt ("N hooks need review … Press t to trust"). It does NOT auto-accept. Answer a single-key prompt with `send --raw <name> t` only after you trust it.
- Prefer `doctor --json`, `setup`, and `self-test` before debugging agent behavior; they verify wrapper dependencies, active approval/profile state, and tmux capture/wait without starting a real agent.
- For secret injection (`--secret KEY=URI`) and audit log enablement (`TMUX_AGENT_TOOLS_AUDIT_LOG`): see `references/security.md`. Missing secrets fail closed before the session is created.

## Session naming

- Without `--exact`, `start` appends a random suffix to avoid collisions.
- With `--exact`, the session uses the requested name exactly under the tool prefix.
- **Single caller per agent name.** Two `start --exact same-name` kills the first. Wrapper state under `$TMUX_AGENT_DIR/<name>/` is NOT lock-protected.

## Remote sessions

`start-ssh` when the target repo is on another host:

```bash
claude-tmux start-ssh --exact review example-host ~/github/project 'Review the diff and return findings only.'
```

Requirements: local `tmux`; remote shell can resolve `claude` or `codex` on `PATH`; SSH target preconfigured.

## References

Load these only when you hit the relevant scenario — they are not needed for routine use:

- `references/cheatsheets.md` — scenario → command, token-efficient patterns, completion-signaling matrix, marker pitfalls (including the alternation case), failure-mode triage.
- `references/multi-agent.md` — dialogue / pair-review / critic / debate / fanout details, worker→dialogue bridge pattern, SSH participants, participant profiles, github-comment (no posting by default).
- `references/contracts.md` — `status --json` stable fields, `result.json` schema with worked example, approval-gate state/exit codes, concurrency model, cost accounting, inventory/cleanup.
- `references/security.md` — secret injection backends, audit log operator surface, full environment-override table, pre-flight checks.
