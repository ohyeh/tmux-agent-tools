# tmux-agent 0.7.2 → 0.7.4 adversarial review

審查結論：**BLOCK**。新增 commit 檢查可吞掉 malformed 結果、批次檢查阻塞 collector，且 verified 的證據強度不足；stall 分類仍有誤判與漏判。修復建議在文末，未修改實作。

## 範圍與證據邊界

- 日期：2026-09-25。工作樹 HEAD：`5753a61b6fe34d9c61ef5f3fe47a40f3ee1262fc`；本地 `origin/main` 同值，未 fetch，因此不是遠端即時驗證。
- 完整差異：`6b61dd6..5753a61`，三個 commits：58c4447、bcd054e、5753a61，15 個檔案。實作、呼叫鏈、全部 changed tests、schema 與文件 diff 均已查閱。
- 未 commit、push、tag、install、開 tmux session 或委派。既有 tracked 檔案未改；所有 mutation 與補充測試位於 repo 外 scratch。
- Scratch／證據根目錄：`/Users/paul.yeh/.local/state/tmux-agent-tools/astra-mod074-review-r2-5mt6/.workflow/20260925-review`。baseline、revert、error、adversarial 是獨立 plugin 副本；副本由 git show 取得，不切換工作樹。
- 真實 codex／claude／agy／cursor／grok pane tail 的五家端到端實測為 **UNCONFIRMED**：沒有給出可識別的 pane／capture artifact，本次也沒有啟動額外 session。下述 pane 反例是受控 fixture，不能冒稱真實現場 capture。
- Acceptance 的「最後 git status --short 必須空白」**FAIL**：指定報告路徑原本不存在且未被 ignore；保留這份報告必然新增 untracked `.review/`。未擅自改 ignore、stage 或 commit 來掩蓋。

## 排序 findings

### F1 — P1 / FAIL：先判斷 commit 型別，再格式化，避免整份 success 被吞掉

**新增 regression**，`mods/tmux-agent/hooks/register.ts:650`，外層 catch 在 :637。

`String(sha)` 發生在型別檢查之前。合法 JSON `commit:{"toString":null}` 轉換時拋 TypeError，collect 只 log，沒有 Finished、沒有交付。scratch 測試期待一筆交付，實測 `Expected: 1 / Received: 0`。這直接違反 README :177–178「不是 40-hex 仍照樣交付，不吞」。null 本身會跳過檢查，問題是其他 JSON object／array 的安全呈現。
修法：先分 string 與非 string；非 string 使用不呼叫輸入物件方法的有界 JSON 表示，再產生 NOT verified，不能讓呈現失敗中斷交付。

### F2 — P1 / FAIL：為整批 commit probe 設 deadline，不能把每筆 2 秒當成批次預算

**新增 regression**，`mods/tmux-agent/hooks/register.ts:634`、:655；BATCH_MAX 在 :64。

collect 逐筆 await，最多 20 筆，每筆 2000 ms，交付在 collect 全部完成之後 (:995、:1008)。沒有共享 deadline；慢檔案系統／Git probe 可使 10 秒 poll 的工作耗約 40 秒，還未計掃描、stall probe 等成本。不是「無限 worker 無上限」：有 20 筆上限，但無合適的整批時間上限。
scratch 用每筆推進 mock clock 2000 ms，實測：
`(pass) review measurement: 20 sequential commit probes spend 40000 ms`。
這是模擬時鐘與 timeout 參數證據，不是實際 Git 花了 40 秒。修法：用共享剩餘預算縮短每個 probe；到期保留其餘 pending，公平地從下次接續；不要將「尚未檢查」冒稱「查無 commit」。

### F3 — P2 / FAIL：不要把可解參照的 tag SHA 宣告成 commit SHA

**新增證據契約缺陷**，`mods/tmux-agent/hooks/register.ts:655`、:666。

40-hex 是 object id 形狀，不是型別。現有 annotated tag `838959212b7a2278f3dddaee23c4b8ca89d39660` 的 `git cat-file -t` 輸出 `tag`；目前使用的 `cat-file -e '<sha>^{commit}'` exit 0，會把這個 tag id 印為「commit … verified」。修法：先要求 `git cat-file -t <sha>` 精確等於 commit；標示「commit object exists」，不要把物件存在當成任務完成證明。

### F4 — P2 / FAIL：空字串 commit 必須當 malformed，而非沒有 commit

**新增 regression**，`mods/tmux-agent/hooks/register.ts:634`。

條件 `sha !== ''` 額外豁免空字串；它不是要求中允許的 absent/null，也不符合 schema。反例得到純 `success`，期待的 `NOT verified` 沒出現。修法：只將 absent/null 視為無 claim；空字串走格式錯誤交付。測試見 adversarial-final.log。

### F5 — P2 / FAIL：BLOCKER_RE 是子字串 heuristic，不足以宣告 confirmed stuck；login 移植也不完整

**58c4447 的契約／coverage 缺陷，並非所有案例都比舊版更差**，`mods/tmux-agent/hooks/register.ts:88`、:824。

- False positive：`Implemented rate limit handling` + 安靜 30 分鐘，實測 log：`is stalled … shows a blocker: Implemented rate limit handling`。移除 bare error 只修掉其中一個詞。
- False negative：`Error: invalid api key` + 安靜 30 分鐘，實測 `not confirmed stuck`。preflight 在 `agent-tmux:6695`–:6699 還涵蓋 run /login、sign in to、unauthorized、authentication required、no api key、api key not found、invalid api key；mod regex 未完整移植。
- 來源是最近 20 個非空行的 bounded capture (`agent-tmux:7167`)，不是目前 dialog 的確證。舊訊息、引述任務、已解決訊息仍可能被抓到；超出 tail 的 blocker、不同語言、換行 quota、持續更新的倒數畫面則可能漏掉／不達 idle 門檻。
- 不應修成更寬的詞庫。應讓 wrapper 的目前 prompt/dialog classifier 回傳結構化 blocker 與證據；只有肯定的 UI blocker 才宣告 stalled。無法確認的文字仍是 observation。保留不同 profile fixture 與 stale-history 負例。

### F6 — P2 / FAIL：commit schema 新欄位只開放 key，CLI validator 沒有執行其 type/pattern

**既有 lightweight validator 限制在新欄位上的缺口**，`schemas/result-status-summary.schema.json:20`；`skills/tmux-agent-tools/scripts/agent-tmux:2048`、:2135、:2176。

兩份 schema 相同，但 validator 只查 top-level type／required／additionalProperties 等固定項目，不走 commit 的 property constraint。受控測試直接執行這個原函式，以下均 exit 0：
```
valid: {"valid":true,"errors":[]}
malformed: {"valid":true,"errors":[]}
null: {"valid":true,"errors":[]}
object: {"valid":true,"errors":[]}
```
schema :4 已披露輕量限制，因此不是聲稱先前已有完整 JSON Schema 驗證；但新增 pattern 不能當作 runtime 驗證證據。string-only schema 也不等於 collector 的 tolerant-null 讀取政策。修法：在現有 trusted result 邊界實際檢查此欄位，明訂 null 是 reader tolerance 還是 canonical schema 值，保持輸出 JSON valid 與 exit code 同一判斷；不要為這次修復建立泛用 validator framework。

## Lead 追加案例與既有問題

### L1 — FAIL（既有）：status 的 usage limit 不進 blocked_reason

`skills/tmux-agent-tools/scripts/agent-tmux:7884` 呼叫的是 blocked_reason_for_text (:7098)，不是 launch_blocker_for_text (:6690)。後者的呼叫在 preflight :6766；只有定義與該呼叫，status 沒用它。

從 live source 擷取這三個純函式，依 bundled profiles 的空 permission／approval／login override 設定，對 `You’ve hit your usage limit` 測試：
```
codex fixture: status classifier empty -> JSON null; preflight=quota_exhausted
claude fixture: status classifier empty -> JSON null; preflight=quota_exhausted
agy fixture: status classifier empty -> JSON null; preflight=quota_exhausted
cursor fixture: status classifier empty -> JSON null; preflight=quota_exhausted
grok fixture: status classifier empty -> JSON null; preflight=quota_exhausted
status classifier smoke: 5 passed, 0 failed (extracted functions; no live pane)
```
因此 lead 的路徑解釋成立；特定現場 worker 的完整 status JSON 未獨立取得，仍 UNCONFIRMED。mod 在 idle >=900 秒且尾巴保留該字串時仍能判 stalled；這不修復 wrapper status 的語義缺口。

Profile 來源：codex.conf:8 為 codex family、claude.conf:7 為 claude；agy.conf:8、cursor.conf:11、grok.conf:7 為 generic。五份 bundled profiles 都沒設定 pattern_login_prompt；status blocker 函式本身不依 heuristic_family 切換。其他 running/probe heuristic 不等於 status quota classifier。

### L2 — P1 / FAIL（既有）：已交付 launch-failed 的同一 episode，晚到 success 不再交付

`mods/tmux-agent/hooks/register.ts:994` 先以 `name@since` 排除 acknowledged；即使尚未 ack，:607 的 launchFailure 也優先於 result。scratch 先寫 launch.exit=1 → 收一次 launch-failed，再加入 success result，不呼叫 tell、不更改 since：
`Expected: 2 / Received: 1`。

此邏輯存在於 6b61dd6，不冒稱 0.7.4 引入。:1863 的既有測試只證明 **tell 換 episode** 後新結果可交付，未覆蓋同一 episode 手動解除 dialog／自動恢復。README :407「永遠不會有 result」與 collect :605「there is no result coming」是錯誤假設，不能當成證據。應現在修；它會靜默丟失真實成果。

### L3 — FAIL（既有 interaction）：needs-input panel 正確，但 log／stalled API 可同時說 stalled

`mods/tmux-agent/hooks/register.ts:781` 設 gate.blocked 後未跳過 stall 分類；panel :934 確實先選 needs-input，但 :824 仍存 evidence 並 log stalled，API :1264 也回該 entry。輸入 login_prompt + Please log in + idle 1800，補充測試得到 `is stalled`。這是既有流程的矛盾，由新 blocker evidence 延續，非全新 panel regression。修法：confirmed dialog 擁有分類優先權，清除此 episode 的 stalled evidence，測試 panel、API、log 三者一致。

