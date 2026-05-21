# Troubleshooting

The failures you'll actually hit, ordered roughly by frequency.

## `wait-text` times out but the pane clearly has the text

The marker contains a regex metacharacter (`[`, `]`, `(`, `)`, `.`, `*`, `?`, `+`, `|`). `wait-text` is regex by default. Switch to:

```bash
codex-tmux wait-literal worker '[CODEX-01]' 180
# or:
codex-tmux wait-text --literal worker '[CODEX-01]' 180
```

Use regex `wait-text` only when you actually want regex matching.

## `wait-literal` returns immediately on the first call

Stale marker from a previous turn — the pane scrollback already contains an old occurrence. Use `send-wait-literal` instead, which waits for a *new* occurrence relative to the send:

```bash
codex-tmux send-wait-literal worker 'Next step.' '[CODEX-02]' 180
```

## `status --json` says `running:true` but no visible progress

The agent CLI is sitting on a permission / first-run confirmation prompt. Check the `diagnostic` field — `confirmation_detected` means the wrapper saw a prompt shape. Attach to the session and answer:

```bash
codex-tmux attach worker
# answer the prompt
# Ctrl+B, D to detach
```

The wrapper deliberately does not auto-accept permission prompts.

## `--on-exit` hook never logged

`--on-exit` requires `--sentinel`. Add it:

```bash
codex-tmux start --exact w ~/repo \
  --sentinel /tmp/w.exit \
  --on-exit 'echo done >> /tmp/w.log' \
  '...'
```

`--on-exit` without `--sentinel` is silently ignored — by design, but easy to miss.

## `result.json` is missing after the agent said it was done

The agent never wrote `$TMUX_AGENT_RESULT`. Re-prompt explicitly:

> Write `$TMUX_AGENT_RESULT` before signaling done. Schema: `{"schema_version":1,"status":"ok|blocked|error","summary":"…","artifacts":[],"errors":[]}`.

Agents forget this constraint unless it's stated in the prompt. The prompt is the contract.

## Pane shows the exit-code marker but the session lingers

Normal. The wrapper keeps the pane open after the CLI exits so failures stay capturable. Clean up with:

```bash
codex-tmux stop worker
```

`status --json` reports `running:false` and `exit_detected:true` for this state.

## Multiline prompt sits in the input box without submitting

The submit timing is too tight for your environment. Raise the delay:

```bash
CODEX_TMUX_SUBMIT_DELAY=0.5 codex-tmux start --exact w ~/repo '...'
# or, for the Claude wrapper:
CLAUDE_TMUX_SUBMIT_DELAY=0.5 claude-tmux start --exact w ~/repo '...'
```

Default is 0.2s.

## `--secret op://...` exits with code 4

The 1Password CLI (`op`) isn't on the wrapper's `PATH`. Install it (`brew install --cask 1password-cli`) and re-authenticate (`op signin`). The preflight is intentional: a half-configured session would be worse than failing fast.

Same pattern for `keychain:` → install `security` (macOS only).

## Audit `verify` fails after rotation

You ran a non-locked write directly into the JSONL file. The audit chain uses an advisory lock — bypassing it is the supported way to corrupt the chain. Use `tmux-agent-audit rotate` for rotation; never `mv audit.jsonl audit.jsonl.1` by hand.

## Two `start --exact same-name` killed the first session

By design — single-caller invariant. Wrapper state under `$TMUX_AGENT_DIR/<name>/` is not lock-protected. Use different agent names for parallel work, or use `tmux-agent-fanout` which handles naming for you.

## Fanout hangs for ~10 minutes when one wrapper binary is missing

This was a real bug — fixed in `v0.11.0`. If you still see it, you're on `v0.10.0` or older. Upgrade.

## I changed `local path=...` to `local wt_path=...` and now something else breaks

`path`, `status`, `lines` in zsh are tied to uppercase env vars. `local path=x` clobbers `$PATH` inside the function scope. The renaming convention used in this repo:

- `path` → `wt_path` / `target_path` / context-specific name
- `status` → `check_status` / `task_status`
- `lines` → `out_lines` / `pane_lines`

CI lint at `scripts/lint-no-path-tied-locals` enforces this. If your lint passes but `$PATH` still breaks, you may have hit the multi-name `local` form (`local path agent foo`). [Issue #196](https://github.com/ohyeh/tmux-agent-tools/issues/196) tracks widening the lint.

## doctor says everything is fine but the wrapper still misbehaves

Run `self-test`:

```bash
codex-tmux self-test
```

It exercises tmux capture/wait without spawning a real agent. Failures there point at tmux config, not your prompt.

## Still stuck

- Read `skills/tmux-agent-tools/SKILL.md` in the repo — it carries the canonical command reference.
- File a repro at https://github.com/ohyeh/tmux-agent-tools/issues with: command line, expected output, actual output, `doctor` + `self-test` output.
