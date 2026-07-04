# Claude Code Dynamic Workflows（本目錄說明）

本目錄是 **Claude Code 原生探索 saved dynamic workflows 的位置**。放在這裡的
workflow 腳本，clone 此 repo 的人都能直接以 `/<name>` 叫用。

> 需求：Claude Code **v2.1.154 以上**。dynamic workflows 在 Pro 需到 `/config` 開啟，
> Max/Team/Enterprise 與 API 預設開啟。

## 探索規則（官方）

| 位置 | 範圍 | 可見性 |
| --- | --- | --- |
| `.claude/workflows/`（本目錄，專案層） | 隨 repo 共享、版控 | 所有 clone 的人 |
| `~/.claude/workflows/`（家目錄，個人層） | 每個專案都可用 | 只有自己 |

- 兩處皆以 `/<name>` 呼叫；**同名時專案層優先**（會 shadow 個人層）。
- **command 名稱的推導**：官方 docs 未明文定義 `<name>` 如何從檔名產生。本腳本
  `meta.name = feature-plan-consensus`（穩定錨點）。本檔保留 `.workflow.js` 後綴以明示用途。
  實際 slash command 字串請在 CLI 打 `/` 查看確認，不在此臆測；絕對 `scriptPath` 叫用
  與檔名/命名推導無關，永遠可用。

## ⚠️ 哪些目錄「不」會被探索

- `.workflow/`、`.workflow/recipes/` —— 這是 `codex-dynamic-workflows` **skill 自己**的
  產物/範例慣例（一次性 run 的 plan/orchestration/report 存檔），**Claude Code 不會**
  把它當 saved workflow 探索。要能 `/name` 叫用，一定要放在 `.claude/workflows/`。

## 如何使用

```text
# 簡寫（本目錄被探索後）
/feature-plan-consensus

# 帶結構化參數（腳本以 global `args` 讀取）
> Run /feature-plan-consensus on { repoPath: "...", featureBrief: "...", slug: "..." }

# 或永遠可用的 canonical 絕對路徑（不依賴探索/命名）
Workflow({ scriptPath: "<abs path>/feature-plan-consensus.workflow.js", args: {...} })
```

## 本目錄現有 workflow

- **`feature-plan-consensus.workflow.js`** — supervised orchestration：把「新功能需求」轉成
  第一版實作計畫。階梯式升級（sonnet → orchestrator self → codex → 上呈 user）、
  證據鐵則（以 code/log/實際輸出為準，不採信記憶或舊 .md/.html）、內部 critic 共識
  迴圈後再經 codex 外部對抗 review，兩關都共識且經授權才寫出 plan 並 commit。
  設計已經 codex 多輪對抗 review 至 AGREE。

- **`pr-review-triage-resolve`**（⚠️ 設計存檔——**檔案尚未落地**：git 史、個人層、三台
  harvest 皆查無此檔；本條目是完成度高的設計 spec，落地前不可 `/name` 叫用）
  — 一次性 PR review 處理流程：⓪ 大腦先獨立
  讀 diff＋ledger 建 code 真相 → ① 用 `scripts/pr/trigger-codex-review.sh` 召 review
  bot 並 detached-poll 等回（minGrace 先硬等、以 baseline thread-id 快照判新留言）→
  ② 只收 bot 的、未 resolved 的新 thread（人類留言一律不碰）→ ③ TRIAGE 每條對撞
  code 真相判 accept／already-fixed／reject（severity 自評不吃 bot 標；低信心或高
  severity 升 T2 worker 評審團、T3 內部對抗＋codex 外部共識）→ ④ 只修 accept（worker／
  self 階梯，修一條驗一條）→ ⑤ push 後**先寫 ledger 驗證可讀再** resolve 三類 thread
  （不留言）。**不走內建閉環**，下一輪＝手動重跑整支；跨輪去重靠 `isResolved=false`
  過濾＋ledger 稽核。設計已經 codex 對抗 review（含實打 PR API 驗證）收斂。
  搭配腳本：**`scripts/pr/trigger-codex-review.sh`**（帳號守門＋嚴格 review rubric，
  可被 workflow 呼叫，也能 CLI 單獨手跑）。**本 repo 可直接跑的 args 範例見檔頭。**

- **`plan-pipeline.workflow.js`** — 規劃專用管線（刻意**不含 build**）：① direction
  （goal_doc）→ ② frozen plan（plan-<slug>.md）→ ③ ADRs——每份 artifact 由 codex 起草、
  經 codex 對抗 review 至 CLEAN（0 Critical/0 Major）才凍結 → commit/push 文件。
  全參數化（slug/brief/輸出路徑/review 輪數），完成訊號一律輪詢輸出檔。與
  `project-direction-review` 互補（那支回答「往哪走」、這支凍結「怎麼做」）；
  後續 build 交給 `spec-implement-dual-review-verify`。**args 範例見檔頭。**

