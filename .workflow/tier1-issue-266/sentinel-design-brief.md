# Design debate: standardize the codex-sandbox result-path gotcha

Repo: /Users/paul.yeh/github/tmux-agent-tools (branch tier1-issue-266). Review only — no code changes, no push.

## Problem (verify against real code first)
The wrapper injects the result path into the worker pane via `tmux new-session -e TMUX_AGENT_RESULT=$result_path` (skills/tmux-agent-tools/scripts/agent-tmux:2472) and TMUX_AGENT_NAME. claude/fake workers read it; **codex's sandbox does NOT propagate pane env vars into the codex process**, so a codex worker cannot learn where to write result.json — and since non-exact names get a random suffix, it cannot derive the path either. Today the only fix is manually pasting the literal path into the codex prompt. No env-independent fallback exists in code.

Result path is deterministic: `$(agent_root_dir)/<name>/result.json`, agent_root_dir = ${TMUX_AGENT_DIR:-$XDG_STATE_HOME/.local/state/tmux-agent-tools} (agent-tmux:1227-1228).

## Two candidate fixes (both reuse the already-computed `result_path`)
- **A. cwd sentinel file**: at start, wrapper writes `<workdir>/.tmux-agent-result` containing result_path. Worker (any CLI) reads it from cwd — cwd survives the sandbox. CLI-agnostic, no prompt pollution.
- **B. auto prompt template**: when cli==codex, wrapper prepends "Your result path: <path>" to the initial prompt. Codex-only, pollutes prompt, may be lost on resume.

## Your job — adversarial design review
1. Confirm/deny the diagnosis against the actual code (does codex really not see -e env? cite where the env is set and any place a worker reads it, e.g. agent-tmux:5491).
2. **Edge cases I want you to stress** — especially: multiple workers sharing the SAME workdir would clobber a single `.tmux-agent-result` (collision). Does that kill option A? Mitigations? (e.g. write into a per-agent state dir the worker can find another way, gitignore concerns, --workdir-fresh, start-ssh remote cwd, resume path.)
3. Is there a THIRD option better than A/B? (e.g. a `agent-tmux self result-path` command the worker runs — but that also needs the name; does cwd or some stable anchor solve it?)
4. Pick a recommendation. Give minimal interface, exact landing points, self-check idea, and what stays out of scope.
5. Should this be sequenced BEFORE the quorum/watch-count packet (it's a correctness papercut hit every time codex participates) or is it independent?

Write verdict JSON to EXACT path:
/Users/paul.yeh/github/tmux-agent-tools/.workflow/tier1-issue-266/sentinel-design-result.json
Shape: {"diagnosis":"confirmed|partial|wrong","recommended_option":"A|B|C-<name>","collision_verdict":"...","blocking_concerns":[...],"minimal_interface":"...","landing_points":[...],"selfcheck":"...","sequence":"before_quorum|after|independent","out_of_scope":[...],"notes":"..."}
Then say DONE_SENTINEL.
