# 執行契約與 12-factor

依據 [The Twelve-Factor App](https://12factor.net/)。本分支將 Gateway Bot、會議與 PM 定時提醒合成同一個 Node.js 程序，正式狀態由外部 MongoDB replica set 保存。

| 原則 | 做法 |
|---|---|
| Codebase | 同一 repo、同一入口 `npm start`，不同環境使用不同設定 |
| Dependencies | 精確版本與 lockfile，npm ci，不用全域套件 |
| Config | Token、Webhook、頻道／角色／看板、`MONGODB_URI` 由 env 提供 |
| Backing services | MongoDB、Discord、Make、Trello 都是外部資源 |
| Build/release/run | 安裝、注入設定、一次性建索引、執行分開；不自動開通服務 |
| Processes | 無本機持久狀態；只有尚未提交、15 分鐘失效的 Discord 表單暫存記憶體 |
| Port binding | 指定 PORT 時提供健康檢查，Gateway 使用出站連線 |
| Concurrency | 主程序內獨立非同步工作；單文件租約與唯一索引防重；部署維持單副本 |
| Disposability | SIGTERM／SIGINT 停止新工作、排空，25 秒上限；狀態供重啟恢復 |
| Dev/prod parity | Node 24.x、相同 lockfile、相同主版本 MongoDB replica set；保留舊 SQLite 回歸測試 |
| Logs | stdout／stderr 的受控事件，不記錄 URI、Token、內容或原始例外 |
| Admin processes | migrate、check、register、admin、PM 預覽均為 one-off 指令 |

## 資料庫

使用官方 `mongodb` driver，不使用 Mongoose，也沒有 SQL 翻譯介面。`src/state/` 提供具名資料操作；runtime 不呼叫 `prepare(sql)`。

十個 collection：`proposals`、`forum_recovery`、`task_members`、`task_changes`、`task_creations`、`meetings`、`meeting_records`、`meeting_dates`、`pm_deliveries`、`bank_notifications`。升級後先執行 `npm run migrate`，建立缺少的 collection；runtime 的 `check` 會確認必要 collection 及索引存在。

- Discord ID 及卡片 ID 都是字串；毫秒 timestamp 是 JS 安全整數。
- `_id` 保存 Thread ID、Interaction ID、delivery key 或由 channel／date 等欄位組成的識別碼。
- proposals 以 `findOneAndUpdate` 原子取得租約；寫入必須持有相同 lease token。
- 任務 pending 使用 partial unique index；同一張卡同時只能有一項待確認更新。
- 文字頻道建立任務以草稿操作 ID 作為 `task_creations._id`，在建立 Discord 討論串前就原子保留。`thread_pending`／`card_pending` 保存結果不明的操作；只有確認完整卡片欄位後才在 transaction 中一起保存提案綁定及 `succeeded`。重啟後可核對，不自動重送建立請求。通知另以 pending→sending→sent 記錄，sending 不重送。
- 會議設定／取消與日期歷史使用 transaction。callback 只含資料庫操作，可安全由 driver 重試，沒有 Discord／Trello 副作用。
- 不設 TTL 刪除去重、會議或提醒歷史。
- Bank 新任務通知的首次清單基準與各任務 ID 在 transaction 中保存。發送前原子取得工作，回應不明時僅核對最近公告，不自動重送。與 Gateway 共用主程序及 MongoDB，停止時一起排空。
- 狀態由 store 方法檢查並限定寫入值，不要求 collection validator。直接手動改 DB 不受此層驗證保護。

### 連線與權限

只設定 `MONGODB_URI`，資料庫名稱必須放在 URI 路徑中；`client.db()` 使用 driver 解析的名稱。名稱限 1–63 個英數字、底線或連字號。省略名稱或明確使用 `test` 均以 `invalid_mongodb_config` 拒絕啟動；格式錯誤也使用此錯誤碼，連線／ping 失敗則為 `mongodb_unavailable`，不輸出原始 URI。`authSource` 獨立指定認證來源。舊設定需將 database 名稱移至 URI 路徑，並移除原本獨立的 database 環境變數。

提供本專案獨立 database 的內建 `readWrite` role 即可，包含建 collection／索引與交易所需權限，不需 admin 或 dbAdmin。`npm run migrate` 是一次性建立 collection／索引，不會刪除或重建資料。`npm run check` 檢查 replica set 及必要唯一索引；runtime 啟動前也檢查。

連線池上限 8；server selection／connect timeout 5 秒、一般操作預算 10 秒、socket timeout 15 秒；會議 transaction 預算 15 秒。driver 自動重連，不再因程序鎖 session 消失而退出。外部 API 保留原有 timeout 與有限重試。

團隊版本尚待確認；本機整合測試預設 MongoDB 8.0.17，可以用 `MONGOMS_VERSION` 覆寫。這不是將正式 MongoDB 版本寫死在程式。

## 單一程序與部署要求

啟動 `npm start`，並以 `PM_ENABLED=true` 啟用同程序內的 PM。`PM_INTERVAL_MS` 預設 60000；掃描未完成時不重疊執行。停止時不再啟動下一輪，主關閉流程也會等待 PM。PM 共用資料庫連線，直接呼叫 Trello／Discord，不經 Make。

應用程式不再取得全域程序鎖。部署維護者須採單副本與 Recreate，並避免舊環境使用相同正式 Token 並存；不能以滾動部署或增加 replicas 擴展同一 Bot。本次不修改部署檔案。

即使如此，節點失聯仍可能導致新舊程序短暫並存。單文件租約、唯一索引與原子提醒 claim 仍保留，但不能宣稱它們取代跨節點程序鎖或保證全域 exactly-once。團隊已接受移除程序鎖的風險。

## 健康與停止

- `/healthz`：運作時 200、停止中 503。
- `/readyz`：Discord ready 且未停止時 200，其餘 503；回覆不含設定。
- 停止接新 Discord 事件、清除定時工作、等待正在進行的工作，再關閉 Gateway、HTTP 與共享 MongoDB client。25 秒後強制結束，外部停止寬限需大於此值。
- 程序中斷後租約可回收。會議 sending 在新程序啟動時改為 uncertain，不自動重送；PM 的 pending receipt 也不會自動重送。

## 維護決策與公開內容

本階段移除 PostgreSQL、程序鎖及 PostgreSQL 專用 SQLite 匯入工具；SQLite 實作保留供既有回歸測試，不擴大進行第二階段清理。舊資料檔及原本電腦上的 Bot 不會被修改，是否搬移舊狀態需在正式切換前確認。

不提交真實 URI、帳號、部署 ID、Webhook、會議連結、資料庫檔、日誌、截圖或個人電腦路徑。測試數字、帳密與網址只用合成值。`CMSFTC_*` 僅為相容舊卡片的標記名稱。

CI 維護者可另加 mongod binary 快取；既有 Dockerfile、workflow 本次保持不動。Dockerfile 原本的獨立 PM 指令旁註已不再適用，請勿另啟 PM daemon。

## 人工驗收

1. 確認正式 MongoDB 主版本、replica set、TLS 及該 DB 的 readWrite role；執行 migrate／check。
2. 決定是否需要舊狀態，保留備份並停止舊 Bot／PM，再由部署負責人切換；本分支不自動搬移或捨棄。
3. 只有一個 npm start 程序，PM_ENABLED=true。確認部署是單副本 Recreate，而不是期待程式鎖擋重複啟動。
4. 新文章建卡一次、Make 回應遺失不重複建卡；重啟補抓只涵蓋新啟用後文章。
5. 任務設定、查看、狀態、Owner／Assignee 與日期正確，未授權頻道／成員被拒絕。
6. 24h／1h／逾期與會議提醒僅發一次；記錄只能選已有會議日期。
7. 發 SIGTERM，確認 Gateway 與 PM 一起停止、排空及重啟後狀態；不殘留第二個 PM worker。
8. 資料庫斷線／恢復時不洩漏憑證，亦不因未確認結果重發訊息。
