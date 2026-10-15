# Contributing

For people writing patches against the repo. Outsiders welcome — small focused PRs are easy to review.

## Repo layout

```
tmux-agent-tools/
├── skills/tmux-agent-tools/
│   ├── SKILL.md                       # canonical command reference
│   └── scripts/
│       ├── agent-tmux                 # unified wrapper engine (agent-tmux <cli> <command>)
│       ├── tmux-agent-dialogue        # bounded two-agent dialogue
│       ├── tmux-agent-sessions        # cross-agent inventory
│       ├── tmux-agent-fanout          # parallel run across agents
│       ├── tmux-agent-dag             # dependency-ordered execution
│       ├── tmux-agent-audit           # hash-chained audit log surface
│       ├── tmux-agent-worktrees       # managed git-worktree lifecycle
│       ├── tmux-agent-replay          # transcript diff / redact
│       └── install-bin                # symlinks wrappers into ~/.local/bin
├── scripts/
│   ├── test-*-smoke                   # smoke runners (one per integration boundary)
│   ├── ci-shellcheck                  # syntax + shellcheck across all scripts
│   └── lint-no-path-tied-locals       # zsh tied-pair locals lint (smoke: test-smoke-lib-smoke)
├── schemas/                           # JSON schemas for stable surfaces
├── docs/                              # design docs (one per issue / batch)
└── CHANGELOG.md                       # release-by-release narrative
```

## Style ground rules

- **bash + zsh portable**. Wrappers are sourced by both. Test under zsh as well as bash before pushing.
- **zsh tied-pair locals are forbidden** — never `local path=...`, `local status=...`, `local lines=...`. Use `wt_path`, `check_status`, `out_lines`. CI fails the lint.
- **Every new JSON surface needs `schema_version: 1`**. Adding a versioning shim later breaks every consumer.
- **No hidden autonomy**. Synchronous, operator-explicit, no resident daemons or background supervisors.
- **Breaking changes are acceptable**. No compatibility aliases or deprecation periods: remove a feature in one change, together with its code, tests, and docs.

## Adding a feature: the loop

