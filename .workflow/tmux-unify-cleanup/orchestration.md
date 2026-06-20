# Orchestration: Unify workflows on tmux-agent-tools and harden feature-lifecycle flow

## Execution Rules
- 單 context 執行,不開 swarm、不進 goal mode(小型維運任務)。
- P1 啟動真實 CLI → 執行前必須取得使用者批准。
- P2-P6 為非破壞本地編輯;每改一條 workflow .js 後立即重跑語法檢查 + 死引用掃描。
- 完成偵測一律輪詢 OUT 檔,嚴禁比對 tmux pane。

## Branching Rules
- P1 smoke 失敗(agent-tmux 在 workflow agent 環境叫不動)→ 停手,回報環境問題,P2 之後暫緩(driver 統一無意義)。
- P1 通過 → P2-P4 可並行編輯(檔案不重疊);P5/P6 視使用者意願再做。
- 任一語法檢查 ❌ → 立即修正,不往下走。

## Packet Prompts
- **P1**: `Workflow({ scriptPath: ".claude/workflows/codex-consensus-gate.workflow.js", args: { repoPath, proposal:"sanity: reply OK", sessionName:"smoke1", effort:"low", timeoutSec:120 }})`;成功後改 agent-tmux claude profile 重跑等效最小任務。記錄實際輸出。
- **P2**: 在三條 driver 的 `driveCodex` 把字面 `codex` 換 `${cli}`,`const cli = a.cli === 'claude' ? 'claude' : 'codex'`,session/marker 沿用。
- **P3**: stage workflow 頂部加 `// NESTING: this is a mid-level stage — do NOT call workflow() here (1-level nesting cap). Drive codex/claude via inline agent() + agent-tmux.`
- **P4**: `feature-lifecycle-auto` 的 `JOB_FILE` 改 `.../.${slug}.job.json`;或讀取時 log 警告「全域 job 檔,勿並行」。
- **P5**: `planOk` 增加必備 sections regex 檢查(不只 length>300 + /risk/)。
- **P6**: shell 加 `budget.total` 守門 + 輪數上限 early-exit。

## Completion Audit
- [x] live code 無 codex:codex-rescue / agentType
- [x] 6 檔語法綠
- [x] SAFE_LIB inline 一致
- [x] P1 runtime smoke(self-test ok + 真實 codex round file-polled)
- [x] P2 cli 切換(codex|claude 參數化)
- [x] P3 nesting 防呆(3 stage)
- [x] P4 args 通道加固(並行警告)
- [x] P5 品質閘(PLAN_SECTIONS 五段完整性)
- [x] P6 成本守門(BUILD 前 budget early-exit)
- [x] P7 deviation→amendment halt-gate(判準+gate,amendment 重用 plan-pipeline)
- [x] P8 plan-pipeline BUILTIN 還原 {} + 用法註解去專案化
