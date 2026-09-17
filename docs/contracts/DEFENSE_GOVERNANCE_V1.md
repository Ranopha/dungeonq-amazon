# 合成防禦輪換治理 v1

Owner：DungeonQ。2026-09-17，DQ-DEFENSE-003。範圍：`SYNTHETIC_ONLY`、固定 loopback Reference Issuer、人工資源與可丟棄憑證。此契約不授權企業接點、外部通知、任意 URL、AI 身分推定或正式環境輪換。

## 信任與授權

`openGovernance` 新增選配 `rotationPrivateKey`，必須是獨立於 containment signer 的 Ed25519 私鑰。啟用時持久釘選公鑰；之後缺失或替換拒絕啟動。一般 Store、Issuer、sink 只進行 Schema migration，不要求該 key。rotation 使用 `dungeonq.reference-rotation/v1\n` 專用 domain；原 containment Grant、意圖及效果都不能用來授權 rotation。

人類 Session、Worker 與可信組裝端是不同 capability handles。只有 `TENANT_SUPER_ADMIN` 有 `APPROVE_ROTATION`；Reviewer 是檢閱角色，不是第二核准人。核准是 `SINGLE_OWNER_AUTHORIZED`：獨立於 Actor／Worker，但不宣稱兩名管理員 quorum。Actor 不取得人類密碼、意圖、rotation signer、Broker token 或 local handle。

只有可信組裝端可以登錄固定 A、報告已配置本機誘餌的接觸及回報結果。組裝端負責固定 world 設定與事件來源；傳入 `worldId` 本身不是 sensor attestation。核心只驗已登錄 A、封閉 schema、事件 digest 與事故重播一致性，`actorClassification` 固定 `UNDETERMINED`。命中不證明對方是 AI，也不證明 A 已失陷。

## API

| Handle / 方法 | 封閉輸入與結果 |
| --- | --- |
| `local.registerRotationTarget` | `{tenantId,assetId,expectedGeneration,epoch,cleanConsumer}` → `{registered,replay,generation,epoch}`。A 必須已由可信 bootstrap 登錄；重啟只接受完全相同原始登錄，不重設已前進 generation。 |
| `local.recordDecoyContact` | `{tenantId,incidentId,assetId,worldId,eventDigest}` → `{incidentId,recorded,replay,notificationEventId}`。同交易建立事故、`DECOY_CONTACT` Audit 及 notification outbox。相同事故只接受相同 binding。 |
| `execution.requestRotation` | `workerToken,{requestId,incidentId}` → request view。伺服器從固定 A 產生 reference rotation manifest；期限最長五分鐘且不超過 Worker 期限。Proposal 不簽發 permit。 |
| `application.rotationStatus` | `sessionToken` → `{incidents,requests}`。只讀本人 tenant；request view 不含 permit／signature／key。 |
| `application.reauthenticate` | `sessionToken,{password,purpose:'APPROVE_ROTATION',manifestDigest,otp?},source` → 原有單次 intent。啟用 TOTP 者不能省略。 |
| `application.approveRotation` | `sessionToken,{requestId,manifestDigest,intentToken}` → request view。核對 Owner、單次 intent、Worker、tenant epoch、A generation／epoch／Consumer 及期限。 |
| `application.refreshRotation` | `sessionToken,{requestId}` → request view。僅 Owner 可刷新已過期、從未 claim 的等待／已批准提案；保持事故與 scope，更新期限與 digest，清空原核准並刪除舊 digest 的 rotation intents。需要重新審阅／重驗／核准。撤銷、Worker 失效、generation 改變或曾 claim 均拒絕。 |
| `execution.claimRotation` | `workerToken,{requestId}` → `{requestId,incidentId,manifestDigest,state,permit:{body,signature},replay}`。已核准才簽；同請求重播回相同 manifest／signature，固定 generation 只能一個 request claim。完成後只回歷史 receipt／checks，沒有 permit。 |
| `local.recordRotationOutcome` | `{tenantId,requestId,manifestDigest,status,receipt,checks}` → request view；`status` 僅 `COMPLETED/UNKNOWN/FAILED`。由可信 Broker 執行，不是 Actor 的成功宣告。 |
| `local.rotationRequestsToReconcile` | `{tenantId}` → 已 claim 且待讀回的 request views；包含 `CLAIMED/UNKNOWN` 與已 Fence 的先前 claim，沒有 permit。 |
| `local.rotationVerificationKey` | 無參數 → `{domain,publicKey}`；只供組裝端釘選 Issuer 驗章 key。 |