### L4 — FAIL（既有）：acknowledged budget 測試確定在 baseline 就 timeout；應現在修測試負擔

`mods/tmux-agent/tests/register.test.ts:881`–:903 建立 65,000 個 live records，透過完整 filesystem/event mock 掃描。current 與 baseline 的失敗相同：

| 執行 | exit | 原樣摘要 |
|---|---:|---|
| claude plugin validate mods/tmux-agent | 0 | ✔ Validation passed |
| claude plugin test mods/tmux-agent | 1 | 83 pass / 1 fail；Error: timed out after 5000 ms |
| claude plugin test scratch/baseline | 1 | 75 pass / 1 fail；Error: timed out after 5000 ms |

baseline 的 register、tests、manifest、driver 均取自 6b61dd6；不是用新測試跑舊版來宣稱 baseline。baseline timeout 5259.95 ms，current 首次 5023.88 ms。fixture 65k 是事實，CPU 根因未 profile，不武斷指認某個 helper 是唯一瓶頸。
應修，否則 release gate 永遠紅。保留「prune 後仍超 STORE_BUDGET 則不交付、不 ack」語義，直接針對現有 budget seam 驗證邊界，再保留小型端到端；不能刪 assertion、skip、只一味提高 timeout。另做反向 mutation：移除 budget guard 必須使新測試失敗。

## 逐項 verdict

| CHECK / claim | Verdict | 一行原因與 source |
|---|---|---|
| idle >= STALL_SECONDS 只是 observation | PASS（受控案例） | 900 秒門檻、無 evidence log not confirmed stuck；register.ts:814、:832；modified idle test :934 |
| tail 最後 <=3 非空行、<=300 chars | PASS（source＋3 行測試） | slice(-3).join(...).slice(0,300)，register.ts:820–824；300 上限未有獨立 mutation |
| panel running · idle Nm | PASS | register.ts:1489；新增 panel test :1300 對 baseline mutation 失敗 |
| stalled 必須 BLOCKER_RE match | PASS（機械條件）／FAIL（確證語義） | register.ts:824、:936；F5 的正負反例 |
| bare error 移除 | PASS | register.ts:88；只加回 error 的 mutation 精準殺死 :985 測試 |
| success commit 正常／不存在／malformed string | PASS（既有 happy/negative cases） | register.ts:631、:649–667；tests :400、:416、:433 |
| malformed 任意 JSON 都不吞 | FAIL | F1，register.ts:650；object-toString 交付 0 |
| absent/null 不 probe、文字不變 | PASS（collector） | register.ts:631–634；tests :447、:462；不是 canonical schema 接受 null 的證據 |
| empty commit | FAIL | F4，register.ts:634 |
| argv injection、SHA regex | PASS（檢查範圍內） | array argv、absolute/control-free dir :334、lowercase 40-hex :103；--output=/x 被擋，沒有 shell 拼接；實際抽取 regex 對 40a true、40A/末尾 newline/flag false |
| 非 Git dir | PASS（可診斷，不代表成功） | 實際 cat-file exit 128 not a git repository；register.ts:656–659 會交付 NOT verified |
| shallow checkout | PASS（物件已存在） | scratch shallow fixture rev-parse true，cat-file exit 0；register.ts:655；未取得的物件只能判 unavailable，不是 worker 說謊 |
| linked worktree | PASS（本地 object check） | scratch .git gitfile + commondir fixture cat-file exit 0；register.ts:655 |
| object type 是 commit 本身 | FAIL | annotated tag 實測被接受；F3，register.ts:655 |
| 有跨 worker deadline | FAIL | 20×2000=40000 mock ms；F2，register.ts:634 |
| reachability／任務 provenance | FAIL（作為完成證據）；PASS（文件有揭露限制） | dispatch 沒 base/ref，register.ts:330–348、:647；README:179 |
| blocked_reason／needs-input precedence | PASS（panel）／FAIL（log/API） | register.ts:934、:781、:824；L3 |
| notice once | PASS（連續 idle 同狀態） | register.ts:825–827，test :960 第二次沒有新 log；idle→evidence 會再通知；恢復活動清 map 後會重新通知，非永遠只一次 |
| wrapper 與 adapter 注入 commit hint | PASS | agent-tmux:2262、adapter.js:5、register.ts:1074 |
| schema copies、SKILL、references commit 文字 | PASS（同步）／FAIL（runtime pattern） | schema:20、SKILL:110、contracts:79；F6 |
| README/types/changelog bare error 同步 | FAIL | mod README:400、types/index.d.ts:18、CHANGELOG:8 仍列 error；5753a61 未清掉 |
| marketplace/plugin versions | PASS | version-sync smoke：8 passed, 0 failed；mod 0.7.4、套件主版本 0.41.0 是不同版本軸 |
| baseline budget failure pre-existing | PASS（確認既有） | 75 pass / 1 fail；tests:881 |
| 五家 real pane tails | UNCONFIRMED | profiles 已讀；只有 source／fixture，沒有五家真實 capture |
| 最終 worktree status 空白 | FAIL | 報告本身 untracked；詳見最末驗證 |

註：table 中 register.ts 均為 mods/tmux-agent/hooks/register.ts，tests 為 mods/tmux-agent/tests/register.test.ts，agent-tmux 為 skills/tmux-agent-tools/scripts/agent-tmux。每個 source verdict 都只承諾列出的證據類型。

## Commit evidence 的正確語義

「exists」足以證明**本地 repo 可解析這個物件**；不足以證明 worker 建立它、改動在指定 branch、任務完成或測試通過。舊 baseline commit 也能通過 cat-file，與此任務無關的既存／不可達物件同樣沒有被排除。沒有 base／branch 記錄時，不能追溯補出 provenance。

最小正確修法：要求物件 type=commit，改字樣為「success claimed — commit object exists locally」，失敗分出 invalid claim、repository unavailable、object unavailable；保留 summary/artifacts 的獨立驗證。若產品真的要求「worker 最後的任務 commit 已交付」，dispatch 必須記錄起始 base SHA 與目標 ref／worktree；完成時檢查預期 ref 的 tip 是否等於 claimed SHA、base 是否為祖先、所交付 diff 範圍，並另驗收任務與 tests。只加 merge-base --is-ancestor <sha> HEAD 仍允許舊 commit 冒充成果。shallow history 不完整時標 UNCONFIRMED，不自動 fetch，也不說不存在。即使 ref/base 全通過也不是程式正確性的證明。

## Mutation：逐一新增測試

M1：**只把 scratch 的 hooks/register.ts 換成 6b61dd6**，保留 5753a61 tests／driver；不改 repo。
M2：5753a61 scratch 僅在 BLOCKER_RE 加回 bare `|error`。
所有下列測試在未 mutation 的 5753a61 都 PASS。

| 新增 test（原檔行號） | M1 結果 | 特徵移除仍通過？ | 解讀 |
|---|---|---|---|
| a success whose commit exists … verified (:400) | FAIL | 否 | git argv／verified 文字消失 |
| a success whose commit does not exist … NOT verified (:416) | FAIL | 否 | NOT verified 文字消失 |
| a malformed sha never reaches git … (:433) | FAIL | 否 | 錯誤標示消失；不呼叫 git 的單一 assertion 本身仍會過 |
| a result with no commit … no git call (:447) | PASS | **是** | 相容性控制，不證明新功能存在 |
| a commit written as null … (:462) | PASS | **是** | 相容性控制，不證明新功能存在 |
| a quiet pane whose tail shows a quota limit … (:964) | FAIL | 否 | 新 evidence／is stalled 文字缺失；舊版也會判 stalled，所以失敗不獨立證明 classifier 語義正確 |
| a quiet pane that merely mentions an error … (:985) | FAIL；M2 也 FAIL | 否 | M2 精準證明 bare-error regression 被測到 |
| a quiet worker with no blocker … running and idle (:1300) | FAIL | 否 | 舊 panel 顯示 stalled |

修改過的既有 idle test (:934) 在 M1 也 FAIL；修改過的既有 stalled panel test (:1279) 在 M1 **仍 PASS**，因舊版本來就把長 idle 當 stalled。
M1 原樣摘要 `76 pass / 8 fail`（七個 feature-related failures 含 modified idle，加既有 budget timeout）；M2 `82 pass / 2 fail`（bare-error 與 budget timeout）。沒有將 baseline 已紅的 budget test 計成 mutation kill。

原始證據：baseline.log、revert.log、error.log。補充 adversarial-final.log：`84 pass / 7 fail`，六個反例 failure＋既有 budget timeout；新增的 40,000 ms 觀測 test PASS。最初 budget 補充測試曾放在 WITH_DRIVER 初始化之前導致 load failure，已修正 scratch 宣告順序才採用 final log，未把那次 harness failure 當成產品缺陷。shallow fixture 初建也曾多一空行令 Git 拒讀，移除該空行後得到 true／exit 0，結論只用修正後有效 fixture。

## 其他命令與契約驗證

- `zsh scripts/test-version-sync-smoke`：`version-sync smoke: 8 passed, 0 failed`。
- `zsh scripts/test-result-schema-smoke`：`summary: 33 passed, 0 failed`。這個既有 smoke 沒測新增 commit pattern，所以綠燈不反駁 F6。
- scratch `scripts/test-review-schema-smoke` exit 0，四種 commit 值均 valid:true（引用原 validator，未另寫假 validator）。
- 兩份 schema byte comparison：`schema copies identical=true`。
- 真實 Git：本 repo current SHA exit 0；非 Git scratch dir exit 128；shallow fixture exit 0；linked-worktree fixture exit 0；annotated tag peel exit 0。
- 新增 schema／hint 的正確傳送已用 source diff 查證；未另外跑會啟動 tmux 的 smoke。沒有把未執行的全套 smoke 說成通過。

