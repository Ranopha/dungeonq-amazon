# DungeonQ：中文入門與文件索引

適用：v0.10.0 合成實驗室。此頁是後續文件補強；既有 v0.10.0 tag、下載包與原始實驗紀錄保持不變。最新文件以公開庫 `main` 為準。

## 它現在能做什麼？

DungeonQ 是可在自己電腦上執行的資安治理與誘餌場域實驗室。參與者在有狀態的 B／C／D 合成工作面操作；管理員在分開登入的控制台查看接觸事件、告警及對 A 的輪換提案。必須由管理員重新驗證並核准確切範圍，才可執行合成 A 的憑證輪換，再分別讀回結果。模型及 MCP 工具沒有核准權。

新增通知會送到管理員綁定並驗證的信箱，不由參與者或模型決定收件人。預設是本機模擬信箱，不會對外寄信。

這不是會自動攔截任意企業流量的商用防火牆。誘餌接觸不等於證明 AI 身分或 A 已遭入侵；同機程序分離不等於正式網路／雲端隔離。現有模型紀錄只支持有限的誘餌資料採用，不能宣稱持續認知受騙或普遍防護效力。

## 公開版本怎麼選？

| 入口 | 用途 |
| --- | --- |
| [Astra 公開庫](https://github.com/Ranopha/dungeonq-astra) | 同一合成核心，另含 Astra 提案／獨立核准流程及原始模型證據；付費呼叫須自行明確啟用 |
| [Amazon 公開庫](https://github.com/Ranopha/dungeonq-amazon) | 同一合成核心與 MCP 參賽版本；不代表 Alexa 服務認證或 Echo 整合 |
| [公開展示頁](https://dungeonq-astra.kq7dn7jb6r.chatgpt.site/#email) | 不用安裝即可讀取保存證據；它不代替完整後端，不執行真實登入或寄信 |

私人開發庫沒有改成公開。兩個公開庫採 Apache-2.0，保留乾淨來源、授權及合成證據，不含私人歷史、金鑰或安裝資料。

## 先在本機跑一次，不需要付費帳號

需求：Node.js 24.15.0+、npm、支援 `req -addext` 的 OpenSSL。已驗收 CI 平台為 Ubuntu 24.04、macOS 14；原生 Windows 尚未完成發行驗收。

從上述任一公開庫下載來源，或下載 [Astra v0.10.0 發行包](https://github.com/Ranopha/dungeonq-astra/releases/tag/v0.10.0)／[Amazon v0.10.0 發行包](https://github.com/Ranopha/dungeonq-amazon/releases/tag/v0.10.0)。進入含 `package.json` 的目錄：

```sh
npm ci --ignore-scripts
npm run doctor
npm run email:proof -- --out ../dungeonq-email-proof
npm run defense:proof -- --out ../dungeonq-defense-proof
```

兩個輸出目錄必須尚未存在。預期分別完成 **9 項通知檢查**、**13 項防禦工程檢查**，但只有實際成功結果才算通過；非零退出、UNKNOWN 或缺少讀回不是成功。這些檢查不呼叫付費模型、不掃描外部目標，也不對外寄信。完整檢查使用 `npm run check`；來源清單使用 `npm run verify:source`。

## 打開可操作的管理台

首次建立專用空目錄，只做一次：

```sh
mkdir -m 700 ../dungeonq-orders-lab
npm run defense:workspace -- --data-dir ../dungeonq-orders-lab --seed 17 --depth 4
```

1. 開啟終端印出的 **Owner** 網址，預設為 `https://127.0.0.1:4196/defense`。只複製網址，不要帶入旁邊文字。自行檢查本機自簽憑證提示，不關閉 TLS 驗證、不安裝全系統信任。用首次印出的 `owner-lab` 密碼登入，將密碼安全留在自己本機。
2. 先完成管理員通知設定：展開 **Administrator email & alert delivery → Use email-code verification instead**，輸入 `owner@example.test` 及原密碼，申請驗證碼，在 **simulated mailbox** 讀取並確認。這是模擬驗證，並不證明真實信箱所有權。此信箱可作為原帳號的登入別名，仍需原密碼／已配置的驗證器。
3. 再開啟終端印出的 **Actor** 網址，使用獨立的 Actor-only token，開啟工作面並依序操作 snapshot、index、reconciliation。不要把 Owner 密碼交給 Actor 或模型。
4. 回 Owner 按 **Read current status**，查看同一事故的告警與模擬信箱訊息。這是一次有界 campaign 的首次設定接觸，不是每個流量封包都寄信，也不會補寄綁定以前的歷史事故。
5. 如要驗收輪換，再依 [管理員操作流程](DEFENSE_LAB.md#a-short-interactive-review) 檢查範圍、重新驗證、核准並執行。通知本身不核准。成功必須看到四項讀回：舊 key 被拒絕、新 key 能完成請求、舊 consumer 被拒絕、世界憑證被 A 拒絕。

結束用 Ctrl+C。重新啟動時**不要再 mkdir，不要省略 `--data-dir`**；使用同一條啟動命令、同一 seed／depth／presentation，才能保留原帳號、事故與證據。沒有資料目錄參數會建立另一個臨時安裝；不應拿它當重啟或重設既有帳號。

若預設埠被使用，可在首次啟動加入 `--web-port 4316 --actor-port 4317 --mcp-port 4318`，後續沿用；OAuth callback 的埠亦須相符。不要停掉其他專案或刪除既有安裝來解決衝突。

## Google、GitHub、Apple 與真正寄信的狀態

| 功能 | 現況 | 啟用前還需要什麼 |
| --- | --- | --- |
| 本機帳號＋模擬信箱 | 已實作及驗收，預設可用 | 不需要雲端帳號或憑證 |
| Google／GitHub 登入 | 選配轉接器已實作，測試採本機 fixture | 自己的 OAuth app、相符 callback、先由既有 Owner 連結；真實 provider 流程尚未驗收 |
| Apple 登入 | 本機 profile 尚未實作、按鈕停用 | 另行完成部署方案與實作，不是只補一把 key |
| 真正 Email | 選配 TLS SMTP 已實作，本機收件伺服器測試通過 | 配置寄件服務、驗證寄件身分與收件信箱，再驗收真實收件 |

Google／GitHub 登入不會自動提供寄信服務，也不索取 Gmail 寄信權限。一個帳號目前只有一個有效 provider 綁定；啟用 TOTP 時仍使用本機密碼＋驗證器登入。設定檔範例、必要權限及完整命令見 [登入與郵件設定](EMAIL_NOTIFICATIONS.md)。

真實告警驗收要在該安裝**首次 Actor 接觸以前**完成 SMTP 與收件綁定。若已跑完前面的模擬流程，保留原安裝與證據，另開一個明確命名的私有 lab 驗收新事件；不要刪除舊紀錄或期待補寄。真正 provider 驗證的綁定與手動模擬綁定不同；開始手動替換信箱會解除先前 provider 綁定，不能把它當作無副作用的寄信測試。

`ACCEPTED` 只表示所選傳輸接受訊息：模擬模式是本機捕獲，SMTP 模式是郵件伺服器接受，**不是收件匣送達證明**。`UNKNOWN` 不會盲目重送；移除綁定也無法收回已寄出的郵件。

## 文件與證據索引

| 想確認的事情 | 看這裡 |
| --- | --- |
| 通知、provider 設定、重啟與復原 | [EMAIL_NOTIFICATIONS](EMAIL_NOTIFICATIONS.md) |
| 管理台、人類核准、輪換與四項讀回 | [DEFENSE_LAB](DEFENSE_LAB.md) |
| 合成工作面、MCP 與模型結果限制 | [WORKSPACE_LAB](WORKSPACE_LAB.md) |
| 三分鐘開源審查 | [OSS_REVIEW_GUIDE](OSS_REVIEW_GUIDE.md) |
| 發行測試與 CI 證據 | [VALIDATION](VALIDATION.md) |
| 九項通知原始報告 | [email proof](../evidence/email-v1/proof.json) |
| 十三項工程原始報告 | [defense proof](../evidence/defense-v1/proof.json) |
| 安全回報、貢獻、版本變更 | [SECURITY](../SECURITY.md) · [CONTRIBUTING](../CONTRIBUTING.md) · [CHANGELOG](../CHANGELOG.md) |

升級前先安全備份完整私有安裝，包含資料庫、keys與相關狀態；不要公開該目錄。Schema v7 不應降版，不復活已撤銷憑證。真實企業 connector、正式隔離與商用驗收是獨立工作，不由本機合成結果代替。
