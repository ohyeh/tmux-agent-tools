export type Tmux = {
  /** Workers this mod dispatched that are still inside the reconcile window and unreported. */
  outstanding: () => Promise<readonly TmuxDispatch[]>
  /** Scan now instead of waiting for the next tick; wakes the session for each terminal worker. */
  reconcile: () => Promise<void>
  /**
   * Workers that are alive but whose pane has stopped changing — an observation.
   * Only an entry with `evidence` is confirmed stuck. Nothing is killed.
   */
  stalled: () => Promise<readonly TmuxStalled[]>
}

export type TmuxStalled = {
  /** The worker itself, so a caller never has to split the id back apart. */
  dispatch: TmuxDispatch
  /** Seconds since the worker's pane last changed, as `agent-tmux status` measures it. */
  idleSeconds: number
  /** The pane line that shows a blocker (quota, rate limit, login, error). Absent = quiet, not confirmed stuck. */
  evidence?: string
}

export type TmuxDispatch = {
  profile: string
  name: string
  /** Absolute working directory the worker was given. */
  dir: string
  /** ms since epoch when the brief was dispatched. */
  since: number
  /** The brief's GOAL line, for a one-line row. Absent on records written before it existed. */
  goal?: string
  /**
   * The id of the session that dispatched it (`$.session.id()`). A collector
   * delivers, lists, tells and stops its own; another session's only once that
   * session stops heartbeating. A record without one is anyone's.
   */
  owner?: string
  /** The owning session's cwd: an orphan is adopted only by a collector in the same cwd. */
  ownerCwd?: string
  /** Set when a collector claimed this worker from a session that stopped heartbeating: that session's id. */
  adoptedFrom?: string
}

declare module 'claude-code' {
  interface EngineInterface {
    tmux: Tmux
  }
}
