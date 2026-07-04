# Workflow & Agent 日常使用教學

對象：在**任何 repo**（工作專案、side project、別台機器）想直接用這套閉環資產的人。
參考手冊（每支 recipe 的詳細條目與 args）在 [`.claude/workflows/README.md`](../.claude/workflows/README.md)；
本文只講三件事：**日常怎麼用、新 repo 怎麼導入、用完怎麼反饋**。

---

## 0. 三十秒心智模型

```text
排程層（誰叫醒它）      cron ／ bash watcher ／ ScheduleWakeup ／ 你手打一句話
      ↓
控制流層（recipe）      ~/.claude/workflows/*.workflow.js —— 13 支，個人層＝任何 repo 都能叫
      ↓
執行體層（誰幹活）      Claude subagents ＋ 第二模型（args.cli = 任一 agent-tmux profile）
```

核心原語是**對抗共識**：重要產物（計畫、設計、實作）都由第二個模型對抗 review 到
CLEAN 才凍結。`codex`、`claude-fable-gate-glm`、`agy`……都只是 `args.cli` 的一個值，
沒有任何 recipe 綁死特定模型。

閉環骨架（單題、小時級）：

```text
稽核 audit → 接頭① findings-triage → 規劃/brief → 閘門✋(你) → 建置 → 接頭② 同參數再稽核
                                                                    └ confirmed==0 ＝ 收斂
```

## 1. 前置需求（一次性，通常已就緒）

| 需求 | 檢查方式 |
| --- | --- |
| Claude Code ≥ v2.1.154（dynamic workflows） | CLI 打 `/` 看有沒有 workflow 名 |
| 13 支 recipe 在個人層 | `ls ~/.claude/workflows/*.workflow.js`（含 `_lib/`） |
| agent-tmux 在 PATH（或 skill bundle scripts/） | `agent-tmux --help` |
| 第二模型 profiles | `ls ~/.config/agent-tmux/profiles`（codex／agy／claude-fable-gate-glm…） |

三台（hub／mbp14／25006931Paul）已由本 repo 分發對齊；新機器照
[`docs/wiki/Getting-Started.md`](wiki/Getting-Started.md) 裝 tmux-agent-tools 後，
把本 repo `.claude/workflows/` 整包 cp 到 `~/.claude/workflows/` 即可。

## 2. 怎麼呼叫（在任何 repo 的 Claude Code 裡）

```text
# A. 自然語言（最常用）——名字＋參數講清楚就行
「跑 docs-vs-code-audit，repoPath 用當前 repo，cli 用 codex」

# B. slash 簡寫（個人層被探索後）
/design-vs-code-audit

# C. canonical scriptPath（不依賴探索，腳本裡也這樣互相引用）
Workflow({ scriptPath: "~/.claude/workflows/plan-pipeline.workflow.js", args: {...} })
```

**已知 gotcha**：部分環境下 scriptPath 呼叫會掉 `args`（recipe 標頭有註記）。
症狀＝recipe 回 `aborted: missing arg`。解法：改用名字呼叫，或暫填腳本內
`BUILTIN = {...}` 跑完再還原。

**共通參數慣例**：`args.cli`（第二模型 profile，凡有對抗 review 的 recipe 都必填）、
`args.context`（一句話講清 repo 路徑＋技術棧，品質差很多）、
`args.outputLanguage`（預設繁中）。

## 3. 日常場景速查表

| 你的情境 | 用這支 | 備註 |
| --- | --- | --- |
| 懷疑文件跟 code 漂移 | `docs-vs-code-audit` | findings 走 findings-schema |
| 設計文件 vs 實作對不上 | `design-vs-code-audit` | 同上 |
| 詭異 bug 要挖根因 | `root-cause-deep-dive-audit` | 產出 confirmed findings |
| **audit 完 findings 一堆不知道怎麼消化** | `findings-triage` | 接頭①：分流成 brief／directFix／ask-user，一條不丟 |
| 有一段 brief（迷你 PRD）想全自動做完 | `feature-lifecycle-auto` | 全流程：plan→gate→build→verify |
| 只要凍結規劃文件、刻意不建置 | `plan-pipeline` | direction→plan→ADR，全部第二模型凍結 |
| 需求→實作計畫（監督式、雙關共識） | `feature-plan-consensus` | 內部 critic＋第二模型對抗 |
| 一個設計方案要對抗共識 | `design-consensus` | |
| 任意產物要過「第二模型同意」這一關 | `consensus-gate` | 通用閘；`codex-consensus-gate` 是舊名 shim（僅限頂層呼叫） |
| 照 spec 建置＋雙模型 review＋驗證 | `spec-implement-dual-review-verify` | |
| 專案「下一步做什麼」方向盤點 | `project-direction-review` | |
| 艦隊 recipe 資產快照／盤點 | `workflow-manifest` | 產出 manifest artifact，通常週跑 |