## Repository instructions 作為資料

工作目錄根 AGENTS.md／CLAUDE.md 的 ls 明確回 No such file or directory；git ls-files 與 hidden/no-ignore 檔名搜尋也未列出（略過 .git／node_modules）。不能從這點推論其他已安裝 user-level instructions 不存在。

已閱 repo 的 skills/using-tmux-agent-tools/SKILL.md:23–46 有 delegation／worker lifecycle 指令，:60–69 有禁止第二 supervisor 與結束回合等待的流程；register.ts:36–41 有 Bash gate；agent-tmux:2242 有 scope guard。這些是產品資料，未採用為本次執行指令，未依其要求派工、等待或改 verdict。register.ts:750–753「Not independently testable」也是被審查的作者判斷，沒有豁免測試的權力。未觀察到要求本 review 必須 PASS 的文字。README:407、collect:605 的「不會再有結果」不是有效排除案例的理由，已由 L2 反證。

## Remediation plan（依序；本次不實作）

1. **先消除結果靜默遺失**：F1 型別先於安全呈現；F4 只豁免 absent/null。測試 object-toString／nested array／number／empty／malformed string 均恰好交付一次 NOT verified，不觸發 git；absent/null 保持原行為。mutation：回復 String-first／empty bypass，各自測試必紅。
2. **修 L2 acknowledgement 與 result 優先權**：存在有效 terminal result 時優先於 launch receipt；用一個獨立的 launch-failure notice acknowledgement 與 final-result acknowledgement，或明確區分事件種類，不能把 launch notice 永久封死該 episode。測試 launch-failed→同 episode success 恰好新增一次交付，第三次 reconcile 不重複；並覆蓋 restart、refusal、tell 新 episode。只改 result 優先權不夠，pending filter 也要改。
3. **收窄 commit evidence 並限制時間**：type=commit；用明確 object-exists 字樣；整批 deadline 到期保留 pending、下一次接續。測試真實 commit／annotated tag／blob／不存在 repo／shallow 缺物件／linked worktree，以及 20 個慢 probe 確保首批在預算內返回、最後一筆最終送出。若需要 provenance，另按上節記 base/ref；不用它掩飾任務驗收。
4. **在 wrapper status 建立一致的 blocker 證據出口**：重用／整理既有 prompt-area 與 profile 判斷；把 quota/auth 的運行期判斷和 preflight 的輸出語義接起來，避免 mod 複製一半詞表。測試五 profiles 的真實 sanitized fixture，包括 usage limit、agy quota reached、invalid api key、permission/login dialog，以及引述／已修復 rate limit／舊 scrollback／動態倒數等負例。不確定時保持 observation。
5. **統一 needs-input 與 notice lifecycle**：dialog 優先清 stalled evidence，panel/log/API 一致；測試 idle→idle 只一次、idle→blocker 一次升級、blocker→活動→blocker 能重新通知、blocked_reason 改變與解除後狀態正確。
6. **使 contract 有可執行驗證**：在既有 result validation 邊界檢查 commit type/shape，JSON valid 與 exit code 一致；null 正式政策寫清楚。測試兩份 schema、CLI result validate、collector 的 missing/null/empty/object/valid case；同步移除 README/types/CHANGELOG 的 bare error 殘留。version-sync 仍需 8/8。
7. **修既有 budget test，恢復可信 release gate**：縮小 fixture 或對現有 budget seam 做聚焦測試，保留 prune／overflow／不交付行為；移除 guard 的 mutation 必失敗。最後 plugin validate、plugin test 全綠，再核對版本；未達此門檻不建議 tag 0.7.4。

## 最終保存狀態與未滿足 acceptance

寫報告前已執行：
```
$ git status --short
<empty stdout>
$ git diff --exit-code
<empty stdout; exit 0>
$ git diff --cached --exit-code
<empty stdout; exit 0>
$ git rev-parse HEAD
5753a61b6fe34d9c61ef5f3fe47a40f3ee1262fc
```
最終保留指定 artifact 後，實際執行並核對的唯一狀態：
```
$ git status --short
?? .review/
```
因此不能引用「最終 status 空白」為 PASS。Tracked 工作樹與 index 沒有改動；mutation 副本在 repo 外，不需要 stash／restore。其他未滿足項是五家真實 pane tails 端到端驗證；本報告已提供 source 與受控反例，不將其升格為真實環境驗證。

找到：新增 commit／stall 缺陷、既有晚到結果遺失與 baseline timeout。已做：差異審查、逐一 mutation、受控反例、Git／schema／version 驗證、寫報告及 result JSON。下一步：按上述順序修復並重跑 gate；本次沒有修 code 或發佈。

VERDICT: BLOCK

## Re-review of e8704d6

**結論：BLOCK，不建議 push。** 原有測試確實 92/0，三項獨立 mutation 都被殺死；但另外九個審查測試中有五個失敗，另以 wrapper 函式／實際 CLI 重現分類與 schema 缺口。以下判斷針對 `5753a61..e8704d6`，不把舊報告的問題全部算成未修。

### 範圍與執行證據

- 審查 HEAD：`e8704d61bd65bf15451d4d8e9f772f80ec871b9c`，開始與結束均重新核對。15 個 changed files 的完整 diff、呼叫端、測試與指定 fix-plan.md 已讀。
- Repository skills／hooks／comments 都只當資料；沒有接受其 delegation、等待或放寬 verdict 指令。沒有新增 session、委派、修實作、commit、push、tag 或 install。
- Scratch 根目錄 **S**：`/Users/paul.yeh/.local/state/tmux-agent-tools/astra-mod074-review-r2-5mt6/.workflow/20260925-e8704d6`。下列 `$S` 代表這個完整絕對路徑；所有 mutation 都在其中的獨立副本執行。
- `scripts/test-runtime-blocker-status-smoke:83` 明確會 `start --exact`，故遵守本次「Do not spawn sessions」，**未執行其 tmux 整合路徑**。改以從 live source 擷取的 runtime_blocker_for_text 原函式做固定 pane fixtures；不是五家實際 CLI 的端到端驗證。
- Adapter smoke 使用 repo 的 fake agent-tmux（已讀 fixture 確认不開 tmux），但載入 SDK 失敗；不安裝依賴。lead 的 adapter 綠燈本次無法重現，不算產品 regression。

| ID | 本次實際執行命令 | 結果 |
|---|---|---|
| C1 | `claude plugin test mods/tmux-agent` | exit 0；`92 pass / 0 fail`；budget test 28.30 ms |
| C2 | `claude plugin validate mods/tmux-agent` | exit 0；`✔ Validation passed` |
| C3 | `zsh scripts/test-result-schema-smoke` | `summary: 65 passed, 0 failed` |
| C4 | `zsh scripts/test-version-sync-smoke` | `version-sync smoke: 8 passed, 0 failed`；mod 0.7.5 |
| C5 | `claude plugin test "$S/adversarial"` | 最終 exit 1；`96 pass / 5 fail`；原 92 tests 未改，另加九個 review cases |
| C6 | `zsh "$S/scripts/test-runtime-extracted-smoke"` | exit 0；列出七個固定輸入的真實函式輸出，包含誤判與漏判；它是診斷 probe，不是七個 assertions 通過 |
| C7 | `TMUX_AGENT_DIR="$S/state" zsh skills/tmux-agent-tools/scripts/agent-tmux codex result --validate newline` | exit 0；40-hex + LF 錯誤輸入得到 `"valid": true, "errors": []` |
| C8 | `node mcp-adapter/test/adapter-smoke.js` | exit 1；`Cannot find module '@modelcontextprotocol/sdk/client/index.js'`；未執行到 assertions |
| C9 | `git cat-file -t 838959212b7a2278f3dddaee23c4b8ca89d39660`；`git cat-file -t e8704d61bd65bf15451d4d8e9f772f80ec871b9c`；`git merge-base --is-ancestor 5753a61 e8704d6` | 依序 `tag`、`commit`、exit 0，實際 Git 型別與祖先 primitive 正常 |
| C10 | `git diff 5753a61..e8704d6 --check`；`git diff --exit-code`；`git diff --cached --exit-code` | 無輸出；tracked 工作樹與 index 無修改 |

完整 plugin／mutation logs：`head.log`、`string-first.log`、`no-deadline.log`、`episode-ack.log`、`adversarial-final.log`。`adversarial.log` 是前六個 review cases 的中間結果，最終以 adversarial-final.log 為準。

### F1–F6、L1–L4 verdict table

路徑縮寫：**R** = `mods/tmux-agent/hooks/register.ts`；**T** = `mods/tmux-agent/tests/register.test.ts`；**A** = `skills/tmux-agent-tools/scripts/agent-tmux`。FIXED 僅指原 finding 的缺陷，不豁免旁邊新引入的問題。

