# Result: P0 — Remove codex:codex-rescue + fix root-cause paren bug

Status: DONE (static-verified)

## Changes
- `feature-plan-consensus.workflow.js`: escalation ladder codex rung (L96) + external review loop (L237) 改為 inline `agent()` driver,跑 `agent-tmux codex` 並輪詢 OUT 檔(`driveCodex` helper)。移除 `agentType: 'codex:codex-rescue'`。
- `spec-implement-dual-review-verify.workflow.js`: 第二模型 reviewer (L62) 改 `driveCodex`;移除 `externalAgentType` 預設,更新 doc + warning log。
- `root-cause-deep-dive-audit.workflow.js`: `parallel(` 漏一個 `)`,`.then` 原掛在 `Array.from()` 上 → 補 1 個 `)`,語法 + 語意一併修復(此檔原本從未成功解析)。

## Verification (passed)
- `rg 'codex:codex-rescue|agentType' *.js`(排除註解)→ live code 為空。
- 6 條 workflow AsyncFunction 語法檢查 → 全綠。
- `_lib/safe.js` 的 SAFE_LIB inline 副本 → byte-identical。

## Behavioral win
硬 crash → 優雅降級:codex 不可用時,`feature-plan-consensus` 升級耗盡 → `needsUser`;`spec-implement` → 退化為 claude 單邊 review 且 `codex_available:false` 誠實標示。

## Not yet done
runtime smoke(P1)未跑 → 「driver 在 workflow agent 環境真的叫得動 agent-tmux」尚未證實。
