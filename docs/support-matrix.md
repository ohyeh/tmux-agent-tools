# Support matrix

What works on which host, by which delivery path. Each cell has an evidence
path, or a blocker and the action that closes it. Nothing here is inferred.

`$R` = `.workflow/202610011947-tui-closure`. All paths are relative to the repo root.

## Terms

- **Host**: the AI coding tool that dispatches work and receives results.
- **MCP path**: the host calls `tmux-agent-mcp` tools.
  - Write = `spawn_tmux_agent`, `send_tmux_agent`, `close_tmux_agent`.
  - Read = `wait_tmux_agent` and the result read.
- **Paste path**: a collector pastes the result notice into the host pane.
  - Write = paste one notice, then Enter, then ack.
  - Read = `agent-tmux <cli> composer-state`, which classifies the pane
    (empty, draft, busy, permission, shell, unknown) before any paste.
- **Mod path**: the Claude Code function-hook mod. It is the channel for Claude Code in a terminal.
- **PASS** = a check ran and the cited artifact records it. **UNCONFIRMED** = no real run backs the cell.

Every live run below used macOS and a private tmux server. Live MCP runs used a
fake worker CLI (`$R/r8-live/common/r8cli`) under a real host.

## Codex CLI

| Path | Op | Status | Evidence, or blocker and action |
|---|---|---|---|
| MCP | write + read (spawn, wait, send, wait, close) | PASS | `$R/r8-live/codex/life2.jsonl`, `$R/r8-live/codex/life2-calls.txt` |
| MCP | restart during wait | FAIL, then PASS | `$R/r8-live/codex/restart/`. First wait after host kill returns `not_owner` (finding F3 in `$R/agent-r8-live.md`). Second wait returns `completed` with the same `delivery_id`. To close: re-run on the release SHA after the F3 fix. |
| MCP | two waits at once | PASS in one process only | `$R/r8-live/common/concurrent-inprocess/`. Codex serialises its own calls (`$R/r8-live/codex/concurrent2/`). |
| MCP | all rows above | not re-run on the current SHA | Live MCP runs used `3c96040` plus `a39bfba`. To close: re-run `life2` on the release SHA. |
| Paste | read (composer-state) | PASS | `skills/tmux-agent-tools/scripts/lib/collector.contract.node.ts`, test `composer-state: every captured pane gets its class` (real codex captures in `skills/tmux-agent-tools/scripts/lib/fixtures/composer/codex-*.txt`) |
| Paste | write, empty composer | PASS | `$R/r74-e8acb89/codex/1-empty/driver.log` |
| Paste | write, multiline | PASS | `$R/r74-e8acb89/codex/5-multiline/driver.log` |
| Paste | write, permission dialog | PASS (no Enter sent into the dialog) | `$R/r74-e8acb89/codex/4-permission/act-state-during.txt`, `04-scrollback.txt` |
| Paste | write, unsent draft | PASS | `$R/r74-paste-fix/codex/2-draft/driver.log` (code `041fa0f`, not re-run on `e8acb89`) |
| Paste | write, busy host | PASS | `$R/r74-paste-fix/codex/3-busy/act-state-during.txt`, `driver.log` (code `041fa0f`, not re-run on `e8acb89`) |
| Paste | write, collector in host pane (R8.2) | PASS | `$R/r8-live/codex/r82/` (`host-pane-after-delivery.txt`, `focus-*.txt`, `ps-after-tui-close.txt`, `host-gone-result.txt`, `rereport-count.txt`) |
| Both | one channel only (S3) | PASS | `$R/r8-live/codex/r82/s3-forward.jsonl`, `s3-reverse/launcher.out`; unit: `skills/tmux-agent-tools/scripts/lib/channel.contract.node.ts` |

## Cursor agent CLI

| Path | Op | Status | Evidence, or blocker and action |
|---|---|---|---|
| MCP | write + read (full lifecycle) | PASS | `$R/r8-live/cursor-agent/life2.jsonl`, `$R/r8-live/cursor-agent/life2-calls.txt` |
| MCP | restart during wait | FAIL, then PASS | `$R/r8-live/cursor-agent/restart/`. One cursor tool call times out after about 62 s (finding F7). The old claim needs 90 s or more to expire. To close: the host retries the wait; re-run on the release SHA. |
| MCP | two waits (two host processes) | PASS | `$R/r8-live/cursor-agent/concurrent/` |
| MCP | all rows above | not re-run on the current SHA | Same SHA caveat as Codex. |
| Paste | read (composer-state) | PASS | `collector.contract.node.ts`, same test as Codex (real captures `fixtures/composer/cursor-agent-*.txt`) |
| Paste | write, empty and multiline | PASS on old code only | `$R/r74-paste/cursor-agent/1-empty/VERDICT.txt`, `5-multiline/VERDICT.txt` (code `3c96040` plus `a39bfba`, before the composer probe). To close: re-run both cells on the release SHA. |
| Paste | write, draft and busy | blocker: not re-run since the old FAIL | `$R/r74-paste/cursor-agent/2-draft/VERDICT.txt`, `3-busy/VERDICT.txt` record FAIL on old code. Unit coverage: `collector.contract.node.ts`, test `D-paste: host draft -> nothing pasted ...` and the `busy` twin. To close: live run of both cells on the release SHA. |
| Paste | write, permission dialog | blocker: the dialog cannot be produced | `$R/r74-paste/cursor-agent/4-permission/VERDICT.txt`. `~/.cursor/cli-config.json` sets `approvalMode=unrestricted`, and no CLI flag asks again. To close: use a machine or profile with a changed Cursor config (user decision). |

