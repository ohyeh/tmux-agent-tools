# Audit log operator surface (#188)

Builds on the v0.10.0 hash-chained JSONL audit log (#119) to give operators a
single CLI for enabling, querying, verifying and rotating audit data.

## Goals

- One canonical binary, `tmux-agent-audit`, that exposes the full operator
  surface (`verify`, `query`, `rotate`, `path`).
- Enable audit via either `--audit-log [PATH]` flag or `AUDIT_LOG=1` env, with
  a deterministic default path. Keep the v0.10 `TMUX_AGENT_TOOLS_AUDIT_LOG=...`
  env contract working unchanged.
- Bound disk usage via size-based rotation while preserving chain integrity
  across rotated files.
- Cover the events operators actually need: wrapper lifecycle, hook decisions,
  secret reads, approval gate transitions, and safety-fuse triggers.

## Non-goals

- New cryptographic guarantees beyond the existing per-host HMAC chain key.
- Streaming/tailing UI — `query` returns matching JSONL lines and composes with
  `jq`/`rg`.
- Implementing secret backends (#189) or the approval gate emitter (#185); this
  PR only defines the schema those code paths must conform to.

## Enablement (precedence)

1. `--audit-log <PATH>` flag on `claude-tmux` / `codex-tmux` — explicit path.
2. `--audit-log` (no value) — default path.
3. `TMUX_AGENT_TOOLS_AUDIT_LOG=<PATH>` env (v0.10 contract).
4. `AUDIT_LOG=1` env — default path.
5. Otherwise: audit disabled (no-op).

Default path:

    ${XDG_STATE_HOME:-$HOME/.local/state}/tmux-agent-tools/audit.jsonl

Wrappers `mkdir -p` the parent directory once at startup.

## Event schema (`schema_version: 1`)

Every line is a single JSON object with at least:

| field             | type    | notes                                       |
| ----------------- | ------- | ------------------------------------------- |
| `schema_version`  | int     | always `1`                                  |
| `event`           | string  | `wrapper.start`, `hook.allow`, ...          |
| `at`              | string  | ISO-8601 UTC                                |
| `prev_chain_hash` | string  | SHA-256 hex, 64 chars                       |
| `chain_hash`      | string  | SHA-256 hex of (key‖prev‖line-w/o-chain)    |
| `tenant`          | string  | omitted when `TMUX_AGENT_TOOLS_TENANT` unset |
| `tool`            | string  | `claude` / `codex` (wrapper events)         |
| `name`            | string  | agent name (wrapper / hook / approval)      |

### Event catalog

| event              | additional fields                          |
| ------------------ | ------------------------------------------ |
| `wrapper.start`    | `tool`, `name`, `session`, `cwd`           |
| `wrapper.stop`     | `tool`, `name`, `stopped`                  |
| `wrapper.send`     | `tool`, `name`, `text_len`                 |
| `hook.allow`       | `name`, `hook`, `reason?`                  |
| `hook.reject`      | `name`, `hook`, `reason`                   |
| `hook.run`         | `name`, `hook`, `exit`, `duration_ms?`     |
| `secret.read`      | `name`, `secret_name`, `backend`           |
| `approval.approve` | `name`, `gate`, `actor?`                   |
| `approval.reject`  | `name`, `gate`, `actor?`, `reason?`        |
| `approval.timeout` | `name`, `gate`, `timeout_seconds`          |
| `fuse.max_trigger` | `name`, `kind` (`runtime`/`idle`), `seconds` |
| `audit.rotation`   | `rotated_from`                             |

`secret.read` MUST NOT carry the secret value — only `secret_name` and
`backend` identifier.

Event names are namespaced with `<group>.<verb>`. The wrapper's
`audit_log_append` auto-prefixes legacy bare names (`start` → `wrapper.start`)
so older call sites stay valid.

## Hash chain across rotation

The chain hash is computed as

    SHA256( chain_key || prev_chain_hash || line_without_chain_hash )

`chain_key` is derived from `/etc/machine-id` on Linux, `IOPlatformUUID` on
macOS, falling back to `$HOME`.

When the active log exceeds `TMUX_AGENT_TOOLS_AUDIT_MAX_BYTES` (default 10MB),
rotation runs:

1. Suffixes shift: `audit.jsonl.N` is dropped when N ≥ `TMUX_AGENT_TOOLS_AUDIT_RETAIN`
   (default 5); `audit.jsonl.{1..N-1}` shifts up by one.
2. Current `audit.jsonl` → `audit.jsonl.1`.
3. A HEAD-link record is written as the first line of the new `audit.jsonl`:

       {"schema_version":1,"event":"audit.rotation",
        "rotated_from":"<path>.1","prev_chain_hash":"<last hash of .1>",
        "at":"...","chain_hash":"<sha of key||prev||stripped>"}

This means `verify` across a single file remains a valid chain; cross-file
verification can be done by concatenating older files first (left to operators
because individual files already self-verify against the on-disk previous
file's last hash via the `rotated_from` pointer).

Rotation is best-effort and triggered from `audit_log_append` synchronously.

## Query semantics

`tmux-agent-audit query` filters by:

- `--since ISO` / `--until ISO` against `.at`
- `--tenant T` against `.tenant`
- `--agent A` against `.name` (or `.agent`)
- `--tool T` against `.tool`
- `--event E` against `.event`

Output is JSONL of matching records — composable with `jq`. Missing log → empty
output, exit 0.

## Coordination with parallel PRs

- `#185` approval gate: when the wait-and-capture pause-until-file path is
  reworked, it should call `audit_log_append` with `approval.approve` /
  `approval.reject` / `approval.timeout` events using the schema above.
- `#189` secret backends: the injection code path should emit `secret.read`
  events with `secret_name` + `backend` (never the value).

This PR ensures the audit helper accepts these event shapes today; emission is
landed in the respective feature PRs.
