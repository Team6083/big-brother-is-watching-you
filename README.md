# Big Brother Is Watching You

Discord 專案管理 Bot。成員在 Discord 討論及更新任務，Trello 保存正式任務資料，MongoDB replica set 保存同步、去重、提醒與會議狀態。

**只需一個常駐程序：`npm start`。** Discord 指令、論壇提案、會議提醒，以及 PM 定時追蹤在同一程序內運作，共用一組 MongoDB 連線；啟用 `PM_ENABLED=true` 就會排程 PM，不需另外啟動 PM worker。

## 功能

- 指定論壇新貼文經 Make 同步至 Trello；一般聊天與後續留言不會另建卡片。
- `/任務`：查看任務、Owner／Assignee、描述、開始／截止日期，以及更新狀態。
- 截止前 24 小時、1 小時及逾期各提醒一次，發在任務原討論串。
- `/會議設定`：選日期及開始／結束時間、填地點、預覽後確認；會議前一天台灣時間 17:00 提及指定角色。
- `/會議記錄設定`、`/查看會議記錄`：從已登錄會議日期選擇，保存／查詢 HTTPS 連結。
- 重連後補抓啟用之後漏掉的論壇文章，保留持久化去重。

一般文字頻道 `/建立任務` 尚未完成，不註冊為可用功能。AI 分析、自動決策與對外公告尚未實作。

## 開發與執行

需要 Node.js 24.21 以上的 24.x，以及 MongoDB replica set。測試版本預設 8.0.17；團隊伺服器版本需另行確認，再用 `MONGOMS_VERSION` 對齊測試。開發與正式環境使用不同 Bot Token、看板、Webhook 與 database。

```sh
npm ci
```

複製 `.env.example` 成 `.env`，只在本機或私密環境填值，不要提交或貼到聊天：

```sh
node --env-file=.env src/state/migrate.js
node --env-file=.env src/check.js
node --env-file=.env src/tasks/register.js
npm run dev
```

正式環境由外部注入設定：

```sh
npm run migrate
npm run check
npm run tasks:register
npm start
```

`migrate` 僅建立必要 collection 與索引，不搬移資料、不刪除資料。runtime 不自動建索引。團隊提供該 database 的內建 `readWrite` role，可供初始化與日常讀寫使用，不需要 admin 或 dbAdmin。

## 設定

| 變數 | 用途 |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot Token，機密 |
| `DISCORD_GUILD_ID`、`DISCORD_FORUM_CHANNEL_ID` | 指定伺服器與提案論壇 |
| `MAKE_WEBHOOK_URL`、`MAKE_WEBHOOK_API_KEY` | 私密 Webhook 及選用驗證金鑰 |
| `MONGODB_URI` | MongoDB 連線字串，機密；路徑必須包含專用 database 名稱，取代舊 `DATABASE_URL` |
| `DISCORD_NOTIFY` | 提案成功回覆，預設 true |
| `TASK_CONTROLS_ENABLED` | 啟用 `/任務`，預設 false |
| `TASK_MANAGEMENT_MODE` | `forum`：可查看論壇成員；`roles`：限定角色 |
| `TASK_MANAGER_ROLE_IDS` | `roles` 模式允許的角色，逗號分隔 |
| `TRELLO_BOARD_ID`、`TRELLO_API_KEY` | 看板與 API Key |
| `TRELLO_WRITE_TOKEN` | 任務更新用 read/write Token，機密 |
| `TRELLO_READ_TOKEN` | PM 查詢用 Token，機密 |
| `PM_ENABLED` | 在主 Bot 啟用 PM 定時提醒，預設 false |
| `PM_INTERVAL_MS` | 掃描間隔，預設 60000；允許 60000～86400000 |
| `PM_TRELLO_AUTOMATION_MEMBER_IDS` | 排除的自動化成員，逗號分隔 |
| `MEETING_CHANNEL_ID`、`MEETING_ROLE_ID` | 會議頻道及提及角色，兩者都提供才啟用 |
| `PORT`、`HOST` | 選用健康檢查；HOST 預設 0.0.0.0 |

