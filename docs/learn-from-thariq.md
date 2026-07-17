# Learn from Thariq — HTML 閘門介面與 unknown 挖掘（2026-07-04）

蒸餾來源（Thariq Shihipar，Anthropic Claude Code 團隊）：

- 《The unreasonable effectiveness of HTML》 https://thariqs.github.io/html-effectiveness/index.html （20 demos，9 類）
- 《Know your unknowns》 https://thariqs.github.io/html-effectiveness/unknowns/ （11 demos，按實作階段分）
- 公告推文 https://x.com/trq212/status/2073100352921215386 （登入牆，內容即上兩頁）

本檔定位：**下一輪動線 ⑥（人機閘門 artifact 化）與 ⑦（unknown 挖掘 recipe）的設計輸入**。
對應 roadmap：Workflow Manifest artifact §07、`handoffs/2026-07-04-workflow-pipeline-closed-loop.md` 追加段。

---

## 一、他的兩個核心論點

1. **輸出媒介**：agent 的產出該用互動 HTML artifact，不是 markdown 牆。
   diff、call-graph、多方案比較都是**空間資訊**，markdown 會壓扁；HTML 讓人
   「指」而不是「讀完三面牆再憑記憶挑」。9 類場景：探索規劃、code review、
   design、prototype、diagram、deck、研究學習、報告、**客製化編輯介面**
   （為手上這一件事造用完即丟的編輯器）。
2. **時序**：找 unknown 最便宜的位置在**寫 code 之前**。pre-implementation 8 個
   demo（blindspot pass、interview、mock-before-wire、tweakable plan…）都在
   把「你不知道自己不知道的事」提前變成可回答的問題；post-implementation
   （buy-in doc、merge quiz）處理的是「別人要繼承你的 unknown」。

## 二、殺手細節：export 按鈕（回寫機制）

每個 demo 真正的共同 pattern 不是視覺，是**「機器→人→機器」的回寫**：

- steal/skip chips 點完，回覆已經組好（four design directions）
- resonate checkboxes 勾完，自動 assemble your reply（churn brainstorm）
- copy diff 只匯出改過的 keys（feature flag editor）
- 答錯的 quiz 題把你指回沒讀懂的段落（merge quiz）

> "You stay in the loop; the loop gets tighter."

**閘門的瓶頸從來不是人看不懂，是人的裁決要重新打字才能回到環裡。**
判斷是人的比較優勢，打字不是——chips＋export 把閘門延遲從「組織語言」
壓到「只做判斷」。

## 三、跟我們閉環的關係：正交，不是競品

| 層 | 我們的 recipe（控制流） | 他的 pattern（閘門介面） |
| --- | --- | --- |
| 管什麼 | 誰跑、跑幾輪、什麼時候停 | 人怎麼看、怎麼回 |
| 現況 | fail-closed／對抗共識／收斂條件已成 | 「文字回報→人打字」，未升級 |

我們把「人退到閘門」做完了，但沒人問過「閘門本身好不好用」。
蒸餾方式因此不是「一 demo 一 recipe」，而是**每個人肉節點配一個渲染 pattern**：

```text
接頭①（findings-triage 出口）  → triage 板（accept/reject/改註 chips → 組回覆）
計畫閘✋（plan 核准）           → tweakable plan（按「易被改動機率」排序，非執行順序；選項可切換）
接頭②（re-audit 收斂後）       → merge quiz（驗證人真懂改了什麼，錯題指回原段）
```

另一面鏡像：unknown 挖掘（⑦）與 findings-triage（接頭①）互補——
一個在環的**入口**展開「未知的未知」，一個在環的**出口**收斂「已知的問題」。
我們的 L1 環從 audit 起跑，天生只服務「已有 code 可稽核」的題；
blindspot pass＋interview 補上「還沒有 code」時的入口。

## 四、31 個 demo 的案例吸收與蒸餾判定（Q1–Q5 打過）

