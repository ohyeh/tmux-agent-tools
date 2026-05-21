# Observability: Audit Log and Secret Injection

Read this for the audit log surface and `--secret KEY=URI` injection. Both share a redaction contract: secret values must never appear in capture output, transcript, or audit log — only the secret's name and backend label do.

## Audit log

Both wrappers can write a hash-chained JSONL audit log. Each line includes the previous line's hash so tampering with history is detectable via `verify`.

### Enablement

Any of these enables the log:

- `--audit-log [PATH]` flag on `claude-tmux start` / `codex-tmux start`
- `AUDIT_LOG=1` env (uses default path)
- `TMUX_AGENT_TOOLS_AUDIT_LOG=/path/to/audit.jsonl` env (explicit path; pre-existing surface)

Default path: `${XDG_STATE_HOME:-$HOME/.local/state}/tmux-agent-tools/audit.jsonl`.

### Operator surface

The `tmux-agent-audit` binary exposes:

```bash
tmux-agent-audit verify [--log PATH]
tmux-agent-audit query  [--since ISO] [--until ISO] [--tenant T] \
                        [--agent A] [--tool T] [--event E] [--log PATH]
tmux-agent-audit rotate [--log PATH] [--force]
tmux-agent-audit path
```

`verify` is rotation-aware: it walks the active log and any rotated-out segments, reconstructing the chain across files. Tampering anywhere in the history is detected.

### Rotation

Size-triggered. Defaults:

- `TMUX_AGENT_TOOLS_AUDIT_MAX_BYTES=10485760` (10 MB)
- `TMUX_AGENT_TOOLS_AUDIT_RETAIN=5`

Rotation is locked (flock when available, mkdir-fallback otherwise) so concurrent appenders and rotators do not break the chain. An `audit.rotation` HEAD-link record preserves the hash chain across the rename so cross-file verification still works.

### Event coverage

Schema (`schema_version: 1`) is in `docs/design-issue-188-audit-surface.md`. Covered events:

- `wrapper.start`, `wrapper.stop`, `wrapper.send`
- `hook.allow`, `hook.reject`, `hook.run`
- `secret.read` (carries `secret_name` and `backend`, never the value)
- `approval.approve`, `approval.reject`, `approval.timeout`
- `fuse.max_trigger`

Legacy event names (pre-namespacing) are auto-mapped to `wrapper.<verb>` so existing consumers keep working.

## Secret injection

`claude-tmux start` and `codex-tmux start` accept repeated `--secret KEY=URI` to inject values into the tmux session env. The URI scheme picks the backend; the resolved value is exported as `$KEY` to the agent CLI.

### Supported backends

| URI | Backend | Notes |
| --- | --- | --- |
| `file:<path>` | Read file contents | Trailing newlines trimmed for matching only; full value injected into env. |
| `<path>` (bare) | Same as `file:` | Back-compat shorthand. |
| `env-file:<path>` | Dotenv loader | Reads `KEY=value` from the file. |
| `op://<vault>/<item>/<field>` | 1Password CLI | Requires `op` on `PATH`. |
| `keychain:<account>/<service>` | macOS Keychain | Requires `security` (macOS only). |

### Fail-fast preflight

If a referenced backend CLI is missing or the secret cannot be resolved, the wrapper exits with a clear diagnostic and code 4 **before** any tmux session is created. This avoids leaving a half-configured session that the agent will fail against.

### Redaction

Registered secret values are redacted from `capture` output and transcript events as `[REDACTED:KEYNAME]`. The matcher handles multi-line values (PEM keys, multi-line tokens) and treats the secret as a literal string, not a regex — so secrets containing regex metacharacters cannot self-corrupt the matcher.

`--secret-redact=false` bypasses redaction for debugging; the wrapper prints a loud stderr warning when this is active. Do not use it in committed workflows.

### Audit interaction

When the audit log is enabled, secret resolution emits a `secret.read` event containing only `secret_name` and `backend` — never the value, never the path.

### Safe example

```bash
codex-tmux start \
  --secret OPENAI_API_KEY=op://Personal/OpenAI/credential \
  --audit-log \
  agent-x ~/work
```

This pulls the key from 1Password, redacts it from capture/transcript, and records the read in the audit chain — with zero plaintext leakage in any operator-visible surface.
