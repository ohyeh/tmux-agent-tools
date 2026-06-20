# Release-prep + CI-fix brief (codex worker)

Repo `/Users/paul.yeh/github/tmux-agent-tools`, branch `feat/v3-sessionid-268-oneshot`. Do these 3 things.
DO NOT commit. Write result.json + unique marker. No tmux sessions. fd/rg/jq only. Ponytail: minimal diffs.

## 1. CI fix — wire the new smokes into CI (they currently never run)
`.github/workflows/ci.yml` runs zsh -n + ci-shellcheck + `*-tmux self-test` + metadata, but NOT the
`scripts/test-*-smoke` suite. Add a NEW step to the `smoke` job (after the "Run wrapper self-tests" step) that
runs BOTH fake-CLI smokes (deterministic, no real CLI, no network):
```
      - name: Run session-id + oneshot smokes
        run: |
          scripts/test-session-meta-smoke
          scripts/test-oneshot-smoke
```
Do the SAME in `.github/workflows/release.yml` (add to the `validate` job after its self-test step). Match the
existing YAML indentation/style exactly. Do not touch other steps. (Scope: only these two smokes — the broader
suite stays unwired this increment.)

## 2. CHANGELOG.md — new release section
Replace the empty `## Unreleased` with an empty `## Unreleased` followed by a new
`## v0.21.0 - 2026-06-21` section (keep the empty Unreleased line above it; match the existing v0.20.0 section
format — `### Added` / `### Changed`). Document, in user-facing terms:
- Added `exec_mode=oneshot` (#268): run any CLI headless once in-pane via one argv path — flag form
  (`prompt_flag=-p` → `cli -p "<prompt>"`) and subcommand form (`launch_flags=exec`, empty prompt_flag →
  `cli exec "<prompt>"`); prompt passed as a single shell-quoted argv; synthesizes result.json then prints
  marker `__AGENT_TMUX_ONESHOT_EXIT__<code>`; pane stays open; `status --json` reports exit_detected/exit_code.
  New profile keys `exec_mode`/`prompt_via`/`prompt_flag` (default interactive/paste/empty). Closes #268.
- Added `session_id_capture=off|supplied|transcript` (v3): claude supplies a race-free `--session-id` written
  to the sidecar before launch; codex/agy correlate a CLI-owned transcript/store after launch
  (null-on-ambiguity with one observable signal). Mutual-exclusion single writer. Default-off for all bundled
  profiles (off until per-CLI L-phase enablement).
- Changed: CI now runs `test-session-meta-smoke` and `test-oneshot-smoke`. Added `scripts/test-oneshot-smoke`
  (28 checks); `test-session-meta-smoke` expanded 27→58 (codex/agy correlation + decoy/ambiguity fixtures).

## 3. Formula bump
`Formula/tmux-agent-tools.rb`: bump the url tag `v0.20.0` → `v0.21.0` (line ~4). Leave sha256 as-is (the
release workflow recomputes it post-tag).

## Verify before returning
- `zsh -n skills/tmux-agent-tools/scripts/agent-tmux` pass (unchanged, sanity).
- `scripts/test-session-meta-smoke` 58/0; `scripts/test-oneshot-smoke` passes.
- YAML parses: `ruby -ryaml -e 'YAML.load_file(".github/workflows/ci.yml"); YAML.load_file(".github/workflows/release.yml"); puts "yaml ok"'`.
- CHANGELOG v0.21.0 section is matched by the release regex:
  `ruby -e 'c=File.read("CHANGELOG.md"); m=c.match(/^## v0\.21\.0(?:\s+-[^\n]*)?\n(?<body>.*?)(?=^## v|\z)/m); abort("no/empty v0.21.0 section") unless m && !m[:body].strip.empty?; puts "changelog ok"'`.

## Return (result.json + marker)
status, summary; artifacts: files+lines changed, the CI step added (both workflows), the CHANGELOG section,
the Formula line, and all verify outputs. ANY deviation w/ reason. DO NOT commit.