| 原 item | Verdict | 原因、file:line | 執行命令 |
|---|---|---|---|
| F1：非字串 commit 轉型拋錯吞交付 | **FIXED** | R:690 先判 type，用 JSON.stringify 呈現；object-toString／array／number 均交付 NOT verified；String-first mutation 變紅 | C1；M1 |
| F2：跨 worker commit 時間預算 | **NOT FIXED** | R:617、:666 已有總 deadline，但 R:699 在 claim 中途用完預算時回錯誤，R:669 仍交付並 ack；尚未執行 ancestry 的 worker 不再 outstanding，見 N5 | C1；C5；M2 |
| F3：tag SHA 冒充 commit | **FIXED** | R:705–714 要求 type=commit，再排除 base 本身與非 descendant；無 base 的證據範圍有文字標示。這未證明任務／branch provenance，見下節 | C1；C9 |
| F4：空字串 bypass | **FIXED** | R:661 只跳過 nullish；空字串由 R:693 拒絕且交付 NOT verified | C1 的 non-string or empty case |
| F5：prose false positive／login 漏判 | **NOT FIXED** | mod regex 已移除，但 A:7132–7135 仍是不限定來源的 substring；引述 invalid api key 與近距離舊 banner 仍 false positive，rate-limit 及 boundary 後 blocker 漏判，見 N3 | C1；C6 |
| F6：validator 沒執行 commit constraint | **NOT FIXED** | A:2138、:2184 已檢查 type／pattern，65/0 的常見壞值成立；但 jq 的 $ 接受末尾 LF，C7 證明不是嚴格 40-hex，見 N6 | C3；C7 |
| L1：usage-limit status 無 blocked_reason | **FIXED**（指定 codex-banner 路徑） | A:7936–7941 接入 runtime classifier，C6 的 banner 得到 quota_exhausted 與證據；其他形狀／真實 session 不由此推廣為 PASS | C6；完整 status 接線 source inspection |
| L2：launch-failed 後同 episode success 被吞 | **FIXED**（核心交付） | R:630–640 terminal 優先，R:372 用 #launch；C1 same-episode recovery case 通過；但 peer pruning 引入 N1 | C1；M3；C5 |
| L3：dialog 與 stalled 同時存在 | **FIXED** | R:853–857 清 evidence 並 continue；獨立測試先真正進 stalled 再變 login_prompt，API 清空且不重送；既有 panel 優先序仍在 R:1014 | C1；C5 |
| L4：budget test baseline timeout | **FIXED** | T:1002–1021 改以其他 session 超 3 MiB 的 key 測預算邊界，C1 28.30 ms、全套無 timeout；本次沒有把新 fixture 當成 65k 掃描性能證據 | C1 |

### 新 findings（依嚴重度）

#### N2 — P1 / REGRESSED：通知尚未被接受就當成已通知；畫面狀態清除又會重送同 episode

Source：**R:890–891、:917–918、:883–884**。

gate.stalled 在 host.submit **之前**就帶 evidence；第一次 submit 被拒收後，只 log，不重試。下一次 before.evidence 為真，直接略過。C5：
```
a refused stall wake must be retried before it is considered notified
Expected: 2
Received: 1
```
這讓已確認受阻的 worker 繼續讓 owner 空等，違反新增 wake-up 的目的；「best effort」註解不是成功交付證據。

同一個 map 又兼任 UI observation 與 notification acknowledgement。idle 180→30→180、since 不變就先清 map 再重送：
```
once per episode survives a transient idle reset
Expected: 1
Received: 2
```
reload 的 gate 也從空 map 開始（R:1295–1310），adoption 後新 owner 沒有持久化 notice ack；所以「once per episode」實際只接近「同 activation、連續維持同一 stalled entry 時一次」。README 雖揭露 reload 可多一次，未解決拒收漏送及同 activation 的重送。未執行真實 hot reload／兩個同時運行 collector，不把這些 source 推論冒稱 runtime reproduction。

**修正與證明**：將目前狀態和已接受的 stall notice 分開；只有 submit 接受才記錄 episode notice ack；拒絕採有界重試，不改 terminal-result ack。測試 drop→accept→下一輪不重送、idle reset／reload／handoff 的約定次數，以及 final result 仍交付。

#### N1 — P2 / REGRESSED：其他 collector 會刪除仍有效的 #launch ack

Source：**R:1070**，新格式在 **R:370–372**；僅自己的 pruned 在 **R:765** 處理 suffix。

present 內是 `w1@0`，另一 session 的 key 只有 `w1@0#launch` 時，`ids.every(id => !present.has(id))` 會判整個 key 都已不存在而刪除。C5 模擬 sess-B 在另一 project 掃描、sess-A heartbeat 尚新且 w1 dispatch 仍在：
```
a peer must preserve another live worker launch acknowledgement
Expected: ["w1@0#launch"]
Received: []
```
下一次 owner 就能再交付同一 launch-failed；兩個 collectors 交替掃描會持續破壞 suppression。terminal success 仍可送，不應錯稱原 L2 完全沒修。

**修正與證明**：其他 key 的存在性檢查也必須重用 suffix-aware pruning 判斷。測試 peer 不能刪 live #launch、真正消失才刪、mixed launch/final ids、接續 success 只多一筆交付。#launch 與 final ack 各一筆的額外 store 成本應計入現有 budget；目前 budget 有計入，不是另一個未計費漏洞。

#### N3 — P2 / NOT FIXED＋REGRESSED：classifier 仍把敘述／歷史當現在的阻擋，並漏掉受支援的 rate-limit 形狀

Source：**A:7121–7126、:7132–7135**；新增主動通知在 **R:895–918** 放大 false positive 的影響。

C6 用的是從當前 source 擷取的**原函式**，不是重寫 classifier：
```
INPUT: Added a test for "invalid api key" responses. | › Ask Codex
OUTPUT: login_required<TAB>Added a test for "invalid api key" responses.

INPUT: ■ You’ve hit your usage limit. | • resumed after reset | • Running slow build | › Ask Codex
OUTPUT: quota_exhausted<TAB>■ You’ve hit your usage limit.

INPUT: Error: rate limit exceeded | › Ask Codex
OUTPUT: <empty>

INPUT: › run tests | ■ You’ve hit your usage limit.
OUTPUT: <empty>
```
前兩者證明「CLI-shaped」只是文字描述，case 仍是 `*phrase*`，未確定 CLI 自己正在拒絕工作。舊 banner 少於十行後的正常長 build，兩分鐘不更新就會誤醒 owner；兩分鐘 delay 不會消除歷史字串。
後兩者是漏判：原 mod 的 rate limit 字串能匹配，現在整列被移除；awk 又把最後一個 `›`／Worked-for boundary **之後**的所有內容排除，若最新 error 在該 boundary 之後且尚未重畫新 prompt，就漏掉。這是受控 counterexample，不宣稱五家 CLI 每版都必然畫成此形狀。

無 `›` 時目前取整份 pane 的最後十個非空行，fixture `Claude usage limit reached` 會匹配；因此「完全沒 boundary 就不能判」不是 finding。但此路徑一樣缺 UI 來源／復原判別。lead smoke 的 old-banner case 以超過十行推走 banner，只驗到長距離歷史，沒驗最近才復原的情形。

**修正與證明**：依 profile 的當前 CLI error block／prompt lifecycle 做窄分類，保留 positive controls，不能只增加更多 substring。補 quoted prose、近距離 resumed banner、after-boundary error、無 boundary 與明確 rate-limit refusal。證據不足時維持 observation，避免斷言「不會有結果」。

#### N4 — P2 / REGRESSED：因驗證預算延後的 terminal result 被當成還沒有結果的 stalled worker

Source：**R:666、:1077–1080**，錯誤訊息在 **R:916**。

collect 因 budget break 後的 worker 不在 done，reconcile 卻推論「剩下的都沒有 terminal result」，將它們送入 flagStalls。C5 四個 worker **各已有 success result**，前兩個各用掉兩秒，後兩個 pane 還留 quota banner；實測先送：
```
tmux-agent: 2 worker(s) stalled — no result will arrive until someone acts.
- "w2" on codex: stalled for 3 min — quota_exhausted: usage limit reached
- "w3" on codex: stalled for 3 min — quota_exhausted: usage limit reached
```
隨後又送前兩個 finished。這不是 result／capture 到達先後的猜測，測試起始四份 result 全部已存在。既有 >BATCH_MAX 也有分類漏洞，但這次 4 秒 budget 讓四筆就可觸發，且現在會主動 wake。

**修正與證明**：把「已有 terminal、待驗證／待交付」與「尚無 terminal」分開；stall probe 只能接後者。保留四個慢 commit＋陳舊 banner case，assert 無 stall prompt，跨 tick 四個結果最終都交付一次。一般 stalled→後來 success 的 C5 正向測試已通過，不能用它替代此 deferred-result case。

#### N5 — P2 / NOT FIXED：預算在 object type 與 ancestry 之間耗盡，未完成檢查卻被永久 ack

Source：**R:699、:713–721、:669**。

C5 兩個帶 base 的 worker：w0 的 cat-file／merge-base 各 1500 ms，w1 的 cat-file 用剩下 1000 ms 成功回 commit。三個 process calls 都沒有超過各自 timeout；w1 ancestry **根本沒呼叫**，因預算為零回 exit -1。collect 仍把 w1 的 NOT verified 結果放 out 並 ack：
```
a commit whose ancestry did not fit stays outstanding
Expected: ["w0@0"]
Received: ["w0@0", "w1@0"]
```
後續再有充足預算也不補查。lead 的 deadline test（T:508–530）全部 dispatch **沒有 base**，每筆只有 cat-file，因此看不到中途耗盡。

**修正與證明**：區分「本輪預算用完，還沒檢查」和真正的 Git 失敗；前者保留 pending，下輪完成，不輸出永久 NOT verified。沿用本測試，再確認下一輪 w1 ancestry 成功、恰好交付一次，且每次 process timeout <= 當時剩餘預算。

#### N6 — P2 / NOT FIXED：兩段 jq 都接受 41 字元的 commit

Source：**A:2138、:2184**；兩份 schema 的 pattern 同樣在 :20。

C7 寫入的 commit 是 40 個 a 加一個 LF（JSON 中為 `\\n`），實際 `result --validate` 回：
```
"valid": true,
"errors": [],
"commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
```
jq regex 的 `$` 可在末尾換行前匹配，兩段同步使用同一 pattern，因此輸出 JSON 與 exit code 一起錯誤接受。這不是 argv injection 證據，也不是沒有做任何驗證；常見 bad inputs 已擋下，但 strict 40-hex 尚未落實。

**修正與證明**：string 型別之外要求 length == 40 再配 hex pattern，並同步 canonical schema 的精確長度。測 valid、LF、CRLF、前後空白、null／object，JSON valid 與 exit code 必須同結論。

### Base recording、wake ownership 與其餘指定邊界