1. **Open an issue** describing the user-visible outcome and acceptance criteria. Acceptance criteria should be checkable from the merged diff.
2. **Branch** off `main`, conventional name: `feat/<scope>-<short>-<issue#>` or `fix/<scope>-<short>-<issue#>`.
3. **Add a regression case** under the [smoke test conventions](#smoke-test-conventions).
4. **Implement** in the smallest surface that meets acceptance. Match existing patterns.
5. **Run locally**:
   ```bash
   scripts/run-all-smokes test-<name>-smoke
   scripts/run-all-smokes test-fanout-run-smoke   # if you touched L5 fanout/dag
   scripts/run-all-smokes test-sentinel-smoke test-secret-uri-smoke test-worktree-lifecycle-smoke  # if you touched L6
   scripts/ci-shellcheck
   scripts/lint-no-path-tied-locals
   ```
6. **Open a PR** with `Closes #<issue>` and an acceptance-checklist body, quoting the local check output. There is no CI: this repo has no GitHub Actions workflows, and agents never add or trigger one (owner ruling 2026-10-02).
7. **Review loop** — see [the partner review pattern](#partner-review-pattern) below.
8. **Merge** via squash. Conventional commit message in the squash subject.
9. **CHANGELOG.md** — add an entry under `## Unreleased`. The release PR consolidates these into a versioned section.

## Smoke test conventions

The general test policy (which test owns a case, fixed waits, cut duplicates before adding) is the "Test cost" rule in `ohyeh/agent-scripts` `.agents/rules/operator-defaults.md`. The repo facts:

- **Budget**: `PARALLEL_JOBS=4 zsh scripts/run-all-smokes` must finish within 180 seconds, from preflight through cleanup, on the owner's development host. Quote its `suite wall` line, with the host and revision, in the change report.
- **Runner**: run smokes through `scripts/run-all-smokes` (every `test-*-smoke`; `test-mcp-bundle-smoke` also runs the mcp-adapter source tests) or `scripts/run-all-smokes test-<name>-smoke` (one). The runner gives each job its own HOME and tmux directory.
- **Home guard**: line 2 of every smoke sources `scripts/lib/smoke-home-guard.sh`, which refuses to run with the real HOME (2026-10-09 home-deletion incident). A smoke started directly exits 3.
- **Isolation**: next, source `scripts/lib/smoke-tmux.sh`, before the smoke creates files or starts tmux. It puts `TMPDIR` and the tmux sockets inside the job directory and kills those tmux servers on exit, error, and signal. Register an extra socket with `smoke_socket <name>`.

## Partner review pattern

Many PRs land via a two-agent loop: an implementer writes the code, a partner runs a 7-step checklist against the PR branch:

1. **Re-run the smoke** from the PR branch (not the main checkout). Tests that pass in the author's worktree can fail in a fresh one.
2. **Contract check**: walk each issue acceptance criterion against the diff. Mark `✅` / `❌` per criterion.
3. **Mode-switch coverage**: confirm negative paths have tests (missing input, bad input, error path).
4. **Honest verdict**: APPROVE, REQUEST_CHANGES, COMMENT. HIGH-priority bot findings → REQUEST_CHANGES regardless.
5. **Followups over scope creep**: open new GH issues for unrelated nits.
6. **Lock killer bugs as regressions**: every reproducible bug gets a test name in the review.
7. **Lock design-doc invariants**: changes that contradict a design doc need the doc updated in the same PR.

## Shipping a change locally (every change)

Every shipped change bumps the version, even without a release: the plugin cache is keyed by version, and the `/workers` title shows which code a session runs. No tag, no `gh release` unless the owner asks.

1. Bump every version line (`scripts/test-version-sync-smoke` lists them; rebuild the MCP bundle), add a `## v0.X.Y - YYYY-MM-DD` section with a `- Not verified: …` line, run the local checks (Release process step 2), commit, push `main`.
2. `claude plugin marketplace update tmux-agent-tools`, then update both plugins: `claude plugin update tmux-agent@tmux-agent-tools` (the mod) and `claude plugin update tmux-agent-tools@tmux-agent-tools` (skills, gate, MCP). Each prints `updated from A to B`; a missed one stays on its old version (the root plugin sat at 0.46.3 through 0.46.4).
3. `npx --yes skills update -g tmux-agent-tools using-tmux-agent-tools`; `diff -rq skills/tmux-agent-tools ~/.agents/skills/tmux-agent-tools` prints nothing.
4. In agent-scripts, copy the new `skillFolderHash` / `updatedAt` from `~/.agents/.skill-lock.json` into `skills-lock.json` and push: a lock restore reinstalls what the lock pins, so a stale pin puts the old skill back.
5. Call `mcp__tmux-agent__reload`: it runs `/reload-plugins`, then `/reload-skills`, when the turn ends. The handler that runs is the loaded one, so after a mod change call it again on the next turn.

## Release process

No GitHub Actions: the release is local, after the local checks pass.

1. Move `## Unreleased` entries under `## v0.X.Y - YYYY-MM-DD` and add a `- Not verified: …` line (what this release did not check; `release-notes` refuses a section without it), bump every version line (`scripts/test-version-sync-smoke` lists them), rebuild the MCP bundle (`npm --prefix mcp-adapter run build`), commit `chore(release): 0.X.Y`.
2. Run `scripts/ci-shellcheck`, the plugin tests in `mods/tmux-agent`, and `PARALLEL_JOBS=4 zsh scripts/run-all-smokes`. The smoke suite includes the type checks and core contracts; run those lanes once. Quote each result and the smoke wall time. Run an extra targeted check only for a changed boundary that these commands did not check.
3. Push `main`, then tag and publish from the same commit:
   ```sh
   git tag -a v0.X.Y -m v0.X.Y
   ruby scripts/release-notes v0.X.Y > "$TMPDIR/notes.md"   # fails unless the tag is on the chore(release) commit; fix before pushing the tag
   git push origin v0.X.Y
   gh release create v0.X.Y --title v0.X.Y --notes-file "$TMPDIR/notes.md"
   ```

## Asking for help

- Comment on the related issue.
- Reference the canonical surface in `skills/tmux-agent-tools/SKILL.md` when explaining a contract.
- For ambiguous behavior, write the failing smoke first — it's a clearer artifact than a paragraph of description.
