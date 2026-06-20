# Packet P4 — Args channel hardening

Packet ID: P4
Objective: 降低單一全域 job 檔在並行 run 下互撞 / 吃舊檔的風險。
Context: 此 runtime 吞掉 top-level Workflow args(L34-43 自述),`feature-lifecycle-auto` 靠 `~/.claude/workflows/.feature-lifecycle-auto.job.json` 單檔輸入。
Files: `feature-lifecycle-auto.workflow.js`。
Ownership: 單 agent。
Do(擇一):
- 保守:讀 job 檔時 `log()` 警告「全域 job 檔,勿並行,確認內容為本次任務」。
- 進階:`JOB_FILE` 改 per-slug(`.${slug}.job.json`),但 slug 也來自 job 檔 → 需先讀預設檔取 slug 再讀 per-slug,或改由 args.slug 決定(注意 args 被吞的限制)。
Do not: 不破壞既有 args→job→builtin 優先序。
Expected output: diff + 選用方案理由。
Verification: 語法檢查綠;手動模擬缺檔/壞 JSON 仍走既有 abort 路徑。
Note: 進階方案受「args 被吞」限制,保守方案 CP 值較高(ponytail)。
