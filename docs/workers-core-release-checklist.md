# workers-core P8 release checklist

Inventory for the release that ships one core (`skills/tmux-agent-tools/scripts/lib/workers.ts`) inside the root plugin. The base is `merge-base main HEAD` of the branch being released, not worktree `wc-p8` or `eec07ff`. Tag and publish stay with the operator. Do not bump versions in a lane that has not merged P3–P7.

Contract: workers-core P0 contract v6 §9 (capability matrix) and §10 (P8 = immutable candidate / approved tag, install + upgrade matrix). Plan D1 is C: the mod binding lives in the root plugin and imports the core. Release policy for pinned consumers: agent-scripts `AGENTS.md` lines 35–37 (`npx --yes skills@<version>` against a gated release ref).

## Version strings that move together

`scripts/test-version-sync-smoke` fails the release if these disagree with the first `^## vX.Y.Z` heading in `CHANGELOG.md`. That heading is `CHANGELOG.md:5` (`## v0.42.0 - 2026-09-30`). `CHANGELOG.md:3` is an empty `## Unreleased`. Do not edit historical headings.

| file:line | string | this prep |
|---|---|---|
| `CHANGELOG.md:5` | `## v0.42.0 - 2026-09-30` (first `## v` heading; `CHANGELOG.md:3` is empty `## Unreleased`) | bumped |
| `.claude-plugin/plugin.json:3` | `"version": "0.42.0"` | bumped |
| `.codex-plugin/plugin.json:3` | `"version": "0.42.0"` | bumped |
| `.cursor-plugin/plugin.json:3` | `"version": "0.42.0"` | bumped |
| `.claude-plugin/marketplace.json:9` | `metadata.version` `0.42.0` | bumped |
| `.claude-plugin/marketplace.json:16` | plugin `tmux-agent` `version` `0.42.0` | bumped |
| `skills/tmux-agent-tools/scripts/agent-tmux:13` | `AGENT_TMUX_VERSION='0.42.0'` | bumped |
| `hooks/register.ts:94` | `const MOD_VERSION = '0.42.0'` | bumped; version-sync compares it to the plugin manifest |

The guard that reads them: `scripts/test-version-sync-smoke:23` (CHANGELOG), `:30` (three plugin manifests), `:38` (`AGENT_TMUX_VERSION`), `:46` and `:48` (marketplace metadata and the `tmux-agent` entry), `:56` (`MOD_VERSION`).

Not a version to bump:

- `README.md:164` says "until 0.41.0" as history of the two-plugin layout.
- `mcp-adapter/package.json:3` is `"version": "1.0.0"` for a different package. P5 owns `mcp-adapter/`. Do not fold it into the plugin version.

## Manifest and plugin paths

D1 C is already the tree at this base. These paths must stay pointed at the root plugin. `mods/` is absent.

| file:line | path | meaning |
|---|---|---|
| `.claude-plugin/marketplace.json:2` | marketplace name `tmux-agent-tools` | Claude and Codex marketplace id |
| `.claude-plugin/marketplace.json:13` | plugin name `tmux-agent` | install id `tmux-agent@tmux-agent-tools` |
| `.claude-plugin/marketplace.json:14` | `"source": "./"` | plugin root is the repo root, not `./mods/tmux-agent` |
| `.claude-plugin/plugin.json:2` | `"name": "tmux-agent"` | Claude manifest name |
| `.claude-plugin/plugin.json:21` | `"skills": "./skills/"` | skill payload |
| `.codex-plugin/plugin.json:2` | `"name": "tmux-agent"` | matches the marketplace plugin name `tmux-agent` (install id `tmux-agent@tmux-agent-tools`) |
| `.codex-plugin/plugin.json:21` | `"skills": "./skills/"` | same skill tree |
| `.cursor-plugin/plugin.json:2` | `"name": "tmux-agent"` | Cursor manifest name, matches marketplace entry |
| `.cursor-plugin/plugin.json:21` | `"skills": "./skills/"` | same skill tree |
| `hooks/hooks.json:9` | `"${CLAUDE_PLUGIN_ROOT}"/hooks/tmux-dispatch-gate.sh` | classic Bash gate |
| `hooks/hooks.json:17` | `"modules": ["./register.ts"]` | function-hook module at the plugin root |
| `hooks/register.ts:80` | import `../skills/tmux-agent-tools/scripts/lib/workers.ts` | one core, imported by the root mod |

Node entry points (not Claude plugin paths):

