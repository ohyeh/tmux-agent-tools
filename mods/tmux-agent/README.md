# tmux-agent (function-hook mod)

派工給 `agent-tmux` worker，並且**由這個 mod 負責等**：收集端 session 每 10 秒
對帳一次 `result.json`，worker 收工時直接把結果送進你的 session —— 即使那個
session 正閒著沒人看。

這是獨立的 `tmux-agent` plugin（source `mods/tmux-agent`），只有 Claude Code 的 function-hook mod。
skills、Bash gate 與獨立 TUI（`tmux-agent-tui`）在 `tmux-agent-tools` plugin 或全域 `npx skills` 安裝裡。
shell 路徑（`agent-tmux ... assign` + `result wait-required`）繼續服務 codex／
cursor 等沒有這個 mod 的 runtime。

## 前置條件

- **Claude Code 2.1.287 以上**：mod 預設開啟，不用設 env（claude.dev getting-started，
  2026-10-01：「Claude Code 2.1.287 or later. Mods are on by default」；本機 settings 已設
  env，預設值未在本機驗證）。
- **更舊的版本**：要設 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`。沒設的話這個 plugin 不會
  載入，`assign` 工具不會出現。
- state root 必須是絕對路徑（見下）。

## 安裝

```sh
claude plugin marketplace add ohyeh/tmux-agent-tools
claude plugin install tmux-agent@tmux-agent-tools        # mod
claude plugin install tmux-agent-tools@tmux-agent-tools  # skills + Bash gate（有全域 skill 可不裝）
```

只裝 mod 時沒有 Bash gate（GATE 1/2）；mod 自己的 Bash guard 仍擋手打的
`agent-tmux … assign|send|send-wait|stop|status|…`。

mod 匯入的 core 是 `hooks/lib/` 的複製（plugin cache 只有 `mods/tmux-agent`）：改
`skills/tmux-agent-tools/scripts/lib/` 後跑 `scripts/sync-mod-core`，version-sync smoke 會比對。

開發時掛 mod 目錄：`claude --plugin-dir mods/tmux-agent`（要 skills/gate 就再加 `--plugin-dir .`）。

裝完就能用，不用再跑 install-bin：`agent-tmux` 不在 `PATH` 上時，mod 自己用同一個
marketplace checkout 裡的那份（`~/.claude/plugins/marketplaces/tmux-agent-tools/…`），
其次是 `npx skills` 裝的 `~/.agents/skills/tmux-agent-tools/…`，用了哪一份會 log 一行。
都找不到時 `assign` 直接 deny，訊息寫出找過的位置——讀它的是 model，它自己就能補裝。

## 收集端：每個 session 都是

沒有設定。裝了就收：每個 session 起 10 秒時鐘，對帳**自己派的** worker，收工
時喚醒你；同 repo 死掉 session 的 worker 90 秒沒心跳就認領（owner 規則見下）。
0.6.x 的 `mode` 選項（`lite`＝只派不收）在 0.7.0 拆掉了：不收的 session 只是
把結果丟回給人自己收，正是這個 mod 要補的洞；各 session 只投遞自己的，所以
多個 session 同時收也不會重複。

多個 session 共用的是一本帳：state root 下的 `.v3/`（workers-core 合約 v6）。它不放在
`$.store`（store 沒有原子的 read-modify-write），每一筆都是檔案系統的原子動作：

- `.v3/<name>/worker.json`：worker 的身分，assign／resume 時寫一次，之後不改。
- `.v3/<name>/episodes/<seq>/dispatch.json`：每一輪（assign 是第 1 輪，每次 `tell` 開下一輪）
  的描述，寫一次不改：`seq`、`since`、開它的 session（第 0 代 owner）、`goal`、`base`、
  這一輪的 `resultPath`、`origin`。
- `episodes/<seq>/sent/`、`acks/<kind>/`：`mkdir` 建一次、不刪不剪。`acks/done|expired|cancel`
  關掉這一輪；`acks/launch|exited|unattributed-*` 只記通知送過了。
- `episodes/<seq>/claims/<gen>/owner`：接手孤兒時 `mkdir` 下一代，搶輸的拿到 `EEXIST`。
- `.v3/.sessions/<hex(sid)>/act/<n>` 加 `.beat`（key 是 session id 的 UTF-8 位元組 hex）：每次 reload 註冊一個 activation，每次對帳
  更新心跳；同一個 session 只有最新的 activation 收，舊的停下來並說明原因。
- `.v3/<name>/.action`：每個 worker 一把 `ln -sn` 鎖，內容是持有者（session、host、pid、pid 起始時間）。
  tell、開新一輪、復原、stop／cancel、autoStop、waiter 綁定與釋放在鎖裡做；ack 是 create-once
  目錄，不進鎖（重複送只會 `EEXIST`）。鎖卡住（持有者當掉）時用 `/workers unlock <name>`：
  先回報持有者、要你確認所有對這個 worker 的動作都結束了，再打 `/workers unlock <name> confirm`；
  它只在持有者同一台機器、session 已不 live、pid 已不在（或被重用）時才拔鎖，否則照樣說 busy。
  unlock 與一般 release 的 `rm` 都在維護區段 `<lock>.unlock` 內；它是被當掉的程序留下、且仍有未完成的
  `rm` 子程序時，不會被接手。要手動清掉它，先確認沒有那個 `rm` 子程序（`ps -ax | grep "rm "`）。
  unlock 已拔鎖、但 `.unlock` 自己拔不掉時，結果是失敗（not ok），文字會寫出 `.unlock` 路徑、`rm` 的原始錯誤，
  以及清除用的 `rm '<路徑>'`。
- `/workers cancel <name> <seq> [--force]`：只關掉那一輪（`acks/cancel`），不動 pane；`stop` 才殺 pane
  並把所有開著的輪次一起關掉。shell 上同一套是 `node skills/tmux-agent-tools/scripts/lib/workers.cli.node.ts
  cancel <name> <seq> [--force] | unlock <name> [confirm]`（`--session` 必填；沒有 session 的 viewer 不能 `--force`）。
- 投遞的 reservation（plan §1c S8）：collector 在 submit 之前，於 action lock 內重查這一輪還開著，
  再寫 `episodes/<seq>/delivering`（`{token, activation, session, at}`，tmp＋rename），放鎖後才 submit；
  ack 之後在鎖內比對 token 才刪（token 不同＝已有新的 reservation，不刪）。submit 被拒也會刪。
  讀這個 marker 的結果只有三種：`in-flight`（marker 的 activation 是該 session 目前權威的 activation 而且 live）、
  `stale`（activation 已被取代，或 session non-live）、`unknown`（讀不到，不當 stale）。
  - `stale` 或 `unknown` 的那一輪，band 與 TUI 的列都是 `unknown`，文字是 `unknown: 可能已送達`。
    普通 `cancel` 在 `in-flight` 回 `in-flight`，在 `stale`／`unknown` 回 `unknown: 可能已送達` 而且**不關**。
  - `cancel … --force`（TUI 選取那一列按 `-`，鍵位提示變成 `force-close`，一樣按兩次）只在 `stale` 時成立，
    只寫 `acks/cancel`：之後的 reconcile 不再投遞、不重試。它不撤回已經送出的 submit，不寫 `done`，
    也不說「沒送達」；回報文字維持 `unknown: 可能已送達`。`in-flight`、讀不到時 `--force` 也拒絕。
  - 只有 reconcile 的 submit 會寫 marker。MCP 的 `wait` 回覆與 ack（`mcp-adapter`）走自己的 request-id 路徑，不經這個 marker。
- resume 之後 pane 死掉：resume 出來、還沒 tell（沒有 episode）的 worker，pane 不在時列保留，狀態是 `exited`
  （`resumed worker: its pane is gone …`）；`tmux ls` 沒回答時是 `unknown`，不是 `exited`。
  用 `stop`（band 的 `✕`、TUI 的 `x`）記下「這是我停的」（`<name>/stopped`）後那一列才離開；
  在這個 mod 之外用 `agent-tmux stop` 或手動關掉的，列會留著直到在這裡 stop 一次。

ack 是目錄，不是 store key，所以沒有「誰蓋掉誰的 ack」，也沒有剪除與容量預算。
0.11 以前的紀錄（state root 直下的 `<name>/dispatch.json`）不支援：不匯入、不計數、不顯示。

settings 裡若還留著 `pluginConfigs.tmux-agent.options.mode`，engine 會忽略它
（`claude --debug` 印 unknown option），拿掉即可。

## 它要哪些權限

| 面 | 用途 |
|---|---|
| `process.run` | 派工（`sh -c 'nohup agent-tmux <profile> assign --detach ... &'`）、停滯探測（`agent-tmux <profile> status --json`）、面板鏡像（worker：`agent-tmux <profile> capture --strip-ansi --tail N`；專案 session：`tmux capture-pane -p -J -t <name>`）、隊友追話（`result init` + `send --prompt-file`）、收工（`stop`）、按 id 接回（`agent-tmux <profile> resume --exact <name> <dir> <id>`，以及對 claude／codex 的 session log 跑 `grep -m1 -o '"cwd":"[^"]*"'`），以及每 10 秒一次 `tmux list-sessions -F '#{session_name}\t#{session_path}\t#{session_created}'`（專案列；不在 2 秒時鐘上）；按 `[ ⧉ ]` 時一次 `/bin/sh -c` 找 `node`、`agent-tmux` 旁的 `lib/tui.node.ts` 與 `tmux-agent-tui`，在 tmux 裡再一次 `tmux split-window` |
| `fs.read/write/list/stat` | 寫只在 state root 的 `.v3/` 底下：`worker.json`、每輪的 `dispatch.json`／`tell.md`／`waiter`、`brief.md`、`launch.exit`、`mod-assign.log`、`result.json`、activation 心跳。建目錄、`ln -sn` 鎖、`mv` 發佈、`rm` 走 `process.run`（引擎的 `fs` 沒有 mkdir／rename）。state root 之外只讀、只在按 `[ + ]` 或打 `/workers resume` 時：列出 `~/.claude/projects`、`~/.cursor/chats`、`~/.codex/sessions/<年>/<月>/<日>` 的目錄名，讀 cursor 的 `<id>/meta.json` 和 agy 的 `cache/conversation_metadata.json`（只取 cwd） |
| `fs.exists` | state root 之外兩種用途：找 `agent-tmux` —— 依序查 `PATH` 各目錄的 `agent-tmux`，再查 plugin／skill 安裝位置那一個檔名；以及 `resume` 找 session id 在哪個 CLI 的 store（下面 `[ + ]` 那節列的路徑）。只問「在不在」 |
| `store.get/set/keys/delete` | 只放 UI 偏好：面板開著沒（`tmux-agent.panel`）。交付帳不在 store（見上面 `.v3/`） |
| `tool.call` on `Bash` | **攔截**：mod 載入時，手打的 `agent-tmux <cli> assign/send/send-wait/stop/status/capture/probe/result` 會被拒絕並指向對應工具；帶 `--help` 的命令放行（gate 不擋；wrapper 本身接不接受 `--help` 是它的事） |
| `agent.spawn` | brief 有一行 `runtime: tmux/<profile>` 時派工，並把這次 Agent 呼叫改成 `tmux-waiter`（haiku、背景；清單裡看得到——`isOffered: false` 連派工也擋）。設了 `name` 則拒絕。waiter 沒註冊成功時，維持舊的拒絕。沒有那一行則原樣放行 |
| `$.agent.register` | `session.start` 註冊 `tmux-waiter`（只有 Bash、haiku、不帶 CLAUDE.md）。失敗 log 一次，之後 runtime spawn 改回拒絕 |
| `$.agent.list` | 面板開著時，跟 2 秒時鐘一起讀本 session 的 agent（含 teammate），數 `status === 'running'`，寫進標題的 `內部 M`。collector 用同一份清單對這一輪 `episodes/<seq>/waiter` 的 `agentId`。面板上失敗顯示 `內部 ?` 並 log 一次。對帳時 `agent.list` 丟出：有 waiter 的通知留著（unknown 不是沒有 waiter），沒有 waiter 的照送。 |
| `prompt.submit` | worker 收工時喚醒 session —— 這個 mod 唯一不可取代的能力 |
| `clock.every` | 兩條時鐘：10 秒對帳（永遠跑），2 秒面板鏡像（只在面板開著時存在） |
| `ui.render/resolve/invalidate` | `/workers` 面板（畫在 `AbovePrompt` band；沒有 pane，所以沒有 `ui.open/close`） |
| `ui.toast/log` | 診斷，不開 turn（不用 `ui.status`：引擎把它釘成 `⚠ tmux-agent: …` 直到被換掉） |
| `env.get` | 只讀四個：`TMUX_AGENT_DIR`、`XDG_STATE_HOME`、`HOME`、`PATH`（找 `agent-tmux`） |

**它不做的事**：沒有 `http.fetch`，不連網；不讀 credentials、shell history 或 state root 以外的檔案內容；不寫任何環境變數（pin 裡 `env writes: nothing`）；不改 `AskUserQuestion` 或其他工具的輸出。以上都能從下面那份 pin 對出來——pin 沒列的 API，mod 就沒有呼叫。

`claude plugin validate mods/tmux-agent` 會把以上逐條印出來對帳。那份輸出釘在
[`permissions.txt`](permissions.txt)，`scripts/test-mod-permissions-smoke` 在 CI
比對：權限面任何變動都必須是一個看得見、被 review 過的 diff，不能是重構的副作用。

## 原生 sub-agent 列 (0.10.0)

Agent tool 的 brief 裡若有單獨一行 `runtime: tmux/<profile>`，mod 會照 `assign` 派出 tmux worker，同時讓這次 Agent 呼叫繼續跑一個 haiku sub-agent（`tmux-agent:tmux-waiter`）。它只用 Bash，一次一個迴圈、每次不超過 540 秒（Bash timeout `600000`），每 5 秒看一次絕對路徑的 `result.json`（要到終態 status；agent-tmux 開工時先寫一份 `pending`）與 `launch.exit`，總共最多 60 分鐘，然後只回答 worker 名字、狀態、摘要和 result 路徑。

原生 sub-agent 列，以及只看主 transcript 裡名為 `Agent`／`Task` 的 tool_use 的 claude-hud，因此跟 worker 同時存在。runtime spawn 在 action lock 裡先把 `{binding:true, token}` 寫進 `episodes/1/waiter`，`next()` 回來後改成 `agentId`。collector 的規則是：

- waiter 還是 `running`：不 `prompt.submit`，也不 ack
- waiter `completed` 且 result 已是終態：靜默 ack（它的 `turn.complete` 就是交付），之後的 tick 不再喚醒
- waiter `failed`、`killed`、或清單裡已經沒有（例如 reload 之後）：照舊喚醒一次
- `$.agent.list` 失敗：有 waiter 的通知不送，沒有 waiter 的照送，並 log 一次

這行 spawn 不可以帶 `name`（有名字會變成閒置的 teammate，永遠不會 `completed`）。拿掉 runtime 那一行之後，brief 仍要有 GOAL、ACCEPTANCE、REPORT。`assign` 工具本身的行為不變。

## 隊友：assign → tell → stop

目標是「只開一個 Claude Code，其他 coding agent 當隊友」。派工三個工具，卡住時兩個，
面板與更新各一個：

| 工具 | 做什麼 |
|---|---|
| `mcp__tmux-agent__assign` | 派一個 brief 給 `<profile>`，立刻回傳；收據最後一句說 collector 會不會叫你 |
| `mcp__tmux-agent__tell` | 對同一個 worker 再說一句（下一個任務、修正）。它開下一輪 `episodes/<seq+1>/`（自己的 `result.json` 路徑與 `episode` 編號），把訊息連同這兩者送進去——collector 監看這一輪，worker 回到面板。對別的 session 派的 worker 也能用：新的一輪由你開，結果送你 |
| `mcp__tmux-agent__stop` | 停掉 worker 並把它記為已回報，離開面板；之後不會再有任何投遞 |
| `mcp__tmux-agent__peek` | 卡住時先看：pane 最後幾行，加上 running／idle／gone／needs input |
| `mcp__tmux-agent__keys` | 回答 worker 停著的信任／權限對話框（只收白名單鍵）；答完用 `tell` 重送 brief |
| `mcp__tmux-agent__panel` | 開或關 `/workers` 面板，和人打 `/workers` 同一條路 |
| `mcp__tmux-agent__reload` | `claude plugin update` 之後，本輪結束時跑 `/reload-plugins` |

**自動 stop（0.7.7）**：每一輪都已關閉（最新一輪的終態 result 已交付）、之後 30 分鐘
沒有 `tell` 的 worker，會在一個沒有交付的 tick 被停掉——走 `stop` 同一條路，所以離開面板——並留一行 log／toast：`auto-stopped "<名字>" — its result was delivered and it had no
tell for 30 min`。30 分鐘從派工／最後一次 tell、result 的 `finished_at`、本次載入的交付時間三者
最晚的那個算。不會停：別的 session 的 worker、沒有終態 result.json 的（`tell` 會把它重設，也就是
進行中的一輪）、pane 已經不在的。每個 tick 最多停一個；session 啟動那一輪不停。

`tell` 的 `since` 保證嚴格大於上一輪（`max(now, since+1)`），因為 id 是
`<name>@<since>`；同一毫秒內的兩次 tell 或粗粒度時鐘若撞到同一個 since，新一輪
會繼承舊一輪的「已投遞」標記而永遠不被收集。

### 隊友是誰都行

`profile` 是 agent-tmux 的 cli 或 profile 名：內建 `claude`／`codex`／`agy`／
`cursor`／`grok`，未知名字走 generic 預設，要調就寫一個
`~/.config/agent-tmux/profiles/<name>.conf`（純 `key=value`，不會被 source）。
`profile` 填 `<name>` 本身，不含 `.conf`（wrapper 自己補；填 `glm.conf` 會去找
`glm.conf.conf`）；名字打錯不報錯，會當 generic 起，直到 assign step 0 找不到同名
binary 才失敗。現有清單看 `ls ~/.config/agent-tmux/profiles/`。
例如把 cc-switch 裡某個 provider 的設定拿出來，起第二個走 gateway 的 claude：

```sh
sqlite3 ~/.cc-switch/cc-switch.db \
  "select settings_config from providers where name = 'LLM-GATE GPT-PRO';" \
  > ~/.config/agent-tmux/llm-gate-gpt-pro.settings.json
