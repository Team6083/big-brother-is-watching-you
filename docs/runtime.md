# 執行契約與 12-factor

依據 [The Twelve-Factor App](https://12factor.net/) 整理。此文件描述應用程式需要的執行條件，部署、容器與 CI/CD 由團隊另外管理。

| 原則 | 此版本的做法 |
|---|---|
| I. Codebase | 單一 repo，開發與正式環境共用程式、用不同設定 |
| II. Dependencies | package.json 宣告並鎖定版本，npm ci 安裝，不依賴全域 npm 套件 |
| III. Config | Token、Webhook、伺服器／頻道／角色／看板、資料庫均由 env 提供；範例留空 |
| IV. Backing services | PostgreSQL、Discord、Make、Trello 是外部資源，可替換憑證與連線設定 |
| V. Build/release/run | 安裝相依套件、注入 release 設定、執行程序分開；migrate 是一次性程序 |
| VI. Processes | runtime 不保存本機持久狀態；佇列、去重、任務更新、會議、記錄與提醒狀態都在 PostgreSQL |
| VII. Port binding | 指定 PORT 時開啟健康檢查 listener；Gateway 本身是對外連線，不需要對外 webhook port |
| VIII. Concurrency | Bot 與 PM 各自為程序；資料庫租約／唯一鍵防重，程序鎖避免同一身分雙開 |
| IX. Disposability | SIGTERM/SIGINT 排空工作、停止新事件，25 秒上限；重啟由持久狀態恢復 |
| X. Dev/prod parity | 開發與正式使用同一 Node 主版本、lockfile 和 PostgreSQL；測試另含 PGlite 與舊 SQLite 回歸 |
| XI. Logs | 受控事件／錯誤碼寫 stdout/stderr，不寫常駐日誌；不輸出原始例外、憑證或內容 |
| XII. Admin processes | migrate、check、register、SQLite 匯入與 admin CLI 是使用相同程式的 one-off process |

## 必要資源

- Node.js 24.21 以上的 24.x；請依 package-lock.json 安裝。
- 外部 PostgreSQL，帳號與 schema 由管理員建立，`DATABASE_URL` 經私密設定注入。
- 一次性 migration 帳號可建表；日常執行帳號只需這些表的讀寫權限。程式啟動不自行執行 DDL。
- PostgreSQL pool 上限為每程序 4 條連線；程序鎖會占其中 1 條。
- 出站 HTTPS/WSS：Discord Gateway/API、Make Webhook、Trello API；出站 PostgreSQL 至指定資料庫。Proxy／CA 設定由執行環境管理。
- 不需要 runtime 可寫的專案目錄或持久磁碟。未儲存的 Discord 表單暫存在記憶體，15 分鐘到期、重啟後重開；它們不是正式狀態。

## 程序鎖與擴展限制

同一個 Bot 連到同一個 guild，僅允許一個 Gateway 程序。鎖保存在 PostgreSQL session，程序失聯／關閉後釋放；失去該連線時 Bot 結束，避免繼續以失效鎖執行。PM 使用獨立鎖。資料庫連線不要經會破壞 session lock 的 transaction pooling；需要支援 session 的直連或 session pooling。

此版本沒有實作 Discord sharding 或多副本 Gateway，也不應用增加 replicas 的方式擴展同一身分。擴展不同 Bot／guild 使用獨立設定與資料庫；PM 和 Gateway 可分開配置資源。狀態已外部化，但不代表所有角色可以任意水平擴展。

## 健康檢查與關閉

- `/healthz`：程序仍接受運作時回 200，停止中回 503。
- `/readyz`：Discord 已 ready 且未停止時回 200；啟動中／斷線／停止中回 503。
- 健康回覆只有固定狀態，不包含設定或憑證。此埠不是管理 API。
- Bot 停止新事件及排程，等待同步、回覆與補抓完成；超過 25 秒強制結束。未完成工作由持久化租約或 uncertain 狀態保護。
- Make 請求可能遇到「Trello 成功但回應遺失」，接收端去重仍是必要條件。
- 發送會議通知前保存 sending；發送結果不明不重送。重啟時該頻道的 sending 改成 uncertain。

## 公開內容界線

不提交 `.env`、Token、Webhook 真實網址、帳號、私人頻道／角色 ID、看板與卡片實際 ID、會議記錄連結、SQLite 或資料庫匯出、日誌、截圖、帳號操作紀錄與個人電腦路徑。

測試的長數字及網址都是合成資料。`CMSFTC_*` 是舊卡片的資料標記名稱，保留來相容既有描述格式，並非部署 ID 或機密資料；不要為了更名而破壞既有卡片辨識。

## 團隊需進行的端對端驗收

1. 確認外部 PostgreSQL 的 TCP/TLS 連線與 migration 權限，日常帳號能執行 check。
2. 在私人管道匯入舊狀態；核對 proposals、forum_recovery、meetings、meeting_records、meeting_dates、pm_deliveries 數量與狀態。
3. 只有一個 Bot／PM 程序在線；重複啟動會被鎖拒絕。驗證資料庫斷線後不會同時有兩個持鎖程序。
4. 新論壇文章建卡一次；重啟、Make 回應遺失與重連補抓不重複建卡。一般訊息和其他論壇不觸發。
5. 任務設定／查看／狀態更新可用，沒有權限的成員被拒絕。
6. 24h、1h、逾期提醒只在原討論串發一次；PM 重啟不重發。
7. 會議日期、時間範圍、地點、角色提及及台灣時間 17:00 正確；記錄只能選已登錄日期，查詢為私人回覆。
8. 發出 SIGTERM，檢查 readiness、停止時間及重啟後的持久狀態。關機／離線期間無法即時通知。
9. 確認日誌不含連線字串、Token、Webhook、任務描述或會議連結。

本 repo 不會替上述步驟啟用服務、建立部署設定或修改團隊伺服器。
