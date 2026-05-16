# tmux-agent-tools Task Plan

## Goal

Ship the verified tmux-agent-tools MVP as `v0.1.0`, then prepare the next reliability-focused development branch.

## Success Criteria

- `v0.1.0` tag exists on the verified MVP commit.
- Homebrew formula supports stable install without `--HEAD`.
- `brew install tmux-agent-tools` succeeds from the tap.
- `npx skills add ohyeh/tmux-agent-tools --skill tmux-agent-tools` can discover the skill.
- True Codex/Claude tmux communication remains verified.
- Next branch exists for reliability primitives work.

## Current State

- Repo: `ohyeh/tmux-agent-tools`
- Current verified MVP commit: `64af8c0 Add wait-text and skill usage guidance`
- Verified commands: `start`, `start-ssh`, `send`, `wait`, `wait-text`, `capture`, `list`, `status`, `stop`
- Verified install surfaces: `skills.sh`, Homebrew `--HEAD`, VM `install-bin`
- Verified runtime: real Codex/Claude start-send-wait-capture-stop and 10-run ping-pong

## Decisions

- Release discipline comes before new features.
- `B` reliability primitives are the next branch after `v0.1.0`.
- `A` orchestration depends on reliability primitives.
- `D` personal workflow shortcuts should stay outside public core unless generalized.

## Active Work

1. Tag verified MVP as `v0.1.0`. Done.
2. Compute GitHub source archive SHA-256. Done.
3. Update Formula for stable `url` + `sha256`. Done.
4. Update README install instructions. Done.
5. Verify stable Homebrew install. Pending.
6. Verify skills.sh discovery. Pending.
7. Create/push reliability branch. Pending.

## Next Branch Scope

Branch: `feature/reliability-primitives`

Candidate work:

- `wait-literal` or `wait-text --literal`
- `doctor`
- `self-test`
- session metadata/structured status
- better Claude first-run confirmation handling
- local hold-on-exit diagnostics
