# Tier-1 實作 PLAN — issue #266

> Source of truth: https://github.com/ohyeh/tmux-agent-tools/issues/266
> 範圍 = 收斂後 2.5 個功能。所有落點皆對 `skills/tmux-agent-tools/scripts/agent-tmux` 實證過。

## Goal
把 #266 的三項小型、有界增量落地:宣告式 trust/approval（含 doctor 讀數）、dry-run 預覽、result.json 必填欄位契約。每項建立在既有機制上，不新增基建。

## Success criteria
- `approval=auto|prompt` 可在 profile 宣告，預設 `prompt`（零行為變更）。
- `doctor --json` 輸出多一個 `approval` resolved 欄位。
- `agent-tmux <cli> <start-cmd> --dry-run` 印出將執行的 tmux 指令並 exit 0，不 spawn。
- profile 可宣告 `result_required_fields=a,b`，result 讀取時驗存在性，缺者標 failed（重用既有 missing_fields）。
- 既有測試/self-test 全綠；新增最小自檢。

## Current context（實證落點）
- profile parser：`agent-tmux:98-117` 的 `key=value` case 區塊（never sourced，安全）。
- doctor JSON：`doctor_session --json` 已存在（`agent-tmux:4333`）；`setup` 已 emit 合併 JSON（`:470, :4356`）。profile path 已在 `:4312` 印出。
- missing_fields：`result wait-required --fields <csv>` 與 `result validate` 已存在（`:1775` 等）。

## Constraints
- 不直推 main：開 feature branch。
- profile 維持扁平 `key=value`，never sourced。
- 不擴回 out-of-scope（見下）。

## Risks
- A 案（宣告+報告，預設 prompt）= 零行為變更，低風險。若誤改啟動路徑會動到所有 worker → 嚴守 A 案，不碰 launch_flags 注入。

## Approval required
- push feature branch：已授權。
- 任何改動啟動路徑（B 案）：**未授權**，不做。

## Work packets（disjoint，建議實作順序）
1. **P1 trust/approval + doctor 讀數**（同一功能）
   - parser 加 `approval)` arm → `PROFILE_APPROVAL`（default `prompt`）。
   - `doctor_session --json` 輸出加 `approval` 欄位。
   - 自檢：載入帶/不帶 `approval=` 的 profile，斷言 resolved 值正確。
2. **P2 result_required_fields 契約**
   - parser 加 `result_required_fields)` arm → flat csv。
   - result 讀取路徑：若宣告且欄位缺，走既有 missing_fields → 標 failed。
   - 自檢：缺欄 result.json → failed；齊全 → ok。
3. **P3 dry-run**（獨立）
   - launch 路徑加 `--dry-run`：印 resolved tmux invocation、exit 0、不 spawn。
   - 文件明寫「不驗 approval，由 P1 doctor 讀數覆蓋」。

## Integration policy
三項檔案/區塊不重疊（同檔不同 arm + 不同函式），順序提交，各自帶自檢。

## Verification
- `agent-tmux doctor` / `self-test` 綠。
- 三個 packet 各自最小斷言。
- `--dry-run` 手測印出指令且不起 session。

## Out of scope（YAGNI，撞牆再做）
worker DAG / `needs:`、quorum 聚合、budget governor、TUI dashboard、profile 繼承、`init` scaffolder、done-webhook。

<!-- ponytail: 單一 plan.md，省略 state.json/packets/results 目錄；真要多 worker 並行再 scaffold -->
