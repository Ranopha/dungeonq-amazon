import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  DUNGEONQ_RESPONSE_ACTION_CATALOG,
  authorizeDungeonqResponseAction,
  computeDungeonqResponseTargetRegistryDigest,
  dungeonqResponseTargetRegistrySchema,
  evaluateDungeonqLegitimateHealth,
  evaluateDungeonqResponseAction,
  listDungeonqAutomaticActionCandidates
} from '../../packages/policy/src/dungeonq-response-action.ts';
import {
  createDungeonqResponseExecutors,
  dungeonqResponseConnectorLimits,
  openDungeonqResponseConnector
} from '../../plugins/dungeonq-host-integration/src/response-actions.ts';
import { LEGIT_CONSUMER_LIMITS, legitHealthMeasurement, startLegitConsumer } from './legit-consumer.mjs';

/*
 * DungeonQ 處置交接接線（DQ-HANDOFF-015，M3 逾時預設動作 → M5 處置連接器）。
 *
 * 用 M5 的處置連接器與合法消費者實作 M3 預留的 responseActions 注入埠：
 * - policyFacts：對象登錄表由執行環境控制帳本的事件（事件編號 → 被導流的 context）產生；次數、全域每小時數與
 *   停止狀態一律取自連接器自己的處置紀錄（policyInputState），不採用呼叫端的計數。
 * - readLegitHealth：合法消費者量測，經 evaluateDungeonqLegitimateHealth 判定後保留最近一次結果；讀不到時回報
 *   0 個樣本（政策判定為 UNKNOWN、不執行、升級），不猜測。
 * - runSafeDefault：逐一驗證 M3 交來的授權（authorizeDungeonqResponseAction，EXECUTE_A_CLASS），只接受本事件、
 *   本次觸發、且屬於政策目錄對該訊號候選動作的決策；依序交給連接器（執行前讀回、執行、執行後讀回、失敗回復並升級）。
 *   前一個動作寫入紀錄後，原決策的輸入必然與連接器紀錄不符，此時以最新紀錄重新請政策判定同一動作與對象。
 * - listIncidentActions：轉接 M5 的 responseLedger。
 * - executeDecision：管理員在事件摘要頁送出的 A 級決策（已驗證 ACK 之後，由 response-handoff.mjs 的決策處理器經政策判定後交來）。
 *   只接受通過 EXECUTE_A_CLASS 授權、屬於本事件的決策；走與逾時預設動作相同的 M5 路徑（執行前讀回、執行、讀回、失敗回復並升級）。
 *   逾時預設動作的事件閘門在已驗證 ACK 後關閉，真人決策改以「事件仍在控制帳本且未結束」為條件。
 * 對象登錄表除了被導流的 context（FLAGGED_CONTEXT），也為同一個 context 的參與者身分登錄一個帳號對象（ACCOUNT，
 * context-account:<contextId>），供結束流程第 0 步在 A-1 達上限時產生 B 級工單；處置設定檔可另外登錄不綁事件的對象（targets）。
 * 本模組不寄送任何通知；升級只寫入本機控制台告警與記憶體紀錄，寄送仍由 M3 執行環境負責。
 * 契約：docs/contracts/dungeonq-alert-handoff-v1.md、docs/contracts/dungeonq-response-actions-v1.md（「接線」一節）。
 */

export const RESPONSE_WIRING_VERSION = 'dungeonq.response-wiring/v1';
export const RESPONSE_WIRING_CONFIG_SCHEMA = 'dungeonq.response-wiring-config/v1';
export const RESPONSE_WIRING_LIMITS = Object.freeze({
  /** policyFacts、健康讀回、處置紀錄讀取、事件狀態讀取的單次時限。 */
  callTimeoutMs: 5_000,
  targetStateTimeoutMs: 10_000,
  /** 健康讀回取最近 10 秒的樣本，與連接器執行前讀回相同。 */
  healthWindowMs: dungeonqResponseConnectorLimits.preHealthWindowMs,
  /** M3 的決策超過 20 秒（連接器上限 30 秒）就不沿用，改用最新紀錄重新判定。 */
  decisionReuseMs: 20_000,
  maxAuthorizations: 8,
  maxRegistryEntries: 1_000,
  maxEscalationLog: 200,
  configMaxBytes: 4_096,
  /** 每個動作的等待上限＝兩次觀察時間＋固定餘裕；執行環境的 safeDefault 時限另外生效。 */
  actionSlackMs: 45_000,
  /** 逾時預設動作的時間預算：(候選動作數＋1 次回復觀察) × 觀察時間＋餘裕，必須小於執行環境的 safeDefault 時限。 */
  budgetSlackMs: 20_000,
  closeWaitMs: 5_000
});

