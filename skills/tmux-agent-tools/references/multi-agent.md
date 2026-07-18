# Multi-agent coordination

Read this when orchestrating two or more agents — pair-review, critic, debate, dialogue, or fanout. The skill body lists when each preset applies; this file covers the contracts, profiles, and bounded-orchestration discipline.

## Bounded orchestration (read first)

These tools are for **long-running supervised tasks**, not for unbounded agent sprawl. Apply every constraint below before launching anything that spawns more than one worker.

1. **Ask the user for tool + model + effort per worker before any `start`/`start-ssh`/`fanout run`.** Do not assume defaults. Example: "Worker A: claude or codex? which model tier? what reasoning effort?"
2. **Declare an explicit worker upper bound up front** (e.g., "I will run at most 3 workers; if one is insufficient I will report back, not spawn helpers").
3. **Forbid cascade spawning inside worker prompts.** Add a literal instruction to each worker's prompt body: "Do not call `claude-tmux`, `codex-tmux`, `tmux-agent-fanout`, or `tmux-agent-dialogue`. Do not start background jobs. Do not SSH to other hosts. Reason only from the provided context and write your conclusion to <the literal path from `result --path <name>`>." The wrappers have no kernel-level sandbox; this prompt-level barrier is the only stopgap.
4. **Bound the dialogue length.** `critic` and `debate` require positive even `--turns`. Pick a small number (2–6). Unbounded debate is a smell.
5. **Stop and report instead of spawning more workers.** If a task is not making progress, surface that to the user. Do not "try with more workers".

## Persistent teammates (worker reuse)

A fresh worker per task re-pays CLI boot plus repo-context ingestion every time. For sequential same-repo tasks (review -> fix -> re-review chains), reuse one named worker instead.

**Reuse when:** same repo, same domain, sequential bounded tasks, worker's context is still clean (no error/confusion to shed).

**Start fresh when:** different repo or domain, worker context got contaminated by an error or dead end, or the next task needs a different engine (claude vs codex).

**CRITICAL: reset the result before every reused send.** `send-wait` does not clear the previous `result.json`. If you skip the reset, `result wait-required` on the next task returns instantly with the STALE prior result — a false completion, not a timeout.

Reuse loop:

```bash
agent-tmux claude result init worker            # clears result.json to an empty-summary skeleton
agent-tmux claude send-wait worker 'Next task. Write final JSON to the result path when done.'
agent-tmux claude result wait-required worker --fields status,summary --wait 120 --json
```

Use `start --exact <name>` with a stable name up front so the worker stays addressable across the whole chain. Only `stop` the worker at the end of the entire engagement, not between tasks.

## Cross-CLI native integration

The primary integration path is native skill + agent discovery, not MCP. Claude Code reads the repo-root `skills/` bundle and `.claude/agents/*.md` mirrors. Codex CLI 0.142.5 was verified to load project-local skills from `.codex/skills/<name>/SKILL.md` (and also `.agents/skills/<name>/SKILL.md`); this repo exposes `tmux-agent-tools` to Codex through the symlink `.codex/skills/tmux-agent-tools -> ../../skills/tmux-agent-tools`.

Codex subagent definitions are mirrored as validated custom-agent TOML files under `.codex/agents/*.toml`, converted from the existing Claude agent Markdown. The TOML files preserve the same instructions in `developer_instructions`. In local verification, the files pass Codex's official migrated-target validator, but `codex exec` 0.142.5 did not expose those custom names as `spawn_agent` `agent_type` values in a headless session; treat runtime custom-agent spawning as version/host dependent until the host lists the agent type.

`skills/tmux-agent-tools/agents/openai.yaml` exists, but `codex debug prompt-input` verified that a real Codex session's model-visible prompt contained zero references to `display_name`, `openai.yaml`, or `default_prompt`; do not rely on that YAML as an observable Codex integration mechanism.

`mcp-adapter/` remains a secondary option for hosts that explicitly want programmatic MCP tool-calling. It is not required for Claude Code or Codex skill discovery.

## Dialogue presets

All presets share the same local transcript flow. None of them post comments, merge PRs, or publish externally on their own.

| Preset | Default turns | Speaking order | When to use |
| --- | --- | --- | --- |
| `dialogue` (bare) | user-chosen | A then B alternating | Generic two-party exchange where you control every flag |
| `pair-review` | 2 | A reviews, B responds | One reviewer, one responder. `--swap` to flip. `--summary-file` for local Markdown summary |
| `critic` | 4 (must be positive even) | A odd turns, B even | Bounded critique/response loop — A critiques, B responds, A critiques again, B responds. No winner. |
| `debate` | 4 (must be positive even) | A odd turns, B even | Bounded back-and-forth argument. No winner selection. No arbitration. |

For dry-runs and credential-free smoke tests, use `--agent-a fake --agent-b fake`. Real `codex`/`claude` participants only run with explicit user authorization.

## Worker → dialogue bridge pattern (eval-1 gap)

A common pattern is: spawn two workers in parallel, then have them review each other's output through a dialogue preset. The wrappers do NOT auto-feed worker pane contents into the dialogue — you bridge manually:

```bash
# 1. Start workers
claude-tmux start --exact wA ~/repo 'Refactor src/auth/. Write final JSON to the literal result path from result --path wA with summary+diff path.'
claude-tmux start --exact wB ~/repo 'Run tests for src/auth/. Write final JSON to the literal result path from result --path wB with pass/fail+failing-test list.'

# 2. Wait for both workers with one bounded watcher, then read results
claude-tmux watch --all --timeout 600 --json wA wB > /tmp/watch.json
claude-tmux result --json wA > /tmp/wA.json
claude-tmux result --json wB > /tmp/wB.json

# 3. Build a review prompt that includes both results
cat > /tmp/review-prompt.md <<EOF
Worker A produced this refactor: $(jq -r .summary /tmp/wA.json)
Worker B observed these test results: $(jq -r .summary /tmp/wB.json)
Review whether A's diff is consistent with B's observations. Do not call any tmux-agent-tools wrappers. Do not start workers.
EOF

# 4. Run the cross-review dialogue
tmux-agent-dialogue pair-review --workdir ~/repo \
  --prompt-file /tmp/review-prompt.md \
  --transcript /tmp/cross-review.jsonl \
  --agent-a fake --agent-b fake   # use real claude/claude for real run
```

## Commander loop (shrinking fleet)

When workers finish at different times, do not sleep/poll. Before each watch, check `result --json <name>` for every remaining worker; `watch` reports `result_updated` only for results written after it was armed, so workers that finished before re-arming must be collected before the next watch. Then arm one bounded `watch --any --timeout <s> --json` for the still-absent names; repeat until none remain.

```bash
remaining=(w1 w2 w3)
while (( ${#remaining[@]} )); do
  absent=()
  for n in "${remaining[@]}"; do
    if codex-tmux result --json "$n" | jq -e '.present' >/dev/null; then
      codex-tmux result --json "$n" > "/tmp/$n.result.json"
      codex-tmux stop "$n"
    else
      absent+=("$n")
    fi
  done
  (( ${#absent[@]} == 0 )) && break
  codex-tmux watch --any --timeout 600 --json "${absent[@]}"
  remaining=("${absent[@]}")
done
```

## Marker contract for real-agent dialogue

Real dialogue prompts use a split marker. The participant must end each turn with one standalone final line containing only the joined marker. Keep the literal out of the sent prompt or split it in the prompt instructions so the prompt echo cannot satisfy the wait.

If a marker wait times out, inspect the emitted `failure` JSONL event and the captured pane tail once, then stop and report the blocker. Do not loop marker waits. `failure_type` is conservative diagnostic metadata, not proof of root cause.

`critic` and `pair-review` do NOT document a separate marker contract — they reuse the dialogue split-marker pattern internally.

## Validating a transcript

Run before summarizing, sharing, or posting any transcript:

```bash
tmux-agent-dialogue validate-transcript --transcript <path>
```

This checks `schema_version=1` and structural correctness of the JSONL.

## Participant profiles

Profiles live at `~/.config/tmux-agent-tools/participants.json` by default, or at `TMUX_AGENT_TOOLS_PARTICIPANTS` / `--participants-config <path>`. Each top-level profile may contain only `agent`, `ssh`, `workdir`, `timeout`, and `env`; command-line flags override profile values.

- `timeout` must be a positive integer string in seconds; applies only when the run does not pass `--timeout`.
- `env` must be an object of newline-free string values keyed by shell environment names; passed to the local wrapper/session process.
- For SSH participants, remote environment behavior depends on SSH and remote shell configuration. Do not rely on profile `env` as a secret transport.
- Use only generic, reusable defaults. Do not encode personal project shortcuts in public docs or examples.

## SSH participants

One real agent can run remotely while tmux stays local:

```bash
tmux-agent-dialogue --turns 2 --workdir . \
  --agent-a codex --agent-a-ssh example-host --agent-a-workdir /srv/github/project \
  --agent-b claude \
  --prompt-file prompt.md --transcript transcript.jsonl
```

Only real `codex` or `claude` participants can use `--agent-a-ssh` / `--agent-b-ssh`. `fake` is local-only. Remote workdirs must be absolute paths on the target host.

## github-comment (no posting by default)

For any existing `dialogue`, `pair-review`, `critic`, or `debate` transcript, prepare a GitHub PR comment body without posting:

```bash
tmux-agent-dialogue github-comment --transcript review.jsonl --github-pr 123 --github-repo owner/repo
```

Only add `--post-github-comment` when the user explicitly asks to publish.
Use `--max-lines`, `--max-bytes`, and repeated `--redact-pattern` on `summarize` or `github-comment` when transcript content may be too large or sensitive to share raw. The generated Markdown includes visible truncation and redaction notes.

## Fanout (one-to-many)

`tmux-agent-fanout run` spawns one agent per `--agent tool:name` (mix `claude:` and `codex:` in a single call) or one per `--workdir` (legacy single-tool form). Each child writes its own `result.json` under `--result-dir`; the parent emits a consolidated summary on stdout (schema: `schemas/fanout-summary.schema.json`). The summary and per-child results are authoritative; do not scrape child panes in a fanout loop.

```bash
tmux-agent-fanout run \
  --prompt-file ./prompt.txt \
  --agent claude:reviewer --workdir ~/repo \
  --agent codex:refactor  --workdir ~/repo \
  --result-dir /tmp/fanout-demo \
  --merge-mode all
```

- `--merge-mode all` (default): `ok=true` iff every agent succeeds.
- `--merge-mode first-success`: `ok=true` if any agent succeeds. Remaining agents continue (they are NOT killed) and are still recorded in the summary.
- Failure isolation: each agent's `result.json` is preserved on disk even if a sibling fails or times out.
- The wrappers have no `--no-cascade` flag. Enforce no-cascade by writing it into the prompt sent to every child.

Daemon / async / supervisor-tree / cross-agent cancellation are deferred. See `docs/design-issue-184-fanout.md`.
