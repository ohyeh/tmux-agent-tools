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
│       ├── tmux-agent-replay          # transcript diff / redact / validate
│       └── install-bin                # symlinks wrappers into ~/.local/bin
├── scripts/
│   ├── test-*-smoke                   # smoke runners (one per feature)
│   ├── ci-shellcheck                  # syntax + shellcheck across all scripts
│   ├── lint-no-path-tied-locals       # zsh tied-pair locals lint
│   └── lint-no-path-tied-locals.test  # lint smoke
├── schemas/                           # JSON schemas for stable surfaces
├── docs/                              # design docs (one per issue / batch)
└── CHANGELOG.md                       # release-by-release narrative
```

## Style ground rules

- **bash + zsh portable**. Wrappers are sourced by both. Test under zsh as well as bash before pushing.
- **zsh tied-pair locals are forbidden** — never `local path=...`, `local status=...`, `local lines=...`. Use `wt_path`, `check_status`, `out_lines`. CI fails the lint.
- **Every new JSON surface needs `schema_version: 1`**. Adding a versioning shim later breaks every consumer.
- **No hidden autonomy**. Synchronous, operator-explicit, no resident daemons or background supervisors. See `docs/design-l5-l6-policy-block.md`.
- **Back-compat is the default**. Existing callers must keep working. Deprecate first, remove much later.

## Adding a feature: the loop

1. **Open an issue** describing the user-visible outcome and acceptance criteria. Acceptance criteria should be checkable from the merged diff.
2. **Branch** off `main`, conventional name: `feat/<scope>-<short>-<issue#>` or `fix/<scope>-<short>-<issue#>`.
3. **Write a smoke** before the feature: `scripts/test-<name>-smoke`. Smokes assert observable behavior, not implementation. Each smoke counts its sub-assertions in stdout and exits non-zero on any failure.
4. **Implement** in the smallest surface that meets acceptance. Match existing patterns.
5. **Run locally**:
   ```bash
   scripts/test-<name>-smoke
   scripts/test-fanout-run-smoke       # if you touched L5 fanout/dag
   scripts/run-all-smokes test-sentinel-smoke test-secret-uri-smoke test-worktree-lifecycle-smoke  # if you touched L6
   scripts/ci-shellcheck
   scripts/lint-no-path-tied-locals
   ```
6. **Open a PR** with `Closes #<issue>` and an acceptance-checklist body, quoting the local check output. There is no CI: this repo has no GitHub Actions workflows, and agents never add or trigger one (owner ruling 2026-10-02).
7. **Review loop** — see [the partner review pattern](#partner-review-pattern) below.
8. **Merge** via squash. Conventional commit message in the squash subject.
9. **CHANGELOG.md** — add an entry under `## Unreleased`. The release PR consolidates these into a versioned section.

## Smoke test conventions

- File name: `scripts/test-<feature>-smoke`. Executable, `#!/usr/bin/env bash`.
- Print one line per case as it runs.
- Track pass/fail counts. Final stdout line: `N/N passed`. Exit 0 only when N == total.
- Negative cases matter — every new code path should have a smoke for the failure mode too.
- For runtime-bounded behavior (fail-fast, timeout), assert the timing. A 30s outer timeout doesn't prove a path is fast.

## Partner review pattern

Many PRs land via a two-agent loop: an implementer writes the code, a partner runs a 7-step checklist against the PR branch:

1. **Re-run the smoke** from the PR branch (not the main checkout). Tests that pass in the author's worktree can fail in a fresh one.
2. **Contract check**: walk each issue acceptance criterion against the diff. Mark `✅` / `❌` per criterion.
3. **Mode-switch coverage**: confirm negative paths have tests (missing input, bad input, error path).
4. **Honest verdict**: APPROVE, REQUEST_CHANGES, COMMENT. HIGH-priority bot findings → REQUEST_CHANGES regardless.
5. **Followups over scope creep**: open new GH issues for unrelated nits.
6. **Lock killer bugs as regressions**: every reproducible bug gets a test name in the review.
7. **Lock design-doc invariants**: changes that contradict a design doc need the doc updated in the same PR.

## Release process

No GitHub Actions: the release is local, after the local checks pass.

1. Move `## Unreleased` entries under `## v0.X.Y - YYYY-MM-DD`, bump every version line (`scripts/test-version-sync-smoke` lists them), rebuild the MCP bundle (`npm --prefix mcp-adapter run build`), commit `chore(release): 0.X.Y`.
2. Run the local checks: `scripts/test-mod-typecheck-smoke`, `scripts/ci-shellcheck`, `scripts/test-core-contract-smoke`, `(cd mods/tmux-agent && claude plugin test .)`, `zsh scripts/run-all-smokes`. All must pass; quote their output.
3. Push `main`, then tag and publish from the same commit:
   ```sh
   git tag -a v0.X.Y -m v0.X.Y && git push origin v0.X.Y
   ruby scripts/release-notes v0.X.Y > "$TMPDIR/notes.md"
   gh release create v0.X.Y --title v0.X.Y --notes-file "$TMPDIR/notes.md"
   ```

## Asking for help

- Comment on the related issue.
- Reference the canonical surface in `skills/tmux-agent-tools/SKILL.md` when explaining a contract.
- For ambiguous behavior, write the failing smoke first — it's a clearer artifact than a paragraph of description.
