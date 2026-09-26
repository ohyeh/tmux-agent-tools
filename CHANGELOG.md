# Changelog

## 0.10.1

- `mods/tmux-agent` 0.10.1 — the `tmux-waiter` agent is offered again. 0.10.0 hid it with `agent.offer` → `isOffered: false`, which hides a type at dispatch as well as in the listing; the runtime rewrite is a model-facing dispatch, so live 2026-09-26 every `runtime: tmux/<profile>` Agent call was refused (`a hook's subagentType 'tmux-agent:tmux-waiter' names no agent this call can dispatch`) after its worker had started — the collector still delivered it. The waiter now shows in the model's agent listing, its description saying the mod dispatches it and it is never called directly. The engine's refusal comes after the hook chain, so the `dispatched anyway` wording never reached it; the mocked tests never met the engine's check. Mod tests 172 pass; the offer test fails with the hide put back.

## 0.10.0

- `mods/tmux-agent` 0.10.0 — an Agent brief with a line `runtime: tmux/<profile>` dispatches that tmux worker and lets the Agent call continue as a hidden haiku `tmux-waiter` subagent, so the native sub-agent row (and claude-hud) lasts exactly as long as the worker. The waiter polls `result.json` and `launch.exit` with one Bash call at a time (≤ 540 s, Bash timeout 600000, 60 min overall). While the waiter is `running` the collector does not submit; when it is `completed` and the result is terminal the collector acks silently; when it is `failed`, `killed`, or gone the collector delivers as before. A runtime spawn that sets `name` is denied. Written by a cursor worker (Grok 4.7 model); reviewed by the commander (Opus 5.5), who fixed three gaps: a waiter that ends before the result (its cap, a crash) is released on disk, so the later result is delivered instead of acked silently; a pane that exited with no result is delivered at once, since the waiter's poll cannot see it; and a spawn refused further down the chain (another plugin) says the worker was dispatched anyway, so the model does not dispatch it twice. Mod tests 170 pass; each fix's test fails without it.

## 0.9.1

- `mods/tmux-agent` 0.9.1 — a project row's mirror and `peek` drop the blank rows under the pane's last output before taking the tail. Raw `tmux capture-pane` prints the whole pane height; live 2026-09-26 a session with one line of output at the top peeked as five blank lines. Worker rows go through `agent-tmux capture --tail`, which already trims. Mod tests 156 pass; the changed test fails without the trim.
- The title names the session the panel belongs to instead of a project count: `workers v0.9.1 · @<session> · tmux N · 內部 M` (asked 2026-09-26; project rows still say 專案). A row names its holder only when it is not this session: `@<id>` while that session's heartbeat is fresh, `@unknown` once it is not — an orphan nobody collects (a settled one is never claimed, so it keeps its dead owner). `adopted@…` is gone: an adopted row is ours. One heartbeat stat per owner per panel build.
- Other sessions' workers in this repo fold into one line, `◌ [ 展開 · 其他 session 運行中 N：@<id> N · @unknown N ]`, which is also the filter: its button (hotkey `a`) lists them row by row, tagged, and folds them back (`只看自己`). Default is folded — asked 2026-09-26: a third session in agent-scripts saw every session's workers as its own. No line when no other session holds a row here; project rows show in both modes; `/workers tell|stop <name>` and the tools still reach a folded row by name (numbers index the rows drawn); `tmux N` counts the rows shown. The line is cut by display cells with the toggle word first, so at 60 columns it drops holders, never wraps. The choice is not kept across a reload. Mod tests 160 pass; the fold, no-others, by-name and 60-column tests each fail without their change.
- Every `agent-tmux` / `tmux` call runs from `/` when the worker's dir no longer exists, logged once per dir. Live 2026-09-26: a worker worktree removed after its branch merged made every status read fail `ENOENT posix_spawn 'agent-tmux'`, logged again each tick; agent-tmux finds a worker by name, not cwd. Mod tests 158 pass; each new test fails without its change.

## 0.9.0

- `mods/tmux-agent` 0.9.0 — `/workers` lists this project's detached tmux sessions after the worker rows (a fastlane `hg-android` you would otherwise switch windows to see). Each reconcile pass runs one `tmux list-sessions -F '#{session_name}\t#{session_path}\t#{session_created}'` (`session_created` is epoch seconds); the 2s mirror clock does not. A session is a project row when its path is this session's cwd or a directory under it (`/private/tmp` and `/private/var` fold to `/tmp` and `/var`; a trailing slash is stripped; an empty path is not a row). Worker sessions are excluded with the same `-<name>` rule as `hasSession`, over `Scan.visible`. The title is `workers v0.9.0 · tmux N · 內部 M · 專案 K` (zeros shown; the hint still drops from the right, and when title plus buttons would exceed the row — 69 cells at 60 columns — the `workers vX ·` prefix goes and the counts stay). A project row is the session name, 專案, and age from `session_created`. Selecting it mirrors that one pane through the existing single-flight path, `tmux capture-pane -p -J -t =<name>:` (`=` makes tmux match the name exactly; a bare `-t hg` prefix-matches `hg-android` once `hg` is gone). `peek` of a current project row returns the same untrusted `<worker-pane>` fence; any other name is refused. `tell`, `stop`, and `keys` refuse a project row with `read-only project session`. Written by a cursor worker (Grok 4.7 model); reviewed by the commander (Opus 5.5), who made the pane target exact and kept the bar inside 60 columns. Mod tests 156 pass.

## 0.8.0

- `mods/tmux-agent` 0.8.0 — the panel command is `/workers` (no `/tmux` alias). The title is `workers v0.8.0 · tmux N · 內部 M`: `tmux N` counts panel rows that have no terminal result (`success` / `failed` / `blocked` / `needs-input`), and `內部 M` counts `$.agent.list()` entries with `status === 'running'` (teammates included), read on the 2s clock only while the panel is open. `list()` rejecting shows `內部 ?` and logs once. Title and hint width count CJK/fullwidth characters as 2 cells and `·` as 2, so the bar does not run past `[ hide ]`. Zeros are shown. design opinions from codex, agy and cursor; decided and reviewed by the commander (Opus 5.5).
- The collector heartbeat runs on its own 10s clock. Before, it rode `reconcileOnce`, which joins an in-flight pass, so one pass slower than 90s stopped the beat and another session in the same repo adopted this live session's workers and took their delivery (observed 2026-09-26: five workers re-owned by an idle session). A paused collector still stops beating on purpose. Reply strings say `workers panel`. Mod tests 152 pass; the new heartbeat test fails with the old wiring.
- An orphan whose current episode is already acknowledged (by any session) is not claimed: it has nothing left to deliver, and claiming it only moved `owner` away from the session that dispatched it (the five above were all delivered). A `tell` starts a new episode, which is claimable again. Mod tests 153 pass; the new test fails without the guard.

## Unreleased

- `tmux-agent-commander assign` starts that session's collector from the tmux server (`run-shell -b`), so a CLI shell tool cannot reap it when the call returns. `collect` owns the pid file (a live pid that is not this process exits quietly; the file is removed on exit) and `start` no longer writes it. A session name that matches no known cli prints one hint and `assign` still exits 0. Live 2026-09-26: a codex CLI ran the commander from its pane; `nohup sleep 300 &` did not survive the tool call, and `(nohup tmux-agent-commander collect ... &)` was gone minutes later, while a foreground collector did deliver the worker result into the pane.

- `mods/tmux-agent/README.md` permission table matches the 0.7.14 pin again: `env.get` reads four names (adds `PATH`), `fs.exists` probes `PATH` dirs and the plugin/skill install paths for `agent-tmux` (existence only), `agent.spawn` is listed as the second hook that touches another tool, and a "它不做的事" line states no `http.fetch`, no credential or history reads, no env writes — the gaps a 2026-09-22 Pluto Security report says Function Hooks users cannot see from the install screen.

- `tmux-agent-commander panel <session>` prints one line of workers that session owns, newest first so a cut line keeps current work: running `▶`, a terminal result as `✓ success` or `✗ <status>`, then the three newest `dispatch.delivered.json` rows as `✓ delivered`. `start` installs that line on the session only (`status 2`, `status-format[1]`, `status-interval 2`); `--no-panel` skips it. A split pane is not used, because agent-tmux sends to the session's active pane and a focused split pane would take the delivery. `--width N` drops whole entries from the end and appends `+N more`. Written by a grok 4.7 worker; reviewed by the commander (Opus 5.5), who removed two one-line owner wrappers and added a smoke case that pins the commander's session name to `agent-tmux start --dry-run`.

- `tmux-agent-commander` — codex, agy, and cursor can command tmux workers. Claude Code already wakes itself from `mods/tmux-agent`; the other CLIs had no collector, so a finished worker sat until someone harvested it. `start` runs `agent-tmux <cli> start --exact` and a detached collector; `assign` (from inside that pane) writes `dispatch.json` with `owner` set to the tmux session name before `assign --detach`; the collector heartbeats `<state>/.collector-<owner>` every 10s and sends each terminal `result.json` into the commander pane once. A fresh heartbeat keeps the Claude mod from adopting the worker; after 90s with no beat it adopts as before — the repo's top commander sees every worker (asked 2026-09-26). Each `assign` gets a fresh directory (`<worker>-<4 chars>`, as the mod does), so a reused name never hands the last run's `result.json` over before `assign` resets it; a delivered record is renamed `dispatch.delivered.json`, so a Claude session that adopts after this commander ends never re-delivers it. Written by a grok 4.7 worker from a spec; reviewed by the commander (Opus 5.5), who fixed those two spec gaps, a leaked prompt temp file, and one always-true assertion. `scripts/test-commander-smoke` 40 pass.

- `agent-tmux`: a browser sign-in screen (`Approve in your browser to finish signing in` … `Waiting for approval...`) is `login_prompt`, not `approval_prompt`, and a login-blocked `assign` says to sign in to the CLI once by hand instead of "answer it yourself if you trust it (keys)". Live 2026-09-25: grok 1.0.41, never signed in on this machine, drew that screen in a fresh dir and assign told the reader to press keys. `test-hook-trust-status-smoke` 42 pass (41/1 on the old wrapper). grok's workspace-trust screen, if it has one, stays UNCONFIRMED until grok is signed in.

- `agent-tmux send` / `send-wait` (and the mod's `tell`, which calls `send --prompt-file`) deliver a multi-line message as a file under file-ref delivery, the claude family's default: the text goes to `<agent dir>/send-<time>-<pid>.md` and the CLI gets one typed line naming it. Live 2026-09-25: a real claude worker answered a pasted 5-line `send` with "this message is only pasted content — shall I do it?" and wrote nothing; after the change it wrote `two.txt` (`send`) and `three.txt` (`send-wait`). The `send.multiline` audit event keeps the message's own bytes and sha and adds `delivery`. A profile's `prompt_delivery=paste` keeps pasting.
- `send-wait` matches a nonce line with the CLI's layout removed (indent, a leading `⏺ • ●` bullet): claude drew `⏺ reply` then `  MARK-58b923`, and send-wait timed out on an exact-line compare while the nonce sat on screen. `test-marker-nonce-smoke` 19 pass (18/1 on the old wrapper).

- `mods/tmux-agent` 0.7.14 — installing the mod is the whole setup: when `agent-tmux` is not on `PATH`, every call the mod makes runs the copy in the marketplace checkout the mod came from (`~/.claude/plugins/marketplaces/tmux-agent-tools/skills/tmux-agent-tools/scripts/agent-tmux`), then an `npx skills` install (`~/.agents/skills/tmux-agent-tools/scripts/agent-tmux`), and logs once which. `PATH` still wins, so a developer's checkout is used as before. Found nowhere, `assign` is denied before anything is written, naming where it looked — the model reads that and can fix it; before, it launched a detached shell that failed later in `mod-assign.log`. One seam: `host.run` swaps argv[0], plus the `assign` launch line. README drops the install-bin checklist added in 0.7.13 (asked 2026-09-26: "think how people use it", "find the plugin or skill yourself"). Permission pin: env reads add `PATH`. Mod tests 148 pass (two new: marketplace copy used off PATH; deny when missing).
  From the Opus 5.5 review of 0.7.13–0.7.14 (verdict: push; three Low findings, all fixed here): the panel's "See it whole" line names the binary the mod runs, not a bare `agent-tmux` that does not resolve off PATH; that line, "+N more" and "Band too short to mirror" truncate instead of wrapping — a wrapped line is a row the height budget never counted (width 80 and a 45-character worker name drew maxRows + 1 and disarmed the digits); the found binary is kept per environment (HOME + PATH), not per host, so both hosts of a session share it and the fallback is logged once, as documented.
  0.7.12's `panel` tool proven live 2026-09-26 on 0.7.12: after the `reload` tool ran `/reload-plugins`, `panel close` answered `tmux panel closed.` (the reload had reopened it), `panel` answered `tmux panel opened above the prompt (0 worker row(s)).`, and a second `panel` answered `tmux panel is already open.`

- `mods/tmux-agent` 0.7.13 — panel and docs from a review round with teammates (2026-09-26: a grok 4.7 worker on the panel, an agy worker on the tool texts, the Grok Bot "NOVA 替身 w39" on the README; those are suggestions, not a review gate — the diff was reviewed by a fresh Opus 5.5 agent together with 0.7.14). Panel: goal lines under worker rows are drawn only when every worker fits with its goal; before, each worker took two rows and a 13-row band listed half the fleet, then "+N more". The header hint drops whole pieces from the right instead of slicing (at 72 columns it ended "· /tmux stop <"). Row labels put the state and elapsed time before the repo, so a narrow band cuts the repo first. A delivered row's dot is `✓` (finished and delivered were both a cyan `●`). The selected worker's "See it whole" line names a real command, `agent-tmux <profile> attach <name>`, not `tmux attach -t <session>` with a placeholder. The tell field says `send` beside it while focused. README: a check after install (`which agent-tmux && tmux -V`, the hooks variable, the `assign` tool and `/tmux` visible), the tool table lists peek, keys, panel and reload, and a paused collector's recovery is `peek` then Read of `result.json` — the old text sent the model to a Bash `agent-tmux … result` the mod's own gate denies; `skills/using-tmux-agent-tools` says the same. Mod tests 146 pass (the 13-row test now uses fourteen workers to keep its overflow case; eight fit without goal lines).

- `mods/tmux-agent` 0.7.12 — new tool `panel` (`action`: `open`, the default, or `close`): the model opens or closes the `/tmux` panel itself, through the same `openPanel` a typed `/tmux` runs, so it is recorded for reopen after a reload too. Before this, a model that wanted the panel shown had to ask the person to type `/tmux` (2026-09-26: it took two tries of sending `/tmux` from the web client). Answers say already open/closed instead of toggling. Mod tests 146 pass; permission pin updated for the new hook.
  Same release, model-facing texts that sent the model into the mod's own Bash gate (review by an agy worker, 2026-09-26): with no collector, `assign` and `tell` said "Harvest yourself: agent-tmux … result wait-required", a Bash call the gate denies; they now say to check with `peek` and read `<state dir>/result.json` with the Read tool. A failed `stop` said to run `agent-tmux … stop` (also denied); it now points at `stop` with `all: true`, which still finds the dropped worker (the dispatch record stays). `assign`'s `name` says a 4-character suffix is added and later calls take the returned name; `tell`'s unknown-name deny no longer says "check /tmux", a command the model cannot run.

- `mods/tmux-agent` 0.7.11 — orphan claims log one line per session claimed from (`claimed 7 worker(s) from session X (no heartbeat for 90s): "a", "b", … and 2 more`), not one line per worker. Live 2026-09-26: after a reload, 40 lines `claimed "<name>" from session 94c9a8c7…` filled the transcript. Cause: the process started as session 94c9a8c7 and then resumed transcript 5f8e7fac (`CLAUDE_CODE_SESSION_ID`); the module kept the first `$.session.id()` until the reload, the reload read the new one, and the old id's records were orphans 90 s later. The claim itself is right (that session id ended; acks are read across every session's key, so nothing is delivered twice). A panel opened under the old id is not reopened by the first reload after such a switch. Mod tests 145 pass.

