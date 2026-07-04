# Session handoff — workflow 資產管線走完 7 phase＋閉環第一輪（2026-07-04）

## 完成

- **7-phase 管線收官**：61 支排氣腳本 → 47 base names 全數過 Q1–Q5 判定 →
  收斂＋優化 → 快照（Workflow Manifest artifact）→ 分發（三台全對齊，實測
  13 支＋_lib×3、tmux-delegate.md hash 9595f88f 一致）→ 再生（`workflow-manifest`
  recipe，manifest 從此自我再生）。
- **閉環第一輪改動**（commit `e409f60`）：
  - `consensus-gate`：`codex-consensus-gate` 中立化改名（reviewer＝`args.cli`
    任一 agent-tmux profile；命名也是 API）。行為逐位元不動；舊名降 Q2 preset
    shim（僅限頂層——它花掉唯一一層 workflow() nesting）。
  - `findings-triage`（NEW，閉環接頭①）：稽核 findings 按 findings-schema action
    語意＋根因分群三路分流（迷你 PRD→feature-lifecycle-auto／directFix→
    partitioned-fix／ask-user→人）。fail-closed 底線：一條 finding 都不丟。
  - plan-pipeline／feature-plan-consensus／spec-implement 措辭中立化
    （codex → second-model via args.cli）；README 校正陳舊描述。
- **Manifest artifact**：新增 §00 雙循環軌道圖（內圈單題閉環六站、外圈排程層
  四站、人工閘門標橘；SVG 吃頁面 CSS token，雙主題自適配）。
  https://claude.ai/code/artifact/6733cfaf-836a-4ab8-ba9d-89a67c80ac2f

## 閉環現狀（四塊拼圖）

1. 控制流層 ✅ 13 支（12 recipe＋1 shim）
2. 執行體層 ✅ profiles 多樣化（codex/claude-fable-*/agy/gate-glm/gate-gpt）
3. 接頭 ◐ 接頭①（findings-triage）已落地；接頭②（re-audit 停止條件）在呼叫端，
   慣例已寫進 findings-triage 的 `nextStep`
4. 排程層 ⏳ 未動——最便宜第一刀＝cron 掛 `workflow-manifest`；事件 watcher
   （firstmate wake-queue 模式）是 repo issue 級後續

## 待辦（行為層，照紀律先過閘再動）

- **統一 gate `reviewers[]`**：內外對抗收斂成一個原語
  （`[{kind:'profile'|'inline', ...}]`＋quorum）。建議用 design-consensus
  自己設計自己（reviewer 混編 codex＋glm＋agy 當第一次 demo）。
- **計畫家族二合一**：feature-plan-consensus＋plan-pipeline → 單支
  plan factory（`mode: explore|frozen`）。
- degraded-return 統一（6 支舊 recipe，前輪已識別）。
- fastlane-uat-distribute → healthgo 專案層收成（域特定，不進公開 repo）。
- 低優先：smoke-* 與 552 orphan state dirs 實體清理；pr-review-triage-resolve 落地另議。

## 追加（v0.31.0 之後；靈感源 Anthropic《unreasonable effectiveness of HTML》＋《Know your unknowns》）

- 已出貨：`using-workflows` meta-router skill（英文 SKILL.md＋recipe bundle＋
  `scripts/install.sh` 拒改覆寫）、`docs/workflow-usage-guide.md` 教學、
  **v0.31.0 release**（tag＋GitHub release＋Formula bump）。階梯頂層「畢業進產品面」
  第一步已踏出。注意第三份副本：`skills/using-workflows/workflows/` 是部署快照，
  `.claude/workflows/` 更新後要 cp 對齊（README 已記）。
- **⑥ 人機閘門 artifact 化**（渲染器新檔＝免閘；掛進既有 recipe＝過閘）：
  三個人肉節點升級成互動 HTML＋export 回寫——接頭① triage 板（accept/reject
  chips 組回覆）、plan 閘 tweakable plan（按易改機率排序）、接頭②收斂後
  merge quiz 驗收。核心 pattern＝「export 按鈕把 UI 操作轉回可餵 agent 的文字」。
- **⑦ unknown 挖掘 recipe**（免閘新增）：blindspot pass＋interview（按 blast
  radius 排序提問）→ 產 brief 前置，接 feature-lifecycle-auto 之前。

## 不變式提醒

- `.claude/harvest/` 含工作專案 transcript，gitignore 白名單外——永不入公開 repo。
- 同步方向永遠 repo → 個人層 → 工作機；正本改動先在 `~/.claude/workflows`，
  cp 進 repo，wrap-check（裸 node --check 會誤報 top-level return）。
- SAFE_LIB 逐字內嵌，正本 `_lib/safe.js`；改動後 `grep -rl SAFE_LIB` 同步所有副本。
