# Worker doctrine — canonical COMMON preamble blocks

Prompt fragments for multi-agent implementation workflows. Not importable (workflow
scripts are self-contained): copy the relevant blocks into your recipe's `COMMON`
template string and fill the `<...>` slots. Harvested from the proven room-* run
family (room-feature-implementation / room-phase2-backends, v0.19→0.20 era).

## 1. Anchoring（每個 worker prompt 開頭）

```
Repo: <ROOT>, branch <BRANCH> (already checked out — do NOT switch branches).
AUTHORITATIVE SPEC: <spec path> — read it FULLY before coding; where sections
conflict, the newer/harder section overrides.
```

要點：branch 用「已 checkout、禁止切換」語氣釘死；spec 衝突的解決規則寫在 preamble，
不留給 worker 猜。

## 2. Hard tool mapping

```
HARD tool mapping: file discovery=fd, text search=rg, JSON=jq, YAML=yq.
NEVER use find/grep/sed/awk/ag/ack.
All JSON output strictly via jq -n --arg/--argjson (printf-assembled JSON is forbidden).
```

## 3. Language traps（zsh 版；其他語言仿此格式列「已知踩過的坑」）

```
Known zsh traps you MUST respect:
(1) never re-declare 'local' inside a loop; hoist above the loop.
(2) under set -e, 'out=$(cmd); rc=$?' never runs the error path — use:
    out="$(cmd)" && rc=0 || rc=$?
(3) guard every flag parser taking a value:
    (( $# < 2 )) && { echo "...requires a value" >&2; return 2; }
(4) empty-dir globs need (N) nullglob.
```

要點：traps 是**這個 codebase 實戰踩過的坑**，不是通用 lint 規則——每次收割新的坑
就補進對應語言的 trap 清單。

## 4. Scope fence

```
Hard invariants: surgical changes only; no new deps (<allowed list> allowed, already
deps); do not touch <protected code paths>; exit codes <the repo's contract>.
Do NOT edit <out-of-scope area>; if you find a bug there, report it in
decisions_not_in_spec instead of fixing.
```

要點：「發現界外 bug → 回報不修」是防 scope creep 的關鍵句。

## 5. Report contract（worker 最終輸出）

```
Your final text is data for the orchestrator, not a human-facing message. Report:
(1) what you changed (files + commit hash),
(2) DECISIONS-NOT-IN-SPEC: bullet list of any judgment calls, deviations, or
    tradeoffs you made that the spec did not dictate,
(3) how you self-verified (commands + results).
```

搭配 schema（強制 worker 交代 spec 外決策，orchestrator 據此追審）：

```js
const REPORT_SCHEMA = {
  type: 'object',
  required: ['summary', 'decisions_not_in_spec', 'verification'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    decisions_not_in_spec: { type: 'array', items: { type: 'string' } },
    verification: { type: 'string' },
  },
}
```

要點：`decisions_not_in_spec` 是整套 doctrine 的靈魂——spec 再凍結，實作一定有
judgment calls；不逼 worker 自首，這些偏差就會沉默地進 main。

## 6. Verify 收尾（最後一個 agent 的固定形狀）

```
Run <all relevant smoke/lint suites>, capturing pass/fail counts. If something
fails, FIX it (respecting the traps above) and re-run until green, committing
fixes. Report final per-suite counts + git log --oneline <base>..HEAD.
```

## 組裝範例

```js
const COMMON = `
Repo: ${ROOT}, branch ${BRANCH} (already checked out — do NOT switch branches).
AUTHORITATIVE SPEC: ${SPEC} — read it FULLY before coding.
HARD tool mapping: file discovery=fd, text search=rg, JSON=jq, YAML=yq. NEVER use find/grep/sed/awk/ag/ack.
${ZSH_TRAPS}
Hard invariants: surgical changes only; ${SCOPE_FENCE}
Commit on the current branch with a conventional-commit message; report the commit hash.
Your final text is data for the orchestrator: report changes, DECISIONS-NOT-IN-SPEC, and self-verification.
`
```