Manifest 嚴格沿用 reference schema：`schemaVersion,profile,tenantId,assetId,expectedGeneration,epoch,cleanConsumer,expiresAt`。沒有模型提供的 effect、URL 或權限欄位。事故、Worker、人類核准、domain/digest 與 request binding 由治理 DB／Audit 保存。

request view：`requestId,incidentId,assetId,workerId,manifest,manifestDigest,domain,state,storedState,authorizationActive,approvedBy,approvedAt,claimedAt,completedAt,receipt,checks`。主要狀態 `AWAITING_HUMAN → APPROVED → CLAIMED → COMPLETED`，另有 `UNKNOWN/FAILED/FENCED`；view 以現在時鐘衍生 `EXPIRED`，保留 `storedState` 供對帳。incident 包含 `incidentId,assetId,worldId,eventDigest,observedAt,actorClassification,notification:{eventId,state,receipt}`。

## 效果讀回與拒絕

`COMPLETED` 必須有 Reference Issuer 的精確 receipt，tenant、asset、manifestDigest、Consumer 及 generation 必須匹配；`issuerReadback:true`。Issuer 的 `businessVerified:false` 保留原意，另以 `checks` 的四項 `oldKeyDenied,newKeyBusiness,oldConsumerDenied,decoyKeyDenied` 全真作為完成條件。Receipt 不可包含 key 或自由 Provider 原始錯誤。測試／Broker 必須真做檢查；可信函式收到四個 true 不等於有獨立第三方證明。

UNKNOWN 不再領 permit、不新簽授權，不以重送輪換解決；可信 Broker 只依同一 manifest digest 查 Issuer receipt，再做必要讀回。FAILED 表示確知不成功的終態，不能重開同一 request。完成結果重播不可改寫收據或檢查。Issuer 回傳的 replay 旗標不改變已保存效果。

`revokeGrants` 與 Owner Recovery 前進 tenant epoch 並 Fence 未完成 rotation。Broker 在實際 rotate 前必須重新 claim 驗證，且不得把 permit 或 Broker token 交 Actor。已簽出的 permit 本身在 Issuer 的有界效期內有效：目前尚無跨 DB 原子撤銷傳播或 Issuer epoch fence hook，因此不宣稱撤銷瞬間能使外流 permit 在 Issuer 立即失效。正式部署需獨立完成撤銷傳播及時序驗收。

即使核准後被撤銷／過期，可信 Broker 仍可保存已經發生的完成效果，避免丟棄事實；這只開放精確 readback，不發新 permit、不復活舊 key。原始核准、Fence 與結果 Audit 都保留。

目前一個 A 使用已登錄的 old／clean Consumer 支持一次固定接續；完成後 generation 前進，不把已 retired Consumer 再當乾淨實例。後續多輪 Consumer 佈建／target 更新需要版本化契約。本輪每 tenant 最多 100 targets、100 requests、1,000 incidents；同 incident 只有一個 request，refresh 仍保留原 request trace。

## 相容、驗證與成熟度

Schema v6 於單一初始化交易新增 rotation targets／incidents／requests／generation claims，不改寫既有研究證據；未知表衝突整體 rollback。保留 tenant epoch、clock、signer、舊 Audit；不能靠降版或重開重設撤銷狀態。停用新 UI 不移除 v6 表；回復使用同版本備份或獨立合成 fixture，不還原正式資料。

`tests/defense-governance.test.mjs` 涵蓋實際合成 Issuer 與 notification sink、獨立授權、意圖／角色拒絕、重播、重啟、跨 tenant／Worker、expiry／refresh、單 generation claim、UNKNOWN 對帳、四項讀回、Owner 撤銷／Recovery，以及 v5→v6 保留與 rollback。自動化核准測試證明 API 身分分離，不冒充真人曾點 UI；完整 HTTPS UI／Broker／世界閉環由 DQ-DEFENSE-003 整合驗收另行證明。

同主機不同 DB／handles 不等於 OS 隔離，MCP 不提供透明網路隔離；本機 sink 收據也不等於 Email／外部管理員已讀。正式 Connector、通知 Provider、跨信任域隔離、恢復與負載均未因本輪變更自動通過。
