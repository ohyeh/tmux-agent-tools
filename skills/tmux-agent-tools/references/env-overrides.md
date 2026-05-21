# Environment Overrides

Read this when a wrapper needs to be pointed at a non-default binary, when timing/submit behavior needs tuning, or when shared state needs to land somewhere specific.

## Binary location

| Var | Purpose |
| --- | --- |
| `TMUX=/path/to/tmux` | Override `tmux` binary |
| `CLAUDE=/path/to/claude` | Override `claude` binary |
| `CODEX=/path/to/codex` | Override `codex` binary |

## Session naming and shape

| Var | Purpose |
| --- | --- |
| `CLAUDE_TMUX_PREFIX` / `CODEX_TMUX_PREFIX` | Per-tool session-name prefix |
| `CLAUDE_TMUX_CONF` / `CODEX_TMUX_CONF` | Per-tool tmux config file |
| `CLAUDE_TMUX_MOUSE` / `CODEX_TMUX_MOUSE` | Toggle mouse mode in the generated config |
| `CLAUDE_TMUX_CLIPBOARD` / `CODEX_TMUX_CLIPBOARD` | `auto`, `internal`, or a copy command |

## Timing and waits

| Var | Purpose |
| --- | --- |
| `CLAUDE_TMUX_STABLE_SECONDS` / `CODEX_TMUX_STABLE_SECONDS` | Pane-stable threshold for `wait` |
| `CLAUDE_TMUX_SUBMIT_DELAY` / `CODEX_TMUX_SUBMIT_DELAY` | Delay between send and submit; raise if multiline prompts stay in the input box |
| `CLAUDE_TMUX_STATUS_TAIL_LINES` / `CODEX_TMUX_STATUS_TAIL_LINES` | Lines `status` inspects for the exit-code marker |

## Orchestration and policy

| Var | Purpose |
| --- | --- |
| `TMUX_AGENT_TOOLS_PARTICIPANTS` | Override participant-profile path (see `references/dialogue.md`) |
| `TMUX_AGENT_TOOLS_TENANT` | Multi-tenant prefix; isolates state directories across teams |
| `TMUX_AGENT_WORKTREE_POLICY` | `no-change-cleanup` (default) / `has-change-keep` / `always-keep` |

## Audit log

| Var | Purpose |
| --- | --- |
| `TMUX_AGENT_TOOLS_AUDIT_LOG` | Path to the audit log; presence enables logging |
| `AUDIT_LOG=1` | Enables logging at the default path |
| `TMUX_AGENT_TOOLS_AUDIT_MAX_BYTES` | Rotation threshold (default 10485760) |
| `TMUX_AGENT_TOOLS_AUDIT_RETAIN` | Rotated-segments retained (default 5) |

See `references/observability.md` for the audit log contract.