```

```ini
# ~/.config/agent-tmux/profiles/gpt-pro.conf
bin=claude-fable
launch_flags=--settings ~/.config/agent-tmux/llm-gate-gpt-pro.settings.json --dangerously-skip-permissions
heuristic_family=claude
approval=auto
result_required_fields=status,summary
```

然後 `assign` 的 `profile` 填 `gpt-pro`。profile 的其他鍵（`prompt_delivery`、
`preflight_flags`、偵測 pattern）見
`skills/tmux-agent-tools/references/profiles.md`。`launch_flags` 是 pane shell
會執行的原始片段，跟 profile 同一信任等級，不要從不可信輸入填。

### mod 載入時不要用 Bash 打 agent-tmux

`tool.call` 攔 `Bash`：`agent-tmux <cli> assign|send|send-wait|stop|status|capture|probe|result`
會被拒絕，訊息指向該用的工具（或說「collector 會叫你、`/workers` 看得到」）。
理由是兩個：只有工具會寫 `.v3/` 的帳，手打的 assign collector 永遠聽不到；
而 status／capture／result 是第二個監督者。`--help` 放行。這個 gate 跟
`~/.agents/hooks/tmux-assign-host-gate.sh` 守的是同一件事——那個 shell hook 是給
沒有 mod 的 session 用的，mod 在時以 mod 為準。

## state root

照 CLI 自己的順序解析，派工端與收集端共用同一份：

1. `TMUX_AGENT_DIR`（必須絕對路徑）
2. `XDG_STATE_HOME` + `/tmux-agent-tools`
3. `HOME` + `/.local/state/tmux-agent-tools`

三者都解析不出絕對路徑時，這個 mod 什麼都不做，而不是猜一個暫存目錄。

## 派工的身分規則

每次 `assign` 會鑄一個**新目錄**：`<你給的名字>-<base36 時戳>`。這是 ownership
判準 —— 新目錄裡的 `result.json` 不可能來自上一代，所以同名重派永遠不會收到
上一次的結果。工具回覆會告訴你實際的 worker 名字。

紀錄要帶 `dispatch.json` 且 `name` 等於所在目錄名才算這個 mod 的 worker；shell 路徑派
的由它自己的呼叫端收，這個 mod 不碰。之後分兩層——**看得到／管得到**與**結果送給誰**
是分開的：

| 範圍 | 規則 |
|---|---|
| `/workers` 列表、`tell`、`stop`、`peek` | **同一個 repo**（`ownerCwd` 等於本 session 的 cwd，字串相等）的所有 worker，不管誰派的、派它的 session 活著沒。別人派的列上標 `@<sid 前 8 碼>`。別的 repo 的看不到。 |
| 結果投遞 | 只送給這一輪的 owner（最高一代 `claims/<gen>/owner`，沒有就是開這一輪的 session）。owner 的最新 activation（編號最大的那個，只看它）心跳停超過 90 秒（或沒有心跳、過了寬限期、確認 `ENOENT`）才算它死了；`EACCES` 等錯誤一律當 unknown，不接手。同 repo 的 collector 這時 `mkdir claims/<gen+1>` **認領**，搶輸的拿到 `EEXIST` 不送；這一 tick 不送，下一 tick 只有新 owner 送。 |
| `tell` | **誰開的這一輪，這一輪就歸誰**：別的 session 對你的 worker `tell`，新的一輪的 owner 是它，答案送它；你已經開的輪次照樣送你。 |
| resume | `claude --resume` 回來的 session id 不變（實測：transcript 每份只有一個 sessionId，resume 寫回同一份），所以 owner 不變、零等待。只有「關掉、另開新 session」才走 90 秒認領。 |

同 repo 的判準是 cwd 字串相等：在子目錄或 worktree 開的 session 算另一個 repo。
`$.tmux.outstanding()`／`stalled()` 與停滯探測仍只看自己的 worker——探測是每個
worker 一個子行程，每個 session 都去探別人的會倍增。

## 從 model 開關面板：`panel`

`panel` tool（`action`: `open` 預設，或 `close`）跟人打 `/workers` 走同一段程式，reload 後一樣會自己重開。
已經開著／關著時只回報，不會反過來切換。派完 worker 後開面板，讓人看得到進度。

## 更新 mod：`reload`

`claude plugin update tmux-agent@tmux-agent-tools` 之後，呼叫 `reload` tool：它在這一輪結束時執行
`/reload-plugins`，面板標題會顯示新版號。不必等人手打 `/reload-plugins`。
reload 會重跑 module，面板原本會跟著關掉；0.7.10 起開著的面板會自己重新打開（記在 store 的 `tmux-agent.panel`，只記這個 session），但選中的列不會保留。

## launch requested ≠ worker started

外層 shell 立刻退出，它的 exit code 只代表「背景指令已排入」。真正的 launch
收據是 child 自己寫的 `launch.exit`：

- `launch.exit` 非 0 → 對帳時以 `launch-failed` 回報：wrapper 在 `mod-assign.log`
  最後那個 JSON 物件裡寫的 `failed_step` 與 `diagnostic`，加上 log 路徑；全文留在檔案裡
  （0.7.6 以前貼最多 12,000 字元的 log，真正的原因埋在 brief 回顯底下）。log 沒有 JSON
  物件時附最後 5 行。**不會**讓你等一個永遠不會出現的 result。
- worker 開在從沒信任過的目錄時，CLI 會在開機後才畫 workspace-trust 對話框。assign 送出前
  要看到 pane 靜止 3 秒且沒有對話框（最多看 10 秒，每次都查對話框）。workspace-trust 對話框
  （選項停在 yes／trust）由 assign 按 Enter 信任，最多兩次，再送 brief：worker 被派到這個目錄，
  就信任它。其他對話框一律**不送**、不替你回答，以 `failed_step: send`、`the brief was NOT sent`
  結束。`peek` 看對話框、`keys` 回答，再把 brief 用 `tell` 送一次，整份 brief 就會到。
  2026-09-25：agy、claude、claude-fable-gate 的 brief 都被晚出現的對話框吃掉（claude 吃掉前半）。
- `failed_step: confirm-processing` 是 brief 已送出、之後從 pane 判斷「沒在處理」。在工作中的
  worker 也曾被判失敗（cursor `Reading 22k tokens`、claude 7 秒的回合），所以通知會提醒先
  `peek` 再重派；它之後寫的 result 照樣送達。
- `launch.exit` 為 0 但還沒有終態 result → 保持 outstanding。

工具回覆本身明說 `This is NOT proof the worker started`。

## 交付與確認的順序

先送達、後記帳：

1. 掃描 → 收集終態 result（或 launch 失敗）
2. 組一則 prompt（上限 20 個 worker / 16,000 字元），送出。第一筆自己就放不下時
   （摘要 fence 後變長、dir 很長），這一筆改成不帶摘要送出（摘要留在 result.json），
   不會卡住之後所有的交付
3. 送出前重讀一次：這個 activation 還是 session 的最新一個、每一輪最高一代 claim 還是本 session；不是就不送，留給新 owner
4. **session 接受之後**才 `mkdir` 這批的 ack 目錄（建一次，搶輸的也算已記）

`prompt.submit` 可能 throw，也可能正常回傳 `{ drop }` —— 兩者都不算送達。
因此送出後、記帳前當掉最多多報一次，永遠不會靜默漏報。

連續 3 次被拒（backoff 10 秒、60 秒）後**暫停自動交付**，寫一次 log 告訴你還有
幾筆留在磁碟上；修好原因後重啟收集端 session 即恢復。暫停期間：面板第一行寫原因；
要立刻拿結果，用 `peek` 看 worker 閒置了沒，再用 Read 讀 `<state dir>/<name>/result.json`。
mod 載入時從 Claude 的 Bash 跑 `agent-tmux … result` 會被 mod 自己的 gate 擋掉。

`success` 的 result 若帶 `commit`（完整 40-hex sha），交付前在 worker 的 `dir` 驗兩件事：
`git cat-file -t <sha>` 必須是 `commit`（tag id 也解析得到 `^{commit}`，所以不能只看
存在），而且 commit 物件與祖先關係成立：`git merge-base --is-ancestor <base> <sha>`
成立且 `sha ≠ base`。`base` 是派工（`assign`、每次 `tell`）當下、worker 啟動前讀的
`git rev-parse HEAD`，記在 dispatch.json。成立 → 狀態行寫
`success — commit <sha12> verified (descends from dispatch base <base12>)`；`dir` 不是 repo
或 0.7.5 以前的紀錄沒有 base → 只能證明物件存在，狀態行照實寫
`verified (commit object exists; no dispatch base recorded)`。不是字串、空字串、不是
40-hex、不存在、不是 commit、是 base 本身、不在 base 之後 → 照樣交付（不吞），寫
`success claimed, commit <sha> NOT verified: <reason>`。只收 40-hex：SHA-256
object-format 的 repo（64-hex）目前一律記不到 base、驗不過。`base` 與 result.json 放在
同一個 worker 可寫的目錄：這個檢查是抓「幻覺出來的 commit」，不是防惡意 worker。缺 `commit` 或 `null`（唯讀／
review worker）→ 與以前完全相同。一個 pass 的讀檔與 commit 檢查共用 4 秒預算（之後的
停滯探測另有 4 秒，正常情況下合起來在 engine 的 10 秒 hook 預算內——不是硬上限：下面說的
第一筆不受預算限制，一次很慢的讀檔加兩次 git 就會超過；引擎丟掉那次 hook 時下一個 tick
重來，ack 在交付之後才寫，所以代價是重報，不是漏報）。每一 pass 從上一 pass 停下的
那筆開始，而且那一筆不受預算限制：讀檔與兩次 git 呼叫一定做完，所以每一 pass 至少結清
一筆，慢 repo 會被回報，不會永遠延後。其他 commit 檢查只有在剩下的時間放得下全部 git
呼叫時才開始，開始了就不會被截斷；放不下的、以及預算用完後還沒讀到的，留到下一個 tick
（從它開始），不會被說成「查無 commit」或「NOT verified」。所以結果是在有界的幾個 tick
內送達，不保證同一 tick。
已經讀到終態、只是在等 commit 檢查的 worker 也不會被停滯探測當成「沒有結果」，它之前的
stalled／needs-input 紀錄同時清掉。`dir` 讀不到 base 時
（不是 repo、git 沒回應）log 會寫原因。這證明的是 DAG 關係——「有一個在 base 之後的
commit」——不是這個 worker 寫的（另一條 branch 上早就在 base 之後的 commit 也會過），
更不是任務做對了。

## 掃描窗口

24 小時是**結果**的窗口，不是任務壽命：以 `result.finished_at`（缺則檔案
mtime）判定。跑了 25 小時才收工的 worker 照樣會通知你。

## 已驗證（真實 session，非 mock）

2026-09-18，0.6.0 同 repo 多 session（`agent-tmux claude start --plugin-dir`，full）：
另一個 sid 派的 worker（心跳檔新）在這個 session 的 `/tmux` 上列為
`● 1:   peer-row  @deadbeef  agent-scripts  running`；停止更新它的心跳 100 秒後，
這個 session 印 `claimed "peer-row" from session deadbeef-… (no heartbeat for 90s);
delivering from the next tick`，`dispatch.json` 變成 `owner=<本 sid>`、
`adoptedFrom=deadbeef-…`。

（下列紀錄中的 `lite`／`full` 是 0.6.x 的 `mode` 選項，0.7.0 已拆掉；行為＝當時的 `full`。）

2026-09-18，0.5.0 band 面板，互動式 session（`agent-tmux claude start` 掛
`--plugin-dir`，tmux window 160×45，lite mode）：

- 預設佈局與 `CLAUDE_CODE_NO_FLICKER=0` 兩種都跑：面板都在 prompt 正上方，
  沒有 dock 到右邊（0.4.x 在 160 欄會 dock）。
- 空 prompt 按 `1` → 該列選中（`› band-row`）、輸入列＋`[stop]` 出現、鏡像 5
  行（`band 13 rows`；`MIRROR_RESERVED` 6→5 之前差一行進不了 6 行門檻，面板
  印 `Band too short to mirror … (band 13 rows; needs 14)`——這行就是拿來看這個的）。
- `ctrl+x tab` 再按 `q` → 面板關閉、composer 乾淨（0.7.5 起是 `[ hide ]`）。
- `full` mode（`--settings` 帶 `pluginConfigs["tmux-agent@inline"].options.mode=full`）
  同一套操作再跑一次：⚠ collector 警告行消失，其餘畫面與行為相同；10 秒對帳
  時鐘與 2 秒鏡像時鐘並存，鏡像照常更新。
- 已知邊界：面板開著時存檔 plugin 目錄（熱重載）→ 新模組 `panel.open=false`，
  之後的 `q` 會打進 composer 變成 prompt。正常使用不會發生。

在 `--plugin-dir` + `--settings` + `TMUX_AGENT_DIR` 的 headless session 實跑：

- plugin 載入、`$.tmux` 掛上 engine、`assign` 工具註冊成 MCP server。
- `mode: full` 生效，startup 對帳掃到 `TMUX_AGENT_DIR` 底下的 worker，
  `$.prompt.submit` 確實送出批次通知。
- **同一個 worker 在第二個 session 不會再送一次** —— 已回報集合跨 session 生效（當時是 store；現在是 `.v3/` 的 ack 目錄）。

2026-09-17，互動式 session（`--plugin-dir`，全程未重開）跑完 P8 驗收，worker
`modtest3-opqu`（codex，經 `assign` 工具派出，`dispatch.json` 在）：

- **`lite` 確實抑制投遞**，而且是有效的 negative：worker 在 `03:48:51Z` 就寫出
  `status: success`，此後 60 秒窗口內零投遞。（先前一輪的「安靜」是無效證據
  —— 當時 worker 根本還沒到終態，分不出抑制正確、collector 壞掉、還是無事可送。
  測試要先 gate 在終態上，靜默才有意義。）
- **改 `mode` 免重啟生效**：`/config` 在 `03:55:58Z` 翻成 `full`，session 未重開，
  閘門讀到的是新值而非載入時快照。
- **對帳撿得起「開關翻之前就已終態」的 worker**：終態與翻開關相隔 **7 分鐘**，
  collector 起來後回頭撿到並投遞。這就是「lite session 結束後結果乾等」那個洞
  已補的證據。
- 投遞延遲 21 秒（`POLL_MS` 兩拍）。prompt 只能在 turn 邊界插入，當時 session
  idle，不是漏拍。投遞的 summary 與 `result.json` 的 `.summary` 逐字一致，
  `worker-output` 的 untrusted 標註正確掛上。
- brief **一個字沒提 result 契約**，worker 仍吐出合格五鍵 JSON —— wrapper 的
  契約注入（`RESULT_SCHEMA_LINE`）在真實派工路徑上生效。

2026-09-17，`/tmux` 面板在真實終端機跑完驗收（素材為 agy worker，**不是 codex**
—— 面板與 CLI 家族無關這點一併證掉）：

- **開啟但未選中任何列 → 不生子行程。** 符合 `if (row)` 才 spawn 的實作。
- **只鏡像選中的那一格。** 抓到的 argv 是
  `agent-tmux agy capture --strip-ansi --tail 3 agytrust3`，目標正是選中列；
  124 次連續取樣只見到單一目標，`max_concurrent` 從未超過 1 —— single-flight
  保證實測成立。
- **關閉後子行程完全消失。** 240 次取樣零命中，而對照組（面板開著且選中）在
  124 次取樣命中 2 次 —— 這個 0 是有效的 negative，不是取樣方法失效。
- **resize 有生效**：視窗拉高後 argv 變成 `--tail 18`。當時的結論寫成
  「`rows_available` 跟著 `scroll.bodyRows` 走」，**那個機制解釋後來被推翻**
  （見下方鏡像高度一節）：`bodyRows` 是這個 hook 自己畫出來那棵樹的視窗高度，
  用它當尺規是循環的。argv 確實變了這件事仍然成立，但它證明的是「尺寸會重算」，
  不是「bodyRows 是正確的訊號」。
- **計畫外**：選中列在鏡像進行中被對帳回報並移除，鏡像乾淨停止，125 次取樣零
  孤兒 capture。第 136-139 行的 generation 機制在真實 race 下守住了 —— 這是
  mock 造不出來的情境，是撞上來的，不在測試計畫裡。
- 唯一沒跑到的是**切換選中列**（需要兩列同時存在的窗口）。

## 已知邊界

- A cancel that lands during an in-flight pass is now caught by `stillOurs`: `stillOurs` checks `ackNames` for `CLOSED_ACKS` (cancel, done, expired) and drops any closed episode before prompt submission, so cancelled episodes are never delivered and `acks/done` is not written. (P2 gate r2 R2-8 resolved in fix-stop-deliver.)
- The lock holder pid is `$PPID` of a `/bin/sh` probe (`processId`, `skills/tmux-agent-tools/scripts/lib/workers.ts:2566`). In the collector that pid is the node process; in the engine it is UNCONFIRMED that it is the engine and not a short-lived intermediate. `unlock` also requires the holder's session to be non-live (`unlockWorker`, `workers.ts:2652`), and the waiter `binding` hold (`waiterOf` / `holderProvablyAlive`, `workers.ts:861` and `:838`) is released when that pid is provably gone — if the recorded pid is an intermediate, a binding can be released during the spawn window and E1 may be delivered by both the waiter and the collector (one extra re-report).
- `holderProvablyAlive` treats a `ps` exit other than 0 with empty output as the pid gone (`workers.ts:849`).
- The launcher steals a stale collector lock after 5 seconds (`LOCK_STALE_MS`, `skills/tmux-agent-tools/scripts/lib/launcher.node.ts:47`, used at `:122`).
- The ledger has no seq pointer file. The next activation or episode number is one past the max listed child (`allocateNext`, `skills/tmux-agent-tools/scripts/lib/ledger.ts:50`). Nothing writes or reads a pointer (plan R8.4).
- A late launch-lifecycle fold after tell E2 lands on E1's path only. `stop` (`finalize_launch_envelope`) and a result read (`reconcile_launch_envelope`) fold only `$(agent_root_dir)/$name/result.json`. That is E1's path. E1 keeps its `status` and `episode`, and E2's `episodes/2/` stays byte-identical. A second stop does not fold again. `scripts/test-wrapper-limits-smoke` case c runs this with the real wrapper. The core side is `workers.contract.node.ts` (“a seq ≥ 2 result on the launch path”).
- One tmux server for the whole chain. `TMUX_AGENT_TMUX_SOCKET` puts `-S` on every tmux call of `agent-tmux` (`TMUX_SOCKET_ARGS`) and of the node core (`host.node.ts`). `tmux-agent-commander` sets the variable from its own `$TMUX` socket when it is unset, exports it, and passes it to the `run-shell` collector. Without the variable and outside tmux, the chain uses tmux's default socket under `TMUX_TMPDIR`. `agent-tmux` never takes the server from `$TMUX`. `scripts/test-wrapper-limits-smoke` case b runs this with two private servers.
- Name collision (plan R8.5, breaking): `start`, `resume`, and `start-ssh` never replace a live session. A live `<prefix>-<name>` makes them exit 1 before they touch any state of the name. One per-name lock (`<name>/launch.lock`, `zsystem flock`; the OS drops it when its holder exits, so no stale lock and no takeover) covers the check, the state init, `new-session`, and the `pane-id` publication; a concurrent starter waits, then refuses without writing any of the winner's state. The launch publishes the pane id that `new-session -P` printed to `<name>/pane-id` through a temp file and rename, only after `new-session` succeeded. `stop` refuses (exit 1) when the session of that name does not hold that pane, or when `pane-id` is missing, empty, or unreadable. The core's `reserve` draws another name for a live session, so the refusal applies to a direct `--exact` launch.
- An earlier launch's `result.json` and `stdout.log` are kept, not harvested. A new `start` or `resume` of the same name moves them (when they are not empty) into `<name>/legacy-<UTC time>-<pid>/` and prints that path on stderr. A result from a wrapper or collector from before an upgrade stays readable at that path. Nothing reads or delivers it from there on its own.
- Incomplete reservation (plan R8.5): a `delivering` marker is trusted only with a token, session, activation and `at`, and an `act/<activation>.json` record that exists; anything else (an impossible activation, a missing record) reads `unknown`, never `in-flight`. A `delivering` marker whose activation is gone is shown as `unknown: 可能已送達`, and `cancel --force` stops new attempts only. It cannot say whether the earlier submit reached the session, and it does not try to. The next activation of the same session delivers the notice again with the same `delivery_id` (at-least-once), so the marker is replaced then. A marker left because the action lock was busy at release time stays until the next delivery of that episode replaces it; `acks/done` or `acks/cancel` makes it irrelevant. When the action lock is busy (also a stuck one, `unlock`), the acks cannot be read, or the marker cannot be written, that notice is deferred, not sent: the log gives the reason and the next pass retakes the lock, re-checks the episode is open and reserves before it submits, so a cancel can never land beside a done. A holder that crashed keeps its lock (never taken over) until `unlock`, and delivery of that worker waits with it. A worker directory that has no `worker.json` (a crash between its `mkdir` and its publish, or a writer still between them) is shown as an `unknown` row, `initializing` while it is younger than `ORPHAN_MS` (90 s). `workers cancel <name>` (one argument; TUI: select the row, press `-` twice) removes it; it refuses while the directory is younger than `ORPHAN_MS` or holds anything but a half-published `worker.json.<tmp>`, and a complete worker is never cleared this way.
- Resumed worker whose pane died (plan R8.5): it is shown only while it has no episode. After its first `tell` it follows the normal rule: once its pane is gone and its episode is delivered, the row leaves with the pane.
- Polling cannot see some rewrites. The collector samples each result path at most once per tick (`POLL_MS` = 10 s, `workers.ts:124`). A pass reads at most `BATCH_MAX` = 20 workers within `COLLECT_BUDGET_MS` = 4 s, and the rest wait for the next tick. A read is stat, read, stat. A file whose mtime or size moved is read again next tick (`workers.ts:1281`). A snapshot's identity is the first 16 hex of sha256 of its bytes plus `floor(mtimeMs)` (`identity`, `workers.ts:1240`). So two rewrites are invisible: (1) a state that is overwritten before the next sample, which can be up to one tick plus the pass time, or longer when the batch defers the path; (2) a rewrite with the same bytes within the same mtime millisecond. On a filesystem with 1 s mtime resolution, that is the same second.
- `.github/workflows/release.yml` has not run on GitHub yet. The Codex install with id `tmux-agent` was verified once before the last manifest change and has not been re-run.
- `mock.clock` **確實**驅動 plugin 的 `$.clock.every`（本 mod 只用 `every`，
  沒有用到 `after`）：tick、面板的 2 秒
  mirror clock 都是用 `clock.advance()` 在單元測試裡
  驗過的（`tests/register.test.ts` 的 `delivery`、`panel`、`regressions`）。
  這段先前寫成「證不了」，是錯的。
- **UNCONFIRMED**（範圍已縮小，面板主體於 2026-09-17 實測，見上一節）：
  長期行為：連續數小時的 10 秒 tick、module hot reload 後 `session.start` 是否
  重新觸發。這幾項只有 mock harness 的證據——mock 不 fork 真的 process，也沒有
  終端機尺寸事件。切換選中列時鏡像目標跟著換，已由單元測試驗證
  （`honest states` › `switching the selected row …`：capture 目標序列為
  `['w1','w2']`，同時在飛的 capture 不超過 1）；真實終端機上的同一動作就是
  開 `/tmux` 按另一列，尚未另外量測。

  要量面板的 mirror subprocess，**唯一正確的訊號是 `--strip-ansi`**：

  ```sh
  ps -Ao command | grep -c '[c]apture --strip-ansi'
  ```

  mirror 實際 spawn 的是 `agent-tmux <profile> capture --strip-ansi --tail N
  <name>`，只有它帶這個旗標。不要用 `grep 'agent-tmux.*capture'`——每個 worker
  pane 的 shell argv 都內含橫幅字串 `capture: <self> <cli> capture <name> 120`，
  所以那個 pattern 在 pane 活著時永遠 match，量到的是 pane 數不是行程數
  （2026-09-17 實測：面板未開時該 pattern 回 7，正確指標回 0）。`[c]` 的自排除
  也不能省，否則 grep 自己會被 `ps` 掃到，多算一個。

  量之前先在面板未開時取一次 baseline，否則面板開啟後量到的數字分不出是面板
  造成的還是既有底噪。

  鏡像有高度下限：扣掉列表與鏡像自己的 chrome 之後不足 6 行，鏡像**整個關掉**，
  面板改印 `Pane too short to mirror — enlarge the window. (surface N rows;
  needs M)`。實測 `--tail 3` 抓回來 0 行實際內容（agy 自己的底部 chrome 就佔
  4 行），6 行才有 2 行、9 行 4 行、12 行 6 行。舊的下限 3 等於每 2 秒花一個
  子行程畫一個空盒子。

  高度**必須讀 `viewport.rows`，不能讀 `scroll.bodyRows`**。型別檔講得很直白：
  `bodyRows` 是「視窗看到樹的多少列」，而那棵樹正是這個 hook 畫的，所以它是
  循環訊號。鏡像關著時 `bodyRows` 等於列表自己的高度，用它判斷「放不放得下
  鏡像」會做出一個閂鎖：關著 → 樹很矮 → 判定放不下 → 繼續關著，**視窗拉多高
  都救不回來**。2026-09-17 實測到的就是這個：`body 5 rows` 對上一個正好 5 行
  的列表，人把終端機拉高，鏡像沒有回來。`viewport.rows` 是「整個介面的高度，
  不是這個元件剩下的空間」，不受我們畫什麼影響，才是能用的尺規。Pane 的 props
  沒有 `maxRows`，所以這是唯一的非循環選項；它是 optional，缺席時退回固定
  預設值而不是 0 —— 不知道高度不是砍掉功能的理由。

  **而且不能用瞬間值判定。** mirror 每 2 秒 spawn 一個 `capture-pane`，那個行程
  活不到 100 毫秒就結束——它是短命的，不是常駐的。用「某一瞬間數到 1」當判準，
  實測有約 98% 機率誤判成 FAIL（2026-09-17：面板開著且選中一列時，8 秒內 160 次
  取樣只命中 2 次）。正確判準是**窗口內的命中率加上最大並行數**：連續取樣數秒，
  看 `samples_with_capture > 0` 以及 `max_concurrent` 是否始終為 1。關閉後的
  negative 同理要用同樣長度的窗口，否則 0 沒有意義。
- `prompt.submit` 成功只代表引擎接受並排入，不代表模型已讀懂或採取行動。
- 跨 process 的 exactly-once 做不到：`prompt.submit` 與 ack 的 `mkdir` 不是
  同一筆 transaction。本 mod 的取捨是「可能重報，絕不漏報」。

## `/workers` 面板

`/workers` 開關面板。標題是 `workers v<MOD_VERSION> · @<本 session> · tmux N · 內部 M`（目前為 `workers v0.44.2`，列上的 `@<id>` 是別的 live session 持有的 worker，`@unknown` 是沒有 heartbeat 的孤兒，自己的不標）。別的 session 的 worker 預設收成一行 `◌ [ 展開 · 其他 session 運行中 N/共 T：@<id> n ]`（`n` 是該 session 的列數，含已完成的），按它（hotkey `a`）逐列展開，再按收回；收起時 `/workers tell|stop <name>` 照樣找得到；沒有別人就沒有這行：`tmux N` 是面板上還沒有終態 result 的 worker（`success`／`failed`／`blocked`／`needs-input` 不算，專案列也不算，0 也印）；`內部 M` 是這個 session `$.agent.list()` 裡 `status === 'running'` 的數量（teammate 也算），只在面板開著時跟 2 秒時鐘一起讀。`list` 失敗顯示 `內部 ?` 並 log 一次。面板畫在 **prompt 正上方的 band**（`AbovePrompt`），不是
`Pane`：不管終端機多寬、有沒有 `CLAUDE_CODE_NO_FLICKER=0`、在不在 tmux 裡，
位置都一樣。（0.4.x 用 `Pane`，≥110 欄會 dock 到右邊、inline 時按鈕完全按不了——
引擎只在 fullscreen 佈局回報滑鼠 click，`hotkey` 又只有 band 認；2026-09-17
兩台機器都撞到。）

每個 worker 一列：`1: 名字  repo  狀態  已跑多久`；總覽（沒選任何列）時底下一行是
brief 的 GOAL。標頭是青底的標題列，一眼就分得出面板和 session 自己的輸出。

### `[ clear ]`：一次停掉全部 (0.11.1)

面板上有 worker 時，標題列多一顆 `[ clear ]`（hotkey `c`）。它跟列上的 `[ stop ]` 一樣要按兩次：
第一次變成 `clear all? press again`，5 秒內再按一次才執行。它停掉的是這個專案裡這個 mod
派出、還有 tmux session 的每個 worker，等同 `mcp__tmux-agent__stop` 帶 `all: true`。
`shell` 列和專案列都不算，因為那些不是 mod 派的。沒有 worker 時這顆按鈕不畫。

### `[ ⧉ ]`：在旁邊開全螢幕 TUI（plan P7）

標題列的 `[ ⧉ ]`（hotkey `t`）把 Claude Code 所在的 tmux pane（`$TMUX_PANE`）切一半，
右邊跑 `lib/tui.node.ts --session <這個 session>`，焦點留在左邊。不走 launcher：在
Claude Code 裡 mod 自己就是 collector，launcher 會再起一個，同一份結果可能送兩次；TUI
只看不收；狀態列的「收件」讀的是 mod 自己寫的 `act/<n>.state`（見下）。

TUI 的按鍵（plan R4.6；畫出來的每個鍵都有 handler，contract 測試逐一檢查）：

- 標題列：`[ n resume ]`（按 session id 接回）、`[ + assign ]`（輸入
  `<profile> <name> <brief 檔>`，走 core 的 `assign`，與 MCP、mod 同一條路）、
  `[ r refresh ]`、`[ c clear ]`（按兩次）、`[ q quit ]`；`a` 切換全部／只看自己，
  `j`／`k`、方向鍵、`1`–`9` 選列。寬度不夠時先拿掉 `a all · j/k select`，再只留鍵。
- 選中的列：`[ t tell ]`（追話）、`[ i interrupt ]`、`[ x stop ]`（按兩次）、
  `[ - cancel ]`（按兩次；關掉這個 episode，pane 不動，與 `workers.cli.node.ts cancel`
  同一個 core 呼叫）、`[ U unlock ]`（按兩次；維護用，與 `unlock <name> confirm` 同一個
  core 呼叫，只在持有者確定已死時才移除鎖）。`Enter` 打開細節：row 狀態與 result 狀態
  分開列、完整 summary（不受 12000 字截斷）、blocked 原因、result 路徑；`PgUp`／`PgDn`
  捲動，`Enter` 或 `Esc` 收合。
- 版面（R4.1）：一個函式依高度、寬度、選中列與展開狀態分配各區塊的行數；鏡像抓的
  行數就是它算出的 viewport。縮放時重算，縮放前開始的 capture 結果直接丟掉。
- 空狀態三種：沒有 outstanding、被篩選掉（按 `a` 看全部）、讀取失敗（附 errno）。
- 不帶 `--session` 的 viewer 是唯讀：`x c i n t + - U` 都只顯示
  「唯讀；帶 --session 才能操作」，不動 ledger、ack、pane。

「收件」狀態（C-health）：每個收件通道（mod、node collector、MCP adapter）在
`heartbeat` 與投遞被拒三次而暫停時，以 temp＋rename 寫自己那個 activation 的
`act/<n>.state`（`{token, channel, mode, status, reason?, updatedAt}`，只在內容變了
才寫）。TUI 只讀最大的 n，配合 `sessionLiveness`：沒有 session 目錄或 activation →
`無收件者`；剛註冊、grace 內 → `initializing`；`paused` → 顯示原因（暫停後不再
beat，所以不當 stale）；beat 新鮮且 collecting → `collecting（mod|node）`，MCP 的
on-request 寫成「MCP：host 呼叫 tool 時才收」；collecting 時若 collector 帶著 `reason`（投遞被延後、或 register 殘留），接在後面顯示並改用黃色；beat 超過 90 秒 → `stale（beat Ns 前）`；
讀不到、JSON 不合法、token 對不上、或讀的時候最大 n 一直變 → `unknown（原因）`。
`act/<n>.state` 只給 TUI 看，不參與 fencing、claim 與 `sessionLiveness`。

一個 session 只有一個收件通道（plan §1c S3）：`<sessionDir>/channel` 是 `ln -sn`
建立一次的 `{channel, token}`，先註冊的通道贏。查 channel 與 `registerActivation`
在 `<sessionDir>/channel.lock`（action lock 規則：只有持有者釋放，不搶）裡一起做。
別的通道用同一個 session id 註冊時被拒，不建 activation，所以不會 fence 現有的
通道；它的 gate 停在 paused（`this session is collected by its <channel> channel …`）。
`channel.lock` 的持有者紀錄和 action lock 一樣帶 `pid`、`pidStart`、`host`（`processId`
探測，mod 與 node 同一條路）：被佔用時，log 與 gate 的 `waiting` 狀態說出持有者是「還在跑」、
「已經不在」或「無法證明」；只有「不是還在跑」才印 `rm '<path>'`，鎖從不被搶。
channel 讀不到、沒寫 channel 名、或 `channel.lock` 被佔用（狀態 unknown／initializing）→
任何通道都不註冊、不 fence，gate 的 `waiting` 寫原因（不是 paused），下一拍再試；不當成
「還沒有 channel」。launcher 看到 channel 是別的通道時不起 node collector，印一行
`no collector started: this session is collected by its <ch> channel …` 與換通道的指令，
TUI 照開；channel 讀不到則 busy，什麼都不起。

換通道只有一條路（要確認，同 `--migrate-launcher`）：
`tmux-agent-tui --handover-channel <session> <mod|node|mcp> [--yes]`。順序固定
`channel.lock` → `collector.owner`（launcher 持 `collector.owner` 時只讀 channel，不取
`channel.lock`，所以不會反向）。兩把鎖都拿到後，用一次
`ps -o pid=,ppid=,lstart=,args=` 快照證明舊通道的 registration caller 與它們的子 process
都不在：args 同時含 session id 與 `launcher.node.ts`／`collector.node.ts`；舊通道是 mcp 時，
任何 `mcp-server.mjs`／`tmux-agent-mcp` process 都算（它的 args 沒有 session id）。過期的
heartbeat 不算 quiescence，也不讀。mod 跑在 Claude Code process 裡，`ps` 對不上 session，
所以沒有 `--yes` 只印會做什麼；`--yes` 同時是你的確認：沒有舊通道的 caller 正在跑或會在
這之後啟動（快照之後起來的 process 沒有 fence 擋得住）。換完之後，晚到的舊通道 caller 在
`channel.lock` 內重讀 channel，被拒絕，不註冊、不 fence 新的 authority；新通道下一次註冊
的 activation 才 fence 舊的。通知的每個 worker 區塊帶一行
`delivery_id: <gen0 owner>/<name>/<seq>`：重報（at-least-once）時這一行不變，
認領之後也不變。

TUI 結束時（`q`、Ctrl-C（任何模式，輸入列開著也一樣）、SIGINT、SIGTERM、stdin 關閉或出錯、例外）都走同一條 cleanup，把 tty 還原成啟動時的狀態（原本就是 raw 的 tty 維持 raw），並關掉 bracketed paste；SIGKILL 攔不到，終端機會留在 raw／alt screen，用 `reset` 或 `stty sane` 救回。還原的某一步失敗時，其他步驟照做，每個錯誤在離開 alt screen 後印到 stderr，TUI 以 exit 1 結束（按 `q` 結束也一樣）。啟動時任何一步（raw mode、resume、alt screen）失敗，TUI 不啟動：已做的步驟還原，錯誤印出，exit 1。TUI 開著時 terminal 是 bracketed paste（DECSET 2004）：貼上的 `q`、`x` 是文字，不是按鍵。沒有結束標記（`ESC[201~`）的 paste 或沒結束的 escape sequence 不會卡住 TUI：1 秒沒有新輸入、CSI 參數超過 256 個字元、或 paste 超過 65536 個字元時，整段丟掉，狀態列顯示 `input — dropped an unfinished paste or escape sequence …`，丟掉的內容不會變成按鍵。paste 開著時按 Ctrl-C：丟掉這段 paste 並結束 TUI（按一次即可；所以內容含 0x03 的 paste 也會結束 TUI）。

TUI 的位置跟著 mod 已經在用的 `agent-tmux` 走（`PATH`、marketplace checkout、
`npx skills` 的 skill 資料夾；symlink 會 `realpath` 解開），不寫死路徑。找不到 `node`、
`lib/tui.node.ts` 或 `tmux-agent-tui` → `FAILED`。不在 tmux 裡時什麼都不切，也不自動開
終端機 app：結果是 `ok`，toast 寫「已提供開啟指令」，加上完整、可直接執行的一行
`'<絕對路徑>/tmux-agent-tui' --session '<id>' --cwd '<cwd>'`（每個參數都加單引號，
空白與單引號都安全；mod 有 `TMUX_AGENT_DIR` 時前面加 `TMUX_AGENT_DIR='<root>'`）。整段
超過 200 字時，完整指令寫進 log，toast 印「完整指令見 log」和前段。mod 的 tmux 呼叫
都用預設 socket，所以指令不帶 socket。

`tmux-agent-tui`（R2.1）就是這個入口：自己的目錄以 `${0:A:h}` 解開 symlink，所以
install-bin 的 link、`npx skills`、marketplace 都能用，路徑含空白、`%`、`#`、非 ASCII
也行。帶 `--session` 是 owner（能對該 session 的 worker 動作），不帶是 viewer（列出全部、
唯讀）。先在 shell 檢查 Node ≥ 22.18（與 `lib/tui.node.ts` 的 `NODE_FLOOR` 同一個值），
不是 TTY 時 exit 2；`--help` 不需要 TTY。`TMUX_AGENT_DIR`、`TMUX_AGENT_TMUX_SOCKET`
原樣傳下去。升級：install-bin 只連結執行當下存在的腳本，更新 skill 之後要重跑
`install-bin ~/.local/bin`；`agent-tmux <cli> doctor`／`setup` 會列出 `~/.local/bin` 少了
哪些 link（`bin_links`，只是提示，不算失敗）。

按鈕字樣：寬的終端機是 `[ + new ][ ↻ refresh ][ ⧉ tui ]`，放不下時只留符號；先讓出
的是按鈕的字，再來是 `workers v…` 名稱，計數永遠留著。符號都是 East Asian Width N，
CJK 終端機也只佔一格。`[ hide ]` 畫成 dim（次要動作）。

### `[ + ]`：按 session id 接回成隊友 (0.11.0)

標題列的 `[ + ]`（hotkey `n`）打開一行輸入框，填 `[profile] <session-id> [name]`，Enter
接回；空的 Enter 關掉。沒有 Input 的地方（手機）或 band 拿不到焦點的終端機，用
`/workers resume [profile] <session-id> [name]`，同一套字。

- **只給 id**：mod 用 id 去各 CLI 自己的 store 找，找到的就是 profile，連它原本的 cwd
  一起帶回——resume 要回到原本的目錄，不然 claude 和 cursor 找不到那段對話：
  - claude：`~/.claude/projects/<slug>/<id>.jsonl`，cwd 從 log 裡 grep（slug 會把 `.`
    和 `/` 都變成 `-`，反推不回來；log 可能超過 `fs.read` 的 4 MiB 上限，所以用 grep）
  - cursor：`~/.cursor/chats/<cwd 的 md5>/<id>/meta.json` 的 `cwd`
  - agy：`~/.gemini/antigravity-cli/conversations/<id>.db`。cwd 只在 protobuf blob
    裡；metadata cache 有記就用，沒記（cache 會停更）就用這個 session 的 cwd
  - codex：`~/.codex/sessions/<年>/<月>/<日>/rollout-…-<id>.jsonl` 第一行的 `cwd`
- **兩個 store 都有這個 id**：拒絕，請你加上 profile。**都沒有**：拒絕，請你給 profile
  （自訂 profile、grok 走這條，cwd 用這個 session 的）。**給了 profile**：以你給的為準，
  它的 store 有就用那裡的 cwd。
- **name**：沒給用 `<profile>-<id 前 8 碼>`，撞名就加尾碼；給了就原樣當 tmux 名
  （`--exact`），撞名拒絕——跟 `assign` 一樣，每個 worker 一個新目錄。

接回後寫 `worker.json`（跟 `assign` 同形），不開任何一輪，所以它是一般的 worker
列，`tell`／`peek`／`stop` 都找得到，不是唯讀的 `shell` 列；pane 死了會照常以 `exited`
回報。它沒有 brief，`result.json` 不會自己寫，所以**在你 `tell` 它第一件事之前，什麼都
不會叫醒你**，回覆裡會寫這句。

### 專案 session

這個 cwd 裡、不是 worker 的 detached tmux session（例如 fastlane 的 `hg-android`）列在 worker 後面：名字、`專案`、從 `session_created` 算的時間。每 10 秒對帳跑一次 `tmux list-sessions`，2 秒鏡像時鐘不跑。路徑等於 cwd 或在它底下才算；`/private/tmp`、`/private/var` 先對成 `/tmp`、`/var`，結尾的 `/` 拿掉，空路徑不算。worker 自己的 session 用跟 `hasSession` 一樣的 `-<name>` 規則排除。選中只鏡像那一個 pane（`tmux capture-pane -p -J -t <name>`）。`peek` 可以看，包在跟 worker 一樣的 `<worker-pane>` 裡；不是 worker、也不是目前專案列的名字直接拒絕。`tell`、`stop`、`keys` 回 `read-only project session`。

**任何終端機都能用的操作**（不靠字母鍵、不靠組合鍵）：

- prompt 空白時直接按 `1`–`9` 選那一列（鏡像它的畫面尾巴；再按一次取消）。
- `/workers N` 選第 N 列（第 10 列起、或被擠到 `+N more` 裡的列用這個）。
- `/workers stop <名字>`、`/workers tell <名字> <訊息>`、`/workers hide`。打出名字本身就是確認。
- `/workers probe on|off|show`：記錄這個 session 的 band 被哪些 surface 畫出來（desktop、手機實測用）。`on` 開一個新 epoch，寫 `loaded`、`attach`／`detach`、每個 surface 第一次的 `render`（面板關著也記）到 `<state root>/<session id>/surfaces.jsonl`；`show` 只印最新 epoch：整個 epoch 的計數（判定「沒有」要看這行）、遺失的觀測數，再加最後 20 行。預設關閉；新的 `on` 會把舊 epoch 移出檔案，單一 epoch 上限 1 MiB。讀不到的檔案、store 失敗、缺 session id 或 state root 都回 `probe: blocked — …`，不會當成空檔覆寫；寫入失敗計入遺失數，直到下一次 `on`，band 照常畫。reload（或新 process）接手一個不是自己開的 epoch（on 或 off）時，`show` 會加一行 `restored after a reload…`：reload 前存不下來的遺失不留痕跡，這個 epoch 不能證明「沒有」，`off` 也不會清掉，要重新 `on`。
  `stop`／`tell` 只收名字、不收列號：列號跟著每次 refresh 移動，打字到按 Enter 之間插進
  一列就會停錯人（0.7.6，cursor d20cdcc N-2）；打數字會回 `row N is "<名字>" right now`
  讓你照名字再打一次。訊息原樣送出，換行與縮排保留。`tell` 最壞要
  git 2 秒 + init 5 秒 + send 60 秒（`TELL_SEND_MS`；claude 的一次 send 實測 22.6 秒）。
  這些都是 `$.process.run`，進行中的 `$` 呼叫不算進 hook 的時間預算（plugin-authoring），
  所以不會被預算砍掉；send 超過 60 秒才會被停，這時訊息可能已送到，回傳會說 peek 後再決定要不要重送。

**聚焦後的字母鍵**：`ctrl+x tab` 把鍵盤交給 band 之後 `r` 重讀、`x` 停掉選中的
worker、`q` 隱藏面板；Esc 還給 prompt。字母鍵**只在 band 聚焦時**有效（引擎規則，
d.ts `ButtonProps.hotkey`），prompt 聚焦時按 `x` 只會打出一個 x。`ctrl+x tab` 這個
組合鍵要終端機原樣送進 pty：2026-09-25 在 Warp 裡按了沒反應（tmux 裡正常）。
自己的終端機可以這樣查：`cat -v` 後按 ctrl+x、Tab，印出 `^X^I` 就是有送到。

`[ interrupt ]`（hotkey `i`）只畫在 running／stalled 的列上：它打斷 worker 正在跑的那一輪，
按的是 CLI 自己在畫面上提示的鍵：`esc to interrupt|cancel` 就送 `Escape`（claude、codex、
agy），`ctrl+c to stop` 就送 `C-c`（cursor-agent）。畫面上沒有這種提示就代表它沒在跑，這時
什麼都不送，因為在閒置的 prompt 上按 C-c 有些 CLI 會直接退出。打斷後 CLI 停在 prompt，
不會寫 result.json：接著在輸入框打字送出就是 steer（`tell` 本身只是貼上並按 Enter，
忙碌時會排隊還是插隊由 CLI 決定）。兩分鐘後出現的「stopped by their CLI」通知是預期行為。

`[ stop ]` 要按兩次：第一次變成 `[ stop <名字>? press again ]` 並倒數 5 秒，時間內
再按一次才真的停（兩次間隔不到 0.4 秒算按住鍵的重複，不算確認；選中的 worker 離開清單時
選取自動取消）（停掉會結束 tmux session，不能復原；2026-09-25 實測 band 聚焦在
`[ refresh ]` 上時一個誤按的 `x` 就停掉了 worker）。`[ hide ]` 放在標頭最右邊、
離 `[ refresh ]` 遠一點；隱藏可以用 `/workers` 復原。滑鼠點也行（終端機有回報 click
時），但不要依賴它。

標頭有 `[ refresh ]`：面板每 2 秒自動重讀，但 `tmux ls` 慢或被拒時會沿用上一次
結果，覺得畫面不對就按它。按它也會收起已展開的列、回到總覽（和再按一次那一列一樣），並取消還在等第二下的確認。選中的那一列底下多出兩個控制：一行輸入框（打字、Enter 就是 `tell`——同一個
函式，不是另一條路）和一個 `stop` 按鈕。結果用 toast 回報成功或失敗。已收工
的列選中時不鏡像 pane，改印它自己的 `status: summary`——收工的隊友你要看的是
它說了什麼，不是它的終端機尾巴。

band 是所有 plugin 共用的一塊：面板關著時這個 hook 原樣放行別人畫的東西，開著
時把自己的列疊在別人的下面；survey（`hasSurvey`）佔用 band 時讓位。整棵樹刻意
控制在 band 的 `maxRows` 內——超過會捲動，而捲動中的 band「bare digit 不觸發任何
hotkey」（d.ts `AbovePrompt.maxRows`），數字鍵就廢了。每一行都算進預算：選中列的
摘要只佔一行（全文在 result.json；以前 `wrap` 最多換成 6 行卻只算 1 行，選到一個已收工的
隊友數字鍵就失靈）；總覽放不下的列收進 `+N more — /workers N selects row N`；選中時
列表先讓位給鏡像的 6 行下限（13 行的 band、兩個 worker 以前印 `needs 15`，八個印
`needs 18`，鏡像永遠出不來）。鏡像行數是 `maxRows` 減掉這些之後剩下的，不是固定值。
band 連「一列加它的控制」都放不下時只畫標題列和一行指令提示（`/workers N · /workers stop <name> …`），
不溢位。

三件事是刻意的：

- **面板畫的是「還有 pane 的隊友」，不只是「未回報」的。** `panelRows()` 吃
  `scan()` 全集：未回報的照舊（running／stalled／finished／exited／launch-failed／
  needs-input；`launch.exit` 讀不到時標 `unknown`，不猜 running 或 exited），已投遞記帳的則標 `done — tell it more, or stop it`，只要它的 tmux
  session 還活著就留在面板上（每個 tick 跑一次 `tmux ls -F '#S'`，用 `-<name>` 尾綴
  比對；session 名稱前綴是 profile 自己的，mod 不猜）。收工的隊友選中後印
  `success: <summary>`，同一列仍有輸入列與 `[stop]`。**列消失的條件是 pane 沒了**
  （你按了 stop，或它自己退出），不是「已投遞」。2026-09-17 實測：舊行為下
  assign→tell→投遞完，使用者開 `/workers` 只看到 `No workers outstanding.`，隊友明明還開著。
- **只認自己 session 的隊友；別人的只在它死了之後接手。** assign 把 `$.session.id()`
  寫進第 1 輪 dispatch.json 的 `owner`、session cwd 寫進 worker.json 的 `ownerCwd`。每次對帳 collector 都
  更新自己 activation 的 `.beat` 當心跳；另一個 session 的 worker，只有在它的
  心跳超過 90 秒沒動、而且 `ownerCwd` 等於本 session cwd 時才接手（結果總得有人收）。
  同一個 repo 開多個 session 各做各的事，彼此的隊友互不干擾；session 關了，同 repo 的
  下一個 session 會把它留下的結果收回來。沒有 `owner` 的舊紀錄任何人都可接手。
  2026-09-17 實測（cwd 版）：8 個別人的 `*-stress-*` session 同時在線，本 session
  的 collector 一個都沒收。
- **pane 死了、沒寫 result 的 worker 會自己走。** status 探測回 `exists:false`
  的下一個 tick，collector 以 `exited` 交付一次（summary 說明沒有 result.json）並記帳，
  列跟著消失；`exists:true, running:false` 是 idle，不算死。舊行為要人按 stop 才會清。
- **卡在對話框的 worker 標 `needs input`。** status 的 `blocked_reason`（trust／
  permission／approval／login／ssh）一出現，該列立刻改標、toast 一次；Claude 用
  `peek` 看畫面、`keys` 按白名單鍵回答。不會等 15 分鐘才被當 stalled。
- **只鏡像選中的那一格。** 五個 worker 全鏡像等於每秒 2.5 個子行程，而且
  沒人在看。沒選任何一列就完全不抓。
- **鏡像用 `--strip-ansi`，不上色。** 引擎的 `Text.color` 接受哪些寫法沒有
  文件，把 256 色／truecolor escape 硬對上去是用猜的當功能賣。要看真的畫面
  就 `tmux attach`。

`$.tmux.reconcile()` 這個 noun 會順帶跑一輪停滯探測，也就是**會起子行程**；
呼叫它的 plugin 要知道這件事。session 啟動時的那次對帳刻意**不**探測停滯 ——
`session.start` 吃引擎的 hook 預算，掃一排子行程正是會超時的那種事，而 15 分鐘
等級的狀況晚一個 tick 完全來得及。整輪探測另有 4 秒上限、單次 3 秒。

面板關著時鏡像時鐘不存在（`/workers` 再按一次、`/workers hide` 或 `[ hide ]`／`q` 都走同一個
`closePanel`，它 cancel 時鐘並換代），但**對帳時鐘照跑** —— 叫醒沒人在看的
session 正是這個 mod 的目的。

### 停滯偵測

活著不等於在做事。已觀察到 `dead=0` 的 session 卡在「⚠ Individual quota
reached」七天：沒有終態、沒有 exit，等 result 會等到天荒地老。

閒置超過 15 分鐘且 pane 仍 running 的 worker 只是「安靜」，不等於卡住：面板顯示
`running · idle Nm`，log 播報一次「pane unchanged for N min; not confirmed stuck」
並附上 pane 最後 3 行（≤300 字元）當證據，**不叫醒**。

`stalled` 只由 wrapper 判：`agent-tmux status --json` 的 `blocked_reason` 是
`quota_exhausted` 或 `login_required`（CLI 自己說停了：用量窗口、憑證失效），證據是
同一份輸出的 `blocked_evidence`（命中的那一行）。wrapper 只認 CLI 自己的錯誤區塊：
pane 最後 10 個非空行裡，從**第 0 欄**開始就是錯誤形狀的那一行（`■` 橫幅、
`⚠ Individual quota reached`、`Error:`／`API Error:`，要有冒號、`You've hit your …`），或 claude
在 `⎿` 後**緊接著**寫的錯誤（`API Error:…`、`You've hit your session/weekly limit · resets …`、
`Credit balance is too low`），而且
它之後沒有新的輸出行（`•`、`⏺`、`⎿`、`└`、`✔`、「Worked for」）——worker 自己引述的
「invalid api key」、以「Error handling…」「API Error handling…」開頭的敘述、工具輸出（在 `⎿`／`└` 之下或縮排
在它們底下）、恢復後才剛被推上去的舊橫幅都不算；
CLI 放棄的 rate limit（`Error: rate limit exceeded`）算 `quota_exhausted`。字表收的是從
本機 transcript 與各 CLI binary 找到的真實字串：claude 的 session／weekly limit 與
credit balance、codex 的「access token could not be refreshed」（`login_required`）、agy
的「exhausted your quota」、grok 的「hit your free usage limit」。`⚠` 開頭的行只有
quota 字樣才算：`⚠ MCP client … authentication required` 是警告，不是停工。mod 自己不留字表
—— 0.7.3／0.7.4 在 mod 裡複製的半份字表會把 worker 自己寫的「Implemented rate limit
handling」當成阻擋（astra 審查 F5）。pane 靜止滿 2 分鐘才算數（剛恢復時畫面上還留著
舊橫幅，不該叫人），然後**叫醒 session 一次**，措辭是「看起來被 CLI 停住，等結果前先
peek」——證據只是一行畫面文字，worker 自己在第 0 欄引述的 `Error:` 也長這樣：session 接受了才算說過（被拒就下一個
tick 再試，連續拒 3 次就放棄並寫 log）；閒置時間中途歸零又回來不重說；記在記憶體，
所以 hot reload 或別的 collector 認領後可能再說一次。這個 worker 不會自己交出結果，owner 空等才是這個 mod 要消除的沉默
（2026-09-24：兩個 codex worker 停在 usage limit 一個小時，lead 不知道）。不殺。
對話框（trust、permission、login prompt）是 `needs-input`，同時清掉這個 episode 的
stalled 紀錄，面板、log、`$.tmux.stalled()` 三者一致。閒置時鐘讀的是
`agent-tmux status --json` 已經在維護的 `idle_seconds`，不另外算一份。

第五種狀態 `launch-failed` 來自 `launch.exit`（與 `collect` 讀同一份收據）：
`agent-tmux assign` 自己以非零碼結束。這是**暫定**判斷：assign 看的是 pane，而 CLI
可能收下了 brief 卻沒顯示在 pane 上（2026-09-24：claude-fable-gate 開進 session
picker，brief 變成背景 session，結果照樣寫出來）。所以 launch-failed 通知另記一個
ack（`episodes/<seq>/acks/launch/`），episode 不關；同一 episode 之後寫出的 terminal result
一律優先於收據，照常交付一次。以前這種結果會被永遠丟掉。通知之後這個 worker 照一般
worker 看：pane 已經不在就以 `exited` 通知一次、離開面板與 `outstanding()`（不存在的
profile 名稱不會永遠掛在面板上），pane 還活著就照樣探測，停在 quota 或對話框時一樣會被發現。

面板最上面一行說 collector 現在會不會投遞：連續三次投遞被拒而
暫停、或這個 activation 被同 session 較新的一個（reload）取代，都會印出原因；沒有這一行就表示
collector 活著。同一個判斷也寫進 `assign` 工具的回傳最後一句
（`collector: active …` 或 `collector: NONE — …` 加上 `peek` 後讀 `result.json` 的路徑），
`skills/using-tmux-agent-tools/SKILL.md` 的 COLLECTOR 一節就是拿這一句當分支條件。

node collector 貼進 host pane 之前先探測 composer（plan D-paste、§1c S5）：
`agent-tmux <cli> composer-state <name>|--pane %N` 依 pane capture 的 pattern 回
`empty | draft | busy | permission | shell | unknown`（第一行；有 composer 時其餘行是它的文字）。
cli 為 codex、cursor（cursor-agent）、claude、agy；其他 CLI 一律 `unknown`。
collector 的 `--cli` 沒給時，從 pane 底下的 process 找出是哪個 CLI。
只有 `empty` 才貼；貼完、送 Enter 之前再探測一次，composer 必須等於剛貼的文字（忽略空白差異，
或是 CLI 自己的 `[Pasted text #1 +9 lines]` 佔位），否則不送 Enter、文字留在 composer、回報 blocked。
其他狀態一律不貼、不送 Enter，結果是 deferred：不算拒收（不計入三次暫停）、不 ack，下一輪再試；
原因（例如 `host composer is draft … nothing pasted, retrying`）留在 `gate.deferred`，條件不解除就一直顯示。
保證只有這三條，不保證任意時刻插入的打字不會干擾（probe 到 Enter 之間沒有鎖）。
已知限制：placeholder 文字是逐字比對，沒列出的 placeholder 會被當成 `draft`（不貼，安全方向）；
cursor-agent 的 permission 對話框沒有實機 capture，認不得時是 `unknown`（同樣不貼）。

同一輪探測還負責第四種狀態 `exited`：status 回 `exists:false`（session 沒了），但磁碟上沒有終態
result；下一個 tick 會以 `exited` 通知一次，記在自己的 ack（`acks/exited/`，跟
`#launch` 一樣只關通知、不關 episode）：列離開面板，但之後如果還有遲到的 result（背景
寫入者、延遲 flush）照樣交付一次。光看磁碟，這種 worker 跟「還在想」長得一模一樣，所以面板以前一路畫成
`running` —— 那是在叫人去等一個永遠不會來的結果。狀態探測是這個 mod 裡唯一會
問 pane 死活的東西，所以答案記在那裡。與 `stalled` 同樣是 best-effort：探測
每輪最多探 8 個，最久沒探過的先探（沒探過的最先），預算（4 秒）用完就停——被跳過的正好
排在下一輪最前面。順序跟著 worker 本身，不是它在這一輪清單裡的位置：collect 每輪交過來的
子集合不一樣，用位置輪替時八個裡有四個永遠探不到（astra，34e2a1e）。沒被探到的 worker
下一輪才會改狀態。