- `skills/tmux-agent-tools/scripts/lib/collector.node.ts:6` usage; floor check `:18` and `:57–60` (`22.18.0`).
- `skills/tmux-agent-tools/scripts/lib/workers.cli.node.ts:5` usage (`cancel`, `unlock`).

`scripts/test-mod-permissions-smoke` does not enumerate entry points. It diffs `claude plugin validate` (`:45–67`) against `permissions.txt` and runs `claude plugin test .` (`:69–81`, `MOD=.` at `:26`). `permissions.txt` lists `./register.ts` only. `collector.node.ts` and `workers.cli.node.ts` are outside that surface. Adding them to `permissions.txt` would fail the diff. No change in this prep.

## CI and release gates

### Already on CI (` .github/workflows/ci.yml`)

| gate | file:line | runs the new tests? |
|---|---|---|
| Node floor `22.18.0` | `ci.yml:31–34` `actions/setup-node@v5` | yes, for the steps below |
| Core contract | `ci.yml:36–37` `scripts/test-core-contract-smoke` | yes. The smoke is `scripts/test-core-contract-smoke:13–20`: floor `22.18.0`, then `node --test ./*.contract.node.ts` |
| Collector tests | same glob | yes: `collector.contract.node.ts` matches `*.contract.node.ts`. `ledger.race.node.ts` and `workers.race.node.ts` are contender processes, not `node:test` files |
| Launcher tests | same glob | yes: `launcher.contract.node.ts` matches `*.contract.node.ts` (P7) |
| TUI tests | same glob | yes: `tui.contract.node.ts` matches `*.contract.node.ts` (P6, renamed from `tui.test.node.ts` in 4463641) |
| `claude plugin test .` | `ci.yml:522–544` installs Claude, then `scripts/run-all-smokes` | yes, indirectly. `scripts/run-all-smokes:46` globs `test-*-smoke`, which includes `scripts/test-mod-permissions-smoke:70` (`claude plugin test .`). Per-smoke timeout is `scripts/run-all-smokes:17` (240s) |
| Typecheck | same glob | yes: `scripts/test-mod-typecheck-smoke:22` (`npx -p typescript tsc --noEmit -p tsconfig.json`). `tsconfig.json:17–18` includes `scripts/lib` and excludes `*.node.ts` |

`ci.yml` did not need a new job.

### Release workflow (landed here)

Before this prep, `.github/workflows/release.yml` `validate` did not set up Node 22.18.0 and did not run the contract smoke, typecheck, or plugin test. P6 TUI tests (`tui.contract.node.ts`) and P7 launcher tests (`launcher.contract.node.ts`) are now in the tree and executed by `test-core-contract-smoke` (`*.contract.node.ts`). Release workflow now also runs `cd mcp-adapter && npm ci && npm test` on Node 22.18.0, the full smoke suite (`scripts/run-all-smokes`) with private tmux isolation, and ties publish to the tested candidate SHA.

| gate | file:line |
|---|---|
| job timeout | `release.yml:31` `timeout-minutes: 30` |
| Candidate SHA recording | `release.yml:42–46` `record_sha` output |
| Node `22.18.0` | `release.yml:56–59` |
| mcp-adapter `npm ci` + `npm test` | `release.yml:61–62` `cd mcp-adapter && npm ci && npm test` |
| Socket isolation guard | `release.yml:64–65` |
| Core contract (includes collector, launcher, and TUI contracts) | `release.yml:67–68` |
| Typecheck | `release.yml:70–71` |
| Claude install | `release.yml:73–77` |
| Permission surface + `claude plugin test .` | `release.yml:79–80` `scripts/test-mod-permissions-smoke` |
| Smoke CLI stubs + full smoke suite (private tmux isolation) | `release.yml:82–96` `scripts/run-all-smokes` |
| Existing candidate checks (version regex, tag absent, wrapper self-test, version-sync, session-meta, oneshot, dialogue with isolated tmux) | `release.yml:98–129` |
| CHANGELOG section for the tag | `release.yml:131–145` |
| Checkout tested candidate SHA & refuse if main moved | `release.yml:164–179` |
| Publish (tag + GitHub release on tested SHA) only when `dry_run` is false | `release.yml:196–211` |

`publish` does not re-run tests. `needs: validate` is the gate, and publish checks out the tested SHA and tags it explicitly. Formula syntax is not a gate: the Homebrew formula was removed (`CHANGELOG.md:112`). `docs/wiki/Contributing.md:85` still mentions it. `docs/release-process.md` is not in the tree; `docs/wiki/Contributing.md:81` still points at it.

