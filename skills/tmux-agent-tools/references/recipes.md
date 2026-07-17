# Recipes

Copy-pasteable workflows. Each one starts from a clean shell — adapt the agent name and paths to your situation.

## Single agent with structured result

```bash
codex-tmux start --exact reviewer ~/repo --transcript /tmp/reviewer.jsonl \
  'Review the latest commit. End by writing $TMUX_AGENT_RESULT with {"schema_version":1,"status":"ok"|"blocked"|"error","summary":"...","artifacts":[],"errors":[]}.'

codex-tmux wait-and-capture --marker '"status"' --tail 5 reviewer 600

codex-tmux result --field '.summary' --wait 10 --json reviewer
codex-tmux stop reviewer
```

The wait-and-capture polls for the moment the agent writes the result, then returns immediately. You never parse scrollback.

## Sentinel + on-exit hook

Run code automatically when the agent CLI exits:

```bash
codex-tmux start --exact builder ~/repo \
  --sentinel /tmp/builder.exit \
  --on-exit 'echo "builder exited with $ON_EXIT_CODE" >> /tmp/build.log' \
  'Build the project, run tests, write result to $TMUX_AGENT_RESULT.'

# In another shell (or the same one, after detaching):
until [[ -f /tmp/builder.exit ]]; do sleep 2; done
echo "exit code: $(cat /tmp/builder.exit)"
```

`ON_EXIT_CODE` is set in the pane's shell when the hook fires. `--on-exit` without `--sentinel` is silently ignored.

## Mid-run human approval gate

```bash
marker=/tmp/agent-7/approve.txt
mkdir -p "$(dirname "$marker")"

codex-tmux wait-and-capture --literal --marker '[NEEDS-APPROVAL]' \
  --pause-until-file "$marker" --pause-timeout 1800 worker
# In another shell:
#   echo approve > "$marker"   → exit 0
#   echo reject  > "$marker"   → exit 7
#   wait 30 minutes             → exit 8
```

While blocked, `$TMUX_AGENT_DIR/worker/approval-status.json` shows `state: "awaiting_approval"`. Transcript and audit log record the decision when those surfaces are enabled.

## Fanout: parallel agents on one prompt

```bash
tmux-agent-fanout run \
  --prompt-file ./review-prompt.txt \
  --agent claude:reviewer-a --workdir ~/repo \
  --agent codex:reviewer-b  --workdir ~/repo \
  --result-dir /tmp/fanout-review \
  --merge-mode all \
  --summary-out /tmp/fanout-summary.json
```

Each agent writes its own `result.json` under `--result-dir`. `--merge-mode all` (default) means the run is `ok` only if every agent succeeded. `--merge-mode first-success` flips the polarity but does **not** kill remaining agents — they keep running so their results are preserved.

If a wrapper fails to exec at all (missing binary, bad arg), fanout synthesizes an error `result.json` immediately and fails fast — no 10-minute hang.

## DAG: dependency-ordered pipeline

Manifest (`pipeline.json`):

```json
{
  "schema_version": 1,
  "fail_fast": false,
  "tasks": [
    {"name": "lint",   "depends_on": [],         "command": "codex-tmux start --exact lint ~/repo 'lint'",   "result_path": "/tmp/lint.json"},
    {"name": "test",   "depends_on": ["lint"],   "command": "codex-tmux start --exact test ~/repo 'test'",   "result_path": "/tmp/test.json"},
    {"name": "deploy", "depends_on": ["test"],   "command": "codex-tmux start --exact dep  ~/repo 'deploy'", "result_path": "/tmp/dep.json"}
  ]
}
```

Run:

```bash
tmux-agent-dag pipeline.json --summary-out /tmp/dag-summary.json
```

Validation runs before any task starts and fails fast on missing dependency, duplicate task name, self-dependency, cycle, or duplicate dep within one task. Task names can contain spaces or special characters — deps are stored with unit-separator delimiting.

`fail_fast: false` means independent branches continue when one task fails; only the failed task's dependent subtree is skipped.

## Bounded two-agent dialogue

```bash
tmux-agent-dialogue --turns 4 --workdir . \
  --agent-a codex --agent-b claude \
  --prompt-file prompt.md \
  --transcript /tmp/dialogue.jsonl

tmux-agent-dialogue validate-transcript --transcript /tmp/dialogue.jsonl
```

Always run `validate-transcript` before summarizing or posting a transcript. Treat the `failure_type` field as diagnostic, not proof of root cause.

For credential-free smoke testing, use `--agent-a fake --agent-b fake`.

### Local critique preset

```bash
tmux-agent-dialogue critic --workdir . --prompt-file review.md --transcript /tmp/critic.jsonl
```

`critic`, `debate`, and `pair-review` default to 4 turns. They do not post comments or merge PRs.

### Prepare a GitHub PR comment without posting

```bash
tmux-agent-dialogue github-comment \
  --transcript /tmp/dialogue.jsonl \
  --github-pr 123 --github-repo owner/repo \
  --max-lines 200 --redact-pattern 'Bearer\s+\S+'
```

Add `--post-github-comment` only when the user explicitly asks to publish.

## SSH: agent CLI runs remote, tmux stays local

```bash
claude-tmux start-ssh --exact review example-host /Users/example/repo \
  'Review the diff and write a summary.'
```

The remote host needs `claude` (or `codex`) on its `PATH`. tmux state stays local so you can `capture` / `status` from your own shell as if it were a local session.

## Read-only inventory across all agents

```bash
tmux-agent-sessions list --json
tmux-agent-sessions list --tool codex --state running
tmux-agent-sessions list --tag project=tradingview
tmux-agent-sessions watch --interval 5
```

`watch` emits one JSONL event per state transition (`session_added`, `session_state_changed`, `session_removed`).

## Bulk cleanup (always preview first)

```bash
tmux-agent-sessions cleanup --preview
tmux-agent-sessions cleanup --execute --tool codex
```

Never run `cleanup --execute --all` unless the user has explicitly authorized killing all tool-owned sessions.
