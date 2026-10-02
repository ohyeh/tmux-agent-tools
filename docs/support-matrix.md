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
fake worker CLI (`$R/r8-live-ff31398/common/r8cli`) under a real host. The Codex and
Cursor rows were re-run on the release SHA `ff31398` (report: `$R/agent-live-ff31398.md`).

## Codex CLI

| Path | Op | Status | Evidence, or blocker and action |
|---|---|---|---|
| MCP | write + read (spawn, wait, send, wait, close) | PASS on `ff31398` | `$R/r8-live-ff31398/codex/life.jsonl`, `life-calls.txt` (seq 1 and 2 `completed`, `close` returns `closed: true`) |
| MCP | restart during wait | PASS on `ff31398` | `$R/r8-live-ff31398/codex/restart/`. After the host is killed its MCP server exits (`host gone (stdin ended); shutting down`). The new host's first wait returns `pending` / `wait_again` within the 40 s cap; the next wait returns `completed` with the original owner's `delivery_id`; one ack set. |
| MCP | two waits at once | PASS on `ff31398` | `$R/r8-live-ff31398/codex/concurrent/`. While the first claim is held both waits return `not_owner`; after it expires one returns `completed`, the other `already_acked`, same `delivery_id`, one ack set. Codex serialises its own calls (`$R/r8-live/codex/concurrent2/`). |
| MCP | plugin registration (`.codex-plugin/mcp.json`) | PASS: load + tools list, on the commit that adds it | `$R/r75-plugin-mcp/`: `codex plugin add` in a clean `CODEX_HOME` lists `tmux-agent` (`codex-mcp-list.txt`); started from the plugin root with a minimal env it answers `initialize` and lists the 5 tools (`codex-plugin-root-tools.jsonl`). Codex runs a plugin server with cwd = plugin root and no `roots` (`codex-cwd-probe.log`, `codex-init-probe.log`); the lifecycle does not depend on the server cwd (`server-cwd-lifecycle.txt`). A full lifecycle through the plugin entry is not run (no auth in the clean home). |
| Paste | read (composer-state) | PASS | `skills/tmux-agent-tools/scripts/lib/collector.contract.node.ts`, test `composer-state: every captured pane gets its class` (real codex captures in `skills/tmux-agent-tools/scripts/lib/fixtures/composer/codex-*.txt`) |
| Paste | write, empty composer | PASS on `ff31398` | `$R/r74-ff31398/codex/1-empty/driver.log` |
| Paste | write, multiline | PASS on `ff31398` | `$R/r74-ff31398/codex/5-multiline/driver.log` (one prompt) |
| Paste | write, permission dialog | PASS on `ff31398` (no Enter sent into the dialog) | `$R/r74-ff31398/codex/4-permission/` (`host composer is permission; nothing pasted`, release Escape, ack after the release, `You approved` 0) |
| Paste | write, unsent draft | PASS on `ff31398` | `$R/r74-ff31398/codex/2-draft/` (`host composer is draft; nothing pasted`, ack after Ctrl-U) |
| Paste | write, busy host | PASS on `ff31398` | `$R/r74-ff31398/codex/3-busy/` (`host composer is busy; nothing pasted`, ack after the busy command ends) |
| Paste | write, collector in host pane (R8.2) | PASS | `$R/r8-live/codex/r82/` (`host-pane-after-delivery.txt`, `focus-*.txt`, `ps-after-tui-close.txt`, `host-gone-result.txt`, `rereport-count.txt`) |
| Both | one channel only (S3) | PASS | `$R/r8-live/codex/r82/s3-forward.jsonl`, `s3-reverse/launcher.out`; unit: `skills/tmux-agent-tools/scripts/lib/channel.contract.node.ts` |

## Cursor agent CLI

