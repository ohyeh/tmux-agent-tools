# Handoff: huddle = private 領先 repo；public 回退至 v0.18.1 mirror

## Session Metadata
- Created: 2026-06-11 01:23:44
- Project: /Users/paul.yeh/github/tmux-agent-tools
- Branch: main (clean, top = `61ab5a1`)
- Continues from: [2026-06-11-000607-room-v0190-shipped-phase2-next.md](2026-06-11-000607-room-v0190-shipped-phase2-next.md)

## Current State Summary

本 session 完成兩件大事：

**1. room Phase 2 全部實作完並 shipped 為 v0.20.0**（Workflow 6 subagents 全程執行）：
- Phase 2a SSH hub（`--hub user@host` → `_room_ssh_dispatch`，printf %q quoting，ssh 255→exit 2）
- Phase 2b Cloudflare（`--hub https://...` → `_room_cf_*` + `cf-room/` Worker + Durable Object）
- 安全強化超出 spec：WS token 走 `Sec-WebSocket-Protocol`（不進 URL）、constant-time 比對、WS replay LIMIT、mktemp
- gates：codex review R1 REJECT（cf_read 空訊息要 exit 1）→ fix → ACCEPT；secrets 稽核 PASS；gemini 3 findings 修畢
- PR #257（squash `1e0b9ad`）+ Formula #258；test-room-backends-smoke 48/48

**2. repo 拓撲重組為 private-lead**（Paul 決定 room 概念先私下實驗）：
- 新 private repo **`ohyeh/huddle`**（原名 tmux-agent-tools-lab，已改名）＝領先開發 repo，本地 `origin` 指它；完整歷史 + v0.19/v0.20 tags + `.workflow/` plan docs（c5857b1）都在
- public `ohyeh/tmux-agent-tools` **force-push 回退到 `6e92ded`（v0.18.0）**，v0.19/v0.20 tags 與 Releases 已刪；remote 名 `public`
- public 清理（PR #259）：刪 task_plan.md + 27 個內部 docs，只留 README/CHANGELOG/wiki/ci-mode-exit-codes
- public 發 **v0.18.1**（PR #260/#261）+ backport Formula 引擎安裝修復（PR #262，brew test 11/11 過）
- huddle 打了 `-s ours` merge（`61ab5a1`）記錄「已涵蓋 public v0.18.1」同步點——歷史有接續感，`git log public/main..main` 乾淨

## Important Context

1. **之後開發全部在 https://github.com/ohyeh/huddle（origin）**。public 只是落後 mirror。
2. **絕對不要 `git push public main`**——private main 含 `.workflow/` 等私有檔，整支推會外洩。對外發版：從 `public/main` 開 sync branch、帶入篩選後變更、開 PR 到 public。
3. **GitHub 殘留**：public 的 merged PR #252/#253/#257/#258 頁面與 diff 不可刪，room 程式碼仍可從 PR 頁看到（無 secrets，已稽核；Paul 知情）。
4. **secrets 稽核 gate 是硬性要求**（memory: feedback-room-secrets-audit-gate）：room/CF 相關 PR 前必掃 diff；cf-room 的 `.dev.vars*`/`.wrangler/`/node_modules 已在 .gitignore。
5. **回退 public 歷史的操作程序**：先 `gh api -X PUT .../rulesets/16476237 -f enforcement=disabled`，再 DELETE branch protection，force-push，然後照原設定 PUT 還原兩者。
6. Formula 修復不需新 tag（Formula 在 tap main、不在 tarball）。public Formula 現在已含 `bin.install agent-tmux`。
7. 發版慣例更新：**每次發版都建 GitHub Release page**（Paul 看 Releases 頁；v0.16–v0.19 補建過，v0.19/v0.20 已隨回退刪除，public 現存最新 = v0.18.1）。
8. gh GraphQL 間歇 401——PR create/merge 走 REST；resolveReviewThread 必須 GraphQL，401 就重試。

## Decisions Made

- room 概念先在 private 多實驗一段時間；public 當落後 mirror（Paul）
- 不 rebase huddle onto public v0.18.1——public 沒有 huddle 缺的內容，rebase 反而會 replay「刪內部文件」；改用 `merge -s ours` 記同步點
- private repo 命名 `huddle`（Paul 選的，要避開 tmux 字樣）
- WS 認證棄 query-string token（spec §6.3 已更新）

## Immediate Next Steps

1. **之後的 session 直接在 huddle（origin/main）開發**，room 概念繼續實驗（可 dogfood：multi-agent 任務讓 workers 用 `room post/read` 互通）
2. 要部署 Phase 2b 時：`cd cf-room && wrangler deploy` + `wrangler secret put ROOM_TOKEN_<TEAM>`（cf-room/README.md）
3. 未來對外發版：從 public/main 開 sync branch → 篩選變更 → public PR → tag/Release/Formula 照 release checklist

## Critical Files

- `skills/tmux-agent-tools/scripts/agent-tmux` — engine（room local + ssh + cf backends）
- `cf-room/` — Cloudflare Worker + DO（概念上 private only，住在 huddle）
- `scripts/test-room-backends-smoke` — 2a/2b 測試（fake ssh/curl PATH shim；注意 macOS path_helper 要設 ZDOTDIR 隔離）
- `.workflow/agent-tmux-room-chat-style-team-communication/implementation-notes.md` — 全部決策紀錄（已 commit 進 huddle）
- `docs/design-room-phase2a-ssh-hub.md` / `docs/design-room-phase2b-cloudflare.md` — Phase 2 specs（§6.3 已更新 WS 認證）

## Potential Gotchas

- 本地 remotes：`origin`=huddle（private）、`public`=tmux-agent-tools。gh 指令在 public 操作時要 `--repo ohyeh/tmux-agent-tools`。
- huddle main 與 public main 內容大幅分岔是**刻意的**（內部文件、room、版本號），不要「同步」它們。
- public Formula test 斷言 = `agent-tmux - run Claude Code in tmux`（engine 共用靜態 usage 首行），別當 bug。
- subagent 共用 working tree 會互切 branch——平行開發用 worktree 隔離。
