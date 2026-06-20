# Next implementation plan v2

## Goal

Add one team-native dependency gate: `agent-tmux team needs <team> <target-worker> ... -- <prompt>`.

It should wait until a quorum of upstream team worker results is present/valid, then send exactly one downstream prompt to the target worker. This turns the existing quorum primitive into the next useful orchestration step without introducing a full DAG engine, scheduler, TUI, webhook system, or semantic voting layer.

## Why-now

Evidence from the current tree:

| Current fact | Evidence |
| --- | --- |
| `watch --count` exists for named sessions and already implements bounded count semantics over result changes/exits. | `skills/tmux-agent-tools/scripts/agent-tmux:5421`, `skills/tmux-agent-tools/scripts/agent-tmux:5427`, `skills/tmux-agent-tools/scripts/agent-tmux:5436`, `skills/tmux-agent-tools/scripts/agent-tmux:5518`, `skills/tmux-agent-tools/scripts/agent-tmux:5531` |
| Team state already persists every member's `result_path`, so downstream gates can read the authoritative stored path instead of guessing `$TMUX_AGENT_DIR/<name>/result.json`. | `skills/tmux-agent-tools/scripts/agent-tmux:5651`, `skills/tmux-agent-tools/scripts/agent-tmux:5657`, `skills/tmux-agent-tools/scripts/agent-tmux:5711`, `skills/tmux-agent-tools/scripts/agent-tmux:5721`, `skills/tmux-agent-tools/scripts/agent-tmux:5728` |
| `team quorum` already counts present+valid results via stored row `result_path` and supports jq predicates. | `skills/tmux-agent-tools/scripts/agent-tmux:5906`, `skills/tmux-agent-tools/scripts/agent-tmux:5922`, `skills/tmux-agent-tools/scripts/agent-tmux:5957`, `skills/tmux-agent-tools/scripts/agent-tmux:5963`, `skills/tmux-agent-tools/scripts/agent-tmux:5971`, `skills/tmux-agent-tools/scripts/agent-tmux:5983` |
| The team API already has send/broadcast primitives, so the missing piece is a gate that waits before sending to a downstream worker. | `skills/tmux-agent-tools/scripts/agent-tmux:5846`, `skills/tmux-agent-tools/scripts/agent-tmux:5853`, `skills/tmux-agent-tools/scripts/agent-tmux:5859`, `skills/tmux-agent-tools/scripts/agent-tmux:5866` |
| `team wait --require-result` is all-workers only and still calls per-member `result --json <name>`, so it does not cover quorum or stored custom result paths. | `skills/tmux-agent-tools/scripts/agent-tmux:5868`, `skills/tmux-agent-tools/scripts/agent-tmux:5877`, `skills/tmux-agent-tools/scripts/agent-tmux:5893`, `skills/tmux-agent-tools/scripts/agent-tmux:5894`, `skills/tmux-agent-tools/scripts/agent-tmux:5897` |
| `agent-tmux team` has no `needs` subcommand today. | `skills/tmux-agent-tools/scripts/agent-tmux:5763`, `skills/tmux-agent-tools/scripts/agent-tmux:5766`, `skills/tmux-agent-tools/scripts/agent-tmux:5775`, `skills/tmux-agent-tools/scripts/agent-tmux:5777` |
| A separate `tmux-agent-dag` exists, but it executes JSON manifest shell commands synchronously and explicitly does not provide parallel execution. It is not a team/quorum/result-path gate. | `skills/tmux-agent-tools/SKILL.md:49`, `skills/tmux-agent-tools/scripts/tmux-agent-dag:8`, `skills/tmux-agent-tools/scripts/tmux-agent-dag:16`, `skills/tmux-agent-tools/scripts/tmux-agent-dag:48`, `skills/tmux-agent-tools/scripts/tmux-agent-dag:49`, `skills/tmux-agent-tools/scripts/tmux-agent-dag:321` |
| Docs now teach `watch --count` and `team quorum`, but not a way to release a downstream worker after quorum. | `skills/tmux-agent-tools/SKILL.md:159`, `skills/tmux-agent-tools/SKILL.md:164`, `skills/tmux-agent-tools/SKILL.md:169` |

MECE candidate set:

| Candidate | Evidence-based read | Decision |
| --- | --- | --- |
| Worker DAG / `needs:` gate | Half-built by team state result paths, `team quorum`, and team send; missing only the gate that connects quorum to downstream prompt send. | Choose this. |
| Profile inheritance | Profiles already have direct precedence and per-key overrides; no current team/quorum bottleneck points here. Evidence: profile prepass and profile file loading are already explicit at `skills/tmux-agent-tools/scripts/agent-tmux:35` and `skills/tmux-agent-tools/scripts/agent-tmux:68`. | Defer. |
| TUI | `tmux-agent-dashboard` is already the overview surface; this does not reduce the current quorum-to-downstream manual step. Evidence: `skills/tmux-agent-tools/SKILL.md:50`. | Defer. |
| Budget governor | No current team result/quorum code records budget fields; adding it would require a new data model, not a small packet. Evidence: current team member state is `name/role/cli/result_path` at `skills/tmux-agent-tools/scripts/agent-tmux:5711` and `skills/tmux-agent-tools/scripts/agent-tmux:5729`. | Defer. |
| Done-webhook | There is an `--on-exit` hook for individual starts, but not a team/quorum gate; webhook delivery would add external side effects. Evidence: `skills/tmux-agent-tools/scripts/agent-tmux:316`. | Defer. |
| Result-schema migration | Result helpers already validate and read results; schema migration is orthogonal to the next supervision primitive. Evidence: result command surface at `skills/tmux-agent-tools/scripts/agent-tmux:229` and docs at `skills/tmux-agent-tools/SKILL.md:201`. | Defer. |
| Auto-cancel losing workers | There is cancel-file support in `wait-and-capture`, but no team-loser state or cancellation policy; this is higher blast radius than a gate. Evidence: `skills/tmux-agent-tools/scripts/agent-tmux:227`, `skills/tmux-agent-tools/scripts/agent-tmux:4215`. | Defer. |
| Semantic voting / tie-breaking | `team quorum` supports literal jq predicates only; semantic voting would require model-level interpretation beyond shell/result primitives. Evidence: `skills/tmux-agent-tools/scripts/agent-tmux:5931`, `skills/tmux-agent-tools/scripts/agent-tmux:5971`. | Defer. |

## Chosen packet: Packet C — `team needs`

### Command

```bash
agent-tmux team needs <team> <target-worker> \
  [--from <worker[,worker...]>] \
  --count N \
  [--field <jq> --value <literal>] \
  [--timeout <seconds>] [--interval <seconds>] \
  [--json] \
  -- <prompt>
```

### Exact behavior

- Resolve `<target-worker>` the same way `team send` does: bare `synth` means `<team>-synth`; a fully prefixed `<team>-synth` is accepted. Existing behavior is at `skills/tmux-agent-tools/scripts/agent-tmux:5863`.
- Upstream set:
  - If `--from` is supplied, use only those worker rows.
  - If `--from` is omitted, use all worker rows except the target row.
  - Names in `--from` accept the same bare-or-prefixed form as the target.
- For each upstream row, read `.result_path` from the team state and use the same present/valid/predicate logic as `team quorum`, not `result --json <name>`. Current path-based reader starts at `skills/tmux-agent-tools/scripts/agent-tmux:5906`, and current quorum row handling is at `skills/tmux-agent-tools/scripts/agent-tmux:5957`.
- `--field` is a jq expression and must be paired with `--value`, matching `team quorum` behavior at `skills/tmux-agent-tools/scripts/agent-tmux:5931` and `skills/tmux-agent-tools/scripts/agent-tmux:5950`.
- The gate is met when `matched_count >= --count`.
- When met, send exactly one prompt to the target via the existing team send path. Existing send behavior reaches `_agt "$cli" send "$target" "$prompt"` at `skills/tmux-agent-tools/scripts/agent-tmux:5866`.
- Exit codes:
  - `0`: quorum met and downstream prompt sent.
  - `1`: timeout before quorum or target/upstream row not found.
  - `2`: usage error.
- JSON output when `--json`:

```json
{
  "schema_version": 1,
  "team": "review",
  "target": "review-synth",
  "required_count": 2,
  "matched_count": 2,
  "total_count": 3,
  "met": true,
  "sent": true,
  "agents": [
    {"name": "review-w1", "path": ".../result.json", "present": true, "valid": true, "matched": true}
  ]
}
```

On timeout, emit the same shape with `met:false` and `sent:false`, then exit `1`.

### Landing sites

- `usage()` help: add `agent-tmux team needs ...` near current team-related usage. Main usage command list currently ends before team modes at `skills/tmux-agent-tools/scripts/agent-tmux:238`.
- `cmd_team()` dispatch: add `needs) _team_needs "$@" ;;` and update the usage string. Current dispatch is at `skills/tmux-agent-tools/scripts/agent-tmux:5763`.
- Add `_team_needs` beside `_team_quorum`, reusing or factoring:
  - `_team_worker_rows` at `skills/tmux-agent-tools/scripts/agent-tmux:5668`.
  - `_team_result_from_path` at `skills/tmux-agent-tools/scripts/agent-tmux:5906`.
  - predicate/count JSON construction from `_team_quorum` at `skills/tmux-agent-tools/scripts/agent-tmux:5922`.
  - send handoff from `_team_send` at `skills/tmux-agent-tools/scripts/agent-tmux:5859`.
