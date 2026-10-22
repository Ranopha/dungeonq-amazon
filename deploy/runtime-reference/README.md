# Isolated artificial reference

This profile runs four bounded DungeonQ services in the dedicated `colima-dungeonq-rehearsal` Docker context by default. It is a reference deployment for synthetic acceptance, not a production connector or proof against container escape. The services share one Linux VM kernel; the Docker administrator remains trusted.

The gateway owns canonical state, admission signatures, and operator authority. The participant-facing facade has only its own non-secret configuration and the world network. Origin and evidence services use separate internal networks, credentials, and named state volumes. All four services run as the nonroot preparing user, with a read-only root filesystem, no capabilities, no-new-privileges, bounded memory/PIDs, and a temporary scratch filesystem. No ports are published to the host. Acceptance clients run inside the dedicated gateway container. SSH/PostgreSQL bind to gateway loopback and remain the declared bounded protocol subset.

The VM needs no host filesystem mounts. Role configurations are generated outside the repository with mode `0600` and copied into separate named config volumes through stopped temporary containers. Each running service mounts only its own config volume read-only. Existing config volumes must match their original content digest; startup never replaces credentials behind persisted state.

The image pins Node 24.15.0 by registry digest. Its build context contains only an explicit source allowlist, not the repository, local credentials, or Git history. Locked dependencies include the test clients; install scripts are disabled. A source manifest binds exact staged bytes to an image label. This label is checked against actual image IDs and current source bytes; it is not a cryptographic attestation from an independent builder.

## Run and verify

Run from an installed source checkout. The runner always supplies the dedicated Docker context and never switches the default context or creates/stops a VM.

On an explicitly provisioned disposable Linux runner, set `DUNGEONQ_DOCKER_CONTEXT` to a dedicated context named `dungeonq-*`. The public workflow creates `dungeonq-ci` against that runner's local Docker socket. The default Docker context is never selected or changed. A name is not proof of isolation: the verifier inspects the actual project containers, networks, mounts and source image.

```sh
node scripts/runtime-isolation.mjs prepare
```

Save the returned private directory path as `REFERENCE_DIR` for this task. It contains credentials: do not commit, upload, or print its config files.

```sh
node scripts/runtime-isolation.mjs build --directory "$REFERENCE_DIR"
node scripts/runtime-isolation.mjs up --directory "$REFERENCE_DIR"
node scripts/runtime-isolation.mjs verify --directory "$REFERENCE_DIR"
node scripts/runtime-isolation.mjs down --directory "$REFERENCE_DIR"
```

`build` stages current source into a new immutable build directory. After source changes, rebuild and run `up` again before verification. `up` returns the gateway container identity and internal origin, not a host-accessible URL. `down` stops only this generated Compose project and retains its named volumes and private configuration for restart/continuity acceptance. Never regenerate credentials to reuse existing state.

`verify` performs only scoped artificial read operations and their audit records. From the actual facade container it checks canonical TCP reachability, direct-IP origin/collector denial, operator API denial, unsigned canonical-request rejection, and inability to open real protected files. Positive controls check that those files exist and are readable in their owning container. Actor and ordinary requests must correlate to accepted gateway/collector events, while the independent origin witness preserves its data/configuration digests and counts only the ordinary admission.

The private `isolation-result.json` includes observed container/image/network IDs, mount facts, network outcomes, witness readbacks, source digest, and individual checks. Missing, duplicate, or unobserved checks are `INCONCLUSIVE`; any failed check prevents `PASS`. The gateway's separate local integration report continues to identify its own scope accurately. This external report supplies additional measured infrastructure facts rather than changing a deployment label into proof.

Unit tests validate preparation and the acceptance gate; they do not establish live isolation:

```sh
node --test tests/runtime-isolation.test.mjs
```

No external destinations, enterprise data, real production credentials, remote settings, or public deployment are part of this profile. PostgreSQL uses disposable cleartext credentials only inside the gateway loopback profile; external PostgreSQL/TLS support remains unavailable.

## 參與者隔離實驗室（選用，預設停用）

`compose.participant.yml` 在同一個專用 context 內，把四個參考服務加上一個「參與者」容器，供對抗實驗與演練使用。只有明確執行 `lab-*` 指令才會建立；上面的參考流程與 `compose.yml` 不受影響。

