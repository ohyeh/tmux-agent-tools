# L5 / L6 Backlog — Policy-Blocked Until Roadmap Amendment

Status: design-doc-only batch. None of these are implementable today
because they violate the explicit "no hidden autonomy" non-goal in
[docs/design-issue-101-lifecycle-hooks.md](design-issue-101-lifecycle-hooks.md).

This file documents the proposed designs so the roadmap amendment
discussion has concrete proposals to amend against. Each section is
intentionally short — the issue body has the full spec.

## Why these are blocked

All eight issues require something the wrapper does NOT have today and
that the roadmap explicitly bans:

- a **resident watcher process** the operator did not explicitly
  spawn, OR
- **automatic side effects** on triggers the operator did not
  individually authorise, OR
- **shared state** across agent sessions that survives a single
  `start`/`stop` lifecycle.

The roadmap text covering this is reproduced verbatim in #101 so
operators reviewing one issue don't have to chase the link.

---

## L5 — Topology (#112, #113, #114)

### #112 Fan-out coordinator
- **Surface:** `tmux-agent-fanout <prompt-file> --workdir <a> --workdir <b> --workdir <c>`
  spawns N agents in parallel, gathers each `result.json`, emits one
  consolidated JSONL with `{schema_version: 1, agent, result, error}`.
- **Why blocked:** The coordinator IS a daemon — it has to outlive its
  own caller's shell so the children can complete asynchronously, but
  it has to react when each child writes its result. That's the
  hidden-autonomy shape #101b ruled out.
- **What would unblock:** A `tmux-agent-fanout` subcommand on the
  existing sessions tool, with PID visible via `sessions list` and
  events written to a transcript the operator can read. Then it is
  operator-visible work, not silent daemonisation.

### #113 Declarative dependency DAG
- **Surface:** YAML manifest declaring `tasks: [{name, after: [task-a], prompt: ...}]`
  → runner walks the DAG, starts each task when its predecessors
  signal success.
- **Why blocked:** Same daemon shape as #112 — runner sleeps between
  tasks, decides when to advance. Operator never explicitly approved
  each spawn.
- **What would unblock:** Same as #112 — explicit subcommand with
  visible PID and a transcript per launched task. Plus an explicit
  `--abort-on-fail` policy so the runner can't silently keep going.

### #114 Approval gate
- **Surface:** `wait-and-capture --marker '[NEED-APPROVAL]' --pause-until-file approve.flag`
  blocks the agent until a human writes the approval file.
- **Why blocked:** The blocking wait IS NOT autonomy in itself —
  it's the **wakeup** side that triggers automation when approval
  arrives. That's the same shape as #101b `--on-marker`.
- **What would unblock:** Couple it with the lifecycle-hook roadmap
  amendment from #101. If `--on-marker` is allowed via the
  watcher-PID-visible amendment, approval gate is the smallest
  consumer.

---

## L6 — Safety (#115, #116, #117, #118, #119)

### #115 Hook sandbox / allowlist
- **Surface:** `--on-exit-allow 'whitelist'` restricts what the
  `--on-exit` hook can run; rejects shell metachars unless allowlisted.
- **Why blocked:** This is partial safety theater — the hook command
  is operator-supplied, so an "allowlist" is a placebo unless we also
  drop privileges. A serious answer needs OS-level sandboxing
  (`firejail` on Linux, `sandbox-exec` on macOS) which is a multi-week
  research project.
- **What would unblock:** Pick one platform (Linux + `firejail` is
  the lowest-friction) and ship a `--sandbox profile=<name>` flag.

### #116 Secrets injection
- **Surface:** `--secret API_TOKEN=op://Personal/...` resolves at
  start, injects into the pane env, never writes to transcript.
- **Why blocked:** Not technically blocked — could ship today if we
  document the `op` / Vault dependency. Sits in L6 because the larger
  policy question (which agents are allowed to read which secrets) is
  unanswered. Shipping just the injection without the policy is a
  footgun.
- **What would unblock:** A simple ACL config under
  `~/.config/tmux-agent-tools/secrets-acl.yaml` granting per-agent
  secret access. Then `--secret` looks up agent name + secret name in
  the ACL before resolving.

### #117 Sandboxed workdir
- **Surface:** `start --workdir-fresh` creates a `git worktree add`
  off the current branch so the agent operates on its own copy.
- **Why blocked:** Tractable but non-trivial — the worktree has to be
  cleaned up on `stop`, and the design needs to decide what happens
  to uncommitted changes (preserve as stash? Discard?). The clean-up
  side IS the autonomy concern.
- **What would unblock:** Explicit `stop --keep-worktree` /
  `--discard-worktree` flags so the destructive operation is always
  operator-chosen.

### #118 Multi-tenant prefix
- **Surface:** `TMUX_AGENT_TOOLS_PREFIX_OWNER=alice` namespaces all
  session names + state dirs under `alice/`.
- **Why blocked:** Not blocked by autonomy — this is straightforward
  scoping. Sits in L6 because the larger picture is whether we want
  tmux-agent-tools to be multi-tenant in the first place; current
  answer is "no, single-operator-per-host". Revisit when there's
  demand.

### #119 Audit log
- **Surface:** Append-only signed JSONL of all wrapper events across
  sessions to `~/.tmux-agent/audit.log` (HMAC-chained).
- **Why blocked:** The audit log IS NOT autonomy, but maintaining the
  HMAC chain requires a key the wrapper has to manage — that's a
  multi-tenant question (whose key?) and overlaps with #118.
- **What would unblock:** Ship with a per-host key derived from
  `/etc/machine-id` (Linux) or `IOPlatformUUID` (macOS); revisit when
  multi-tenant lands.

---

## Roadmap amendment proposal

For L5 (#112/#113/#114), the smallest change that unblocks all three:

> Wrappers MAY own a watcher process **when** it is started via an
> operator-visible subcommand (e.g. `tmux-agent-fanout`,
> `tmux-agent-dag`, `tmux-agent-watch`), exposes its PID, can be
> stopped explicitly, and writes events to a transcript the operator
> can read.

For L6 (#115-#119), each issue has its own unblock path documented
above; none of them need a single sweeping amendment.

## Next step

This file enables review. Once the operator signals "amendment
accepted", individual L5 issues can be implemented one PR at a time
under the new policy.
