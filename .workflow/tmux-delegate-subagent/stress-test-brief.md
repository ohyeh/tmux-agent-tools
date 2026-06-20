# STRESS TEST: can the supervision fallback be bypassed by a non-compliant/malicious worker?

Repo: /Users/paul.yeh/github/tmux-agent-tools. Goal: prove the SKILL.md supervision
contract (status --json / result --json --wait / result wait-required / ping / watch,
all bounded) cannot be made to hang forever or to accept stale/garbage as "done".

Build a real harness `scripts/test-supervision-stress-smoke` (zsh, follow existing
test-*-smoke style; source-only-safe; uses real tmux via the bundled agent-tmux).
For each adversarial worker behaviour, START a real tmux session running a FAKE shell
script (NOT a real CLI — use a zsh -c payload), then run the documented supervision
command with a SHORT timeout and ASSERT the wrapper returns within the bound with the
correct exit code / JSON, never hanging. Use small timeouts (1-5s) so the whole smoke
runs in well under a minute. Bound the whole script under a perl/SIGALRM watchdog so a
real hang fails the test instead of blocking CI.

Adversarial cases (each must be bounded + correctly classified):
1. **Never emits marker** — payload sleeps silently. `wait-text --literal MARK --timeout 2`
   must exit non-zero (timeout), not hang.
2. **Emits a STALE/echoed marker** — payload prints `[DONE]` immediately then keeps running
   without doing work. Show that a raw wait would be fooled, but `send-wait` with a fresh
   nonce is NOT (nonce never printed → bounded timeout). Assert nonce path times out.
3. **Exits without writing result.json** — payload exits 0, writes nothing.
   `result wait-required <n> --fields status,summary --wait 2 --json` must exit 1 with
   `timeout:true` and non-empty `missing_fields`; `status --json` must show running:false.
4. **Writes MALFORMED / contract-invalid result.json** — payload writes `{"status":` garbage
   or a schema-invalid file. `result validate <n> --json` must exit 2 with `valid:false`
   and non-empty `errors[]` (NOT exit 0).
5. **Alive but unresponsive (stall)** — payload ignores stdin and spins. `ping --json
   --timeout 2` must report non-responsive / time out within the bound; assert bounded.

Each case: assert (a) command returned within ~timeout+slack, (b) exit code matches the
contract, (c) JSON fields match. Print one PASS/FAIL line per case + a final summary.
Clean up every tmux session you create (stop <n>).

**Run every case across BOTH presets to prove the contract is CLI-agnostic:**
`codex` (heuristic_family=codex) AND `agy` (the user's ~/.config agy profile resolves
`bin=agy-local`, heuristic_family=claude). The adversarial payloads stay fake zsh -c (we
test the SUPERVISION layer, not the real CLI), but driving them through both
`agent-tmux codex …` and `agent-tmux agy …` exercises both completion-heuristic families
on the same bounded-fallback path. Verify `agent-tmux agy doctor --json` reports ok before
the agy cases (skip+log agy cases only if agy-local is absent — never fail the whole
smoke just because the optional agy binary is missing on a CI box).

After it passes, also run: scripts/ci-shellcheck; scripts/test-help-smoke.
If any case reveals the docs PROMISE something the runtime does NOT deliver (a real
bypass), STOP and report it as a FINDING with the exact gap — do not paper over it.
Reply [STRESS-DONE] with per-case PASS/FAIL, any FINDING, and whether you committed the
new smoke (commit it if green; no push).
