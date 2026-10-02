Pane captures for `agent-tmux <cli> composer-state` (collector.contract.node.ts).

- `codex-*.txt`, `cursor-agent-*.txt`: real `capture-pane -J -p` screens from the R7.4 live run
  (`.workflow/202610011947-tui-closure/r74-paste/<host>/<state>/01-before.txt`). cursor-agent has no
  permission capture: its `permission` cell could not be produced without changing user-global config,
  so an unrecognised dialog reads `unknown` (never pastes).
- `*.synthetic.txt`: hand-written, UNCONFIRMED against the real CLI (claude has no live capture;
  the shell prompt is a plain zsh prompt).
- `agy-*.txt`: real `capture-pane -J -p` screens of Antigravity CLI 1.2.14, captured 2026-10-02 in a
  trusted folder with the real HOME (account email and project path redacted). `agy-permission.txt` is
  the trust-folder menu; agy runs tools with no prompt when `toolPermission` is `always-proceed`.
- `fake-cursor.mjs`: a stand-in composer for the delivery tests.
