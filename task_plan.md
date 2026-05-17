# tmux-agent-tools Task Plan

## Goal

Develop tmux-agent-tools through the public PR workflow: keep `main` protected, ship verified releases, and iterate beyond `v0.5.0` observability into `v0.6.0` composability on focused feature branches with Claude tmux-agent teammate review.

## Success Criteria

- `v0.3.0` tag exists on the verified session hygiene and transcript usability commit, and remains the current stable Homebrew release until the next tag is published.
- `v0.4.0` release notes and dry-run evidence stay current with all merged automation-readiness and operator-ergonomics slices.
- Homebrew formula supports stable `v0.3.0` install without `--HEAD`, with the `v0.4.0` Formula bump deferred until after the reviewed Release workflow creates the tag.
- `brew install tmux-agent-tools` installs `claude-tmux`, `codex-tmux`, `tmux-agent-dialogue`, and `tmux-agent-sessions` from the tap.
- `npx skills add ohyeh/tmux-agent-tools --skill tmux-agent-tools` can discover the skill.
- True Codex/Claude tmux communication remains verified.
- Next release branch exists and has a concrete scope.
- Next unreleased roadmap exists and has a concrete first slice.
- Every mainline change goes through PR merge; no direct push to `main`.
- Future release tags and GitHub releases are created by a reviewed GitHub Actions workflow, not by local manual tag/release commands.

## Current State

- Repo: `ohyeh/tmux-agent-tools`
- Release tag: `v0.3.0`
- Release tag URL: `https://github.com/ohyeh/tmux-agent-tools/releases/tag/v0.3.0`
- Current main includes CI smoke checks, Node 24 checkout action updates, bounded dialogue orchestration, pair-review, remote participants, explicit GitHub comment helper support, wrapper-backed session state, bounded status tails, blocked-reason diagnostics, handoff, summary-file comment input, and bounded session watch.
- Verified commands: `start`, `start-ssh`, `send`, `send-wait-literal`, `wait`, `wait-text`, `wait-literal`, `capture`, `list`, `status`, `doctor`, `self-test`, `stop`, `tmux-agent-dialogue`, `tmux-agent-sessions`
- Verified install surfaces: `skills.sh`, stable Homebrew, Homebrew `--HEAD`, VM `install-bin`
- Verified runtime: real Codex/Claude start-send-wait-capture-stop and 10-run ping-pong
- Branch protection: `main` requires PR flow; force push and branch deletion are disabled.

## Decisions

- Release discipline comes before new features.
- `B` reliability primitives are now in `main`.
- `v0.3.0` improved session hygiene and transcript usability without adding more autonomy.
- `v0.4.0` should improve automation readiness: accurate session state, richer status contracts, bounded handoff, and local summary pipelines.
- `v0.5.0` should improve observability and multi-session composability: bounded session watch, richer exit detail, transcript contract versioning, and local blocked-trigger artifacts.
- `v0.6.0` should improve composability closure: stronger local output contracts, shell quality gates, and bounded presets without release side effects or credentials.
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
32. Merge `v0.4.0` release-process validation docs through PR #51 (`71b37a3`). Done.
33. Merge `v0.4.0` release-ready state through PR #52 (`9cf1684`). Done.
34. Merge `v0.4.0` status-contract roadmap sync through PR #53 (`17ee594`). Done.
35. Merge `v0.4.0` roadmap current-state refresh through PR #54 (`dc37dc2`). Done.
36. Merge `v0.5.0` roadmap through PR #55 (`71e8ec4`). Done.
37. Merge bounded session watch through PR #56 (`3a28a5a`). Done.
38. Merge status exit-code contract through PR #57 (`854b51e`). Done.
39. Merge v0.5 exit-code state sync through PR #58 (`46df23e`). Done.
40. Merge transcript schema-version validation through PR #60 (`61af464`). Done.
41. Merge skill environment reference parity through PR #83 (`ca4730e`). Done.
42. Merge JSON summary schema metadata through PR #85 (`17bb966`). Done.
43. Merge structured GitHub comment result through PR #87 (`761758b`). Done.
44. Merge bounded debate preset through PR #89 (`69799d2`). Done.

