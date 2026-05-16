# Release Process

Releases are handled through pull requests and the `Release` GitHub Actions workflow. Do not create release tags or GitHub releases from a local shell as the normal path.

## Release PR

Open a focused release PR that prepares the release content:

- update `CHANGELOG.md` with a section named for the target tag, such as `## v0.2.1 - 2026-05-16`;
- include any release-readiness docs or small stabilization changes;
- let CI pass and merge through the protected `main` branch.

The release workflow must run from `main`, so the release PR must land before the tag/release can be created.

## Create Tag And GitHub Release

After the release PR merges, run the `Release` workflow from GitHub Actions:

- `version`: the tag to create, for example `v0.2.1`;
- `dry_run`: keep `true` first to validate notes and smoke checks without writing a tag;
- `dry_run`: set to `false` only when the dry run is clean and the release should be published;
- `prerelease`: set according to the release type.

The workflow validates shell syntax, the Homebrew Formula, wrapper self-tests, a fake two-turn dialogue smoke, and the matching `CHANGELOG.md` section before it writes anything. Real releases create an annotated tag and GitHub Release with notes extracted from `CHANGELOG.md`.

The dry-run validation job uses read-only repository permissions. The write permission is scoped to the publish job, which only runs when `dry_run` is explicitly set to `false`.

## Formula Bump PR

After the workflow creates the tag and GitHub Release, use the workflow run summary to open a follow-up Formula PR. The summary includes the released archive URL and SHA-256.

The Formula bump PR should update:

```ruby
url "https://github.com/ohyeh/tmux-agent-tools/archive/refs/tags/vX.Y.Z.tar.gz"
sha256 "<sha256 from the Release workflow summary>"
```

Keep this as a separate PR because the archive SHA-256 is only authoritative after the tag exists.
