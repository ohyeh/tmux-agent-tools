class TmuxAgentTools < Formula
  desc "Tmux wrappers for controllable Claude Code and Codex CLI sessions"
  homepage "https://github.com/ohyeh/tmux-agent-tools"
  url "https://github.com/ohyeh/tmux-agent-tools/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "100b9ea658b3413c30404eb25ce6d7771ad946039dea61ccf7947b40afc12fa1"
  head "https://github.com/ohyeh/tmux-agent-tools.git", branch: "main"

  depends_on "tmux"
  on_linux do
    depends_on "zsh"
  end

  def install
    bin.install "skills/tmux-agent-tools/scripts/claude-tmux"
    bin.install "skills/tmux-agent-tools/scripts/codex-tmux"
    bin.install "skills/tmux-agent-tools/scripts/tmux-agent-dialogue" if build.head?
    pkgshare.install "skills"
  end

  test do
    assert_match "claude-tmux - run Claude Code in tmux", shell_output("#{bin}/claude-tmux help")
    assert_match "codex-tmux - run Codex CLI in tmux", shell_output("#{bin}/codex-tmux help")
    if build.head?
      assert_match "tmux-agent-dialogue - run a bounded two-agent tmux dialogue",
                   shell_output("#{bin}/tmux-agent-dialogue help")
    end
  end
end
