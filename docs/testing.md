# MongoDB 與單一程序驗證

2026-10-23 本機結果：**178 項測試通過、0 失敗**。

## 實際執行

```sh
node --import ./test/env.js --test --test-reporter=dot test/*.test.js
```

測試使用 MongoDB 8.0.17 的真實臨時 replica set，啟用認證；另外保留 SQLite 回歸測試。沒有連線團隊的資料庫、Discord、Make 或 Trello。

已驗證：

- 同時 enqueue／claim，只取得一份工作；錯誤 lease token 不能寫入。
- Make 暫時失敗後重試，只有確認建卡後才回覆；新 store 仍辨識已同步資料。
- 任務 partial unique index、成員唯一映射、任務更新持久化。
- 會議日期／取消的 transaction、刻意拋錯後回滾、記錄與時間範圍。
- 會議 sending 時不能改期或取消；重啟後改成 uncertain，不重送。
- 補抓 checkpoint 保留、不能倒退；初次資料庫失敗後仍可重試。
- PM 共用主程序的狀態，不開第二個 Bot／資料庫；不重疊掃描，停止時可等待當前掃描。
- 提醒 receipt 原子 claim，相同到期階段不重複通知。
- 僅有專用 DB `readWrite` 的帳號可以建 collection／索引、check 與執行 transaction；對 admin 的 usersInfo 指令被拒絕。
- 健康檢查狀態與 HTTP 關閉、連線錯誤不洩漏帳密。
- URI 路徑決定實際 database；認證來源可獨立指定。漏填名稱、`test`、非法名稱與無效連線字串都在連線前拒絕，錯誤不含帳密。
- 隊長／幹部建立任務的年／月／日選單、閏年／月底翻頁、日期清除、取消及預覽。
- 新任務一次建卡、完整欄位確認、原討論串綁定、重啟核對與重複操作去重；未確認建卡不回覆成功、不 @人員。
- 私人頻道白名單、原操作建立者及即時權限檢查；不能指派無頻道權限的成員。
- 真實 MongoDB 的建立操作原子保留、綁定 transaction 失敗回滾；新任務相容既有 `/任務` 及 PM 通知。
- 已綁定且未鎖定的隊長／幹部討論串可在自動封存後接收到期提醒；鎖定時不發送。
- Migration 診斷：真實 MongoDB 錯誤密碼（18）、唯讀帳號建 collection（13）、索引規格衝突及重複資料（11000）均能指出失敗步驟，且不洩漏帳密、database 名稱或文件值；既有衝突索引及資料保留。
- Migration CLI 設定錯誤時輸出一行可解析 JSON、非零 exit code；DNS／TLS／網路的巢狀錯誤與循環 cause 以合成錯誤測試分類及機密保護，未對正式網路／TLS 做驗證。
- Bank 公開任務清單格式、台灣日期與開放條件、有限次數來源重試；無效回應或權限不足不建立基準。
- Bank 首次不補發歷史、新 ID 只公告一次、重啟及內容編輯不重複公告、429 有限重試、發送結果不明時僅核對原訊息；通知限制長度且不觸發提及。
- 真實 MongoDB 的 Bank 基準與發送紀錄持久化、同時 claim 僅取得一份工作、sending lease 恢復及重啟後核對成功；掃描不重疊，停止時不繼續送出。

另以唯讀方式核對正式 Bank 公開 API 的回應可由解析器處理，以及通知頻道的伺服器與文字頻道類型。沒有新增網站任務或發送 Discord 測試公告；正式權限與新任務通知仍需依 `docs/bank-notifications.md` 人工驗收。

Windows 上 mongod 首次啟動曾超過預設 10 秒，因此測試給予 60 秒啟動寬限。測試後會停止臨時程序並清理資料；不建立 Windows 服務或開機排程。

## 尚未驗證

團隊的 MongoDB 版本、正式網路與 TLS、實際帳號權限及 API 端對端連線尚待團隊確認。實際 Gateway 的 SIGTERM 排空與單副本 Recreate，也需由伺服器負責人依 `docs/runtime.md` 驗收。本機測試通過不表示已正式部署。

舊 SQLite 資料與現行 Bot 保留，本分支不自動搬移、刪除或切換。
