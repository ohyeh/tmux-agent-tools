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
- Release tag: `v0.1.0`
- Release URL: `https://github.com/ohyeh/tmux-agent-tools/releases/tag/v0.1.0`
- Current main includes CI smoke checks and Node 24 checkout action updates.
- Verified commands: `start`, `start-ssh`, `send`, `wait`, `wait-text`, `wait-literal`, `capture`, `list`, `status`, `doctor`, `self-test`, `stop`
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

## Active Work

Branch: `feature/v0.2-roadmap`

Scope:

- document `v0.2.0` direction;
- define the first orchestration feature branch;
- add marker-wait ergonomics needed before orchestration;
- add Claude readiness diagnostics without auto-accepting first-run prompts.

Verification evidence:

- `zsh -n` passes for both wrapper scripts.
- Skill validation passes for `skills/tmux-agent-tools`.
- `ruby -c Formula/tmux-agent-tools.rb` passes.
- Branch-local `doctor` and `self-test` pass for both wrappers.
- `wait-text --literal` and `wait-literal` both match special-character markers for Codex and Claude wrapper sessions.

Next implementation branch:

- `feature/dialogue-runner`

## v0.2.0 Candidate Scope

P0:

- `wait-text --literal` alias for exact marker waits;
- Claude first-run/permission confirmation diagnostics in `status`;
- `dialogue` runner for bounded Codex/Claude ping-pong using existing wrappers;
- transcript file output with timestamps, speaker, marker, and captured text;
- cleanup guarantees for both sessions on success/failure;
- local-only operation by default.

P1:

- `pair-review` preset: one agent proposes, the other reviews, final transcript saved;
- `--turns`, `--timeout`, `--workdir`, `--agent-a`, `--agent-b`, `--prompt-file`;
- machine-readable JSONL transcript.

P2:

- remote participant support through `start-ssh`;
- GitHub PR comment helper that posts transcript summaries only when explicitly requested;
- credential-free CI integration tests with fake participants;
- real-agent/token tests only as manual release evidence or explicit opt-in workflows.

Do not do:

- personal OpenClaw/Mac mini shortcuts in core;
- hidden external side effects;
- default real-agent orchestration in CI;
- destructive cleanup outside owned tmux sessions.