- **`feature-lifecycle-auto.workflow.js`** — 頂層薄殼（零業務邏輯）：PLAN（explore＝
  feature-plan-consensus｜frozen＝plan-pipeline）→ gate（plan 沒過共識/凍結就停）→
  BUILD（可選，spec-implement-dual-review-verify）。`autoBuild` 預設 false——閘門處
  停下讓人先讀 plan。已在頂層用掉唯一一層 workflow() nesting，不可再被嵌套。
  檔頭記錄了 top-level args 掉失的 harness bug 與 JOB FILE 替代通道。**args 範例見檔頭。**

- **`codex-consensus-gate.workflow.js`** — 最小可複用 primitive：把「丟提案 → 驅動 codex
  拿高 effort 共識 → 回傳結構化裁決」收成單一呼叫。透過 agent-tmux 驅動 codex，回傳
  `{ ok, verdict, consensus(agree/agree_with_changes/disagree/unclear), notes }` 與
  `passed` 旗標。**完成訊號用「輪詢輸出檔（含 marker）」而非比中 pane**——避免 marker
  在送出 prompt 裡被 echo 誤判（本專案實戰踩過兩次的坑）。其他 workflow 的外部 rung
  可改呼叫它以收斂重複寫法。**args 範例見檔頭。**

- **`spec-implement-dual-review-verify.workflow.js`** — 功能開發主力管線：實作 spec →
  codex＋claude **平行雙審** → 只採真實且 in-spec 的修正 → 跑 `verifyCommands` 驗證並貼
  輸出。三階段（Implement／Review／Finalize），實作 agent 回 null 即早退。外部審查者
  以 `externalAgentType` 參數化（預設 `codex:codex-rescue`）。兩個 reviewer 對稱偵測：
  各自回 null 都 log 降級、return 帶 `codex_available`／`claude_available`，兩個都掛則
  在 Finalize 前 abort；finalize agent 回 null 也 abort（不把未驗證實作報成完成）。
  codex 補審 2 輪至 AGREE。**args 範例見檔頭。**

- **`docs-vs-code-audit.workflow.js`** — 文件維運：拿 `docs/` 每份文件對**程式碼真相**
  逐條查核（唯讀稽核員回 FINDINGS_SCHEMA）→ 同 scope 修補員就地改（修前再驗一次、可
  反駁就跳過、delete-candidate 只記不刪）→ 單一 agent 做全 docs/ 跨檔一致性掃（連結
  完整性、跨檔矛盾、banned residue、索引準確）。按 `groups` 切 scope、各組以
  `pipeline` 平行流動。group key 在 pipeline 內就綁進回傳（不靠事後 index，避免任一
  組 null 時標籤錯位）。契合「真相＝程式碼非舊文件」教條。**args 範例見檔頭。**

- **`root-cause-deep-dive-audit.workflow.js`** — 除錯偵查：給一個 bug 症狀，① 一個 agent
  發散 N 個候選根因（MECE）→ ②③ 每個假設以 `pipeline` 獨立流：找證據（file:line）→
  supported 者派 `VOTES` 個**對抗式驗證者**（盡量反駁、證據弱即 refuted）→ ④ 收斂排序、
  解釋因果鏈、給治根最小修正。survivor＝反駁票 < 多數決。`N`／`VOTES` 以 `Math.max(1,…)`
  防退化；**fail-closed 計票**：失敗的驗證者算反駁票，缺驗證撐不過（避免零驗證 silent
  pass）；證據 agent 失敗標 `unevaluated`、部分驗證標 `verify_incomplete`，都上呈不靜默。
  codex review 2 輪至 AGREE。**args 範例見檔頭。**

- **`design-consensus.workflow.js`** — 設計共識 judge panel（域無關）：N 個獨立設計者
  各從一個指定 angle 提案 → 互相 adversarial cross-attack（找真實使用情境下的失效點，
  並點名值得留下的部分）→ judge 合成一份「會真的出貨」的共識 spec（明列被否決者與原因）。
  領域細節全放 `args.context`（必填：背景＋任務＋硬限制）；`angles`／`outputLanguage`／
  `synthesisSpec` 可覆寫。proposer 掛掉降級續跑（<2 存活即 abort）、attacker 掛掉該提案
  標記「未受審」讓 judge 提高懷疑權重、synthesis 掛掉 abort 不以半成品充數。
  收成自 aurora-reader-homepage-consensus 一次性 run。**args 範例見檔頭。**

- **`project-direction-review.workflow.js`** — 專案方向盤點（域無關）：Understand（5 個
  並行 readers 掃 plans／pending decisions／runtime health／constraints-lessons／
  consumer-gaps，預設用探索式 prompt、可用 `args.readers` 換成專案特化版）→ Design
  （每個 lens 一份方向提案，預設 quality-first／consumer-first／automation-first）→
  Synthesize（合成單一 prioritized roadmap：P0/P1/P2、gate 標註、風險與里程碑）。
  reader 掛掉標記「證據 PARTIAL」注入下游 prompt（不當作沒事）、全掛才 abort。
  與 `plan-pipeline`（凍結計畫）互補：這支產「往哪走」，那支產「怎麼做」。
  收成自 aurora-future-direction-plan 一次性 run。**args 範例見檔頭。**