- Add docs:
  - `skills/tmux-agent-tools/SKILL.md` near the existing `watch --count` / `team quorum` guidance at `skills/tmux-agent-tools/SKILL.md:159`.
  - `skills/tmux-agent-tools/references/contracts.md` only if a stable JSON contract is documented.

### Self-test

Add `self_test_team_needs` and wire it into the self-test dispatcher after `self_test_team_quorum`. Current runner wiring is at `skills/tmux-agent-tools/scripts/agent-tmux:6168`.

Minimum self-test:

1. Use a temporary `TMUX_AGENT_DIR`.
2. Start one live downstream target session with a fake CLI, following the pattern already used by `self_test_result_path_prompt` at `skills/tmux-agent-tools/scripts/agent-tmux:4814` and `skills/tmux-agent-tools/scripts/agent-tmux:4867`.
3. Write team state with three upstream worker rows and one target worker row. Use custom upstream `result_path` values to prove the gate reads stored paths, like `self_test_team_quorum` does at `skills/tmux-agent-tools/scripts/agent-tmux:5002` and `skills/tmux-agent-tools/scripts/agent-tmux:5004`.
4. Write two upstream success results.
5. Run `_team_needs "$team" synth --from w1,w2,w3 --count 2 --field .status --value success --timeout 5 --json -- "synthesize now"`.
6. Assert exit `0`, JSON has `met:true`, `sent:true`, and `matched_count:2`.
7. Capture the downstream target pane and assert it received `synthesize now`.
8. Negative case: with only one upstream success and `--count 2 --timeout 1`, assert exit `1`, `met:false`, `sent:false`, and target pane did not receive the prompt.

### Gates

- `zsh -n skills/tmux-agent-tools/scripts/agent-tmux`
- `scripts/ci-shellcheck`
- `skills/tmux-agent-tools/scripts/agent-tmux codex self-test`
- `skills/tmux-agent-tools/scripts/agent-tmux claude self-test`
- `scripts/test-help-smoke`

## Fallback

If `team needs` is judged too much orchestration for one packet, ship the smaller fallback: `team quorum --wait <seconds> [--interval <seconds>]`.

That fallback reuses `_team_quorum` and only changes it from an instantaneous check into a bounded waiter. It still does not send a downstream prompt, so it is less valuable: users would still need a second `team send` call after the quorum wait. The current one-shot quorum implementation is at `skills/tmux-agent-tools/scripts/agent-tmux:5922` and returns directly at `skills/tmux-agent-tools/scripts/agent-tmux:5998`.

## Explicit out-of-scope

- Full manifest DAG execution inside `agent-tmux`.
- Changes to `tmux-agent-dag`.
- Stored dependency metadata in team state.
- Parallel scheduler.
- Auto-cancel losing workers.
- Budget governor.
- Done webhooks.
- Result-schema migration.
- TUI/dashboard work.
- Semantic voting, model-based tie-breaking, or result summarization.

<!-- ponytail: team needs is just quorum + send. No manifest engine, no scheduler, no semantic voting. -->

## Orchestrator decision (brain) — REVISED after independent adversarial consensus

**Superseded my first call.** An independent fresh codex session (no authorship stake) reviewed this plan against the committed tree and returned **DISAGREE / premise_ok=false**. Its evidence held up:

- `team needs` fuses a gate with a **side-effecting send**, and single-send/idempotency is the *hard* part — yet the plan kept dependency metadata / sent-marker state **out of scope**, contradicting its own refinement note that a re-run after quorum must not double-send.
- The "just quorum + send, small surgical" framing understated the real surface (wait loop, `--from` resolution, target exclusion, exit-code + JSON contract, side-effect safety). The original brief (orchestrator-written) biased toward `team needs` as primary.
- Citations spot-checked TRUE against HEAD (one minor line-range nit at the usage-list landing).

**Revised decision — primary flips to the composable primitive:**

### Packet C (revised) = `team quorum --wait [--interval <s>] [--timeout <s>]`
Extend the existing one-shot `_team_quorum` (`agent-tmux:5922-5998`) into a bounded waiter: poll present+valid row results until `matched_count >= --count` or timeout. **No send, no side effect, no new state.** Compose deliberately: `agent-tmux team quorum <team> --count N --field .status --value success --wait 600 && agent-tmux team send <team> <target> -- "<prompt>"`. Reuses `_team_worker_rows` / `_team_result_from_path`; only adds the poll loop + `--wait`/`--interval` flags + `self_test_team_quorum_wait` (live tmux). Gates as before.

### Deferred — `team needs` (send-once gate)
Revisit only after a designed idempotency/state contract exists: key derivation, persisted sent-marker path, retry behavior, and a self-test that fires the same satisfied gate twice and proves exactly one prompt reaches the target. Not the next packet.

This revised plan = the form the independent reviewer prescribed as acceptable. Consensus target: re-confirm AGREE on this revision before it becomes the next branch's starting point.