原始頁已逐頁掃過：主頁 20 個 demo、unknowns 子頁 11 個 demo，合計 31。
其中多數頁不是單純「更漂亮的報告」，而是有 copy/export/reset、chips、
toggle、quiz、drag 等回寫或驗收動作；這也是為什麼抽象應落在
「渲染＋回寫」與「實作前 unknown 挖掘」，而不是一頁一支 recipe。

### A. `html-effectiveness` 20 案：把 markdown 牆換成可操作版面

| 章節 | demo | 可偷的手法 | 我們的落點 |
| --- | --- | --- | --- |
| Exploration & Planning | code approaches、visual directions、implementation plan | 方案並排、tradeoff 就地標、選完直接變成可交付 plan | `design-consensus` / `feature-plan-consensus` 的輸出不要只列文字，改成「可指選」的方案板 |
| Code Review & Understanding | annotated PR、PR writeup、module map | diff 旁邊放 severity / jump links；call graph 畫成盒箭圖；review 焦點先排出來 | `docs-vs-code-audit` / `design-vs-code-audit` 的 findings 可用 annotated evidence view |
| Design | design system、component variants | token swatch、component contact sheet、狀態矩陣一次看完 | design audit 不只報 drift，還要 render drift：設計 token、元件狀態、缺口並排 |
| Prototyping | animation sandbox、clickable flow | motion/interaction 用可點可調的 throwaway HTML 驗，不靠文字描述 | 新 UI feature 的 plan gate 可要求 mock-before-wire，不先進正式 code |
| Illustrations & Diagrams | SVG figure sheet、flowchart | 把流程圖、架構圖做成可點節點；圖本身就是可複製 artifact | Workflow manifest 的雙環圖方向正確，可升級成節點點開看 recipe/usage |
| Decks | arrow-key slide deck | 一個 HTML 就能開會，不需要 Keynote/export pipeline | roadmap / release readout 可輸出 meeting deck preset，不必新 recipe |
| Research & Learning | feature explainer、concept explainer | TL;DR、collapsible path、tabbed snippets、互動概念模型 | `root-cause-deep-dive-audit` 的教學段落可轉成 explainer，而不是長文 |
| Reports | weekly status、incident timeline | status/incident 用 timeline、chart、action checklist 讓人掃得完 | manifest / handoff 應保留 report 形，但關鍵數字要一致、可追證據 |
| Custom Editors | triage board、feature flag editor、prompt tuner | 直接造一次性編輯器；drag/toggle/edit 後 export markdown/diff/prompt | `gate-render` 的正本：任何人肉裁決都要有 copy/export 回寫，不只是展示 |

### B. `unknowns` 11 案：把未知放到正確時間點處理

| 階段 | demo | 可偷的手法 | 我們的落點 |
| --- | --- | --- | --- |
| Pre-implementation | blindspot pass | 掃陌生模組、歷史、flag、慣例、已 revert 嘗試；每張卡附「怎麼改 prompt」 | `unknown-hunt --mode blindspot`：先產出 better brief，再交給 lifecycle |
| Pre-implementation | teach me my unknowns | 把陌生領域做成互動教具，最後產出使用者一小時前寫不出的 prompt | 遇到非工程熟悉域時，不急著 plan，先產 domain prompt primer |
| Pre-implementation | four design directions | 4 種極端方向＋steal/skip chips，最後組成回覆 | `design-consensus` 可要求 directions 彼此足夠不同，並支援 steal/skip export |
| Pre-implementation | mock before you wire | 用假資料先做 toolbar/layout mock，A/B 問題在頁內回答 | UI/UX 變更先 mock gate，避免進正式 code 後才發現布局錯 |
| Pre-implementation | churn brainstorm | codebase-grounded 10 個介入點，按成本/野心排，checkbox 組 reply | `project-direction-review` 可用「cheap-to-ambitious」干預圖替代純 roadmap |
| Pre-implementation | interview | 一次一題，按「會不會改 architecture」排序，最後輸出決策表＋實作 prompt | `unknown-hunt --mode interview` 第一刀；零渲染依賴、最小可落地 |
| Pre-implementation | reference port | 先做 semantics map、gotcha、edge-case table，確認理解再 port | 跨語言/跨 repo 移植前先做 reference semantics gate |
| Pre-implementation | tweakable plan | plan 不照執行順序，照「人最可能改」排序；機械工作沉底 | plan gate 的正本：先讓人改決策，不要逼人讀 build checklist |
| During implementation | implementation notes | build 中記錄所有偏離 plan 的地方，整理成 attempt #2 的輸入 | 接頭②之外也要留「計畫偏離」資料，餵 re-audit / retro |
| Post-implementation | buy-in doc | prototype/spec/notes 合成可丟 Slack 的 ship-it pitch，先回答 reviewer objection | release/PR artifact 可自動產「反對意見預答」段，不只列完成項 |
| Post-implementation | change quiz | merge 前用 quiz 驗證人是否真懂 diff；錯題指回原段落 | merge quiz 等接頭②成碼後再做，作為最終人類理解 gate |