const PHASES = Object.freeze(['BEFORE', 'DURING', 'AFTER']);
/** 代表被導流 context 參與者身分的帳號對象（B 級停用帳號的對象）；與 incident-close.mjs 的 CONTEXT_ACCOUNT_ASSET_PREFIX 相同。 */
export const RESPONSE_WIRING_CONTEXT_ACCOUNT_PREFIX = 'context-account:';
const MAX_STATIC_TARGETS = 32;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/u;
const contextPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const codePattern = /^[A-Za-z0-9_:.-]{1,160}$/u;

const coded = (code) => Object.assign(new Error(code), { code });
const insist = (ok, code) => {
  if (!ok) throw coded(code);
};
const codeOf = (error) => (typeof error?.code === 'string' && codePattern.test(error.code) ? error.code : 'UNEXPECTED_ERROR');
const safeReason = (value, fallback) => (typeof value === 'string' && codePattern.test(value) ? value : fallback);

/** 有時限、遵守 abort signal 的呼叫；逾時或中止時對內層發出 abort。 */
async function bounded(task, timeoutMs, signal) {
  if (signal?.aborted) throw coded('ABORTED');
  const controller = new AbortController();
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      Promise.resolve().then(() => task(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(coded('TIMEOUT')); }, timeoutMs);
        onAbort = () => { controller.abort(); reject(coded('ABORTED')); };
        signal?.addEventListener('abort', onAbort, { once: true });
      })
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

function integerIn(value, fallback, min, max, code) {
  const result = value ?? fallback;
  insist(Number.isSafeInteger(result) && result >= min && result <= max, code);
  return result;
}

/**
 * 處置設定檔可登錄的固定對象（不綁事件）：只接受識別字，種類不能是被標記類（被標記類必須綁事件，由執行環境紀錄產生）。
 * 格式由政策的登錄表綱要檢查；targetId 不能以 incident- 開頭，避免與事件對象衝突。
 */
function normalizeStaticTargets(value) {
  if (value === undefined) return Object.freeze([]);
  insist(Array.isArray(value) && value.length <= MAX_STATIC_TARGETS, 'RESPONSE_WIRING_CONFIG_INVALID');
  const entries = value.map((row) => {
    insist(row !== null && typeof row === 'object' && !Array.isArray(row)
      && Object.keys(row).every((key) => ['targetId', 'kind', 'assetId'].includes(key))
      && typeof row.targetId === 'string' && !row.targetId.startsWith('incident-'), 'RESPONSE_WIRING_CONFIG_INVALID');
    return { targetId: row.targetId, kind: row.kind, assetId: row.assetId, boundIncidentId: null };
  });
  const parsed = dungeonqResponseTargetRegistrySchema.safeParse({ registryId: 'response-wiring-config', registryVersion: 'v1', entries });
  insist(parsed.success, 'RESPONSE_WIRING_CONFIG_INVALID');
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

/** 處置設定檔內容（不含任何祕密）。缺漏的欄位用 M5 預設值；超出 M5 上限一律拒絕。 */
export function normalizeResponseWiringConfig(value) {
  insist(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => ['schemaVersion', 'observationMs', 'legitConsumer', 'targets'].includes(key))
    && value.schemaVersion === RESPONSE_WIRING_CONFIG_SCHEMA, 'RESPONSE_WIRING_CONFIG_INVALID');
  const consumer = value.legitConsumer ?? {};
  insist(consumer !== null && typeof consumer === 'object' && !Array.isArray(consumer)
    && Object.keys(consumer).every((key) => ['durationMs', 'intervalMs'].includes(key)), 'RESPONSE_WIRING_CONFIG_INVALID');
  const limits = dungeonqResponseConnectorLimits;
  return Object.freeze({
    schemaVersion: RESPONSE_WIRING_CONFIG_SCHEMA,
    observationMs: integerIn(value.observationMs, limits.defaultObservationMs, limits.minObservationMs, limits.maxObservationMs,
      'RESPONSE_WIRING_CONFIG_INVALID'),
    legitConsumer: Object.freeze({
      durationMs: integerIn(consumer.durationMs, LEGIT_CONSUMER_LIMITS.maxDurationMs, 1, LEGIT_CONSUMER_LIMITS.maxDurationMs,
        'RESPONSE_WIRING_CONFIG_INVALID'),
      intervalMs: integerIn(consumer.intervalMs, LEGIT_CONSUMER_LIMITS.defaultIntervalMs, LEGIT_CONSUMER_LIMITS.minIntervalMs,
        LEGIT_CONSUMER_LIMITS.maxIntervalMs, 'RESPONSE_WIRING_CONFIG_INVALID')
    }),
    ...(value.targets === undefined ? {} : { targets: normalizeStaticTargets(value.targets) })
  });
}

/**
 * 讀取處置設定檔。檔案必須是絕對路徑的一般檔、不是符號連結、其他使用者不可寫入、4 KB 以內。
 * 回傳 { ok: true, config } 或 { ok: false, reason }（中文原因，供啟動畫面顯示）。
 */
