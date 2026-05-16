# tmux-agent-tools Task Plan

## Goal

Develop tmux-agent-tools through the public PR workflow: keep `main` protected, ship verified releases, and iterate toward `v0.4.0` automation readiness on focused feature branches with Claude tmux-agent teammate review.

## Success Criteria

- `v0.3.0` tag exists on the verified session hygiene and transcript usability commit.
- Homebrew formula supports stable `v0.3.0` install without `--HEAD`.
- `brew install tmux-agent-tools` installs `claude-tmux`, `codex-tmux`, `tmux-agent-dialogue`, and `tmux-agent-sessions` from the tap.
- `npx skills add ohyeh/tmux-agent-tools --skill tmux-agent-tools` can discover the skill.
- True Codex/Claude tmux communication remains verified.
- Next release branch exists and has a concrete scope.
- Every mainline change goes through PR merge; no direct push to `main`.
- Future release tags and GitHub releases are created by a reviewed GitHub Actions workflow, not by local manual tag/release commands.

## Current State

- Repo: `ohyeh/tmux-agent-tools`
- Release tag: `v0.3.0`
- Release tag URL: `https://github.com/ohyeh/tmux-agent-tools/releases/tag/v0.3.0`
- Current main includes CI smoke checks, Node 24 checkout action updates, bounded dialogue orchestration, pair-review, remote participants, and explicit GitHub comment helper support.
- Verified commands: `start`, `start-ssh`, `send`, `send-wait-literal`, `wait`, `wait-text`, `wait-literal`, `capture`, `list`, `status`, `doctor`, `self-test`, `stop`, `tmux-agent-dialogue`, `tmux-agent-sessions`
- Verified install surfaces: `skills.sh`, stable Homebrew, Homebrew `--HEAD`, VM `install-bin`
- Verified runtime: real Codex/Claude start-send-wait-capture-stop and 10-run ping-pong
- Branch protection: `main` requires PR flow; force push and branch deletion are disabled.

## Decisions

- Release discipline comes before new features.
- `B` reliability primitives are now in `main`.
- `v0.3.0` improved session hygiene and transcript usability without adding more autonomy.
- `v0.4.0` should improve automation readiness: accurate session state, richer status contracts, bounded handoff, and local summary pipelines.
- `D` personal workflow shortcuts should stay outside public core unless generalized.
- Keep orchestration public and generic: transcript capture, pairing, and bounded turns are core; OpenClaw/Mac-mini shortcuts are not.

## Completed Work

1. Tag verified MVP as `v0.1.0`. Done.
2. Compute GitHub source archive SHA-256. Done.
3. Update Formula for stable `url` + `sha256`. Done.
4. Update README install instructions. Done.
5. Verify stable Homebrew install. Done.
6. Verify skills.sh discovery. Done.
7. Merge reliability primitives through PR. Done.
8. Merge structured status, local exit diagnostics, and CI smoke checks through PRs. Done.
9. Merge `feature/v0.2-roadmap` through PR #6. Done.
10. Merge bounded dialogue runner through PR #8. Done.
11. Merge real dialogue marker hardening through PR #9. Done.
12. Merge pair-review preset through PR #10. Done.
13. Merge remote participant support through PR #11. Done.
14. Merge explicit GitHub comment helper through PR #12. Done.
15. Merge `v0.2.0` stable Formula prep through PR #13. Done.
16. Merge `jq` runtime dependency and Formula summarize smoke through PR #14. Done.
17. Merge manual dry-run-first release workflow through PR #15. Done.
18. Merge release handoff docs and Formula bump summary workflow through PR #16. Done.
19. Merge v0.3 session hygiene helper through PR #18 (`32135e0`). Done.
20. Merge transcript validator through PR #19 (`8c3607a`). Done.
21. Merge failure classification through PR #20 (`8ca4aeb`). Done.
22. Merge safer transcript sharing through PR #21 (`132289f`). Done.
23. Merge stable status JSON through PR #22. Done.
24. Merge participant profiles through PR #23 and profile docs cleanup through PR #24. Done.
25. Merge critic preset through PR #25 and critic coverage cleanup through PR #26. Done.
26. Merge transcript-generic comment docs through PR #27 and generic transcript summary labels through PR #28. Done.
27. Merge roadmap refresh through PR #29, soft-wrap capture normalization through PR #30, clipboard mode override through PR #31, and human copy-mode UX hardening through PR #32. Done.
28. Merge task-plan release state through PR #33 and v0.3 real-agent release evidence through PR #34. Done.
29. Merge `v0.3.0` release notes through PR #35 (`6516e7c`). Done.
30. Merge `v0.3.0` Release workflow dry-run state through PR #36 (`97a629f`). Done.
31. Merge `v0.3.0` stable Formula bump through PR #37 (`6acb503`). Done.

