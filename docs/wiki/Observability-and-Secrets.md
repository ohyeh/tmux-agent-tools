# Observability and Secrets

Three surfaces work together to keep agent runs inspectable without leaking what shouldn't leak: **transcript** (per-agent), **audit log** (operator-level chain), and **`--secret` injection** (env vars, never the command line).

## Transcript: per-agent event log

```bash
agent-tmux codex start --exact worker ~/repo --transcript /tmp/worker.jsonl '...'
```

Every wrapper event is appended as JSONL: `start`, `send`, `wait_*` (matched / timeout / stable / session_gone), `capture`, `stop`. Each line carries `schema_version: 1`, ISO-8601 UTC timestamp, and event-specific fields.

For oversized text payloads, opt into truncation:

```bash
agent-tmux codex start --exact worker ~/repo \
  --transcript /tmp/worker.jsonl \
  --transcript-text-truncate 1024 \
  '...'
```

When a `send` text exceeds the threshold, the transcript records `text: "[truncated, original X bytes]"` plus `text_sha256` and `text_bytes` instead of the verbatim payload.

For first-class multi-line injection, use:

```bash
agent-tmux codex send --from-file /abs/handoff.md --enter-count 3 worker
```

The `send --from-file` transcript event carries `multiline: true`, `bytes`, and
`text_sha256`. If audit logging is enabled, the audit event is `send.multiline`
and records only size/hash metadata, never the prompt body.

### Validating a transcript

```bash
tmux-agent-replay fixture-validate /tmp/worker.jsonl
```

Checks: all lines parse, all entries carry `schema_version: 1`, all timestamps are ISO-8601 UTC, at least one `start` event present.

### Diffing two transcripts

```bash
tmux-agent-replay diff a.jsonl b.jsonl --json
```

Reports send delta, wait outcomes, marker sequences.

### Redacting before sharing

```bash
tmux-agent-replay redact in.jsonl --output redacted.jsonl --pattern 'company-secret-\S+'
```

Default regex set already scrubs AWS keys, GitHub tokens, `api_key=`, `password=`, `Bearer`. Add your own with repeated `--pattern`.

## Audit log: hash-chained operator surface

Tamper-evident, append-only JSONL log spanning all agents. Each line includes the previous line's hash so any retro-edit is detectable.

### Configure

Audit logging is enabled by default. Use these overrides when needed:

```bash
# Per-invocation flag (recommended):
agent-tmux codex start --audit-log --exact worker ~/repo '...'

# Explicit path (pre-existing surface):
TMUX_AGENT_TOOLS_AUDIT_LOG=/var/log/tmux-agent.audit.jsonl agent-tmux codex start --exact worker ~/repo '...'

# Explicit opt-out:
AUDIT_LOG=0 agent-tmux codex start --exact worker ~/repo '...'
```

Default path: `${XDG_STATE_HOME:-$HOME/.local/state}/tmux-agent-tools/audit.jsonl`.

### Operator surface

```bash
# Where am I writing?
tmux-agent-audit path

# Is the chain intact?
tmux-agent-audit verify

# Query events
tmux-agent-audit query --event approval.reject
tmux-agent-audit query --since 2026-05-21T00:00:00Z --tool claude
tmux-agent-audit query --tenant team-a --agent worker

# Force a rotation
tmux-agent-audit rotate
```

`verify` is rotation-aware: it walks the active log and all rotated-out segments, reconstructing the chain across files.

### Rotation

Size-triggered. Defaults: `TMUX_AGENT_TOOLS_AUDIT_MAX_BYTES=10485760` (10 MB), `TMUX_AGENT_TOOLS_AUDIT_RETAIN=5`. An advisory lock guards concurrent appenders and rotators; a `audit.rotation` HEAD-link record preserves the hash chain across the rename.

### Event coverage

`schema_version: 1`. Events: `wrapper.start`, `wrapper.stop`, `wrapper.send`, `send.multiline`, `hook.allow`, `hook.reject`, `hook.run`, `secret.read` (records `secret_name` + `backend` only, **never** the value), `approval.approve`, `approval.reject`, `approval.timeout`, `fuse.max_trigger`.

## `--secret KEY=URI`: env injection without leakage

`agent-tmux claude start` and `agent-tmux codex start` accept repeated `--secret KEY=URI`. The URI scheme picks the backend; the resolved value is exported as `$KEY` to the agent CLI's process.

### Backends

| URI | Backend | Notes |
| --- | --- | --- |
| `file:<path>` | Read file contents | Trailing newlines trimmed for matching only; full value injected into env. |
| `<path>` (bare) | Same as `file:` | Back-compat shorthand. |
| `env-file:<path>` | Dotenv loader | Reads `KEY=value` from the file. |
| `op://<vault>/<item>/<field>` | 1Password CLI | Requires `op` on `PATH`. |
| `keychain:<account>/<service>` | macOS Keychain | Requires `security`. |

### Fail-fast preflight

If a referenced backend CLI is missing or the secret can't be resolved, the wrapper exits **before any tmux session is created**, with a clear diagnostic and exit code 4. Empirical timing: under 100 ms on the `op://` missing-CLI path. No half-configured sessions.

### Redaction

Registered secret values are scrubbed from `capture` output and transcript events as `[REDACTED:KEYNAME]`. The matcher handles multi-line values (PEM keys, multi-line tokens) and treats the secret as a literal string, not a regex — so a secret containing regex metacharacters can't self-corrupt the matcher.

`--secret-redact=false` bypasses redaction for debugging and prints a loud stderr warning. Do not use it in committed workflows.

### Safe end-to-end example

```bash
agent-tmux codex start --exact agent-x ~/work \
  --secret OPENAI_API_KEY=op://Personal/OpenAI/credential \
  --secret SENTRY_DSN=keychain:default/sentry-dsn \
  --audit-log \
  --transcript /tmp/agent-x.jsonl \
  'Run the task using $OPENAI_API_KEY. Do not echo the key.'
```

This pulls the key from 1Password, redacts it from capture and transcript, records a `secret.read` event in the audit chain — zero plaintext leakage in any operator-visible surface.

## When to use which

| Question | Surface |
| --- | --- |
| "What did *this agent* do?" | Transcript |
| "What did *all agents* do across the host, with tamper evidence?" | Audit log |
| "How do I pass a credential without putting it on the command line?" | `--secret` |
| "How do I diff two runs?" | `tmux-agent-replay diff` |
| "How do I share a transcript safely?" | `tmux-agent-replay redact` |
