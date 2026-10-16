# Big Brother Is Watching You

Discord 專案管理 Bot。成員在 Discord 討論與更新任務，Trello 保存正式任務資料；PostgreSQL 保存同步佇列、去重、提醒與會議記錄。正式執行不依賴本機磁碟。

## 功能

- 指定論壇的新貼文經 Make 同步成 Trello 卡片；後續留言不會重複建卡。
- `/任務`：查看任務、設定 Owner／Assignee、描述、開始／截止日期，以及更新狀態。
- 截止前 24 小時、1 小時及逾期各提醒一次，發在任務原討論串。
- `/會議設定`：從選單選日期及開始／結束時間，填地點，預覽後確認。
- 會議前一天台灣時間 17:00 提及指定角色，提醒開會與準備簡報。
- `/會議記錄設定`、`/查看會議記錄`：只從已登錄會議日期中選擇，保存及查詢 HTTPS 文件連結。
- 重連後補抓啟用之後漏掉的論壇文章，持久化去重。

一般文字頻道的 `/建立任務` 尚未完成，因此不註冊、不列為可用功能。AI 分析、對外公告與自動決策也未實作。Bot 不會自行指定人員、改期限或決定執行提案。

## 本機開發

需要 Node.js 24.21 以上的 24.x、npm，以及開發用 PostgreSQL。請為開發與正式環境使用不同的 Bot、看板、Webhook 與資料庫。

```sh
npm ci
```

複製 `.env.example` 成本機 `.env` 並填入設定。不要提交填好的設定檔。開發指令可明確載入該檔：

```sh
node --env-file=.env src/state/migrate.js
node --env-file=.env src/check.js
node --env-file=.env src/tasks/register.js
npm run dev
```

正式執行由外部環境注入設定：

```sh
npm run migrate
npm run check
npm run tasks:register
npm start
```

`migrate` 是一次性的 schema 初始化／更新，與 Bot 執行分開。請由負責發布的人在啟動前執行；程式不會自動建立資料庫服務或開通付費資源。

## 設定

所有部署值透過環境變數提供，範例檔沒有實際帳號或 ID。

| 環境變數 | 用途 |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot Token，機密 |
| `DISCORD_GUILD_ID` | 允許的伺服器 |
| `DISCORD_FORUM_CHANNEL_ID` | 提案論壇 |
| `MAKE_WEBHOOK_URL` | Make Webhook，機密 |
| `MAKE_WEBHOOK_API_KEY` | 選用的 Webhook 驗證金鑰 |
| `DATABASE_URL` | 外部 PostgreSQL 連線字串，機密、必填 |
| `DISCORD_NOTIFY` | 是否回覆提案同步成功，預設 true |
| `TASK_CONTROLS_ENABLED` | 開啟 `/任務` 的處理，預設 false |
| `TASK_MANAGEMENT_MODE` | `forum`：可查看論壇的成員；`roles`：限定角色 |
| `TASK_MANAGER_ROLE_IDS` | `roles` 模式的角色 ID，逗號分隔 |
| `TRELLO_BOARD_ID` | 任務與 PM 使用的看板 |
| `TRELLO_API_KEY` | Trello API Key，機密 |
| `TRELLO_WRITE_TOKEN` | 任務更新用 read/write Token，機密 |
| `TRELLO_READ_TOKEN` | PM 讀取用 Token，機密 |
| `MEETING_CHANNEL_ID`、`MEETING_ROLE_ID` | 會議通知頻道及提及角色，兩者都提供才開啟 |
| `PM_TRELLO_AUTOMATION_MEMBER_IDS` | 排除的自動化成員 ID，逗號分隔 |
| `PORT`、`HOST` | 選用的健康檢查 listener；HOST 預設 0.0.0.0 |

`TASK_ALLOWED_CHANNEL_IDS` 僅供匯入既有、已綁定的文字頻道任務使用，預設留空；它不會讓一般聊天自動成為任務。TLS 使用 node-postgres 支援的 PostgreSQL 設定，如 `PGSSLMODE=verify-full` 及 `PGSSLROOTCERT`，由管理員提供 CA，請勿關閉憑證驗證。

## Discord 設定

