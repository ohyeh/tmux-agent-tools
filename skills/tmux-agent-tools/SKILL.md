---
name: tmux-agent-tools
description: Use when running or supervising AI coding CLIs (Claude Code, Codex, or any custom CLI) as managed tmux workers via agent-tmux, claude-tmux, codex-tmux, or tmux-agent-sessions. Covers start/resume, send, wait, capture, status/doctor/self-test, list, stop/cleanup, reading structured result.json files, watching multiple workers for the first/all completions (watch --any, no hand-rolled polling loops), human approval gates, declarative per-CLI profiles for adding new or renamed CLIs, and multi-agent pair-review, critic, debate, dialogue, or fanout. Also use for questions like "which worker finished first", "wait for any of these agents", or "supervise this long-running agent". Trigger on tmux as the execution layer for managed AI agent sessions; not for general tmux config, theming, shell wrappers, non-tmux headless claude/codex, or human team debate.
---

# Tmux Agent Tools

## Fast paths (read this first)

- **Wrapper not on PATH?** Run it from the skill bundle directly: `<skill-dir>/scripts/codex-tmux …` (this file's directory). Don't waste steps on `which`/`find`/`tmux ls` discovery.
- **Supervising an existing worker?** `tmux-agent-sessions resolve --name <n> --json` → `codex-tmux status --json <n>` → `codex-tmux result --json --wait 30 <n>` → `codex-tmux ping --json --timeout 5 <n>` only if liveness is unclear. Pane capture is diagnostic fallback only.
- **Multiple workers, need the first/all completions?** One blocking call: `codex-tmux watch --any|--all --timeout <s> --json <n1> <n2> …` — do **not** write a shell polling loop. Parse the JSON `agents[].done/reason` for the winner, then `codex-tmux result --json <winner>`.
- **Want to auto-delegate a substantial task?** Use the `.claude/agents/tmux-delegate.md` subagent to decide inline vs worker, then run its exact wrapper command.
- **New or renamed CLI?** Write a profile (`~/.config/agent-tmux/profiles/<cli>.conf` with `bin=…`), then prove it with `agent-tmux <cli> doctor` showing both the resolved binary and the `profile:` line.

## Overview

`agent-tmux <cli> <command>` is the single engine: it runs **any** AI coding CLI as a managed tmux worker. `claude-tmux` and `codex-tmux` are one-line shims for the two most common CLIs (`claude-tmux start … ` ≡ `agent-tmux claude start …`). Prefer these wrappers over hand-written `tmux send-keys` flows because they provide consistent session naming, capture, wait, status, secret injection, and cleanup.

Any other CLI works without code changes: `agent-tmux gemini start …` uses generic defaults, and a declarative profile file (`~/.config/agent-tmux/profiles/<cli>.conf`) can customize the binary, launch flags, resume keyword, and busy/blocked detection patterns. See "Custom CLIs and profiles" below.

Use `tmux-agent-dialogue` (and its `pair-review` / `critic` / `debate` presets) when the task is a bounded two-party exchange with a JSONL transcript. Use `tmux-agent-fanout` for parallel one-to-many work. Use `tmux-agent-sessions` for read-only inventory across all wrappers.

Local and SSH sessions keep the pane open after the agent CLI exits, showing the exit code so failures can still be captured.

The wrapper scripts are bundled at:

- `scripts/agent-tmux` (engine; `agent-tmux <cli> <command>`)
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

Claude Code can use `.claude/agents/tmux-delegate.md` as the decision gate for substantial work. It delegates when the task is likely to take more than 30s, modifies 2 files or more, needs an independent context window, requires a multi-step read-plan-write cycle, or runs tests/builds/lint across the codebase. It handles inline for single-file reads/searches/formatting, one-liners with immediate output, explicit "quick"/"inline" requests, and marginal cases.

`tmux-delegate` must include this literal worker constraint in every delegated prompt: "Do not spawn additional tmux sessions or delegate further." It uses a hardcoded wrapper command skeleton instead of interpolating raw task text into Bash. `--resume` is not supported in v1 because wrapper resume requires a CLI UUID that `start` does not emit yet.

## Command Choice

- `claude-tmux` when the worker should run Claude Code; `codex-tmux` when it should run Codex CLI; `agent-tmux <cli>` for any other CLI (gemini, cursor, grok, custom binaries).
- `start` for a local working directory; `start-ssh` when tmux stays local but the CLI runs over SSH.
- `resume` (claude or codex) when an existing session ID should continue inside a managed tmux session.
- The subcommands `send`, `send-wait`, `capture`, `wait*`, `status`, `ping`, `attach`, `stop`, and `result` all take the **agent name** you chose, not the full tmux session name.
- If you don't know which wrapper owns a session, use `tmux-agent-sessions resolve --name <partial-or-full-name> --json` before any `start`. It accepts a full tmux session name, wrapper-prefixed partial, or short agent name and returns the owning wrapper, short `agent_name`, full tmux session, cwd, result path, running state, and safe next commands for `status`, `wait-and-capture`, and `result`. Ambiguous or missing names exit non-zero and return JSON candidates/errors.
- Use `tmux-agent-monitor --name <agent> --every <duration> --commands <manifest.json> --stop-on-change --summary-out <path> --json` when you need read-only periodic evidence checks against a managed session/repo. It polls manifest commands and emits JSONL observations plus a summary; it is distinct from `wait-and-capture`, which watches a tmux pane for a marker and captures pane output.

## Custom CLIs and profiles

`agent-tmux <cli>` works for any binary out of the box: unknown CLI names get generic defaults (binary = the CLI name, codex-family heuristics, no launch flags). Profiles are the canonical per-CLI configuration: the bundled `scripts/profiles/` directory ships the defaults for claude/codex/agy/cursor/grok (the in-script preset table is a frozen legacy fallback), and new CLIs are added as profiles, not code. To customize, write a declarative profile at `~/.config/agent-tmux/profiles/<cli>.conf`, set `AGENT_TMUX_PROFILE_DIR`, or pass it at use time: `agent-tmux <cli> --profile-dir <your-managed-dir> …` / `--profile <file>`. Profiles are plain `key=value` files — never sourced, so they cannot execute code. Precedence: env vars (`<NS>_TMUX_*` > `AGENT_TMUX_*`) > `--profile`/`--profile-dir` > `$AGENT_TMUX_PROFILE_DIR` > user config dir > bundled defaults > legacy preset.

```ini
# ~/.config/agent-tmux/profiles/gemini.conf
bin=gemini
env_ns=GEMINI
launch_flags=--yolo
resume_keyword=resume
heuristic_family=codex
# Optional detection overrides (extended regex, case-insensitive):
pattern_busy=(thinking|generating|esc to cancel)
pattern_approval_prompt=allow this (command|action)\?
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

2. **Send** follow-up work without attaching:

```bash
codex-tmux send worker 'Now implement the smallest fix and run the targeted test.'
codex-tmux send-wait worker 'Summarize the current blocker in result.json.' 180
```

Use `send-wait <name> <text> <timeout>` for marker-driven orchestration. It generates a fresh nonce, appends the instruction to end with that nonce, sends the text, and waits for that unique marker. Fresh nonce markers avoid both stale pane matches and prompt-echo matches.

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
```

Exit 0 when the condition is met, 1 on timeout. The JSON lists per-agent `done` and `reason` (`result_updated` | `exited`). Polling happens inside the shell call, so the supervising agent spends one tool call instead of a status loop — this is the token-efficient pattern for fanout supervision.

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
codex-tmux result validate worker --json
codex-tmux result wait-required worker --fields status,summary --wait 60 --json
```

Agents should write `result.json` at `$TMUX_AGENT_DIR/<name>/result.json` with `schema_version: 1`, `status`, `summary`, `artifacts`, `errors`; review workflows may also include optional `verdict` and `decision` blocks. Agents cannot expand `$TMUX_AGENT_RESULT` from sandboxed tool envs; pass the literal path from `result --path <name>` in the worker prompt. Parent branches on `.present` → `.valid` → `.body` in that order. See `references/contracts.md`.

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
3. **Forbid cascade spawning** by writing a literal ban into each worker's prompt body: "Do not call `claude-tmux`, `codex-tmux`, `tmux-agent-fanout`, or `tmux-agent-dialogue`. Do not start background jobs. Do not SSH out. Reason only from provided context and write your result to <the literal path from `result --path <name>`> when done." The wrappers have no kernel-level sandbox; this prompt-level barrier is the only stopgap.
4. **Bound dialogue length.** `critic` and `debate` require positive even `--turns`. Pick a small number (2–6).

For credential-free smoke tests of any preset, use `--agent-a fake --agent-b fake`. Real `codex` / `claude` participants only after explicit user authorization.

Cross-review pattern (workers produce → dialogue reviews): see `references/multi-agent.md`. Fanout details, dialogue presets, SSH participants, participant profiles, and `github-comment` (which never posts without `--post-github-comment`): same file.

Always run `tmux-agent-dialogue validate-transcript --transcript <path>` before summarizing, sharing, or posting a transcript.

## Safety

- The wrappers run their CLIs with permissive flags by default (`--dangerously-skip-permissions` for Claude, `--yolo` for Codex; profiles may set their own `launch_flags`). Do not use them for destructive, privacy-sensitive, externally visible, payment, or irreversible operations without explicit user authorization.
- `claude-tmux status <name>` reports a `diagnostic` when the pane looks like it is waiting for a first-run or permission confirmation. It does NOT auto-accept that prompt.
- Prefer `doctor` and `self-test` before debugging agent behavior; they verify wrapper dependencies and tmux capture/wait without starting a real agent.
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