- **`design-vs-code-audit.workflow.js`** — 設計稿 vs 程式碼 drift 稽核（域無關）：
  `docs-vs-code-audit` 的姊妹篇——那支的真相是 code、對象是舊文件；這支的目標是設計稿
  （Figma／mockup／凍結 spec）、對象是現行 code。按 `sections` 分區，每區一個 finder
  （七類 drift taxonomy：MISSING/HALF_DONE/STATE_MACHINE/OVERLAP/ORDER/TEXT/STYLE）→
  每條 finding 逐一 adversarial verify（isReal／isDesignWip／severity／fixHint）。
  **design-WIP 三態**（`wip: false/'partial'/true`）：設計稿本身未完成時，缺元件不算
  code bug——這是文件稽核沒有的維度。fail-closed：finder 掛掉該區標 UNAUDITED（不是
  clean）、verifier 掛掉該條進 `unverified` bucket 上呈（不靜默丟棄）。audit-only
  （scout）；後續修復走檔頭註記的 partitioned-fix 模式（所有權互斥、SKIP+report、
  缺 asset/欄位不發明）或餵 `spec-implement-dual-review-verify`。
  收成自 25006931Paul 機的 health-coin figma 五支家族。**args 範例見檔頭。**

- **`workflow-manifest.workflow.js`** — 艦隊 workflow 快照產生器（Phase 7「再生」）：
  Scan（每台機器一個 agent，遠端走 ssh BatchMode：recipes＋`_lib`＋agents＋排氣 base
  names）→ Classify（Q1–Q5 五路判定樹**內嵌於 recipe**，每次重跑同一把尺；
  `priorJudgments` 讓已定案標籤不被翻案）→ Render（讀 `templatePath` 逐字繼承設計
  token 系統，寫出六節 Workflow Manifest HTML 到 `outPath`）。fail-closed：掃描死
  標 `unscanned`（不是乾淨）、判定死該台排氣渲染為 UNTAGGED（不隱藏）、渲染死帶完整
  payload abort。**發佈在 recipe 外**：script 無 Artifact tool，回傳 `publishHint`
  由主迴圈一行接手。收成自本 repo 的手工 manifest 產程。**args 範例見檔頭。**

## 共用 helper：`_lib/safe.js`

silent-failure 三招（`coalesceNull`／`nullIndices`／`failClosedRefutes`）的**正本**在 `_lib/safe.js`。
因 workflow script 為 self-contained（runtime 不支援 import），各 recipe 以 `// ── SAFE_LIB ──`
標記**逐字內嵌**同一份；正本改動後用 `grep -rl SAFE_LIB .claude/workflows` 找出所有副本同步。
目前內嵌者：`root-cause-deep-dive-audit`（failClosedRefutes）、`docs-vs-code-audit`
（coalesceNull＋nullIndices）、`design-consensus`／`project-direction-review`／
`design-vs-code-audit`（nullIndices）、`workflow-manifest`（coalesceNull＋nullIndices）。詳見
`.claude/memory/lessons.md` L1。

另有 **`_lib/worker-doctrine.md`**：multi-agent 實作型 workflow 的 COMMON preamble
正本（anchoring／hard tool mapping／語言 traps／scope fence／report contract 含
`DECISIONS-NOT-IN-SPEC` schema／verify 收尾）。prompt 片段用複製的，不是 import；
收成自 room-* 家族實戰 run。

與 **`_lib/findings-schema.js`**：**新**稽核/review recipe 的 finding/verdict 標準形
（severity: error/warning/info ＋ action: no-op/auto-fix/ask-user ＋ risk_level，
形狀借鑑 no-mistakes review step；ask-user 保留給「挑戰作者意圖」的 finding）。
既有 recipe 維持已過 review 的 schema，不追溯改——要 retrofit 得先過 review gate。

## 正本與同步

此目錄是 workflow 腳本的**團隊用快照**,供 clone 本 repo 的人直接 `/<name>` 叫用。
它不是編輯起點:改動應發生在來源端,再由一條獨立的 SYNC 管道流入本目錄(管道規劃中;
在它就緒前以手動複製對齊,兩份為獨立副本、不會自動同步)。因此請勿直接在此編輯作為改動源。

## 來源

- Claude Code Docs — Orchestrate subagents at scale with dynamic workflows：
  https://code.claude.com/docs/en/workflows
- Anthropic — Introducing dynamic workflows in Claude Code：
  https://claude.com/blog/introducing-dynamic-workflows-in-claude-code