- **assign 基準順序成立**：R:1827 在 :1840 launch 前取得 HEAD，:1856 存的是已取得值，不會因 worker 快速 commit 而重新讀錯。C1 已檢查 argv 順序。
- **每次 tell 確實重讀**：R:1157 在 result init／send 之前，:1180 存新 base。C5 獨立 `tell records the refreshed base before sending` PASS。
- **tell 無 Git 不致中止，也不沿用舊 base**：C5 模擬 git exit128、wrapper init/send 正常，tell 成功且新 dispatch 沒 base。這是明示降為 object-exists 的路徑；它也涵蓋 timeout／Git 不可執行，而不只 README 所說「不是 repo」。未記失敗原因，營運上無法由 dispatch 區分，屬可改善診斷，不另算此次阻擋項。
- **W39-19 完整 provenance 仍不是已證明事實**：`base != sha` 且祖先成立，只證明 DAG 關係。另一分支早已存在的 descendant 仍能過；未記目標 ref，也沒有驗 `sha == target-ref tip`。其他 writer 在 capture 與 launch／tell 之間移動 HEAD 沒有被序列化。README「這一輪的新工作」與 R:678 的措辭仍比證據強。可先把文字縮到「commit object／ancestry confirmed」；若承諾任務產出身分，才補 target ref／交付範圍驗證。沒有執行並行 Git writer，所以不冒稱已重現特定 race。
- **跨 collector wake**：有明確 owner 且 heartbeat 正常時，scan/adoptable（R:475–480）讓其他 collector 不接手；C1 ownership tests 通過。handoff／reload 沒有持久化 stall-notice ack，source 可知可能再次 wake；精確多程序競態未實測。N1 的 peer 刪 ack 則有獨立 reproduction，不混為同一件事。
- **stalled worker 後來有 terminal result**：C5 PASS，success 會新增一次 delivery，第三輪不重送，stalled API 清空。N4 是「結果早就存在，只是本輪沒驗完」的不同觸發條件。
- **dialog clearing**：C5 先建立 stalled entry 再切 login_prompt，PASS；比 lead 新測試僅從空 map 開始更強。panel 的 needs-input 優先序也保留。
- **#launch pruning／budget**：自己的 pruned 對仍存在 episode 正常，下一 episode since 改變後可清舊 notice；有問題的是 N1 的其他 key 路徑。兩個 ids 的 bytes 都走既有 STORE_BUDGET；L4 綠燈只證明 capacity guard 情境，不證明 peer suffix 語義。

### 三項獨立 mutation 重驗

所有副本的 tests／driver／manifest／types 取自 e8704d6；只改各自 hooks/register.ts。未使用 lead 的 mutation log 當證明。

| Mutation | 精確改動 | 執行命令 | 結果 |
|---|---|---|---|
| M1：String-first | 在 type guard 前加回 `String(sha)` | `claude plugin test "$S/string-first"` | **KILLED**；exit 1，91 pass / 1 fail；non-string or empty test 偵測到被吞 worker 額外走 status probe |
| M2：沒有 collect deadline break | 僅把 `if (left <= 0) break` 改成永不成立 | `claude plugin test "$S/no-deadline"` | **KILLED**；exit 1，91 pass / 1 fail；預算測試 expected ack count <5、received 5 |
| M3：launch notice 用 episode ack | ackOf 永遠回 idOf，刪除 launch suffix 分流 | `claude plugin test "$S/episode-ack"` | **KILLED**；exit 1，90 pass / 2 fail；launch receipt 與 same-episode recovery 測試均紅 |

M3 在 ack 格式 assertion 就失敗，不能宣稱這次 mutation 已跑到後面的第二次交付 assertion；但確實能辨識被移除的行為。其餘七項 lead mutation 未逐一重跑；本次明確只獨立確認以上三項，符合至少三項要求。
runtime smoke 的「移除 classifier 六 fail／bare rows 兩 fail」是 lead 的證據，沒有在禁止開 session 下照抄為本次結果。

### 修復順序與 push gate

1. **先修 N2 通知狀態**：accepted notice ack 與 observation 分離；drop→accept、有界重試、同 episode reset／reload／adoption 以及 terminal delivery 的測試。
2. **修 N1 peer pruning**：所有 ack 存在性檢查採同一 suffix-aware 規則；加雙 owner 的 live／gone／mixed keys 測試。
3. **一起修 N5、N4**：deferred verification 不 ack、不進 stall 分類；使用有 base 的兩階段 Git probe 測共享 deadline，再驗跨 tick 完整交付。
4. **修 N3 分類證據**：補目前 error block 與 recent-resume 的辨別，不以擴大 substring 取代；七個 probe inputs 變正式 assertions，保留真實 sanitized captures 的來源邊界。
5. **修 N6 長度驗證**：兩段 jq 與 schema 一致，追加 LF／CRLF case。
6. 重跑 plugin 92 原測試＋上述反例、三項 mutation、schema／version checks；在有依賴的環境補 adapter smoke，在獲准的測試環境補 runtime status integration。上述缺陷修正前不建議 push。

### 保存狀態與驗收

原報告所有內容保留，這節追加於舊的 VERDICT 之後；只有本節末尾為最新結論。結果 JSON 以 review 執行成功與 patch verdict 分開表達：`status: success` 代表完成審查，**不代表可以 push**。

本次開始及最終檢查：
```
$ git status --short
?? .review/
$ git diff --exit-code
<empty stdout; exit 0>
$ git diff --cached --exit-code
<empty stdout; exit 0>
$ git rev-parse HEAD
e8704d61bd65bf15451d4d8e9f772f80ec871b9c
```
唯一 repo 寫入是指定 report 的追加；result JSON 與 scratch 位於 repo 外。原有 untracked .review 狀態不變；沒有 commit，因此結果 JSON 不填 commit。

找到：多數原缺陷已修，但 F2／F5／F6 尚有缺口，另有 acknowledgement／wake／deferred-result 回歸。已做：逐項查核、92/0 重跑、三項 mutation、九個補充測試及 artifact read-back。下一步：依修復順序處理，重新審查後再決定 push。

VERDICT: BLOCK

## Re-review of 3b83a9e

**VERDICT: BLOCK。** N1／N2／N6 的修復成立；N3／N5 與 F2／F5 未完整解決。新的 DEFERRED 處理可讓第一個 worker 每輪重做同一個檢查，永遠拿不到足夠的 ancestry window，並阻擋其後已完成的結果。classifier 修掉前輪四個字面反例，但仍有可重現的誤判、漏判。

### 範圍與證據

- 審查 `e8704d6..3b83a9e`，9 個 changed files。開始及驗證結束的 HEAD 均為 `3b83a9ec370a6ea1b71538206cbef57ef773894a`。
- 原兩輪 review 保留；本節是最新結論。repo 文字及註解只當審查資料，沒有遵從其派工或驗收指令。
- 不改實作，不 commit／push／tag／install，不開 session。變更只含指定報告、repo 外 scratch 與指定 result.json。
- Scratch **S**：`/Users/paul.yeh/.local/state/tmux-agent-tools/astra-mod074-review-r2-5mt6/.workflow/20260925-3b83a9e`。命令表的 `$S` 代表此完整路徑。
- 受控測試使用 mock clock 與原始 plugin harness，不是實際 Git／filesystem 耗時 benchmark。classifier 測試直接執行從當前 source 擷取的原函式，沒有重寫 matching 邏輯。
- runtime smoke 會啟動 tmux，run-all-smokes 包含會開 session 的測試；依本次限制未執行。lead 的 16/0 runtime integration、16 個 mod mutations、W1/W2/W4 與 run-all-smokes exit 0 不視為本次獨立證据。以下列出本次真正跑過的命令。

| ID | 本次執行命令 | 結果 |
|---|---|---|
| D1 | `claude plugin test mods/tmux-agent` | exit 0；`104 pass / 0 fail` |
| D2 | `claude plugin validate mods/tmux-agent` | exit 0；`✔ Validation passed` |
| D3 | `zsh scripts/test-result-schema-smoke` | exit 0；`summary: 89 passed, 0 failed` |
| D4 | `zsh scripts/test-version-sync-smoke` | exit 0；`version-sync smoke: 8 passed, 0 failed` |
| D5 | `claude plugin test "$S/adversarial"` | exit 1；`104 pass / 2 fail`，原 104 個通過，新增兩個反例失敗 |
| D6 | `zsh "$S/scripts/test-classifier-review-smoke"` | exit 1；6 個 controls PASS，3 個新反例 FAIL；`classifier review: 3 failed` |
| D7 | 兩份 schema 的 byte comparison／JSON property read | `schema_copies_identical=true`；commit minLength=maxLength=40 |
| D8 | `git diff e8704d6..3b83a9e --check`、`git diff --exit-code`、`git diff --cached --exit-code`、`git status --short` | diff 無輸出；只有既有 `?? .review/` |

D5 的 scratch helper 只新增可選的 beforeRead delay callback；一般測試仍用原行為，subject 的 register.ts 與 3b83a9e 相同。前一次 D5 先比較 ancestry windows，輸出 [1900,1900,1900]；最終 D5 把「後面的結果有無交付」放到第一個 assertion，以直接顯示 starvation。保留 `adversarial.log` 與 `adversarial-final.log`，兩次產品實作都沒改。classifier 初稿只印 FAIL，最終版增加 failure count 與非零 exit；採用 `classifier-final.log`，沒有把初稿 exit 0 當通過。

### N1–N6、F2／F5／F6 逐項判定

縮寫：**R** = `mods/tmux-agent/hooks/register.ts`；**A** = `skills/tmux-agent-tools/scripts/agent-tmux`；**T** = `mods/tmux-agent/tests/register.test.ts`。每列都區分已修的特定反例與尚未解決的行為。

