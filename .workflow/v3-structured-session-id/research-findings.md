# v3 Phase-S Source Inventory Findings

## (a) Artifacts found per CLI with exact paths

`claude-tmux` and `codex-tmux` are thin shims into the same engine:

- `skills/tmux-agent-tools/scripts/claude-tmux:3` execs `agent-tmux claude`.
- `skills/tmux-agent-tools/scripts/codex-tmux:3` execs `agent-tmux codex`.

So the wrapper-owned local artifacts are the same modulo `<name>` and selected profile:

| CLI | Artifact | Path | Created during `start`? | Notes |
| --- | --- | --- | --- | --- |
| claude | agent state dir | `${TMUX_AGENT_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/tmux-agent-tools}/<name>/` | yes | `agent_root_dir()` defines the root and `ensure_agent_dir()` creates per-agent dirs (`agent-tmux:1243-1258`). |
| claude | result target | `${TMUX_AGENT_DIR:-...}/<name>/result.json` | path exported, existing file removed | `apply_result_env_args()` removes stale `result.json` and exports `TMUX_AGENT_RESULT`; the CLI, not wrapper, writes the final result (`agent-tmux:2575-2583`). |
| claude | session meta sidecar | `${TMUX_AGENT_DIR:-...}/<name>/session-meta.json` | only if `result init` is run before/around start, or later pane capture writes it | `result init` seeds `{schema_version:1, cli_session_id:null}` (`agent-tmux:1753-1768`). `start` passes this path to pane capture (`agent-tmux:2856-2858`) but does not itself seed a structured UUID. |
| claude | usage JSONL | `${TMUX_AGENT_DIR:-...}/<name>/usage.jsonl` unless `--usage <path>` recorded `${TMUX_AGENT_DIR:-...}/<name>/usage-path` | yes | `usage_path_for()` defaults to `<agent>/usage.jsonl`; `usage_init_event()` writes only `{schema_version,event:"usage_init",name,at}` (`agent-tmux:1971-1994`). |
| claude | optional transcript JSONL | caller-provided absolute path from `--transcript <path>`; recorded at `${TMUX_AGENT_DIR:-...}/<name>/transcript-path` | only when `--transcript` is passed | `start` requires an absolute non-existing writable path (`agent-tmux:2641-2648`, `agent-tmux:2774-2792`), records it (`agent-tmux:2835-2839`), and appends a wrapper `start` event (`agent-tmux:2861-2869`). |
| claude | optional audit JSONL | `$TMUX_AGENT_TOOLS_AUDIT_LOG` or explicit leading `--audit-log`; bare `--audit-log` uses `${XDG_STATE_HOME:-$HOME/.local/state}/tmux-agent-tools/audit.jsonl` | only when audit log env/flag is set | `audit_log_append()` is a no-op when `TMUX_AGENT_TOOLS_AUDIT_LOG` is unset (`agent-tmux:2186-2195`). Start emits `{event,tool,name,session,cwd}` when enabled (`agent-tmux:2823-2824`). |
| codex | same as claude | same paths | same | `codex-tmux` uses the same `agent-tmux` engine with the codex profile. |

## (b) Deterministic UUID field/label existence and evidence

No deterministic structured UUID source exists for either bundled Claude or Codex defaults.

Evidence:

- The v3 gate requires a wrapper-owned local source and an explicit field/label boundary before extraction; if none exists, it says to STOP and avoid loose heuristics (`goal-doc.md:56-62`).
- The only existing structured sidecar field is `session-meta.json` `.cli_session_id`, but the wrapper treats it as the destination/read surface, not a source. `result init` seeds it to null (`agent-tmux:1753-1768`), and `result --field .cli_session_id` reads only that sidecar (`agent-tmux:3830-3844`).
- `usage.jsonl` start-time content is only `usage_init` with `schema_version`, `event`, `name`, and `at`; no CLI session ID field or label exists (`agent-tmux:1971-1994`).
- Optional `--transcript` writes a wrapper event with `schema_version`, `event`, `tool`, `name`, `session`, `cwd`, and `at`; no CLI internal session UUID field exists (`agent-tmux:2861-2869`). The `session` value is the tmux session name, not an RFC-4122 CLI session UUID.
- Optional audit start events contain wrapper metadata only: `event`, `tool`, `name`, `session`, and `cwd`, plus audit chain metadata when appended; no CLI internal session UUID field exists (`agent-tmux:2166-2183`, `agent-tmux:2823-2824`).
- Both bundled profiles explicitly leave `session_id_pattern` unset because no verified deterministic session-label format is confirmed: Claude (`profiles/claude.conf:9-14`) and Codex (`profiles/codex.conf:9-14`).
- The documented `session_id_pattern` source is pane output, not a structured transcript/JSONL source; profile docs say to leave it unset when the CLI output format is unknown or unstable (`profiles/README.md:39`).
- Existing pane capture is correctly label-anchored and RFC-4122 validated, but it is opt-in and reads tmux pane text, not structured JSONL (`agent-tmux:1712-1748`).

Per CLI conclusion:

| CLI | Deterministic structured UUID field/label? | Decision |
| --- | --- | --- |
| claude | No | Leave `cli_session_id` null unless an operator opts into pane capture with a verified `session_id_pattern`. |
| codex | No | Leave `cli_session_id` null unless an operator opts into pane capture with a verified `session_id_pattern`. |

## (c) Recommended canonical source order

Use this order, but keep source 1 empty for current bundled Claude/Codex until a real structured source is proven:

1. Structured extractor from a wrapper-owned local transcript/JSONL artifact with an explicit per-CLI field or label-matched event.
2. Opt-in pane capture via `session_id_pattern`, label-anchored and RFC-4122 validated.
3. Leave `cli_session_id` null.

This matches the goal doc precedence (`goal-doc.md:56-62`) and the existing profile guardrail that resume remains unsupported by default for both Claude and Codex (`profiles/claude.conf:9-14`, `profiles/codex.conf:9-14`).

## (d) GO/STOP recommendation for the M-phase extractor

STOP for default Claude/Codex extractor enablement.

Do not implement a loose extractor over `usage.jsonl`, optional `--transcript`, audit logs, `result.json`, or arbitrary pane/blob UUIDs. None of those sources currently provides a deterministic CLI session UUID in an explicit structured field or label-matched JSONL event.

Docs-only/no-default-enablement is the correct Phase-S outcome. A future M-phase is only justified after a concrete CLI-owned or wrapper-owned local artifact is identified with stable field semantics, or after adding fake fixture support for the extractor while leaving bundled Claude/Codex source configuration empty.