**Agent（不是 workflow）什麼時候用**：單一有邊界的任務丟後台跑完收結果
→ `tmux-delegate`（幫你判斷該不該丟）→ `claude-oneshot`／`codex-oneshot`。
多階段、有控制流（迴圈、fan-out、閘門）才用 workflow。

## 4. 標準一日閉環（範例：任意 repo 修一輪債）

```text
① 「跑 design-vs-code-audit，context: <repo 一句話>，cli: codex」
② confirmed findings 出來 → 「把 findings 餵 findings-triage」
③ 看分流結果：
   - askUser[]   → 你裁決（都是挑戰設計意圖的，機器不代決）
   - briefs[]    → 逐個「用這份 brief 跑 feature-lifecycle-auto」（計畫閘會停下等你✋）
   - directFix[] → 一次 partitioned fix run（互不重疊檔案、缺料 SKIP 回報）
④ 修完 → 「用同樣參數重跑 design-vs-code-audit」（接頭②）
⑤ confirmed==0 ＝ 這一題收斂；沒歸零就回 ②
```

你全程只出現在兩個地方：**③ 的裁決**與**計畫核准閘**。其餘機器自轉。

## 5. 導入新 repo：其實是零安裝

recipe 住個人層（`~/.claude/workflows/`），**任何 repo 開 Claude Code 都直接可用**，
不需要對 repo 做任何事。以下是可選強化：

1. **repo 級共享（給團隊）**：把需要的 recipe cp 進該 repo 的 `.claude/workflows/`
   （連同 `_lib/`），clone 的人就都能 `/name` 叫用。同名時專案層 shadow 個人層。
2. **repo 的 `CLAUDE.md` 記兩行慣例**：這個 repo 跑 audit 用什麼 `context` 樣板、
   對抗 review 慣用哪個 `cli` profile。之後一句「跑 audit」就不用重講參數。
3. **域特定 recipe 留在專案層**：像 fastlane-uat-distribute 這種綁專案的，
   放該 repo `.claude/workflows/`，不進公開 repo。

## 6. 反饋迴路：用完之後怎麼餵回來

這套資產靠三個時間尺度的環自我更新，你的日常反饋對應：

| 你觀察到 | 動作 | 尺度 |
| --- | --- | --- |
| recipe 的**措辭／文件／命名**問題 | 直接改正本（`~/.claude/workflows/`）→ wrap-check → cp 進本 repo → 分發 | 隨手 |
| recipe 的**行為**要改（prompt、schema、控制流） | **先過 `consensus-gate`**（改動的正當性來自過閘），過了才動 | 需閘✋ |
| 又寫了一次性腳本解決某 repo 的事 | 不用管——它就是排氣，下輪 harvest 會被 Q1–Q5 判定（重複≥2 次自然升 recipe） | 天級 |
| 想知道艦隊現況／懷疑三台漂移 | 重跑 `workflow-manifest`（未來掛 cron 週跑） | 週級 |
| 踩到 gotcha／assumption 錯了 | 記 `lessons.md`；影響 recipe 的補進該 recipe 標頭註解 | 隨手 |

**不變式（改東西前默念）**：

- 同步方向永遠 **個人層正本 → cp 進本 repo → 分發到工作機**，不反向。
- 語法檢查用 wrap-check（裸 `node --check` 對 top-level return 會誤報）：
  ```bash
  f=~/.claude/workflows/X.workflow.js
  { echo 'export const _wrap = async (agent,parallel,pipeline,phase,log,args,budget,workflow) => {'; \
    sed '/^export const meta = {/,/^}$/d' "$f"; echo '}'; } > /tmp/w.mjs && node --check /tmp/w.mjs
  ```
- `SAFE_LIB` 逐字內嵌，正本 `_lib/safe.js`；改動後 `grep -rl SAFE_LIB` 同步所有副本。
- `.claude/harvest/`（工作專案 transcript）永不入公開 repo。