URI 可指定 replica set、認證來源與 TLS；使用團隊提供的 CA，勿關閉憑證驗證。資料庫名稱放在 URI 路徑，例如 `mongodb://localhost/botdb?replicaSet=rs0&authSource=admin`（僅為格式示例）。名稱限 1–63 個英數字、底線或連字號；省略名稱或使用 `test` 都會拒絕啟動，避免誤寫 driver 的預設資料庫。`authSource` 是獨立的認證來源，請依帳號設定；runtime 使用 URI 指定的 database。`TASK_ALLOWED_CHANNEL_IDS` 僅供已綁定文字討論串任務的相容用途，預設留空，不會將一般聊天轉成任務。

## Discord 與 Make

1. 管理員建立 Bot，開啟 Message Content Intent，以 `bot`、`applications.commands` scopes 邀請。
2. 只授權指定論壇／頻道，不要求 Administrator。論壇需要 View Channel、Read Message History，回覆需 Send Messages in Threads。
3. 會議頻道需要 View Channel、Send Messages，以及提及指定角色的權限。程式不允許 @everyone。
4. `tasks:register` 只逐一更新本專案已啟用的指令；停用功能後重跑會移除對應舊指令。
5. 依 [Webhook 契約與去重](docs/webhook.md) 設定 Make。收到 Accepted 不代表 Trello 成功。

私人 Discord 頻道維持原權限；Trello 看板成員仍可讀取同步內容，請確認可見範圍。Bot 不讀取會議文件，也不更改其分享權限。

## 程序與維運

完整條件見 [執行契約與 12-factor](docs/runtime.md)。

- 常駐程序只有 `node src/index.js`。PM 每分鐘以非同步工作掃描，不阻塞 Gateway，也不重複啟動 Bot。
- **不再提供資料庫程序鎖**。部署負責人須確保單副本、Recreate，且本機舊 Bot／PM 已停止。節點失聯仍可能短暫雙開，團隊已接受這項限制。
- 所有正式狀態都存 MongoDB；不需要 runtime 持久磁碟。SIGTERM／SIGINT 排空工作，25 秒上限。
- 指定 PORT 時提供 `/healthz`、`/readyz`；日誌寫 stdout／stderr，只用受控事件與錯誤碼。
- Make 回應不明時保留等待確認；會議及 PM 提醒結果不明時不自動重送。
- 本次不修改學長管理的 Dockerfile 或 CI/CD。原 Dockerfile 註解中的獨立 PM 指令已不適用；不應另外啟動第二個 PM 程序。

### 一次性管理指令

```sh
npm run admin -- status
npm run admin -- retry THREAD_ID
npm run admin -- notify THREAD_ID
npm run admin -- enqueue THREAD_ID
npm run pm -- --mode daily
npm run pm -- --mode weekly
```

`pm` 現在只供一次性預覽，不發訊息，不支援 `--send` 或 `--watch`。定時通知一律由主 Bot 的 `PM_ENABLED` 控制。

### 舊資料與切換

舊電腦上的 SQLite、Bot 與自動啟動設定不會被此分支修改。PostgreSQL 專用匯入工具已移除；本階段不提供 SQLite→MongoDB 匯入，也不自動捨棄原資料。若需要保留舊同步、提醒與會議狀態，應在正式切換前另行確認搬移方式。

使用空的 MongoDB 不會繼承舊去重／提醒歷史；補抓只從新環境啟用後開始，既有 Trello 任務可能再次收到當前階段的到期提醒。此分支不會替團隊執行正式切換。

## 測試

```sh
npm test
npm run audit:public
```

保留 SQLite 回歸測試，另以 `mongodb-memory-server` 的臨時 **replica set** 測試真正的 MongoDB 原子更新、transactions、唯一索引與去重。套件只屬 devDependency；首次測試會下載 mongod binary，暫存資料在測試後清理，不安裝 Windows 服務或開機啟動。

CI 維護者可快取 `MONGOMS_DOWNLOAD_DIR`，並將 `MONGOMS_VERSION` 設成團隊版本；本次不改 workflow。production image 只安裝 production dependencies，不需要測試伺服器。

團隊實際 MongoDB 的 TCP/TLS、權限、Discord、Make、Trello 與伺服器上的關閉流程仍需人工端對端驗收。
