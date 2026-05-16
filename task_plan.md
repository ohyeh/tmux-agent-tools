# tmux-agent-tools Task Plan

## Goal

Develop tmux-agent-tools through the public PR workflow: keep `main` protected, ship verified releases, and iterate toward `v0.2.0` orchestration features on focused feature branches with tmux-agent teammate review.

## Success Criteria

- `v0.1.0` tag exists on the verified MVP commit.
- Homebrew formula supports stable install without `--HEAD`.
- `brew install tmux-agent-tools` succeeds from the tap.
- `npx skills add ohyeh/tmux-agent-tools --skill tmux-agent-tools` can discover the skill.
- True Codex/Claude tmux communication remains verified.
- Next v0.2.0 branch exists and has a concrete scope.
- Every mainline change goes through PR merge; no direct push to `main`.

## Current State

- Repo: `ohyeh/tmux-agent-tools`
- Release tag: `v0.2.0`
- Release tag URL: `https://github.com/ohyeh/tmux-agent-tools/releases/tag/v0.2.0`
- Current main includes CI smoke checks, Node 24 checkout action updates, bounded dialogue orchestration, pair-review, remote participants, and explicit GitHub comment helper support.
- Verified commands: `start`, `start-ssh`, `send`, `send-wait-literal`, `wait`, `wait-text`, `wait-literal`, `capture`, `list`, `status`, `doctor`, `self-test`, `stop`
- Verified install surfaces: `skills.sh`, stable Homebrew, Homebrew `--HEAD`, VM `install-bin`
- Verified runtime: real Codex/Claude start-send-wait-capture-stop and 10-run ping-pong
- Branch protection: `main` requires PR flow; force push and branch deletion are disabled.

## Decisions

- Release discipline comes before new features.
- `B` reliability primitives are now in `main`.
- `A` orchestration is the next product direction for `v0.2.0`.
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

## Active Work

Branch: `feature/v0.2-release-prep`

Scope:

- publish `v0.2.0` as the stable Homebrew release target;
- update Formula stable `url` and `sha256` to the `v0.2.0` archive;
- install `tmux-agent-dialogue` in stable Homebrew, not only `--HEAD`;
- update README and roadmap wording so they no longer describe merged features as active work;
- add a concise changelog entry for `v0.2.0`;
- keep all mainline changes going through PR.

Verification evidence:

- `v0.2.0` tag exists on commit `4e2fd0f`.
- remote tag object `0506f731eee6978d7188293ed9bd1e47e4a5cf17` peels to commit `4e2fd0f`.
- `v0.2.0` archive SHA-256 is `a9c5aab558ee306727215feb7a5146aa50132360a00e7a9a6c4d7c5627962a55`.
- `zsh -n` passes for all wrapper scripts and `tmux-agent-dialogue`.
- `ruby -c Formula/tmux-agent-tools.rb`, `brew style Formula/tmux-agent-tools.rb`, and tap-name `brew audit --strict --online` pass.
- Local tap branch install proves stable `0.2.0` installs `/opt/homebrew/bin/tmux-agent-dialogue`.
- Remaining check for this branch: PR CI.

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
