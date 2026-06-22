class TmuxAgentTools < Formula
  desc "Tmux wrappers for controllable Claude Code and Codex CLI sessions"
  homepage "https://github.com/ohyeh/tmux-agent-tools"
  url "https://github.com/ohyeh/tmux-agent-tools/archive/refs/tags/v0.24.0.tar.gz"
  sha256 "87dadceb563dc8ae9ce4d3034a0b4880f2ec34ed82bf0b119441a803e7879ff0"
  head "https://github.com/ohyeh/tmux-agent-tools.git", branch: "main"

  depends_on "jq"
  depends_on "tmux"
  on_linux do
    depends_on "zsh"
  end

  def install
    bin.install "skills/tmux-agent-tools/scripts/agent-tmux"
    bin.install "skills/tmux-agent-tools/scripts/claude-tmux"
    bin.install "skills/tmux-agent-tools/scripts/codex-tmux"
    bin.install "skills/tmux-agent-tools/scripts/tmux-agent-dialogue"
    bin.install "skills/tmux-agent-tools/scripts/tmux-agent-sessions"
    bin.install "skills/tmux-agent-tools/scripts/tmux-agent-monitor"
    bin.install "skills/tmux-agent-tools/scripts/tmux-agent-fanout"
    bin.install "skills/tmux-agent-tools/scripts/tmux-agent-dag"
    bin.install "skills/tmux-agent-tools/scripts/tmux-agent-audit"
    bin.install "skills/tmux-agent-tools/scripts/tmux-agent-worktrees"
    bin.install "skills/tmux-agent-tools/scripts/tmux-agent-replay"
    pkgshare.install "skills"
    pkgshare.install "schemas"
  end

  test do
    assert_match "agent-tmux - run Claude Code in tmux", shell_output("#{bin}/claude-tmux help")
    assert_match "agent-tmux - run Claude Code in tmux", shell_output("#{bin}/codex-tmux help")
    assert_match "tmux-agent-dialogue - run a bounded two-agent tmux dialogue",
                 shell_output("#{bin}/tmux-agent-dialogue help")
    assert_match "tmux-agent-sessions - inspect and clean up tmux-agent-tools sessions",
                 shell_output("#{bin}/tmux-agent-sessions help")
    assert_match "tmux-agent-monitor - poll read-only evidence commands",
                 shell_output("#{bin}/tmux-agent-monitor --help")
    assert_match "tmux-agent-fanout - synchronous fan-out coordinator",
                 shell_output("#{bin}/tmux-agent-fanout --help")
    assert_match "tmux-agent-dag - DAG validator + synchronous topological executor",
                 shell_output("#{bin}/tmux-agent-dag --help")
    assert_match "Usage: tmux-agent-audit",
                 shell_output("#{bin}/tmux-agent-audit --help")
    assert_match "tmux-agent-worktrees — manage --workdir-fresh worktrees",
                 shell_output("#{bin}/tmux-agent-worktrees --help")
    assert_match "tmux-agent-replay - read-only utilities",
                 shell_output("#{bin}/tmux-agent-replay --help")

    transcript = testpath/"transcript.jsonl"
    transcript.write <<~JSONL
      {"event":"turn","turn":1,"speaker":"agent-a","agent":"fake","timestamp":"2026-05-16T00:00:00Z","marker":"[DONE]","text":"fake-a: ok"}
    JSONL
    assert_match(/tmux-agent-tools (pair-review|transcript)/,
                 shell_output("#{bin}/tmux-agent-dialogue summarize --transcript #{transcript}"))
  end
end