## Capability matrix

Contract §9 groups Codex, Cursor, and agy as one node collector. P6 TUI (`tui.node.ts`) and P7 launcher (`launcher.node.ts`) are implemented in this tree.

| capability | Claude mod | Codex | Cursor | agy |
|---|---|---|---|---|
| collect | in-session collector | `collector.node.ts`, one process per host session | same | same |
| assign | `mcp__tmux-agent__assign` | CLI verb on the shared core | same | same |
| tell | `mcp__tmux-agent__tell` | CLI verb | same | same |
| stop | `mcp__tmux-agent__stop` | CLI verb | same | same |
| cancel | `/workers cancel` and `workers.cli.node.ts cancel` | `workers.cli.node.ts cancel` | same | same |
| unlock | `/workers unlock` and `workers.cli.node.ts unlock` | `workers.cli.node.ts unlock` | same | same |
| panel | `/workers` band | read-only snapshot (panel line / dashboard). Not a collector | same | same |
| TUI | `skills/tmux-agent-tools/scripts/lib/tui.node.ts`: shared key handling, panel rows, viewer mode | same | same | same |
| Bash guard (`tool.call`) | yes | unsupported | unsupported | unsupported |

Wake on Claude is `Host.submit`. Wake on Codex, Cursor, and agy is a tmux paste into pane id `%N`. A waiter subagent is Claude-only; other hosts get the collector delivery.

## Pinned-consumer clean install

No file in this repo or in agent-scripts records a `skills@x.y.z` pin. The P0 probe pin is `skills@1.7.0` (`p0-probes.sh` E4). `skills@1.7.0` declares `node >= 22.20.0`. The core floor stays `22.18.0`. Use a Node that satisfies the skills CLI for the install, and run the contract smoke on `22.18.0`.

Replace `REPO` with the candidate checkout. Run from a directory that is not the repo. `HOME` and `CLAUDE_CONFIG_DIR` must be empty directories.

```bash
scratch=$(mktemp -d)
mkdir -p "$scratch/home" "$scratch/elsewhere" "$scratch/claude"
cd "$scratch/elsewhere"

env HOME="$scratch/home" npx --yes skills@1.7.0 add "$REPO" -g -y --skill tmux-agent-tools

env HOME="$scratch/home" CLAUDE_CONFIG_DIR="$scratch/claude" \
  claude plugin marketplace add "$REPO"
env HOME="$scratch/home" CLAUDE_CONFIG_DIR="$scratch/claude" \
  claude plugin install tmux-agent@tmux-agent-tools

env HOME="$scratch/home" CLAUDE_CONFIG_DIR="$scratch/claude" \
  claude --plugin-dir "$REPO" -p 'Reply with the single word ok'

env HOME="$scratch/home" codex plugin marketplace add "$REPO" --json
env HOME="$scratch/home" codex plugin add tmux-agent@tmux-agent-tools --json

env HOME="$scratch/home" agent plugin marketplace add "$REPO"
env HOME="$scratch/home" agent --plugin-dir "$REPO" -p 'Reply with the single word ok'
```

`cursor` (the IDE shim) is not the installer on this machine. The Cursor agent CLI is `agent`. Its marketplace add takes a git URL (`agent plugin marketplace add --help`), and `--plugin-dir <path>` loads a local directory without installing it.

A published tag install (`npx --yes skills@1.7.0 add ohyeh/tmux-agent-tools --skill tmux-agent-tools` at a tag, or `codex plugin marketplace add ohyeh/tmux-agent-tools --ref <tag>`) waits until the operator publishes. UNVERIFIED until that tag exists.

### Sample run from 0.41.0 worktree p8 (historical 2026-09-29 sample, not this checkout)

`REPO=/Users/paul.yeh/git/tmux-agent-tools.wt/p8` (historical sample), scratch HOME `/tmp/wc-p8-install.QpkldD/home`, cwd `/tmp/wc-p8-install.QpkldD/elsewhere`.

`npx --yes skills@1.7.0 add` exit 0. The registry warned, then installed:

```text
npm warn EBADENGINE   package: 'skills@1.7.0',
npm warn EBADENGINE   required: { node: '>=22.20.0' },
npm warn EBADENGINE   current: { node: 'v22.18.0', npm: '10.9.8' }
```