## Active Work

Branch: `feature/v0.4-handoff-preset`

Scope:

- implement the v0.4 handoff preset for bounded context transfer;
- keep the handoff flow exactly two turns unless a future multi-step flow is explicitly designed;
- write only local transcript and optional summary files;
- avoid GitHub posting, scheduling, daemon loops, or automatic task execution;
- use Claude tmux-agent teammate review only;
- keep all mainline changes going through PR.

Verification evidence:

- PR #34 merged as `483b028` and main CI run `25963205465` passed.
- PR #35 merged as `6516e7c`; feature branch CI run `25963350635` and main CI run `25963375020` passed.
- Real wrapper smoke passed with `V03CODEXSMOKEOK`, `V03CLAUDESMOKEOK`, and `REAL_WRAPPER_SMOKE_OK`.
- Real bounded dialogue smoke passed with `REAL_DIALOGUE_SMOKE_OK`; `jq` verified codex turn 1 and claude turn 2.
- Local release workflow equivalent validation passed for `v0.3.0`: tag absence check, script syntax, skill validation, Formula syntax/style, wrapper self-tests, fake dialogue smoke, `jq` transcript checks, release notes extraction, and `git diff --check`.
- Claude tmux-agent teammate reviewed the release-prep diff and found no blockers.
- Release workflow dry-run for `v0.3.0` passed in run `25963410344`: `validate` succeeded, `publish` was skipped, and `refs/tags/v0.3.0` is still absent.
- Claude tmux-agent teammate reviewed this dry-run state update and found no blockers.
- PR #36 merged as `97a629f`; main CI run `25963504552` passed.
- Release workflow non-dry-run for `v0.3.0` passed in run `25963549877`: `validate` and `publish` succeeded.
- GitHub Release exists: `https://github.com/ohyeh/tmux-agent-tools/releases/tag/v0.3.0`.
- Release archive SHA-256 for `https://github.com/ohyeh/tmux-agent-tools/archive/refs/tags/v0.3.0.tar.gz` is `7447ce4f8f88a8da2f2c8b0a610c68754886f642c63cc82f6a5749b7b8041318`.
- Local Formula validation passed against a tap clone of this branch: `brew reinstall --build-from-source ohyeh/tmux-agent-tools/tmux-agent-tools`, `brew test`, and `brew info` all reported `0.3.0`; the installed commands include `claude-tmux`, `codex-tmux`, `tmux-agent-dialogue`, and `tmux-agent-sessions`.
- Claude tmux-agent teammate reviewed the Formula bump diff, independently recomputed the `v0.3.0` archive SHA-256, and found no blockers. The human tmux copy/mouse UX concern is a valid follow-up, but does not block this release Formula bump.
- PR #37 merged as `6acb503`; main CI run `25963770634` passed.
- Stable Homebrew reinstall/test from the GitHub tap reported `0.3.0` and installed `tmux-agent-sessions`.
- Claude tmux-agent teammate brainstormed v0.4 candidates and recommended automation readiness: status/session truth, handoff preset, and summary-file pipeline.
- Roadmap docs validation passed: script syntax, skill metadata validation, Formula syntax/style, and text searches for v0.4 scope anchors.
- Claude tmux-agent teammate reviewed the v0.4 roadmap diff and found no blockers.
- `tmux-agent-sessions` state accuracy local validation passed on `feature/v0.4-sessions-state`: script syntax, skill metadata validation, Formula syntax/style, wrapper self-tests, running inventory JSON shape, cleanup preview text shape, exited-but-capturable inventory JSON shape, cleanup preview JSON shape, and cleanup scoping.
- Claude tmux-agent teammate reviewed the session state diff, initially found two blockers, then re-reviewed after fixes and found no blockers. Remaining note: `missing` is only wrapper-reported passthrough/race state, now documented in README.
- PR #39 merged as `52c0fe9`; main CI run `25966994197` passed.
- Summary-file pipeline local validation passed on `feature/v0.4-summary-file-pipeline`: workflow YAML check with `yq`, script syntax, skill metadata validation, Formula syntax/style, wrapper self-tests, `git diff --check`, and fake `pair-review` smoke covering `summarize --summary-file`, `github-comment --transcript`, `github-comment --summary-file`, `--max-lines`, invalid transcript rejection, both-input rejection, and missing-input rejection.
- Claude tmux-agent teammate reviewed the summary-file pipeline diff after two Claude API 500 attempts and found no blockers (`VERDICT: PASS`). After exactly-one validation was tightened for missing input too, Claude re-reviewed and again found no blockers (`VERDICT: PASS`). Non-blocking notes: empty summary-file and `--max-bytes` summary-file tests could be added later.
- PR #40 merged as `2592628`; main CI run `25969424457` passed.
- Handoff preset local validation passed on `feature/v0.4-handoff-preset`: workflow YAML check with `yq`, script syntax, skill metadata validation, Formula syntax/style, wrapper self-tests, `git diff --check`, and fake `handoff` smoke covering two-turn transcript shape, summary file output, `validate-transcript`, `jq` assertions for agent-a/agent-b turns, and rejection of `handoff --turns 3`.
- Claude tmux-agent teammate reviewed the handoff preset diff and found no blockers (`VERDICT: PASS`). After removing an unused local variable, Claude re-reviewed and again found no blockers (`VERDICT: PASS`). Non-blocking notes: `--turns` is not listed in handoff usage because non-two-turn handoff is intentionally rejected; CI now checks handoff summary body content as well as the header.
- Pending for this branch: PR CI.