export function loadResponseWiringConfig(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return { ok: false, reason: '處置設定檔路徑必須是絕對路徑' };
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? '處置設定檔不存在' : error?.code === 'ELOOP' ? '處置設定檔不能是符號連結' : '處置設定檔無法開啟' };
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return { ok: false, reason: '處置設定檔不是一般檔案' };
    if (info.mode & 0o022) return { ok: false, reason: '處置設定檔可被其他使用者寫入（權限需為 0600 或 0644）' };
    if (info.size > RESPONSE_WIRING_LIMITS.configMaxBytes) return { ok: false, reason: '處置設定檔超過 4 KB' };
    let parsed;
    try { parsed = JSON.parse(readFileSync(fd, 'utf8')); } catch { return { ok: false, reason: '處置設定檔不是有效的 JSON' }; }
    try { return { ok: true, config: normalizeResponseWiringConfig(parsed) }; } catch { return { ok: false, reason: `處置設定檔格式不符（需 ${RESPONSE_WIRING_CONFIG_SCHEMA}，數值在 M5 上限內）` }; }
  } finally {
    closeSync(fd);
  }
}

/** 逾時預設動作需要的時間預算（毫秒）。 */
export function responseWiringBudgetMs(config) {
  const settings = normalizeResponseWiringConfig(config);
  const actions = DUNGEONQ_RESPONSE_ACTION_CATALOG.actions.filter((entry) => entry.ackTimeoutDefault).length;
  return (actions + 1) * settings.observationMs + RESPONSE_WIRING_LIMITS.budgetSlackMs;
}

/**
 * 合法消費者說受保護來源的業務協定（POST /business）；在配球實驗中，合法使用者的實際路徑是 gateway 的
 * ordinary context，所以把探測轉成 POST <gateway>/api/operate。這樣每次探測都經 gateway 記錄，執行環境的
 * 「ordinary 來源請求都有對應 gateway 嘗試」證據檢查仍成立；A-1 若誤封 ordinary 也會被量到。
 * 逾時預設動作不輪替憑證，取回新憑證一律回 404，消費者不會換用。
 */
export function createGatewayConsumerFetch({ gatewayOrigin, fetchImpl = fetch }) {
  insist(typeof gatewayOrigin === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(gatewayOrigin) && typeof fetchImpl === 'function',
    'GATEWAY_CONSUMER_INVALID');
  return async (url, init = {}) => {
    const target = new URL(url);
    if (target.origin !== gatewayOrigin) throw coded('GATEWAY_CONSUMER_ORIGIN_DENIED');
    if (target.pathname === '/business' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      return fetchImpl(`${gatewayOrigin}/api/operate`, {
        method: 'POST',
        headers: { authorization: init.headers?.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: body.requestId, operation: body.operation, args: body.args }),
        signal: init.signal
      });
    }
    return new Response(JSON.stringify({ error: { code: 'CREDENTIAL_ROTATION_NOT_WIRED' } }),
      { status: 404, headers: { 'content-type': 'application/json' } });
  };
}

const shortIncident = (incidentId) => (typeof incidentId === 'string' ? incidentId.slice(9, 21).toUpperCase() || '-' : '-');
const sameExecutions = (left, right) => {
  const key = (rows) => JSON.stringify((Array.isArray(rows) ? rows : []).map((row) => `${row.actionCode}\n${row.targetId}\n${row.assetId}`).sort());
  return key(left) === key(right);
};

/**
 * 開啟接線。M5 連接器在這裡開啟（紀錄目錄 0700、單一寫入鎖）；執行環境與合法消費者稍後綁定。
 * @param {object} options
 * @param {string} options.directory 處置紀錄目錄。
 * @param {{ origin: string, controlToken: string, credentialAssetId: string }} options.fileOrigin 受保護來源的處置控制端點。
 * @param {object} options.config 處置設定（normalizeResponseWiringConfig 的格式）。
 * @param {(alert: object) => void} [options.localConsole] 本機控制台告警（M3 的 createLocalConsole）。
 * @param {() => number} [options.clock]
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} [options.connectorSleep] 只供測試替換觀察等待。
 */