- `mods/tmux-agent` 0.7.10 — a reload no longer loses the panel: `/reload-plugins` re-runs the module, so the open `/tmux` band closed with it (asked 2026-09-26). Opening the panel records this session in the store key `tmux-agent.panel` (closing removes it, other sessions' entries stay, at most 20); `session.start`, which fires again after a reload, reopens it through the same code `/tmux` runs. That code is now one closure, `openPanel`: a plugin's own `$.command.run({ command: 'tmux' })` skips its own command hook (the test kit ran it straight to the hooks beneath), so replaying `/tmux` could not work. Selection and mirror are not restored. Mod tests 144 pass (the reopen test failed before the change). Live 2026-09-26 on 0.7.11: `/tmux` opened the panel (store `tmux-agent.panel` = this session), the `reload` tool ran `/reload-plugins`, and the next `/tmux` answered `tmux panel closed.` — the panel was open again after the reload.

- `mods/tmux-agent` 0.7.9 — new tool `reload`: queues `/reload-plugins` (via `$.command.run`, on a timer, since the call rejects inside the turn's own tool call) for when the turn ends, so an update installed with `claude plugin update` takes effect without the person typing it. Live 2026-09-25: the tool answered at 18:51:44Z and `/reload-plugins` ran at 18:51:54Z, right after the turn ended (`Reloaded: 15 plugins · 28 skills …`), with no one typing it. Also: a `launch-failed` notice whose failed step is `confirm-processing` now says the brief was sent, the step is judged from the pane, the worker may be working, and to peek before dispatching again (a later result is still delivered). Live 2026-09-25: a cursor reviewer reading 22k tokens was reported launch-failed. Mod tests 141 pass (140/1 without the change).

- `agent-tmux stop` writes a `wrapper.stop` audit event (name, session, whether a session was killed, the caller's command). Before, a stopped worker and one killed from outside looked the same in `audit.jsonl`, so a vanished session could not be traced (live 2026-09-25: `live-claude-ref-kgst`, cause still UNCONFIRMED — its result has no `terminal_reason`, so it was not closed by `stop`). `test-audit-smoke` 21 pass (19/2 on the old wrapper).

- `run-all-smokes` runs every smoke on a tmux server of its own (`TMUX_TMPDIR` temp dir, `$TMUX` unset, `kill-server` of that server on exit). On the operator's server the suite opened 100+ sessions (`claude-cli-live-claude`, `claude-cli-a-claude-a`, …) beside real workers, where a matching name was killed and leftovers such as `stuckclaude-cli-deliver-stuck` showed in `/tmux`. Proof: a `session-closed` hook on the real server logged 0 closes during a full run (72 PASS), versus 100+ before. A smoke run by itself, outside `run-all-smokes`, still uses the caller's server.

- `agent-tmux` — six fixes from live runs (2026-09-25). **Workspace trust is answered**: a trust-this-folder dialog whose selected option says yes/trust (codex `› 1. Trust and continue`, agy `> Yes, I trust this folder`, claude `❯ 1. Yes, proceed`) gets one Enter from `assign`, at most twice, then the brief is sent; every other dialog still fails the send with `the brief was NOT sent` (user policy: a worker dispatched to a dir trusts it). Live: codex and agy in never-trusted dirs, rc=0. **claude gets the brief as one typed line**: claude read a long pasted brief as the user's pasted data and answered "this message is only pasted content" without acting; the claude family now defaults to `file-ref` (a profile's `prompt_delivery` still wins). Live: 3/3 real claude runs read `prompt.md` and finished. **A finished turn confirms**: a new `✻ <Verb> for Ns` / `─ Worked for` line since the send is processing, so a 9 s answer between two looks is no longer resent; the verb may be non-ASCII (`✻ Sautéed for 7s` missed an `[a-z]+` match live and the brief ran twice). Live: 2/2 short claude turns confirmed this way, one prompt each in the transcript. **cursor's climbing token count confirms**: `⠘⠣ Running  9.63k tokens` or `⠘⠤ Reading  22.29k tokens` (the verb follows the tool) moves like a counter (a working cursor worker read as launch-failed and its brief queued twice). Smoke-proven; live on cursor UNCONFIRMED (cursor quota paused). **One look window per paste**: once a marker look has waited 10 s, the paste's other marker gets one look; a send with two unseen markers went from 23 s to 12 s (each new paste starts a fresh window). **No composer, last 20 lines**: with no composer on screen the dialog scan reads the last 20 non-empty lines, not the whole pane, so text echoed high above a booting TUI is not a dialog. **A caller with no UTF-8 locale gets one**: the pane scans match `✻ ❯ → ⠘` inside bracket classes, which the C locale reads as bytes, so under launchd, cron or `env -i` every dialog, counter and finished-turn check saw nothing; the wrapper now sets `LC_ALL=C.UTF-8` when `locale charmap` is not UTF-8 (the finished-turn case runs under `LC_ALL=C` and fails 3 checks without it). Tests: `test-assign-dialog-smoke` 58 pass (new cases fail on the old wrapper: trust/other-dialog, send window, finished turn, cursor counter), `test-hook-trust-status-smoke` 41 pass (the no-composer case fails on the old wrapper), full `run-all-smokes` 71 PASS + 1 FLAKY-PASS (`test-send-multiline-smoke`: send-lock contention, exit 75, passed on retry 22/0).

- `mods/tmux-agent` 0.7.8 — **bug 8, a delivered tell answered "no tool.call hook answered"**: `tell` gave the wrapper's `send` 8 s, but a send to a CLI that folds the paste (claude) waits up to 10 s for each of its two injected instructions and took 22.6 s live. At 8 s `process.run` killed the wrapper after the paste and rejected, the hook threw, and the caller read an error for a message that had arrived. The send now gets 60 s (the wrapper's 30 s lock wait plus the paste and its looks), and a send cut off at that deadline still records the new episode and answers "the message may have arrived — peek before telling it again". Live: a headless session with the 0.7.8 mod told a real claude worker; the worker wrote its answer 10 s in, the send finished 22 s in, and `tell` answered `sent to …`. Tests: 140 pass (the new case fails on 0.7.7).

- `mods/tmux-agent` 0.7.7 + `agent-tmux` — six defects from the live five-CLI e2e on 0.7.6 (2026-09-25). **A, a stop's ack was lost**: `prompt.submit` resolves at the turn boundary, so a delivery that read this session's ack list at 14:34 wrote it back at 14:35:32 — over the acks two `stop`s had written in between (e2e-gate at 14:34:57, e2e-claude at 14:35:14); both stopped workers were later notified `launch-failed` and `exited`. Every write of the session's own key now goes through one per-activation chain that re-reads the key at write time (`updateAcks`), and a pass prunes only the ids it decided to prune, so an ack written since its read stays. **B, a trust dialog ate the brief**: `assign` checked the pane once before sending; claude, claude-fable-gate and agy on never-trusted dirs drew the workspace-trust dialog a moment later and it took the paste (claude's first half). The pane must now sit unchanged for 3 s with no dialog before the send (looked at for at most 10 s, dialogs checked on every look); a dialog fails `send` with `the brief was NOT sent` and is never answered by the wrapper — the caller peeks, answers with `keys`, and sends the brief again. **C, a false UNCONFIRMED on every paste assign**: the result-path and scope-guard markers were looked for right after the paste, while the composer still held it, and cursor-agent shows `[Pasted text #1 +24 lines]` in its transcript too, so the text never reaches the pane (and a generic family was distrusted outright). `assign` now judges both after confirm-processing: a submitted placeholder that covers every line of the payload proves the whole paste arrived, for any family; otherwise the marker text as before, and the warning stays. **D**: a launch-failed notice is the `failed_step` and `diagnostic` of the log's trailing JSON block plus the log path (the last 5 lines when there is no block), not up to 12,000 chars of `mod-assign.log`. **E**: `assign`'s `brief` parameter has a description (GOAL/ACCEPTANCE/REPORT; the wrapper adds the result path and scope lines). **F, auto-stop** (user decision Q-1): a worker whose terminal result was delivered to this session and that had no tell for 30 min — counted from the latest of dispatch/tell, the result's `finished_at` and this activation's delivery — is stopped on a quiet tick through the `stop` path (acked, off the panel) with one log/toast line; never another session's worker, one without a terminal result.json (mid-episode), one without a pane, on the startup pass, or more than one per tick. Tests: 4 engine tests (`live e2e of 0.7.6`, 137 pass), new `test-assign-dialog-smoke` (17 pass); 12 mod mutations and 5 wrapper mutations all killed. `run-all-smokes` allows 240 s per smoke: `test-dispatch-delivery-smoke` took 166 s before the pre-send look and about 178 s after it. Review follow-ups, still 0.7.7: the pre-send look window re-anchors when a startup screen clears, so a long "verifying your account" no longer sends the brief with zero settle; auto-stop reads `status --json` and does not stop a pane idle for less than 30 min, a running/busy worker, or a worker whose status read failed; a folded paste is whole only when M is at least the payload's line count (newlines + 1); a brief section may be a markdown heading or bold (`# GOAL`, `**GOAL**`). Three more from live runs, still 0.7.7: **5, an update menu took the brief**: codex 0.156.1 drew `Update available · … › 1. Update now (runs … curl … | sh) 2. Skip` at boot and the send's Enter ran the installer (the CLI updated itself and exited). A screen with an update word and a way to skip it is now `blocked_reason: update_prompt`, a hard dialog everywhere the others are (`send`, `start`, the assign pre-send look, `confirmation_detected`): the brief is not sent, no key is pressed, and the diagnostic says to update or skip that CLI by hand. **6, a working worker called launch-failed and sent the brief twice**: confirm-processing read the busy and idle signals only after the brief's first line showed in the pane, and codex 0.157.0 showed a one-line queue preview of the injected first line while claude folded the paste, so neither ever matched. An elapsed counter on screen (`● Orbiting… (27s ·`, `• Working (3m 01s •`) that moves between two looks now confirms for every CLI family, and a confirm that fails while a counter is on screen fails without the resend. **7, dialog words in a worker's answer read as a dialog**: the dialog/startup scan started at the last `›` line only, so a cursor (`→`) or claude (`❯`) pane was scanned whole and an idle worker whose report quoted "Verifying your account" was `startup_pending` for good (`tell` refused). The scan now starts at the last composer line of any of those glyphs; a numbered menu line (`› 1. …`) is a dialog's cursor, not a boundary. Tests: `test-assign-dialog-smoke` (39 pass: update menu; moving counter, codex and claude shapes; frozen counter, no resend), `test-hook-trust-status-smoke` (40 pass: quoted dialog words, send goes through). **8, a still pane is not a ready CLI**: cursor-agent drew nothing under the launcher header for over 3 s while it booted, so the pre-send look sent the brief; the tty echoed it above the Cursor banner, the TUI kept it unsubmitted in its composer, and the echoed words ("trust this folder") read as `permission_prompt`. `assign` now also needs a line drawn below the launcher header before the send, and fails after `AGENT_TMUX_START_READY_TIMEOUT` (45 s) with `CLI drew nothing`. Live: cursor-agent passed twice with that brief; claude, agy and codex were not slowed (the gate held claude for one look; agy and codex still refuse at their trust dialogs). Tests: `test-assign-dialog-smoke` (42 pass; the silent-boot case fails 2 checks on the old wrapper).

- `mods/tmux-agent` 0.7.6 — fixes the cursor opus review of 0.7.5 (`d20cdcc`, pushed; `VERDICT: PASS` with N-1..N-4). **N-1** a status probe that timed out with its full 3 s window is now recorded in `probedAt`; before, only answered probes were, so a worker whose `status` always hung sorted first every sweep and took 3 of the 4 s budget. A probe cut short by what was left of the budget still does not count. **N-2** `/tmux stop` and `/tmux tell` take a name only: row numbers move with every refresh, and the render-time `drawn` snapshot only closed the millisecond gap, not the seconds between reading the panel and pressing Enter. A number answers `row N is "<name>" right now — stop takes a name` and stops nothing; `drawn` is removed, and the usage, compact-band and command-list texts no longer teach `stop N`. **N-3** a press inside the 0.4 s repeat beat slides the armed window's start, so a held `x` never confirms a stop (a key repeat at 375 ms then 405 ms used to). **N-4** the mirror draws at most the rows this render has for it (a capture sized by an earlier, taller render overflowed `maxRows` for one mirror clock and disarmed the digits), and the empty-list line counts toward the budget (`maxRows` 1 drew 2 rows). The cursor fable review of `95f32f0` (`VERDICT: PASS`, three P3) is fixed too: the mirror's no-room guard now has a test that fails without it (a 4-row band drew 5), the collector-down line is cut to one row instead of wrapping past the budget, and the missing-message reply says `/tmux tell <name> <text>`.

