Pane captures for `agent-tmux <cli> composer-state` (collector.contract.node.ts).

- `codex-*.txt`, `cursor-agent-*.txt`: real `capture-pane -J -p` screens from the R7.4 live run
  (`.workflow/202610011947-tui-closure/r74-paste/<host>/<state>/01-before.txt`). cursor-agent has no
  permission capture: its `permission` cell could not be produced without changing user-global config,
  so an unrecognised dialog reads `unknown` (never pastes).
- `*.synthetic.txt`: hand-written, UNCONFIRMED against the real CLI (claude has no live capture;
  the shell prompt is a plain zsh prompt).
- agy: no capture exists (agy is never launched in tests), so its state is always `unknown`.
- `fake-cursor.mjs`: a stand-in composer for the delivery tests.
