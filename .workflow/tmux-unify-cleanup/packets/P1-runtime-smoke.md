# Packet P1 — Runtime smoke: agent-tmux callable from workflow agent env

Packet ID: P1
Objective: 證明 workflow 內的 driver agent 能在本 harness 環境啟動並驅動 `agent-tmux codex` 與 `agent-tmux claude`,輪詢 OUT 檔取回結果。
Context: 改後 3 條 driver workflow 只通過靜態檢查;整合鏈 workflow→agent()→Bash→agent-tmux 未實跑。工具自身 smoke 已綠但不等於 workflow 整合可用。
Files / sources: `codex-consensus-gate.workflow.js`(已驗證 codex 路徑);`skills/tmux-agent-tools/scripts/profiles/{codex,claude}.conf`。
Ownership: 單 agent,本地執行。
Do:
- 先跑 codex:最小 proposal(回 "OK"),`effort:"low"`、`timeoutSec:120`,記錄實際 verdict 輸出。
- 再用 agent-tmux claude profile 跑等效最小任務,確認雙 CLI 都能 start/send/poll。
Do not:
- 不要改任何 workflow .js(這是驗證,不是編輯)。
- 不要比對 tmux pane 判完成;只輪詢 OUT 檔。
Expected output: 兩段真實 CLI 輸出 + 「codex/claude 皆可用」或明確失敗點(PATH? tmux? profile?)。
Verification: OUT 檔含結束 marker 且內容非空;退出無 error。
Approval: REQUIRED(啟動真實 CLI、耗 token)。
