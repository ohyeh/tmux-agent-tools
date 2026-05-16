class TmuxAgentTools < Formula
  desc "Tmux wrappers for controllable Claude Code and Codex CLI sessions"
  homepage "https://github.com/ohyeh/tmux-agent-tools"
  url "https://github.com/ohyeh/tmux-agent-tools/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "a9c5aab558ee306727215feb7a5146aa50132360a00e7a9a6c4d7c5627962a55"
  head "https://github.com/ohyeh/tmux-agent-tools.git", branch: "main"

  depends_on "jq"
  depends_on "tmux"
  on_linux do
    depends_on "zsh"
  end

  def install
    bin.install "skills/tmux-agent-tools/scripts/claude-tmux"
    bin.install "skills/tmux-agent-tools/scripts/codex-tmux"
    bin.install "skills/tmux-agent-tools/scripts/tmux-agent-dialogue"
    bin.install "skills/tmux-agent-tools/scripts/tmux-agent-sessions" if build.head?
    pkgshare.install "skills"
  end

  test do
    assert_match "claude-tmux - run Claude Code in tmux", shell_output("#{bin}/claude-tmux help")
    assert_match "codex-tmux - run Codex CLI in tmux", shell_output("#{bin}/codex-tmux help")
    assert_match "tmux-agent-dialogue - run a bounded two-agent tmux dialogue",
                 shell_output("#{bin}/tmux-agent-dialogue help")
    if build.head?
      assert_match "tmux-agent-sessions - inspect and clean up tmux-agent-tools sessions",
                   shell_output("#{bin}/tmux-agent-sessions help")
    end

    transcript = testpath/"transcript.jsonl"
    transcript.write <<~JSONL
      {"event":"turn","turn":1,"speaker":"agent-a","agent":"fake","timestamp":"2026-05-16T00:00:00Z","marker":"[DONE]","text":"fake-a: ok"}
    JSONL
    assert_match "tmux-agent-tools pair-review",
                 shell_output("#{bin}/tmux-agent-dialogue summarize --transcript #{transcript}")
  end
end
