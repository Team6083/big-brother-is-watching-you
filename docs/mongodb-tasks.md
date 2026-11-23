# MongoDB 任務切換與驗收

任務、論壇提案與 PM 直接使用現有 MongoDB，不需要 Make Webhook、Trello API Key 或 Token。

## 部署

1. 備份現有 MongoDB。沿用同一個 database，保留 proposals、task_creations、task_changes、pm_deliveries、會議與 Bank 歷史；不要清空任何 collection。
2. 停止舊 Bot，維持既有單副本 Recreate 部署。更新程式或映像後，先執行 npm run migrate，新增 tasks collection 及 task_thread_unique 唯一索引，再執行 npm run check。
3. 保留 Discord、MongoDB、TASK_*、TEAM_CHANNEL_ACCESS_ENABLED、PM_*、會議與 Bank 設定。移除不再使用的 MAKE_WEBHOOK_*、TRELLO_*、PM_TRELLO_AUTOMATION_MEMBER_IDS；即使殘留舊值，新 runtime 也不讀取它們。
4. 執行 npm run tasks:register 更新指令說明，再啟動唯一的 npm start。

本次只增加任務集合與索引，不更動原有會議及 Bank 資料結構。升級後的新論壇提案直接存入 tasks，原始內容、標籤及附件 metadata 保存在 proposal 欄位，不下載附件。

## 任務狀態

保留原流程的七個狀態：想法收集、待討論／決策、待執行、進行中、待審核、待公告、完成。狀態選單由 Bot 提供。任務 ID 與伺服器／討論串綁定；任務內容沿用既有表單欄位，並保存版本、建立／更新及完成時間。

## 舊任務

舊 MongoDB 的 task_snapshot 只代表建立時資料，不能當作 Trello 最新狀態，因此不自動恢復人員、日期或進度。未匯入的舊任務保留綁定與全部歷史，使用 /任務 時提示管理員匯入；新任務可直接使用。

可使用 Trello 看板 JSON 匯出（cards、lists、看板 id），或舊 readBoard 的完整 snapshot。匯出檔放在 private/，不要提交 repository。匯入不連線 Trello，也不需要有效的 Trello 憑證。若目前無法取得匯出，先使用新任務；舊資料繼續保留。

先在注入正式環境設定的管理程序預覽：

~~~sh
npm run tasks:import -- private/board.json
~~~

預覽只輸出數量，不寫入資料、不顯示任務內容。人工核對後才套用：

~~~sh
npm run tasks:import -- private/board.json --apply
~~~

- 僅接受目前伺服器、提案論壇或允許的任務頻道內，已成功綁定相同卡片 ID 的紀錄；不根據標題猜測任務。
- 每項匯入在 transaction 中新增 tasks 並更新綁定，保留原 legacy_ack 及完整 legacy_card。重跑不覆寫已匯入或新建立的任務，也不改動提醒 receipt。
- 待確認更新、重複討論串、未知狀態、無綁定、日期或 metadata 異常會略過，以原因與數量回報。請保留來源資料並逐項核對，不要清除操作紀錄來繞過限制。
- Trello 狀態別名（如待辦事項、執行中、已完成）對應到原任務階段；自訂且無法辨識的清單不猜測。
- 優先保留 Discord 人員 metadata；只有缺少 Owner 區塊時，才使用既有明確成員映射。沒有映射不猜人名／人員。
- 已完成任務從匯出檔的 actions 還原最近一次移入完成清單的時間。缺少可核對的移動紀錄時留空。既有提醒紀錄保留；未曾發出的目前到期階段仍可能在啟用 PM 後通知。
- 舊版尚未完成的建立操作，不會由新版默默重建；以核對編號查詢會提示管理員處理。

## 驗收

1. 移除 Make 與 Trello 設定後，check 與 Bot 可正常啟動。
2. /建立任務 可開表單、選人員／日期／狀態，取消不寫入。確認後只建立一個討論串、一項任務與一則通知。
3. 在原討論串及允許的父頻道使用 /任務，可查看、編輯及更新狀態；重啟後資料仍存在，舊面板的查看／核對按鈕仍可用。越權、跨頻道與無頻道權限者被拒絕。
4. 發布一則新論壇提案，確認只收錄一項任務、保留原文與附件 metadata，回覆明確顯示已收錄為任務。
5. PM 到期前 24 小時、1 小時與逾期各通知一次；只發到已綁定的原討論串。改成完成後不再排到期提醒。
6. 會議查看／設定及 Bank 通知沿用原流程。正式網路、Discord 權限與 SIGTERM 排空仍須由部署負責人驗收。

本機測試通過不代表正式 Bot 已更新。新版不會改動 Trello 卡片或自動刪除 Make Scenario。
