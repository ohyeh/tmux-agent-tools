class TmuxAgentTools < Formula
  desc "Tmux wrappers for controllable Claude Code and Codex CLI sessions"
  homepage "https://github.com/ohyeh/tmux-agent-tools"
  head "https://github.com/ohyeh/tmux-agent-tools.git", branch: "main"

  depends_on "tmux"
  on_linux do
    depends_on "zsh"
  end

  def install
    bin.install "skills/tmux-agent-tools/scripts/claude-tmux"
    bin.install "skills/tmux-agent-tools/scripts/codex-tmux"
    pkgshare.install "skills"
  end

  test do
    assert_match "claude-tmux - run Claude Code in tmux", shell_output("#{bin}/claude-tmux help")
    assert_match "codex-tmux - run Codex CLI in tmux", shell_output("#{bin}/codex-tmux help")
  end
end
