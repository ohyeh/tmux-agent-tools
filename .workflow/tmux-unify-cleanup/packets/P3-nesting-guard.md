# Packet P3 — Nesting-guard comment in stage workflows

Packet ID: P3
Objective: 明示 stage workflow 不可在內部 `workflow()`(1 層巢狀上限),避免日後有人加 `workflow('codex-consensus-gate')` 觸發 runtime throw。
Context: `feature-lifecycle-auto` 用 `workflow()` 叫 stage(第 1 層);stage 內若再 `workflow()` 會炸。codex driver 故意用 inline `agent()` 規避。
Files: `feature-plan-consensus.workflow.js`、`spec-implement-dual-review-verify.workflow.js`、`plan-pipeline.workflow.js`(頂部各加一行)。
Ownership: 單 agent;純註解,不改邏輯。
Do: 頂部加 `// NESTING: mid-level stage — do NOT call workflow() here (1-level cap). Drive codex/claude via inline agent() + agent-tmux.`
Do not: 不動任何可執行碼。
Expected output: 三檔各 +1 行註解。
Verification: 語法檢查仍綠(註解不影響)。
