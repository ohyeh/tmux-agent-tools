# Changelog

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
