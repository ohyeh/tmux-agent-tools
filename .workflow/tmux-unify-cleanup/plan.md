# Unify workflows on tmux-agent-tools and harden feature-lifecycle flow

## Goal
把 `~/.claude/workflows/` 全部 workflow 統一改用 tmux-agent-tools(`agent-tmux codex/claude`)驅動第二模型,移除已棄用的 `codex:codex-rescue`(來自 disabled 的 `codex@openai-codex` plugin),並加固 `feature-lifecycle-auto` 整體 flow 的已知風險。

## Success Criteria
- live code 無任何 `codex:codex-rescue` / `agentType` 引用(註解說明可留)。 ✅ DONE
- 6 條 workflow 全部通過語法檢查(AsyncFunction 建構)。 ✅ DONE
- 第二模型驅動走 tmux-agent-tools 且對齊已驗證的 `codex-consensus-gate` pattern(輪詢 OUT 檔,不比對 pane)。 ✅ DONE
- runtime smoke 證明 workflow agent 環境內 `agent-tmux` 真的叫得動。 ✅ DONE (P1:self-test ok + 真實 codex round file-polled;claude profile self-test 綠,live round 未跑)
- 第二模型可 `cli: codex|claude` 切換。 ✅ DONE (P2)
- args 通道 / nesting / 品質閘 / 成本的加固到位或明確標記為已接受風險。 ✅ DONE (P3-P6)
- P7 deviation→amendment halt-gate 落地;P8 部署副本 BUILTIN 還原。 ✅ DONE

## Current Context
- `~/.claude/workflows` 是獨立 live 副本(非 git、非 symlink);repo `~/github/tmux-agent-tools` 內無這些 `.workflow.js` 來源 → 編輯不會被同步覆蓋,無上游需同步,無 commit 目標。回溯靠 `~/.claude/file-history/`。
- 已驗證乾淨(早就走 tmux-agent-tools):`plan-pipeline`、`codex-consensus-gate`。
- 本 session 已修:`feature-plan-consensus`(2 處)、`spec-implement-dual-review-verify`(1 處)改為 `agent-tmux codex` driver;`root-cause-deep-dive-audit` 補回 1 個漏掉的 `)`(原本從未解析過)。
- 工具層證據:`scripts/profiles/{codex,claude}.conf` 皆存在;`test-agent-tmux-team-smoke` 測過 mixed-CLI(claude lead + codex worker);`test-approval-gate-smoke` 測過 claude-tmux。

## Constraints
- workflow 腳本自包含、無 import:共用邏輯只能 inline(SAFE_LIB 模式)。
- 巢狀 `workflow()` 僅一層:stage workflow 內不可再 `workflow()`(故 codex driver 用 inline `agent()` 而非 `workflow('codex-consensus-gate')`)。
- 完成偵測必須輪詢 OUT 檔,不可比對 tmux pane(marker 會在送出 prompt 回顯 → 誤觸發)。
- 不開 swarm / goal mode:本任務單 context 可完成。

## Risks
| # | 風險 | 嚴重度 |
|---|------|--------|
| 1 | top-level Workflow args 被 runtime 吞,靠單一全域 job 檔 → 並行 run 互撞 | 高 |
| 2 | 巢狀一層上限脆弱,日後在 stage 內加 `workflow()` 會炸 | 中 |
| 3 | codex driver 依賴 workflow agent 環境有 agent-tmux,尚未實測 | 中 |
| 4 | autoBuild frozen 模式 planPath 靠猜回傳結構,強耦合 | 中 |
| 5 | `planOk` 品質閘過淺(只看長度+含 risk 字) | 中 |
| 6 | consensus fan-out 成本無上限(曾燒 750k token) | 中 |
| 7 | "self" rung 未設 orchestratorModel 時可能是同模型空升級 | 低 |
| 8 | `fpc-${slug}` codex session 同 slug 並行撞名 | 低 |

## Approval Required
- P1 runtime smoke 會啟動真實 codex/claude CLI(spawn tmux、耗 token)→ 執行前需使用者批准。
- 其餘為本地讀寫 / 程式編輯,非破壞性,無外部副作用 → 不需批准。

## Work Packets
- **P0 移除 codex-rescue + 修語法**(DONE):3 檔改為 agent-tmux driver + root-cause 補括號;靜態驗證通過。
- **P1 runtime smoke**(PENDING, needs-approval):用 `codex-consensus-gate` 跑最小 codex 任務,確認 agent-tmux 在 workflow agent 環境可用;再以 claude profile 重跑一次確認雙 CLI。
- **P2 cli 切換**(PENDING):`driveCodex` 的 `codex` 改為 `${a.cli||'codex'}`,3 條 driver workflow 加 `cli` 參數透傳。
- **P3 nesting 防呆**(PENDING):在 stage workflow 頂部加註解明示「不可在此 `workflow()`」。
- **P4 args 通道加固**(PENDING):job 檔改 per-slug(`.<slug>.job.json`)或於讀取時警告並行覆蓋風險。
- **P5 品質閘加強**(PENDING, optional):`planOk` 增加區段完整性檢查(必備 sections 存在),不只長度。
- **P6 成本守門**(PENDING, optional):`feature-lifecycle-auto` 加 budget/輪數上限 early-exit。
- **P7 deviation→amendment 回饋邊**(DISCUSSION, design-only):決定 ④build 撞到「凍結 ADR/plan 假設錯了」時的紀律機制是否做成 workflow,並定義觸發門檻。來自另一 session 的 v8 規劃輪;先討論未定案。詳見 `packets/P7-deviation-amendment-edge.md`。

## Integration Policy
各 packet 檔案不重疊:P2/P5 改 workflow .js,P3 只動註解,P4 改 job 檔處理。改完逐條重跑語法檢查 + 死引用掃描再整合。衝突以 live source 為準。

## Verification
- 靜態:`rg 'codex:codex-rescue|agentType' *.js`(排除註解)為空;6 檔 AsyncFunction 語法檢查全綠。 ✅
- 動態:P1 smoke 實跑輸出為證(codex + claude)。 ⬜
- 回歸:P2 改完後對 3 條 driver workflow 重跑語法檢查。 ⬜

## Reusable Artifacts
若 P1 smoke 成形,存成 `.workflow/recipes/agent-tmux-driver-smoke.md`(trigger / 最小命令 / 預期輸出 / 已知雷:輪詢 OUT 不輪詢 pane)。
