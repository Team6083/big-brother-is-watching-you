# Make Webhook 契約與去重

Bot 只接收指定 Discord guild／forum 的新文章。首則訊息最多抓取 5 次；HTTP timeout 15 秒，暫時性錯誤最多 5 次指數退避。Thread ID 是永久提案識別碼，重啟後保留。

## Request

POST 至私密的 `MAKE_WEBHOOK_URL`，JSON 至少包含：

```json
{
  "event_type": "proposal_created",
  "guild_id": "900000000000000200",
  "forum_channel_id": "900000000000000201",
  "thread_id": "900000000000000202",
  "starter_message_id": "900000000000000202",
  "title": "範例提案",
  "content": "僅供說明的合成內容",
  "author_id": "900000000000000203",
  "author_name": "Example Mentor",
  "created_at": "2026-01-01T00:00:00.000Z",
  "discord_url": "https://discord.com/channels/900000000000000200/900000000000000202",
  "tags": ["範例標籤"]
}
```

數字不是實際帳號／頻道；正式值由 Discord API 取得。附件只傳 metadata 與原始 URL，不下載。`Idempotency-Key` 使用 Thread ID；設定 `MAKE_WEBHOOK_API_KEY` 時帶 `x-make-apikey`。

## Make Scenario

1. 使用團隊管理的帳號建立 Custom Webhook，設定 API key 驗證。Webhook URL 本身也必須保密。
2. 將 JSON 作為資料結構樣本；Trello 欄位必須選 Make mapping token，不能填字面上的 `[content]`。
3. 開啟 Sequential processing，同一提案只能有一個執行者進行建卡；其他 Scenario 不可繞過同一去重流程。
4. Data Store 以 Thread ID 為 key，保存 `pending/confirmed/uncertain`、卡片 ID 與 URL。先持久化 pending，再呼叫 Trello。
5. 已 confirmed：讀取確認卡片仍存在，直接回傳既有卡片，絕不新建。
6. 新提案：指定既有的想法收集清單；標題映射 title，描述包含 content、作者、日期、Discord URL，以及獨立一行 `CMSFTC_THREAD_ID=THREAD_ID`。不自動建立清單、標籤、負責人、期限或優先級。
7. 標籤僅匹配看板上名稱相同的既有標籤。附件保持原始連結。
8. 建卡成功後保存 confirmed 與卡片資料，最後執行 Webhook Response。

如果 Trello 已建卡但回應遺失，Data Store 可能停在 pending／uncertain。此時先列出目標看板卡片，以描述中的 Thread ID 精確核對；找到唯一卡片就補齊 confirmed。不要只依賴可能有索引延遲的標題搜尋；不要因回應遺失就再建一張卡。

若查不到、找到多張、資料互相矛盾或不能確定前次請求是否成功，回傳未確認並停止自動建卡，由管理員核對。不以「刪除 Data Store 再重試」作排錯手段。這是跨 Discord、Make、Trello 的至少一次傳送，不宣稱分散式 exactly-once。

## Response

HTTP 200 JSON，完成建卡或確認卡片已存在後才回應：

```json
{
  "status": "success",
  "thread_id": "900000000000000202",
  "trello_card_id": "aaaaaaaaaaaaaaaaaaaaaaaa",
  "trello_card_url": "https://trello.com/c/example1"
}
```

例子不是實際卡片。Bot 驗證 status、對應 Thread ID、24 字元卡片 ID 與 Trello URL。空的 200、Accepted、錯誤 Thread ID 或不可信網址都不算成功；不可在 Scenario 進入點就先回成功。

Webhook 或 Token 輪替時只更新外部環境設定，重新啟動程序。請勿把實際 Scenario export、執行紀錄、驗證資料或成功回應貼進公開 repo。
