# Design: room Phase 2a — SSH Hub Backend

Status: SPEC-ONLY (Phase 2a; implementation pending user approval)
Created: 2026-06-10
Related: docs/design-room-phase2b-cloudflare.md, .workflow/.../orchestration.md §Backend dispatch

---

## 1. Purpose and Decision Criterion

Phase 2a provides a shared-state room over SSH.
Use this backend when **all participating machines can mutually SSH to a designated hub host** (LAN, VPN, or public-key access already provisioned).
If any machine is behind NAT and cannot reach the hub directly, use Phase 2b (Cloudflare) instead.

> Decision rule (canonical):
> machine ↔ hub SSH reachable → Phase 2a
> NAT / no inbound SSH → Phase 2b

---

## 2. Design Principle

The hub runs the authoritative local backend.
Each remote machine is a thin SSH wrapper that delegates every room verb to `agent-tmux room` on the hub, then pipes stdout/stderr and exit code back to the caller unchanged.
**No new state format.** The hub stores `teams/<team>.room.jsonl`, cursors, and locks exactly as defined in the Phase 1 local schema (orchestration.md §Design Freeze v3).

---

## 3. Backend Dispatch Hook (Phase 1 stub)

Phase 1 already parses `--hub` and dispatches via `_room_backend()`:

```text
_room_backend()
  --hub not set / "local"  → _room_local_{post,read,wait,status}
  any other value           → "room backend '<v>' not implemented yet"; exit 2
```

Phase 2a adds `_room_ssh_{post,read,wait,status}` functions and updates the dispatch branch:

```text
  value matches "user@host" pattern → _room_ssh_dispatch "$verb" "$@"
```

No code above `_room_backend()` changes. The condition is: value contains `@` and does not equal `"local"`.

---

## 4. CLI Interface (no change to callers)

```bash
# identical to local, just add --hub
agent-tmux room post  <team> --from <member> [--topic t] <text...> --hub user@host
agent-tmux room read  <team> --member <m> [--since <seq>] [--topic t] [--json] --hub user@host
agent-tmux room wait  <team> --member <m> [--since <seq>] [--topic t] \
                      [--timeout 300] [--interval 5] [--json] --hub user@host
agent-tmux room status <team> [--json] --hub user@host
```

`AGENT_TMUX_ROOM_HUB` env var is the alternative to `--hub` (same precedence as the flag, flag wins).

---

## 5. SSH Dispatch Implementation Contract

`_room_ssh_dispatch` constructs an SSH command that:

1. Runs `agent-tmux room <verb> <team> [all original flags, reconstructed] [text args]` on the hub.
2. Uses `ssh -o BatchMode=yes -o ConnectTimeout=10 "$hub_user_at_host"` — no password prompt, no interactive TTY.
3. Passes stdout and stderr through unmodified (no wrapping, no buffering).
4. Exits with the exact exit code returned by the remote `agent-tmux` invocation.

Flag reconstruction rules:
- All flags the local caller passed (except `--hub`) are forwarded verbatim.
- `<text...>` for `post` is passed as a single shell-quoted argument to avoid word-splitting on the remote.
- Shell quoting: use `printf '%q'` for each argument to produce a safely-quoted remote command string.

```zsh
# Sketch (not implementation code — spec only)
_room_ssh_dispatch() {
  local hub=$1; shift          # user@host
  local -a remote_cmd
  remote_cmd=(agent-tmux room "$@")   # verb + team + flags already reconstructed by caller
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$hub" \
      "$(printf '%q ' "${remote_cmd[@]}")"
  return $?
}
```

---

## 6. State: Single Source of Truth on Hub

- All room state (`teams/<team>.room.jsonl`, `.room.lock/`, `.room-cursors/`) lives exclusively on the hub.
- Remote callers never read or write room files locally.
- Cursor semantics are identical to local: hub's `_room_local_read` manages cursors per member.
- `--since` forwarded to hub; hub's cursor file for `<member>` is used when `--since` is absent.

---

## 7. Disconnection Semantics

SSH transport is stateless per-invocation (one SSH call per `room` verb call).

| Verb | Disconnect behaviour |
| --- | --- |
| `post` | SSH exits non-zero → caller gets exit ≥ 1; caller should retry (at-least-once guarantee is the caller's responsibility, as with local). |
| `read` | SSH exits non-zero → no cursor advance on hub; safe to retry. |
| `wait` | SSH exits non-zero mid-poll → timeout/network; caller treats as exit 1 (timeout semantics) and retries if needed. |
| `status` | SSH exits non-zero → caller treats as transient failure; retry. |

No automatic retry inside `_room_ssh_dispatch`. Retry policy belongs to the caller or the worker prompt pattern.

---

## 8. Authentication

Authentication is entirely SSH key-based:
- Caller machine must have a private key that is authorized in `~/.ssh/authorized_keys` on the hub.
- `BatchMode=yes` prevents password prompts; if auth fails, SSH exits 255 which propagates as exit 2 to the room caller (mapped in dispatch: SSH exit 255 → room exit 2 with message `"ssh auth failed: <hub>"`).
- Key provisioning is out of scope for this tool; SKILL.md documents the prerequisite.

---

## 9. Prerequisites (documented in SKILL.md)

1. `agent-tmux` must be installed and in `PATH` on the hub host.
2. SSH key auth must be pre-configured (no password, `BatchMode=yes` compatible).
3. Hub must have the team created (`agent-tmux team create <team>`) before remote callers use `room`.
4. All members must be added to the team on the hub.

---

## 10. Exit Code Mapping

Remote exit codes pass through unchanged with one exception:

| Condition | Exit code |
| --- | --- |
| SSH connection failure / auth failure | 2 (bad input / not implemented / fail-closed) |
| Remote `agent-tmux room` exit 0–3 | passed through as-is |
| Any other SSH error (e.g. host unreachable) | 2 |

SSH exit 255 signals an SSH-layer error (not a remote agent-tmux error) and maps to local exit 2.

---

## 11. Scope Exclusions

- No multiplexing (`ControlMaster`): each invocation opens a fresh connection. Performance is acceptable for agent polling cadences (seconds between reads).
- No hub-side daemon or persistent connection: stateless per call.
- No E2E encryption beyond SSH transport itself. If end-to-end encryption is required, use Phase 2b with a shared symmetric key (to be decided by user — see Phase 2b §Auth and Encryption).
- No `team create` / `team add-member` remote forwarding in Phase 2a: hub team management is manual or via separate SSH session.

---

## 12. wrangler / deployment

Phase 2a requires no Cloudflare account, no wrangler, no deployment artifact. The only deployment step is:
1. Install `agent-tmux` on hub.
2. Provision SSH key.
3. Pass `--hub user@host` or set `AGENT_TMUX_ROOM_HUB`.
