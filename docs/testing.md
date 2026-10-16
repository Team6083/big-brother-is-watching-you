# MongoDB 與單一程序驗證

2026-10-16 本機結果：**137 項測試通過、0 失敗**。

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

Windows 上 mongod 首次啟動曾超過預設 10 秒，因此測試給予 60 秒啟動寬限。測試後會停止臨時程序並清理資料；不建立 Windows 服務或開機排程。

## 尚未驗證

團隊的 MongoDB 版本、正式網路與 TLS、實際帳號權限及 API 端對端連線尚待團隊確認。實際 Gateway 的 SIGTERM 排空與單副本 Recreate，也需由伺服器負責人依 `docs/runtime.md` 驗收。本機測試通過不表示已正式部署。

舊 SQLite 資料與現行 Bot 保留，本分支不自動搬移、刪除或切換。