## Active Work

Branch: `feature/v0.6-session-inventory-ergonomics`

Scope:

- implement the next `v0.6.0` slice from the roadmap while keeping the `v0.5.0` non-dry-run release gated on explicit operator go/no-go;
- add scriptable session inventory ergonomics for sorted and filtered local inventory consumption;
- keep this free of release publish, tag, GitHub Release, Formula bump, credentials, scheduling, cleanup, GitHub posting, or unrelated runtime side effects;
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
- PR #41 merged as `5c39146`; main CI run `25969626764` passed.
- Status tail JSON local validation passed on `feature/v0.4-status-tail-json`: workflow YAML check with `yq`, script syntax for both wrappers, skill metadata validation, Formula syntax/style, wrapper self-tests, `git diff --check`, and local `jq` smoke proving missing sessions return `last_capture_lines == []`, bounded two-line tails work for Claude/Codex, and invalid/zero `*_STATUS_TAIL_LINES` values fall back to a bounded array.
- Claude tmux-agent teammate reviewed the status tail JSON diff, found two blockers in the first implementation, then re-reviewed after the fix and reported no blockers with `VERDICT: READY TO MERGE`. Final docs-only re-reviews also reported `BLOCKERS: None`, `NON-BLOCKING: None`, and `VERDICT: READY TO MERGE`; the README now states the diagnostic tail is bounded by the wrapper's 80-line status capture window.
- PR #42 merged as `febcd46`; main CI run `25969865523` passed.
- Status blocked-reason local validation passed on `feature/v0.4-status-blocked-reason`: workflow YAML check with `yq`, script syntax for both wrappers and `tmux-agent-sessions`, skill metadata validation, Formula syntax/style, wrapper self-tests, `git diff --check`, and local `jq` smoke proving missing sessions return `confirmation_detected == false` and `blocked_reason == null`, Claude permission prompts map to `permission_prompt`, Codex approval prompts map to `approval_prompt`, SSH prompts map to `ssh_prompt`, exit markers map to `cli_exited`, wrapper exit footers do not false-positive as `permission_prompt`, ordinary `accept` text does not false-positive as `approval_prompt`, and `tmux-agent-sessions list --json` preserves wrapper blocked-state fields.
- Claude tmux-agent teammate reviewed the status blocked-reason diff, found no blockers, then re-reviewed after prompt-pattern and CI hardening; final verdict was `BLOCKERS: None`, `NON-BLOCKING: None`, and `VERDICT: SHIP`.
- PR #43 merged as `8a77554`; main CI run `25970224776` passed.
- v0.4.0 release-prep local validation passed on `feature/v0.4-release-prep`: release workflow YAML check with `yq`, script syntax for all wrappers/dialogue/session helper, Formula syntax/style, wrapper self-tests, `git diff --check`, release-note extraction for `v0.4.0`, and the release workflow fake two-turn dialogue smoke with `jq` assertions.
- Claude tmux-agent teammate reviewed the v0.4.0 release-prep diff and found no blockers with `VERDICT: READY TO PR`; Formula bump remains correctly deferred until after the tag exists.
- PR #44 merged as `5070e2a`; main CI run `25970349954` passed.
- Release workflow dry-run for `v0.4.0` passed in run `25970374512` (`https://github.com/ohyeh/tmux-agent-tools/actions/runs/25970374512`): `validate` succeeded, release notes were built from `CHANGELOG.md`, `publish` was skipped, and `refs/tags/v0.4.0` / the GitHub Release were absent before dispatch.
- Claude tmux-agent teammate reviewed this dry-run state update and found no blockers with `VERDICT: READY`.
- PR #45 merged as `c411413`; main CI run `25970460874` passed.
- Pair-review swap local validation passed on `feature/v0.4-pair-review-swap`: workflow YAML check with `yq`, script syntax for wrappers/dialogue/session helper, Formula syntax/style, wrapper self-tests, `git diff --check`, and fake pair-review smoke using slurped `jq` assertions to prove default A-to-B order, `--swap` B-to-A order, `critic --swap` rejection, and leading `--swap pair-review` rejection.
- Claude tmux-agent teammate reviewed the pair-review swap diff, initially found two blockers in CI/assertion clarity and leading `--swap` handling, then re-reviewed after fixes; final verdict was `BLOCKERS: None`, `NON-BLOCKING: None`, and `VERDICT: SHIP`.
- PR #46 merged as `9c17d2f`; main CI run `25970732453` passed.
- Profile env local validation passed on `feature/v0.4-profile-env`: workflow YAML check with `yq`, script syntax for wrappers/dialogue/session helper, Formula syntax/style, skill metadata validation, wrapper self-tests, `git diff --check`, fake profile smoke, fake `codex` executable through the real wrapper path proving no-env profiles do not crash and profile env reaches the local tmux session process, and bad profile rejection for unknown keys, non-string profile values, invalid env keys, non-string env values, and newline env values.
- Claude tmux-agent teammate reviewed the first profile env diff and found a blocker: empty `@f` command substitution could create `env "" wrapper ...` for env-less real participants. The fix filters empty entries and passes session env through wrapper-managed `tmux new-session -e` arguments; local revalidation covered env-less and env-set real-wrapper paths.
- Claude tmux-agent teammate re-reviewed after the fix and found no blockers with `VERDICT: SHIP`; the only non-blocking CI no-env assertion note was addressed and rechecked locally.
- PR #47 merged as `7ad17a5`; main CI run `25971163853` passed.
- PR #48 merged as `3ac6bc2`; main CI run `25971276044` passed.
- Release workflow validation hardening local equivalent passed on `feature/v0.4-release-validation-sessions`: workflow YAML check with `yq`, `git diff --check`, script syntax for wrappers/dialogue/session helper, Formula syntax/style, wrapper self-tests, empty session inventory JSON assertion, fake release dialogue smoke, `validate-transcript`, `jq` turn assertions, and v0.4.0 release-note extraction.
- Claude tmux-agent teammate reviewed the first release-validation diff and found a blocker: `jq -s 'length == 0'` did not fail on false. The fix changed the release workflow check to `jq -se 'length == 0'`; local revalidation proved the false case exits non-zero, and Claude re-reviewed with `VERDICT: SHIP`.
- PR #49 merged as `35ab0bd`; main CI run `25971447690` passed.
- Hardened Release workflow dry-run for `v0.4.0` passed in run `25971497742` (`https://github.com/ohyeh/tmux-agent-tools/actions/runs/25971497742`) on `35ab0bd`: the `validate` job succeeded, its `Build release notes` and `Dry-run summary` steps succeeded, the `publish` job was skipped, and `refs/tags/v0.4.0` / the GitHub Release remain absent.
- PR #50 merged as `8c5b34e`; main CI run `25971623256` passed.
- Release-process docs validation passed on `feature/v0.4-release-process-docs-refresh`: `git diff --check`, workflow YAML name check with `yq`, workflow anchor checks with `rg`, and docs/task-plan anchor checks with `rg`.
- Claude tmux-agent teammate reviewed the release-process docs diff and found no blockers with `VERDICT: SHIP`.
- PR #51 merged as `71b37a3`; main CI run `25971728433` passed.
- Current `v0.4.0` release state: release notes exist, the hardened Release workflow dry-run is green, release-process docs match the workflow gates, and the Formula bump remains deferred until after the reviewed Release workflow creates the tag.
- Release-ready state validation passed on `feature/v0.4-release-ready-state`: `git diff --check`, workflow YAML name check with `yq`, roadmap/task-plan anchor checks with `rg`, and Claude tmux-agent teammate review with `VERDICT: SHIP`.
- PR #52 merged as `9cf1684`; main CI run `25971846873` passed.
- Roadmap status-contract sync validation passed on `feature/v0.4-roadmap-status-contract-sync`: `git diff --check`, workflow YAML name check with `yq`, script syntax checks, stale-status searches with `rg`, and Claude tmux-agent teammate re-review with `VERDICT: SHIP`.
- PR #53 merged as `17ee594`; main CI run `25971998894` passed.
- Current-state roadmap validation passed on `feature/v0.4-roadmap-current-state`: `git diff --check`, workflow YAML name check with `yq`, script syntax checks, stale roadmap searches with `rg`, and Claude tmux-agent teammate review with `VERDICT: SHIP`.
- PR #54 merged as `dc37dc2`; main CI run `25972109136` passed.
- Claude tmux-agent teammate brainstormed the next version and recommended `v0.5.0` focus on observability and multi-session composability, with bounded `tmux-agent-sessions list --watch --json --count N` as the first measurable slice.
- v0.5 roadmap validation passed on `feature/v0.5-roadmap`: `git diff --check`, workflow YAML name check with `yq`, script syntax checks, roadmap anchor searches with `rg`, and Claude tmux-agent teammate final review with `VERDICT: SHIP`.
- PR #55 merged as `71e8ec4`; main CI run `25972340758` passed.
- Bounded session watch local validation passed on `feature/v0.5-bounded-session-watch`: script syntax, skill metadata validation, Formula syntax/style, wrapper self-tests, `git diff --check`, and fake session JSON watch smoke covering `--count 0`, invalid `--count`, and two emitted snapshots.
- Claude tmux-agent teammate reviewed the bounded session watch diff, found a zsh regex blocker in the first implementation, then re-reviewed after fixes and found no blockers with `VERDICT: SHIP`.
- PR #56 merged as `3a28a5a`; main CI run `25972534503` passed.
- Status exit-code local validation passed on `feature/v0.5-status-exit-code`: `git diff --check`, workflow YAML name checks with `yq`, script syntax checks, skill metadata validation, Formula syntax/style, wrapper self-tests, missing status `exit_code == null`, fake local/remote exit markers with `exit_code == 7` and `exit_code == 2`, inventory JSON preservation, cleanup preview JSON preservation, and dialogue rows with `exit_code == null`.
- Claude tmux-agent teammate reviewed the status exit-code diff and found no blockers with `VERDICT: SHIP`. Non-blocking notes: multiple captured exit markers use last-wins parsing, and the bounded pane capture window remains the source of evidence.
- PR #57 merged as `854b51e`; main CI run `25972810785` passed.
- Docs-only state validation passed on `feature/v0.5-exit-code-state`: `git diff --check`, workflow YAML name checks with `yq`, roadmap/task-plan anchor checks with `rg`, and Claude tmux-agent teammate review with `VERDICT: SHIP`.
- PR #58 merged as `46df23e`; main CI run `25972934251` passed.
- Transcript schema-version local validation passed on `feature/v0.5-transcript-schema-version`: `git diff --check`, workflow YAML name checks with `yq`, script syntax check, skill metadata validation, Formula syntax/style, wrapper self-tests, fake transcript default validation as schema version `1`, explicit `--schema-version 1` validation, unsupported `--schema-version 2` rejection before transcript reading, empty schema-version rejection, and `summarize --schema-version` rejection.
- Claude tmux-agent teammate reviewed the transcript schema-version diff, found one CI stability blocker, then re-reviewed after fixes and found no blockers with `VERDICT: SHIP`.
- PR #60 merged as `61af464`; main CI run `25973206839` passed.
- Local blocked-trigger artifact validation passed on `feature/v0.5-blocked-trigger-artifacts`: `zsh -n` for `tmux-agent-dialogue`, workflow YAML name check with `yq`, `git diff --check`, skill metadata smoke, Formula Ruby syntax check, wrapper self-tests, blocked fake smoke proving `failure_type == "permission_prompt"` and trigger JSON `blocked_reason == "permission_prompt"`, non-blocked pair-review proving no trigger file is created, and transcript validation for both flows.
- `brew style --formula Formula/tmux-agent-tools.rb` was attempted from this non-tap working copy and rejected by Homebrew because formulae must be inside a tap; Formula syntax still passed and the Formula file is unchanged by this slice.
- Claude tmux-agent teammate reviewed the blocked-trigger diff, initially raised two evidence questions, then re-reviewed after local proof and found no blockers with `VERDICT: SHIP`.
- PR #62 merged as `30ba8a6`; feature branch CI run `25973517992` and main CI run `25973541155` passed.
- Summary output formats local validation passed on `feature/v0.5-summary-output-formats`: `zsh -n` for `tmux-agent-dialogue`, workflow YAML name check with `yq`, `git diff --check`, skill metadata smoke, Formula Ruby syntax check, wrapper self-tests, fake pair-review summary smoke proving default Markdown equals explicit `--output-format markdown`, JSON output validates with `jq`, redacted structured `turns[].tail_lines` do not leak the unredacted fake marker text, JSON `--summary-file` writes the selected format, `github-comment --output-format` is rejected, and unknown output formats are rejected.
- Claude tmux-agent teammate reviewed the summary output formats diff, found no blockers, and re-reviewed the final diff after a metadata naming cleanup with `VERDICT: SHIP`.
- PR #64 merged as `d298f25`; feature branch CI run `25973829558` and main CI run `25973857604` passed.
- Cleanup preview coverage local validation passed on `feature/v0.5-cleanup-preview-coverage`: `zsh -n` for `tmux-agent-sessions`, workflow YAML name check with `yq`, `git diff --check`, skill metadata smoke, Formula Ruby syntax check, wrapper self-tests, and local tmux smoke proving `cleanup --preview --json` covers all owned sessions, `--tool claude`, `--tool dialogue`, and `--name ci-hygiene`, excludes unrelated sessions, leaves previewed sessions alive, and rejects `cleanup --execute --json`.
- Claude tmux-agent teammate reviewed the cleanup preview coverage diff and found no blockers with `VERDICT: SHIP`.
- PR #66 merged as `1b482fc`; feature branch CI run `25974048560` and main CI run `25974086394` passed.
- Profile timeout override local validation passed on `feature/v0.5-profile-timeout-overrides`: `zsh -n` for `tmux-agent-dialogue`, workflow YAML name check with `yq`, `git diff --check`, skill metadata smoke, Formula Ruby syntax check, wrapper self-tests, and fake profile timeout smoke proving `timeout:"1"` triggers a per-profile `marker_timeout` transcript while non-integer and zero timeout profile values are rejected.
- Claude tmux-agent teammate reviewed the profile timeout override diff, initially raised a zsh regex robustness blocker, then re-reviewed after the regex fix and found no blockers with `VERDICT: SHIP`.
- PR #68 merged as `002dfaa`; feature branch CI run `25974347910` and main CI run `25974375950` passed.
- GitHub comment edit-existing local validation passed on `feature/v0.5-github-comment-edit-existing`: `zsh -n` for `tmux-agent-dialogue`, workflow YAML name check with `yq`, `git diff --check`, skill metadata smoke, Formula Ruby syntax check, wrapper self-tests, and fake GitHub smoke proving dry-run edit mode does not call `gh`, non-numeric `--edit-existing` is rejected, and `--post-github-comment --edit-existing 123` calls `gh api --method PATCH repos/ohyeh/tmux-agent-tools/issues/comments/123 --input <json>` with the rendered Markdown body.
- Claude tmux-agent teammate reviewed the GitHub comment edit-existing diff and found no blockers with `VERDICT: SHIP`.
- PR #70 merged as `1febcd0`; feature branch CI run `25974584663` and main CI run `25974612263` passed.
- Summary-file edge coverage local validation passed on `feature/v0.5-summary-file-edge-coverage`: `zsh -n` for `tmux-agent-dialogue`, workflow YAML name check with `yq`, `git diff --check`, skill metadata smoke, Formula Ruby syntax check, wrapper self-tests, and fake summary-file smoke proving `github-comment --summary-file <rendered-summary> --max-bytes 200` emits the `--max-bytes` truncation note while an empty `--summary-file` dry-run succeeds with an empty body and no GitHub write.
- Claude tmux-agent teammate reviewed the summary-file edge coverage diff and found no blockers with `VERDICT: SHIP`.
- PR #72 merged as `2421161`; feature branch CI run `25974802216` and main CI run `25974835304` passed.
- v0.5 current-state refresh local validation passed on `feature/v0.5-current-state-refresh`: `git diff --check`, workflow YAML name check with `yq`, and roadmap/changelog/task-plan anchor checks with `rg` proving the unreleased `v0.5.0` changelog, all-planned-slices-landed status, no-tag/release/Formula-bump state, and next release-readiness dry-run path are documented.
- Claude tmux-agent teammate reviewed the v0.5 current-state refresh diff and found no blockers with `VERDICT: SHIP`; the only duplicate release-notes wording observation was cleaned up before PR.
- PR #74 merged as `d9c96da`; feature branch CI run `25975033756` and main CI run `25975062529` passed.
- v0.5 release-prep branch created as `feature/v0.5-release-prep`.
- v0.5 release-prep local validation passed on `feature/v0.5-release-prep`: `git diff --check`, workflow YAML name checks with `yq`, script syntax checks, Formula Ruby syntax check, wrapper self-tests, empty session inventory check with `jq`, release-notes extraction for `v0.5.0`, absent tag/release checks, fake release dialogue smoke, transcript validation, turn checks with `jq`, and release-prep anchor checks with `rg`.
- `brew style --formula Formula/tmux-agent-tools.rb` was attempted from this non-tap working copy and rejected by Homebrew because formulae must be inside a tap; the Release workflow keeps the authoritative `brew style` gate.
- Claude tmux-agent teammate reviewed the v0.5 release-prep diff, including the new release-readiness doc, and found no blockers with `VERDICT: SHIP`.
- PR #76 merged as `ed2c1a7`; feature branch CI run `25975327454` and main CI run `25975354971` passed.
- Release workflow dry-run for `v0.5.0` passed in run `25975385734`: `validate` succeeded, `publish` was skipped, and both the `v0.5.0` tag and GitHub Release are still absent.
- Claude tmux-agent teammate reviewed the v0.5 dry-run state sync diff and found no blockers with `VERDICT: SHIP`.
- PR #77 merged as `a2ebfe0`; feature branch CI run `25975453243` and main CI run `25975479364` passed.
- Pending next: explicit operator go/no-go before any non-dry-run Release workflow for `v0.5.0`; do not publish the tag, GitHub Release, or Formula bump without that approval.
- Claude tmux-agent teammate brainstormed v0.6 candidates and recommended composability closure: shellcheck CI, skill env reference parity, JSON summary schema metadata, structured GitHub comment results, bounded debate preset, and scriptable session inventory ergonomics.
- v0.6 roadmap validation passed on `feature/v0.6-roadmap`: `git diff --check`, workflow YAML name checks with `yq`, roadmap/task-plan/README anchor checks with `rg`, and Claude tmux-agent teammate review with `VERDICT: SHIP`.
- PR #79 merged as `a4320a9`; feature branch CI run `25975810492` and main CI run `25975839000` passed.
- Claude tmux-agent teammate reviewed the v0.6 roadmap state sync diff and found no blockers with `VERDICT: SHIP`.
- Shellcheck CI gate local validation passed on `feature/v0.6-shellcheck-ci`: `git diff --check`, workflow YAML checks with `yq`, `zsh -n` for all installed scripts including `install-bin`, `scripts/ci-shellcheck`, `shellcheck scripts/ci-shellcheck`, Formula Ruby syntax, wrapper self-tests, empty session inventory check with `jq`, and roadmap/task-plan anchor checks with `rg`.
- ShellCheck cannot parse zsh (`SC1071`), so the gate lints supported-shell helpers and keeps an explicit `SC1071` compatibility sentinel for installed zsh scripts while preserving `zsh -n`.
- Claude tmux-agent teammate reviewed the shellcheck CI diff and found one blocker: `scripts/ci-shellcheck` must be executable because CI invokes it directly. The file was staged with mode `100755`.
- Claude tmux-agent teammate re-reviewed after the executable-bit fix and found no blockers with `VERDICT: SHIP`.
- PR #81 merged as `64d7142`; feature branch CI run `25976129168` and main CI run `25976153865` passed.
- Claude tmux-agent teammate reviewed the shellcheck state sync diff and found no blockers with `VERDICT: SHIP`.
- Skill env reference parity local validation passed on `feature/v0.6-skill-env-reference-parity`: `git diff --check`, workflow YAML name checks with `yq`, skill metadata smoke, README/SKILL public env parity checks with `rg`, and private hostname/path guard with `rg`.
- Claude tmux-agent teammate reviewed the skill env reference parity diff and found no blockers with `VERDICT: SHIP`.
- PR #83 merged as `ca4730e`; feature branch CI run `25976405131` and main CI run `25976433533` passed.
- JSON summary schema metadata local validation passed on `feature/v0.6-json-summary-schema`: `zsh -n` for `tmux-agent-dialogue`, workflow YAML name checks with `yq`, `git diff --check`, dialogue help smoke, roadmap/README/CI/script anchor checks with `rg`, and fake pair-review summary smoke proving default Markdown still renders while JSON stdout and JSON `--summary-file` include top-level `schema_version == "1"` with existing fields preserved.
- Claude tmux-agent teammate reviewed the JSON summary schema metadata diff and found no blockers with `VERDICT: SHIP`.
- PR #85 merged as `17bb966`; feature branch CI run `25976644042` and main CI run `25976674074` passed.
- Structured GitHub comment result local validation passed on `feature/v0.6-github-comment-json-result`: `zsh -n` for `tmux-agent-dialogue`, workflow YAML name checks with `yq`, `git diff --check`, `scripts/ci-shellcheck`, roadmap/README/CI/script anchor checks with `rg`, and fake pair-review GitHub comment smoke proving JSON dry-run post/edit do not call `gh`, JSON post/edit call fake `gh` only with explicit `--post-github-comment`, and JSON results report `dry_run`, `posted`, `edited`, `comment_url`, and `comment_id` as available.
- Claude tmux-agent teammate reviewed the structured GitHub comment result diff and found no blockers with `VERDICT: SHIP`.
- PR #87 merged as `761758b`; feature branch CI run `25976924280` and main CI run `25976956631` passed.
- Bounded debate preset local validation passed on `feature/v0.6-debate-preset`: `git diff --check`, `zsh -n` for `tmux-agent-dialogue`, workflow YAML name checks with `yq`, `scripts/ci-shellcheck`, Formula Ruby syntax check, wrapper self-tests, dialogue help smoke, roadmap/README/SKILL/CI/script anchor checks with `rg`, fake four-turn `debate` smoke proving alternating agent-a/agent-b transcript rows with `jq`, `validate-transcript`, `debate` summary label output, and odd `--turns` rejection.
- Claude tmux-agent teammate reviewed the bounded debate preset diff and found no blockers with `VERDICT: SHIP`.
- PR #89 merged as `69799d2`; feature branch CI run `25977319588` and main CI run `25977351225` passed.
- Session inventory ergonomics local validation passed on `feature/v0.6-session-inventory-ergonomics`: `git diff --check`, workflow YAML name checks with `yq`, `zsh -n` for `tmux-agent-sessions`, `scripts/ci-shellcheck`, Formula Ruby syntax check, wrapper self-tests, README/SKILL/CI/script anchor checks with `rg`, and local tmux smoke proving `list --sort name`, `list --sort session`, `list --state running --sort tool`, empty `--state exited`, watch snapshots with `--state running --sort name`, text output shape, and invalid `--sort` / `--state` rejection.
- Pending for this branch: Claude tmux-agent teammate review, PR CI, and merge.

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
