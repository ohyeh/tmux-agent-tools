# Custom CLIs and profiles

Read this when adding a new CLI, renaming a binary, or fixing busy/approval detection for a non-default CLI.

`agent-tmux <cli>` works for any binary out of the box: unknown CLI names get generic defaults (binary = the CLI name, generic-family heuristics, no provider-key inheritance, no `--yolo`, result-path-via-prompt on, no launch flags). Profiles are the canonical per-CLI configuration: the bundled `scripts/profiles/` directory ships the defaults for claude/codex/agy/cursor/grok (the in-script preset table is a frozen legacy fallback), and new CLIs are added as profiles, not code. To customize, write a declarative profile at `~/.config/agent-tmux/profiles/<cli>.conf`, set `AGENT_TMUX_PROFILE_DIR`, or pass it at use time: `agent-tmux <cli> --profile-dir <your-managed-dir> …` / `--profile <file>`. Profiles are plain `key=value` files — never sourced, so they cannot execute code. Precedence: env vars (`<NS>_TMUX_*` > `AGENT_TMUX_*`) > `--profile`/`--profile-dir` > `$AGENT_TMUX_PROFILE_DIR` > user config dir > bundled defaults > legacy preset.

Migration note: unlisted CLIs now use `generic` instead of Codex-family behavior. If a custom CLI intentionally needs Codex/OpenAI provider-key inheritance or `--yolo`, set those explicitly in its profile.

Profile contract keys that affect safety and structured results:

- `approval=prompt|auto` controls the profile approval mode; read the active value from `agent-tmux <cli> doctor --json`.
- `result_required_fields=status,summary,...` becomes the default field list for `result wait-required` when `--fields` is omitted; explicit `--fields` still wins.
- `session_id_pattern=<label-anchored ERE>` enables v2 `cli_session_id` capture. Leave it unset unless the CLI's session-label line is verified for that version.

Use `agent-tmux <cli> setup` as the JSON preflight (`doctor --json` + `self-test`). Use `agent-tmux <cli> start --dry-run ...` to inspect the resolved invocation/profile without creating a tmux session.

`start --model <m>` pins a worker's model for that run (passed through as `--model <m>`; not validated per-CLI, since `ANTHROPIC_MODEL`/env are unreliable). For a durable per-CLI default set `launch_flags` in the profile instead.

```ini
# ~/.config/agent-tmux/profiles/gemini.conf
bin=gemini
env_ns=GEMINI
launch_flags=
resume_keyword=resume
heuristic_family=generic
# Optional detection overrides (extended regex, case-insensitive):
pattern_busy=(thinking|generating|esc to cancel)
pattern_approval_prompt=allow this (command|action)\?
approval=prompt
result_required_fields=status,summary
# session_id_pattern=Session ID:
```

Common cases:

- **Same CLI, different binary name per machine** (e.g. `agy` installed as `agy-local`): a one-line profile `bin=agy-local` — no code change, no env var to remember.
- **Brand-new CLI**: write the profile, then `agent-tmux gemini start --exact worker ~/repo 'prompt'`. All subcommands (`send`, `wait*`, `status`, `result`, approval gates) work identically.
- **Detection mismatch**: if `status`/`probe` misreads the new CLI's busy/approval output, set `pattern_busy` / `pattern_permission_prompt` / `pattern_approval_prompt` / `pattern_login_prompt`.

`agent-tmux <cli> doctor` shows which profile file was loaded (`profile: <path>` or `<none>`). Supported keys: see `scripts/profiles/README.md`.
