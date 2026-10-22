# Migration 失敗診斷

使用包含此修正的新版程式／image，在正式環境變數已注入的同一環境執行：

```sh
npm run migrate
```

本機使用私密 `.env` 時則執行 `node --env-file=.env src/state/migrate.js`。npm 指令本身不會自動讀 `.env`。

成功時 stdout 仍輸出 `{"event":"schema_ready"}`，exit code 為 0。失敗時 stderr 輸出一行 JSON，exit code 為 1；不再只有事件名稱。

以下只是權限不足的範例，不代表已判定正式環境的實際原因：

```json
{
  "event": "migration_failed",
  "code": "mongodb_migration_failed",
  "stage": "create_collection",
  "collection": "proposals",
  "reason": "authorization_failed",
  "driver_error": "MongoServerError",
  "mongo_code": 13,
  "mongo_code_name": "Unauthorized",
  "hint": "請確認帳號對 URI 指定的 database 具有 readWrite 權限，並核對 authSource。"
}
```

## 失敗步驟

| `stage` | 意義 |
|---|---|
| `configuration` | URI 未注入、語法／協定／database 名稱不合法；還沒連線 |
| `connect` | 連線、節點選擇、TLS 或認證失敗 |
| `ping` | 已建立 client 連線，但 ping 失敗 |
| `list_collections` | 無法查詢程式需要的 collection 是否存在 |
| `create_collection` | 建立缺少的 collection 失敗 |
| `create_index` | 建立索引失敗，另有 `collection` 與 `index` |
| `close` | 完成工作後關閉 client 失敗；仍以非零狀態結束 |

若 migration 與關閉都失敗，優先保留原本 migration 的診斷，避免清理錯誤掩蓋主要原因。

## 排查方式

| `reason`／錯誤碼 | 排查方向 |
|---|---|
| `missing_uri` | 確認 Secret／env 確實注入 migration 的程序或容器 |
| `invalid_uri_scheme`、`invalid_uri` | 私下核對 URI 語法、選項及帳密編碼 |
| `default_database_forbidden` | URI 路徑不可省略 database，也不可使用 `test` |
| `invalid_database_name` | 名稱須為 1–63 個英數字、底線或連字號 |
| `authentication_failed`／18 | 帳密、`authSource`、認證方式 |
| `authorization_failed`／13 | 帳號需有 URI 所選 database 的 `readWrite` 權限；有登入成功不代表能建 collection／索引 |
| `dns_failed`／`ENOTFOUND`、`EAI_AGAIN` | 從 Bot 容器確認 DNS／SRV 解析及網路政策 |
| `connection_refused`／`ECONNREFUSED` | 資料庫服務、連接埠、路由及防火牆 |
| `network_failed`、`timeout` | 容器至各節點的可達性、資料庫負載及 primary 狀態 |
| `tls_failed` | TLS、CA 掛載、憑證主機名稱及效期；不要關閉憑證驗證 |
| `file_access_failed` | 執行權限及 CA 掛載路徑；日誌不輸出實際私密路徑 |
| `server_selection_failed` | `replicaSet` 名稱、primary、節點公布的位址是否從容器可達；`topology_type` 可協助辨識 |
| `index_conflict`／85、86 | 管理員比對指定索引的 key、unique、partial filter 等規格，不要直接刪除 |
| `duplicate_key`／11000 | 既有資料違反唯一索引；管理員先私下核對資料，不自動刪除／修改 |
| `mongodb_error` | 尚未分類的錯誤，依步驟、driver 類型及數字錯誤碼進一步查核 |

錯誤碼與排查方向依 [MongoDB 錯誤碼](https://www.mongodb.com/docs/manual/reference/error-codes/) 與 [Node.js driver 連線排查](https://www.mongodb.com/docs/drivers/node/current/connect/connection-troubleshooting/) 整理；提示是排查方向，不是對環境的直接診斷。

## 可提供的資訊

請提供新版輸出的 `migration_failed` JSON，以及使用的 image tag／commit。沒有 `mongo_code` 時，仍可由 `reason`、`driver_error`、`system_code` 與 `topology_type` 排查。

日誌只選取已知錯誤類型、受控提示、數字錯誤碼及程式定義的集合／索引名稱。刻意不輸出原始 message、stack、連線字串、帳密、伺服器位址、database 名稱、指令內容或重複文件的值。不需要提供完整 URI 或開啟原始錯誤傾印。

此修正只增加診斷與清理錯誤保護；保留原本的 timeout、連線選項、collection／索引定義與重複 migration 行為。不會自動修復權限、刪除索引或更動資料。
