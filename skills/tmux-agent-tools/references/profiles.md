# Custom CLIs and profiles

Read this when adding a new CLI, renaming a binary, or fixing busy/approval detection for a non-default CLI.

`agent-tmux <cli>` works for any binary out of the box: unknown CLI names get generic defaults (binary = the CLI name, generic-family heuristics, no provider-key inheritance, no `--yolo`, result-path-via-prompt on, no launch flags). Profiles are the canonical per-CLI configuration: the bundled `scripts/profiles/` directory ships the defaults for claude/codex/agy/cursor/grok (the in-script preset table is a frozen legacy fallback), and new CLIs are added as profiles, not code. To customize, write a declarative profile at `~/.config/agent-tmux/profiles/<cli>.conf`, set `AGENT_TMUX_PROFILE_DIR`, or pass it at use time: `agent-tmux <cli> --profile-dir <your-managed-dir> …` / `--profile <file>`. Profiles are plain `key=value` files — never sourced, so they cannot execute code. Precedence: env vars (`<NS>_TMUX_*` > `AGENT_TMUX_*`) > `--profile`/`--profile-dir` > `$AGENT_TMUX_PROFILE_DIR` > user config dir > bundled defaults > legacy preset.

Migration note: unlisted CLIs now use `generic` instead of Codex-family behavior. If a custom CLI intentionally needs Codex/OpenAI provider-key inheritance or `--yolo`, set those explicitly in its profile.

Profile contract keys that affect safety and structured results:

- `approval=prompt|auto` controls the profile approval mode; read the active value from `agent-tmux <cli> doctor --json`.
- `result_required_fields=status,summary,...` becomes the default field list for `result wait-required` when `--fields` is omitted; explicit `--fields` still wins.
- `session_id_pattern=<label-anchored ERE>` enables v2 `cli_session_id` capture. Leave it unset unless the CLI's session-label line is verified for that version.
- `prompt_delivery=paste|file-ref` picks how `assign` hands over the task body. `paste` (default) bracketed-pastes the whole prompt. `file-ref` composes scope-guard + result-path + body into `$TMUX_AGENT_DIR/<name>/prompt.md` and sends ONE line naming that file, for TUIs that submit on every newline — agy turned one pasted prompt into 12 separate inputs on 2026-09-08 and never received its `GOAL`/`CONTEXT` at all, so `agy.conf` ships `file-ref`. Override per dispatch with `assign --prompt-delivery`. A same-named profile under `~/.config/agent-tmux/profiles` (or `$AGENT_TMUX_PROFILE_DIR`) shadows the bundled one entirely — keys are not merged — so a host that has its own `agy.conf` keeps pasting until `prompt_delivery=file-ref` is added there too.
- `preflight_flags=<argv>` is the launch probe `preflight` and `assign` step 0 run before starting a session (default `--version`; empty disables the check). It must be side-effect-free and must exit — a probe that paints a TUI instead is reported as "did not exit", not as a blocked CLI.
- `effort_flags=<template>` enables `start --effort <v>` for profiles that support it; `%s` is replaced by the shell-quoted value, and profiles without it reject `--effort` with exit 2.

Use `agent-tmux <cli> setup` as the JSON preflight (`doctor --json` + `self-test`). Use `agent-tmux <cli> start --dry-run ...` to inspect the resolved invocation/profile without creating a tmux session.

`start --model <m>` pins a worker's model for that run (passed through as `--model <m>`; not validated per-CLI, since `ANTHROPIC_MODEL`/env are unreliable). `start --effort <v>` expands the profile's `effort_flags` template; Codex uses `-c model_reasoning_effort=%s`. For a durable per-CLI default set `launch_flags` in the profile instead.

`<NS>_TMUX_LAUNCH_FLAGS` / `AGENT_TMUX_LAUNCH_FLAGS` replace profile `launch_flags` wholesale. `<NS>_TMUX_EXTRA_LAUNCH_FLAGS` / `AGENT_TMUX_EXTRA_LAUNCH_FLAGS` append after the effective launch flags, so callers can add one option without restating profile defaults. Both are operator-controlled raw shell fragments executed by the pane shell (same trust class as profile `launch_flags`), not a sanitized argv API — never populate them from untrusted input.

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