## v0.2.0 Candidate Scope

P0:

- `wait-text --literal` alias for exact marker waits;
- `send-wait-literal` to wait for a new literal after a prompt send;
- Claude first-run/permission confirmation diagnostics in `status`;
- `dialogue` runner for bounded Codex/Claude ping-pong using existing wrappers - first local MVP merged;
- transcript file output with timestamps, speaker, marker, and captured text - first local MVP merged;
- cleanup guarantees for both sessions on success/failure - first local MVP merged;
- local-only operation by default - first local MVP merged.

P1:

- `pair-review` preset: one agent proposes, the other reviews, final transcript saved;
- `--turns`, `--timeout`, `--workdir`, `--agent-a`, `--agent-b`, `--prompt-file`;
- machine-readable JSONL transcript.
- harden real Codex/Claude marker protocol so manual 2-turn smoke closes without intervention.

P2:

- remote participant support through `start-ssh` - merged;
- GitHub PR comment helper that posts transcript summaries only when explicitly requested - merged;
- credential-free CI integration tests with fake participants;
- real-agent/token tests only as manual release evidence or explicit opt-in workflows.

Do not do:

- personal OpenClaw/Mac mini shortcuts in core;
- hidden external side effects;
- default real-agent orchestration in CI;
- destructive cleanup outside owned tmux sessions.
