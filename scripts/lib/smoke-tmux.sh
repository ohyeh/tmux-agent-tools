# Sourced before a smoke creates files or starts tmux. Works in zsh and bash.
# A runner owns TAS_JOB_DIR; a direct run owns a short private directory.
unset TMUX TMUX_PANE
SMOKE_TMUX_BIN="$(command -v tmux)"
SMOKE_OWN_DIR=0
if [ -n "${TAS_JOB_DIR:-}" ]; then
  export TMUX_TMPDIR="$TAS_JOB_DIR"
else
  export TMUX_TMPDIR="$(mktemp -d /tmp/tas-solo.XXXXXX)"
  SMOKE_OWN_DIR=1
fi
export TMPDIR="$TMUX_TMPDIR/tmp"
mkdir -p -m 0700 "$TMUX_TMPDIR/tmux-$(id -u)" "$TMPDIR"
SMOKE_SOCKETS=("$TMUX_TMPDIR/tmux-$(id -u)/default")

# Call directly, then read REPLY: a command substitution loses registration.
smoke_socket() {
  REPLY="$TMUX_TMPDIR/tmux-$(id -u)/$1"
  SMOKE_SOCKETS+=("$REPLY")
}

smoke_cleanup() {
  local s
  for s in "${SMOKE_SOCKETS[@]}"; do
    env -u TMUX -u TMUX_PANE "$SMOKE_TMUX_BIN" -S "$s" kill-server 2>/dev/null || true
  done
  # Node contracts can create more sockets in TMPDIR beneath this directory.
  if [ -d "$TMUX_TMPDIR" ]; then
    while IFS= read -r s; do
      env -u TMUX -u TMUX_PANE "$SMOKE_TMUX_BIN" -S "$s" kill-server 2>/dev/null || true
    done < <(find "$TMUX_TMPDIR" -type s)
  fi
  if [ "$SMOKE_OWN_DIR" = 1 ]; then rm -rf "$TMUX_TMPDIR"; fi
}

if [ -n "${ZSH_VERSION:-}" ]; then
  autoload -Uz add-zsh-hook
  add-zsh-hook zshexit smoke_cleanup
  # zsh 5.9.2 (measured): when errexit fires on a failing function call, the shell exits
  # without its EXIT trap or zshexit hooks, so an aborted smoke leaked its tmux server
  # (and a relay on 7717). ZERR still runs there: leave through a real exit, which runs
  # both. Only the main shell: a subshell's errexit stays its own.
  zmodload zsh/system
  SMOKE_MAIN_PID=$sysparams[pid]
  _smoke_errexit() {
    local rc=$?
    [[ -o errexit && $sysparams[pid] == "$SMOKE_MAIN_PID" ]] || return 0
    unsetopt errexit
    exit $rc
  }
  trap _smoke_errexit ZERR
else
  trap smoke_cleanup EXIT
fi
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