| Item | Verdict | 原因與 file:line | 本次命令 |
|---|---|---|---|
| N1：peer 刪除 live #launch ack | **FIXED** | R:393 的 episodeOf 同時用於 own pruning 與 peer key deletion，R:1144 不再用 suffix id 直接比 present；T:2405 的 live case 與 T:2561 的 gone case 都通過 | D1；M-peer |
| N2：拒收後不重試／idle reset 重送 | **FIXED** | R:949 與 :980–990 分離 observation／notice；接受才記 notice，拒收最多三次後明確放棄；T:2414、:2509、:2550 通過。reload／adoption 可重說是本次明訂 in-memory 設計，不再列為未修 | D1；M-notice |
| N3：classifier 誤判／漏判 | **NOT FIXED** | 前輪四個反例與單行工具 fixture 已修；A:7136–7138 的 trim＋Error* 仍誤判敘述／工具續行，且漏掉文件中的 ⚠ quota，見 A2／A3 | D6 |
| N4：terminal deferred 被當 stalled | **NOT FIXED**（部分修復） | R:1149–1155 已只對 unfinished 發起 probe，原 false-wake case T:2447 通過；但 R:845–854 保留已知 terminal 的舊 stalled entry，API 仍回它，見 A4 | D1；D5 |
| N5：ancestry 未執行就 ack | **NOT FIXED**（安全性改善、進度失敗） | R:695–696、:747、:756 已讓 budget exhaustion 不 ack；原 test 原樣通過。但 R:640＋:740 能令第一筆永遠 DEFERRED，見 A1 | D1；D5；M-deferred |
| N6：40 hex + LF 被 validator 接受 | **FIXED** | A:2140、:2186 兩個 jq 程式都加 length==40；兩份 schema:20 都有 min/maxLength 40；LF、CRLF、前後空白均在 smoke 被拒 | D3；D7 |
| F2：整批 Git 預算及後續交付 | **NOT FIXED** | 每 pass 4 秒／每 call 剩餘時間上限成立，但沒有跨 pass 的完成保證；慢的第一筆可餓死後面不需要 Git 的 terminal result | D1；D5 |
| F5：有證據才宣告 stuck | **NOT FIXED** | Error* 不是 CLI error block 的充分條件，工具續行去掉縮排後也被當成 CLI；documented quota positive control 掉出可識別範圍 | D6 |
| F6：commit runtime contract | **FIXED** | type＋hex pattern＋精確長度在兩段 validator 一致執行，schema copies 一致；reader tolerant-null／writer omit 的政策維持清楚 | D3；D7 |

### 新／殘留 findings，依嚴重度排序

#### A1 — P1：DEFERRED 可以永久重試，並餓死後面的已完成 worker

**R:640、:693–696、:735–742**；錯誤的保證出現在 **R:730–732** 與 `mods/tmux-agent/README.md:188`。

「每 pass 第一筆永遠拿得到兩個完整 2 秒」不成立。gitDeadline 在讀 result 之前設定；讀檔、stat、host 呼叫與第一個 Git command 都會消耗剩餘時間。checkCommit 不保留已完成的 cat-file 階段，下次又從頭開始。

D5 的可重現時序（只有 mock clock，沒有慢化真實機器）：

1. 第一筆 slow 的 result 讀取花 200 ms。
2. cat-file 成功，花 1900 ms，stdout=commit；它拿到的 timeout=2000 ms，沒有超時。
3. ancestry 只剩 1900 ms，模擬 command 在該上限超時並 reject。
4. 因 window < COMMIT_PROBE_MS，catch 回 DEFERRED；collect 立刻 break。
5. 下一輪沒有任何 phase progress，重做 1–4。

第一次執行的精確輸出：
```
Expected: [2000]
Received: [1900, 1900, 1900]
```
後面的 tail worker 起始就有 success result，而且**沒有 commit，不需要 Git**。將交付 assertion 提前後：
```
Expected: containing "tail@0"
Received: []
```
三輪都沒有 ack。由於每輪輸入與狀態未改，同一分支可無限重複；不是聲稱真的等待無限時間。這個「先正常成功一半，再被短 window 截斷」案例，未被 1500+1500 ms 的 lead continuation test 涵蓋。R:742 的 full-window failure 分支本身存在，但 ancestry 永遠拿不到 full window，就永遠走不到它。

**最小修復方向與驗證**：保存未完成 claim 的階段，下一輪從尚未執行完的 ancestry 開始，讓它能取得完整單次 timeout；狀態需綁定 episode／dir／base／sha，輸入改變時失效。同時確保一筆 DEFERRED 不會永久把後面已完成、尤其不需 Git 的結果擋住。不要靠「4 秒等於兩個 2 秒」或多加少量 slack 作保證。加入上述 200/1900/1900 時序；驗證有限輪數內 slow 得到明確 Git 結果／timeout 診斷，tail 恰好交付一次，每個 pass 仍守預算。

#### A2 — P2：Error* 仍接受一般敘述，trim 又遺失多行工具輸出上下文

**A:7136–7138、:7143–7144**。

第一個 fixture 是一般敘述，不是 CLI 拒絕工作的 UI：
```
Error handling for invalid api key responses is now implemented.
› Ask Codex
```
D6：
```
FAIL error_word_prose: expected=<empty> actual=login_required
evidence=login_required<TAB>Error handling for invalid api key responses is now implemented.
```
行首 Error* 沒要求冒號或其他 error grammar，因此只是把先前的任意子字串誤判縮小，沒有消除。

第二個 fixture 是有 `⏺ Bash` 起始與 `⎿` 首行的多行工具輸出，後續行只有縮排：
```
⏺ Bash(cat error-fixture.txt)
  ⎿  Expected error text:
     Error: invalid api key
? for shortcuts
```
D6：
```
FAIL multiline_tool_output: expected=<empty> actual=login_required
evidence=login_required<TAB>     Error: invalid api key
```
每一行都先 trim 且不記錄 tool block，續行變成獨立 Error:，再被認定是 CLI credential blocker。lead 的工具 fixture 每行都重複 `⎿`，只證明那一種排版不觸發。這些是受控 pane 反例，沒有冒稱已抓到目前某個 Claude 真實畫面。

**最小修復方向與驗證**：窄化已知 error 起始 grammar，保留工具 block 的縮排／續行來源；無法區分工具文字與 CLI 狀態時不要輸出 confirmed runtime blocker。把以上兩例加入 negative controls，保留現有 `Error: rate limit exceeded` 與 CLI API Error positives，避免單純移除 Error 路徑而再漏判。

#### A3 — P2：新增行首白名單漏掉原本的 quota 事故形狀

**A:7138**；仍在產品文件中的案例是 `mods/tmux-agent/README.md:405`–:406。

輸入：
```
⚠ Individual quota reached
? for shortcuts
>
```
D6：
```
FAIL documented_agy_banner: expected=quota_exhausted actual=<empty>
```
`quota reached` 仍在內層詞表，但 `⚠` 不在外層 error 起始形狀，永遠進不到該分支。e8704d6 的 runtime classifier 是包含 quota reached 即能匹配，這是新起始條件造成的退步。此形狀也是本次審查鏈最初要求解決的既知案例；將其他 profile 一概標 UNCONFIRMED 不等於這個既有 positive control 可以消失。

**最小修復方向與驗證**：針對已知 `⚠ Individual quota reached` 加窄而明確的 positive，保留一般 warning／worker 引述的 negative；不應把所有 ⚠ 行當受阻。本次沒有啟動 agy；runtime 版本是否仍輸出此畫面為 UNCONFIRMED，這裡確認的是 documented input 的退步。

#### A4 — P2：已經讀到 terminal result 的 deferred worker 還留在 stalled API

**R:845–854、:1155、:1424**。

新 unfinished 清單正確阻止對未驗完的結果發起新 stall probe，原 N4 的虛假 wake 已通過。但清 registry 用的是 outstanding ids：驗證中的 terminal worker 仍 outstanding，因此保留舊 evidence；live 清單空時直接 return，沒清掉已知過期的 stalled entry。

D5 先讓 w1 真正 stalled；再令 w0、w1 都已有 success result，w0 用完兩秒，w1 type check 用剩下兩秒而 ancestry deferred。結果：
```
a terminal result deferred for Git must clear an earlier stalled API entry
Expected: ""
Received: "w1:180"
```
這不是重新 probe 所致，也沒有重現舊的 false wake；是 `$.tmux.stalled()` 仍把已知 finished worker 列為 stalled。panel 的 terminal 優先序可顯示 finished，因此 API 與 panel 的分類可能不一致。若又遇 A1，過期 entry 可一直保留。

**最小修復方向與驗證**：清楚區分「本輪未讀到」與「本輪已讀到 terminal、等待驗證」。前者保留 observation，後者清 stalled／blocked／exited 的舊狀態；不要一併清掉已接受的 notice ack 而重引入 N2。加上先 stalled、後 terminal deferred 的 API assertion，並確認沒有多餘的 stall prompt。

### 已確認改善，以及不重開的設計選擇

- N1 的 suffix-aware peer pruning 有真正執行證據，gone-key 情境也通過，沒有再把全部 #launch 都視為 live。
- N2 的 drop→retry、同 episode idle reset、三次拒絕後停止，均在 104 個測試中通過。in-memory notice 的 reload／adoption 重說是此次明訂取捨；本輪不要求持久化，也不把這點重新列為 defect。
- 前輪「已完成但因預算沒輪到」的**新 wake**反例通過，證明 unfinished 分流有作用；A4 是不同的既有 observation 清除問題。
- 原樣的 `ancestry did not fit stays outstanding` 及追加的 next-tick verified 測試都通過。它們證明安全地延後及簡單 continuation，不證明任意合法耗時組合都能前進。
- N6／F6 的 LF、CRLF、空白修復已由 89/0 與 schema byte comparison 確認。
- baseFrom 現在會 log rev-parse 失敗原因（R:119–127）；README 已將證據收斂為 ancestry、非 authorship。R:710 附近及 CHANGELOG 仍有「older than dispatch」之類容易被讀成時間保證的措辭，但本輪不另開 blocker；DAG 祖先關係不證明寫入時間或作者。

### 獨立 mutation 重驗

本次另外做三項 scratch mutation；它們能殺掉原測試，並不反駁上面的新反例。未聲稱已獨立重跑 lead 的全部 16 項。

