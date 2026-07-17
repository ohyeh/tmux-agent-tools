# Core workflow (single worker, full detail)

Read this for the complete start -> send -> wait -> inspect -> result -> stop walkthrough, including flags and edge cases. The main SKILL.md has the condensed one-line version for the common path.

## Supervising an existing worker: listen before send

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

## 1. Start

```bash
codex-tmux start --exact worker ~/github/project 'Read the repo and report the failing test. Write final JSON to the wrapper-provided result path when done.'
claude-tmux resume --exact worker ~/github/project ee5aca88-a1af-48d3-af21-54f60d618f22
```

Use `start --dry-run` first when validating a new profile, `--result-schema`, or launch flags; it prints the resolved invocation and exits without creating a tmux session.

### Session naming

- Without `--exact`, `start` appends a random suffix to avoid collisions.
- With `--exact`, the session uses the requested name exactly under the tool prefix.
- **Single caller per agent name.** Two `start --exact same-name` kills the first. Wrapper state under `$TMUX_AGENT_DIR/<name>/` is NOT lock-protected (see `references/contracts.md` concurrency model).

### Remote sessions

`start-ssh` when the target repo is on another host (tmux stays local, the CLI runs over SSH):

```bash
claude-tmux start-ssh --exact review example-host ~/github/project 'Review the diff and return findings only.'
```

Requirements: local `tmux`; remote shell can resolve `claude` or `codex` on `PATH`; SSH target preconfigured.

## 2. Send follow-up work without attaching

```bash
codex-tmux send worker 'Now implement the smallest fix and run the targeted test.'
codex-tmux send-wait worker 'Summarize the current blocker in result.json.' 180
```

Use `send-wait <name> <text> <timeout>` for marker-driven orchestration. It generates a fresh nonce, appends the instruction to end with that nonce, sends the text, and waits for that unique marker. Fresh nonce markers avoid both stale pane matches and prompt-echo matches.

### Sending so it actually submits

Bare `send` pastes the text and fires an `Enter` after the submit delay — and a second `Enter` after another delay when the prompt contains a newline (`paste_and_submit`) — using `<NS>_TMUX_SUBMIT_DELAY` (e.g. `CODEX_TMUX_SUBMIT_DELAY`, falling back to `AGENT_TMUX_SUBMIT_DELAY`; default `0.2s`). On a busy or slow-rendering TUI that Enter can land before the input box is ready — it inserts a newline or is swallowed, and the prompt stays in the box **unsent**. This is the "I sent it but nothing happened" failure; it is silent unless you verify.

Make submission verifiable, never assumed:

- **Default to `send-wait`.** It generates a *fresh nonce*, appends "end with this nonce" to your prompt, sends, and waits for that unique marker — so the marker only appears once the prompt is accepted and the worker answers. Marker arrives -> it submitted and ran. No marker by the timeout means submission is *unconfirmed* — not proven failed; the worker may simply be slow or stuck. Distinguish before resending: `status --json` (still `running`?) plus `probe --metric <metric> <name>` for the busy signal (`--metric tool_active` for codex/generic, `--metric active_spinner` for claude) — `status` and `ping` expose none. Resend the same `send-wait` only if it is idle or not progressing — that liveness check, not the nonce, is what keeps this safe (the fresh nonce only stops a stale marker from matching; it does not make the worker's action idempotent, so a resend after a prompt that *did* land would run it twice). If it is actively working, keep waiting.
- **`send-wait-literal` needs a *unique* literal.** Unlike `send-wait`, it does not generate a marker — it records the literal's occurrence count before sending and waits for that count to rise, so existing pane content cannot satisfy it. The real caveat is a non-unique literal: if unrelated later output also emits it, that counts as the new occurrence and false-positives. Choose a literal unlikely to appear except in the worker's reply.
- **If you must use bare `send`, verify with a capture.** `capture --strip-ansi <name> 20`: if your prompt text still sits on the input line, it was not submitted — resend. `status --json` has **no** busy field and `ping` only proves the pane responds (`ok`/`timeout`/`dead`); for a positive "is it working" signal use the busy-signal `probe` described above.
- **Tune the delay for heavy TUIs.** If non-submission keeps happening for a given CLI, raise its submit delay per that CLI's namespace or universally: `CODEX_TMUX_SUBMIT_DELAY=0.6` (or `CLAUDE_TMUX_SUBMIT_DELAY=0.6`, or `AGENT_TMUX_SUBMIT_DELAY=0.6` for all CLIs). Slower is more reliable; trade latency for landing the prompt.
- **Never re-fire raw `tmux send-keys Enter` to "nudge" it.** That is the bypass rule #1 forbids and it desyncs the engine's view of the pane. Resend through `send-wait` instead.

## 3. Wait with a bounded wrapper call

Every blocking wait needs a timeout; never write shell `sleep`, `while status ...`, or hand-rolled capture polling loops.

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

### Engine-agnostic resolution & mixed fleets

The commands `watch`, `result`, and `status` resolve sessions by NAME.
- **Result path resolution** is fully engine-independent; `result` paths are resolved as `$TMUX_AGENT_DIR/<name>/result.json` using the bare session name.
- **Tmux session presence checks** (used in `status` and `watch` exited liveness checks) are prefix-dependent; they prepend the active wrapper CLI's prefix (e.g. `codex-cli-`, `claude-cli-`, `agy-cli-`).
- Any `agent-tmux <cli> watch` command will successfully detect when a session's `result.json` is updated regardless of which wrapper/engine started it (`reason:result_updated` is always engine-agnostic), but it will report a session from a **different** wrapper/engine as `reason:exited` while the session is still running — a **false positive** caused by mismatched tmux prefixes (e.g. a codex-tmux watch cannot see an `agy-cli-*` tmux session). Only trust `reason:exited` when all workers were started by the same wrapper family.
- **Preferred neutral entrypoint:** For heterogeneous fleets (mixed codex+agy+claude workers), `tmux-agent-sessions` is the preferred engine-neutral inventory and supervision surface (resolve/list/watch by name across all wrappers). It supports `--tool agy` natively and recognises `agy-cli-*` sessions alongside `claude-cli-*`, `codex-cli-*`, and `tmux-agent-dialogue-*`.

Example: Watching a mixed fleet containing a `codex` and an `agy` session (`ios-deliv` and `ios-native`):
```bash
agent-tmux codex watch --all --timeout 900 --json ios-deliv ios-native
```
Output JSON shape:
```json
{
  "schema_version": 1,
  "mode": "all",
  "met": true,
  "agents": [
    {
      "name": "ios-deliv",
      "done": true,
      "reason": "result_updated"
    },
    {
      "name": "ios-native",
      "done": true,
      "reason": "exited"
    }
  ]
}
```

For team state, `team quorum <team> --count N [--field <jq> --value <literal>] --json` counts present, valid worker results using each worker row's stored `result_path`. Use `--field .status --value success` to require a specific result value.

If `watch` times out, run one structured liveness pass per worker: `status --json`, then `ping --json --timeout 5` for workers with `running:true` and high `idle_seconds`, then `result --json --wait 30`. If `diagnostic` shows an approval/permission prompt, attach and answer only with authorization. If ping fails and no result appears, report the worker as stalled with status JSON and one `capture --strip-ansi <name> 80` diagnostic tail.

`wait-text` is literal-by-default. Add `--regex` only when you intentionally want regex matching. Literal markers may contain regex metacharacters like `[`, `]`, `(`, `)`, `.`, `*`, or `?` without escaping.

For **alternation markers** (e.g. wait for `[DONE]` OR `Need approval`), use `wait-and-capture --regex --marker` with an escaped regex; do not race two raw wait calls. See `references/cheatsheets.md` for worked marker pitfalls.

## 4. Inspect, probe liveness, or clean up

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

## 5. Read the agent's structured result

```bash
codex-tmux result --field '.status' --wait 30 --json worker
codex-tmux result --field '.cli_session_id' --wait 30 worker
codex-tmux result validate worker --json
codex-tmux result wait-required worker --fields status,summary --wait 60 --json
```

Agents should write `result.json` at `$TMUX_AGENT_DIR/<name>/result.json` with `schema_version: 1`, `status`, `summary`, `artifacts`, `errors`; review workflows may also include optional `verdict` and `decision` blocks. For `result_path_via_prompt=true` families (Codex and generic by default), the **first** prompt-bearing start/send injects the literal path **once per session** (sandboxed tool envs cannot expand `$TMUX_AGENT_RESULT`); follow-up sends and `send --raw` keystrokes are never prefixed, so answering a TUI prompt with a single key stays clean (#283). Use `result --path <name>` as the debug surface. Parent branches on `.present` -> `.valid` -> `.body` in that order. See `references/contracts.md`.

`cli_session_id` is not stored in `result.json`; `result --field .cli_session_id` reads the per-session `session-meta.json` sidecar so resume can work before the worker writes a final result. `--result-schema <abs.json>` on `start`/`resume` persists a schema path for `result validate`; profile `result_required_fields` supplies the default required-field contract for `result wait-required`.

Stall fallback: if `status --json` reports `running:true` with high `idle_seconds` and `ping` times out, send one bounded recovery prompt with `send-wait`: "Write result.json now with status blocked and the current blocker." Then read `result wait-required worker --fields status,summary --wait 60 --json`. If that also times out, stop waiting and report stalled with structured status plus one diagnostic capture tail.

## Peer-review loop

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

## Recovering from accidental session creation

Capture a timestamp before the risky operation and then use the session inventory helpers:

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
# Operator (another shell): echo approve > "$marker"  -> exit 0
#                           echo reject  > "$marker"  -> exit 7
# Timeout fires             ->                            exit 8
```

While blocked, `$TMUX_AGENT_DIR/<name>/approval-status.json` reports `state: "awaiting_approval"`. Use this gate for any destructive/irreversible action a worker is about to take. Full state-file and exit-code reference: `references/contracts.md`.

## Orchestrator playbook (multi-agent collaboration)

Before spawning more than one worker — including any `dialogue` / `pair-review` / `critic` / `debate` / `fanout` — the bounded-orchestration rules (ask tool/model/effort up front, declare a worker upper bound, forbid cascade spawning, bound dialogue length) and the cross-review pattern live in `references/multi-agent.md`. Read that file before any multi-worker orchestration.

Always run `tmux-agent-dialogue validate-transcript --transcript <path>` before summarizing, sharing, or posting a transcript.

## Auto-delegation via tmux-delegate

Claude Code can use the `tmux-delegate` subagent as the decision gate for substantial work. Discovery depends on how this bundle is loaded: installed as a plugin, the subagent ships at the plugin root `agents/tmux-delegate.md` and is addressable as `tmux-delegate` (qualified `tmux-agent-tools:tmux-delegate`); in a checked-out repo, the same agent is at `.claude/agents/tmux-delegate.md`. The two files are kept byte-for-byte in sync (a smoke test fails on drift). Note the lifecycle: editing a subagent file requires a session restart to re-register it, and changing other plugin components requires `/reload-plugins` — adding the agent mid-session does not take effect. It delegates when the task is likely to take more than 30s, modifies 2 files or more, needs an independent context window, requires a multi-step read-plan-write cycle, or runs tests/builds/lint across the codebase. It handles inline for single-file reads/searches/formatting, one-liners with immediate output, explicit "quick"/"inline" requests, and marginal cases.

`tmux-delegate` must include this literal worker constraint in every delegated prompt: "Do not spawn additional tmux sessions or delegate further." It uses a hardcoded wrapper command skeleton instead of interpolating raw task text into Bash. Resume (v2): after `start`, a background capture may populate `session-meta.json` with a `cli_session_id` UUID — read it with `jq -r .cli_session_id "$TMUX_AGENT_DIR/<name>/session-meta.json"` or `result --field .cli_session_id`, then use it with `resume` if non-null. Bundled `claude.conf` and `codex.conf` ship `session_id_pattern` UNSET — resume is unsupported by default (guardrail: no verified deterministic session-label format confirmed across versions). Operators opt in per-CLI by setting `session_id_pattern` to a label-anchored ERE (e.g. `session_id_pattern=Session ID:`) in a user-local profile once they know the exact label line their version prints. Capture is label-anchored + UUID-validated (decoy UUIDs on non-matching lines are ignored).
