# agent-tmux CLI profiles

Declarative per-CLI profiles. **This directory is the canonical source of
per-CLI defaults**: `claude.conf`, `codex.conf`, `agy.conf`, `cursor.conf`,
and `grok.conf` mirror the legacy in-script preset table, which is frozen and
only acts as a fallback when this directory is missing. New CLIs are added as
profiles, not as code.

`agent-tmux <cli> ...` looks for `<cli>.conf` in:

1. `--profile-dir <dir>` (use-time flag, e.g. a user-managed profile repo)
2. `$AGENT_TMUX_PROFILE_DIR`
3. `~/.config/agent-tmux/profiles` (or `$XDG_CONFIG_HOME/agent-tmux/profiles`)
4. this directory (bundled defaults)

`agent-tmux <cli> --profile <file> ...` bypasses the search and loads that
exact file. The first match wins and overrides the built-in preset for that
CLI.
Files are plain `key=value` (never sourced, so they cannot execute code).
Env vars (`<NS>_TMUX_*`, `AGENT_TMUX_*`, bare `<NS>` binary override) still
take precedence over profile values.

## Supported keys

| Key | Meaning | Example |
| --- | --- | --- |
| `bin` | binary name or absolute path | `bin=agy-local` |
| `env_ns` | env namespace (uppercased) | `env_ns=GEMINI` |
| `prefix` | tmux session prefix | `prefix=gemini-cli` |
| `launch_flags` | flags appended at launch | `launch_flags=--yolo` |
| `resume_keyword` | resume subcommand/flag | `resume_keyword=--resume` |
| `heuristic_family` | `claude` or `codex` pane-heuristic baseline | `heuristic_family=codex` |
| `usage_kind` | usage text label | `usage_kind=CLI` |
| `pattern_busy` | ERE overriding busy detection (`active_spinner`/`tool_active`) | `pattern_busy=(thinking\|generating)` |
| `pattern_permission_prompt` | ERE matched (case-insensitive) against pane text → `permission_prompt` | |
| `pattern_approval_prompt` | ERE → `approval_prompt` | |
| `pattern_login_prompt` | ERE → `login_prompt` | |

## Examples

Use a differently named binary on this machine only
(`~/.config/agent-tmux/profiles/agy.conf`):

```
bin=agy-local
```

Add a brand-new CLI without touching code
(`~/.config/agent-tmux/profiles/gemini.conf`), then run
`agent-tmux gemini start ...`:

```
bin=gemini
env_ns=GEMINI
launch_flags=--yolo
resume_keyword=resume
heuristic_family=codex
pattern_approval_prompt=allow this action\?
```
