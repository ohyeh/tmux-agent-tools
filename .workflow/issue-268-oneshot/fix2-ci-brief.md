# Fix brief — `--dry-run` must not require the CLI binary (pre-existing CI failure on main)

Repo `/Users/paul.yeh/github/tmux-agent-tools`, branch `feat/v3-sessionid-268-oneshot`. Fix ONE pre-existing
bug that makes CI red on `main` too. Surgical. DO NOT commit. result.json + marker. No tmux sessions. fd/rg/jq only.

## Root cause (confirmed by brain)
`start_session()` calls `require_bins` as its FIRST line (agent-tmux ~2819), BEFORE the `--dry-run` flag is
parsed (the `dry_run=1` while-loop is ~2825-2838). `require_bins` (def ~565) does a hard `exit 1` when
`$CLI_BIN` is not executable. So `agent-tmux <cli> start --dry-run ...` ABORTS with exit 1 (empty stdout) on
any machine without the real CLI installed. GitHub CI runners have no `codex`/`claude`, so the wrapper
self-test `self_test_dry_run` gets empty output → `self-test dry-run: FAIL (invocation.session missing in
output)`. This has been failing CI on `main` for many commits (verified: run 27881784183 on 7c37057 fails the
same assertion). `--dry-run` is meant to preview WITHOUT the binary — `run_dry_run_checks` already reports
both tmux and the CLI as checks (`tmux_binary`, `agent_cli_binary`), so aborting beforehand is wrong.

## Fix (minimal, surgical)
Make the local `start` dry-run path NOT call `require_bins`:
- Remove the unconditional `require_bins` at the top of `start_session` (~line 2819).
- After the `--dry-run` parse while-loop sets `dry_run`, add a guarded call: `(( dry_run )) || require_bins`.
- Ensure nothing between the old call site and the new one needs `$CLI_BIN`/tmux (write_tmux_conf + flag
  parsing do not). Real (non-dry-run) `start` MUST still abort early when bins are missing — only dry-run skips.
Keep it to start_session. (If `resume_session` ~line 3178 has the same `require_bins`-before-`--dry-run` bug
AND supports `--dry-run`, apply the same guard there; if resume has no `--dry-run`, leave it untouched — state
which in your report.)

## Verify before returning
- Repro now fixed: with a NON-EXISTENT bin, dry-run emits JSON (not empty) and ok:false:
  `tmp=$(mktemp -d); printf 'bin=/nope/nocli\n' > "$tmp/n.conf";
   agent-tmux codex --profile "$tmp/n.conf" start --dry-run --exact p "$tmp" x | jq -e '.invocation.session and (.ok==false) and (.checks[]|select(.name=="agent_cli_binary").status=="fail")'`
  → must print true / exit 0 (previously: empty output, exit 1).
- Real start still guards bins: `agent-tmux codex --profile "$tmp/n.conf" start --exact p2 "$tmp" x` (NO
  --dry-run) still exits non-zero with the "not found" message (do this WITHOUT spawning a real session — the
  require_bins abort happens before tmux; safe).
- `zsh -n skills/tmux-agent-tools/scripts/agent-tmux` pass.
- `agent-tmux claude self-test` and `agent-tmux codex self-test` both end ok (dry-run subtest passes).
- `scripts/test-session-meta-smoke` 58/0; `scripts/test-oneshot-smoke` passes.
- Simulate CI (no CLI on PATH): `PATH=/usr/bin:/bin:/usr/sbin:/sbin JQ=$(command -v jq) TMUX=$(command -v tmux) skills/tmux-agent-tools/scripts/codex-tmux self-test` → dry-run subtest ok. (Adjust so jq/tmux still resolve but codex/claude do not.)

Ponytail: smallest diff. DO NOT commit. Return: files+lines, the moved/guarded call, all verify outputs,
confirmation the missing-bin dry-run now emits JSON, and whether resume_session needed the same fix.
