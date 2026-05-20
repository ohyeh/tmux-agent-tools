# Design — Issue #97: Result-file convention and `result` subcommand

Status: draft, not implemented. Builds on #95 (sentinel) and is the natural
caller-owned artifact layer above the completion primitive.
Tracking: https://github.com/ohyeh/tmux-agent-tools/issues/97
Related: RFC #109 L2 Interface; depends on #95 sentinel for "done" signal.

## Problem

Right now there is no project-wide convention for where a child agent
writes its structured result. Each caller invents its own filename and
schema. That blocks cross-skill reuse and forces parent agents to parse
pane text — the most token-expensive option.

## Goal

Define one path convention, one minimal schema, and one `result`
subcommand. Once #95 fires (sentinel written = CLI exited), the parent
reads exactly one file to know what happened.

Non-goals:

- no validation of arbitrary user-defined fields beyond a couple of
  required ones — keep the schema permissive;
- no automatic JSON Schema enforcement (defer to #125 `--result-schema`);
- no remote (ssh) result handling — local first, follow-up issue for ssh.

## Path convention

Two new wrapper-exported env vars:

```
TMUX_AGENT_NAME=<short-name>
TMUX_AGENT_RESULT=$TMUX_AGENT_DIR/<short-name>/result.json
```

Where `TMUX_AGENT_DIR` defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/tmux-agent-tools`.

The wrapper creates `$TMUX_AGENT_DIR/<short-name>/` on start. Existing
contents are preserved so a parent can pre-write inputs into the same
directory, but `result.json` is removed at start to avoid stale reads.

Why a per-name directory and not a single shared file:

- avoids name collision across concurrent agents;
- gives a natural place to drop `errors.log`, `artifacts/`, etc., later
  without inventing more conventions.

## Schema (v1, intentionally minimal)

```json
{
  "status": "ok",
  "summary": "string",
  "errors": [],
  "artifacts": []
}
```

Required:

- `status`: one of `ok`, `error`, `partial`. Anything else is treated as
  `error` by the `result` reader.
- `summary`: non-empty string.

Optional:

- `errors`: array of strings; empty when `status == ok`.
- `artifacts`: array of `{path, role?, sha256?}` objects pointing at
  files the child produced.

Schema version: implicit `v1`. Schema-version negotiation is #125.

## `result` subcommand

```
<wrapper> result <name> [--field <jq-path>] [--wait <seconds>] [--json]
```

| Flag | Behavior |
|---|---|
| (no flag) | Print the entire `result.json` content. Exit non-zero if file missing. |
| `--field <jq>` | Extract a single field via `jq -r '<jq>'`. If path missing in JSON, exit non-zero. |
| `--wait <s>` | Block until the file exists or timeout. Use `fswatch -1` on macOS, `inotifywait -e create` on Linux. If neither is available, fall back to 1-second polling with a single warning to stderr. |
| `--json` | Wrap the result content in metadata: `{path, mtime, bytes, body: ...}`. Composable with `--wait` and `--field`. |

`--wait` and `--field` can compose: wait first, then extract.

## Relationship to #95

| Concern | #95 sentinel | #97 result |
|---|---|---|
| Question answered | "Did the CLI exit?" | "What did the agent produce?" |
| Authoritative file | `$SENTINEL` | `$TMUX_AGENT_RESULT` |
| Write owner | wrapper | the agent's prompt (caller-owned) |
| Required for completion | yes (mechanism) | no (convention) |
| Format | decimal int + newline | JSON |

Parent flow becomes:

```sh
codex-tmux start --exact --sentinel "$SENT" --on-exit "$RESULT_READER" worker /path
while [[ ! -f "$SENT" ]]; do sleep 1; done
status=$(codex-tmux result worker --field .status)
```

## SKILL.md addendum (proposed wording)

> When this skill exits, write the final structured result to
> `$TMUX_AGENT_RESULT` as JSON with at least `status` and `summary`,
> then print `[DONE]` on a separate line. The parent will read the file
> after the sentinel fires; never re-print the full result to the pane.

## Rollout

1. Land docs + schema (this file).
2. Wire `TMUX_AGENT_NAME` / `TMUX_AGENT_RESULT` env into `start` /
   `resume` (already use `session_env_args`).
3. Add `result <name>` subcommand without `--wait` / `--field` /
   `--json` first.
4. Add `--field` (jq dependency already present).
5. Add `--wait` with fswatch/inotifywait/polling fallback.
6. Add `--json` wrapper.
7. Mirror to claude-tmux.
8. Add example to README + SKILL.md addendum.

## Risk and trade-offs

- Picking `$XDG_STATE_HOME` default vs the issue's
  `~/.tmux-agent/<name>/`: chose XDG for cross-platform tidiness, but
  the env var `TMUX_AGENT_DIR` lets the user keep the simpler `~/.tmux-agent/`
  path if preferred. Either path stays a single conventional location;
  the path is not negotiated per call.
- Removing `result.json` at start prevents stale reads but also prevents
  "resume and read last result" use cases. Mitigation: provide
  `--no-clean-result` flag if/when a real user hits this need; do not
  add prophylactically.
- Schema is permissive (no JSON Schema enforcement). #125 will add
  `--result-schema` so callers can opt into strict validation.