- `mods/tmux-agent` 0.7.5 + `agent-tmux` — fixes the astra review of 0.7.4 (`VERDICT: BLOCK`, six findings plus four pre-existing) and its re-reviews of the fix (`VERDICT: BLOCK`, N1–N6, then A1–A4). **Commit evidence**: a `commit` that is not a string (`{"toString":null}` threw inside `String()` and the whole success was never delivered) or is `''` is delivered once as `NOT verified`; the sha must be a `commit` object (`git cat-file -t`; an annotated tag id resolved `^{commit}` and passed as "verified"), and descend from the dispatch base — `assign` and every `tell` record `base` (`git rev-parse HEAD` of `dir`, read before the worker starts) and the claim must satisfy `merge-base --is-ancestor <base> <sha>` with `sha ≠ base`, so a commit older than the dispatch no longer passes (an ancestry check, not proof of authorship: a descendant already on another branch passes too). A base `git rev-parse HEAD` could not give is logged with the reason. No base (not a repo, or a pre-0.7.5 record) says `commit object exists; no dispatch base recorded`. All commit checks of one pass share a 4 s budget; what does not fit — including a claim whose `cat-file` fit and whose `merge-base` did not — waits for the next tick instead of being delivered as `NOT verified` and acked for good (20 × 2 s could hold a tick for 40 s). A git call is a failure only when it had its full 2 s; one cut short by the budget is deferred. One pass's result reads and commit checks share a 4 s budget (the stall sweep's 4 s follows, inside the engine's 10 s hook budget); a pass starts where the last one stopped, and that first worker is exempt — its read and both git calls always run — so every pass settles at least one claim and a slow repo is reported, never deferred forever (a budget spent by reads left the ancestry call 1900 ms every pass). Any other check starts only when all its calls fit what is left, so none is cut short; a deferred claim and the unread tail wait for the next tick. Results arrive within a bounded number of ticks, not the same tick (20 workers × 400 ms reads held one pass for 12 s). A worker read as terminal clears its earlier stalled/needs-input observation. A worker whose terminal result waits on that budget is not handed to the stall sweep (four finished workers with a stale banner woke the lead with "no result will arrive"). **Launch-failed is provisional**: the notice is acked as `<name>@<since>#launch`, so a real result of the same episode — the CLI took the brief without showing it, as claude-fable-gate did from its session picker on 2026-09-24 — is still delivered once, and a terminal result outranks the receipt in `collect` and the panel. **Stalls**: `agent-tmux status --json` now reports `blocked_reason: quota_exhausted | login_required` with `blocked_evidence` (the line) and a diagnostic, read from the pane's last 10 non-empty lines (the live codex banner `■ You’ve hit your usage limit` sits above `›`, outside the prompt area, so status answered `null` all night). Only the CLI's own error block counts: a line that starts at column 0 as one (`■`, `⚠ Individual quota reached`, `Error:`/`API Error:` with the colon) or claude's `⎿  API Error:…`, with no newer output line (`•`, `⏺`, `⎿`, `└`, `✔`, "Worked for") after it — a quoted "invalid api key", prose opening with "Error handling…" or "API Error handling…", a tool's output (under `⎿`/`└` or indented beneath), and a banner the worker resumed past are not blockers; `Error: rate limit exceeded` is `quota_exhausted`; an error printed after an echoed `› prompt` is still seen. New `test-runtime-blocker-status-smoke` (23 pass, including astra's seven counterexamples and a claude tool-output pane — claude/agy/cursor shapes UNCONFIRMED). The mod drops its own `BLOCKER_RE` (it matched "Implemented rate limit handling" and missed "invalid api key") and reads the wrapper's reason: after 2 min unchanged it marks the worker `stalled` and **wakes the session once per episode**, worded "looks stopped by their CLI — peek before waiting" since one line of pane text is the evidence — two codex workers sat on a usage limit for an hour while the lead waited. "Once" is what the session accepted: a refused wake is retried next tick and given up on (logged) after 3; an idle reset does not re-announce; the notice set is in memory, so a reload or an adopting collector may say it once more. A dialog reason clears the episode's stall so panel, log and `$.tmux.stalled()` agree. **assign never confirms an unsent paste**: when the pane's last prompt-glyph line is a paste placeholder (`→ [Pasted text #1 +25 lines]`, `[Pasted Content …]`), the composer still holds the brief — assign presses Enter at most twice, 10 s apart, and otherwise fails `confirm-processing` with "still sitting unsent in the composer" instead of a false `assigned:true` (2026-09-25: a cursor worker's brief sat unsent after the composer nudge, whose own redraw read as activity); new cases in `test-dispatch-delivery-smoke` (32 pass). **Result validation**: `result --validate` now checks `commit` (exactly 40 lowercase hex characters, or omit; `null` in the file is invalid, readers still tolerate it). The length is checked on its own: jq's `$` matched before a final newline, so 40 hex + LF passed; both schemas state `minLength`/`maxLength` 40. **Tests**: the budget test exercises the budget seam directly (another session's key over 3 MiB) instead of scanning 65k directories — it ran at the 5 s timeout on 0.7.4 and its baseline (22 ms now). A peer's key is deleted only when no episode it names — `#launch` acks included — is on disk (a peer deleted a live `#launch` ack). Astra's eleven review cases are regression tests (111 pass). A finished row's clock stops at its result. **Cursor (Opus 5.5) review of 4d0af09** (`VERDICT: PASS`, O1–O8): the phrase table gains the real stop strings found in this machine's claude transcripts and the CLI binaries — claude `You've hit your session/weekly limit · resets …` and `Credit balance is too low` (under `⎿`, the text right after the glyph; any other `⎿` line is a tool's), codex `access token could not be refreshed` (`login_required`), agy `exhausted your quota`, grok `hit your free usage limit` — and a column-0 `⚠` line counts only with a quota phrase (an MCP auth warning is not a stop); smoke 30 pass. The stall sweep's cursor moves past what it probed, not the whole window, so a slow head no longer hides the tail. After its notice a launch-failed worker is watched like any other: gone → delivered `exited` and closed (a bad profile name no longer stays outstanding forever), alive → probed. A first payload block too large to fit alone is sent without its summary instead of silently stopping every later delivery. A base that is not 40-hex never reaches git argv (tested). README states the SHA-256 limit and that `base` sits in a worker-writable file (116 pass). The panel's header is a cyan title bar, so the band reads as its own region rather than the session's output (a background, not a border: a border would take two of the band's rows from the mirror). **Panel UX, from a live probe on 2026-09-25**: `[ stop ]` asks twice — the first press (or `x`) arms it for 5 s as `[ stop <name>? press again ]`, only a second press stops (one stray `x` with the band focused on `[ refresh ]` stopped a worker). Every control has a typed form that needs no hotkey: `/tmux N` selects row N, `/tmux stop N|name`, `/tmux tell N|name <text>`, `/tmux hide` — letter keys press only while the band is focused, and `ctrl+x tab` did nothing in Warp. `[ close ]` is `[ hide ]`, at the far end of the header, clear of the engine's `[-]` (which covered it). The tree is counted row by row so it stays inside `maxRows` and the digits stay armed: a selected row's summary is one line (a wrapping summary took up to six rows counted as one), a fleet longer than the band is cut with `+N more`, goals show in the overview only, and a selection gives the list's room to the mirror's floor first (a 13-row band printed "needs 15" with two workers and "needs 18" with eight; the mirror never showed). Tests: armed-stop expiry, 13-row band with eight workers, two workers mirrored, the subcommands (120 pass). **Astra review of 34e2a1e** (`VERDICT: PASS`, four P2): the stall sweep probes the longest-unprobed worker first, by identity — a cursor over positions skipped four of eight workers forever, because each tick's collect pass hands over a different subset; `exited` is acked as `<name>@<since>#exited`, which closes the notice and takes the row off `/tmux` and `outstanding()` but not the episode, so a result that lands after the pane went is still delivered once; a band too small for one row and its controls draws the title bar and the typed-command hint instead of overflowing (maxRows 3 drew 4); the 4 s + 4 s split is documented as the normal-case budget, not a hard 10 s bound (the pass's first worker is exempt — a hard cap would bring back the starvation A1 fixed). **Cursor review of 34e2a1e** (`VERDICT: PASS`, three P2): only an answered probe counts as probed, so one cut short by the sweep's budget is first next time (the seventh of seven 600 ms probes was cut every tick and never answered); a selected worker that leaves the list clears the selection (the stale one drew a "too short" line past `maxRows`); `/tmux stop N` and `tell N` resolve N against the rows as last drawn, and a hidden panel takes names only (`stop 2` had ended the worker a refresh moved into row 2); `/tmux tell` keeps the message's newlines and indentation; presses on `[ stop ]` closer than 400 ms are a held key repeating, not a confirmation; the hint is clipped so `[ hide ]` clears `[-]` at any width. README notes that `tell` can take up to 15 s (git base, init, send) inside a 10 s hook budget. 128 pass. Docs: README, types, SKILL.md, contracts.md, schemas, using-tmux-agent-tools.

- `mods/tmux-agent` 0.7.4 — completion evidence bound to a commit sha (W39-19). A `success` result may carry `commit` (full 40-hex sha, top-level or under `.body`); before delivering, the collector runs `git -C <dir> cat-file -e <sha>^{commit}` in the worker's dir. Verified → the status line reads `success — commit <sha12> verified`. Missing commit, a non-40-hex value (rejected before it reaches argv), or a git that does not run → still delivered, never swallowed, as `success claimed, commit <sha> NOT verified: <reason>`. No `commit` (read-only and review workers) → unchanged text, no git call. The dispatch records no base or branch, so reachability from HEAD is not checked. `commit` is added to `result-status-summary.schema.json` (both copies; the schema is `additionalProperties:false`, so `result validate` rejected it before), the injected `RESULT_SCHEMA_LINE`, the mod's `tell` report line, SKILL.md, contracts.md and README. Tests: verified, nonexistent sha, malformed sha, no sha, `commit: null` (82 pass; same pre-existing budget-test timeout).

- `mods/tmux-agent` 0.7.3 — a quiet pane is not a stuck worker (W39-20). A live worker whose pane was unchanged for 15 min was logged `stalled, not working` and drawn `stalled` from silence alone, though a worker thinking or waiting on a long build is quiet too. Now the notice states only the observation — `pane unchanged for N min; not confirmed stuck. Last lines: …` — with the pane's last 3 non-empty lines (≤300 chars) as evidence, and the row reads `running · idle Nm`. The row turns `stalled` (and the log quotes the line) only when the tail shows a blocker: quota reached/exceeded, usage/rate limit, out of credits, not logged in/authenticated, or an `error` word — the quota/login rows of agent-tmux's `launch_blocker_for_text` plus the observed `⚠ Individual quota reached`. Dialogs are unchanged (still `needs-input` via `blocked_reason`). The tail is the `last_capture_lines` the same `status --json` probe already returns, so no extra capture and the sweep budgets are untouched. `$.tmux.stalled()` keeps listing idle workers and gains `evidence?` on confirmed ones. Tests: the idle case now asserts `not confirmed stuck` + the tail; new quota-tail case (stalled) and panel case (`running · idle 30m`, not stalled) (77 pass; the pre-existing 65k-record budget test times out at 5s on this machine, unchanged).

- `mods/tmux-agent` 0.7.2 — the panel title prints the mod version (`tmux workers v0.7.2`). Observed 2026-09-18: a session ran `/reload-plugins` after the 0.7.1 update and its panel still showed the 0.7.0 bug, while a later reload did pick up 0.7.2 — with nothing on screen naming the code that drew the panel, the two cases could not be told apart. `test-version-sync-smoke` holds `MOD_VERSION` to the mod manifest (8 checks).

- `mods/tmux-agent` 0.7.1 — a `tmux ls` that answers `no server running` (exit 1) empties the panel. `liveSessions` read every non-zero exit as "tmux too slow" and kept the last answered fleet, so once the whole tmux server was gone a delivered teammate stayed listed as `done — tell it more, or stop it` forever, and [refresh] walked the same branch (observed 2026-09-18 16:3x: `smcs2084-design-review-hmqq` on the panel with `tmux ls` empty). `process.run` rejects on timeout and resolves with any exit code once tmux exits, so now only a rejection keeps the last fleet; a resolved run is the truth, exit 1 = empty fleet. `stop --all` and the panel share the probe. Tests: the old "exit 1 keeps the fleet" case is replaced by a rejection case plus a new "exit 1 empties the panel" case (76 pass; the new case fails on 0.7.0).

- **Removed** the `claude-tmux` / `codex-tmux` / `agy-tmux` shims (deprecated since v0.35, removal announced for v0.39) and the Homebrew formula (`Formula/`, unused). Spell `agent-tmux <cli> <command>`; install with `skills/tmux-agent-tools/scripts/install-bin`. CI and the release workflow lint and self-test `agent-tmux` directly; the smokes drive the engine through `codex_tmux()` / `claude_tmux()` functions instead of the shim files. `tmux-agent-sessions` prints `agent-tmux <cli>` as the wrapper name.

## v0.41.0 - 2026-09-18

- `mods/tmux-agent` 0.7.0 — the `mode` option is gone; every session collects. `lite` (dispatch, never collect) had one remaining use, opting out of the 10s clock, and one cost: the finished result sat on disk until a person harvested it, which is the silence this mod exists to remove. With per-session acks (0.5.2) and owner-only delivery (0.6.0) several collectors never duplicate, so there is nothing left to opt out of. No `$.config.list()` read on the tick, at startup, in the panel or in the receipts any more; a leftover `pluginConfigs.tmux-agent.options.mode` in settings is ignored by the engine. Receipt text: `collector: active in this session — end the turn; …` (the `(mode full)` tag is dropped; `using-tmux-agent-tools` SKILL.md updated to match). Tests: `mode gate` (2), the lite receipt test and the hanging-config-row test are removed with the code they covered (75 pass).

- `agent-tmux start`: the initial-prompt echo proof now looks for as long as the readiness timeout (`AGENT_TMUX_START_READY_TIMEOUT`, default 45s) instead of a fixed 10s. Observed 2026-09-18: a claude peer with hooks + MCP took 44s from launch to reading its first message (06:41:13 → 06:41:57), the readiness poll saw no startup screen and pasted at once, the paste sat unread in the pty, and at 10s `start` called it swallowed, resent once, and returned `prompt_swallowed` exit 1 — while the prompt had landed. `_sentinel_landed` takes the window as an optional third argument; the two marker checks keep 10s. `test-start-readiness-smoke` new case (banner, tty echo off, reads after 18s): old wrapper reads the prompt twice and logs a resend; this one reads it once, no resend (16 pass).

- `mods/tmux-agent` 0.6.3 — `mode` defaults to `full`. A session that can dispatch but never collects hands the result back to the person (`collector: NONE — harvest yourself`), which is the gap this mod exists to close; with per-session acks (0.5.2) and owner-only delivery (0.6.0) several collectors no longer duplicate, so there is no reason left to opt in. `lite` stays as an explicit opt-out for a session that wants no 10s clock.

- `agent-tmux`: `result_path_via_prompt` now defaults to `true` for every family, claude included. The `self-test result-path-prompt` family-defaults check expects `true` for claude too (it failed on 0.6.3-era wrappers with `unexpected family defaults`). No CLI can read `$TMUX_AGENT_RESULT` from inside its tool sandbox and nothing else told a claude worker where result.json lives, so every claude-family worker dispatched with a brief that did not restate the path finished its task, answered in the pane, and left result.json `pending` forever — the tmux-agent mod's collector never delivered it (observed 2026-09-18 13:57 and 14:00, two workers). The claude exception dated from the 0.35 baseline with no channel behind it. Docs (README, SKILL.md, contracts.md, core-workflow.md, `--help`) updated.

- `mods/tmux-agent` 0.6.2 — a launch receipt older than the episode is stale. `tell` opens a new episode on a pane that is provably alive, but `launch.exit` from the failed first launch stayed and `collect` reads it before result.json, so the old `launch-failed` was delivered again and the episode's real result never was. Observed 2026-09-18 14:01: agy blocked on the workspace-trust dialog (assign exited 1, delivered once), `keys Enter` + `tell` got the task done and result.json said `success`, and the collector delivered the launch failure a second time. Now `launchFailure` ignores a receipt whose mtime is older than `dispatch.since`. Regression test: episode 5 with a receipt from episode 0 and a finished result delivers the result, not the receipt (79 pass; fails on 0.6.1).

- `mods/tmux-agent` 0.6.1 — a tmux session that does not exist YET is not `exited`. `dispatch.json` is written about a second before `agent-tmux assign` creates the session, and `status --json` answers `exists:false` (exit 0) for "not yet" exactly as for "gone"; a stall probe in that gap marked the worker exited, the next tick delivered `exited — no result` and acknowledged it, and the worker's real report (here: `launch-failed`, codex out of quota) was never delivered while its pane sat alive and off the panel. Observed 2026-09-18 13:36 on a live codex dispatch. Now the `gone` verdict waits for the launch receipt (`launch.exit`): until assign has written it, assign owns the pane and a missing session says nothing. One log line marks the transition to exited, so the next occurrence leaves a trace. Regression test: dispatch present, no receipt, `exists:false` → nothing delivered, row not exited; receipt appears → delivered once as exited (78 pass; fails on 0.6.0).

- `mods/tmux-agent` 0.6.0 — two sessions in one repo see and drive the same teammates. `/tmux`, `tell`, `stop` and `peek` now cover every worker whose `ownerCwd` is this session's cwd, whoever dispatched it (rows tagged `@<sid8>`); another repo's workers stay invisible. Delivery is still the owner's alone. Adoption of a dead owner's worker (no heartbeat for 90s) is a CLAIM: the record is rewritten with `owner = me`, `adoptedFrom = <old sid>`, nothing is delivered on that tick, and next tick only the session the record names delivers — two collectors seeing the same orphan cannot both deliver (#323). A `tell` from a non-owner moves the worker to the teller: whoever gave the latest instruction gets the answer, never both. Delivery text names `adopted from session <sid>`. Verified from disk that `--resume` keeps the session id, so a resumed session is still the owner with no wait. Tests: claim-then-deliver, second collector stands down, same-repo visibility + tell moves ownership, other-repo invisible (77 pass; 3 fail on 0.5.2).

- `mods/tmux-agent` 0.5.2 — one acknowledged-set key PER SESSION (`tmux-agent.reported.<sessionId>`), read as a union, written only by its owner. The plugin store is shared by every session and has no atomic read-modify-write, so with one shared key two collectors acknowledging in the same second had the later write drop the earlier id and that worker was delivered again. Now no session touches another's key; a dead session's key, and the pre-0.5.2 shared key, are deleted once nothing they name is on disk. Tests: own-key isolation, no re-delivery on the next tick, garbage collection of dead keys (74 pass).

- `mods/tmux-agent` 0.5.1 — the acknowledged set is pruned against every record on disk, not against the records this session owns. The store is one file per plugin, shared by every session on the machine; with `mode: full` set globally every session is a collector, and a collector in another project saw the owner's worker as "not mine", pruned its ack, and the owner re-delivered the same finished result every 10s — 131 times into one session (observed 2026-09-18). Regression test: a second collector in another cwd leaves the first one's ack alone and prunes only ids whose directory is gone.

- `agent-tmux assign` confirm-processing: the delivery proof is compared with all whitespace removed on both sides. Observed 2026-09-17: agy re-flowed the file-ref line at ~78 columns and broke it inside a path, the 40-char proof never matched, and a worker that had already read its task and run its command was reported `launch-failed — the task never reached the CLI`. Same fix in `_sentinel_landed` (start path, 2026-08-19). New: when the proof is on screen but nothing is busy and the pane has been frozen ≥10s, assign presses Enter once (logged `composer nudge`) instead of resending — observed 2026-09-17: a claude worker sat with the ref line in its composer for 294s, $0, until Enter was pressed by hand; the old path would have pasted the prompt a second time. The busy probe now asks the family's own metric (`active_spinner` for claude, `tool_active` otherwise): `--metric busy` was never a metric and answered "Unknown metric", so every confirmation had been riding on `idle <= 3` — which is how the stuck claude worker got confirmed on startup redraws. For the claude family a definite spinner `false` now forbids that idle shortcut (an idle composer holding unsent text has no spinner); the generic families keep it. The claude family's default busy pattern now knows Claude Code v2.1's markers — `● <Verb>… (Ns · …)`, the in-flight `◐ <Tool>` status cell, `esc to interrupt` — measured 2026-09-18 against a live pane where the braille-only pattern read `false` for the whole of a 60s task. The probe's boolean is read with an explicit null check, not `.value // empty`, which swallows `false`. The nudge goes through `send --key enter` (send lock, audit trail), not raw tmux. `test-dispatch-delivery-smoke` case 3 (re-flowing TUI, tty echo off) and case 4 (claude-family fake that redraws 30s then freezes with the text in its box) fail on the old wrapper — case 4 also on the first nudge version — and pass on this one.

- `mods/tmux-agent` 0.5.0 — `/tmux` panel moves from a `Pane` to the `AbovePrompt` band. Observed 2026-09-17 on two machines: the Pane docked to the right of the transcript from 110 columns (fullscreen layout) and sat inline under `CLAUDE_CODE_NO_FLICKER=0` / in tmux — and inline, none of its buttons could be pressed (clicks are only reported in the fullscreen layout; `hotkey` is honoured only in the band). The band is always above the prompt in both layouts. Rows 1–9 press on a bare digit from an empty prompt (`1: name`); `r` refresh, `x` stop, `q` close once the band is focused (`ctrl+x tab`); a `[close]` button replaces the Pane's ✕. The tree stays under the band's `maxRows` (a scrolling band disarms the digit hotkeys), so the mirror is sized from `maxRows`, not `viewport.rows`. The hook yields to a survey and nests whatever plugins below drew. No `mobile`/`desktop` surface any more: the band is terminal-only (the Pane's mobile branch was defensive, never requested). README advice to pin the panel with `NO_FLICKER=0` is withdrawn — the position no longer depends on it.

## v0.40.1 - 2026-09-17

- `mods/tmux-agent` 0.4.1 — `/tmux` panel: the rows no longer wait on `$.config.list()`. Observed in a fresh session (no reload): panel opened, then an assign, and the new row never appeared — [refresh] did nothing, the 2s clock did nothing, close-and-reopen showed it. The mode-row read was the one await inside `refresh` the rows did not need; if it never settled, `refreshing` stayed set and every later refresh returned early. The read now runs off the rows' path, and a refresh that throws is logged instead of lost. Cause not logged in the field — the regression test drives it with a mode row that never answers (old code: timed out on open).

## v0.40.0 - 2026-09-17

tmux-agent mod v0.4.0（隊友：tell／stop／peek／keys／stop all、/tmux 面板保留已交付隊友、session-id 所有權與孤兒接手、needs-input、狀態色點）；wrapper 側 preflight、prompt_delivery=file-ref、assign 一步派工、result wait-required 修正等。

### tmux-agent mod：peek／keys／stop all，交付不再截斷

- 新工具 `mcp__tmux-agent__peek(name, lines?)`：一次回傳 pane 尾巴（去 ANSI、預設 40 行、上限 200）
  加狀態（running／idle／pane gone／needs input — <blocked_reason>）。Claude 想看就叫，不輪詢。
  Bash gate 對 status／capture／probe 的拒絕文字改指向 `peek`。
- 新工具 `mcp__tmux-agent__keys(name, keys[])`：白名單鍵（Enter Escape Tab Space 方向鍵 y n）
  送進該 worker 的 tmux session，回答 trust／permission／login 對話框。不能打字；打字走 `tell`。
- 面板新狀態 `needs input — <reason>`：status 探測讀 `blocked_reason`，一出現就改標並 toast 一次。
- `stop` 加 `all: true`：停掉本專案所有還有 tmux session 的 worker（含已交付但忘了關的）。
  只掃本專案的 dispatch 紀錄，不碰別的 tmux session。
- 交付截斷修正：summary 上限 800 → 12,000 字元，截斷提示改為指名 result.json 路徑。
  實測起因：cursor／agy 兩個搜尋任務各 11／23 筆結果，交付時只剩前 6／7 筆。
- 修 README 因錨點錯誤重複整節的問題（12d40bb 引入）；三份 handoff 加 STALE 橫幅。
- 面板每列前加狀態色點（running 綠、done／finished 青、stalled 黃、needs-input 紫 `?`、exited／
  launch-failed 紅），summary 行 success 綠、其他黃。Button 沒有 color 屬性，所以色點放在旁邊。
- 面板：`tmux ls` 上限 2s → 5s，失敗時沿用上一次結果（一次慢 tick 不再清空已交付的隊友）；
  行列重讀單飛，慢的那次不會被下一個 tick 疊上；標頭加 `[refresh]` 按鈕手動重刷；
  面板開啟讀完列表立刻重繪（不再等 2 秒才從「No workers outstanding」變成真狀態）。
- peek：有終態 result.json 的 worker 說 `finished (result.json: <status>)`，不再照 wrapper 的
  `running:true` 說 running；idle 秒數照印。

### tmux-agent mod：已投遞的隊友留在 /tmux

- `/tmux` 改畫「還有 pane 的隊友」：已投遞記帳的 worker 標 `done — tell it more, or stop it`，
  選中仍有輸入列、`[stop]` 與 `success: <summary>`；tmux session 沒了才從面板消失。
  每個 tick 多一次 `tmux ls -F '#S'`（2s 上限），用 `-<name>` 尾綴比對，不猜 profile 前綴。
  實測起因：assign→tell→投遞完後 `/tmux` 只剩 `No workers outstanding.`。
- Bash gate 對 status／capture／probe／result 的拒絕文字改成一句話（原本印成 `use nothing: …`）。
- pane 已死、沒寫 result 的 worker 不再永遠掛在 `/tmux` 等人按 stop：status 探測到
  `exists:false` 後，下一個 tick 以 `exited` 交付一次並記帳，列就消失。
  `exists:true, running:false` 是 idle（活著、停在 prompt），不算 exited。
  實測起因：兩個 P5 fixture（p5a／p5b）掛在面板上 1 小時 41 分。
- dispatch.json 新增 `owner`（派工 session 的 `$.session.id()`）與 `ownerCwd`。collector／
  `/tmux`／tell／stop 只認本 session 的 worker；每次對帳 touch `<root>/.collector-<id>` 心跳，
  別的 session 的 worker 只在它心跳停 90 秒以上且 `ownerCwd` 同 cwd 時接手（孤兒不漏收）。
  同一 repo 多個 session 各做各的不互搶；沒有 `owner` 的舊紀錄照舊可被接手。實測起因：
  兩個 session 共用一個 state root，彼此把對方的 worker 當自己的交付。
- 已知代價（不修）：交付是「先 submit、後記帳」，模組若在兩步之間被卸載（plugin 目錄
  熱重載、session 結束），該結果會多送一次（僅一次）。反過來先記帳會在崩潰時弄丟結果，
  重複比遺失便宜。2026-09-17 觀察到 p5a／p5b 各送兩次（16:23:17、16:25:25），同時段
  有 mod 原始檔存檔；「熱重載落在窗口內」是與 commit 時序一致的推論，未在 log 中抓到。

### Added
- **`tmux-agent` mod — workers are teammates: `tell`, `stop`, and a Bash gate.**
  `mcp__tmux-agent__tell` sends a follow-up to a worker this mod dispatched: it
  resets the worker's `result.json` (`result init`), sends the text with the
  result path spelled out (follow-up sends are never prefixed by the wrapper),
  and bumps `dispatch.json`'s `since` — strictly above the previous value, since
  the id is `<name>@<since>` and a collision would inherit the old "delivered"
  mark — so the collector watches the worker again and it returns to `/tmux`.
  `mcp__tmux-agent__stop` stops the worker and acknowledges it, so it leaves the
  panel instead of sitting there as `exited`. While the mod is loaded, a
  hand-typed `agent-tmux <cli> assign|send|send-wait|stop|status|capture|probe|result`
  in Bash is denied with the tool to use instead (`--help` passes): only the tool
  writes the record the collector reads, and a status poll is a second
  supervisor. `assign`'s description now says `profile` is any agent-tmux profile,
  including a custom one (a second claude through a provider gateway via its own
  `--settings`), and the mod README shows that profile.
  Verification moved into CI: `scripts/test-mod-permissions-smoke` pins the
  `claude plugin validate` surface to `mods/tmux-agent/permissions.txt` and runs
  `claude plugin test` (55 tests, previously developer-machine only); CI installs
  the latest Claude Code for these on purpose — the API moves fast, and the
  typecheck against the committed declarations (regenerated on 2.1.274) is what
  says it moved under the mod. A first `claude plugin eval` case checks that the
  model, denied the shell probe, reports the denial instead of a status.
  The panel itself grew the teammate controls: the selected row carries an input
  line (type, Enter — that is a `tell`) and a `stop` button, both through the
  same functions the tools use, and a finished row shows its `status: summary`
  instead of a pane mirror.
- **`tmux-agent` mod — the panel and the `assign` receipt say who will deliver.**
  The `/tmux` panel gains a fifth row state, `launch failed` (read from the same
  `launch.exit` receipt the collector reads), so a dispatch whose `agent-tmux
  assign` died no longer draws as `running`. Its first line now names why nothing
  will be delivered when that is so — mode `lite`, paused after three refusals,
  or paused over the store budget — with the fix beside it. The `assign` tool's
  result ends with the same verdict: `collector: active …` (end the turn and wait
  to be woken) or `collector: NONE — …` plus the exact `result wait-required`
  command to harvest by hand. `skills/using-tmux-agent-tools/SKILL.md` gains a
  COLLECTOR section that branches on that sentence, so a mod session ends its
  turn instead of starting a second supervisor, while Codex, Cursor and mod-less
  sessions keep the ONE OWNER proxy/harvest procedure untouched. Five new tests,
  each mutation-checked (`50 pass, 0 fail`); the row-switch test closes the last
  panel acceptance item left UNCONFIRMED on 2026-09-17.
- **`tmux-agent` mod v0.3.0 — `/tmux` panel and stall detection.**
  `/tmux` opens a pane listing every outstanding worker (name, repo, state,
  elapsed, and the brief's GOAL line, now recorded at dispatch). Pressing a row
  mirrors that worker's pane tail; only the selected row is mirrored, and the
  2-second mirror clock exists only while the panel is open, so a closed panel
  spawns no captures at all while reconcile keeps running. The mirror strips
  ANSI rather than guessing at a colour mapping the engine does not document.
  A live worker whose pane has not changed for 15 minutes is flagged `stalled`
  and shown apart from `running`, announced once, never killed — reusing the
  `idle_seconds` `agent-tmux status --json` already maintains.
- **`tmux-agent` mod v0.2.0 — the collector session owns the wait.**
  A function-hook plugin (`mods/tmux-agent/`, its own version line) that adds
  `$.tmux` and an `assign` tool over `agent-tmux`, reconciles `result.json` on a
  clock and submits a prompt when a worker reaches a terminal state, so a
  dispatch no longer needs a supervising proxy to sit and wait. Delivery is
  submit-then-record: a worker is marked reported only after the session accepts
  the prompt, because `prompt.submit` can legitimately answer `{ drop }`.
  Ownership comes from minting a fresh state directory per dispatch, so
  re-assigning a name can never collect the previous generation's result, and no
  producer-side protocol field is required. The `mode` gate reads the live
  `/config` row every tick, so switching `lite` to `full` takes effect without
  restarting the session.
- **`preflight` — the CLI's own launch probe, before any tmux session exists.**
  `agent-tmux <cli> preflight [--json]` runs the profile's `preflight_flags`
  (default `--version`), and classifies a failure as `keychain_locked`,
  `login_required`, `quota_exhausted`, `cli_not_found` or
  `cli_preflight_failed`, keeping the CLI's own output in `detail`. Exit `4`
  when blocked. `assign` runs it as step 0 and exits `4` with
  `{assigned:false,failed_step:"preflight",blocked_reason,...}`, starting no
  session; `doctor` reports it as a `cli_launch` check. On 2026-09-08
  `cursor-agent` was blocked on a locked macOS login keychain and the review it
  was meant to run was never dispatched — nothing in the wrapper distinguished
  that from a slow worker. Verified against all five real CLIs (claude, codex,
  agy, cursor, grok: launchable, side-effect-free, sub-second).
- **`prompt_delivery=file-ref` — one-line dispatch for TUIs that submit on
  every newline.** agy's own transcript shows a single bracketed-pasted prompt
  arriving as **12 separate inputs** on 2026-09-08, the first being a fragment
  from the MIDDLE of the prompt, with `GOAL` and `CONTEXT` never delivered at
  all — while the wrapper reported `assigned:true` and the worker looked busy
  (it invented its own context and produced a plausible report). `file-ref`
  composes scope-guard + result-path + body into
  `$TMUX_AGENT_DIR/<name>/prompt.md` and sends ONE line naming that file, so
  there is no newline for the TUI to submit on; delivery proof matches the line
  actually sent, and an `assign.file_ref` audit event records the file, its
  byte count and sha256. `agy.conf` now ships `prompt_delivery=file-ref`;
  override per dispatch with `assign --prompt-delivery paste|file-ref`. New
  `scripts/test-dispatch-delivery-smoke` reproduces the defect (paste → 6
  inputs on a newline-submitting fake CLI) and pins the fix (file-ref → exactly
  1 input, whole task retrievable): `21 passed, 0 failed`. File-ref delivery
  records the scope-guard and result-path instructions as landed without a
  pane-echo check: that check exists to catch a half-landed *paste*, and a
  composed file either exists or does not, so requiring it would mark both
  instructions UNCONFIRMED on every dispatch and re-inject them on every
  follow-up send. A same-named profile under `~/.config/agent-tmux/profiles`
  shadows the bundled one whole (keys are not merged), so a host with its own
  `agy.conf` needs `prompt_delivery=file-ref` added there too.

### Fixed
- **`tmux-agent` mod — the v0.3.0 review round.** An external adversarial review
  (`.review/astra-v030-review.md`, `VERDICT: BLOCK`) found eight defects, all
  fixed here: four type errors that `claude plugin validate` and `claude plugin
  test` both pass over; a `ui.close` that tore the panel down on a *resolved*
  `{ deny }`, killing the mirror of a pane still on screen; a mirror that could
  start a second capture on top of a slow one, and could paint a frame captured
  before a close onto the panel reopened after it; a stall probe window pinned to
  the first eight workers, so a ninth was never probed; a stall registry that only
  ever grew, because a delivered worker was never removed; a probe timeout that
  could overrun the sweep budget by a whole probe; a control-character strip using
  a non-global regex, which cleaned only the first escape in a string; and a panel
  that drew a finished-but-undelivered worker as `running`. Each fix has a
  regression test that was mutation-checked -- reverting the fix fails that test
  and only that test (`tests/register.test.ts`, `regressions`). The one exception
  is documented at its call site: with the per-probe cap in place, the sweep's
  `left <= 0` early return cannot be told apart from the engine's own refusal of a
  non-positive `timeoutMs`, so the harness cannot isolate it.
- **`scripts/test-mod-typecheck-smoke` — the type check is no longer skippable.**
  `claude plugin validate` and `claude plugin test` do not type-check the mods, so
  v0.3.0 reached review with four `tsc` errors while both reported clean. The
  check is now a smoke, picked up by `run-all-smokes` and CI.
- **`result wait-required` waited out its whole budget on a field the producer
  never writes.** Both workers of the 2026-09-08 dispatch had written terminal
  results with `status,summary,artifacts,errors`; the parent harvested with
  `--fields status,summary,artifact_path` and sat in a `--wait 2400` for ~24
  minutes until a human asked whether it was stuck. Replaying the untouched
  results with the correct field list returns `exit 0` immediately, which is
  the whole diagnosis. A terminal result that lacks a requested field now exits
  **3** at once with `event:"contract-mismatch"`, `timeout:false`,
  `missing_fields`, and the worker's `body` attached — a finished producer
  cannot be made to answer a field it never writes, and losing its result to a
  fake timeout was the expensive part. Usage errors keep exit `2`. The waiter
  also no longer aborts on a transient read failure or a half-written
  `result.json` (agy rewrote its result 26s after the first write), and it
  checks the required fields against the SAME snapshot it returns.
  `test-result-contract-smoke` covers all of it across five profiles:
  `150 passed, 0 failed`.
- **`result wait-required` could report progress as completion.** It returned
  the moment the named fields were non-empty, so a worker's `status:"pending",
  summary:"working on it"` ended the wait as a success — the false-completion
  trap `references/multi-agent.md` warns about, reached through the field list
  instead of a stale file. The wait now also requires a TERMINAL canonical
  status (`success` with a non-empty summary, or `failed`/`blocked`/
  `needs-input`), sharing the `result_terminal_ready` adjudicator with
  `supervise`. Behaviour change for callers that deliberately polled for
  interim fields: they now wait out the bound. `contracts.md` states the new
  condition.
- **Plugin manifests and `--version` lagged the CHANGELOG by a release.**
  `.codex-plugin/plugin.json` and `.cursor-plugin/plugin.json` still said
  `0.38.0` against a released `0.39.0`, and `AGENT_TMUX_VERSION` — what
  `--version` and `doctor` print, the offline signal for multi-machine
  skill-copy drift — said `0.38.0` too because nothing compared it.
  `test-version-sync-smoke` now covers it: `4 passed, 0 failed`.
- **`test-result-path-once-smoke` merged stderr into a JSON payload.** The
  `send-wait` result-fallback case captured `2>&1`, so the `codex-tmux` shim's
  deprecation banner (`print -u2`) landed in front of correct JSON and both
  `jq` reads failed. The payload was always right
  (`completion_source: result_json`, `submitted: true`); the capture was wrong.
  Now `26 passed, 0 failed`.
- **`using-tmux-agent-tools` contradicted the dispatch gate.** ONE OWNER told
  the parent to dispatch with `assign --detach` "in a short foreground call",
  which `tmux-assign-host-gate.sh` blocks outright (with or without
  `--detach`). Following the hook instead meant a BLOCKING `assign` inside a
  proxy sub-agent, reaped at ~600s three times on 2026-09-03, each reporting
  in-flight with nobody left to wait. The shape that satisfies both is now
  stated: proxy runs `assign --detach`, parent harvests with bounded
  background `result wait-required`.
- **`result-path delivery UNCONFIRMED` was documented as a delivery failure.**
  For `heuristic_family=generic` (cursor) `_sentinel_trustworthy` declines to
  mark by design, so the warning fires on every dispatch while the path
  instruction is re-injected on every send. The skill no longer reads it as
  proof of permanent `pending`, and notes that a TUI collapsing pasted input
  makes a pane capture inconclusive either way.
- **`cursor` resolved the wrong binary.** The bundled profile and the legacy
  preset both set `bin=cursor`, but the Cursor agent CLI installs as
  `cursor-agent`; `cursor` is the editor launcher and never starts an agent
  TUI. Line 268 does one `command -v` with no fallback, so every
  `agent-tmux cursor assign` died at the `start` step with
  `cursor not found at <empty>` and `assigned: false` — measured 2026-09-03,
  worked around only by passing `CURSOR=/path/to/cursor-agent`. The script's
  own approval-prompt comment already referenced `cursor-agent`, so the preset
  was the odd one out. Verified: `agent-tmux cursor doctor` now reports
  `cursor: …/cursor-agent` with no env override.

### Added
- **`assign` — the stepwise dispatch sequence as one command** (W32 retro M5,
  P0). Runs `start --exact` → `result init` → `send --from-file` → a
  confirm-processing check (busy probe, else pane-still-changing fallback) →
  one blocking `supervise --result-required`, refusing to continue past a
  failed step and printing the failed step + pane capture + a JSON line on
  error. Encodes the user-verified sequence that replaces the stale
  `start --prompt-file` shape (worker sits idle with no task; the symptom
  mimics an auth hang — re-hit by ≥4 sessions after the lesson was recorded).
  Smoke: `scripts/test-assign-smoke`.

## v0.39.0 - 2026-07-30

### Changed
- **tmux-dispatch-gate hardened to proxy enforcement.** GATE 1 no longer
  accepts a read-the-rules receipt from the parent session: task-carrying
  dispatch (`start`/`send`/`send-wait`) now passes only from a subagent
  context (harness-injected `agent_type`, probed on Claude Code 2.1.220).
  The parent's escape hatch is `gate-receipt-parent-dispatch` quoting the
  user's explicit direct-dispatch instruction. The old
  `gate-receipt-dispatch` marker is retired.
- GATE 2 (workflow escalation) now counts review-shaped dispatches from
  subagent contexts too — the pass-through was moved after the counter, so a
  proxy-driven manual review loop still escalates to a workflow recipe.
- Gate receipts are content-validated: a receipt opens a gate only if it
  carries a `YYYY-MM-DD` date and at least 40 bytes of rationale; an empty
  `touch` no longer counts.

## v0.38.0 - 2026-07-28

### Deprecated
- The per-CLI shims `claude-tmux` / `codex-tmux` / `agy-tmux` are deprecated in
  favor of the canonical `agent-tmux <cli> <command>` spelling. They keep
  working through v0.38 but print a one-line stderr warning
  (suppress with `AGENT_TMUX_SUPPRESS_DEPRECATION=1`); removal is planned for
  v0.39. All docs, skills, references, and the wiki now use the canonical
  spelling; `tmux-agent-fanout` and `tmux-agent-sessions` invoke
  `agent-tmux <cli>` directly instead of resolving shim paths at runtime.
  The `wrapper` display field in `tmux-agent-sessions` JSON keeps the legacy
  names until the v0.39 removal.

### Added
- `start` now waits out transient CLI startup screens (new
  `blocked_reason=startup_pending`, e.g. agy "Verifying your account
  eligibility") before injecting the initial prompt, fails loudly at
  `AGENT_TMUX_START_READY_TIMEOUT` (default 45s) if the screen never clears,
  and blocks `send` paths while the screen shows. "Please run /login"
  screens classify as `login_prompt`. (`scripts/test-start-readiness-smoke`)
- Runtime-agnostic dispatch gate: when `AGENT_TMUX_REQUIRE_GATE_RECEIPT` is
  set, dispatch-shaped commands (`start`/`resume`/`start-ssh`/`send`/
  `send-wait`/`send-wait-literal`) are refused with
  `blocked_reason=gate_receipt_missing` unless the receipt file named by
  `AGENT_TMUX_GATE_RECEIPT` exists. Mirrors the Claude Code dispatch-gate
  hook for runtimes without a hook system (Codex, agy).
  (`scripts/test-gate-receipt-smoke`)
- The Claude Code plugin now ships a `PreToolUse(Bash)` hook
  (`hooks/hooks.json` + `hooks/tmux-dispatch-gate.sh`, moved here from
  ohyeh/agent-scripts): GATE 1 requires a per-session dispatch receipt before
  driving tmux workers from a parent session; GATE 2 routes the second
  review-shaped dispatch of a session to a workflow recipe. Subagent
  (supervision proxy) contexts pass through. The review-shape detector now
  also sees names behind bare flags (`start --exact review_x`).
  (`scripts/test-dispatch-gate-hook-smoke`)

### Changed
- `skills/tmux-agent-tools/SKILL.md` is repositioned as the mechanics
  library; the `using-tmux-agent-tools` router skill is the single entry
  point.

### Fixed
- Secret redaction: values containing backslashes (e.g. `\d`) leaked
  unredacted from `capture` because `awk -v` C-escape processing mangled the
  literal match value; the secret now reaches awk via `ENVIRON`, which does
  no escape processing. (`test-secret-uri-smoke` regex-meta case)
- `tmux-agent-sessions list`/`watch` died under `set -euo pipefail` whenever
  the tmux server had no sessions at a poll tick (`tmux ls` exits 1), so
  `watch` silently emitted no events on an otherwise idle machine; an empty
  server now yields an empty inventory. (`test-sessions-watch-smoke`)

## v0.37.0 - 2026-07-26

### Changed
- The supervision-proxy mandate is now runtime-neutral. It was documented only under "CODEX VISIBILITY" / "Codex native proxy" headings, which a Claude Code commander read as Codex-only and drove tmux workers directly with `send-wait` (observed in a live session on 2026-07-26, violating model-dispatch §4's "supervise external CLI worker → general-purpose on haiku" row). The router section is renamed "NATIVE PROXY (ALL RUNTIMES)", the hub fast-path and `references/core-workflow.md` (heading renamed to "Native proxy for an external CLI worker") name the Claude Code shape explicitly (`general-purpose` sub-agent on `haiku`), and all three surfaces now state the hard boundary in place: the parent MUST NOT run `start`/`send-wait`/`supervise` on an external worker directly — exactly one supervision-only native proxy owns it.

## v0.36.0 - 2026-07-21

### Added
- Codex-native proxy routing for external CLI workers: one supervision-only native sub-agent named `<cli>_<task>` drives exactly one existing `claude-tmux` / `codex-tmux` / `agy-tmux` / `agent-tmux <cli>` worker so Codex App can track allocation and running/done state. Shell supervision prefers `gpt-5.6-luna`, falls back to `gpt-5.6-terra`, and reserves `gpt-5.6-sol` for proxy tasks that need frontier reasoning. Headless proxies summarize material progress changes with a bounded heartbeat; headed proxies report passive pane liveness and use `ping` only when stale. External `result.json` remains terminal evidence, and runtimes without native sub-agents fall back explicitly as `UNAVAILABLE-NATIVE`.

### Fixed
- Audit events are now written to the documented default path without requiring `--audit-log` or an environment opt-in. `AUDIT_LOG=0` remains an explicit opt-out, and directory/append failures now fail fast instead of silently losing telemetry.
- `result.json` writers and templates now use `success|failed|blocked|needs-input`. Read surfaces normalize legacy spellings into `canonical_status`, while schemas keep accepting existing string values so on-disk results remain valid.

### BREAKING
- Retired the `tmux-delegate` / `codex-oneshot` / `claude-oneshot` subagent defs and their four synced locations (`agents/`, `.claude/agents/`, `.codex/agents/*.toml`, `skills/tmux-agent-tools/agents/`), plus the `.gitignore` whitelist that tracked the project-local copies. Rationale: usage-trigger investigation found 100% of real `codex-oneshot`/`claude-oneshot` invocations (16/16) already depended on repo-local `.claude/agents/` auto-discovery rather than the plugin-root registration, `tmux-delegate` itself had 0/16 real triggers (its decision logic was already being carried ambiently by the `using-tmux-agent-tools` router prose), and `codex exec` never exposed the `.codex/agents/*.toml` mirrors as `spawn_agent` agent_type values at runtime despite passing Codex's validator. The inline-vs-worker gate and the one-shot forwarding pattern now live directly in `skills/using-tmux-agent-tools/SKILL.md` as a forcing-gate section (observable-trigger + naming obligation, not ambient advice) — no file to install, no plugin-restart lifecycle, and one fewer four-way drift surface to maintain (the skill-packaged `agents/` copy had already silently drifted from the canonical source before this change). `scripts/test-agent-delegate-packaging-smoke` is repointed accordingly: it now asserts the four legacy locations stay gone and that the skill carries the gate in forcing-gate form. GitHub repo metrics at removal time (0 stars/forks/watchers, 14-day views=1, clone count consistent with the maintainer's own machine fleet + bot traffic) support no silent external consumer of these subagent defs, but this is **UNCONFIRMED** — if you installed this plugin and relied on the `tmux-delegate`/`codex-oneshot`/`claude-oneshot` subagents, the equivalent decision logic is now in the `using-tmux-agent-tools` skill's "Inline-vs-worker gate" section; there is no drop-in subagent replacement.

## v0.35.0 - 2026-07-11

### Added
- `start --task-shape <bounded|series|review-loop|exploratory>` — validated enum recorded in `launch-meta.json` (schema_version 1, additive; invalid values exit 2; free text rejected by design so launch metadata never carries task-sensitive prose). The `tmux-delegate` agent now decides the shape at the delegate-or-inline gate and passes it on every start skeleton — routing decisions become fleet telemetry instead of unverifiable prose compliance.
- `stats` gains top-level `by_task_shape` + `task_shape_coverage`, and `--exclude-selftest` (CLI-anchored name patterns with an `excluded_selftest` count in both JSON and text output — patterns deliberately anchored to known CLI tokens so legitimate workers like `wc-feature` or `release-smoke` are never swept up).
- Router (`using-tmux-agent-tools`) decision tree: persistent-teammate branch ahead of the headless default (interactive `start`, reuse via the canonical worker-reuse protocol pointer), a `resume` line, a loop-shaped-work branch routing whole audit/plan→build/consensus chains to `using-workflows` (mirror of its existing downward pointer — the two routers are now bidirectional), and a new "After the result returns" section (success/failure/series verbs, pointers only).
- `agents/tmux-delegate.md`: one-shot-vs-teammate relationship question, inline boundary clarification (a single already-known test/build/lint command runs inline even when it touches many files), and `--task-shape` in all start skeletons.
- Capability cheatsheet: persistent-teammate scenario row; stats row documents `--exclude-selftest` and the task-shape fields. Skill hub documents the agent model ladder (forwarders haiku, delegate gate sonnet, worker per task).

### Fixed
- `start-ssh` never wrote `launch-meta.json`, `started_at`, or the usage ledger init event, violating the launch-metadata parity the stats work specified — remote-target workers were invisible to `stats`. Now writes all three in the same order as local `start` (found by a Codex adversarial review of this release's diff).

## v0.34.0 - 2026-07-10

### Added
- `skills/unknowns-discovery/` — standalone skill for surfacing map/territory gaps before they get expensive (blindspot pass, brainstorm-before-code, user-invoked interview, references, plan review, explainer). Adapted from "A Field Guide to Fable: Finding Your Unknowns" (Thariq, Anthropic); the stop-and-ask conditions are inlined in a self-contained `§STOP` section so the UNIVERSAL GUARD has no external dependencies.
- `skills/delegation-templates/` — five fill-in-the-blank delegation prompt templates (SEARCH/LOCATE, IMPLEMENT, REFACTOR, RESEARCH, REVIEW/VERIFY) + a common REPORT footer, with dual dispatch shapes: in-process Agent tool and tmux worker (`--prompt-file`, literal injected result path per the result.json contract — never `$TMUX_AGENT_RESULT` in tool sandboxes, plus the no-cascade ban). Prompt-shape only; delegate-or-not, invocation, and supervision stay with the tmux-delegate agent and the tmux-agent-tools skill. Shipped through a 5-round Codex adversarial gate (3 BLOCKs fixed: `$TMUX_AGENT_RESULT` misuse, ownership-boundary inconsistency, rule-sentence duplication into the router).
- Both skill hubs now route worker-prompt shaping to `delegation-templates`: `using-tmux-agent-tools` gains a Prompt-shape router gate, `tmux-agent-tools` a Fast-answers pointer, and `agents/tmux-delegate.md` points worker prompts at it — pointers only, no rules restated.

## v0.33.0 - 2026-07-10

### Added
- Wrapper-owned terminal envelope + append-only launch ledger (P0 from the 2026-07-10 usage survey — ~40% of workers left no result.json and same-name restarts were unrecoverable). `start` now generates a `launch_id` (stamped into `launch-meta.json` and a `usage.jsonl` init event; restart = new launch, never an overwrite), and the wrapper guarantees a terminal envelope on every ending — `launch_id`, `finished_at`, `terminal_reason` (`agent-result|process-exit|stopped|max-runtime|unknown`), `process_exit_code`. Agent-written result fields are merged, never clobbered; invalid agent JSON is preserved as `result.json.invalid` next to a parseable skeleton; heal-on-read refolds lifecycle fields from the ledger when a non-cooperating background writer rewrites result.json after the envelope ran.
- `stats [--json] [--since YYYY-MM-DD]` — usage stats over the state dir: `total`/`by_month`/`by_exec_mode`/`by_cli`/`result_coverage`/`status_buckets`/`status_raw_top`, plus a `launches` block (`total`/`ended`/`end_coverage_pct`/`by_terminal_reason`/`name_reuse`) with line-tolerant ledger parsing (one corrupt line no longer zeroes the fleet). `start` writes `launch-meta.json` (`{schema_version,cli,exec_mode}`) so tui/oneshot/headless are distinguishable.
- `status_bucket_of()` normalizes 20+ observed status spellings into `success/partial/review/failure/unknown`; `result validate --json` gains an additive `status_bucket` field and a stderr hint on unknown statuses.
- `capture <name> --tail <N>` — flag alias for the positional `lines` argument (scan-anywhere; flag wins over positional with a stderr warning; empty `--tail=` is exit 2).
- `--version`/`-V` (top-level and per-CLI) backed by a new `AGENT_TMUX_VERSION` constant; `doctor` prints version + install path, so multi-machine skill-copy drift is visible offline.
- Wrong-engine hint: `status`/`watch` on a missing session scan the other CLI's prefix (tenant-aware); a same-name session elsewhere emits `hint: session exists under <other-cli> prefix — wrong engine?` on stderr and an additive `wrong_engine_hint` JSON field (watch includes it per-agent). Exit codes unchanged.
- `TMUX_AGENT_TOOLS_HEADLESS_FLAGS` env override — replaces the CLI's headless preset flags wholesale for dogfooding; empty override on a CLI whose subcommand lives inside those flags (codex `exec`) is exit 2 naming the variable.
- New smokes: `test-lifecycle-smoke` (43 checks incl. invalid-JSON, clobber-heal, corrupt-ledger, stop-idempotence failure paths), `test-stats-smoke` (35), `test-p1-batch-smoke` (16); `test-capture-smoke` and `test-headless-smoke` extended to 70/19 checks.

### Fixed
- Global `--audit-log` argv prepass consumed the `--` end-of-flags boundary, silently re-exposing post-boundary tokens to downstream scan-anywhere parsers (pre-existing; surfaced by capture `--tail` adversarial review). The boundary and everything after it now pass through untouched.
- `result validate` on schema-invalid results aborted under `set -e` before emitting its JSON verdict (unguarded command substitution); guarded with `|| rc=$?` and covered by regression checks.
- Team/collab smoke suites cleaned up with `tmux kill-server` in EXIT traps, killing unrelated live sessions (including any worker running the suite). Replaced with ownership-based cleanup: snapshot sessions at start, kill only new-since-snapshot sessions carrying the test's team name. `test-audit-query-smoke` no longer leaks a worker via tenant-start/non-tenant-stop mismatch.

## v0.32.0 - 2026-07-10

### Added
- `start --headless` — first-class headless one-shot mode, no profile file needed. Runs the CLI non-interactively (`claude --dangerously-skip-permissions -p '<prompt>'`, `codex exec --dangerously-bypass-approvals-and-sandbox '<prompt>'`; flags verified against the installed CLIs): prompt passes as argv, completion = process exit, no TUI rendering quirks, no pane-heuristic false WAITING. CLIs without a built-in headless invocation exit 2 with guidance to set the new profile keys.
- New profile keys `headless_flags` / `headless_prompt_flag` — swapped in for `launch_flags`/`prompt_flag` under `start --headless`, so one profile serves both interactive and headless starts. Bundled claude/codex profiles ship them; documented in `profiles/README.md` and `profile.conf.example`.
- `scripts/test-headless-smoke` — 13 checks: preset dry-run command assembly (claude `-p`, codex `exec`), unsupported-CLI exit 2, synthesized-result contract via `result wait-required`, worker-authored result preservation.

### Changed
- Oneshot exit-time `result.json` synthesis now emits the full completion contract — `summary` (stdout tail, `(no output)` fallback), `artifacts: []`, `errors: []` alongside `status`/`exit_code`/`stdout_path` — so `result wait-required --fields status,summary` returns the moment the process exits instead of stalling to timeout when the worker wrote no result ("done but stuck WAITING" fix). Synthesis is now also conditional: a result.json the worker wrote itself is preserved, never clobbered (stale results are still cleared at start).
- `claude-oneshot` / `codex-oneshot` forwarder agents start their worker with `--headless`, making the single bounded `result wait-required` deterministic.
- Skill routing now sends bounded fire-and-collect tasks down the headless path first: `SKILL.md` fast answer + command-choice row + headless example block, `using-tmux-agent-tools` decision-tree branch, `references/cheatsheets.md` scenario row, and a new `references/troubleshooting.md` section for the WAITING stall.
- `profiles/README.md`: removed the stale "oneshot not yet active" note (#268 shipped it).

## v0.31.1 - 2026-07-04

### Fixed
- Bumped the three plugin manifests to match the release train so `scripts/test-version-sync-smoke` stays green after the `v0.31.0` workflow bundle release.
- Updated README and wiki first-run docs to prefer the skill-first `send-wait` / wrapper-provided result-path flow instead of steering users toward bare `send` or `$TMUX_AGENT_RESULT` as the primary structured-result path.

## v0.31.0 - 2026-07-04

### Added
- `.claude/workflows/` — 13 saved dynamic-workflow recipes shipped as a team snapshot, `/name`-callable by anyone who clones the repo: drift audits (`docs-vs-code-audit`, `design-vs-code-audit`, `root-cause-deep-dive-audit`), adversarial consensus (`consensus-gate`, `design-consensus`, `feature-plan-consensus`), plan/build pipelines (`plan-pipeline`, `feature-lifecycle-auto`, `spec-implement-dual-review-verify`), `project-direction-review`, the `findings-triage` loop connector (clusters confirmed findings by root cause into mini-PRD briefs / a partitioned-fix list / human intent questions — fail-closed, no finding is ever dropped), and the self-regenerating `workflow-manifest` fleet snapshot; plus shared `_lib/` (fail-closed helpers, findings schema, worker doctrine). Second-model review is neutral throughout: `args.cli` accepts any agent-tmux profile — nothing is hardcoded to codex.
- `skills/using-workflows/` — meta-router skill: routes a described situation to the right recipe via a decision tree with live recipe discovery (never a memorized list), auto-fills args (`cli`/`context`/paths), and chains the closed loop (audit → findings-triage → briefs/direct fixes → re-run the same audit until zero confirmed findings). Optionally co-fires with the `codex-dynamic-workflows` skill (if installed) for `.workflow/<slug>/` run records. Bundles the full recipe set under `workflows/` with `scripts/install.sh` for one-command deployment to `~/.claude/workflows/` or a repo's `.claude/workflows/` (refuses to overwrite files whose content differs unless `--force`).
- `docs/workflow-usage-guide.md` — day-to-day tutorial: 30-second mental model (scheduler / control-flow / executor layers), scenario-to-recipe cheat sheet, zero-install onboarding for new repos, and the feedback loop (wording edits go direct; behavior edits pass `consensus-gate` first).

### Changed
- `codex-consensus-gate` renamed to `consensus-gate` (reviewer = any `args.cli` profile; behavior byte-identical). The old name remains as a deprecated top-level-only forwarding shim. `plan-pipeline` / `feature-plan-consensus` / `spec-implement-dual-review-verify` wording neutralized from codex-specific to second-model-via-`args.cli`.

## v0.30.0 - 2026-07-04

### Added
- Skill payload now ships the delegation policy layer, not just the scripts: `agents/` (tmux-delegate gate + claude/codex one-shot forwarders, installable by copying into `~/.claude/agents/`), `schemas/` (offline `result.json`/fanout validation fallback already resolved by the scripts), `references/troubleshooting.md` and `references/recipes.md` (packaged copies of the wiki pages), and a CI-mode exit-code table in `references/contracts.md`.
- Persistent-teammate worker-reuse policy: new `references/multi-agent.md` section documenting when to reuse one named worker across sequential same-repo tasks vs start fresh, the `result init -> send-wait -> result wait-required` reuse loop, and the stale-`result.json` false-completion trap; mirrored as SKILL.md non-negotiable rule 4 and a Decision Rules line in all four tmux-delegate copies.

### Changed
- `install-bin` links every executable wrapper in `scripts/` via a loop instead of a hand-maintained list, fixing 8 missing symlinks (fanout, dag, cron, monitor, notify, replay, history, dashboard).
- Dev-only eval fixtures moved out of the installable skill payload to `skills/tmux-agent-tools-workspace/evals-archive/`.
- `test-agent-delegate-packaging-smoke` extended: skill-packaged agent/schema/doc copies drift-checked against repo canonicals, CI exit-code table coverage guarded, and evals excluded from the payload (46 checks).

## v0.29.0 - 2026-07-02

### Added
- `<NS>_TMUX_EXTRA_LAUNCH_FLAGS` / `AGENT_TMUX_EXTRA_LAUNCH_FLAGS` append to the effective launch flags (existing `*_LAUNCH_FLAGS` stays full-replacement), and `start --effort <v>` expands a new profile `effort_flags` template with the shell-quoted value (`codex.conf` ships `-c model_reasoning_effort=%s`; profiles without the key reject `--effort` with exit 2). Both surface in `start --dry-run` JSON. Launch-flag env vars are documented as operator-controlled raw shell fragments, not a sanitized argv API (#302).

### Changed
- CI now runs the full smoke suite on every push/PR via new `scripts/run-all-smokes` (per-test 180s timeout, one retry with visible `FLAKY-PASS`/`TIMEOUT` classification, summary table, non-zero exit on residual failure), with `scripts/lint-no-path-tied-locals` as an early step; job timeout raised 10→30 minutes and coreutils added to the runner.
- Skill docs hardened with this round's observed operational traps: the flag-order rule (flags precede positionals), `tmux ls` replaced with `tmux-agent-sessions list`, a cheatsheet triage row, and the commander shrinking-fleet watch loop including the check-`result --json .present`-before-re-arming-`watch --any` nuance (#301).
- writing-great-skills pass over the skill docs: repointed three stale `using-tmux-agent-tools` references that still aimed at SKILL.md's removed "Script capability table" section (the table moved to `references/cheatsheets.md` → "Full script capability table" in v0.28.0), and deduplicated `tmux-agent-tools/SKILL.md` so each rule lives in one place (engine-only ban, PATH fallback, send-wait nonce mechanism, no-polling rule — previously each stated twice). Net −1 line; CI skill-metadata validation still passes and the body stays under the 8KB gate.

### Fixed
- Six #300 hardening fixes to the engine and helper scripts: renamed zsh tied-special locals (`status`, `path`) flagged by `scripts/lint-no-path-tied-locals` — including a runtime-broken `status=` assignment in `tmux-agent-sessions`; `capture_session` no longer reads the undefined `$lines` tied special (renamed to `tail_count`); `send_lock_around`'s mkdir lock fallback is bounded (returns 75 on an unwritable state dir instead of looping forever); `TMUX_AGENT_TOOLS_SESSION_ENV` bare keys deterministically resolve the caller's value and clear-disabled mode (`*_TMUX_CLEAR_*_ENV=0`) explicitly passes provider env through; transcript send events record the caller's text (before task-scope/result-path prepends) via `transcript_emit_send_event`, and liveness/transcript wait-text calls pass `--regex` for regex patterns (#300).
- The task-scope guard preamble is injected once per session (sidecar marker with the #283 semantics: marked inside the send lock right after paste; a wait-timeout still counts as delivered; lock timeout/paste failure/blocked refusal do not mark) instead of on every prompt-bearing send. Fixes the pane-freeze -> false `--max-idle` kill chain against workers that do not consume stdin, and stops re-spending ~330 bytes per follow-up send (#298).
- `start`/`resume`/`start-ssh` and the send family now reject flag-looking tokens that land in positional slots with `unknown or misplaced flag: <tok> (flags must precede positionals; see usage)` and exit 2, instead of silently consuming them as `<name>`/`<directory>` and failing with a misleading `Directory not found: --flag` (#299).
- `codex-oneshot`, `claude-oneshot`, and `tmux-delegate` agents no longer assume `agent-tmux`/`claude-tmux`/`codex-tmux` are on PATH. Wrappers are now resolved from a skill bundle first — probing `<repo-dir>/skills`, `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` in order — with PATH lookup as last-resort fallback, so `npx skills add`-style installs work without `install-bin`/Homebrew. `.claude/agents/*.md` and `.codex/agents/*.toml` mirrors regenerated in sync. Verified end-to-end with a clean PATH: template execution against a real codex worker, plus a haiku-model forwarder run against a real claude worker.

## v0.28.0 - 2026-07-02

### Added
- Added `agents/codex-oneshot.md` and `agents/claude-oneshot.md` as thin one-shot forwarder agents, with matching `.claude/agents/` mirrors for Claude Code discovery (#293).
- Added `mcp-adapter/`, a Node.js `codex-tmux-agent-adapter` MCP server exposing `spawn_tmux_agent`, `send_tmux_agent`, `wait_tmux_agent`, `read_tmux_agent`, and `close_tmux_agent` as an optional programmatic integration path. The primary integration remains native agent/skill discovery through `SKILL.md` and host-local conventions (#293).
- Added Codex-native discovery mirrors: `.codex/agents/*.toml` custom-agent definitions converted from `agents/*.md`, plus a `.codex/skills/tmux-agent-tools` symlink to the canonical skill, so Codex can discover the same local content Claude Code reaches through `agents/` and `.claude/agents/` without MCP registration (#293).

### Changed
- Slimmed `skills/tmux-agent-tools/SKILL.md` from roughly 36KB to under 8KB by moving the full workflow and profile detail into `references/core-workflow.md` and `references/profiles.md`, keeping first-open guidance focused while preserving the deeper reference material (#293).
- Hardened `agent-tmux` against live-worker friction: boot-time trust gates now surface structured `blocked` / `blocked_reason` status instead of hanging, worker prompts get a default task-scope project-config guard with `--allow-project-config` as the opt-out, nonce wait timeouts accept fresh authoritative `result.json` completion, and `send --key enter|up|down` provides explicit key delivery (#293).

### Fixed
- Fixed Codex login-prompt false positives in the boot trust gate by anchoring blocking checks to the pane's current prompt area instead of scanning unrelated scrollback, avoiding matches from old MCP login banners or commit-message text that merely mentioned login prompts (#293).

## v0.27.0 - 2026-06-25

### Added
- File/stdin prompt input for `start`, `start-ssh`, `send`, `send-wait`, `send-wait-literal` (#289): `--from-file <abs>` and its alias `--prompt-file <abs>` (aligns with `tmux-agent-fanout`/`tmux-agent-dialogue` naming), plus `-` to read the prompt from stdin. The file/stdin body becomes the prompt verbatim, so large multi-line packets with shell-special characters (`&`, quotes, `$`, backticks), URLs/deeplinks, and non-ASCII no longer need inline shell-quoting. Flags are position-independent (a shared prepass extracts them from anywhere in the argv), so the documented shapes `start --exact N DIR --prompt-file P` and `send-wait N --prompt-file P <timeout>` work. Verified across two rounds of adversarial codex review (which caught that the first cut only accepted the flag before the positionals).
- `agy` is now a first-class tool in `tmux-agent-sessions` (#290): `--tool agy` is accepted by `list`/`watch`/`cleanup`/`resolve`, the `agy-cli-` prefix is recognized, and all usage/error strings enumerate `claude|codex|agy|dialogue`. This makes `tmux-agent-sessions` a genuine engine-neutral supervision surface for mixed codex+agy+claude fleets.

### Changed
- Documented engine-agnostic name resolution semantics for `watch`/`result`/`status` (#290): result paths resolve by bare session name (`$TMUX_AGENT_DIR/<name>/result.json`, fully engine-independent, so result-based `watch` triggers — `reason:result_updated` — are cross-engine), while `status`/`watch` tmux liveness checks are prefix-tied (a still-running foreign-engine session can read as a false `exited`). For mixed fleets, rely on result-based completion and/or `tmux-agent-sessions`. Added a mixed-fleet example to SKILL.md and references/cheatsheets.md.
- When the wrappers/CLIs are not on `PATH`, the not-found diagnostic now points at `install-bin` (or adding the bundle `scripts/` dir to PATH), saving a discovery step (#290).

## v0.26.1 - 2026-06-24

### Changed

- Unified the version carriers (#286). The three plugin manifests (`.claude-plugin`, `.codex-plugin`, `.cursor-plugin` `plugin.json`) had drifted to `0.24.0`/`0.20.0` while releases were at `v0.26.0`; all three are now bumped in lockstep with the release. A new `scripts/test-version-sync-smoke` guard (wired into CI and the release validation) fails the build if any plugin manifest version diverges from the latest `CHANGELOG.md` `## vX.Y.Z`, so this drift cannot silently recur. The Homebrew formula is intentionally excluded from the guard since it is bumped in a separate post-release PR and lags the tag by design.

## v0.26.0 - 2026-06-24

### Fixed

- Result-path injection is now **once per session** instead of on every send (#283). For `result_path_via_prompt=true` CLIs (codex and generic), the `Write final JSON to this exact path: …` instruction was prepended to *every* `send`/`send-wait`, corrupting follow-up prompts and making it impossible to answer a TUI prompt with a single keystroke. The instruction is now injected only on the first prompt-bearing `start`/`send`, tracked by a per-session sentinel written **inside the send lock right after the prompt reaches the pane** — so a wait-timeout still counts as delivered (the next send won't re-inject), while a lock-acquisition timeout or paste failure correctly does not mark. Verified across two rounds of adversarial codex review, which caught a `set -e` control-flow bug in the first cut (caller-side marking was skipped on a non-zero wait return).

### Added

- `send --raw <name> <keys>` delivers literal keystrokes with no result-path/nonce prefix and no trailing Enter (unless `--enter-count N>0`), under the same send lock and wrapper session resolution (#283). Use it to answer a TUI prompt with a single key, e.g. `send --raw <name> t` for a hook-trust prompt.
- `status --json` now surfaces plugin hook-trust prompts: a new `hook_trust_prompt` `blocked_reason` (with `confirmation_detected:true` and a diagnostic) fires on pane text like "N hooks need review … Press t to trust", using hook/trust-anchored patterns that do not false-trigger on ordinary "needs review" prose (#283).
- `start --model <model>` pins a worker's model for that run, passed through to the CLI as `--model <model>` (shell-quoted, shown in `--dry-run`, not validated per-CLI since env vars like `ANTHROPIC_MODEL` are unreliable). For a durable per-CLI default, set `launch_flags` in the profile (#283).
- The `tmux-delegate` subagent now ships at the plugin root `agents/tmux-delegate.md` so it is registered for installed-plugin users (previously only `.claude/agents/` existed, which only works in a checked-out repo). A smoke test keeps the two copies byte-for-byte in sync (#283).

## v0.25.0 - 2026-06-24

### Changed

- Hardened the tmux-agent skill guidance against two recurring failure modes: agents bypassing the engine with raw `tmux`, and prompts that look sent but never submit. `skills/tmux-agent-tools/SKILL.md`, `skills/using-tmux-agent-tools/SKILL.md`, and the `tmux-delegate` agent now carry three non-negotiable rules. (1) Engine-only: drive workers exclusively through `agent-tmux <cli>` subcommands — never raw `tmux send-keys`/`capture-pane`/`new-session`/`kill-session`. (2) Prefer the managed/Agent path over ad-hoc shell, dropping to shell only for genuine gaps. (3) A `send` is not confirmed until verified — default to `send-wait` (fresh nonce), treat a timeout as *unconfirmed* (check `status --json` + `probe --metric` for the busy signal, since `status`/`ping` expose none; resend only if idle), and raise `<NS>_TMUX_SUBMIT_DELAY` for slow TUIs. Also clarified the cascade-spawn ban covers further tmux/engine workers, not Claude Code's separate in-process `Agent`-tool nesting. Verified across 11 rounds of adversarial codex review against the agent-tmux implementation.

## v0.24.0 - 2026-06-22

### Changed

- `tmux-agent-dialogue` now supports **any** CLI agent-tmux can drive as a real participant (claude, codex, agy, gemini, cursor, grok, in-house CLIs, …), not just claude/codex. Real participants are driven directly through the engine as `agent-tmux <cli>` (the claude-tmux/codex-tmux/agy-tmux shims are themselves only `exec agent-tmux <cli>`), so a new CLI works with zero per-CLI code — no shim required — matching how the rest of the suite generalized. `--agent-a/--agent-b` accept any non-flag CLI name (unknown CLIs get generic defaults and fail clearly at launch if their binary is missing); `fake` is unchanged. The transcript schema's `.agent` field relaxed from the `codex|claude|fake` enum to any non-empty string (backward compatible). Enables e.g. claude↔agy or claude↔gemini pair-review/critic/debate/handoff.

## v0.23.0 - 2026-06-22

### Added

- Added a second skill, `using-tmux-agent-tools`: an on-demand meta-router (modeled on the using-superpowers pattern) that routes a tmux-agent task to the right wrapper via a task-shape → wrapper decision tree, then defers to the canonical capability table in `tmux-agent-tools/SKILL.md` (single source of truth, no duplication). Covers all 17 wrappers plus the inline-vs-worker delegate gate, and encodes the router-level gates (multi-agent authorization, cascade-spawn ban). Auto-discovered via the existing `skills/` plugin scan (#274, #275).

## v0.22.0 - 2026-06-22

### Added

- Added `scripts/profiles/profile.conf.example`: a canonical generic profile template documenting every supported profile key (bin/env_ns/launch_flags/heuristic_family/pattern_*/session_id_pattern/session_id_capture/exec_mode/prompt_via/prompt_flag) with inline guidance. New CLIs now start from one template instead of copy-pasting a CLI-specific example (#270).
- `.gitignore` now blocks `scripts/profiles/*.conf` (personal/local profiles live in `~/.config` and must never ship in the repo) while whitelisting `*.conf.example` templates. Already-tracked bundled defaults (agy/claude/codex/cursor/grok.conf) are unaffected — gitignore does not untrack committed files (#270).

### Changed

- `scripts/profiles/README.md` points users to `profile.conf.example` as the single entry point and removed the redundant inline gemini example.

### Fixed

- `agy`, `cursor`, and `grok` bundled profiles (and the engine preset fallback) switched `heuristic_family` from `codex` to `generic`. The codex family's provider-inheritance gate (`cli_provider_env_keys`) was injecting the full `OPENAI_*`/`CODEX_*` credential set into these CLIs' tmux panes, which is wrong for them (notably agy, which is Anthropic-backed). Generic inherits zero provider keys; each CLI must receive credentials via its own env/cc-switch injection. Pane detection is unchanged because codex and generic share the same `probe_generic_metric_parse` path (#271).

### Removed

- Removed `scripts/profiles/gemini.conf.example`; the generic template supersedes it (#271).

## v0.21.0 - 2026-06-21

### Added

- Added `exec_mode=oneshot` (#268): run any CLI headless once in-pane via one argv path — flag form (`prompt_flag=-p` → `cli -p "<prompt>"`) and subcommand form (`launch_flags=exec`, empty prompt_flag → `cli exec "<prompt>"`). The prompt is passed as a single shell-quoted argv, `result.json` is synthesized, marker `__AGENT_TMUX_ONESHOT_EXIT__<code>` is printed, the pane stays open, and `status --json` reports `exit_detected` / `exit_code`. New profile keys: `exec_mode`, `prompt_via`, and `prompt_flag` (default `interactive` / `paste` / empty). Closes #268.
- Added `session_id_capture=off|supplied|transcript` (v3): Claude supplies a race-free `--session-id` written to the sidecar before launch; Codex and Agy correlate a CLI-owned transcript/store after launch (null-on-ambiguity with one observable signal). A mutual-exclusion single writer protects the sidecar. Bundled profiles remain default-off until per-CLI L-phase enablement.

### Changed

- CI now runs `test-session-meta-smoke` and `test-oneshot-smoke`. Added `scripts/test-oneshot-smoke` (28 checks); `test-session-meta-smoke` expanded 27→58 checks for Codex/Agy correlation plus decoy and ambiguity fixtures.

## v0.20.0 - 2026-06-20

### Added

- Added opt-in v2 session resume: `agent-tmux <cli> resume` can reattach to a prior CLI session via a `cli_session_id` captured into a per-session `session-meta.json` sidecar. Capture is label-anchored then RFC-4122-validated; decoy UUIDs on non-matching lines are ignored.
- Added `scripts/test-session-meta-smoke` (27 checks): null init, UUID validation, blank-pattern no-op, sidecar field reads, invalid-UUID rejection, and label-anchored decoy handling.

### Changed

- `result --field .cli_session_id` now reads the `session-meta.json` sidecar independently of `result.json`, so the post-start / pre-final-result resume window works without an initialized result file.
- `tmux-delegate` subagent and SKILL.md document the v2 resume capability and its default-off guardrail.

### Security

- Bundled `claude.conf` / `codex.conf` ship `session_id_pattern` UNSET — resume is unsupported by default; operators opt in per-CLI with a label-anchored ERE. The session UUID is treated as a non-shareable resume capability (never logged, never synthesized).

## v0.19.0 - 2026-06-19

### Added

- Added the Claude Code `tmux-delegate` subagent for deciding inline vs supervised tmux-worker execution.
- Added `agent-tmux <cli> doctor --json` with independent named checks for tmux, agent CLI binary, git, and git worktree support.
- Added `agent-tmux <cli> setup` as a combined JSON preflight for `doctor --json` plus `self-test`.
- Added delegation-path eval coverage for trigger decisions and exact-call planning.
- Added `scripts/test-supervision-stress-smoke`: adversarial supervision coverage (missing/stale marker, no/malformed result.json, unresponsive stall) across three presets — codex, claude, and agy.

### Changed

- Tightened SKILL.md + references supervision guidance so an agent never idle-waits or hangs: structured `status`/`result`/`watch` first with pane capture as diagnostic fallback only, mandatory timeouts on every blocking wait (no bare `wait`, shell `sleep`, or status-polling loops), `watch --any|--all` for multi-worker, `status --json` + `ping` for liveness, and an explicit bounded fallback when a worker stalls.

### Fixed

- `result wait-required` now reports every requested field in `missing_fields` when `result.json` is absent or malformed (previously returned an empty list), so a non-compliant worker can no longer be misclassified as complete.

## v0.18.1 - 2026-06-11

### Changed

- Removed internal planning/design docs and task_plan.md from the public repo; no functional changes.

## v0.18.0 - 2026-06-10

### Changed

- SKILL.md: new "Fast paths" decision block at the top (bundle-path
  resolution when wrappers are off PATH; resolve → status → result
  supervision quick path; `watch --any|--all` instead of hand-rolled
  polling loops; profile + doctor proof for new/renamed CLIs), and the
  frontmatter description now includes natural-language triggers
  (result.json, watch --any, "which worker finished first",
  "wait for any of these agents"). Driven by a two-iteration
  with-skill/without-skill benchmark: the without-skill baseline
  repeatedly hand-rolled polling loops and omitted orchestration
  guardrails (cascade-spawn ban, literal result paths); iteration-2
  pass rate was 100% with skill vs 68.8% without.

## v0.17.0 - 2026-06-10

### Changed

- Profiles are now the canonical per-CLI configuration. The bundled
  `scripts/profiles/` directory ships default profiles for
  claude/codex/agy/cursor/grok that exactly mirror the legacy in-script
  preset table; `preset_for_cli()` is frozen as a fallback for when the
  profiles directory is missing. New CLIs are added as `.conf` files, not
  code. Equivalence verified: `doctor` output is identical between the
  legacy table and the bundled profiles for all five CLIs.

### Added

- Use-time profile selection flags, recognized between `<cli>` and
  `<command>`: `--profile-dir <dir>` (look up `<cli>.conf` in a
  user-managed directory; highest-priority search location) and
  `--profile <file>` (load an exact file, bypassing the search). They
  compose with the existing leading `--audit-log` flag in either order.

## v0.16.0 - 2026-06-10

### Added

- Declarative CLI profiles: `agent-tmux <cli>` now loads `<cli>.conf` from
  `$AGENT_TMUX_PROFILE_DIR` > `~/.config/agent-tmux/profiles` > the bundled
  `scripts/profiles/` directory. Plain `key=value` files (never sourced) can
  override `bin`, `env_ns`, `prefix`, `launch_flags`, `resume_keyword`,
  `heuristic_family`, `usage_kind`, and detection regexes (`pattern_busy`,
  `pattern_permission_prompt`, `pattern_approval_prompt`,
  `pattern_login_prompt`). Precedence stays env vars > profile > built-in
  preset. `doctor` reports the loaded profile path. Adding a new CLI or
  renaming a binary per machine no longer requires code changes.
- `agent-tmux <cli> watch [--any|--all] [--timeout <s>] [--interval <s>]
  [--json] <name...>`: one blocking call that supervises N workers. A worker
  counts as done when it (re)writes `result.json` after the watch started
  (mtime + content checksum signature, so same-second rewrites are caught) or
  its tmux session exits. Exit 0 when the condition is met, 1 on timeout,
  2 on invalid input.
- `scripts/profiles/README.md` and `gemini.conf.example`; SKILL.md rewritten
  around the unified `agent-tmux` engine and the profile mechanism.

## v0.15.0 - 2026-06-04

### Added

- Plugin-form distribution. The repository now ships CLI plugin manifests, all
  pointing at the same `./skills/` directory (no duplicated content):
  - `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` — installable
    via `/plugin marketplace add ohyeh/tmux-agent-tools` then
    `/plugin install tmux-agent-tools@tmux-agent-tools` in Claude Code.
  - `.codex-plugin/plugin.json` — skills-only manifest for Codex CLI.
  - `.cursor-plugin/plugin.json` — skills-only manifest for Cursor.
  No MCP server or hooks are declared: this project is a skill + shell wrappers,
  so the manifests intentionally expose only the shared skill.

## v0.14.0 - 2026-06-04

### Added

- `agent-tmux <cli> <command>` unified entrypoint: a single engine where the CLI
  identity (`claude`, `codex`, `agy`, `cursor`, `grok`, or any custom binary) is a
  hardcoded preset (binary, env namespace, launch flags, resume syntax, session
  prefix, status `tool` field, pane-scraping heuristic family, provider-env keys).
  `claude-tmux`, `codex-tmux`, and `agy-tmux` are now 1-line shims that delegate to
  it; all existing commands, flags, and env vars behave identically.
- `agent-tmux pair <cli> <team> <dir> [--workers N] [--worker-cli <cli>] [--role lead]`:
  idempotent multi-agent worker bootstrap (resume-if-alive / start-if-gone),
  conservative scale-down (surplus workers are warned `orphan`, never auto-stopped,
  and retained in team state), per-team `mkdir` lock with stale reclaim, and atomic
  team-state writes.
- `agent-tmux team list|workers|lead|stop|rm|broadcast|send|wait|results`: team
  lifecycle plus collaboration primitives over a `teams/<team>.json` state file.
  Mixed-CLI teams are first-class — every per-member operation re-invokes the engine
  with that member's own CLI. `team wait` exits `0` idle / `7` blocked / `8` timeout;
  `team results` branches on `.present`/`.valid` and reports missing results.
- `--role <value>` flag on `start`/`resume` (free-form sugar for `--tag role=<value>`).
- `AGENT_TMUX_*` universal env-override namespace; CLI-specific `<CLI>_TMUX_*`
  variables still take precedence.

### Changed

- Per-CLI `TMUX_CONF` default path is now `${TMPDIR:-/tmp}/agent-tmux-<cli>.tmux.conf`
  (scoped per CLI; `*_TMUX_CONF` overrides are still honored).

## v0.13.0 - 2026-06-01

### Breaking

- BREAKING: `claude-tmux wait-text` and `codex-tmux wait-text` are now
  literal-by-default; pass `--regex` to opt into zsh extended-regex matching.

### Added

- Added `claude-tmux send-wait` and `codex-tmux send-wait`, which append a
  fresh `MARK-<hex>` nonce instruction to each send and wait for that nonce on
  its own line (#223).
- Result contract: optional `verdict` (`ACCEPT|BLOCK|ACCEPT_WITH_CHANGES`,
  `blockers`, `marker`) and `decision` (`decision_by`, `delegate_name`,
  `authority`, `scope`, `decision`, `evidence`, `limits`) blocks in
  `result.json`, plus `result init`, `result validate`, `result wait-required`,
  and `result --path` on both wrappers (#218, #224, #220). The default schema
  path now resolves in both repo and Homebrew layouts; `schemas/` ships in the
  formula.
- `tmux-agent-sessions resolve --name <partial|full> --json` to map any name to
  its owning wrapper and safe next commands, plus `diff --since`,
  `list/cleanup --created-after`, `--cwd`, and `--force` (cleanup refuses dirty
  managed worktrees without `--force`) for accidental-session recovery (#216,
  #222).
- New `tmux-agent-monitor`: polls a manifest of read-only commands on a cadence,
  emits JSONL observations, stops on changed output/exit-code or `--until`, and
  never sends prompts (#219).
- `wait-and-capture --wait-for-human` heartbeat mode: holds without treating
  idle/timeout as completion, returns only on the marker or cancel, and
  maintains `awaiting-next-round.json` (#225).

### Documentation

- SKILL.md: capability table for all 14 scripts, "listen before send"
  supervision recipe, and a peer-review loop recipe; `cheatsheets.md` gains a
  marker-pitfalls section (stale-pane vs prompt-echo). Documented that agent
  CLIs run tool commands in a sandboxed env where `$TMUX_AGENT_RESULT` is empty,
  so orchestrators must pass the literal path from `result --path` (#226, #217,
  #228, #221).

## v0.12.2 - 2026-05-25

`v0.12.2` is a tmux color-environment patch release for managed Claude and
Codex panes.

### Fixed

- `claude-tmux` and `codex-tmux` now normalize color-related environment
  variables immediately before launching the CLI process. When color
  normalization is enabled, managed panes unset leaked caller `NO_COLOR` instead
  of passing `NO_COLOR=`, then set `COLORTERM=truecolor`, `FORCE_COLOR=3`, and
  `CLICOLOR_FORCE=1`. Explicit `TMUX_AGENT_TOOLS_SESSION_ENV` entries still win,
  including deliberate `NO_COLOR` overrides.

- Local `start`, local `resume`, and `start-ssh` now share the same color policy
  instead of hardcoding SSH-only behavior. Setting `CLAUDE_TMUX_COLOR_ENV=0` or
  `CODEX_TMUX_COLOR_ENV=0` disables the wrapper color normalization for both
  local and SSH launches.

- Removed a stale `--workdir-fresh` branch from the SSH launch path that could
  trip `set -u` before creating remote sessions.

### Validation

- Added `scripts/test-color-env-smoke` and wired it into CI. The smoke covers
  default `NO_COLOR` removal, truecolor/force-color defaults, explicit
  environment overrides, and disabled color normalization for SSH command
  generation across both wrappers.

## v0.12.1 - 2026-05-25

`v0.12.1` is a provider-environment isolation patch release for managed tmux
workers.

### Fixed

- `claude-tmux` now clears known Claude provider environment variables by
  default when starting or resuming a managed tmux session, including
  `ANTHROPIC_*` model/base/token settings and `API_TIMEOUT_MS`. This prevents
  stale shell or tmux server environment values from forcing Claude Code onto
  the wrong provider or transport path. Explicit inheritance remains available
  with `CLAUDE_TMUX_INHERIT_CLAUDE_ENV=1`, and explicit
  `TMUX_AGENT_TOOLS_SESSION_ENV` entries still win.

- `codex-tmux` now applies the same default isolation for Codex/OpenAI provider
  variables, including `OPENAI_*`, `CODEX_*`, and `API_TIMEOUT_MS`, with
  opt-in inheritance through `CODEX_TMUX_INHERIT_CODEX_ENV=1`.

### Added

- `claude-tmux env-doctor [name]` and `codex-tmux env-doctor [name]` compare
  caller environment, tmux global environment, and the running CLI child process
  environment with token/key redaction. This makes tmux-side provider pollution
  visible before operators chase shell startup files, app switchers, or CLI
  login state.

### Validation

- Added `scripts/test-claude-env-inherit-smoke` coverage for default provider
  env clearing, explicit opt-in inheritance, explicit `TMUX_AGENT_TOOLS_SESSION_ENV`
  precedence, and bare-key session env preservation.

## v0.12.0 - 2026-05-23

`v0.12.0` is the skill-disclosure and wrapper followup release. It keeps the
existing wrapper contracts backward-compatible while making the skill easier for
agents to load progressively and closing the two post-v0.11 operator gaps:
first-class multi-line send injection (#202) and CLI-aware progress probes
(#203).

### Added

- `claude-tmux send --from-file <abs-path>` and `codex-tmux send --from-file
  <abs-path>` for first-class multi-line / paste injection (#202). The new path
  uses the existing per-agent send-lock, supports `--enter-count N` and
  `--enter-delay S`, records transcript metadata (`multiline`, `bytes`,
  `text_sha256`), and writes a body-free `send.multiline` audit event with size
  and hash metadata. `scripts/test-send-multiline-smoke`: 22 sub-assertions
  across both wrappers, including embedded newlines, payloads larger than 16 KB,
  `--enter-count 3`, and concurrent multi-line + single-line sends under one
  agent name.

- `claude-tmux probe --metric <metric> [--json] <name>` and `codex-tmux probe
  --metric <metric> [--json] <name>` for CLI-aware progress parsing (#203).
  Claude metrics: `context_percent`, `goal_active`, `active_spinner`. Codex
  metrics: `progress`, `tool_active`, `approval_pending`. JSON output carries
  `schema_version: 1`, `name`, `metric`, `value`, `confidence`, and
  `parsed_from`, so downstream watchdogs can depend on one wrapper-local parser
  instead of each consumer shipping its own pane regex. `scripts/test-probe-smoke`:
  10 sub-assertions covering valid metrics, unknown metric exit 2, missing
  session exit 1, and JSON schema fields.

- `skills/tmux-agent-tools/SKILL.md` now uses progressive disclosure: the top
  file is the compact entrypoint, while detailed operator guidance lives under
  `skills/tmux-agent-tools/references/`. New eval manifests under
  `skills/tmux-agent-tools/evals/` cover trigger behavior, multi-agent
  coordination, and safety-boundary expectations for skill consumers.

### Notes

- The new `probe` command complements `ping`: `ping` answers whether a pane is
  responsive; `probe` extracts CLI-specific progress signals from the pane tail
  with an explicit confidence field.
- The new `send --from-file` path does not change existing `send <name> <text>`
  behavior. Existing single-line and inline multi-line callers continue to work.

## v0.11.0 - 2026-05-21

`v0.11.0` upgrades the L5/L6 surfaces from argv-smoke proofs to real runtime contracts. Closes 6 issues (#184–#189) re-opened against the v0.10.0 audit, plus a re-verified fix on #189 (PR #198) that hoists secret-backend preflight to parse-time. Adds two new operator binaries (`tmux-agent-audit`, `tmux-agent-worktrees`). All v0.10.0 callers continue working — every change preserves back-compat.

Total new smoke coverage: ~140 sub-assertions added across this release (fanout 33, approval-gate 20, DAG 32, worktree 18, audit-query 11, audit-rotation 12, audit-tamper 16, secret-uri 26 with 2 timing-bounded). All carry `schema_version: 1` on every JSON surface.

### Added

- L5 fanout runtime controls (#184 / PR #191). `tmux-agent-fanout run` is the canonical entrypoint; bare invocation prints help and forwards to `run` only for the legacy `--workdir`+`--prompt-file` shape (back-compat preserved). New flags: `--agent tool:name` (repeatable, mixes `claude:` and `codex:` in one call), `--result-dir <path>` (default `${XDG_STATE_HOME}/tmux-agent-tools/fanout/<run-id>/`, printed to stderr at start so callers can discover it), `--merge-mode {all|first-success}` (default `all`), `--summary-out PATH`. Consolidated JSON to stdout with per-agent status, result path, error, and final `ok`. Schema: `schemas/fanout-summary.schema.json`. Failure isolation: each child's `result.json` is preserved on disk even when siblings fail or time out — `--merge-mode first-success` does **not** kill remaining children. Wrapper exec failures now synthesize a `status:"error"` `result.json` immediately so the parent fails fast instead of hanging on the wait loop (previously, missing wrapper binaries caused a ~10-minute timeout). `scripts/test-fanout-run-smoke`: 33 sub-assertions covering 4 acceptance cases + legacy back-compat + schema-shape + exec-fail timing bound. Design doc: `docs/design-issue-184-fanout.md`. Daemon / async / supervisor-tree / cross-agent cancellation remain explicit deferrals.

- L5 approval gate runtime (#185 / PR #195). `wait-and-capture --pause-until-file <path>` is now a documented runtime contract, not just an argv smoke. While `<path>` is missing or empty, the wrapper blocks (1s poll). Decision file content: leading `approve` (case-insensitive) → resume + exit 0; leading `reject` → exit 7; other non-empty content → reject with diagnostic. `--pause-timeout <seconds>` triggers exit 8 on deterministic fail. While blocked, `$TMUX_AGENT_DIR/<name>/approval-status.json` reports `state: "awaiting_approval"` with the marker path; on resume it is replaced with the final state. Transcript records an `approval` event (`kind`, `decision`, `marker_path`, `decided_at`). Audit log (when enabled) emits `approval.approve`/`approval.reject`/`approval.timeout`. Existing callers without `--pause-until-file` are unaffected. Exit codes 7 and 8 are documented in `docs/ci-mode-exit-codes.md`. `scripts/test-approval-gate-smoke`: 20 sub-assertions covering all three decision paths plus `awaiting_approval` status visibility on both wrappers. Design doc: `docs/design-issue-185-approval-gate.md`. Webhook / exec handlers remain deferred.

- L5 DAG validation + topological execution (#186 / PR #190). `tmux-agent-dag <manifest.json>` now performs full graph validation before launching any task. Fails fast (exit non-zero) on missing dependency, duplicate task name, self-dependency, cycle (Kahn-based detection), and duplicate dependency within one task. Executes in computed topological order regardless of manifest order. Manifest schema (`schema_version: 1`) supports `fail_fast: true` (default; downstream tasks `skipped` on failure) and `fail_fast: false` (independent branches continue; only the dependent subtree skipped). Task names with spaces and special characters are supported via US (0x1f) / RS (0x1e) delimited dep storage — the v0.10.0 space-joined storage broke task names with whitespace and double-counted duplicate deps in in-degree computation. Final JSON summary on stdout + `--summary-out PATH`: `ordered_tasks`, `results[{name,status,result_path,error}]`, overall `ok`. `scripts/test-dag-validation-smoke`: 32 sub-assertions covering all 7 acceptance cases plus task-name-with-space, duplicate-dep rejection, and special-char names. Design doc: `docs/design-issue-186-dag-manifest.md`. YAML manifest, parallel execution, full `when:` expression engine remain explicit deferrals.

- L6 managed worktree lifecycle (#187 / PR #194). `--workdir-fresh` now uses managed naming `tmux-agent/<sanitized-agent>-<uuid8>` with worktree dirs under `${XDG_STATE_HOME:-$HOME/.local/state}/tmux-agent-tools/worktrees/`. Per-worktree metadata at `.tmux-agent-worktree/meta.json` (schema_version 1) records `source_repo`, `base_ref`, `agent_name`, `tool`, `created_at`, `path`, `branch`, `cleanup_policy` (`no-change-cleanup` default / `has-change-keep` / `always-keep`; override via `TMUX_AGENT_WORKTREE_POLICY`). The wrapper also writes a sibling `worktree.json` under `$TMUX_AGENT_DIR/<name>/` as a machine-readable surface and prints `fresh worktree: <path>` to stderr. New `tmux-agent-worktrees` binary with `list [--json]` and `prune [--dry-run] [--force]` subcommands; `prune` applies the cleanup policies and removes worktrees whose tmux session is dead. `doctor` gains `git` + `git worktree` capability checks. Legacy `fresh-worktree` marker remains for back-compat. `scripts/test-worktree-lifecycle-smoke`: 18 sub-assertions including a `$PATH`-survives regression check. Auto merge-back remains explicit deferral.

- L6 audit operator surface (#188 / PR #193). New `tmux-agent-audit` binary exposes `verify [--log PATH]`, `query [--since ISO] [--until ISO] [--tenant T] [--agent A] [--tool T] [--event E] [--log PATH]`, `rotate [--log PATH] [--force]`, and `path` subcommands. Wrappers gain `--audit-log [PATH]` flag and recognise `AUDIT_LOG=1` env (default path `${XDG_STATE_HOME:-$HOME/.local/state}/tmux-agent-tools/audit.jsonl`); existing `TMUX_AGENT_TOOLS_AUDIT_LOG=<path>` still works. Size-triggered rotation (`TMUX_AGENT_TOOLS_AUDIT_MAX_BYTES` default 10485760, `TMUX_AGENT_TOOLS_AUDIT_RETAIN` default 5). An advisory lock (flock when available, mkdir-fallback otherwise) guards rotate+append against concurrent appenders; an `audit.rotation` HEAD-link record preserves the hash chain across rename so `verify` is rotation-aware and tampering is still detected across rotated segments. Event schema (`schema_version: 1`) covers `wrapper.start`, `wrapper.stop`, `wrapper.send`, `hook.allow`, `hook.reject`, `hook.run`, `secret.read` (records `secret_name` + `backend` only — never the value), `approval.approve`, `approval.reject`, `approval.timeout`, `fuse.max_trigger`. Legacy event names are auto-namespaced to `wrapper.<verb>` for back-compat. Smokes: `test-audit-smoke` 16, `test-audit-query-smoke` 11, `test-audit-rotation-smoke` 12 (including a 2-appender + 1-rotator concurrency stress run). Design doc: `docs/design-issue-188-audit-surface.md`. Cross-host non-repudiation remains explicit deferral.

- L6 `--secret KEY=URI` URI backends + redaction (#189 / PR #192 + PR #198). `--secret` now accepts `file:<path>` (and bare `<path>` for back-compat with the v0.10.0 file-only form), `env-file:<path>` (dotenv loader), `op://<vault>/<item>/<field>` (1Password CLI via `op read`), and `keychain:<account>/<service>` (macOS `security find-generic-password`). **Missing backend CLI exits 4 in under 100ms** before any tmux session is created — preflight is hoisted to immediately after the `--secret` parse loop, so the failure path can never accidentally drift to "after session creation" (PR #198 made this explicit; the regression-proof smoke wraps the case in a 3s alarm assertion). Registered secret values are redacted from `capture` output and transcript events as `[REDACTED:KEYNAME]`. The matcher stores secrets as `KEY<TAB>BASE64(VALUE)<NEWLINE>` so newlines, NULs, and regex metacharacters in the secret cannot corrupt the redactor; substitution runs through `awk RS="\0"` so multi-line values (PEM keys, multi-line tokens) are scrubbed in full. `--secret-redact=false` bypasses redaction for debugging and prints a loud stderr warning. When audit is enabled, `secret.read {secret_name, backend}` is recorded — never the value. `scripts/test-secret-uri-smoke`: 26 sub-assertions including multi-line secret, trailing-newline, regex-meta values, and a `≤3s` timing assertion on the missing-CLI path. README + `skills/tmux-agent-tools/SKILL.md` document the safe `op://` usage example.

### Notes

- Two new binaries are installed by the existing `install-bin` mechanism: `tmux-agent-audit` and `tmux-agent-worktrees`. Both follow the same prefix/install conventions as the wrappers.
- Every new JSON surface carries `schema_version: 1` (fanout summary, fanout per-agent `result.json`, DAG summary, worktree `meta.json` / wrapper `worktree.json`, audit events, approval-gate status).
- Lint coverage gap tracked at #196: `scripts/lint-no-path-tied-locals` does not yet catch the multi-name `local path agent foo` form. Not a runtime issue post-PR #194's rename pass (zero tied-pair locals remain on `main` per a targeted grep) but planned for a separate follow-up.
- This release sits entirely within the v0.10.0 "no hidden autonomy" non-goal: every new surface is operator-explicit, synchronous, and creates no resident daemons or background supervisors.

## v0.10.0 - 2026-05-21

`v0.10.0` closes the entire issue backlog. All 33 GitHub issues from the original list are now closed. This release lands the L5/L6 batch (#112–#119) under the "no hidden autonomy" non-goal: every L5/L6 surface is synchronous, operator-explicit, with no resident daemons or shared cross-session state.

Total smoke coverage: ~440 sub-assertions across 21 smoke runners.



### Added




- L5 batch (#112 #113 #114): `tmux-agent-fanout` spawns N agents synchronously and waits for all to write `result.json` before emitting a consolidated payload (no daemon, no async). `tmux-agent-dag run <manifest.json>` walks a JSON-declared task DAG in topological order, BLOCKING after each task. `wait-and-capture --pause-until-file <path>` blocks after the marker match until the operator writes the gate file. All three respect "no hidden autonomy" — synchronous, operator-explicit, no resident processes. `scripts/test-l5-batch-smoke`: 6 sub-assertions.
- L6 batch (#115 #116 #117): `--on-exit-allow <regex>` rejects hook strings that do not match (#115; exit 3 on policy violation). `--secret KEY=PATH` reads file content into the session env so callers do not embed secrets in command lines (#116; missing file exits 4). `--workdir-fresh` creates a `git worktree add` of the target directory so the agent operates on its own copy (#117; non-git source exits 1). All three respect the "no hidden autonomy" non-goal: no daemons, operator-explicit invocation, synchronous side effects only. `scripts/test-l6-batch-smoke`: 14 sub-assertions.
- `TMUX_AGENT_TOOLS_AUDIT_LOG=<abs.jsonl>` opt-in audit log (issue #119). Each subcommand appends a JSONL event chained via SHA-256 to the previous (`prev_chain_hash` + `chain_hash` + `schema_version: 1`). Chain key derived from `/etc/machine-id` (Linux) / `IOPlatformUUID` (macOS) / `$HOME` (fallback) — no operator-managed key. `audit-verify <log>` walks the chain and reports tamper. No daemon, fully synchronous on each call path — respects "no hidden autonomy". `scripts/test-audit-smoke`: 16 sub-assertions covering append, chain shape, verify-ok, tamper-detection, env-unset no-op.
- `TMUX_AGENT_TOOLS_TENANT=<name>` env var appends a tenant suffix to the session prefix (issue #118). Operators on the same host get isolated session names + state dirs by exporting different tenant names — no shared state, no daemon, fully operator-explicit. New `tenant` subcommand on both wrappers prints the effective prefix. Respects the "no hidden autonomy" roadmap non-goal: tenant scoping is env-var only with no policy machinery. `scripts/test-tenant-smoke`: 6 sub-assertions.
## v0.9.0 - 2026-05-21

`v0.9.0` clears the entire L4/L7/L8 backlog with v1 slices. Closes 7 issues (#103, #111, #120, #122, #123, #127, #129) and lands two design docs (#167 L5/L6 policy-block, #170 v1-slice contracts). Only L5/L6 (#112–#119, policy-blocked per "no hidden autonomy") remain open.



### Added







- `tmux-agent-history` SQLite + FTS5 index tool (issue #129 v1 slice). Subcommands: `index <transcript>...`, `search <query>`, `show <name>`. Stores per-session metadata at `~/.tmux-agent/history.db`; full transcript body indexed via FTS5 unicode61 tokenizer. Time filters (`--since 7d`), cross-session rollups (`top --by cost`), and `diff` are deferred per design batch. `scripts/test-history-smoke`: 9 sub-assertions.
- `tmux-agent-dashboard [--watch] [--interval s] [--count n]` JSON snapshot tool (issue #123 v1 slice). Single JSON object per snapshot with totals + per-session payloads. `--watch` polls bounded by `--count`. Interactive ncurses TUI deferred per design batch. `scripts/test-dashboard-smoke`: 5 sub-assertions.
- `tmux-agent-cron` catalog tool (issue #122 v1 slice). Subcommands: `add`, `list`, `remove`, `show`, `history`. Schedules persist to `~/.tmux-agent/cron/schedules.jsonl`. Platform integration (launchd / systemd-timer / crontab) is deferred to v2 per design batch — operator reads the catalog from their own scheduler. `scripts/test-cron-smoke`: 12 sub-assertions.
- `checkpoint <name> <abs.tar.gz>` and `restore <input.tar.gz>` subcommands on both wrappers (issue #111 v1 slice). `checkpoint` snapshots the per-agent state dir + a 2000-line pane scrollback into a gzip-compressed tarball. `restore` is read-only: extracts to a scratch dir and prints contents. Spawning a fresh session from the checkpoint is deferred to v2 per design batch. `scripts/test-checkpoint-smoke`: 12 sub-assertions.
- `--ci` flag on `start` / `resume` (issue #120 v1 slice). Persists a per-agent marker at `$TMUX_AGENT_DIR/<name>/ci-mode` so future subcommands can branch on it. `docs/ci-mode-exit-codes.md` documents the stable exit code contract: 0/ok, 1/generic, 2/usage-error, 3/permission-wall, 4/secret-missing (placeholder), 5/schema-fail (placeholder), 124/timeout. Deferred to v2: JSON-by-default flip, `doctor --ci`, GH Actions example. `scripts/test-ci-mode-smoke`: 6 sub-assertions.
- `usage.jsonl` skeleton + `status --usage` aggregator (issue #103 v1 slice). `start`/`resume` now write a `{event: "usage_init", at, schema_version: 1}` line under `$TMUX_AGENT_DIR/<name>/usage.jsonl` (or `--usage <abs>` for a custom location). `status --usage <name>` reads the file, folds `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `turns` and emits a structured payload (`schema_version: 1`). v1 has no real CLI-tee mechanism (tracked in design doc) — every aggregate field is 0/null with an explanatory note. `scripts/test-usage-smoke`: 16 sub-assertions covering default path, custom `--usage` path, aggregator output, and relative-path rejection.
- `--record <abs.jsonl>` is now a documented alias for `--transcript` on `start`/`resume` (issue #127 v1 slice). `tmux-agent-replay fixture-validate <jsonl>` sanity-checks a transcript: all lines parse, all entries carry `schema_version:1`, all timestamps match ISO-8601 UTC, and at least one `start` event is present. Exit 0 on valid, exit 2 on validation failure. Output is structured JSON `{schema_version:1, ok, fixture, generated_at, checks[{name,status,detail}]}`. Replay TMUX_AGENT_FIXTURE replay-from-fixture mode remains deferred (depends on a fake-CLI driver — see `docs/design-remaining-backlog.md`). `scripts/test-fixture-validate-smoke`: 10 sub-assertions.
## v0.8.0 - 2026-05-21

`v0.8.0` ships safety + DX surfaces: max-runtime/idle fuses (#105), health-check ping (#128), result-schema validation (#125), session tagging (#124), webhook notify (#121). Also documents the L5/L6 policy-block roadmap amendment proposals (#112–#119 design batch).



### Added





- `tmux-agent-notify --webhook <url> [--format <generic-json|slack>] [--tag k=v]...` standalone tool (issue #121). Reads `$ON_EXIT_NAME` + `$ON_EXIT_CODE` from the calling shell (set by the #95 on-exit hook), POSTs a JSON envelope (`schema_version: 1`) with retry (3 attempts, exponential backoff). Slack format wraps as `{text, attachments[]}`. v1 ships generic-json + slack; discord/mattermost/teams are followups. Always exits 0 — notification is a side channel and must not break the agent contract. `--dry-run` prints the body without POSTing. `scripts/test-notify-smoke`: 16 sub-assertions.
- `--tag key=value` flag (repeatable) on `start` / `resume` (issue #124). Tags persist to `$TMUX_AGENT_DIR/<name>/tags.json` and are queryable via the new `tags <name>` subcommand on both wrappers. `tmux-agent-sessions list --tag key=value` filters the inventory; multiple `--tag` filters AND-combine. Key must match `[A-Za-z0-9_.-]+`; value is free-form. `scripts/test-tagging-smoke`: 10 sub-assertions covering persist+read, invalid-format rejection, and cross-session AND filtering.
- `--result-schema <abs.json>` flag on `start` / `resume` and `result --validate <name>` subcommand (issue #125). Lightweight v1 validator written in shell + jq: top-level `type`, `required` keys, and `additionalProperties: false`. Full JSON Schema draft-07 (refs, oneOf, nested properties) deferred to an ajv-cli followup. Validator output: `{schema_version: 1, present, valid, errors[{path, message}], body}`. Exit 0 on valid, exit 2 on invalid (distinct from exit 1 = file-missing). Ships example schema `schemas/result-status-summary.schema.json` matching the result-file contract from #107. `scripts/test-result-schema-smoke`: 32 sub-assertions covering valid, missing-required, extra-key, non-JSON, missing-file, relative-path rejection, non-existent-schema rejection. Design doc: `docs/design-issue-125-result-schema-validation.md`.
- `claude-tmux ping <name> [--timeout 10] [--json]` and the equivalent on `codex-tmux` actively probe the pane (issue #128). Sends a benign newline + Ctrl-U (which clears the input line — safe against turn-stealing) and waits for pane bytes to change. Exits 0 / 1 / 2 for ok / timeout / dead with rtt_ms reported. JSON output carries `schema_version: 1`. `scripts/test-ping-smoke`: 28 sub-assertions across both wrappers (live → ok, quiet → timeout, missing → dead, --timeout honored, rtt is non-negative int).
- `--max-runtime <seconds>` and `--max-idle <seconds>` safety fuses on `claude-tmux` / `codex-tmux` `start` (issue #105). A detached watcher process polls the pane and force-stops the agent when the threshold trips; sentinel writes `124` and a sidecar `<sentinel>.reason` records `max_runtime` or `max_idle`. `--on-exit` hooks receive `ON_EXIT_REASON` so callers can branch on cause. `stop` kills the watcher PID recorded at `$TMUX_AGENT_DIR/<name>/fuse.pid` to prevent zombies. `scripts/test-max-fuse-smoke`: 20 sub-assertions covering runtime trip, idle trip, idle reset on activity, watcher cleanup, both-flags-runtime-wins, and bad-value rejection. `--max-cost` deferred until #103 token telemetry lands.
## v0.7.0 - 2026-05-21

`v0.7.0` ships the runtime-safety + replay slice: advisory lock around concurrent send (#102), cross-session inventory watch events (#104), and the read-only `tmux-agent-replay` tool (#126 — `diff` + `redact`, with `run` deferred per acceptance).

### Added

- `tmux-agent-replay` tool with two read-only subcommands (issue #126): `diff` and `redact`. `diff <a.jsonl> <b.jsonl> [--json]` reports send delta, wait outcomes, marker sequences. `redact <in.jsonl> --output <out>` strips secrets via default regex set (AWS keys, GitHub tokens, api_key=, password=, Bearer) plus caller `--pattern`. `run` deferred per acceptance. `scripts/test-replay-smoke`: 21 sub-assertions.

- Advisory lock around `send` / `send-wait-literal` to prevent concurrent input races (issue #102). Each agent gets a `$TMUX_AGENT_DIR/<name>/send.lock` mkdir-style lock with stale-PID recovery (dead PID files are reclaimed automatically). Helper `send_lock_around` is shared across both wrappers and supports `--retry N` (default 50) `--retry-delay s` (default 0.1). Smoke `scripts/test-send-lock-smoke` covers: concurrent acquirers serialize, stale PID recovery, missing-agent-dir tolerance, and inner-command return-code propagation across both wrappers (10 sub-assertions).
- `tmux-agent-sessions watch` event subscribe mode (issue #104). Bounded foreground polling loop that diffs successive `inventory_json_array` snapshots and emits one JSONL line per state transition: `session_added`, `session_state_changed` (with `from` / `to`), and `session_removed`. Every event carries `schema_version: 1`, `tool`, `name`, `session`, and ISO-8601 UTC `at`. Flags reuse the existing list filters (`--tool`, `--name`, `--state`) plus `--count <n>` (default 0 = unlimited, Ctrl-C to stop) and `--interval <s>` (default 2). First tick is silent (no prior snapshot); silent ticks emit nothing. Reuses `list --json` state discovery — no new inventory code path. `scripts/test-sessions-watch-smoke`: 10 sub-assertions covering first-tick silence, `session_added` on new session, silent stable ticks, transition events on stop, `--count 0` parsing, and bad-arg rejection. Implementation note: `local foo` on a re-entered scope prints the existing value in zsh, so all scalar locals are declared once outside the polling loop.

## v0.6.0 - 2026-05-21

`v0.6.0` is the contracts + lifecycle + observability release. Closes 17 issues (#95–#101a, #106, #107, #110, #132, #135, #139, #140, #141, #143, #144). Every JSON surface now carries `schema_version: 1`. Total smoke coverage: 308 sub-assertions across 11 runners.

### Added

- Transcript now records `wait_*` events (issue #141 — followup from #100). Each of `wait`, `wait-text`, `wait-literal`, `send-wait-literal`, and `wait-and-capture` emits one JSONL event when it completes with `{schema_version: 1, event, name, outcome, needle, timeout_seconds, at}`. `outcome` is `matched`, `timeout`, `stable` (for `wait`), or `session_gone` (wait-and-capture only). Only fires when `--transcript` is configured. `scripts/test-transcript-smoke`: 38 → 46 sub-assertions covering matched + timeout outcomes for wait-literal / wait-text plus schema_version validation across the new event types.
- `--strip-ansi` now strips OSC, DCS, APC, PM, and SOS escape sequences in addition to CSI/SGR (issue #135 — followup from #96). Single sed pipeline; out-of-scope: 8-bit C1 controls. `scripts/test-capture-smoke` 26 → 48 sub-assertions adding one synthetic example per category and asserting both introducer removal and visible-body survival. README + design doc remove the "known gap" caveat.
- `--transcript-text-truncate <N>` opt-in flag on `start` / `resume` (issue #140). When set and a `send` event's text payload exceeds N bytes, the transcript records `text: "[truncated, original X bytes]"` plus `text_sha256` (hex) and `text_bytes` (integer) instead of the verbatim payload. Default behavior unchanged: text embedded verbatim with `text_sha256: null`. Threshold persists per agent under `$TMUX_AGENT_DIR/<name>/transcript-truncate`. `scripts/test-transcript-smoke` adds 14 sub-assertions (passthrough on short text, hash + bytes on long text, non-integer + zero rejection).
- `status --json` now carries `schema_version: 1` (issue #143). Retrofit only — no field shape change. Aligns `status --json` with the convention established by #96/#97/#99/#100/#142 so consumers can detect contract version on every JSON surface. `scripts/test-liveness-smoke` now asserts the new field per wrapper (34 → 36 sub-assertions).
- Graceful degrade on liveness-state write failures (issue #144). The four `#98` writers (`record_started_at`, `marker_seen_add` append, `marker_seen_add` FIFO cap, `update_pane_hash`) now run inside a subshell with `2>/dev/null || true`. Under read-only `$TMUX_AGENT_DIR/<name>/` (disk-full, permission-denied, NFS read-only mount), `status --json` continues to emit valid JSON with degraded values (null timestamps, stale hash) instead of crashing the caller. The subshell wrapper is necessary because zsh emits redirect-open errors from the SHELL itself (`update_pane_hash:24: permission denied`) which `2>/dev/null` on the printf line alone does NOT catch. `scripts/test-liveness-degrade-smoke` locks this with 4 sub-assertions across both wrappers (status --json exit code + valid JSON under chmod 555 agent dir).
- `claude-tmux start --dry-run` and `codex-tmux start --dry-run` perform pre-flight checks without creating a tmux session or launching the CLI (issue #110). Emits JSON `{schema_version: 1, tool, name, directory, ok, checks[]}` with per-check `{name, status: pass|fail|skip, detail}`. Checks: workdir_exists, tmux_binary, agent_cli_binary (picks correct env var by tool name — no cross-fallback), session_not_in_use (only with `--exact`), sentinel_path (absolute + writable parent + not pre-existing), on_exit_pairing (`--on-exit` requires `--sentinel`), transcript_path (absolute + writable parent + not pre-existing, no file creation). Exit 0 on all-pass, exit 2 on any failure. Side-effect free: `require_bins` and `write_tmux_conf` are gated after dispatch. Scope is `start` only. `scripts/test-dry-run-smoke`: 36 sub-assertions across both wrappers.
- `claude-tmux help <subcommand>` and `codex-tmux help <subcommand>` print a focused per-subcommand cheatsheet instead of the full multi-page usage (issue #106). Topics: start, resume, start-ssh, attach, send, send-wait-literal, wait, wait-text, wait-literal, wait-and-capture, capture, result, status, list, stop, doctor, self-test, help. Unknown topic exits 2 with the topic list. `scripts/test-help-smoke` covers all topics + fallback + unknown-topic dispatch across both wrappers (42 sub-assertions). `skills/tmux-agent-tools/SKILL.md` gains a scenario → command table linking each scenario to the issue that introduced it.
- `--sentinel <abs-path>` and `--on-exit <shell-cmd>` flags on `claude-tmux` and `codex-tmux` `start` / `resume` for event-driven completion signaling (issue #95). After the wrapped CLI exits, the wrapper atomically writes the decimal exit code to the sentinel file and optionally runs the hook with the exit code and agent name as arguments. Hook stdout/stderr is captured to `<sentinel>.hook.log`. Pre-existing sentinel aborts start; relative paths are rejected; `--on-exit` without `--sentinel` warns and is ignored.
- `--sentinel-keep` flag to retain the sentinel file across `stop` (default removes it).
- Docs: `docs/design-issue-95-event-driven-completion.md` and `docs/implementation-notes.md` capture the design and the decisions made during implementation.
- `--strip-ansi`, `--since-marker <text>`, and `--json` flags on `claude-tmux` / `codex-tmux` `capture` for token-efficient post-processing (issue #96). `--strip-ansi` removes CSI/SGR sequences (known gap: does not strip OSC/DCS/APC/PM/SOS — documented in the design doc). `--since-marker` keeps only lines after the LAST occurrence of the literal text, returning empty / `marker_found: false` when missing. `--json` wraps output as `{name, session, lines_requested, marker_found, stripped_ansi, lines}`.
- `scripts/test-capture-smoke` covers the new flags with 24 sub-assertions (raw / strip / since-marker / JSON / missing-marker / missing-value) against both wrappers.
- Result-file convention: `start` and `resume` export `TMUX_AGENT_NAME` and `TMUX_AGENT_RESULT` into the pane so the agent CLI can write a structured result to a conventional path (`$TMUX_AGENT_DIR/<name>/result.json`). Stale `result.json` is cleared at start. (issue #97)
- `result <name>` subcommand on both wrappers. Supports `--field <jq>` for single-value extraction, `--wait <seconds>` for polling until the file appears, and `--json` for metadata-wrapped output (`{schema_version, path, present, bytes, mtime, body}`). Missing file: exits 1 in text mode, `present: false` in JSON mode.
- `scripts/test-result-smoke` covers the new env injection and subcommand with 18 sub-assertions across both wrappers.
- `wait-and-capture` combined subcommand on both wrappers (issue #99). Replaces the two-step `wait-literal X` + `capture --strip-ansi --since-marker X` pattern with a single call. Flags: `--marker <text>` (required), `--literal` / `--regex` (default regex), `--timeout <s>`, `--tail <n>`, `--strip-ansi`, `--since-marker <text>` (defaults to `--marker`), `--json` (schema_version=1 with `reason: matched | timeout | session_gone`), `--no-timeout-error` (decouples soft-timeout from `--json` per partner R3 review).
- `scripts/test-wait-and-capture-smoke` covers literal/regex match, timeout exit-code semantics, JSON reason field, session_gone case, and missing-value rejection across both wrappers — 28 sub-assertions.
- Single-agent JSONL transcript: `--transcript <abs-path>` on `start` / `resume` records `start`, `send`, `capture`, `stop` events (one JSON object per line, `schema_version: 1`, ISO-8601 `at` timestamp). Transcript path is remembered per agent under `$TMUX_AGENT_DIR/<name>/transcript-path`. Pre-existing transcript aborts start to prevent mixed-run noise. (issue #100)
- `scripts/test-transcript-smoke` verifies env-injection + four events + stale rejection + missing-value rejection across both wrappers — 20 sub-assertions.
- `status --json` now reports five additive liveness fields: `started_at`, `last_change_at`, `idle_seconds`, `bytes_in_pane`, and `marker_seen` (string array). Markers from `wait-literal` / `send-wait-literal` are recorded; regex `wait-text` is intentionally not. Existing field shape unchanged. (issue #98)
- `scripts/test-liveness-smoke` covers ISO-8601 timestamps, byte counting, idle growth, marker recording, dedup, and null-on-missing-session — 28 sub-assertions across both wrappers.

### Notes

- Sentinel support is wired into local `start` and `resume` for both wrappers; `start-ssh` sentinel support is pending a separate design decision on remote-vs-local sentinel placement.
- The sentinel format is plain decimal exit code plus newline by design; structured telemetry stays a separate artifact (see roadmap L3 issues).

## v0.5.0 - 2026-05-17

`v0.5.0` is the observability and multi-session composability release.

### Added

- `tmux-agent-sessions list --watch --json --count N --interval S` for bounded inventory polling without creating a daemon.
- Wrapper `status --json` now includes nullable `exit_code` detail parsed from wrapper exit markers.
- `tmux-agent-dialogue validate-transcript --schema-version 1` for explicit transcript contract validation.
- `tmux-agent-dialogue --on-blocked-trigger <path>` for local blocked-session trigger artifacts.
- `tmux-agent-dialogue summarize --output-format json` for structured summary output while keeping Markdown as the default.
- Participant profile `timeout` values for per-agent bounded dialogue waits.
- `github-comment --edit-existing <comment-id>` for explicitly updating a known GitHub issue comment instead of appending.

### Changed

- Cleanup preview JSON coverage now asserts scriptable cleanup decisions for owned sessions, tool filters, name filters, unrelated sessions, and execute-mode rejection.
- Summary-file comment coverage now includes empty summary files and `--max-bytes` truncation behavior.
- GitHub comment helpers remain dry-run by default; posting or editing still requires explicit `--post-github-comment`.

### Notes

- Default CI remains credential-free and uses fake participants.
- Real Codex/Claude runs remain manual release evidence, not default pull-request checks.
- Homebrew Formula stable URL and SHA-256 should be bumped in a follow-up PR after the `Release` workflow creates the `v0.5.0` tag and summary.

## v0.4.0 - 2026-05-16

`v0.4.0` is the automation-readiness release.

### Added

- `tmux-agent-sessions list --json` now reuses wrapper status for Claude/Codex rows and reports a derived `state`.
- `status --json` now includes bounded diagnostic tail lines through `last_capture_lines`.
- `status --json` now includes diagnostic prompt fields: `confirmation_detected` and nullable `blocked_reason`.
- `tmux-agent-dialogue handoff` for bounded two-turn context transfer with local transcript and optional summary output.
- `github-comment --summary-file` for reusing a pre-rendered local Markdown summary body.
- `tmux-agent-dialogue pair-review --swap` for reversing proposal/review speaker order without changing participant definitions.
- Participant profile `env` support for generic per-session environment variables passed into local tmux sessions.

### Changed

- Session inventory and cleanup previews use wrapper-backed running/exited state instead of assuming every owned tmux session is running.
- Status diagnostics remain bounded, best-effort, and non-authoritative; prompt detection never auto-accepts or interacts with prompts.
- Handoff and summary-file flows stay local by default, with GitHub posting still requiring explicit `--post-github-comment`.
- Participant profile env is validated before session start, remains profile-scoped, and is documented with SSH caveats rather than treated as a secret transport.

### Notes

- Default CI remains credential-free and uses fake participants.
- Real Codex/Claude runs remain manual release evidence, not default pull-request checks.
- Homebrew Formula stable URL and SHA-256 should be bumped in a follow-up PR after the `Release` workflow creates the `v0.4.0` tag and summary.

## v0.3.0 - 2026-05-16

`v0.3.0` is the session hygiene and transcript usability release.

### Added

- `tmux-agent-sessions` for inspecting and cleaning up owned tmux-agent-tools sessions with preview-first cleanup.
- `tmux-agent-dialogue validate-transcript` for local JSONL transcript validation before summarizing or sharing.
- Failure classification for dialogue failure events, including conservative `failure_type` values such as `marker_timeout` and `session_missing`.
- Sharing controls for transcript summaries and GitHub comment bodies: `--max-lines`, `--max-bytes`, and repeated `--redact-pattern`.
- Stable `status --json` fields for both `claude-tmux` and `codex-tmux`.
- Participant profiles for reusable local or SSH-backed dialogue participants.
- `critic` preset for bounded critique/response loops.
- Manual `v0.3.0` release evidence for real Codex/Claude wrapper and bounded dialogue smoke checks.

### Changed

- Transcript summary and GitHub comment rendering use a generic `transcript` label unless a preset explicitly sets its own label.
- Wrapper and dialogue capture now join tmux soft-wrapped screen lines before matching or writing transcript text.
- Copy-mode keyboard and mouse-drag copy paths now use the same clipboard selection behavior.
- Clipboard behavior can be forced with `CLAUDE_TMUX_CLIPBOARD` or `CODEX_TMUX_CLIPBOARD` (`auto`, `internal`, or a custom copy command).

### Notes

- Default CI remains credential-free and uses fake participants.
- Real Codex/Claude runs remain manual release evidence, recorded without committing raw real-agent transcripts.
- Homebrew Formula stable URL and SHA-256 should be bumped in a follow-up PR after the `Release` workflow creates the `v0.3.0` tag and summary.

## v0.2.0 - 2026-05-16

`v0.2.0` is the first stable orchestration release.

### Added

- `tmux-agent-dialogue` for bounded two-party tmux dialogues with JSONL transcripts.
- `pair-review` preset for local proposal/review loops.
- `summarize` and `github-comment` helpers for transcript summaries; GitHub posting is dry-run by default and requires `--post-github-comment`.
- Participant-scoped remote dialogue options through existing `start-ssh` wrappers.
- `send-wait-literal` and `wait-text --literal` for stale-marker-safe orchestration.

### Changed

- Stable Homebrew install now includes `tmux-agent-dialogue`.
- CI covers fake dialogue, pair-review, summary rendering, GitHub comment dry-run behavior, and post command shape without real credentials.

### Notes

- Real `codex`/`claude` dialogue runs remain manual release evidence, not default CI.
- GitHub publishing remains explicit opt-in; local transcript and summary generation are the default paths.

## v0.1.0 - 2026-05-16

Initial public MVP.

### Added

- `claude-tmux` and `codex-tmux` wrappers for named local tmux sessions.
- `start-ssh`, `send`, `wait`, `wait-text`, `wait-literal`, `capture`, `status`, `doctor`, `self-test`, and `stop` commands.
- `skills.sh` compatible skill package.
- Homebrew formula for stable and `--HEAD` installs.
