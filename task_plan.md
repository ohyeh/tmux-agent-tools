# tmux-agent-tools Task Plan

## Goal

Develop tmux-agent-tools through the public PR workflow: keep `main` protected, ship verified releases, and iterate toward `v0.3.0` session hygiene and transcript usability on focused feature branches with Claude tmux-agent teammate review.

## Success Criteria

- `v0.2.0` tag exists on the verified orchestration commit.
- Homebrew formula supports stable `v0.2.0` install without `--HEAD`.
- `brew install tmux-agent-tools` installs `claude-tmux`, `codex-tmux`, and `tmux-agent-dialogue` from the tap.
- `npx skills add ohyeh/tmux-agent-tools --skill tmux-agent-tools` can discover the skill.
- True Codex/Claude tmux communication remains verified.
- Next release branch exists and has a concrete scope.
- Every mainline change goes through PR merge; no direct push to `main`.
- Future release tags and GitHub releases are created by a reviewed GitHub Actions workflow, not by local manual tag/release commands.

## Current State

- Repo: `ohyeh/tmux-agent-tools`
- Release tag: `v0.2.0`
- Release tag URL: `https://github.com/ohyeh/tmux-agent-tools/releases/tag/v0.2.0`
- Current main includes CI smoke checks, Node 24 checkout action updates, bounded dialogue orchestration, pair-review, remote participants, and explicit GitHub comment helper support.
- Verified commands: `start`, `start-ssh`, `send`, `send-wait-literal`, `wait`, `wait-text`, `wait-literal`, `capture`, `list`, `status`, `doctor`, `self-test`, `stop`, `tmux-agent-dialogue`
- Verified install surfaces: `skills.sh`, stable Homebrew, Homebrew `--HEAD`, VM `install-bin`
- Verified runtime: real Codex/Claude start-send-wait-capture-stop and 10-run ping-pong
- Branch protection: `main` requires PR flow; force push and branch deletion are disabled.

## Decisions

- Release discipline comes before new features.
- `B` reliability primitives are now in `main`.
- `v0.3.0` should improve session hygiene and transcript usability rather than add more autonomy.
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
19. Merge v0.3 session hygiene helper through PR #18. Done.
20. Merge transcript validator through PR #19. Done.
21. Merge failure classification through PR #20. Done.
22. Merge safer transcript sharing through PR #21. Done.
23. Merge stable status JSON through PR #22. Done.
24. Merge participant profiles through PR #23 and profile docs cleanup through PR #24. Done.
25. Merge critic preset through PR #25 and critic coverage cleanup through PR #26. Done.

## Active Work

Branch: `feature/transcript-summary-label`

Scope:

- make generic `summarize` and `github-comment` output use a `transcript` label instead of the `pair-review` preset label;
- use Claude tmux-agent teammate review only;
- keep all mainline changes going through PR.

Verification evidence:

- PR #27 main CI passed after clarifying transcript-generic `github-comment` wording.
- Local smoke verifies `github-comment` dry-run output for `dialogue`, `pair-review`, and `critic` transcripts.
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