export function openResponseWiring({ directory, fileOrigin, config, localConsole = () => {}, clock = Date.now, connectorSleep } = {}) {
  const settings = normalizeResponseWiringConfig(config);
  insist(typeof localConsole === 'function' && typeof clock === 'function'
    && (connectorSleep === undefined || typeof connectorSleep === 'function'), 'RESPONSE_WIRING_OPTIONS_INVALID');
  const limits = RESPONSE_WIRING_LIMITS;
  const iso = () => new Date(clock()).toISOString();
  const actionTimeoutMs = 2 * settings.observationMs + limits.actionSlackMs;
  let runtime = null;
  let consumer = null;
  let consumerInfo = null;
  let consumerPhase = 'BEFORE';
  let lastHealth = null;
  let closed = false;
  const escalations = [];
  const inFlight = new Set();

  const requireRuntime = () => {
    if (runtime === null) throw coded('RESPONSE_RUNTIME_NOT_READY');
    return runtime;
  };
  // A-1 作用在執行環境 store；gateway 啟動完成前沒有 store，呼叫一律明確失敗。
  const runtimeFence = {
    fence: (input) => requireRuntime().store.fence(input),
    snapshot: () => requireRuntime().store.snapshot()
  };

  /**
   * 對象登錄表：每個控制帳本事件綁定它被導流的 context（FLAGGED_CONTEXT）與該 context 的參與者帳號（ACCOUNT）；
   * 另加處置設定檔的固定對象。由執行環境紀錄與設定檔決定，不由請求決定。
   */
  const staticTargets = settings.targets ?? [];
  const registry = () => {
    let rows = [];
    if (runtime !== null) {
      try { rows = runtime.incidents(); } catch { rows = []; }
    }
    const seen = new Set();
    const entries = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const incidentId = row?.incidentId;
      const contextId = row?.contextId;
      if (typeof incidentId !== 'string' || !identifierPattern.test(incidentId) || seen.has(incidentId)) continue;
      if (typeof contextId !== 'string' || !contextPattern.test(contextId) || contextId === 'ordinary') continue;
      seen.add(incidentId);
      entries.push({ targetId: `${incidentId}/flagged-context`, kind: 'FLAGGED_CONTEXT', assetId: `context:${contextId}`, boundIncidentId: incidentId });
      entries.push({ targetId: `${incidentId}/context-account`, kind: 'ACCOUNT', assetId: `${RESPONSE_WIRING_CONTEXT_ACCOUNT_PREFIX}${contextId}`,
        boundIncidentId: incidentId });
    }
    for (const entry of staticTargets) entries.push({ ...entry });
    entries.sort((left, right) => (left.targetId < right.targetId ? -1 : left.targetId > right.targetId ? 1 : 0));
    return { registryId: 'dungeonq-pitching-incidents', registryVersion: 'v1', entries: entries.slice(0, limits.maxRegistryEntries) };
  };

  /** 合法消費者量測；沒有消費者時回報 0 個樣本，政策判定為 UNKNOWN。 */
  const measure = async ({ sinceMs, signal }) => {
    const current = consumer;
    if (current === null) return legitHealthMeasurement([], { sinceMs, measuredAtMs: clock() });
    return bounded(() => current.measure({ sinceMs }), limits.callTimeoutMs, signal);
  };

  const raise = (alert) => {
    const entry = {
      source: alert.source, priority: alert.priority === 'CRITICAL' ? 'CRITICAL' : 'HIGH', incidentId: alert.incidentId ?? null,
      reason: safeReason(alert.reason, 'unspecified'), actionCode: alert.actionCode ?? null, targetId: alert.targetId ?? null,
      decisionDigest: alert.decisionDigest ?? null, at: alert.at ?? iso()
    };
    if (escalations.length < limits.maxEscalationLog) escalations.push(entry);
    try {
      localConsole({ level: entry.priority, reason: `RESPONSE_${entry.source}`, incidentId: entry.incidentId,
        message: `事件 ${shortIncident(entry.incidentId)} 的自動處置需要人處理（${entry.priority === 'CRITICAL' ? '最高優先' : '高'}）：${entry.reason}；`
          + `動作 ${entry.actionCode ?? '-'}。請在這台 Mac 查看事件摘要與處置紀錄。` });
    } catch { /* 本機顯示失敗不影響紀錄。 */ }
  };

  const connector = openDungeonqResponseConnector({
    directory,
    registry,
    executors: createDungeonqResponseExecutors({ runtimeFence, fileOrigin }),
    health: { measure },
    // M5 的「升級給人」：只寫本機最高優先告警與紀錄；不寄送（寄送與重送屬 M3）。
    escalate: async (escalation) => raise({ source: 'CONNECTOR', ...escalation }),
    clock,
    observationMs: settings.observationMs,
    ...(connectorSleep ? { sleep: connectorSleep } : {})
  });

  const ensureUsable = (signal) => {
    insist(!closed, 'RESPONSE_WIRING_CLOSED');
    insist(signal === undefined || signal instanceof AbortSignal, 'SIGNAL_INVALID');
    if (signal?.aborted) throw coded('ABORTED');
  };

  const advancePhase = async (next) => {
    const current = consumer;
    if (current === null || PHASES.indexOf(next) <= PHASES.indexOf(consumerPhase)) return;
    try {
      await bounded(() => current.setPhase(next), limits.callTimeoutMs);
      consumerPhase = next;
    } catch { /* 階段只影響報告分段，不影響判定。 */ }
  };

  const readLegitHealth = async ({ signal } = {}) => {
    ensureUsable(signal);
    const now = clock();
    let measurement;
    try {
      measurement = await measure({ sinceMs: now - limits.healthWindowMs, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      measurement = legitHealthMeasurement([], { sinceMs: now, measuredAtMs: clock() });
    }
    const verdict = evaluateDungeonqLegitimateHealth(measurement, iso());
    lastHealth = { status: verdict.status, reason: verdict.reason, measuredAt: measurement?.measuredAt ?? null, sampleCount: measurement?.sampleCount ?? 0 };
    return measurement;
  };

  const readGate = async (incidentId, signal) => {
    const gate = requireRuntime().incidentGate;
    if (gate === null) return { open: true, reason: 'gate_not_configured' };
    try {
      const value = await bounded((inner) => gate({ incidentId, signal: inner }), limits.callTimeoutMs, signal);
      return value?.open === true ? { open: true, reason: 'open' } : { open: false, reason: safeReason(value?.reason, 'incident_not_open') };
    } catch (error) {
      return { open: false, reason: `incident_state_unavailable:${codeOf(error)}` };
    }
  };

  /** 只接受本事件、本次觸發、屬於政策目錄候選動作、且通過 EXECUTE_A_CLASS 驗證的授權；任何一筆不符整批拒絕。 */
  const verifyBatch = ({ incidentId, trigger, authorizations }) => {
    if (typeof incidentId !== 'string' || !identifierPattern.test(incidentId) || trigger === null || typeof trigger !== 'object'
      || typeof trigger.kind !== 'string' || typeof trigger.eventId !== 'string') return { ok: false, reason: 'request_invalid' };
    if (!Array.isArray(authorizations) || authorizations.length === 0 || authorizations.length > limits.maxAuthorizations) {
      return { ok: false, reason: 'authorizations_invalid' };
    }
    let candidates;
    try { candidates = new Set(listDungeonqAutomaticActionCandidates(trigger.kind).map((entry) => entry.code)); } catch { candidates = new Set(); }
    const seen = new Set();
    const verified = [];
    for (const item of authorizations) {
      const decision = item?.decision;
      const request = { incidentId, actionCode: decision?.actionCode, targetId: decision?.target?.targetId };
      const authorization = authorizeDungeonqResponseAction({ decision, input: item?.input, request, purpose: 'EXECUTE_A_CLASS' });
      if (!authorization.authorized) return { ok: false, reason: `authorization_rejected:${authorization.reason}` };
      const accepted = authorization.decision;
      if (accepted.signal?.kind !== trigger.kind || accepted.signal?.eventId !== trigger.eventId) return { ok: false, reason: 'authorization_signal_mismatch' };
      if (!candidates.has(accepted.actionCode)) return { ok: false, reason: 'authorization_action_not_candidate' };
      if (seen.has(accepted.actionCode)) return { ok: false, reason: 'authorization_duplicate_action' };
      seen.add(accepted.actionCode);
      verified.push({ decision: accepted, input: structuredClone(item.input),
        request: { incidentId, actionCode: accepted.actionCode, targetId: accepted.target.targetId } });
    }
    return { ok: true, verified };
  };

  /**
   * 連接器只接受與自己紀錄完全一致的政策輸入。原決策仍新、紀錄沒變時直接沿用；否則（例如前一個動作已寫入紀錄）
   * 用最新紀錄、登錄表與健康量測重新請政策判定同一事件、訊號、動作與對象。重新判定的結果照樣交給連接器驗證；
   * 不是 ALLOW 時由連接器拒絕、稽核並履行升級義務。
   */
  const prepare = async (item, signal) => {
    const original = item.input;
    const recorded = connector.policyInputState({ incidentId: item.request.incidentId, evaluatedAt: original.evaluatedAt });
    const currentRegistry = registry();
    const age = clock() - Date.parse(original.evaluatedAt);
    const reusable = age >= 0 && age <= limits.decisionReuseMs
      && computeDungeonqResponseTargetRegistryDigest(currentRegistry) === item.decision.registryDigest
      && sameExecutions(recorded.incidentExecutions, original.incidentExecutions)
      && recorded.globalAutomaticExecutionsLastHour === original.globalAutomaticExecutionsLastHour
      && recorded.incidentAutomationHalted === original.incidentAutomationHalted;
    if (reusable) return { decision: item.decision, input: original, refreshed: false };
    const legitimateHealth = await readLegitHealth({ signal });
    const evaluatedAt = iso();
    const input = { ...original, evaluatedAt, targetRegistry: currentRegistry,
      ...connector.policyInputState({ incidentId: item.request.incidentId, evaluatedAt }), legitimateHealth };
    return { decision: evaluateDungeonqResponseAction(input), input, refreshed: true };
  };

  const track = (promise) => {
    inFlight.add(promise);
    promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise));
    return promise;
  };

  const runSafeDefault = async ({ incidentId, trigger, authorizations, signal } = {}) => {
    ensureUsable(signal);
    requireRuntime();
    const batch = verifyBatch({ incidentId, trigger, authorizations });
    if (!batch.ok) {
      raise({ source: 'WIRING', priority: 'CRITICAL', incidentId: typeof incidentId === 'string' ? incidentId : null, reason: batch.reason });
      return { effective: false, actions: [], reason: batch.reason };
    }
    const actions = [];
    let stopReason = null;
    await advancePhase('DURING');
    try {
      for (const item of batch.verified) {
        if (signal?.aborted) { stopReason = 'aborted'; break; }
        const entry = (status, readback, reason, extra = {}) => ({ actionCode: item.request.actionCode, targetId: item.request.targetId,
          status, readback, recordedAt: iso(), reason, ...extra });
        // 真人已經以已驗證身分 ACK、或事件已結束：不再執行後續動作（M3 已取消逾時；這裡防止動作之間的空窗）。
        const gate = await readGate(incidentId, signal);
        if (!gate.open) { stopReason = `incident_not_open:${gate.reason}`; break; }
        let prepared;
        try {
          prepared = await prepare(item, signal);
        } catch (error) {
          actions.push(entry('REJECTED', null, `prepare_failed:${codeOf(error)}`));
          stopReason = 'prepare_failed';
          break;
        }
        let expectedState;
        try {
          expectedState = await bounded(() => connector.readTargetState(item.request), limits.targetStateTimeoutMs, signal);
        } catch (error) {
          actions.push(entry('REJECTED', null, `target_state_unreadable:${codeOf(error)}`, { decisionDigest: prepared.decision.decisionDigest }));
          stopReason = 'target_state_unreadable';
          break;
        }
        let result;
        try {
          // 連接器內部每個外部呼叫都有時限；這裡另設總時限並遵守 abort。中止時不再等待，但不會重送。
          result = await bounded(() => track(connector.execute({ decision: prepared.decision, input: prepared.input, request: item.request, expectedState })),
            actionTimeoutMs, signal);
        } catch (error) {
          actions.push(entry('UNKNOWN', 'UNKNOWN', `execute_${codeOf(error).toLowerCase()}`, { decisionDigest: prepared.decision.decisionDigest }));
          stopReason = 'execute_unknown';
          break;
        }
        actions.push(entry(result.status, result.readback ?? 'UNKNOWN', result.reason,
          { decisionDigest: prepared.decision.decisionDigest, refreshed: prepared.refreshed, escalation: result.escalation ?? null }));
        if (result.status !== 'EXECUTED' || result.readback !== 'CONFIRMED') { stopReason = `action_${String(result.status).toLowerCase()}`; break; }
      }
    } finally {
      await advancePhase('AFTER');
    }
    for (const item of batch.verified.slice(actions.length)) {
      actions.push({ actionCode: item.request.actionCode, targetId: item.request.targetId, status: 'NOT_ATTEMPTED', readback: 'UNKNOWN',
        recordedAt: iso(), reason: stopReason ?? 'not_attempted' });
    }
    const effective = stopReason === null && actions.length === batch.verified.length
      && actions.every((action) => action.status === 'EXECUTED' && action.readback === 'CONFIRMED');
    return { effective, actions, ...(stopReason ? { reason: stopReason } : {}) };
  };

  /** 真人決策的事件條件：事件仍在控制帳本且未結束（已驗證 ACK 不影響）。讀不到一律視為不可執行。 */
  const humanGate = (incidentId) => {
    let rows;
    try { rows = requireRuntime().incidents(); } catch { return { open: false, reason: 'incident_state_unavailable' }; }
    const row = (Array.isArray(rows) ? rows : []).find((item) => item?.incidentId === incidentId);
    if (!row) return { open: false, reason: 'incident_unknown' };
    if (row.resolution !== null && row.resolution !== undefined) return { open: false, reason: 'incident_resolved' };
    return { open: true, reason: 'open' };
  };

  /**
   * 管理員在摘要頁送出的 A 級決策。只接受本事件、通過 EXECUTE_A_CLASS 授權的單一決策；經同一條 M5 路徑執行並讀回。
   * 回傳 { status, readback, reason, decisionDigest?, refreshed?, recordedAt, escalation? }；status 為 REJECTED 時沒有執行任何動作。
   */
  const executeDecision = async ({ incidentId, decision, input, signal } = {}) => {
    ensureUsable(signal);
    requireRuntime();
    const rejected = (reason) => ({ status: 'REJECTED', readback: null, reason, recordedAt: iso() });
    if (typeof incidentId !== 'string' || !identifierPattern.test(incidentId)) return rejected('request_invalid');
    const request = { incidentId, actionCode: decision?.actionCode, targetId: decision?.target?.targetId };
    const authorization = authorizeDungeonqResponseAction({ decision, input, request, purpose: 'EXECUTE_A_CLASS' });
    if (!authorization.authorized) {
      raise({ source: 'WIRING', priority: 'HIGH', incidentId, reason: `human_decision_rejected:${authorization.reason}` });
      return rejected(`authorization_rejected:${authorization.reason}`);
    }
    const gate = humanGate(incidentId);
    if (!gate.open) return rejected(`incident_not_open:${gate.reason}`);
    const accepted = authorization.decision;
    const item = { decision: accepted, input: structuredClone(input),
      request: { incidentId, actionCode: accepted.actionCode, targetId: accepted.target.targetId } };
    // 管理員常會連續送出幾個決策：第一個動作開始時進入「處置中」，之後的決策都留在處置中；
    // 「處置後」由 settleResponse（結束流程開始時，或呼叫端確認處置告一段落）標記，避免後一個動作的影響被算進處置後。
    await advancePhase('DURING');
    let prepared;
    try { prepared = await prepare(item, signal); } catch (error) { return rejected(`prepare_failed:${codeOf(error)}`); }
    let expectedState;
    try {
      expectedState = await bounded(() => connector.readTargetState(item.request), limits.targetStateTimeoutMs, signal);
    } catch (error) {
      return { ...rejected(`target_state_unreadable:${codeOf(error)}`), decisionDigest: prepared.decision.decisionDigest };
    }
    let result;
    try {
      result = await bounded(() => track(connector.execute({ decision: prepared.decision, input: prepared.input, request: item.request, expectedState })),
        actionTimeoutMs, signal);
    } catch (error) {
      // 結果不明：不重送；連接器已記錄並停止本事件的自動處置。
      return { status: 'UNKNOWN', readback: 'UNKNOWN', reason: `execute_${codeOf(error).toLowerCase()}`, decisionDigest: prepared.decision.decisionDigest,
        recordedAt: iso() };
    }
    return { status: result.status, readback: result.readback ?? 'UNKNOWN', reason: safeReason(result.reason, 'unspecified'),
      decisionDigest: prepared.decision.decisionDigest, refreshed: prepared.refreshed, recordedAt: iso(), escalation: result.escalation ?? null };
  };

  const listIncidentActions = async ({ incidentId, signal } = {}) => {
    ensureUsable(signal);
    return bounded((inner) => connector.responseLedger.listIncidentActions({ incidentId, signal: inner }), limits.callTimeoutMs, signal);
  };

  const policyFacts = async ({ incidentId, signal } = {}) => {
    ensureUsable(signal);
    requireRuntime();
    return { targetRegistry: registry(), ...connector.policyInputState({ incidentId, evaluatedAt: iso() }) };
  };

  /**
   * M7 結束流程（由人在摘要頁啟動，或由協調者在沒有 ACK 的情境啟動）第 0 步用的連接器介面。
   * 與 M5 同一個連接器：協調器自己請政策判定，連接器再以 EXECUTE_A_CLASS 驗證決策、執行前讀回、執行、讀回、失敗回復並升級；
   * 政策拒絕時連接器照樣履行拒絕稽核與升級義務。這裡另外要求事件仍在控制帳本且未結束（與真人決策相同的條件），
   * 並設總時限、遵守接線關閉；不自行決定任何動作。結束流程開始前已由 settleResponse 標記「處置後」，這裡不再改階段。
   */
  const closeConnector = Object.freeze({
    policyInputState: (args) => connector.policyInputState(args),
    readTargetState: (request) => bounded(() => connector.readTargetState(request), limits.targetStateTimeoutMs),
    execute: async ({ decision, input, request, expectedState } = {}) => {
      ensureUsable();
      requireRuntime();
      const gate = humanGate(request?.incidentId);
      if (!gate.open) return { status: 'REJECTED', readback: null, reason: `incident_not_open:${gate.reason}` };
      return bounded(() => track(connector.execute({ decision, input, request, expectedState })), actionTimeoutMs);
    },
    incidentStatus: (incidentId) => connector.incidentStatus(incidentId),
    listAudit: (args) => connector.listAudit(args)
  });

  const wiring = {
    /** M3 的 responseActions 注入埠。 */
    port: Object.freeze({ policyFacts, readLegitHealth, runSafeDefault, listIncidentActions, executeDecision }),
    /** M7 結束流程第 0 步的連接器介面（見 closeConnector）。 */
    closeConnector,
    /**
     * 目前掛上的合成合法消費者（measure、setPhase、report、stop）；沒有時回 null。
     * 只給 M7 結束流程第 0 步停止量測消費者（incident-local-ports.mjs 的 createLegitConsumerPort）與演練收集報告。
     */
    legitConsumer: () => consumer,
    /**
     * 標記「處置後」：管理員的處置告一段落（M7 結束流程開始時由啟動器呼叫；演練的腳本管理員送完決策後呼叫）。
     * 階段只能往後，只影響合法消費者報告的分段，不影響任何判定。
     */
    settleResponse: () => advancePhase('AFTER'),
    settings,
    /**
     * 包住 M3 的 createSafeDefaultExecutor。gateway 尚未就緒（例如重啟時處理已過期的階段）或接線已關閉時，
     * 不執行、回報拒絕原因；執行環境會改發本機最高優先告警，且同一階段不重跑。
     */
    guard(executor) {
      insist(typeof executor === 'function', 'RESPONSE_WIRING_EXECUTOR_INVALID');
      return async (args) => {
        if (closed) return { outcome: 'DENIED', reason: 'response_wiring_closed', decisions: [] };
        if (runtime === null) return { outcome: 'DENIED', reason: 'response_runtime_not_ready', decisions: [] };
        return executor(args);
      };
    },
    /**
     * 綁定執行環境：incidents() 回傳控制帳本事件（incidentId、contextId）；store 提供 fence／snapshot；
     * incidentGate({incidentId,signal}) 回傳 { open, reason }（已驗證 ACK 或事件結束時 open=false）。
     */
    bindRuntime({ incidents, store, incidentGate = null }) {
      insist(!closed && runtime === null, 'RESPONSE_RUNTIME_ALREADY_BOUND');
      insist(typeof incidents === 'function' && store && typeof store.fence === 'function' && typeof store.snapshot === 'function'
        && (incidentGate === null || typeof incidentGate === 'function'), 'RESPONSE_RUNTIME_INVALID');
      runtime = { incidents, store, incidentGate };
    },
    /** 以 gateway 的 ordinary context 啟動合成合法消費者（同程序，有最長時間與樣本上限）。 */
    startGatewayConsumer({ gatewayOrigin, ordinaryToken, fetchImpl = fetch }) {
      insist(!closed && consumer === null, 'LEGIT_CONSUMER_ALREADY_RUNNING');
      const started = startLegitConsumer({
        origin: gatewayOrigin, consumerId: 'pitching-ordinary', bindingToken: randomBytes(32).toString('base64url'),
        credential: ordinaryToken, probe: { operation: 'snapshot' }, durationMs: settings.legitConsumer.durationMs,
        intervalMs: settings.legitConsumer.intervalMs, fetchImpl: createGatewayConsumerFetch({ gatewayOrigin, fetchImpl }),
        onEscalate: (escalation) => raise({ source: 'LEGIT_CONSUMER', priority: 'HIGH', reason: escalation.reason })
      });
      consumer = {
        measure: async ({ sinceMs }) => started.measure({ sinceMs }),
        setPhase: async (phase) => started.setPhase(phase),
        report: async () => started.report(),
        stop: () => started.stop()
      };
      const startedAt = clock();
      consumerInfo = { mode: 'GATEWAY_ORDINARY', startedAt: new Date(startedAt).toISOString(),
        until: new Date(startedAt + settings.legitConsumer.durationMs).toISOString(), ...settings.legitConsumer };
      return consumerInfo;
    },
    /** 掛上其他形式的合法消費者（例如 forkLegitConsumer 或測試替身）：需有 measure、setPhase、stop。 */
    attachLegitConsumer(value, info = { mode: 'ATTACHED' }) {
      insist(!closed && consumer === null, 'LEGIT_CONSUMER_ALREADY_RUNNING');
      insist(value && ['measure', 'setPhase', 'stop'].every((name) => typeof value[name] === 'function'), 'LEGIT_CONSUMER_INVALID');
      consumer = value;
      consumerInfo = { ...info };
    },
    /** 唯讀檢視（啟動畫面、摘要與測試）。 */
    inspect: Object.freeze({
      describe: () => ({
        version: RESPONSE_WIRING_VERSION, observationMs: settings.observationMs, legitConsumer: consumerInfo,
        timeoutActions: DUNGEONQ_RESPONSE_ACTION_CATALOG.actions.filter((entry) => entry.ackTimeoutDefault)
          .map((entry) => ({ code: entry.code, name: entry.name }))
      }),
      escalations: () => escalations.map((entry) => ({ ...entry })),
      lastHealth: () => (lastHealth ? { ...lastHealth } : null),
      consumerReport: async () => (consumer && typeof consumer.report === 'function' ? bounded(() => consumer.report(), limits.callTimeoutMs) : null),
      consumerMeasure: async ({ sinceMs }) => measure({ sinceMs }),
      incidentStatus: (incidentId) => connector.incidentStatus(incidentId),
      listAudit: (args) => connector.listAudit(args),
      registry
    }),
    /** 停止合法消費者、關閉連接器（中止觀察等待；進行中的動作由連接器記為結果不明並停止自動處置）。 */
    async close() {
      if (closed) return;
      closed = true;
      try { if (consumer) await bounded(() => consumer.stop(), limits.closeWaitMs); } catch { /* 子程序有自己的停止上限。 */ }
      connector.close();
      await bounded(() => Promise.allSettled([...inFlight]), limits.closeWaitMs).catch(() => undefined);
    }
  };
  return wiring;
}