```text
■  Failed to install 2
│    ✗ tmux-agent-tools → Eve: Eve does not support global skill installation
│    ✗ tmux-agent-tools → PromptScript: PromptScript does not support global skill installation
SKILLS_RC=0
```

The payload at `$HOME/.agents/skills/tmux-agent-tools/scripts/lib/` includes `collector.node.ts` and `workers.cli.node.ts`. It does not include `mods/`.

Claude, fresh `CLAUDE_CONFIG_DIR`:

```text
✔ Successfully added marketplace: tmux-agent-tools (declared in user settings)
✔ Successfully installed plugin: tmux-agent@tmux-agent-tools (scope: user)
  ❯ tmux-agent@tmux-agent-tools
    Version: 0.41.0
    Scope: user
    Status: ✔ enabled
✔ Validation passed
```

`claude --plugin-dir "$REPO" -p '...'` exit 1:

```text
Not logged in · Please run /login
```

UNVERIFIED. A fresh config has no Claude login. This prep did not run `/login`.

Codex marketplace add exit 0:

```text
{"marketplaceName":"tmux-agent-tools","installedRoot":"/Users/paul.yeh/git/tmux-agent-tools.wt/p8","alreadyAdded":false}
```

`codex plugin add tmux-agent-tools@tmux-agent-tools` exit 1:

```text
Error: plugin `tmux-agent-tools` was not found in marketplace `tmux-agent-tools`
```

`codex plugin add tmux-agent@tmux-agent-tools` exit 1:

```text
Error: plugin.json name `tmux-agent-tools` does not match marketplace plugin name `tmux-agent`
```

That historical mismatch was `.codex-plugin/plugin.json:2` (`tmux-agent-tools`) versus `.claude-plugin/marketplace.json:13` (`tmux-agent`). Resolved in R11: unified public plugin id is `tmux-agent` across `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `.cursor-plugin/plugin.json`.

Cursor: `cursor` prints `No Cursor IDE installation found`. `agent plugin marketplace add <local path>` exit 1:

```text
Error: Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.
```

UNVERIFIED. No login was attempted.

## Local commands for the new release steps

Contract smoke on Node 22.18.0. A login zsh reads `~/.zshenv`, which prepends `/opt/homebrew/bin` (Node 26.8.2 on this machine) and hides a PATH prefix. `zsh -f` skips that file. GitHub-hosted runners do not have this `~/.zshenv`.

```text
cd mcp-adapter && npm ci && npm test
adapter smoke ok
```

```text
zsh -f scripts/test-core-contract-smoke
  ok   core contract (node 22.18.0): pass 65  fail 0  # dated sample 2026-09-29; use that run's count
1 passed, 0 failed
```

```text
scripts/test-mod-typecheck-smoke
typechecking the mod (hooks, tests, types, scripts/lib) against tsconfig.json
  ok   mod typecheck clean
1 passed, 0 failed
```

```text
scripts/test-mod-permissions-smoke
  ok   permission surface matches ./permissions.txt
running the mod's test suite
  ok   plugin test: 180 pass, 0 fail
2 passed, 0 failed
```

`npm install -g @anthropic-ai/claude-code` was not run; `claude` was already on PATH. The smoke is the step `release.yml:64` runs after that install.

## Left for the final P8 (after P3–P7 merge)

- Done in this prep: the eight version rows above are `0.42.0`, under `## v0.42.0 - 2026-09-30`. `hooks/register.ts` `MOD_VERSION` moved with them because version-sync compares it to the plugin manifest. Tag and publish stay with the operator.
- Decided: unified public plugin id is `tmux-agent` across all manifests and marketplace entries (R11).
- Completed: launcher and TUI contract tests landed in the tree (`launcher.contract.node.ts`, `tui.contract.node.ts`) and run in `test-core-contract-smoke` on CI and release.
- Fold commander, dashboard, and mcp-adapter only in their lanes. Then re-run the skills payload check (`scripts/lib` must remain; `mods/` must not reappear).
- Point `docs/wiki/Contributing.md:81` at a real release doc, and drop the Formula sentence at `:85`.
- Updated `docs/tmux-agent-mod.md` to clarify the unified single plugin `tmux-agent` layout.
- Operator: release workflow `dry_run: true`, then `dry_run: false` for the tag. Not from this worktree.
- Re-run `claude --plugin-dir` on a logged-in config, and Cursor `agent plugin` after `agent login`.
- Record the consumer `skills@<version>` pin. `1.7.0` is the probe pin, not a lockfile.