| Path | Op | Status | Evidence, or blocker and action |
|---|---|---|---|
| MCP | write + read (full lifecycle) | PASS on `ff31398` | `$R/r8-live-ff31398/cursor-agent/life.jsonl`, `life-calls.txt`. The harness must create the project `.cursor/mcp.json` first (`attempt0-no-mcp-json.jsonl` shows a run without it: no MCP tools). |
| MCP | restart during wait | PASS on `ff31398` | `$R/r8-live-ff31398/cursor-agent/restart/`. Two `wait_again` answers, then `completed` with the original owner's `delivery_id`; no `not_owner`, no tool timeout. |
| MCP | two waits (two host processes) | PASS on `ff31398` | `$R/r8-live-ff31398/cursor-agent/concurrent/`. After the claim expires one wait returns `completed`, the other `not_owner` (the other waiter's claim was still held); one ack set, exactly once. On `3c96040` the loser returned `already_acked`; both are contract answers, and which one depends on the timing. |
| MCP | plugin registration (`mcpServers` in `.cursor-plugin/plugin.json`) | PASS: load + tools list, on the commit that adds it | `$R/r75-plugin-mcp/cursor-plugin-dir-tools.txt`: `cursor-agent -p --plugin-dir <repo>` lists the 5 tools; no other `tmux-agent` MCP entry exists. A full lifecycle through the plugin entry is not run; the server is the same as above. |
| Paste | read (composer-state) | PASS | `collector.contract.node.ts`, same test as Codex (real captures `fixtures/composer/cursor-agent-*.txt`) |
| Paste | write, empty and multiline | PASS on `ff31398` | `$R/r74-ff31398/cursor-agent/1-empty/`, `5-multiline/` |
| Paste | write, draft and busy | PASS on `ff31398` | `$R/r74-ff31398/cursor-agent/2-draft/` (ack after Ctrl-U), `3-busy/` (`host composer is busy`) |
| Paste | write, permission dialog | blocker: the dialog cannot be produced | `$R/r74-paste/cursor-agent/4-permission/VERDICT.txt`. `~/.cursor/cli-config.json` sets `approvalMode=unrestricted`, and no CLI flag asks again. To close: use a machine or profile with a changed Cursor config (user decision). |

## agy CLI

| Path | Op | Status | Evidence, or blocker and action |
|---|---|---|---|
| MCP | write + read (full lifecycle) | PASS | `$R/r8-live-agy/agy/life2-calls.txt` on `1c021da`: spawn, wait (completed), send, wait (completed), close. Real `HOME`, agy started in a trusted folder; the server was added with `agy mcp add` and removed after, user config shasums unchanged (`$R/r8-live-agy/cfgbak/`). The old keychain dialogs came from the first harness's private `HOME`. |
| MCP | restart | PASS | `$R/r8-live-agy/agy/VERDICT.md`: A killed, no orphan server (`host gone (stdin ended)`); a new agy process's wait got `completed` with A's owner pid (`…-76886-…/rs.ef516/1`); earlier waits returned `wait_again` (the 40 s per-call bound). |
| MCP | concurrent waits | PASS | `$R/r8-live-agy/agy/VERDICT.md`: two agy processes waited the same worker at once; one got `completed`, the other `not_owner` (`claim: lost`); `acks` holds `done` and one `unattributed-*`: delivered once. |
| Paste | read (composer-state) | PASS | Real captures of Antigravity CLI 1.2.14 (`fixtures/composer/agy-*.txt`: empty, draft, multiline, busy, trust menu); the `agy` rows of the composer-state test in `collector.contract.node.ts`. |
| Paste | write | PASS (4 of 5; permission N/A) | `$R/r74-paste/agy/{1-empty,2-draft,3-busy,5-multiline}/VERDICT.txt`: each notice delivered once (`delivery_id` 1); a draft and a busy turn were waited out (`host composer is draft` / `busy; nothing pasted`); user config shasums unchanged. `4-permission`: N/A, `toolPermission=always-proceed` shows no prompt. |

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
| Unit and smoke suites (macOS) | PASS | `scripts/test-mcp-bundle-smoke`, `mcp-adapter/test/adapter-smoke.js`, `skills/tmux-agent-tools/scripts/lib/*.contract.node.ts`; green run for `ff31398` in `$R/state.md` ("gate-b17") |

## Other open items

- `cursor-agent` `resume_keyword` is UNCONFIRMED. No artifact in `$R` records a real cursor-agent resume run. It does not change a cell above.
- The `$R` artifacts are local run records. They are not part of a release tarball.
