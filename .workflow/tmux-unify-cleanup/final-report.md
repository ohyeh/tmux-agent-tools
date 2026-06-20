# Final Report — tmux-unify-cleanup

Status: COMPLETE (P0–P8 all done, single-pass, single-context — no swarm/goal mode).

## Outcome
所有 workflow 統一改用 tmux-agent-tools 驅動第二模型,移除棄用的 `codex:codex-rescue`,並完成 feature-lifecycle flow 的 8 項加固。整合鏈經真實 codex round 驗證可行。

## Accepted Results
- **P0** 移除 `codex:codex-rescue`(3 處/2 檔)→ `agent-tmux` driver;`root-cause` 漏括號修復(原從未解析)。
- **P1** runtime smoke:`agent-tmux self-test: ok` + 真實 codex round(隔離 /tmp)寫出 `SMOKE_OK`+marker、檔案輪詢偵測、乾淨關閉。
- **P2** 第二模型 `cli: codex|claude` 可切換;per-cli `launchEnv`;預設 codex 不變。
- **P3** 3 條 mid-level stage 加 NESTING 防呆註解。
- **P4** lifecycle shell 讀共用 job 檔時 log 並行不安全警告。
- **P5** `planOk` 升級為 PLAN_SECTIONS 五段完整性檢查。
- **P6** BUILD 前 token budget early-exit(<80k)。
- **P7** build→ADR deviation→amendment **halt-gate**(結構化 `deviations[]` + `amendment_needed` hard-stop;amendment 重用 plan-pipeline)。
- **P8** 部署副本 `plan-pipeline` 殘留 v8 `BUILTIN` 還原 `{}`,用法註解去專案化。

## Rejected Results
- 不為下游每 task 配 ADR(commit/PR/test 已等價;違反 No Performative Process)。
- P7 不建新 workflow(重用 plan-pipeline ADR-freeze)。
- P1 不在真 repo 跑 codex --yolo,改隔離 /tmp。

## Conflicts Resolved
- 部署點 `~/.claude/workflows`(非 git)vs repo `~/github/tmux-agent-tools`:`.workflow.js` 留部署點,`.workflow/<slug>/` artifact 進 repo(先前誤放已更正)。
- P7 決策:Q1 判準+halt-gate(非新 workflow);Q2 門檻錨定 frozen file:line(牴觸→amendment,補充→deviation)。

## Verification Evidence
6 檔語法全綠;live dead-ref 空;cli 參數化 ×2;NESTING ×3;plan-pipeline 無 v8 殘留;`agent-tmux self-test: ok`;真實 codex round file-polled ok。

## Remaining Risks
- P4 進階(per-slug job 檔)未做——受「args 被吞」限制,保守警告 CP 值較高。
- P7 halt-gate 召回率需真實 build run 驗(目前靜態 + schema 強制)。
- claude 第二模型路徑已參數化但未跑 live round(codex round 已證機制;claude self-test 綠)。
- artifact git untracked,未 commit(依規則未明確要求不 commit)。

## Reusable Follow-up
若要常態化,可把 P1 的最小 smoke 存成 `.workflow/recipes/agent-tmux-driver-smoke.md`(start→send→poll OUT→stop;雷:輪詢檔不輪詢 pane)。
