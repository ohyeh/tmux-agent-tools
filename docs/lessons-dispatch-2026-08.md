# Dispatch lessons — 2026-08-18 EMFILE / assign-verification cluster

從 `ohyeh/agent-scripts` 的 `.agents/rules/lessons.md` 畢業移入（2026-08-21 W34 retro）。
這六條屬工具層，已由本 repo 的 smoke 套組與 `tmux-assign-host-gate` hook 覆蓋；
保留原文供追溯，不再佔用 kernel lessons 的 150 行額度。

## 2026-08-18 EMFILE kills worker Stop hooks under load
Status: proposed
Evidence: session 37839e4b — adversarial-kernel worker finished in 16m but its
Stop hooks died 3x with "Too many open files (os error 24)", leaving
result.json stuck at `pending`; supervise/result-wait then blocks until
timeout. At diagnosis time kern.num_files was 7724/122880 and the tmux server
ulimit -n was 1048576 — per-pane fd limits ruled out; the pressure was
transient (6 concurrent codex tmux workers + browsers). Root cause UNCONFIRMED.
Lesson: a finished worker with pending result.json + Stop-hook EMFILE in the
pane is a HARVEST-DIRECTLY signal, not a hang; on next EMFILE capture
`sysctl kern.num_files` and `lsof | wc -l` immediately before touching anything.

## 2026-08-18 EMFILE refined chain: Codex app-server MCP pipe-FD leak, 256 as trigger
Status: proposed
Supersedes-detail-of: "2026-08-18 EMFILE kills worker Stop hooks under load".
Chain (user-verified snapshot): long-lived Codex app-server → stdio MCP /
subagent churn → teardown leaves PIPE FDs (PID 15073, ~11h: 159 lsof rows,
90 PIPE, 30 children) → launchd soft RLIMIT_NOFILE 256 becomes the trigger →
EMFILE. Upstream: openai/codex #26984, #34410; local CLI 0.147.0 (rmcp 3.0.0,
non-blocking MCP startup) installed 08-08. Root cause of the original incident
stays UNCONFIRMED (no RLIMIT/EMFILE log captured at the time).
Rules: (1) raising limits is mitigation, not the fix — the leak is upstream;
(2) RLIMIT_NOFILE is per-process and fixed at spawn — after raising launchd
limits, RESTART existing app-server/workers and re-verify a child's actual
limit; (3) on next EMFILE capture, before touching anything:
`sysctl kern.num_files`, `launchctl limit maxfiles`,
`lsof -p <app-server-pid> | awk '$5=="PIPE"' | wc -l`.

## 2026-08-18 assign confirm-step false-pass on Codex 0.147.0 startup banner
Status: proposed
Evidence: worker smcs2050-review (.44) — assign completed its bring-up, but the
brief sat UNSUBMITTED in the composer (placeholder visible, "Context 100% left",
no output) for 6+ min; the 0.147.0 startup banner/warnings swallowed the Enter.
assign's confirm-the-pane-is-processing step passed anyway (it matched brief
text echoed above the banner, not actual processing).
Lesson: (1) "brief text visible in pane" is NOT proof of submission — proof is
working/thinking output or Context consumption; (2) recovery = send-wait to the
SAME worker (persistent-teammate rule), never re-assign; (3) candidate tooling
fix: confirm step should assert composer is empty AND context < 100%.

## 2026-08-18 dispatch verification: dry-run/probe evidence does not transfer
Status: proposed
Evidence: SMCS-2050 review dispatch (.44) — (a) `start --dry-run` showed profile
launch_flags correctly, but the actual dispatch used `assign` (different code
path); worker came up on config-default luna max, generation unattributable
(pre-launch_flags launch-meta). (b) `probe --metric tool_active` returned true
with parsed_from = a line of the BRIEF itself — pane-text matching false-positives
when the brief contains the keyword.
Lesson: (1) model/flag proof = the CLI status line (or launch-meta launch_flags,
recorded since tmux-agent-tools 70c3d7b) read AFTER launch, before sending the
brief — never a dry-run of a different subcommand; (2) liveness proof = Context
percentage consumption, not probe pane-matching; (3) mid-run rate-limit "switch
model?" prompts: keep the user-specified model, report the limit, never swap to
finish.

## 2026-08-18 single-channel observability: result.json is the worker's LEAST reliable output
Status: proposed
Evidence: SMCS-2050 review (.44) — reviewer FINISHED (VERDICT: BLOCK in pane,
14:48) but never wrote result.json (brief lacked the literal result path; also
pointed at git diff while changes sat staged). Waiter watched only result.json
→ three successive misreports ("running", "harvest alive", "still pending");
"Context 93% left" was post-completion residue misread as progress.
Lesson: (1) harvest verdicts from TWO channels — result.json AND the pane's
terminal marker (VERDICT/RESULT SUMMARY); a worker without an injected result
path can only answer in the pane. (2) `start`+send loses assign's result-init/
path-injection — hand-built briefs MUST embed the literal result path.
(3) Brief preflight question: "a reviewer starting from zero — does it SEE what
I want reviewed?" (staged vs unstaged diff, file visibility). (4) A dispatched
background waiter is not a live waiter — exit code first, then trust.

## 2026-08-18 correction: "banner swallowed the Enter" false-pass claim is UNCONFIRMED
Status: proposed
Corrects: "assign confirm-step false-pass on Codex 0.147.0 startup banner" (same
day). Its evidence — composer placeholder + Context 100% — was later shown to be
a misread (placeholder is permanent UI text) and the generation was
unattributable. The narrow lesson that SURVIVES: submission/liveness proof =
Context consumption + worker-written files (result.json, usage.jsonl), never
placeholder text or observer-written files (pane-hash). The confirm-step
tooling-fix suggestion is downgraded to needs-reproduction.

