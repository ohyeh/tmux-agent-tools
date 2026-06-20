# Packet P7 — Design: build→ADR deviation→amendment feedback edge

Packet ID: P7
Type: design-discussion(先討論,未定案,未實作)
Status: discussion
Origin: 另一 session 的 v8 規劃輪討論(plan-pipeline 全程 codex-frozen,已推 main)。

Objective: 決定下游 ④build 撞到「凍結的 ADR/plan 假設其實是錯的」時要走的紀律機制——是否值得做成 workflow,以及「什麼程度算撞到 ADR 假設」的觸發門檻。

Context:
- 已釐清的原理:下游**不需要**每個 task 配一份 ADR——commit message / PR / tests / git history 已是 ADR 三大價值(why 存證、對抗審查、grounding、可追溯)的等價物。給每 task 配 ADR = ceremony,違反 AGENTS.md 的 No Performative Process。
- 真正的缺口:ADR 管「build 之前」,管不到「build 做到一半發現凍結設計講錯」。這條 ④→③ 的回饋邊目前無制度,風險是實作偷偷漂離凍結設計(最危險的洞)。
- 現有雛形(機制是活的,只是沒制度化):v6 `implementation-notes.md` 的 D-1..D-3 deviation log;`plan-v8.md` SC-1「新 scope 用 amendment 捕捉,不准 silent edit」;已產出的 `0002-amendment` / `0008-amendment` ADR。

Proposed proportionate ladder(討論中,源自上游對話):
| build 中遇到的決策 | 記在哪 | 對抗審查 |
|---|---|---|
| 純實作選擇(命名/拆函式) | 不記,code 自證 | 否 |
| 可逆取捨(選 lib A 不選 B) | commit / PR 一兩句 | PR review |
| 偏離凍結 plan/ADR | deviation log(context→改法→理由) | 視大小 |
| 推翻 ADR 的某假設 | 升級成 ADR amendment,回 ③ 凍結 | 是,與上游同規格 |

Open questions(待使用者定奪):
- Q1: 這條 deviation→amendment 邊要**做成一個 workflow**,還是只當**判準/checklist**?
- Q2: 「什麼程度算撞到 ADR 假設」的**判準**怎麼定(就地修正 vs 升級 amendment 的分界)?

Do not:
- 定案前不要先建 workflow / 加 ceremony。
- 不要把 v8 產品工作(P0 OIDC、ADR 內容)複製進本 artifact——那屬 `.workflow/next-direction/`。

Decision needed: Q1 / Q2 方向確定後,才決定是否展開成實作 packet。