- 參與者容器：專用非 root UID（64101，與服務 UID 不同）、唯讀根檔案系統、移除全部 capability、no-new-privileges、PID ≤ 32、記憶體 ≤ 128 MiB、沒有任何主機目錄掛載、沒有對外發布的連接埠。映像只含 Node 與 `participant-client.mjs`，不含 DungeonQ 執行環境原始碼。
- token：參與者只掛載自己的唯讀設定卷，內容只有被導流 context 的 actor token 與 gateway 位址；其他 token、ticket 金鑰與證據資料庫都在各自服務的卷內。設定檔以 tar 串流寫入，擁有者與權限（0600）逐一讀回驗證。
- 網路：參與者只加入 internal 的 `participant` 網路，該網路上只有 gateway。gateway 的簽章 canonical 連接埠只綁在 world 網路的別名 `gateway-state` 上，參與者連不到。gateway 以 `participant-v1` 呈現，結果不帶路由資訊。
- 兩種模式：`SCRIPT_CLIENT`（預設）完全不能出外網；`MODEL_PARTICIPANT` 另外啟動 `egress-proxy.mjs`，只允許 CONNECT 到 `api.openai.com:443`，解析結果必須是公網位址，其他目的地一律 403、非 CONNECT 一律 405，並有並行數、總通道數、閒置與單通道時間上限。
- 模型 API 金鑰：只在 `MODEL_PARTICIPANT` 模式、由呼叫端明確傳入時，經 Docker CLI 的程序環境變數 `DUNGEONQ_MODEL_API_KEY` 交給 Compose，成為參與者容器的 `OPENAI_API_KEY`；不寫入映像、設定卷或任何檔案。Docker 管理者仍可用 inspect 看到它。
- 上限：每個服務都以 `timeout` 包住，最長存活 `lifetimeSeconds`（預設 1200 秒）；等待 gateway 就緒最多 8 次、間隔逐次加倍到 4 秒、總時限 45 秒；建置與啟動失敗不重試。

```sh
node scripts/runtime-isolation.mjs lab-prepare --mode SCRIPT_CLIENT --arm DIVERT   # 或 DIRECT／DENY；MODEL_PARTICIPANT 仍可用
node scripts/runtime-isolation.mjs lab-build  --directory "$LAB_DIR"
node scripts/runtime-isolation.mjs lab-up     --directory "$LAB_DIR"
node scripts/runtime-isolation.mjs lab-verify --directory "$LAB_DIR"
node scripts/runtime-isolation.mjs lab-script --directory "$LAB_DIR"   # 固定參考流程
node scripts/runtime-isolation.mjs lab-study  --directory "$LAB_DIR"   # 三組共用的研究流程（含 A2 來源見證）
node scripts/runtime-isolation.mjs lab-down   --directory "$LAB_DIR"
```

### 三組對照與第二條真實路徑 A2（DQ-HANDOFF-015 M8）

`--arm` 選擇研究組別，三組共用相同提示、工具、預算與第二條真實路徑 A2，差別只在參與者拿到的 token 與 gateway 的路由：

- `DIVERT`（DungeonQ 錯誤 ticket）：參與者拿被導流的 actor token，操作被導到假世界（SYNTHETIC）。
- `DIRECT`（開放正控制）：參與者拿 ordinary token，讀到真實 origin 紀錄（ORIGIN），證明對照組不是永遠拿不到目標。`participant-v1` 呈現已不帶 `_route` 等內部路由欄位。
- `DENY`（普通拒絕，無 DungeonQ）：參與者拿未註冊的 token，gateway 一律拒絕，沒有假世界可接受。

A2 是一個不經 DungeonQ 的合成真實資產容器，每組都有。它只加入內部 `a2` 網路（網路上只有參與者），連不到 gateway／origin／collector；參與者同時加入 `participant` 與 `a2` 網路，連得到 A2。A2 把每次請求以 JSON 寫 stdout，主機以 `docker logs` 讀回作為來源見證。`lab-study` 的流程會記錄每一步的時間、A2 轉向與可選的腳本識破訊號，接受率、識破時間與「接受後停止追真」由主機 `scripts/dungeonq-host/isolated-lab.mjs` 的校準計算，`lab-verify` 只做隔離驗收。不呼叫任何付費模型 API。

`lab-verify` 在實際容器內量測並逐項給 PASS／FAIL：服務與參與者的限制旗標、掛載與網路圖、映像來源綁定、參與者設定只含自己的 token、以雜湊比對掃描參與者可讀檔案與環境變數（不把其他 token 明文送進容器）、主機路徑與 Docker socket 不存在、受保護檔在參與者內讀不到而在擁有者容器內讀得到、外網與非 gateway 服務連不到、操作員 API 回 401、腳本客戶端以 HTTP 與 MCP 完成導流與 ticket 流程且結果不含路由資訊、普通 context 對照仍到 origin、gateway 證據完整。模型模式另驗證白名單只放行 `api.openai.com:443` 的 TLS 握手（不送任何模型請求）與拒絕紀錄。

`lab-down` 移除本專案的容器、網路、狀態卷、設定卷與映像，然後列出殘留；每一步只嘗試一次，失敗時回報殘留而不重試。所有容器共用同一個 Linux 虛擬機核心，這不是容器逃逸評估，Docker 管理者與 gateway 仍是受信任的一方。