| 蒸餾成什麼 | demo 群 | 判定理由 |
| --- | --- | --- |
| **1 支 `gate-render` recipe＋模板庫**（＝動線⑥） | triage 板、tweakable plan、merge quiz、annotated PR、module map、component contact sheet | 控制流全同：吃結構化資料（findings/plan/diff）→ 套模板渲染 → 等 export 回寫。重複 N 次的抽象是「渲染＋回寫」，各板型只是 preset |
| **1 支 `unknown-hunt` recipe**（＝動線⑦） | blindspot pass、interview（按 blast radius 排序逐題）、mock-before-wire、brainstorm chips、teach-me explainer、reference-port semantics map | 有真控制流（掃描→排序提問→逐輪訪談→組 brief），產出接 feature-lifecycle-auto 的 args.brief |
| **不蒸餾——寫進 artifact 慣例即可** | design system swatch、weekly status、incident timeline、concept explainer、PR writeup | 一次性唯讀產出、無回寫迴圈；做成 recipe 是儀式（No Performative Process） |

收斂結果：31 demos → **2 支新 recipe＋一疊模板**。皆為新檔＝免閘；
掛進既有 recipe 的輸出階段（例如 findings-triage 自動接 gate-render）＝行為層，先過 consensus-gate。

## 五、已知障礙與正解

- **claude.ai artifact 是靜態頁**：CSP 擋外連，export 沒有直通管道，只能走
  「人複製→貼回對話」。成敗關鍵＝ copy-reply 按鈕的**文案設計**：複製出來的
  必須是完整可貼的指令（含決定 JSON），Thariq 的 demo 已示範正解
  （chips 的每次點選即時改寫 reply 模板）。
- **模板要吃我們既有 schema**：triage 板的輸入就是 findings-triage 的回傳
  （briefs/directFix/askUser/noOp/degraded），不要發明第二套資料形狀。
- **雙主題**：沿用 manifest artifact 的 CSS token 系統（--bg/--ink/--accent…，
  `prefers-color-scheme`＋`data-theme` 雙軌），模板庫直接繼承。

## 六、下一步建議（等使用者說開跑）

1. `unknown-hunt` 獨立開題：先 interview 模式（純提問，零渲染依賴），
   再做 blindspot pass（需要掃 code，第二階段）。理由：unknowns 原頁的
   時序論點很明確——pre-implementation 是找 unknown 最便宜的位置。
2. 首發 `gate-render` 的 **triage 板模板**——掛 findings-triage 後面，
   三個閘門裡使用頻率最高；但掛進既有 workflow 前先過 consensus-gate。
3. 其次 tweakable plan（計畫閘）；merge quiz 最後（依賴接頭②成碼，動線④）。

## 附：自我修正紀錄

- 本輪之前的偏好盲點：紀律全堆在**驗證側**（fail-closed、對抗共識、收斂），
  **發現側**（pre-implementation unknown）幾乎沒堆——unknowns 頁的時序論點
  直接照出這個不對稱。規則：設計新環時先問「入口的 unknown 誰負責挖」。
- artifact 一直被當「機器→人」唯讀報告在做；正確的問法是「這頁的 export
  按鈕在哪、複製出來的文字能不能直接貼回來」。
