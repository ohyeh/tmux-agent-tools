# Learn from Thariq — HTML 閘門介面與 unknown 挖掘（2026-07-04）

蒸餾來源（Thariq Shihipar，Anthropic Claude Code 團隊）：

- 《The unreasonable effectiveness of HTML》 https://thariqs.github.io/html-effectiveness/index.html （17 demos，6 類）
- 《Know your unknowns》 https://thariqs.github.io/html-effectiveness/unknowns/ （12 demos，按實作階段分）
- 公告推文 https://x.com/trq212/status/2073100352921215386 （登入牆，內容即上兩頁）

本檔定位：**下一輪動線 ⑥（人機閘門 artifact 化）與 ⑦（unknown 挖掘 recipe）的設計輸入**。
對應 roadmap：Workflow Manifest artifact §07、`handoffs/2026-07-04-workflow-pipeline-closed-loop.md` 追加段。

---

## 一、他的兩個核心論點

1. **輸出媒介**：agent 的產出該用互動 HTML artifact，不是 markdown 牆。
   diff、call-graph、多方案比較都是**空間資訊**，markdown 會壓扁；HTML 讓人
   「指」而不是「讀完三面牆再憑記憶挑」。六類場景：探索規劃、code review、
   design、研究學習、報告、**客製化編輯介面**（為手上這一件事造用完即丟的編輯器）。
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

## 四、31 個 demo 的蒸餾判定（Q1–Q5 打過）

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

1. 首發 `gate-render` 的 **triage 板模板**——掛 findings-triage 後面，
   三個閘門裡使用頻率最高。
2. 其次 tweakable plan（計畫閘）；merge quiz 最後（依賴接頭②成碼，動線④）。
3. `unknown-hunt` 獨立開題：先 interview 模式（純提問，零渲染依賴），
   blindspot pass 需要掃 code，第二階段。

## 附：自我修正紀錄

- 本輪之前的偏好盲點：紀律全堆在**驗證側**（fail-closed、對抗共識、收斂），
  **發現側**（pre-implementation unknown）幾乎沒堆——unknowns 頁的時序論點
  直接照出這個不對稱。規則：設計新環時先問「入口的 unknown 誰負責挖」。
- artifact 一直被當「機器→人」唯讀報告在做；正確的問法是「這頁的 export
  按鈕在哪、複製出來的文字能不能直接貼回來」。