## agy CLI

| Path | Op | Status | Evidence, or blocker and action |
|---|---|---|---|
| MCP | write + read (full lifecycle) | blocker: not counted | One run completed (`$R/r8-live/agy/life1-calls.txt`). The user stopped agy because each launch opens a keychain dialog. To close: run `life2` on a machine where the keychain dialog is accepted. |
| MCP | restart, concurrent waits | blocker | `$R/r8-live/agy/restart/` was aborted with no result. Same action. |
| Paste | read (composer-state) | by design `unknown` | `collector.contract.node.ts`, the `agy` row of the composer-state test. agy has no verified pane pattern, so the collector never pastes into agy. To close: capture real agy panes, add a pattern set and fixtures. |
| Paste | write | blocker: no paste is attempted | All five cells are BLOCKED (`$R/r74-paste/agy/*/BLOCKED.txt`). To close: same as the composer-state action, then run the five cells. |

## Claude Code, terminal

| Path | Op | Status | Evidence, or blocker and action |
|---|---|---|---|
| Mod | write + read (assign, wait, deliver) | PASS in unit tests | `tests/register.test.ts`, `describe('delivery')`, `describe('assign')`, `describe('channel authority (S3)')` |
| MCP | write + read | UNCONFIRMED | `mcp-adapter/README.md` names `claude mcp add`, but no run against Claude Code exists. To close: register `tmux-agent-mcp` with `claude mcp add` and run the full lifecycle. Record request, response, `agent_id`, `delivery_id`. |
| Paste | read (composer-state) | UNCONFIRMED | Fixtures `skills/tmux-agent-tools/scripts/lib/fixtures/composer/claude-*.synthetic.txt` are hand-written (`fixtures/README.md`). To close: capture real Claude Code panes for empty, draft, busy, permission. |
| Paste | write | UNCONFIRMED | Same fixtures. Logic is covered with a fake host (`collector.contract.node.ts`, `D-paste:` tests). To close: live run of the five states in `r74-paste` style. |

## Claude Code, desktop (Code tab)

| Path | Op | Status | Evidence, or blocker and action |
|---|---|---|---|
| Mod | write + read | UNCONFIRMED | No run exists. `CHANGELOG.md` (0.5.0 entry) says the panel band is terminal-only. To close: load the mod in the desktop Code tab, run assign and deliver, record the transcript. |
| MCP | write + read | UNCONFIRMED | No run exists. To close: same as the terminal MCP action, in the desktop host. |
| Paste | read + write | not applicable | Paste needs a tmux pane that runs a known CLI. With no such pane the collector pastes nothing (`skills/tmux-agent-tools/scripts/lib/collector.node.ts:135`, `no known CLI ... nothing pasted`). Use the MCP path. |

## Operating systems

| Item | Status | Evidence, or blocker and action |
|---|---|---|
| macOS: detached worker launch (perl `setpgrp`) | PASS | `skills/tmux-agent-tools/scripts/lib/workers.contract.node.ts` (launch detach test); `sh`, `bash`, `dash` children survive a group kill (commit `7ab54a2` record in `$R/state.md`) |
| Linux: detached launch with `setsid` | UNCONFIRMED | `$R/state.md` row `7ab54a2` says Linux `setsid` did not run. CI runs on `macos-latest` only (`.github/workflows/ci.yml`). To close: run the core contract and `scripts/run-all-smokes` on a Linux host or add a Linux CI job. |
| Linux: all other cells | UNCONFIRMED | No Linux run of any live or smoke test is recorded. Same action. |
| Unit and smoke suites (macOS) | PASS | `scripts/test-mcp-bundle-smoke`, `mcp-adapter/test/adapter-smoke.js`, `skills/tmux-agent-tools/scripts/lib/*.contract.node.ts`; green run for `a78880a` in `$R/state.md` ("gate-b16") |

## Other open items

- `cursor-agent` `resume_keyword` is UNCONFIRMED. No artifact in `$R` records a real cursor-agent resume run. It does not change a cell above.
- The `$R` artifacts are local run records. They are not part of a release tarball.
