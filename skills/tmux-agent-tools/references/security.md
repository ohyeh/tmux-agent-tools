# Security, secrets, and audit

Read this when injecting secrets into a worker session, enabling the audit log, or tuning environment overrides.

## Why this matters

Both wrappers launch agent CLIs with permissive flags: Claude uses `--dangerously-skip-permissions`; Codex uses `--yolo`. These are intentional for managed long-running tasks but they remove every interactive safety prompt. Always confirm with the user before destructive, externally visible, payment, or irreversible work.

`status --json` sets `confirmation_detected:true` with a `blocked_reason` (`permission_prompt`, `approval_prompt`, `login_prompt`, `hook_trust_prompt`, …) when the pane looks like it is waiting for confirmation — including a plugin hook-trust prompt ("N hooks need review … Press t to trust"). It does NOT auto-accept. Answer a trusted single-key prompt with `send --raw <name> t` only after you trust it.

## Secret injection (`--secret KEY=URI`)

`claude-tmux start` and `codex-tmux start` accept `--secret KEY=URI` to inject a value into the tmux session env. Backends:

- `file:<path>` — read value from a local file
- bare `<path>` — back-compat alias for `file:`
- `env-file:<path>` — parse a `KEY=VALUE`-per-line file
- `op://...` — 1Password `op read` (CLI must be on PATH and signed in)
- `keychain:<account>/<service>` — macOS Keychain via `security`

Missing backend CLI or missing key/file aborts with a non-zero exit BEFORE the tmux session is created. This is intentional fail-closed behavior so a missing secret can never silently launch an unauthenticated worker.

Registered secret values are redacted from `capture` output and transcript events as `[REDACTED:KEYNAME]`. Use `--secret-redact=false` to bypass for debugging only (the wrapper prints a loud stderr warning).

When `TMUX_AGENT_TOOLS_AUDIT_LOG` is set, a `secret.read` event records the key and backend label only — never the value.

```bash
codex-tmux start --secret OPENAI_API_KEY=op://Personal/OpenAI/credential \
  agent-x ~/work
```

## Audit log

Both wrappers can write a hash-chained JSONL audit log. Enable with `TMUX_AGENT_TOOLS_AUDIT_LOG=1`, `AUDIT_LOG=1`, or `--audit-log [PATH]`.

Default log path: `${XDG_STATE_HOME:-$HOME/.local/state}/tmux-agent-tools/audit.jsonl`.

Rotation:

- `TMUX_AGENT_TOOLS_AUDIT_MAX_BYTES` (default `10485760` = 10 MiB)
- `TMUX_AGENT_TOOLS_AUDIT_RETAIN` (default `5` rotated files kept)

Operator surface via `tmux-agent-audit`:

```bash
tmux-agent-audit verify [--log PATH]
tmux-agent-audit query  [--since ISO] [--until ISO] [--tenant T] \
                        [--agent A] [--tool T] [--event E] [--log PATH]
tmux-agent-audit rotate [--log PATH] [--force]
tmux-agent-audit path
```

Event schema (`schema_version: 1`) and rotation semantics: `docs/design-issue-188-audit-surface.md`.

`secret.read` events carry only `secret_name` + `backend`, never the value.

## Environment overrides

| Variable | Purpose |
| --- | --- |
| `TMUX=/path/to/tmux` | Override tmux binary |
| `CLAUDE=/path/to/claude` | Override Claude CLI binary |
| `CODEX=/path/to/codex` | Override Codex CLI binary |
| `CLAUDE_TMUX_PREFIX` / `CODEX_TMUX_PREFIX` | tmux session name prefix per tool |
| `CLAUDE_TMUX_STABLE_SECONDS` / `CODEX_TMUX_STABLE_SECONDS` | How long pane must be quiet to count as stable |
| `CLAUDE_TMUX_SUBMIT_DELAY` / `CODEX_TMUX_SUBMIT_DELAY` | Raise when multiline prompts sit in CLI input box without submitting |
| `CLAUDE_TMUX_CONF` / `CODEX_TMUX_CONF` | Per-tool tmux config file |
| `CLAUDE_TMUX_MOUSE` / `CODEX_TMUX_MOUSE` | Enable mouse mode |
| `CLAUDE_TMUX_CLIPBOARD` / `CODEX_TMUX_CLIPBOARD` | `auto`, `internal`, or a copy command |
| `CLAUDE_TMUX_STATUS_TAIL_LINES` / `CODEX_TMUX_STATUS_TAIL_LINES` | Lines included in `status` output |
| `TMUX_AGENT_TOOLS_PARTICIPANTS` | Override participant profile path |
| `TMUX_AGENT_TOOLS_AUDIT_LOG` / `AUDIT_LOG` | Enable audit log |
| `TMUX_AGENT_TOOLS_AUDIT_MAX_BYTES` | Audit log rotation byte cap |
| `TMUX_AGENT_TOOLS_AUDIT_RETAIN` | Audit log rotation count |

## Pre-flight checks

Before debugging agent behavior, prefer:

```bash
codex-tmux doctor      # verify wrapper dependencies
codex-tmux self-test   # verify tmux capture/wait without spawning real CLI
codex-tmux status --json worker
codex-tmux ping --json --timeout 5 worker
```

`doctor` and `self-test` do not start a real agent and surface 90% of "why didn't it work" issues. For an existing worker, use structured `status`/`ping` before pane capture.