1. 管理員在 Developer Portal 建立 Bot，將 Token 放進外部環境；不要貼到聊天或 Git。
2. 開啟 Message Content Intent。論壇首則訊息需要完整內容；程式請求 Guilds 與 MessageContent intents。
3. 以 `bot`、`applications.commands` scopes 邀請。只授權指定頻道；不要求 Administrator。
4. 提案論壇需要 View Channel、Read Message History；回覆還需 Send Messages in Threads。
5. 會議頻道需要 View Channel、Send Messages。角色可被提及，或僅在該頻道讓 Bot 有提及角色的權限；程式只允許指定角色，不會發 @everyone。
6. 執行 `tasks:register` 註冊已啟用的指令。它逐一更新本專案的指令，不會整批覆蓋其他指令；功能停用後再執行會移除本專案對應的舊指令。

私人頻道維持原權限。Trello 看板成員仍可讀取同步內容，應由團隊自行確認可見範圍。文件連結的分享權限由文件擁有者管理，Bot 不會讀取或更改文件。

## Make → Trello

見 [Webhook 契約與去重](docs/webhook.md)。單純收到 Make 的 200／Accepted 不代表 Trello 成功。Bot 只有收到符合 Thread ID 的成功確認及卡片資料後，才會回覆成功。

## 程序與交接

詳見 [執行契約與 12-factor](docs/runtime.md)。本 repo 提供 GitHub Actions CI（測試與 image build）及 Dockerfile；`main` 與 `v*` tag 會推送 `linux/amd64` image 到 `ghcr.io/team6083/big-brother-is-watching-you`。不包含 Compose、k8s manifest 或伺服器設定。PM 使用同一個 image，覆寫 command 為 `node src/pm/cli.js --mode alerts --send --watch`。

- Bot：`node src/index.js`。
- PM：`node src/pm/cli.js --mode alerts --send --watch`，獨立程序；直接使用 Trello 與 Discord，不走 Make。
- 同一 Bot／伺服器只跑一個 Gateway 程序；PostgreSQL advisory lock 阻止重複啟動。PM 也有自己的程序鎖。
- 狀態保存在 PostgreSQL；不要掛載 SQLite 當正式執行狀態。
- 選用 `PORT` 後提供 `/healthz`、`/readyz`；未設定 PORT 不開 HTTP。
- SIGTERM／SIGINT 停止接新工作，等待進行中工作；最多 25 秒後退出。外部管理工具的停止寬限需大於此值。
- 所有維運輸出寫 stdout／stderr，不常駐開終端或寫本機日誌。

### 從舊 SQLite 切換

**直接使用空資料庫會失去既有去重、會議及提醒狀態。** 由管理員先停止舊 Bot 與 PM，保存 SQLite 一致性備份，經私人管道交給伺服器負責人。不要把 `.sqlite`、`.env` 或資料匯出放進 repo。

新資料庫先執行 schema 初始化，再使用相同程式版本一次性匯入：

```sh
node src/state/import-sqlite.js --source /private/path/state.sqlite
```

此指令需要外部注入 `DATABASE_URL`，只讀取來源、交易式寫入已知表；既有主鍵不覆蓋，可重跑。會記錄各表匯入數量，不輸出資料內容。匯入完成後執行 `check`，核對數量及狀態，再啟動新程序。舊程序維持停止，避免兩邊發提醒。保留備份與回退方式至人工驗收完成。

### 一次性維護

```sh
npm run admin -- status
npm run admin -- retry THREAD_ID
npm run admin -- notify THREAD_ID
npm run admin -- enqueue THREAD_ID
```

`enqueue` 仍只會從允許的論壇抓取資料。未確認的任務更新使用 Discord「核對未確認更新」，不要反覆提交。會議提醒的發送結果若不明，標記 uncertain 並停止自動重送，先檢查頻道。

## 測試與限制

```sh
npm test
```

測試只用合成資料：SQLite 回歸測試、PGlite PostgreSQL 引擎的 SQL／狀態整合測試，以及本機 HTTP 模擬。不需要任何真實 Token。SQLite 只保留在舊資料匯入與測試用途；開發和正式 runtime 都使用 PostgreSQL。

公開前另執行 `npm run audit:public`，檢查 Git index 中的檔案，拒絕常見機密、私人路徑、資料匯出及 runtime 寫死的部署 ID。此檢查不能取代人工審查；提交前仍需確認範圍與內容。

實際 PostgreSQL TCP/TLS、Discord Gateway、Make Scenario、Trello 權限，以及伺服器上的 SIGTERM／健康檢查仍需團隊人工驗收。本機測試通過不代表已部署；檢查清單見執行契約。
