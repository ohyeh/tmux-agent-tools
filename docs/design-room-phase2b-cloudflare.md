# Design: room Phase 2b — Cloudflare Workers + Durable Objects Backend

Status: SPEC-ONLY (Phase 2b; implementation and deployment pending user approval)
Created: 2026-06-10
Related: docs/design-room-phase2a-ssh-hub.md, .workflow/.../orchestration.md §Backend dispatch

---

## 1. Purpose and Decision Criterion

Phase 2b provides a shared-state room for machines that **cannot directly SSH to each other** (NAT, mobile networks, heterogeneous cloud providers).
State lives in a Cloudflare Durable Object; access is via HTTPS (long-poll) or WSS (WebSocket streaming).

> Decision rule (canonical):
> machine ↔ hub SSH reachable → Phase 2a (simpler)
> NAT / no inbound SSH → Phase 2b (this document)

---

## 2. UNCONFIRMED Items — Resolved

### 2.1 Cloudflare Pub/Sub (MQTT) status

**RESOLVED: Cloudflare Pub/Sub private beta ended August 20, 2025 and is no longer accepting sign-ups.** Cloudflare now recommends `@cloudflare/actors` and Durable Objects for fan-out/broadcast use cases.

Source: [Cloudflare Pub/Sub docs](https://developers.cloudflare.com/pub-sub/) (retrieved 2026-06-10).

**Decision: Phase 2b does NOT use Pub/Sub. The design uses Durable Objects with WebSocket hibernation + long-poll fallback, which is the current Cloudflare-recommended pattern.**

### 2.2 Free Plan Durable Objects limits

As of 2026-06-10 (sources: [DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [DO Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)):

| Resource | Free plan | Workers Paid |
| --- | --- | --- |
| Total DO storage | 5 GB | 10 GB |
| Per-DO SQLite storage | 1 GB | 1 GB |
| Requests/s per object (soft) | 1,000 | 1,000 |
| SQLite storage billing | **Free plan: not charged** | Charged from Jan 7, 2026 |
| WebSocket hibernation | Available (reduces duration charges) | Available |

**Assessment for this use case:** A room's message log fits comfortably in 1 GB SQLite storage (at ~200 B/message × 200 msg/member × 20 members = ~800 KB). Free plan is sufficient for development and small teams.

### 2.3 E2E Encryption requirement

**REQUIRES USER DECISION.** The spec presents two options:

| Option | Description | Trade-off |
| --- | --- | --- |
| A — Transport-only (TLS) | Messages stored as plaintext in DO SQLite; only HTTPS/WSS in transit | Cloudflare can read stored messages; simpler implementation |
| B — E2E (shared symmetric key) | Clients encrypt with a shared secret before POST; DO stores ciphertext; DO cannot read content | Cloudflare sees only ciphertext; key distribution is out-of-band; `room status` seq counts still work; topic field is also encrypted |

**Default assumption for this spec: Option A (TLS only).** If E2E is required, the message schema `msg` field (and optionally `topic`) is replaced with `enc_msg` (base64 AES-256-GCM ciphertext + nonce); the local shell client encrypts/decrypts using `openssl enc`. This is additive and does not change the DO or Worker code except to treat `msg`/`topic` as opaque blobs.

---

## 3. Architecture Overview

```text
agent-tmux room (local shell)
      │  HTTPS POST / WSS
      ▼
Cloudflare Worker (stateless router, ~50 lines)
      │  DO RPC / WebSocket upgrade
      ▼
Durable Object: RoomDO (one per team)
  ├── SQLite: messages table (seq, ts, from, topic, msg)
  ├── WebSocket connections: hibernation-capable
  └── Fan-out: on new message → wake hibernated WS clients
```

No D1, KV, or Queues. The DO is the sole persistent layer.

---

## 4. Durable Object: RoomDO

### 4.1 One DO per room

Binding key: `<team>` (URL-safe name, validated `[A-Za-z0-9._-]{1,64}`).
The Worker derives the DO stub from `env.ROOM.get(env.ROOM.idFromName(team))`.

### 4.2 SQLite schema (inside DO storage)

```sql
CREATE TABLE IF NOT EXISTS messages (
  seq   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    TEXT    NOT NULL,   -- ISO-8601 UTC
  from_ TEXT    NOT NULL,   -- member name, validated [A-Za-z0-9._-]{1,64}
  topic TEXT    NOT NULL DEFAULT 'general',
  msg   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  name  TEXT PRIMARY KEY
);
```

`seq` is the SQLite ROWID-backed AUTOINCREMENT — guaranteed monotone, no manual lock needed (DO single-threaded per instance).

### 4.3 DO RPC surface (Worker → DO)

| Method | Path | Purpose |
| --- | --- | --- |
| POST `/post` | Body: `{from, topic, msg}` | Append message; returns `{seq, ts}` |
| GET `/read?since=<seq>&topic=<t>&limit=<n>` | — | Return messages after `since`, optionally filtered by topic |
| WS upgrade `/watch?since=<seq>&topic=<t>&member=<m>` | — | Streaming delivery; DO pushes `{"t":"msg",...}` frames |
| GET `/status` | — | Return `{member_count, message_count, cursors:[...]}` |
| POST `/member/add` | Body: `{name}` | Add member (admin token required) |

All methods are internal Worker↔DO; external clients only talk to the Worker endpoint.

---

## 5. Worker: Stateless Router

The Worker (~50 lines of JS/TS) is responsible for:

1. **Auth check**: validate `Authorization: Bearer <token>` against the per-team token stored in a Worker secret (`ROOM_TOKEN_<TEAM>` env var, set via `wrangler secret put`).
2. **Team name validation**: `[A-Za-z0-9._-]{1,64}`, no `..`; reject with HTTP 400 if invalid.
3. **Route to DO**: forward validated request to `RoomDO` stub for the team.
4. **WebSocket upgrade**: pass through WS upgrade to DO when `Upgrade: websocket` header present.

The Worker does not parse message content; it is a thin auth + routing layer.

### 5.1 Worker route table

```text
POST /room/:team/post         → DO /post
GET  /room/:team/read         → DO /read
GET  /room/:team/watch        → DO /watch  (WS upgrade)
GET  /room/:team/status       → DO /status
POST /room/:team/member/add   → DO /member/add  (admin token)
```

---

## 6. Wire Protocol

### 6.1 Post (HTTP)

Request:
```http
POST /room/<team>/post HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json

{"from":"w1","topic":"general","msg":"payments 模組改完了"}
```

Response (200):
```json
{"seq": 43, "ts": "2026-06-10T12:00:00Z"}
```

Error (403 auth, 400 bad input, 429 quota):
```json
{"error": "auth_failed"}
{"error": "invalid_from"}
{"error": "quota_exceeded"}
```

### 6.2 Read (HTTP long-poll)

Request:
```http
GET /room/<team>/read?since=42&topic=general&limit=50
Authorization: Bearer <token>
```

Response (200):
```json
{"messages":[{"seq":43,"ts":"...","from":"w1","topic":"general","msg":"..."}]}
```

`messages` is empty array when no new messages (since acts as exclusive lower bound).
`limit` defaults to 100; max 500.

### 6.3 Watch (WebSocket streaming)

Client connects:
```
wss://<worker-host>/room/<team>/watch?since=42&member=w2
Authorization: Bearer <token>  (passed as query param token= for WS, since headers not supported in browser WS)
```

Server → client frames (JSON text):
```json
{"t":"msg","seq":43,"ts":"2026-06-10T12:00:00Z","from":"w1","topic":"general","msg":"..."}
{"t":"ping"}
```

Client → server (keepalive only, no publish over WS):
```json
{"t":"pong"}
```

On new message, DO wakes hibernated connections and sends `{"t":"msg",...}` to all subscribers.
`since` causes DO to replay any missed messages (seq > since) immediately on connect before entering push mode.

### 6.4 Long-poll fallback (no websocat)

For shell environments without `websocat`, the shell client uses repeated HTTP GET `/read` calls with a sleep interval — identical to Phase 1 `wait` polling semantics. The `wait` verb polls `/read` in a loop with `--interval` sleep, exits on first non-empty response (exit 0) or timeout (exit 1).

---

## 7. Message Schema Parity with Local room.jsonl

The DO SQLite row and the local `room.jsonl` line carry identical fields:

| Field | Type | Constraint | Both backends |
| --- | --- | --- | --- |
| `seq` | integer | monotone, 1-based | yes |
| `ts` | string | ISO-8601 UTC | yes |
| `from` | string | `[A-Za-z0-9._-]{1,64}` | yes |
| `topic` | string | `[A-Za-z0-9._-]{1,64}`, default `general` | yes |
| `msg` | string | non-empty | yes |

The shell client reconstructs the same JSON line format when outputting from Phase 2b, so `--json` output is schema-identical to Phase 1.

---

## 8. Auth: Per-Team Bearer Token

- One opaque token per team, 32+ random bytes, base64url-encoded.
- Stored as a Worker secret: `wrangler secret put ROOM_TOKEN_<TEAM>`.
- All participants (agents on all machines) share the same token for a team.
- Token distribution is out-of-band (same as SSH key in Phase 2a).
- There is no per-member token; member identity is carried inside the message payload (`from` field) and validated against the members table in the DO.
- Token rotation: re-run `wrangler secret put`; the Worker picks up the new value on next cold start.

**No JWT, no OAuth, no Cloudflare Access in Phase 2b.** The token model is intentionally minimal.

---

## 9. Quota

Per-member quota is enforced inside the DO `/post` handler:

```text
SELECT count(*) FROM messages WHERE from_ = ?
```

If count ≥ quota limit (default 200; configurable via DO environment binding `ROOM_QUOTA`), return HTTP 429 → shell client exits 3.

Quota semantics identical to Phase 1: best-effort, not a security mechanism (a caller with the team token can always re-add themselves or use a different member name). Document this in SKILL.md.

---

## 10. Local Shell Client Backend (_room_cf_*)

The shell client implements `_room_cf_{post,read,wait,status}` functions that:

1. Read `--hub` value as a Worker base URL (`https://<worker-host>`).
2. Read `AGENT_TMUX_ROOM_TOKEN` env var as the bearer token (required; exit 2 if absent).
3. Use `curl -sf` for HTTP calls (curl is a safe dep: already used by agent-tmux for formula checks; verified present in PATH).
4. Construct requests per §6 wire protocol.
5. Map HTTP status codes to exit codes (§11).
6. Parse JSON responses with `jq`.
7. **Cursor management**: identical to local — cursor files in `teams/<team>.room-cursors/<member>` on the **local machine** (not synced to DO). The DO is the authoritative message store; the local cursor tracks the last-delivered seq for this member on this machine. `--since` overrides cursor read/write (same as Phase 1).

> Rationale for local cursors: DO does not store per-member cursors (stateless fan-out). Each agent machine tracks its own read position. At-least-once delivery guarantee is preserved since cursor is updated only after successful delivery.

### 10.1 Backend dispatch update

```text
_room_backend()
  "local" or unset    → _room_local_*
  value contains "@"  → _room_ssh_*    (Phase 2a)
  value starts "https://" → _room_cf_* (Phase 2b)
  otherwise           → "not implemented"; exit 2
```

---

## 11. Exit Code Mapping (HTTP → shell)

| HTTP status | Shell exit | Meaning |
| --- | --- | --- |
| 200 | 0 | success |
| 200 empty messages (read/wait) | 1 | timeout/no new messages |
| 400 | 2 | bad input |
| 401 / 403 | 2 | auth failure (fail-closed) |
| 404 team not found | 2 | team/room not found |
| 429 | 3 | quota exceeded |
| 5xx / curl error | 2 | transient failure (fail-closed) |

---

## 12. Wrangler Project Layout

```text
cf-room/                        # Cloudflare project root (separate from agent-tmux repo, or subfolder)
  wrangler.toml                 # Worker + DO binding config
  src/
    index.ts                    # Worker router (~50 lines)
    room-do.ts                  # RoomDO class (~150 lines)
  package.json
  tsconfig.json
```

### 12.1 wrangler.toml skeleton

```toml
name = "agent-tmux-room"
main = "src/index.ts"
compatibility_date = "2026-01-01"

[[durable_objects.bindings]]
name = "ROOM"
class_name = "RoomDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RoomDO"]
```

The project lives in a subdirectory `cf-room/` under the repo root (or a separate repo at user's preference). It is **not part of the agent-tmux formula tarball**; it is deployed separately via `wrangler deploy`.

---

## 13. Migration and Compatibility Story

### 13.1 Phase 1 → Phase 2a/2b: zero code migration

- All Phase 1 local room operations continue to work unchanged (`--hub` absent = local).
- Phase 2a/2b is additive: new `_room_ssh_*` / `_room_cf_*` functions; dispatch logic extended.
- No changes to the Phase 1 local engine code paths.

### 13.2 Local → CF message migration

If a team starts with Phase 1 local and wants to migrate to Phase 2b:

1. Use `agent-tmux room read <team> --since 0 --json` to export all local messages as JSONL.
2. Replay each line via `agent-tmux room post <team> --from <from> --topic <topic> <msg> --hub https://...`.
3. `seq` values will differ (DO starts from 1); cursors must be reset (`rm teams/<team>.room-cursors/*`).

This is a manual, one-time migration. No automated migration tooling in Phase 2b.

### 13.3 2a ↔ 2b: no cross-backend sync

Phase 2a and 2b are mutually exclusive per team. A team cannot span both backends simultaneously. This is acceptable: the choice is made at team provisioning time based on network topology.

### 13.4 Backward compatibility invariants

- Phase 1 schema (room.jsonl fields) is preserved in Phase 2b wire protocol.
- `--json` output schema is identical across backends.
- Exit codes are identical across backends.
- SKILL.md documents the backend selection decision rule.

---

## 14. Scope Exclusions

- No message deletion or room truncation in Phase 2b (same as Phase 1).
- No topic wildcards (YAGNI — per orchestration.md).
- No Cloudflare Access, Workers for Platforms, or multi-tenant isolation beyond per-team token.
- No WebSocket client in the shell for `post` or `status`; only `wait`/`watch` uses WS (optional; long-poll is the default shell client path).
- No `room repair` subcommand (deferred, same as Phase 1).
- No real-time dashboard or UI.

---

## 15. Open Question Requiring User Decision

**E2E encryption (§2.3):** Default spec assumes TLS-only (Option A). If the answer is Option B (E2E), the following changes are required:

1. `msg` field in the wire protocol becomes `enc_msg` (base64 AES-256-GCM, 12-byte nonce prepended).
2. `topic` field also encrypted if topic privacy is required.
3. Shell client uses `openssl enc -aes-256-gcm` to encrypt/decrypt; key in `AGENT_TMUX_ROOM_KEY` env var.
4. DO and Worker treat `enc_msg` as an opaque blob (no content inspection).
5. `room status` seq counts remain unencrypted metadata.

**DECIDED 2026-06-10: Option A (TLS-only).** Rationale: room messages are
coordination signals (secrets are prohibited by SKILL.md policy), shell-side
AES-GCM is error-prone (nonce reuse), key distribution adds a new secret-management
problem, and encrypting `topic` would break server-side filtering. The wire schema
keeps `msg` as-is; adding `enc_msg` later is an additive change if requirements shift.