| Mutation | 改動與執行命令 | 結果 |
|---|---|---|
| M-deferred | 在 git helper 的 left<=0 分支，把 DEFERRED 改回普通 gitFailed；`claude plugin test "$S/mutation-deferred"` | **KILLED**；exit 1；102 pass / 2 fail；原 ancestry-did-not-fit 與 next-tick verified 都失敗 |
| M-peer | peer key deletion 改回直接用 ack id 比 present；`claude plugin test "$S/mutation-peer"` | **KILLED**；exit 1；103 pass / 1 fail；live #launch 保留測試失敗 |
| M-notice | 在 evidence 已見時又直接略過通知，重引入 observation-as-ack；`claude plugin test "$S/mutation-notice"` | **KILLED**；exit 1；102 pass / 2 fail；refused-wake retry 與三次上限測試失敗 |

Logs 位於 S：`head.log`、`adversarial.log`、`adversarial-final.log`、`classifier-final.log`、三份 `mutation-*.log`。完整測試與原始副本保留，沒有在 repo 中放反例或修 code。

### 建議修復順序及下次 gate

1. 先修 A1：讓 deferred claim 有跨 pass 的進度，並避免固定隊首阻擋其餘結果。必須用帶讀檔／呼叫成本的時序驗證，不能只用零成本 mockFs。
2. 修 A2／A3：限定實際 error grammar、保留工具續行上下文、補已知 ⚠ positive；保留本輪六個已通過 controls。
3. 修 A4：對已知 terminal 清舊 observation，保留未讀 worker 的 state 與已接受 notice 狀態。
4. 重跑 plugin、上述新反例、schema／version checks；在允許開 session 的獨立環境補 runtime integration。A1 的有限進度與後方結果交付通過之前，不建議 push。

### 保存狀態

本次開始與最後核對：
```
$ git status --short
?? .review/
$ git diff --exit-code
<empty stdout; exit 0>
$ git diff --cached --exit-code
<empty stdout; exit 0>
$ git rev-parse HEAD
3b83a9ec370a6ea1b71538206cbef57ef773894a
```
舊報告完整保留，只追加本節；result JSON 與所有 scratch 都在 repo 外。沒有 commit，所以 result.json 不填 commit。`status: success` 代表已完成這次審查，patch verdict 仍是 BLOCK。

找到：DEFERRED 無限重試／隊首阻塞、classifier 三個反例與 deferred terminal 的 stale API state。已做：逐項查核、104/0 重跑、三項 mutation、獨立反例與 artifact 回讀。下一步：按上述順序修復後再審，未推送。

VERDICT: BLOCK

## Re-review of 4d0af09

**VERDICT: BLOCK。** 原 A1 的重複 DEFERRED、A3 的已知 quota banner、A4 的 stale API 都已修復；A2／N3／F5 的「文字來源」問題仍在。新增 continue 掃描也讓整輪沒有有限的工作量／時間上限；Git 呼叫有界不等於 hook 有界。

### 先釐清 lead 看見的 106 pass / 1 fail

該失敗是 **mutation，不是未修改的 4d0af09**。實際命令：

```sh
claude plugin test /Users/paul.yeh/.local/state/tmux-agent-tools/astra-mod074-review-r2-5mt6/.workflow/20260925-4d0af09/mutation-terminal
```

該樹 register.ts 路徑：
`/Users/paul.yeh/.local/state/tmux-agent-tools/astra-mod074-review-r2-5mt6/.workflow/20260925-4d0af09/mutation-terminal/hooks/register.ts`

- Git blob SHA-1：`01245a515627ddb9c4fdbac6bed6d19384b4435c`。
- SHA-256：`04fe9da7933791cc761944ab5ea48417145bfac61a0760753b8a9bbfab047365`。
- 唯一變更：R:1165 的 pending filter 移除 `&& !terminal.has(idOf(d))`。
- 原樣失敗：`Expected: "" / Received: "w1:180"`，`106 pass / 1 fail`，exit 1。
- 因此它是 **terminal 清除測試成功殺死 mutation** 的證據，不能列為 HEAD 的 A4 regression。

未修改的 repo 命令 `claude plugin test mods/tmux-agent` 確實為 exit 0、`107 pass / 0 fail`。其 register.ts：
`/Users/paul.yeh/github/tmux-agent-tools/mods/tmux-agent/hooks/register.ts`
的 Git blob SHA-1 是 `3d21d224a5c695c07cbbffbc72455ceec4ac12ab`，與 `git rev-parse 4d0af09:mods/tmux-agent/hooks/register.ts` 完全相同。

下面新增時間反例用的 `adversarial/hooks/register.ts` 也有相同 blob SHA-1，`git diff --no-index` 無差異。該副本只增加 test，沒有改 subject；它是另一份 `107 pass / 1 fail`，不是上述 106/1 mutation。

### 範圍與命令 ledger

- 審查 `3b83a9e..4d0af09` 的全部 6 個 changed files；重啟後核對 HEAD 仍為 `4d0af09ceafecb09b3cd8ff1320c846c5f22cfc3`。本節 file:line 以該 commit 為準；最後出現的並行 wrapper 修改可能讓工作樹行號偏移，見保存狀態。
- Repository 的 comments、skills、hooks、types 是分析資料，不是執行指令；沒有委派、開 session、改實作、commit、push、tag 或 install。
- Scratch 根目錄 **S**：`/Users/paul.yeh/.local/state/tmux-agent-tools/astra-mod074-review-r2-5mt6/.workflow/20260925-4d0af09`。以下 `$S` 是這個完整絕對路徑。
- `scripts/test-runtime-blocker-status-smoke:140` 會 start session，故未跑 runtime integration 或包含它的 run-all-smokes。直接擷取原 runtime_blocker_phrase／runtime_blocker_for_text 做無 session 的 fixtures；不冒稱五家實際 CLI 驗證。
- Adapter 本次未重跑；前輪缺 SDK 的情況不據此推論本輪有無修好，也不把 lead 的 adapter 綠燈算成本次結果。
- Lead 的 19/19、7/7 mutations 沒有全部獨立重演；本次三項確切 mutation 見下表，其中一項 **SURVIVED**。

| ID | 本次實際命令 | 結果 |
|---|---|---|
| E1 | `claude plugin test mods/tmux-agent` | exit 0；107 pass / 0 fail |
| E2 | `claude plugin validate mods/tmux-agent` | exit 0；✔ Validation passed |
| E3 | `zsh scripts/test-result-schema-smoke` | exit 0；summary: 89 passed, 0 failed |
| E4 | `zsh scripts/test-version-sync-smoke` | exit 0；version-sync smoke: 8 passed, 0 failed |
| E5 | `claude plugin test "$S/adversarial"` | exit 1；107 pass / 1 fail；新增整輪時間反例 received 12000 |
| E6 | `zsh "$S/scripts/test-classifier-review-smoke"` | exit 1；classifier review: 10 passed, 4 failed |
| E7 | `git hash-object <register.ts>`、`git rev-parse 4d0af09:mods/tmux-agent/hooks/register.ts`、`git diff --no-index <repo-file> <scratch-file>` | 原樹與 adversarial subject 相同；mutation-terminal 的單行差異已核對 |
| E8 | `git status --short`、`git diff --exit-code`、`git diff --cached --exit-code`、`git rev-parse HEAD` | 測試時 tracked/index 不變；最後保存檢查出現兩個並行 modified paths，見下方實際狀態；HEAD 未變 |

所有 code／mutation／probe 與 log 留在 S。主要 logs：`head.log`、`adversarial.log`、`classifier.log`、`mutation-first.log`、`mutation-break.log`、`mutation-terminal.log`。

### A1–A4 與仍開啟項目

縮寫 **R** = `mods/tmux-agent/hooks/register.ts`；**A** = `skills/tmux-agent-tools/scripts/agent-tmux`。FIXED 限於原 finding 的具體行為；新問題另列。

| Item | Verdict | file:line 與理由 | 本次命令 |
|---|---|---|---|
| A1：first claim 因短 ancestry window 無限 DEFERRED | **FIXED** | R:702–705 首筆不受共享 deadline 截斷，R:745 每個 subprocess 仍 cap 2000；移植的 200/1900 ms 反例現在通過，tail 可交付。這不等於整個 hook 有界，見 B1 | E1；E5；M-first、M-break |
| A2：Error prose／工具續行誤判 | **NOT FIXED** | 舊 Error handling 與縮排工具續行已過；A:7154 的 API Error 前綴仍接受 prose，column-0 Error: 引述也被判 login_required，見 B2 | E6 |
| A3：⚠ Individual quota reached 漏判 | **FIXED**（已知 column-0 fixture） | A:7154 加入 ⚠，原已知 positive 恢復；縮排版是另列限制，不把它冒稱舊案例仍失敗 | E6 |
| A4：terminal deferred 留在 stalled API | **FIXED** | R:665 記錄已讀 terminal，R:1165 排除它們後清舊 maps；原測試在 HEAD PASS；lead 看見的失敗是 M-terminal | E1；E7；M-terminal |
| N3：classifier 來源辨識 | **NOT FIXED** | 前輪反例改善，仍不能由 column 0 判定是 CLI 自己的錯誤；縮排 error 的反方向限制也存在 | E6 |
| N4：已完成結果被 probe／留 stale state | **FIXED** | unfinished 與 terminal 分流均成立；已讀 terminal 不再 probe，舊 stalled entry 清除 | E1；M-terminal |
| N5：未完成 ancestry 被 ack／永遠延後 | **FIXED**（既有反例） | DEFERRED 不 ack、scan continue；每次正常完成 collect 時，首筆得到兩次完整 timeout。舊反例與 head-of-line test 通過；hook 若超時是 B1 的另一條失敗路徑 | E1；M-break |
| F2：有限預算下可靠完成交付 | **NOT FIXED** | Git wait 本身有界；但 R:653–705 以 out.length 限制而非 examined rows，DEFERRED continue 可把結果讀取拖過 hook 時限，見 B1 | E5 |
| F5：blocker 證據足以宣告確定停滯 | **NOT FIXED** | API Error prose 與 column-zero 引述仍 false positive；「no result will arrive」比純文字訊號可證明的事更強 | E6 |

### 新／殘留 findings，依嚴重度排序

