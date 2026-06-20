# Packet P2 — Parameterize cli codex|claude in driver workflows

Packet ID: P2
Objective: 讓第二模型 driver 可 `cli: codex|claude` 切換,不寫死 codex。
Context: `driveCodex` 目前字面寫 `agent-tmux codex`;tmux-agent-tools 同時支援 claude profile。
Files: `feature-plan-consensus.workflow.js`、`spec-implement-dual-review-verify.workflow.js`。
Ownership: 單 agent;與 P3/P4 檔案不重疊(P3 只動註解、P4 動 lifecycle)。
Do:
- 加 `const cli = a.cli === 'claude' ? 'claude' : 'codex'`。
- `driveCodex` 內 `codex` 字面替換為 `${cli}`(start/send/session/marker 沿用)。
- doc 區補 `cli` 參數說明。
Do not:
- 不改完成偵測機制(仍輪詢 OUT 檔)。
- 不動 claude in-harness reviewer(那條本來就是 claude)。
Expected output: 兩檔 diff + 預設 codex 行為不變。
Verification: 改後兩檔重跑 AsyncFunction 語法檢查;`rg 'agent-tmux codex'` 應變成可變 `${cli}`。
Depends on: P1 通過(否則統一無意義)。