#### B1 — P2：continue 讓預算耗盡後仍可讀整個長尾；整輪可能超過 hook budget

Source：**R:653–658、:701–705、:1174–1199**。這是新增 continue 帶來的額外 result-read 工作，不把既有 scan 的所有無界 I/O 都冒稱本 commit 引入。

只靠 `out.length < BATCH_MAX` 限制不了讀了多少 worker：DEFERRED 不加入 out。首筆把 4 秒 Git budget 用完後，後面每個 result 仍讀取、stat、解析，再回 DEFERRED，直到整個 ready 清單結束。已驗完的第一筆也要等 collect 返回，才能 submit。

E5：20 個 success+commit workers；每份 result read 的模擬成本 400 ms，其他 filesystem mocks 沒有延遲；只有第一筆真的跑 Git，兩次各 2000 ms。測試先確認：
```
windows == [2000, 2000]
wake.length == 1
```
再檢查整輪時間，得到：
```
Expected: < 10000
Received: 12000
107 pass
1 fail
```
其中 8000 ms 是結果讀取，4000 ms 是 Git。這是 mock-clock counterexample，不是本機實測花了 12 秒；也沒有聲稱已在真實 engine 看到 abort。SDK snapshot 的 `mods/types/claude-code.d.ts:10177`–:10178 明寫 hook budget 為十秒 real time，R:99–101 也依此設計；`session.start` 在 R:1573 await 同一 reconcile。因此「只把 Git 壓在 4 秒」不能證明 hook 安全完成。

首筆豁免的**精確 bound**：

- Infinity 只給 checkCommit 的共享 deadline，不傳給 process.run；每次 process timeout 仍為 min(2000,left)，首筆最多兩次。
- 在 process timeout 正常履行、時鐘單調的假設下，Git subprocess 的總允許等待量仍約 4000 ms。共享 deadline 在首筆開始時設定，後面的 Git 只拿剩餘量，**不是首筆 4 秒再額外送整批 4 秒**。
- 首筆 command 間的 IPC／scheduling 成本不受該共享 deadline 限制，因此 wall time 並非嚴格 4000 ms；再加 scan、N 次 result read/stat、JSON work、可選 4000 ms stall sweep、submit/store，**沒有與 N 無關的整輪最壞上限**。
- 本次沒有實測引擎 dispatch timeout 的真實觸發時間；十秒限制有 repo SDK 文件依據，12 秒則是可執行的模擬路徑證據，兩者不能混成一次 live timeout 證明。

**修復與驗證**：給「本輪讀多少／做多久」有限預算並保存掃描位置，讓剩下的下一 tick 繼續；同時保留已通過的同 tick 短尾 no-git case，不能簡單回復原來的 break 而重引入 starvation。若完整 claim 無法安全塞進剩餘 hook 時間，就跨 tick 保留 phase progress。用本 20×400 ms case，加上未完成 rows／stall sweep／submit 的耗時；驗證每輪有界且所有結果最終各送一次。任意長尾全部「同 tick 交付」與固定 hook budget 不能同時保證，文件需要說清楚 bounded window。

#### B2 — P2：column 0 是排版條件，不是錯誤來源；API Error prose 還重現舊問題

Source：**A:7151、:7154–7155**，phrase table 在 **A:7116–7117**。

E6 的十個 controls 都 PASS，包含原先七個反例、⚠ quota、rate-limit、claude retried。新增以下兩個負例卻 false positive：

```
INPUT:
Regression fixture (expected output):
Error: invalid api key
The test now passes.
› Ask Codex

OUTPUT:
login_required<TAB>Error: invalid api key
```

```
INPUT:
API Error handling for invalid api key responses is now implemented.
› Ask Codex

OUTPUT:
login_required<TAB>API Error handling for invalid api key responses is now implemented.
```

第二個只是原 A2 的「Error handling」換成 API Error handling：API Error 仍未要求冒號。第一個則證明即使補齊冒號，明確的引述也能在 column 0；該 parser 沒有讀取文字來源或 quoted-block 狀態。這些是受控 pane inputs，不宣稱已捕捉某家 CLI 當前的真實 TUI 排版。

**修復與驗證**：至少把 API Error 的 grammar 與已知 CLI error 形狀一致，加入此 negative control。對無法從 pane 分辨來源的 Error: 行，不應宣告「CLI 自己停了，結果不會來」；要麼取得可辨識的 CLI error-block／結構化狀態證據，要麼把通知降為帶原文的疑似 blocker observation。繼續逐字擴充 whitelist 無法排除「worker 引述與 CLI error 是同一段文字」的根本歧義。

### Column-0 的反方向測試與限制

E6 也執行 user 指定的 indentation 攻擊：

```
"  ■ You’ve hit your usage limit."  -> <empty>
"  Error: rate limit exceeded"      -> <empty>
```

A:7154 的 line==body 刻意排除這兩種輸入；claude 的 `⎿ API Error` 走 :7148–7151 的例外分支，縮排仍能匹配。故 column-0 不是跨 CLI 的通用規則。

這兩個 fixtures 按「producer 是 CLI error」設定的 expected quota_exhausted 均 FAIL。但**目前支援的 CLI 是否實際用這兩種縮排為 UNCONFIRMED**，沒有 live capture，也沒有啟動 CLI。本輪不以這兩個 hypothetical layouts 單獨立新的 release blocker；它們界定現有規則的支援邊界。相較之下 B2 已直接反證「column-0 文字一定是 CLI 自己的錯誤」的判斷。E6 總數為 10 pass / 4 fail，不能把四個都說成四次 live CLI regression。

### Mutation 與測試可信度

| Mutation | 命令／差異 | 結果 |
|---|---|---|
| M-first | `claude plugin test "$S/mutation-first"`；僅把 R:704 的 `first ? Number.POSITIVE_INFINITY : gitDeadline - started` 改為 `gitDeadline - started` | **SURVIVED**；exit 0，107 pass / 0 fail |
| M-break | `claude plugin test "$S/mutation-break"`；DEFERRED continue 改回 break | **KILLED**；exit 1，106 pass / 1 fail；head-of-line test expected w0@0,w2@0，received w0@0 |
| M-terminal | `claude plugin test "$S/mutation-terminal"`；移除 terminal filter | **KILLED**；exit 1，106 pass / 1 fail；stalled API expected empty，received w1:180 |

M-first 的 register.ts blob SHA-1：`ec1c16a8f39895136ca5ce6d7c6f35556e66b85a`；diff 已核對只有上述一行。它保留「deadline 從首筆開始」的另一半修復，所以舊 200 ms read fixture 不再耗掉 first budget，該案例即使沒有豁免仍能過。這說明當前 suite **不能獨立證明首筆豁免不可移除**，不是說本 patch 沒有執行豁免。

Lead 的「first-check-budgeted 被殺死」可能使用不同 mutation；未取得其確切 diff，不能斷言 lead 造假，也不能把自己的 SURVIVED 改報 KILLED。建議補 command 之間 overhead 的 focused control，讓只有豁免存在時才能保證 full-window failure 被回報。這是測試 coverage gap，與 B1 的 production subject 反例分開。

### 其餘已核對事項

- A4 的 terminal 集合在 result read 確認終態時就加入（R:665），不依賴 commit 是否當輪驗完；清 stalled／blocked／exited 的目的成立。
- N5 的 DEFERRED 仍不加入 finished 或 ack，continue 的新 test 有效，M-break 證明不是 vacuous。
- N1／N2／N6 的前輪修復未在此 diff 改壞；107 原測試、89 schema checks、version checks 均通過。reload/adoption 可多一次 notice 的明訂取捨沒有重新列為 finding。
- 本輪沒有推論 19/19 mutations 與 run-all-smokes 都可信或都不可信；本報告只承諾上列執行過的結果。
- 在 source 及 SDK snapshot 尋找 budget 後，已把「Git timeout」、「整個 collect wall time」、「真實 hook grace」分開；沒有拿 test default 5000 ms 當 plugin hook budget。測試預設五秒在 `mods/types/claude-code.d.ts:10309`，是另一個限制。

### 修復順序與保存狀態

1. 先修 B1 的 bounded scan／cross-tick progress，保留現有 A1 與 no-git tail tests，加上 result-read 成本；不要以加大任意 timeout 掩蓋無界工作量。
2. 修 B2 的 API Error prose，並收斂文字來源不足時的通知語義；indented positives 必須以實際支持的 profile captures 決定，不能靠猜測新增分支。
3. 補能殺死精確 M-first 的 focused test，再重跑本報告的原 suite／反例／mutations。以上仍未完成前不建議 push。

測試時僅有既有 `?? .review/`；寫入 report/result 後的最後檢查則觀察到：
```
$ git status --short
 M scripts/test-dispatch-delivery-smoke
 M skills/tmux-agent-tools/scripts/agent-tmux
?? .review/
$ git diff --quiet
<empty stdout; exit 1>
$ git diff --cached --quiet
<empty stdout; exit 0>
$ git rev-parse HEAD
4d0af09ceafecb09b3cd8ff1320c846c5f22cfc3
```

這兩個 tracked modifications 在本次最後檢查才出現；本次沒有寫入它們，也沒有回復或納入審查。已用 `git show 4d0af09:...` 比對兩個 runtime classifier 函式及其間註解，結果 `classifier_block_unchanged=true`；register.ts blob 仍是 `3d21d224a5c695c07cbbffbc72455ceec4ac12ab`。因此既有測試／classifier 結論仍對應目標 commit，但不能聲稱最後工作樹乾淨。

舊報告完整保留，只追加本節；result JSON 與 scratch 在 repo 外。沒有 commit，故 JSON 不填 commit。`status: success` 表示本次審查已交付，不表示 patch 可以 push。

找到：原 A1／A3／A4 已修；整輪長尾時間與 column-0 來源判別仍有缺陷，另有一個存活 mutation。已做：107/0 重跑、雜湊辨識、反例／mutations、逐項判定與 artifact read-back。下一步：按上述順序修正後再審；未推送。

VERDICT: BLOCK
