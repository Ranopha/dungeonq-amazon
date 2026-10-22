// DQ-HANDOFF-015 M3：告警交接——主／備援管道切換、持久升級計時器、已驗證 ACK、事件摘要與量測口徑。
// 管理員決策（計畫 6.1 的 t6）：已驗證 ACK 的會話在摘要頁送出決策；本模組只驗證會話、Origin 與單次決策權杖、記錄 t6，
// 再交給主機注入的處理器（decision）。本模組不呼叫處置連接器、工單或結束流程。
// 本模組只由可信組裝（runtime/server.mjs）開啟；參與者介面無法建立、讀取或改變任何一列。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { openAuxiliary } from './auxiliary.mjs';
import { runtimeCheck as check, runtimeEnvelope as envelope, runtimeId as identifier,
  runtimeInteger as integer, runtimeJson } from './contracts.mjs';
import { verifyPassword } from '../server/passwords.mjs';
import { matchOtp } from '../server/totp.mjs';

export const PITCH_HANDOFF_VERSION = 'dungeonq.pitch-handoff/v1';
export const PITCH_HANDOFF_CLOSURE_REASONS = Object.freeze(['AUTO_SAFE_DEFAULT']);
export const PITCH_HANDOFF_PREFIXES = Object.freeze({ TEST: '[DungeonQ 測試告警]', ALERT: '[DungeonQ 告警]' });
/** D5 時間表與所有會重複執行的上限。新目錄可調整；既有目錄改設定一律拒絕（HANDOFF_CONFIG_CHANGED）。 */
export const PITCH_HANDOFF_DEFAULTS = Object.freeze({
  stage2Ms: 120000, stage3Ms: 300000, stage4Ms: 600000,
  channelTimeoutMs: 10000, stageRetryMax: 2, stageRetryBaseMs: 15000,
  channelDailyLimit: 40, channelUnavailableMs: 86400000,
  ackLinkTtlMs: 3600000, ackSessionTtlMs: 900000, ackMaxFailuresPerLink: 5,
  ackMaxFailuresPerWindow: 10, ackFailureWindowMs: 900000, maxLinksPerIncident: 32,
  selfCheckIntervalMs: 86400000, inboxIntervalMs: 10000, inboxWindowMs: 600000,
  safeDefaultTimeoutMs: 60000, summaryTimeoutMs: 5000, maxIncidents: 256, maxDeliveries: 4096, maxEvents: 20000
});
const BOUNDS = Object.freeze({
  stage2Ms: [1000, 86400000], stage3Ms: [1000, 86400000], stage4Ms: [1000, 86400000],
  channelTimeoutMs: [100, 30000], stageRetryMax: [0, 2], stageRetryBaseMs: [100, 3600000],
  channelDailyLimit: [1, 500], channelUnavailableMs: [1000, 2678400000],
  ackLinkTtlMs: [60000, 86400000], ackSessionTtlMs: [60000, 3600000], ackMaxFailuresPerLink: [1, 10],
  ackMaxFailuresPerWindow: [1, 100], ackFailureWindowMs: [1000, 86400000], maxLinksPerIncident: [1, 64],
  selfCheckIntervalMs: [3600000, 2678400000], inboxIntervalMs: [1000, 60000], inboxWindowMs: [10000, 3600000],
  safeDefaultTimeoutMs: [1000, 300000], summaryTimeoutMs: [100, 30000], maxIncidents: [1, 1024],
  maxDeliveries: [16, 65536], maxEvents: [64, 200000]
});
/**
 * 管理員決策的上限（不寫入交接設定，既有目錄不受影響）：決策權杖 5 分鐘且不超過會話期限、單次使用；
 * 每事件最多 20 個決策、同時只處理一個；主機處理器最長 15 分鐘，逾時記結果不明且不重跑；送出後最多等 2.5 秒就先回覆。
 */
export const PITCH_HANDOFF_DECISION_LIMITS = Object.freeze({ tokenTtlMs: 300000, maxTokens: 256, maxDecisionsPerIncident: 20,
  handlerTimeoutMs: 900000, waitMs: 2500, maxRequestBytes: 16384, maxListed: 20 });
export const PITCH_HANDOFF_DECISION_KINDS = Object.freeze(['EXECUTE_A_CLASS', 'CREATE_WORK_ORDER', 'START_CLOSE']);
const DECISION_OUTCOMES = Object.freeze(['EXECUTED', 'NOT_EFFECTIVE', 'WORK_ORDER_CREATED', 'WORK_ORDER_EXISTS', 'CLOSED', 'CLOSE_HALTED',
  'REJECTED', 'FAILED', 'UNKNOWN']);
const DECISION_TARGET = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const DECISION_ID = /^decision-[a-f0-9-]{36}$/u;
const ROLES = ['PRIMARY', 'FALLBACK'];
const SEND_STATES = ['ACCEPTED', 'RETRY', 'FAILED', 'UNKNOWN', 'QUOTA'];
const SCHEMA = [
  'CREATE TABLE handoff_meta (id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL,created_at INTEGER NOT NULL,disabled_at INTEGER,disabled_reason TEXT,self_check_at INTEGER,self_check_next INTEGER,dropped_events INTEGER NOT NULL,last_event_digest TEXT NOT NULL) STRICT',
  'CREATE TABLE handoff_incidents (incident_id TEXT PRIMARY KEY,context_id TEXT NOT NULL,world_id TEXT NOT NULL,epoch INTEGER NOT NULL,armed_at INTEGER NOT NULL,t0 INTEGER NOT NULL,ack_at INTEGER,ack_account TEXT,ack_method TEXT,ack_reference TEXT,ack_synced INTEGER NOT NULL,closure_reason TEXT,closure_at INTEGER,closure_detail TEXT) STRICT',
  'CREATE TABLE handoff_stages (incident_id TEXT NOT NULL,stage INTEGER NOT NULL,due_at INTEGER NOT NULL,status TEXT NOT NULL,retries INTEGER NOT NULL,next_at INTEGER NOT NULL,fired_at INTEGER,finished_at INTEGER,result TEXT,PRIMARY KEY(incident_id,stage)) STRICT',
  'CREATE TABLE handoff_deliveries (delivery_id TEXT PRIMARY KEY,incident_id TEXT,scope TEXT NOT NULL,channel TEXT NOT NULL,attempt INTEGER NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,subject_token TEXT NOT NULL,status TEXT NOT NULL,queued_at INTEGER NOT NULL,provider_at INTEGER,receipt TEXT,inbox_status TEXT NOT NULL,inbox_deadline INTEGER,inbox_at INTEGER,inbox_observed_at INTEGER,inbox_checks INTEGER NOT NULL) STRICT',
  'CREATE TABLE handoff_channels (channel TEXT PRIMARY KEY,unavailable_until INTEGER,reason TEXT,day TEXT NOT NULL,sent_today INTEGER NOT NULL) STRICT',
  'CREATE TABLE handoff_links (handle_digest TEXT PRIMARY KEY,incident_id TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,failures INTEGER NOT NULL,used_at INTEGER) STRICT',
  'CREATE TABLE handoff_sessions (token_digest TEXT PRIMARY KEY,incident_id TEXT NOT NULL,account TEXT NOT NULL,expires_at INTEGER NOT NULL) STRICT',
  'CREATE TABLE handoff_operator (account TEXT PRIMARY KEY,last_totp_step INTEGER NOT NULL) STRICT',
  'CREATE TABLE handoff_failures (seq INTEGER PRIMARY KEY,at INTEGER NOT NULL) STRICT',
  'CREATE TABLE handoff_events (seq INTEGER PRIMARY KEY,at INTEGER NOT NULL,incident_id TEXT,kind TEXT NOT NULL,dedupe TEXT UNIQUE,detail TEXT NOT NULL,digest TEXT NOT NULL) STRICT'
].join(';');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const coded = code => Object.assign(new Error(code), { code });
const fail = code => { throw coded(code); };
const INCIDENT = /^incident-[a-f0-9]{64}$/;
const HANDLE = /^[A-Za-z0-9_-]{43}$/;
const ACCOUNT_FILE_LIMIT = 8192;
const STAGE_LABELS = Object.freeze({ 1: '第 1 階段（主管道）', 2: '第 2 階段（備援管道）', 3: '第 3 階段（最高優先，兩個管道）', 4: '第 4 階段（逾時預設安全動作）' });

function limitsFor(value = {}) {
  envelope(value, [], Object.keys(PITCH_HANDOFF_DEFAULTS));
  const limits = { ...PITCH_HANDOFF_DEFAULTS, ...value };
  for (const [key, bounds] of Object.entries(BOUNDS)) integer(limits[key], ...bounds, 'PITCH_HANDOFF_LIMITS_INVALID');
  check(limits.stage2Ms < limits.stage3Ms && limits.stage3Ms < limits.stage4Ms, 'PITCH_HANDOFF_LIMITS_INVALID');
  return Object.freeze(limits);
}

function channelsFor(notifier) {
  if (notifier === undefined || notifier === null) return [];
  check(typeof notifier === 'object' && Array.isArray(notifier.channels) && notifier.channels.length <= 2, 'PITCH_HANDOFF_NOTIFIER_INVALID');
  const channels = notifier.channels.map(channel => {
    check(channel && typeof channel === 'object' && typeof channel.name === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(channel.name)
      && ROLES.includes(channel.role) && typeof channel.send === 'function'
      && (channel.checkLogin === undefined || typeof channel.checkLogin === 'function')
      && (channel.inbox === undefined || typeof channel.inbox === 'boolean'), 'PITCH_HANDOFF_NOTIFIER_INVALID');
    return Object.freeze({ name: channel.name, role: channel.role, send: channel.send, checkLogin: channel.checkLogin, inbox: channel.inbox === true });
  });
  check(new Set(channels.map(c => c.role)).size === channels.length && new Set(channels.map(c => c.name)).size === channels.length, 'PITCH_HANDOFF_NOTIFIER_INVALID');
  return channels;
}

function base32Decode(text) {
  check(typeof text === 'string' && /^[A-Z2-7]{32,64}$/.test(text), 'ACK_ACCOUNT_INVALID');
  let bits = 0; let value = 0; const out = [];
  for (const char of text) {
    value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 255); }
  }
  return Buffer.from(out);
}

/** ACK 操作員帳號檔：絕對路徑、一般檔案、非連結、0600。內容為既有 Argon2id 密碼紀錄與選配 TOTP 種子。 */
export function loadAckAccountFile(path) {
  let descriptor;
  try {
    check(typeof path === 'string' && isAbsolute(path), 'ACK_ACCOUNT_INVALID');
    const before = lstatSync(path);
    check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && (before.mode & 0o777) === 0o600
      && before.size > 0 && before.size <= ACCOUNT_FILE_LIMIT, 'ACK_ACCOUNT_INVALID');
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    check(opened.dev === before.dev && opened.ino === before.ino && (opened.mode & 0o777) === 0o600, 'ACK_ACCOUNT_INVALID');
    const buffer = Buffer.alloc(ACCOUNT_FILE_LIMIT + 1); const size = readSync(descriptor, buffer, 0, buffer.length, 0);
    check(size > 0 && size <= ACCOUNT_FILE_LIMIT, 'ACK_ACCOUNT_INVALID');
    return ackAccount(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))));
  } catch { throw coded('ACK_ACCOUNT_INVALID'); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function ackAccount(value) {
  envelope(value, ['schemaVersion', 'operatorId', 'password', 'totp'], [], ACCOUNT_FILE_LIMIT);
  check(value.schemaVersion === 'dungeonq.ack-operator/v1' && typeof value.password === 'string' && value.password.length <= 1024, 'ACK_ACCOUNT_INVALID');
  identifier(value.operatorId, 'ACK_ACCOUNT_INVALID');
  const record = JSON.parse(value.password);
  check(record?.algorithm === 'argon2id' && record.version === 1, 'ACK_ACCOUNT_INVALID');
  const totp = value.totp === null ? null : base32Decode(value.totp);
  check(totp === null || totp.length >= 20, 'ACK_ACCOUNT_INVALID');
  return Object.freeze({ operatorId: value.operatorId, password: value.password, totp });
}

function sanitizeReceipt(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{1,255}$/.test(value) ? value : null;
}

function taipei(at) {
  if (!Number.isSafeInteger(at)) return '未知';
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(at)) + '（台北時間）';
}

/** 主機摘要只保留可公開的結構；鍵名像憑證、ticket 原值或內容的欄位一律移除，字串截短。 */
function sanitizeHostSummary(value, depth = 0) {
  if (depth > 6) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 300);
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeHostSummary(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || /token|password|secret|credential|authorization|cookie|^ticket$|handle|contents|^value$|^raw|email|address/i.test(key)) continue;
      out[key] = sanitizeHostSummary(item, depth + 1);
    }
    return out;
  }
  return null;
}

/**
 * 開啟告警交接。可信組裝注入：
 * - notifier.channels：[{ name, role:'PRIMARY'|'FALLBACK', send(message,{signal}), checkLogin?({signal}), inbox? }]
 *   send 回 { state:'ACCEPTED', receiptId } 或 { state:'RETRY'|'FAILED'|'UNKNOWN'|'QUOTA' }。
 * - safeDefault({incidentId,contextId,worldId,epoch,trigger,signal})：主機先經 Policy Engine 判定，再執行並讀回。
 * - summary({incidentId,signal})：主機摘要（M2／M5／M6 資料）。
 * - inboxProbe.find({tokens,signal})：唯讀收件匣查詢，回 { found: { token: internalDateMs } }。
 * - ackAccount：{ path } 或已解析帳號（測試）；未提供時 ACK 無法驗證。
 * - decision({incidentId,decisionId,request,actor,submittedAt,firstDecisionAt,acknowledgement,ticket,signal})：管理員決策的主機處理器
 *   （先經 Policy Engine 判定，再交給 M5／M6／M7）；回 { outcome, reason, readback, policy?, action?, workOrder?, close? }。
 */
export function openPitchHandoff({ path, clock = Date.now, limits: supplied, notifier, safeDefault, summary, inboxProbe,
  ackAccount: accountSource, prefix = 'TEST', selfCheck = 'LOGIN', localConsole, isClosed, ticketSummary,
  onAcknowledged, decision, schedule = true } = {}) {
  check(typeof path === 'string' && isAbsolute(path), 'STORAGE_PATH_INVALID');
  check(typeof clock === 'function', 'CLOCK_INVALID');
  const limits = limitsFor(supplied);
  const channels = channelsFor(notifier);
  for (const fn of [safeDefault, summary, localConsole, isClosed, ticketSummary, onAcknowledged, decision])
    check(fn === undefined || typeof fn === 'function', 'PITCH_HANDOFF_INVALID');
  check(inboxProbe === undefined || typeof inboxProbe?.find === 'function', 'PITCH_HANDOFF_INVALID');
  check(Object.hasOwn(PITCH_HANDOFF_PREFIXES, prefix) && ['NONE', 'LOGIN', 'SEND'].includes(selfCheck), 'PITCH_HANDOFF_INVALID');
  check(accountSource === undefined || accountSource?.path !== undefined || accountSource?.operatorId !== undefined, 'PITCH_HANDOFF_INVALID');
  const now = () => integer(clock(), 0, Number.MAX_SAFE_INTEGER - 86400000 * 400, 'CLOCK_INVALID');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  check(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o022) === 0, 'STORAGE_DIRECTORY_INVALID');
  const db = openAuxiliary(path, SCHEMA, 'handoff_meta');
  const config = JSON.stringify({ version: PITCH_HANDOFF_VERSION, limits, prefix, selfCheck,
    channels: channels.map(({ name, role, inbox }) => ({ name, role, inbox })) });
  let closed = false; let origin = null; let timer; let wake = 0; const running = new Set(); const aborter = new AbortController();
  const transact = action => {
    check(!closed, 'PITCH_HANDOFF_CLOSED'); db.exec('BEGIN IMMEDIATE');
    try { const result = action(now()); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  try {
    db.exec('PRAGMA wal_autocheckpoint=64; PRAGMA journal_size_limit=1048576;');
    const meta = db.prepare('SELECT config FROM handoff_meta WHERE id=1').get();
    if (!meta) db.prepare('INSERT INTO handoff_meta VALUES(1,?,?,NULL,NULL,NULL,NULL,0,?)').run(config, now(), 'ROOT');
    else check(meta.config === config, 'HANDOFF_CONFIG_CHANGED');
    // A previous process may have died mid-send or mid-stage. Its outcome is UNKNOWN; nothing is re-sent or re-run.
    const at = now();
    db.prepare("UPDATE handoff_deliveries SET status='UNKNOWN' WHERE status='SENDING'").run();
    for (const row of db.prepare("SELECT incident_id,stage FROM handoff_stages WHERE status='FIRING'").all()) {
      db.prepare("UPDATE handoff_stages SET status='UNKNOWN',finished_at=?,result=? WHERE incident_id=? AND stage=?")
        .run(at, JSON.stringify({ reason: 'INTERRUPTED_BY_RESTART' }), row.incident_id, row.stage);
    }
  } catch (error) { db.close(); throw error; }

  /* ---------------- 事件紀錄（只追加，同機自證的雜湊鏈） ---------------- */
  function event(kind, incidentId, detail = {}, dedupe = null) {
    check(/^[A-Z][A-Z0-9_]{0,63}$/.test(kind), 'PITCH_HANDOFF_EVENT_INVALID');
    const json = JSON.stringify(detail); check(Buffer.byteLength(json) <= 4096, 'PITCH_HANDOFF_EVENT_INVALID');
    if (dedupe && db.prepare('SELECT 1 FROM handoff_events WHERE dedupe=?').get(dedupe)) return false;
    const meta = db.prepare('SELECT last_event_digest,dropped_events FROM handoff_meta WHERE id=1').get();
    if (db.prepare('SELECT count(*) AS n FROM handoff_events').get().n >= limits.maxEvents) {
      db.prepare('UPDATE handoff_meta SET dropped_events=dropped_events+1 WHERE id=1').run(); return false;
    }
    const at = now(); const digest = sha256(JSON.stringify([meta.last_event_digest, at, incidentId ?? null, kind, json]));
    db.prepare('INSERT INTO handoff_events(at,incident_id,kind,dedupe,detail,digest) VALUES(?,?,?,?,?,?)').run(at, incidentId ?? null, kind, dedupe, json, digest);
    db.prepare('UPDATE handoff_meta SET last_event_digest=? WHERE id=1').run(digest);
    return true;
  }
  const record = (...args) => { try { return transact(() => event(...args)); } catch { return false; } };
  function raiseLocal(alert) {
    record('LOCAL_CONSOLE_ALERT', alert.incidentId ?? null, { level: alert.level, reason: alert.reason, stage: alert.stage ?? null });
    try { (localConsole ?? defaultConsole)({ ...alert, at: now() }); } catch { /* 本機告警顯示失敗不影響事件紀錄。 */ }
  }
  function defaultConsole(alert) {
    process.stderr.write(`\n!!! [DungeonQ ${alert.level === 'CRITICAL' ? '最高優先告警' : '告警'}] ${alert.message}${alert.ackLink ? `\n    ACK 連結（只限本機開啟）：${alert.ackLink}` : ''}\n`);
  }

  /* ---------------- 事件狀態 ---------------- */
  const disabled = () => db.prepare('SELECT disabled_at FROM handoff_meta WHERE id=1').get().disabled_at !== null;
  const incidentRow = incidentId => db.prepare('SELECT * FROM handoff_incidents WHERE incident_id=?').get(incidentId);
  function arm(incident) {
    check(incident && INCIDENT.test(incident.incidentId ?? ''), 'PITCH_HANDOFF_INCIDENT_INVALID');
    identifier(incident.contextId); identifier(incident.worldId); integer(incident.epoch, 1, Number.MAX_SAFE_INTEGER);
    const result = transact(at => {
      const existing = incidentRow(incident.incidentId);
      if (existing) return { armed: false, t0: existing.t0 };
      check(db.prepare('SELECT count(*) AS n FROM handoff_incidents').get().n < limits.maxIncidents, 'PITCH_HANDOFF_CAPACITY');
      // T0 is the entry time recorded by the control ledger; a late arm never restarts the clock.
      const t0 = Number.isSafeInteger(incident.enteredAt) && incident.enteredAt <= at ? incident.enteredAt : at;
      db.prepare('INSERT INTO handoff_incidents VALUES(?,?,?,?,?,?,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL)')
        .run(incident.incidentId, incident.contextId, incident.worldId, incident.epoch, at, t0);
      for (const [stage, offset] of [[2, limits.stage2Ms], [3, limits.stage3Ms], [4, limits.stage4Ms]])
        db.prepare("INSERT INTO handoff_stages VALUES(?,?,?,'PENDING',0,?,NULL,NULL,NULL)").run(incident.incidentId, stage, t0 + offset, t0 + offset);
      event('ESCALATION_ARMED', incident.incidentId, { t0, dueAt: { 2: t0 + limits.stage2Ms, 3: t0 + limits.stage3Ms, 4: t0 + limits.stage4Ms } });
      return { armed: true, t0 };
    });
    if (result.armed) reschedule();
    return result;
  }
  function cancelStages(incidentId, reason) {
    const changed = db.prepare("UPDATE handoff_stages SET status='CANCELLED',finished_at=?,result=? WHERE incident_id=? AND status IN ('PENDING','RETRY_WAIT')")
      .run(now(), JSON.stringify({ reason }), incidentId).changes;
    if (changed > 0) event('ESCALATION_CANCELLED', incidentId, { reason, stages: changed });
    return changed;
  }

  /* ---------------- ACK 連結 ---------------- */
  function mintLink(incidentId) {
    check(INCIDENT.test(incidentId ?? ''), 'PITCH_HANDOFF_INCIDENT_INVALID');
    if (!origin) return null;
    return transact(at => {
      const row = incidentRow(incidentId); check(row, 'PITCH_HANDOFF_INCIDENT_UNKNOWN');
      if (row.ack_at !== null) return null;
      const count = db.prepare('SELECT count(*) AS n FROM handoff_links WHERE incident_id=?').get(incidentId).n;
      if (count >= limits.maxLinksPerIncident) return null;
      const handle = randomBytes(32).toString('base64url');
      db.prepare("INSERT INTO handoff_links VALUES(?,?,?,?,'ACTIVE',0,NULL)").run(sha256(`dungeonq.ack-link/v1\0${handle}`), incidentId, at, at + limits.ackLinkTtlMs);
      return { link: `${origin}/ack/${incidentId}/${handle}`, expiresAt: at + limits.ackLinkTtlMs };
    });
  }

  const safeLink = incidentId => { try { return incidentId ? mintLink(incidentId) : null; } catch { return null; } };

  /* ---------------- 訊息 ---------------- */
  const shortId = incidentId => incidentId.slice(9, 21).toUpperCase();
  function compose({ kind, stage, incident, link, token, update, safe }) {
    const head = PITCH_HANDOFF_PREFIXES[prefix];
    const id = shortId(incident.incident_id ?? incident.incidentId);
    const subjects = {
      ENTRY: `${head} 事件 ${id} 已進入隔離場景（第 1 階段）`,
      STAGE2: `${head} 第 2 階段：事件 ${id} 尚未確認（備援管道）`,
      STAGE3: `${head}【最高優先】第 3 階段：事件 ${id} 仍未確認`,
      STAGE4: `${head} 第 4 階段：事件 ${id} 已執行逾時預設安全動作`,
      TICKET: `${head} 錯誤 ticket 使用更新：事件 ${id}（第 ${update?.ordinal ?? '-'} 封${update?.firstSpread ? '，首次擴散' : ''}）`,
      SELF_CHECK: `${head} 管道自我檢查`
    };
    const lines = [head, ''];
    if (kind === 'SELF_CHECK') lines.push('這是明確設定後才寄出的管道自我檢查，不代表有事件。');
    else {
      lines.push(`事件：${id}（完整編號 ${incident.incident_id ?? incident.incidentId}）`);
      lines.push(`階段：${STAGE_LABELS[stage] ?? '資訊更新'}`);
      const t0 = incident.t0 ?? incident.enteredAt;
      lines.push(`入場時間：${taipei(t0)}`);
      if (kind === 'TICKET') {
        lines.push(`錯誤 ticket 使用：本封涵蓋第 ${update.fromUse}～${update.toUse} 次（${update.useCount} 次），其中擴散 ${update.spreadUses} 次；嚴重度 ${update.severity}。`);
        lines.push(`已觀察到的不同 context：${update.distinctContexts}；不同來源：${update.distinctSources}（只是未驗證線索）。`);
      }
      if (kind === 'STAGE3') lines.push('這是第三階段：沒有第二值班，因此兩個管道各再送一次最高優先通知。');
      if (kind === 'STAGE4') lines.push(`系統已依 Policy Engine 判定執行逾時預設安全動作；結案原因 ${safe?.closureReason ?? '未記錄'}，不代表真人處置成功。`);
      if (['ENTRY', 'STAGE2', 'STAGE3'].includes(kind)) {
        const remaining = { ENTRY: limits.stage4Ms, STAGE2: limits.stage4Ms - limits.stage2Ms, STAGE3: limits.stage4Ms - limits.stage3Ms }[kind];
        lines.push(`若在約 ${Math.round(remaining / 60000)} 分鐘內沒有已驗證的 ACK，系統會執行逾時預設安全動作。`);
      }
      lines.push('');
      lines.push(link ? `ACK 確認（單次使用、有期限，需要本機 ACK 帳號密碼；目前只能在執行 DungeonQ 的這台 Mac 開啟）：\n${link.link}`
        : 'ACK 連結目前無法產生（已確認、連結數達上限或伺服器位址未就緒）。');
    }
    lines.push('', '此通知不含憑證、ticket 原值、誘餌原文或個資；寄件回執不代表已收件或已閱讀。', `追蹤碼：${token}`);
    return { subject: `${subjects[kind]} [${token}]`, text: lines.join('\n') };
  }

  /* ---------------- 單一管道寄送 ---------------- */
  const today = at => new Date(at).toISOString().slice(0, 10);
  async function sendOne({ channel, incidentId, scope, render, signal }) {
    // Reserve the budget and the durable row before any external call. One attempt per (scope, channel) unless RETRY.
    const reservation = transact(at => {
      const prior = db.prepare('SELECT status,count(*) AS n FROM handoff_deliveries WHERE scope=? AND channel=? GROUP BY status').all(scope, channel.name);
      const terminal = prior.find(row => ['ACCEPTED', 'UNKNOWN', 'FAILED', 'QUOTA', 'SENDING'].includes(row.status));
      if (terminal) return { skipped: terminal.status === 'ACCEPTED' ? 'ALREADY_ACCEPTED' : 'NO_BLIND_RESEND', state: terminal.status };
      const retries = prior.filter(row => row.status === 'RETRY').reduce((sum, row) => sum + row.n, 0);
      if (retries > limits.stageRetryMax) return { skipped: 'RETRY_LIMIT', state: 'RETRY' };
      let row = db.prepare('SELECT * FROM handoff_channels WHERE channel=?').get(channel.name);
      if (!row) { db.prepare('INSERT INTO handoff_channels VALUES(?,NULL,NULL,?,0)').run(channel.name, today(at)); row = { unavailable_until: null, day: today(at), sent_today: 0 }; }
      if (row.unavailable_until !== null && row.unavailable_until > at) return { skipped: 'CHANNEL_UNAVAILABLE', state: 'UNAVAILABLE' };
      const sent = row.day === today(at) ? row.sent_today : 0;
      if (sent >= limits.channelDailyLimit) {
        event('CHANNEL_DAILY_LIMIT', incidentId, { channel: channel.name, limit: limits.channelDailyLimit }, `daily:${channel.name}:${today(at)}`);
        return { skipped: 'DAILY_LIMIT', state: 'UNAVAILABLE' };
      }
      check(db.prepare('SELECT count(*) AS n FROM handoff_deliveries').get().n < limits.maxDeliveries, 'PITCH_HANDOFF_CAPACITY');
      db.prepare('UPDATE handoff_channels SET day=?,sent_today=? WHERE channel=?').run(today(at), sent + 1, channel.name);
      const deliveryId = `delivery-${randomUUID()}`; const token = `DQA${randomBytes(5).toString('hex').toUpperCase()}`;
      const attempt = retries + 1;
      db.prepare("INSERT INTO handoff_deliveries VALUES(?,?,?,?,?,?,?,'SENDING',?,NULL,NULL,'NOT_APPLICABLE',NULL,NULL,NULL,0)")
        .run(deliveryId, incidentId, scope, channel.name, attempt, `${scope}:${channel.name}:${attempt}`, token, at);
      return { deliveryId, token, attempt, queuedAt: at };
    });
    if (reservation.skipped) {
      record('DELIVERY_SKIPPED', incidentId, { scope: scopeLabel(scope), channel: channel.name, reason: reservation.skipped });
      return { channel: channel.name, state: reservation.state, skipped: reservation.skipped };
    }
    let message;
    try { message = render(reservation.token); }
    catch { message = null; }
    let state = 'FAILED'; let receipt = null; let timer;
    if (message) {
      const controller = new AbortController(); const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true }); aborter.signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => channel.send({ idempotencyKey: `${reservation.deliveryId}`, subject: message.subject, text: message.text,
            token: reservation.token }, { signal: controller.signal })),
          new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ state: 'UNKNOWN' }); }, limits.channelTimeoutMs);
            controller.signal.addEventListener('abort', () => resolve({ state: 'UNKNOWN' }), { once: true }); })
        ]);
        state = SEND_STATES.includes(result?.state) ? result.state : 'UNKNOWN';
        if (state === 'ACCEPTED') { receipt = sanitizeReceipt(result.receiptId); if (!receipt) state = 'UNKNOWN'; }
      } catch { state = 'UNKNOWN'; }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); aborter.signal.removeEventListener('abort', abort); }
    }
    const probe = state === 'ACCEPTED' && channel.inbox && inboxProbe !== undefined;
    transact(at => {
      db.prepare('UPDATE handoff_deliveries SET status=?,provider_at=?,receipt=?,inbox_status=?,inbox_deadline=? WHERE delivery_id=?')
        .run(state, state === 'ACCEPTED' ? at : null, receipt, probe ? 'PENDING' : 'NOT_APPLICABLE', probe ? at + limits.inboxWindowMs : null, reservation.deliveryId);
      event('DELIVERY_RESULT', incidentId, { deliveryId: reservation.deliveryId, scope: scopeLabel(scope), channel: channel.name, state, attempt: reservation.attempt });
      if (state === 'QUOTA') {
        db.prepare('UPDATE handoff_channels SET unavailable_until=?,reason=? WHERE channel=?').run(at + limits.channelUnavailableMs, 'QUOTA_OR_RATE_LIMIT', channel.name);
        event('CHANNEL_UNAVAILABLE', incidentId, { channel: channel.name, reason: 'QUOTA_OR_RATE_LIMIT', until: at + limits.channelUnavailableMs });
      }
    });
    if (probe) reschedule();
    return { channel: channel.name, state, deliveryId: reservation.deliveryId, receipt };
  }
  const scopeLabel = scope => scope.replace(/incident-[a-f0-9]{64}/g, match => shortId(match));

  /** 2.1 切換規則：依路線送出；被拒、結果不明或管道不可用即改走下一個管道並記錄切換；全部失敗即本機最高優先告警。 */
  async function deliverRoute({ incidentId, scope, route, kind, stage, signal, extra = {} }) {
    const byRole = role => channels.find(c => c.role === role);
    const order = (route === 'FALLBACK_FIRST' ? [byRole('FALLBACK'), byRole('PRIMARY')] : [byRole('PRIMARY'), byRole('FALLBACK')]).filter(Boolean);
    const incident = incidentId ? incidentRow(incidentId) : null;
    const results = []; let accepted = null; let link;
    for (const channel of order) {
      if (signal?.aborted || aborter.signal.aborted) break;
      if (route !== 'ALL' && accepted) break;
      const previous = results.at(-1);
      if (route !== 'ALL' && previous)
        record('CHANNEL_SWITCH', incidentId, { scope: scopeLabel(scope), from: previous.channel, to: channel.name, reason: previous.skipped ?? previous.state }, `switch:${scope}:${previous.channel}`);
      const result = await sendOne({ channel, incidentId, scope, signal, render: token => {
        if (kind !== 'SELF_CHECK' && kind !== 'STAGE4' && link === undefined) link = safeLink(incidentId);
        return compose({ kind, stage, incident: incident ?? { incidentId: 'incident-' + '0'.repeat(64) }, link, token, ...extra });
      } });
      results.push(result);
      if (result.state === 'ACCEPTED') accepted ??= result;
    }
    if (!accepted && kind !== 'SELF_CHECK') {
      const local = kind !== 'STAGE4' ? (link ?? safeLink(incidentId)) : null;
      raiseLocal({ level: 'CRITICAL', reason: channels.length === 0 ? 'NO_CHANNEL_CONFIGURED' : 'ALL_CHANNELS_FAILED', incidentId, stage,
        message: `事件 ${incidentId ? shortId(incidentId) : '-'} ${STAGE_LABELS[stage] ?? '更新'}：所有通知管道都失敗或不可用（${results.map(r => `${r.channel}=${r.skipped ?? r.state}`).join('，') || '未設定管道'}）。請立即在本機處理。`,
        ackLink: local?.link ?? null });
    }
    const retryable = !accepted && results.some(r => r.state === 'RETRY' && !r.skipped) && !results.some(r => r.state === 'UNKNOWN' && !r.skipped);
    return { accepted, results, retryable };
  }

  /* ---------------- 入場告警（T+0，經既有持久 outbox） ---------------- */
  async function entrySend({ idempotencyKey, incident, attempt, signal }) {
    arm(incident);
    if (disabled()) return { accepted: false, definitive: true, retryable: false };
    const scope = `ENTRY:${incident.incidentId}`;
    const outcome = await deliverRoute({ incidentId: incident.incidentId, scope, route: 'FAILOVER', kind: 'ENTRY', stage: 1, signal });
    record('ENTRY_ALERT_RESULT', incident.incidentId, { idempotencyKey: idempotencyKey.slice(0, 120), attempt, accepted: Boolean(outcome.accepted) });
    if (outcome.accepted) return { accepted: true, receiptId: outcome.accepted.deliveryId };
    if (outcome.retryable) return { accepted: false, definitive: true, retryable: true };
    if (outcome.results.length > 0 && outcome.results.every(r => r.skipped || ['FAILED', 'QUOTA', 'UNAVAILABLE'].includes(r.state)))
      return { accepted: false, definitive: true, retryable: false };
    throw coded('HANDOFF_DELIVERY_UNKNOWN');
  }

  /* ---------------- ticket 使用更新（M2 帳本 → 同一個寄送器） ---------------- */
  async function deliverTicketUpdates({ claim, complete, max = 4 }) {
    if (disabled() || channels.length === 0) return { attempted: 0 };
    let attempted = 0;
    for (let index = 0; index < max && !closed; index++) {
      const job = claim(); if (!job) break; attempted++;
      const incident = incidentRow(job.incident.incidentId) ?? { incident_id: job.incident.incidentId, t0: job.incident.enteredAt };
      if (!incidentRow(job.incident.incidentId) && job.incident.phase === 'ENTERED') {
        try { arm(job.incident); } catch { /* 摘要仍可寄出；升級另由 start() 補齊。 */ }
      }
      let outcome;
      try {
        outcome = await deliverRoute({ incidentId: incidentRow(job.incident.incidentId) ? job.incident.incidentId : null,
          scope: `TICKET:${job.update.updateId}`, route: 'FAILOVER', kind: 'TICKET', stage: null,
          extra: { update: job.update, incident } });
      } catch { outcome = { accepted: null, retryable: false, results: [{ state: 'UNKNOWN' }] }; }
      const input = outcome.accepted ? { outcome: 'ACCEPTED', receiptId: outcome.accepted.deliveryId }
        : outcome.retryable ? { outcome: 'REJECTED', retryable: true }
          : outcome.results.length > 0 && outcome.results.every(r => r.skipped || ['FAILED', 'QUOTA', 'UNAVAILABLE'].includes(r.state))
            ? { outcome: 'REJECTED', retryable: false } : { outcome: 'UNKNOWN' };
      try { complete({ updateId: job.update.updateId, claimToken: job.claimToken, ...input }); }
      catch { record('TICKET_UPDATE_COMPLETION_FAILED', job.incident.incidentId, { updateId: job.update.updateId }); }
    }
    return { attempted };
  }

  /* ---------------- 升級階段 ---------------- */
  async function runStage(row) {
    const incident = incidentRow(row.incident_id);
    if (row.stage === 4) {
      if (!safeDefault) {
        raiseLocal({ level: 'CRITICAL', reason: 'SAFE_DEFAULT_NOT_CONFIGURED', incidentId: row.incident_id, stage: 4,
          message: `事件 ${shortId(row.incident_id)} 已逾時，但逾時預設安全動作尚未接上（M5）。請立即手動處置。` });
        return { status: 'FAILED', result: { outcome: 'NOT_CONFIGURED' } };
      }
      const controller = new AbortController(); let timer; let value;
      const stop = () => controller.abort(); aborter.signal.addEventListener('abort', stop, { once: true });
      try {
        value = await Promise.race([
          Promise.resolve().then(() => safeDefault({ incidentId: incident.incident_id, contextId: incident.context_id, worldId: incident.world_id,
            epoch: incident.epoch, trigger: { kind: 'ACK_TIMEOUT', eventId: `ack-timeout-${sha256(incident.incident_id).slice(0, 32)}` }, signal: controller.signal })),
          new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ outcome: 'UNKNOWN', reason: 'TIMEOUT' }); }, limits.safeDefaultTimeoutMs);
            controller.signal.addEventListener('abort', () => resolve({ outcome: 'UNKNOWN', reason: 'ABORTED' }), { once: true }); })
        ]);
      } catch { value = { outcome: 'UNKNOWN', reason: 'EXECUTOR_ERROR' }; }
      finally { clearTimeout(timer); aborter.signal.removeEventListener('abort', stop); }
      let outcome = ['EFFECTIVE', 'NOT_EFFECTIVE', 'DENIED', 'UNKNOWN'].includes(value?.outcome) ? value.outcome : 'UNKNOWN';
      if (outcome === 'EFFECTIVE' && !PITCH_HANDOFF_CLOSURE_REASONS.includes(value.closureReason)) outcome = 'CLOSURE_REASON_INVALID';
      const safe = sanitizeHostSummary({ outcome, reason: value?.reason ?? null, closureReason: value?.closureReason ?? null,
        actions: Array.isArray(value?.actions) ? value.actions.slice(0, 10) : [], decisions: Array.isArray(value?.decisions) ? value.decisions.slice(0, 10) : [] });
      if (outcome === 'EFFECTIVE') {
        transact(at => {
          db.prepare('UPDATE handoff_incidents SET closure_reason=?,closure_at=?,closure_detail=? WHERE incident_id=? AND closure_reason IS NULL')
            .run(value.closureReason, at, JSON.stringify(safe), row.incident_id);
          event('SAFE_DEFAULT_EFFECTIVE', row.incident_id, { closureReason: value.closureReason, actions: safe.actions.length });
        });
        // 告知管理員系統已自動處置；不重送、不影響結案。
        try { await deliverRoute({ incidentId: row.incident_id, scope: `STAGE4:${row.incident_id}`, route: 'FAILOVER', kind: 'STAGE4', stage: 4, extra: { safe } }); }
        catch { /* 已寫入事件紀錄。 */ }
        return { status: 'DONE', result: safe };
      }
      record(`SAFE_DEFAULT_${outcome}`, row.incident_id, { reason: typeof safe.reason === 'string' ? safe.reason : null });
      raiseLocal({ level: 'CRITICAL', reason: `SAFE_DEFAULT_${outcome}`, incidentId: row.incident_id, stage: 4,
        message: `事件 ${shortId(row.incident_id)} 逾時預設安全動作沒有確認生效（${outcome}）。請立即手動處置並檢查事件摘要。` });
      return { status: outcome === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED', result: safe };
    }
    const outcome = await deliverRoute({ incidentId: row.incident_id, scope: `STAGE${row.stage}:${row.incident_id}`,
      route: row.stage === 2 ? 'FALLBACK_FIRST' : 'ALL', kind: `STAGE${row.stage}`, stage: row.stage });
    const result = { accepted: outcome.accepted ? outcome.accepted.channel : null,
      channels: outcome.results.map(r => ({ channel: r.channel, state: r.state, skipped: r.skipped ?? null })) };
    if (!outcome.accepted && outcome.retryable && row.retries < limits.stageRetryMax) return { status: 'RETRY_WAIT', result };
    return { status: outcome.accepted ? 'DONE' : 'FAILED', result };
  }

  async function processStages() {
    if (disabled()) return;
    const due = db.prepare("SELECT * FROM handoff_stages WHERE status IN ('PENDING','RETRY_WAIT') AND next_at<=? ORDER BY next_at,stage").all(now());
    for (const candidate of due) {
      if (closed) return;
      const claim = transact(at => {
        const row = db.prepare('SELECT * FROM handoff_stages WHERE incident_id=? AND stage=?').get(candidate.incident_id, candidate.stage);
        if (!['PENDING', 'RETRY_WAIT'].includes(row.status) || row.next_at > at) return null;
        const incident = incidentRow(row.incident_id);
        let closedExternally = false;
        try { closedExternally = isClosed?.(row.incident_id) === true; } catch { closedExternally = false; }
        if (incident.ack_at !== null || incident.closure_reason !== null || closedExternally) {
          cancelStages(row.incident_id, incident.ack_at !== null ? 'HUMAN_ACK' : 'INCIDENT_CLOSED'); return null;
        }
        db.prepare("UPDATE handoff_stages SET status='FIRING',fired_at=coalesce(fired_at,?) WHERE incident_id=? AND stage=?").run(at, row.incident_id, row.stage);
        event('STAGE_FIRED', row.incident_id, { stage: row.stage, dueAt: row.due_at, lateMs: at - row.due_at, retry: row.retries });
        return row;
      });
      if (!claim) continue;
      let outcome;
      try { outcome = await runStage(claim); }
      catch { outcome = { status: 'UNKNOWN', result: { reason: 'STAGE_ERROR' } }; }
      transact(at => {
        if (outcome.status === 'RETRY_WAIT') {
          db.prepare("UPDATE handoff_stages SET status='RETRY_WAIT',retries=retries+1,next_at=?,result=? WHERE incident_id=? AND stage=?")
            .run(at + limits.stageRetryBaseMs * (2 ** claim.retries), JSON.stringify(outcome.result), claim.incident_id, claim.stage);
        } else {
          db.prepare('UPDATE handoff_stages SET status=?,finished_at=?,result=? WHERE incident_id=? AND stage=?')
            .run(outcome.status, at, JSON.stringify(outcome.result), claim.incident_id, claim.stage);
        }
        event('STAGE_FINISHED', claim.incident_id, { stage: claim.stage, status: outcome.status });
      });
    }
  }

  /* ---------------- 收件匣唯讀量測（D13） ---------------- */
  let lastProbeAt = 0;
  async function processInbox() {
    if (!inboxProbe) return;
    const at = now();
    transact(t => db.prepare("UPDATE handoff_deliveries SET inbox_status='UNKNOWN' WHERE inbox_status='PENDING' AND inbox_deadline<=?").run(t));
    const pending = db.prepare("SELECT delivery_id,subject_token,incident_id FROM handoff_deliveries WHERE inbox_status='PENDING' ORDER BY provider_at LIMIT 8").all();
    if (pending.length === 0 || at - lastProbeAt < limits.inboxIntervalMs) return;
    lastProbeAt = at;
    const controller = new AbortController(); let timer; let found = {};
    const stop = () => controller.abort(); aborter.signal.addEventListener('abort', stop, { once: true });
    try {
      const value = await Promise.race([inboxProbe.find({ tokens: pending.map(row => row.subject_token), signal: controller.signal }),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, Math.max(1000, limits.inboxIntervalMs));
          controller.signal.addEventListener('abort', () => resolve(null), { once: true }); })]);
      found = value && typeof value.found === 'object' ? value.found : {};
    } catch { found = {}; }
    finally { clearTimeout(timer); aborter.signal.removeEventListener('abort', stop); }
    transact(t => {
      for (const row of pending) {
        const value = found[row.subject_token];
        if (Number.isSafeInteger(value) && value > 0) {
          db.prepare("UPDATE handoff_deliveries SET inbox_status='FOUND',inbox_at=?,inbox_observed_at=?,inbox_checks=inbox_checks+1 WHERE delivery_id=?").run(value, t, row.delivery_id);
          event('INBOX_ARRIVAL_OBSERVED', row.incident_id, { deliveryId: row.delivery_id, inboxAt: value, observedAt: t });
        } else db.prepare('UPDATE handoff_deliveries SET inbox_checks=inbox_checks+1 WHERE delivery_id=?').run(row.delivery_id);
      }
    });
  }

  /* ---------------- 管道自我檢查 ---------------- */
  async function processSelfCheck(force = false) {
    if (selfCheck === 'NONE' || channels.length === 0) return null;
    const meta = db.prepare('SELECT self_check_next FROM handoff_meta WHERE id=1').get();
    if (!force && meta.self_check_next !== null && meta.self_check_next > now()) return null;
    transact(at => db.prepare('UPDATE handoff_meta SET self_check_at=?,self_check_next=? WHERE id=1').run(at, at + limits.selfCheckIntervalMs));
    const results = [];
    for (const channel of channels) {
      let state = 'NOT_SUPPORTED';
      if (channel.checkLogin) {
        const controller = new AbortController(); let timer;
        try {
          const value = await Promise.race([Promise.resolve().then(() => channel.checkLogin({ signal: controller.signal })),
            new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ state: 'UNKNOWN' }); }, limits.channelTimeoutMs); })]);
          state = ['OK', 'FAILED', 'UNKNOWN'].includes(value?.state) ? value.state : 'UNKNOWN';
        } catch { state = 'UNKNOWN'; } finally { clearTimeout(timer); }
      }
      results.push({ channel: channel.name, mode: 'LOGIN', state });
      record('SELF_CHECK', null, { channel: channel.name, mode: 'LOGIN', state });
    }
    if (selfCheck === 'SEND') {
      const outcome = await deliverRoute({ incidentId: null, scope: `SELF_CHECK:${today(now())}`, route: 'ALL', kind: 'SELF_CHECK', stage: null });
      results.push(...outcome.results.map(r => ({ channel: r.channel, mode: 'SEND', state: r.skipped ?? r.state })));
    }
    if (results.some(r => r.state !== 'OK' && r.mode === 'LOGIN' && r.state !== 'NOT_SUPPORTED'))
      raiseLocal({ level: 'WARNING', reason: 'SELF_CHECK_FAILED', message: `通知管道自我檢查未通過：${results.map(r => `${r.channel}=${r.state}`).join('，')}` });
    return results;
  }

  /* ---------------- 排程（單一計時器，下一個到期時間） ---------------- */
  function nextWake() {
    const times = [];
    if (!disabled()) {
      const stage = db.prepare("SELECT min(next_at) AS t FROM handoff_stages WHERE status IN ('PENDING','RETRY_WAIT')").get().t;
      if (stage !== null) times.push(stage);
      const self = db.prepare('SELECT self_check_next AS t FROM handoff_meta WHERE id=1').get().t;
      if (selfCheck !== 'NONE' && channels.length > 0 && self !== null) times.push(self);
    }
    if (inboxProbe && db.prepare("SELECT 1 FROM handoff_deliveries WHERE inbox_status='PENDING' LIMIT 1").get()) times.push(lastProbeAt + limits.inboxIntervalMs);
    return times.length ? Math.min(...times) : null;
  }
  function reschedule() {
    if (!schedule || closed || !started) return;
    const next = nextWake();
    if (next === null) { clearTimeout(timer); timer = undefined; wake = 0; return; }
    if (timer && wake <= next) return;
    clearTimeout(timer); wake = next;
    timer = setTimeout(() => { timer = undefined; wake = 0; void tick(); }, Math.min(2147483647, Math.max(0, next - now())));
    timer.unref?.();
  }
  let ticking = null; let started = false;
  function tick() {
    if (closed) return Promise.resolve();
    if (ticking) return ticking;
    ticking = (async () => {
      try { await processStages(); } catch { /* 每階段結果已持久化；下一次排程再判斷。 */ }
      try { await processInbox(); } catch { /* 量測失敗不影響告警。 */ }
      try { if (!disabled()) await processSelfCheck(); } catch { /* 已寫入事件。 */ }
    })().finally(() => { ticking = null; reschedule(); });
    running.add(ticking); ticking.finally(() => running.delete(ticking));
    return ticking;
  }

  /* ---------------- ACK 驗證與摘要 ---------------- */
  function loadAccount() {
    if (!accountSource) return null;
    if (accountSource.path !== undefined) return loadAckAccountFile(accountSource.path);
    return ackAccount(accountSource);
  }
  function accountStatus() {
    if (!accountSource) return 'MISSING';
    try { return loadAccount().totp ? 'CONFIGURED_PASSWORD_TOTP' : 'CONFIGURED_PASSWORD'; } catch { return 'INVALID'; }
  }
  const failureCount = at => db.prepare('SELECT count(*) AS n FROM handoff_failures WHERE at>?').get(at - limits.ackFailureWindowMs).n;
  function noteFailure(handleDigest, incidentId, reason) {
    transact(at => {
      db.prepare('INSERT INTO handoff_failures(at) VALUES(?)').run(at);
      db.prepare('DELETE FROM handoff_failures WHERE at<=?').run(at - limits.ackFailureWindowMs);
      if (handleDigest) {
        db.prepare('UPDATE handoff_links SET failures=failures+1 WHERE handle_digest=?').run(handleDigest);
        db.prepare("UPDATE handoff_links SET state='LOCKED' WHERE handle_digest=? AND state='ACTIVE' AND failures>=?").run(handleDigest, limits.ackMaxFailuresPerLink);
      }
      event('ACK_REJECTED', incidentId, { reason });
    });
  }
  async function verifyAck(input) {
    envelope(input, ['incidentId', 'handle', 'password'], ['totp'], 4096);
    const at = now();
    if (failureCount(at) >= limits.ackMaxFailuresPerWindow) { record('ACK_REJECTED', null, { reason: 'RATE_LIMIT' }); fail('ACK_RATE_LIMIT'); }
    if (typeof input.handle !== 'string' || !HANDLE.test(input.handle) || typeof input.incidentId !== 'string' || !INCIDENT.test(input.incidentId)) {
      noteFailure(null, null, 'FORGED'); fail('ACK_LINK_DENIED');
    }
    const handleDigest = sha256(`dungeonq.ack-link/v1\0${input.handle}`);
    const link = db.prepare('SELECT * FROM handoff_links WHERE handle_digest=?').get(handleDigest);
    if (!link) { noteFailure(null, null, 'FORGED'); fail('ACK_LINK_DENIED'); }
    if (link.incident_id !== input.incidentId) { noteFailure(handleDigest, link.incident_id, 'WRONG_INCIDENT'); fail('ACK_INCIDENT_MISMATCH_DENIED'); }
    if (link.state === 'USED' || link.state === 'SUPERSEDED') { noteFailure(null, link.incident_id, 'REUSED'); fail('ACK_LINK_USED_DENIED'); }
    if (link.state === 'LOCKED') { noteFailure(null, link.incident_id, 'LOCKED'); fail('ACK_LINK_LOCKED_DENIED'); }
    if (link.expires_at <= at) { noteFailure(null, link.incident_id, 'EXPIRED'); fail('ACK_LINK_EXPIRED_DENIED'); }
    const incident = incidentRow(link.incident_id);
    if (incident.ack_at !== null) { noteFailure(null, link.incident_id, 'ALREADY_ACKNOWLEDGED'); fail('ACK_LINK_USED_DENIED'); }
    let account;
    try { account = loadAccount(); } catch { account = null; }
    if (!account) { record('ACK_REJECTED', link.incident_id, { reason: 'ACCOUNT_UNAVAILABLE' }); fail('ACK_ACCOUNT_UNAVAILABLE'); }
    let passwordOk = false;
    try { passwordOk = typeof input.password === 'string' && await verifyPassword(input.password, account.password); }
    catch (error) { if (error?.code === 'AUTH_CAPACITY') fail('ACK_RATE_LIMIT'); passwordOk = false; }
    let step = null;
    if (passwordOk && account.totp) {
      const last = db.prepare('SELECT last_totp_step FROM handoff_operator WHERE account=?').get(account.operatorId)?.last_totp_step ?? -1;
      step = matchOtp(account.totp, input.totp, now(), last);
    }
    if (!passwordOk || (account.totp && step === null)) {
      noteFailure(handleDigest, link.incident_id, account.totp && passwordOk ? 'TOTP_INVALID' : 'CREDENTIALS_INVALID');
      fail('ACK_CREDENTIALS_DENIED');
    }
    const sessionToken = randomBytes(32).toString('base64url');
    const result = transact(t => {
      // Re-check inside the write transaction: a concurrent use of the same or another link wins only once.
      const current = db.prepare('SELECT * FROM handoff_links WHERE handle_digest=?').get(handleDigest);
      const row = incidentRow(link.incident_id);
      if (current.state !== 'ACTIVE' || current.expires_at <= t || row.ack_at !== null) return null;
      if (step !== null) db.prepare('INSERT INTO handoff_operator VALUES(?,?) ON CONFLICT(account) DO UPDATE SET last_totp_step=excluded.last_totp_step').run(account.operatorId, step);
      db.prepare("UPDATE handoff_links SET state='USED',used_at=? WHERE handle_digest=?").run(t, handleDigest);
      db.prepare("UPDATE handoff_links SET state='SUPERSEDED' WHERE incident_id=? AND state='ACTIVE'").run(link.incident_id);
      const reference = `verified-ack-${sha256(handleDigest).slice(0, 32)}`;
      const method = account.totp ? 'PASSWORD_TOTP' : 'PASSWORD';
      db.prepare('UPDATE handoff_incidents SET ack_at=?,ack_account=?,ack_method=?,ack_reference=? WHERE incident_id=?')
        .run(t, account.operatorId, method, reference, link.incident_id);
      db.prepare('INSERT INTO handoff_sessions VALUES(?,?,?,?)').run(sha256(`dungeonq.ack-session/v1\0${sessionToken}`), link.incident_id, account.operatorId, t + limits.ackSessionTtlMs);
      event('HUMAN_ACK', link.incident_id, { account: account.operatorId, method, reference, latencyMs: t - row.t0 });
      cancelStages(link.incident_id, 'HUMAN_ACK');
      return { incidentId: link.incident_id, account: account.operatorId, method, at: t, reference, t0: row.t0 };
    });
    if (!result) { noteFailure(null, link.incident_id, 'REUSED'); fail('ACK_LINK_USED_DENIED'); }
    syncAck(result.incidentId);
    reschedule();
    return { acknowledged: true, incidentId: result.incidentId, account: result.account, method: result.method, at: result.at,
      ackLatencyMs: result.at - result.t0, summaryToken: sessionToken, summaryExpiresAt: result.at + limits.ackSessionTtlMs };
  }
  function syncAck(incidentId) {
    const row = incidentRow(incidentId);
    if (!row || row.ack_at === null || row.ack_synced === 1 || !onAcknowledged) return;
    try {
      onAcknowledged({ incidentId, account: row.ack_account, method: row.ack_method, at: row.ack_at, reference: row.ack_reference });
      transact(() => db.prepare('UPDATE handoff_incidents SET ack_synced=1 WHERE incident_id=?').run(incidentId));
    } catch (error) {
      record('ACK_SYNC_FAILED', incidentId, { code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'UNKNOWN' });
    }
  }

  function measurements(incidentId) {
    const row = incidentRow(incidentId);
    const deliveries = db.prepare('SELECT * FROM handoff_deliveries WHERE incident_id=? ORDER BY queued_at').all(incidentId);
    const first = deliveries[0] ?? null; const accepted = deliveries.find(d => d.status === 'ACCEPTED') ?? null;
    const inbox = deliveries.find(d => d.inbox_status === 'FOUND') ?? null;
    return { t0: row?.t0 ?? null, queueCreatedAt: first?.queued_at ?? null, providerAcceptedAt: accepted?.provider_at ?? null,
      providerChannel: accepted?.channel ?? null,
      inboxArrival: inbox ? { at: inbox.inbox_at, observedAt: inbox.inbox_observed_at, status: 'FOUND' }
        : { at: null, observedAt: null, status: deliveries.some(d => d.inbox_status === 'PENDING') ? 'PENDING'
          : deliveries.some(d => d.inbox_status === 'UNKNOWN') ? 'UNKNOWN' : 'NOT_APPLICABLE' },
      verifiedHumanAckAt: row?.ack_at ?? null,
      adminDecisionAt: firstDecisionAt(incidentId),
      claim: '四個時間點分開記錄；寄件回執只代表已交給供應商，時間窗比較以已驗證真人 ACK 為準。管理員決策時間（t6）是第一個送出的決策。' };
  }
  function stageView(incidentId) {
    return db.prepare('SELECT stage,due_at,status,retries,fired_at,finished_at,result FROM handoff_stages WHERE incident_id=? ORDER BY stage').all(incidentId)
      .map(row => ({ stage: row.stage, label: STAGE_LABELS[row.stage], dueAt: row.due_at, status: row.status, retries: row.retries,
        firedAt: row.fired_at, finishedAt: row.finished_at, result: row.result ? JSON.parse(row.result) : null }));
  }
  async function summaryFor(input) {
    envelope(input, ['incidentId', 'summaryToken'], [], 1024);
    check(typeof input.incidentId === 'string' && INCIDENT.test(input.incidentId) && typeof input.summaryToken === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(input.summaryToken), 'ACK_SESSION_DENIED');
    const session = db.prepare('SELECT * FROM handoff_sessions WHERE token_digest=?').get(sha256(`dungeonq.ack-session/v1\0${input.summaryToken}`));
    if (!session || session.incident_id !== input.incidentId || session.expires_at <= now()) fail('ACK_SESSION_DENIED');
    const row = incidentRow(input.incidentId); const at = now(); const stages = stageView(input.incidentId);
    const next = stages.find(stage => ['PENDING', 'RETRY_WAIT'].includes(stage.status));
    let ticket = null;
    try { ticket = ticketSummary ? sanitizeHostSummary(ticketSummary(input.incidentId)) : null; } catch { ticket = { status: 'UNAVAILABLE' }; }
    let host = { status: 'NOT_CONFIGURED' };
    if (summary) {
      const controller = new AbortController(); let timer;
      try {
        const value = await Promise.race([Promise.resolve().then(() => summary({ incidentId: input.incidentId, signal: controller.signal })),
          new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: 'TIMEOUT' }); }, limits.summaryTimeoutMs); })]);
        host = sanitizeHostSummary(value) ?? { status: 'INVALID' };
      } catch { host = { status: 'UNAVAILABLE' }; } finally { clearTimeout(timer); }
    }
    const view = {
      schemaVersion: 'dungeonq.incident-summary/v1', generatedAt: at, incidentId: input.incidentId, shortId: shortId(input.incidentId),
      stage: { current: row.closure_reason ? `CLOSED_${row.closure_reason}` : row.ack_at !== null ? 'HUMAN_ACKNOWLEDGED' : disabled() ? 'ESCALATION_DISABLED' : next ? `WAITING_STAGE_${next.stage}` : 'ESCALATION_FINISHED',
        stages: stages.map(({ stage, label, dueAt, status, firedAt }) => ({ stage, label, dueAt, status, firedAt })) },
      nextEscalation: next && row.ack_at === null && !disabled() ? { stage: next.stage, label: next.label, dueAt: next.dueAt, remainingMs: Math.max(0, next.dueAt - at) } : null,
      acknowledgement: row.ack_at !== null ? { at: row.ack_at, account: row.ack_account, method: row.ack_method } : null,
      closure: row.closure_reason ? { reason: row.closure_reason, at: row.closure_at, detail: JSON.parse(row.closure_detail ?? 'null') } : null,
      ticket, measurements: measurements(input.incidentId), host,
      decisions: { configured: typeof decision === 'function', items: listDecisions(input.incidentId) },
      boundary: '本頁不含憑證、ticket 原值、誘餌原文或個資；來源與客戶端只以數量呈現。摘要只能在執行 DungeonQ 的這台 Mac 開啟。'
    };
    runtimeJson(view, 65536, 12);
    return view;
  }

  /* ---------------- 管理員決策（摘要頁送出，t6） ---------------- */
  // 決策權杖只在記憶體：重啟後全部失效，頁面重新取得即可（fail closed）。決策本身與結果寫入只追加的事件紀錄。
  const decisionTokens = new Map(); const inflight = new Map();
  const decisionRows = incidentId => db.prepare("SELECT at,kind,detail FROM handoff_events WHERE incident_id=? AND kind IN ('ADMIN_DECISION_SUBMITTED','ADMIN_DECISION_RESULT') ORDER BY seq")
    .all(incidentId).map(row => ({ at: row.at, kind: row.kind, detail: JSON.parse(row.detail) }));
  function firstDecisionAt(incidentId) {
    const row = db.prepare("SELECT min(at) AS at FROM handoff_events WHERE incident_id=? AND kind='ADMIN_DECISION_SUBMITTED'").get(incidentId);
    return Number.isSafeInteger(row?.at) ? row.at : null;
  }
  function requireDecisionOrigin(requestOrigin) {
    // 瀏覽器的 POST 一定帶 Origin；缺少或不是本機摘要頁的來源都視為跨站請求。
    if (!origin || requestOrigin !== origin) fail('DECISION_ORIGIN_DENIED');
  }
  function requireDecisionSession(input) {
    if (typeof input.incidentId !== 'string' || !INCIDENT.test(input.incidentId) || typeof input.summaryToken !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(input.summaryToken)) fail('DECISION_SESSION_DENIED');
    const digest = sha256(`dungeonq.ack-session/v1\0${input.summaryToken}`);
    const session = db.prepare('SELECT * FROM handoff_sessions WHERE token_digest=?').get(digest);
    if (!session) fail('DECISION_SESSION_DENIED');
    if (session.incident_id !== input.incidentId) fail('DECISION_INCIDENT_MISMATCH_DENIED');
    if (session.expires_at <= now()) fail('DECISION_SESSION_EXPIRED_DENIED');
    const row = incidentRow(input.incidentId);
    if (!row || row.ack_at === null) fail('DECISION_SESSION_DENIED');
    return { session, digest, row };
  }
  /** 拒絕一律寫入事件紀錄（只記原因代碼），再丟出。 */
  async function guardDecision(input, task) {
    const hint = typeof input?.incidentId === 'string' && INCIDENT.test(input.incidentId) && incidentRow(input.incidentId) ? input.incidentId : null;
    try { return await task(); }
    catch (error) {
      const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'DECISION_FAILED';
      record('ADMIN_DECISION_REJECTED', hint, { reason: code });
      throw error;
    }
  }
  function purgeDecisionTokens(at) {
    for (const [key, row] of decisionTokens) if (row.expiresAt <= at) decisionTokens.delete(key);
  }
  /** 單次使用的決策權杖（防範 CSRF 與重送）：綁定已驗證會話與事件；新的權杖取代同一會話尚未使用的舊權杖。 */
  async function issueDecisionToken(input, { origin: requestOrigin } = {}) {
    envelope(input, ['incidentId', 'summaryToken'], [], 1024);
    check(!closed, 'PITCH_HANDOFF_CLOSED');
    if (typeof decision !== 'function') fail('ADMIN_DECISION_NOT_CONFIGURED');
    return guardDecision(input, async () => {
      requireDecisionOrigin(requestOrigin);
      const { session, digest } = requireDecisionSession(input);
      const at = now(); purgeDecisionTokens(at);
      if (decisionTokens.size >= PITCH_HANDOFF_DECISION_LIMITS.maxTokens) fail('DECISION_TOKEN_CAPACITY');
      for (const row of decisionTokens.values()) if (row.sessionDigest === digest && row.state === 'ACTIVE') row.state = 'SUPERSEDED';
      const token = randomBytes(32).toString('base64url');
      const expiresAt = Math.min(at + PITCH_HANDOFF_DECISION_LIMITS.tokenTtlMs, session.expires_at);
      decisionTokens.set(sha256(`dungeonq.decision-token/v1\0${token}`), { sessionDigest: digest, incidentId: input.incidentId, expiresAt, state: 'ACTIVE' });
      return { decisionToken: token, expiresAt };
    });
  }
  function consumeDecisionToken(token, sessionDigest, incidentId) {
    if (typeof token !== 'string' || !HANDLE.test(token)) fail('DECISION_TOKEN_DENIED');
    const row = decisionTokens.get(sha256(`dungeonq.decision-token/v1\0${token}`));
    if (!row || row.sessionDigest !== sessionDigest || row.incidentId !== incidentId) fail('DECISION_TOKEN_DENIED');
    if (row.state !== 'ACTIVE') fail('DECISION_TOKEN_USED_DENIED');
    if (row.expiresAt <= now()) { row.state = 'EXPIRED'; fail('DECISION_TOKEN_EXPIRED_DENIED'); }
    row.state = 'USED';
  }
  /** 決策請求只接受固定欄位；動作代號、對象與結束流程內容的語意由主機處理器與政策判定。 */
  function decisionRequest(value) {
    check(value && typeof value === 'object' && !Array.isArray(value) && PITCH_HANDOFF_DECISION_KINDS.includes(value.kind), 'DECISION_REQUEST_INVALID');
    if (value.kind === 'START_CLOSE') {
      try { envelope(value, ['kind', 'close'], [], PITCH_HANDOFF_DECISION_LIMITS.maxRequestBytes); runtimeJson(value.close, PITCH_HANDOFF_DECISION_LIMITS.maxRequestBytes, 5); }
      catch { fail('DECISION_REQUEST_INVALID'); }
      check(value.close && typeof value.close === 'object' && !Array.isArray(value.close), 'DECISION_REQUEST_INVALID');
      return { kind: value.kind, close: JSON.parse(JSON.stringify(value.close)) };
    }
    try { envelope(value, ['kind', 'actionCode', 'targetId'], [], 1024); } catch { fail('DECISION_REQUEST_INVALID'); }
    check(typeof value.actionCode === 'string' && /^[A-Z]-[0-9]{1,2}$/.test(value.actionCode)
      && typeof value.targetId === 'string' && DECISION_TARGET.test(value.targetId), 'DECISION_REQUEST_INVALID');
    return { kind: value.kind, actionCode: value.actionCode, targetId: value.targetId };
  }
  /** 主機結果只保留代號、狀態與讀回欄位；鍵名像憑證或內容的欄位先由 sanitizeHostSummary 移除。事件明細上限 4 KB。 */
  function compactDecisionResult(value) {
    const safe = sanitizeHostSummary(value) ?? {};
    const pick = (item, keys) => (item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(keys.filter(key => item[key] !== undefined).map(key => [key, item[key]])) : null);
    const text = (item, max) => (typeof item === 'string' ? item.slice(0, max) : null);
    const result = { outcome: DECISION_OUTCOMES.includes(safe.outcome) ? safe.outcome : 'UNKNOWN', reason: text(safe.reason, 160),
      readback: text(safe.readback, 32), permit: text(safe.permit, 80), field: text(safe.field, 80),
      policy: pick(safe.policy, ['effect', 'reason', 'decisionDigest', 'healthStatus', 'actionClass', 'expectedClass']),
      action: pick(safe.action, ['actionCode', 'actionName', 'targetId', 'status', 'readback', 'recordedAt']),
      workOrder: pick(safe.workOrder, ['workOrderId', 'ref', 'status', 'actionCode', 'targetId', 'title']),
      close: pick(safe.close, ['status', 'step', 'code', 'steps']) };
    for (const drop of [['close', 'steps'], ['workOrder', 'title'], ['policy', 'decisionDigest']]) {
      if (Buffer.byteLength(JSON.stringify(result)) <= 3500) break;
      if (result[drop[0]]) delete result[drop[0]][drop[1]];
    }
    return Buffer.byteLength(JSON.stringify(result)) <= 3500 ? result : { outcome: result.outcome, reason: result.reason, readback: result.readback };
  }
  function decisionView(incidentId, decisionId) {
    const rows = decisionRows(incidentId);
    const submitted = rows.find(row => row.kind === 'ADMIN_DECISION_SUBMITTED' && row.detail.decisionId === decisionId);
    if (!submitted) return null;
    const finished = rows.find(row => row.kind === 'ADMIN_DECISION_RESULT' && row.detail.decisionId === decisionId);
    const { decisionId: id, ...request } = submitted.detail;
    return { decisionId: id, request, submittedAt: submitted.at,
      state: finished ? 'DONE' : inflight.get(incidentId) === decisionId ? 'RUNNING' : 'UNKNOWN',
      finishedAt: finished?.at ?? null, result: finished ? (({ decisionId: ignored, ...rest }) => rest)(finished.detail) : null };
  }
  function closeStarted(incidentId, decisionId) {
    const result = db.prepare("SELECT detail FROM handoff_events WHERE incident_id=? AND kind='ADMIN_DECISION_RESULT' AND dedupe=?")
      .get(incidentId, `decision-result:${decisionId}`);
    return !result || JSON.parse(result.detail).outcome !== 'REJECTED';
  }
  function listDecisions(incidentId) {
    return decisionRows(incidentId).filter(row => row.kind === 'ADMIN_DECISION_SUBMITTED').slice(-PITCH_HANDOFF_DECISION_LIMITS.maxListed)
      .map(row => decisionView(incidentId, row.detail.decisionId)).filter(Boolean);
  }
  async function runDecision({ incidentId, decisionId, request, row, submittedAt, firstAt }) {
    const controller = new AbortController(); const stop = () => controller.abort();
    aborter.signal.addEventListener('abort', stop, { once: true });
    let timer; let value;
    let ticket = null;
    try { const view = ticketSummary ? ticketSummary(incidentId) : null; ticket = view ? { uses: Number.isSafeInteger(view.uses) ? view.uses : 0, spread: view.spread === true } : null; }
    catch { ticket = null; }
    try {
      value = await Promise.race([
        Promise.resolve().then(() => decision({ incidentId, decisionId, request, submittedAt, firstDecisionAt: firstAt, ticket,
          actor: { account: row.ack_account, method: row.ack_method, reference: row.ack_reference },
          acknowledgement: { at: row.ack_at, account: row.ack_account, method: row.ack_method }, signal: controller.signal })),
        new Promise(resolve => {
          timer = setTimeout(() => { controller.abort(); resolve({ outcome: 'UNKNOWN', reason: 'DECISION_TIMEOUT' }); }, PITCH_HANDOFF_DECISION_LIMITS.handlerTimeoutMs);
          timer.unref?.();
          controller.signal.addEventListener('abort', () => resolve({ outcome: 'UNKNOWN', reason: 'DECISION_ABORTED' }), { once: true });
        })
      ]);
    } catch { value = { outcome: 'FAILED', reason: 'DECISION_HANDLER_ERROR' }; }
    finally { clearTimeout(timer); aborter.signal.removeEventListener('abort', stop); }
    const result = compactDecisionResult(value);
    record('ADMIN_DECISION_RESULT', incidentId, { decisionId, ...result }, `decision-result:${decisionId}`);
    if (inflight.get(incidentId) === decisionId) inflight.delete(incidentId);
    return result;
  }
  /**
   * 送出一個決策：Origin、已驗證會話（同一事件、未過期）、單次決策權杖全部通過才記錄 t6（ADMIN_DECISION_SUBMITTED），
   * 再交給主機處理器。最多等 waitMs 就先回覆（RUNNING），結果之後以 decisionStatus 或摘要讀取；不重跑、不重送。
   */
  async function submitDecision(input, { origin: requestOrigin } = {}) {
    envelope(input, ['incidentId', 'summaryToken', 'decisionToken', 'request'], [], PITCH_HANDOFF_DECISION_LIMITS.maxRequestBytes);
    check(!closed, 'PITCH_HANDOFF_CLOSED');
    if (typeof decision !== 'function') fail('ADMIN_DECISION_NOT_CONFIGURED');
    return guardDecision(input, async () => {
      requireDecisionOrigin(requestOrigin);
      const { digest } = requireDecisionSession(input);
      consumeDecisionToken(input.decisionToken, digest, input.incidentId);
      const request = decisionRequest(input.request);
      const submitted = transact(at => {
        const row = incidentRow(input.incidentId);
        if (inflight.has(input.incidentId)) fail('DECISION_IN_PROGRESS');
        const prior = db.prepare("SELECT detail FROM handoff_events WHERE incident_id=? AND kind='ADMIN_DECISION_SUBMITTED'").all(input.incidentId)
          .map(item => JSON.parse(item.detail));
        if (prior.length >= PITCH_HANDOFF_DECISION_LIMITS.maxDecisionsPerIncident) fail('DECISION_LIMIT');
        // 已開始結束流程（處理中、結果不明或沒有被拒絕）後，不再接受 A 級或 B 級決策；被拒絕的結束請求不算開始。
        if (request.kind !== 'START_CLOSE' && prior.some(item => item.kind === 'START_CLOSE' && closeStarted(input.incidentId, item.decisionId))) {
          fail('DECISION_INCIDENT_CLOSING');
        }
        const decisionId = `decision-${randomUUID()}`;
        const firstAt = firstDecisionAt(input.incidentId) ?? at;
        check(event('ADMIN_DECISION_SUBMITTED', input.incidentId, { decisionId, kind: request.kind, actionCode: request.actionCode ?? null,
          targetId: request.targetId ?? null, account: row.ack_account, method: row.ack_method }, `decision-submitted:${decisionId}`), 'DECISION_RECORD_FAILED');
        inflight.set(input.incidentId, decisionId);
        return { decisionId, row, submittedAt: at, firstAt };
      });
      const job = runDecision({ incidentId: input.incidentId, decisionId: submitted.decisionId, request, row: submitted.row,
        submittedAt: submitted.submittedAt, firstAt: submitted.firstAt });
      running.add(job); job.finally(() => running.delete(job));
      let timer;
      await Promise.race([job, new Promise(resolve => { timer = setTimeout(resolve, PITCH_HANDOFF_DECISION_LIMITS.waitMs); })]);
      clearTimeout(timer);
      return decisionView(input.incidentId, submitted.decisionId);
    });
  }
  async function decisionStatus(input, { origin: requestOrigin } = {}) {
    envelope(input, ['incidentId', 'summaryToken', 'decisionId'], [], 1024);
    return guardDecision(input, async () => {
      requireDecisionOrigin(requestOrigin);
      requireDecisionSession(input);
      check(typeof input.decisionId === 'string' && DECISION_ID.test(input.decisionId), 'DECISION_NOT_FOUND');
      const view = decisionView(input.incidentId, input.decisionId);
      if (!view) fail('DECISION_NOT_FOUND');
      return view;
    });
  }

  function publicStatus() {
    const meta = db.prepare('SELECT * FROM handoff_meta WHERE id=1').get();
    const incidents = db.prepare('SELECT * FROM handoff_incidents ORDER BY armed_at DESC LIMIT 32').all();
    return {
      schemaVersion: PITCH_HANDOFF_VERSION, prefix: PITCH_HANDOFF_PREFIXES[prefix], limits, ackAccount: accountStatus(),
      disabled: meta.disabled_at === null ? null : { at: meta.disabled_at, reason: meta.disabled_reason },
      selfCheck: { mode: selfCheck, at: meta.self_check_at, next: meta.self_check_next },
      channels: channels.map(channel => {
        const row = db.prepare('SELECT * FROM handoff_channels WHERE channel=?').get(channel.name);
        return { name: channel.name, role: channel.role, inboxProbe: channel.inbox && inboxProbe !== undefined,
          unavailableUntil: row?.unavailable_until ?? null, reason: row?.reason ?? null, day: row?.day ?? null, sentToday: row?.sent_today ?? 0 };
      }),
      safeDefaultConfigured: Boolean(safeDefault), summaryConfigured: Boolean(summary), droppedEvents: meta.dropped_events,
      incidents: incidents.map(row => ({ incidentId: row.incident_id, t0: row.t0, armedAt: row.armed_at,
        acknowledgement: row.ack_at === null ? null : { at: row.ack_at, account: row.ack_account, method: row.ack_method, synced: row.ack_synced === 1 },
        closure: row.closure_reason ? { reason: row.closure_reason, at: row.closure_at } : null, stages: stageView(row.incident_id),
        measurements: measurements(row.incident_id) })),
      deliveries: db.prepare('SELECT * FROM handoff_deliveries ORDER BY queued_at DESC LIMIT 200').all().map(row => ({
        deliveryId: row.delivery_id, incidentId: row.incident_id, scope: scopeLabel(row.scope), channel: row.channel, attempt: row.attempt,
        status: row.status, queuedAt: row.queued_at, providerAt: row.provider_at, receipt: row.receipt, subjectToken: row.subject_token,
        inbox: { status: row.inbox_status, at: row.inbox_at, observedAt: row.inbox_observed_at, checks: row.inbox_checks } })),
      events: db.prepare('SELECT seq,at,incident_id,kind,detail,digest FROM handoff_events ORDER BY seq DESC LIMIT 200').all()
        .map(row => ({ seq: row.seq, at: row.at, incidentId: row.incident_id, kind: row.kind, detail: JSON.parse(row.detail), digest: row.digest }))
    };
  }

  return Object.freeze({
    channels: channels.map(({ name, role }) => ({ name, role })),
    configured: channels.length > 0,
    bindOrigin(value) { check(typeof value === 'string' && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value), 'PITCH_HANDOFF_ORIGIN_INVALID'); origin = value; },
    sendingEnabled: () => !closed && !disabled() && channels.length > 0,
    arm, entrySend, deliverTicketUpdates, verifyAck, summary: summaryFor, publicStatus, accountStatus, tick,
    decisionsConfigured: typeof decision === 'function', issueDecisionToken, submitDecision, decisionStatus,
    mintLink(incidentId) { return mintLink(incidentId); },
    selfCheck: () => processSelfCheck(true),
    /** 啟動：補齊重啟前已入場但未上計時器的事件、同步未完成的 ACK，並立即處理已過期的階段（不重新起算）。 */
    async start({ entered = [] } = {}) {
      started = true;
      for (const incident of entered) { try { arm(incident); } catch { record('ARM_FAILED', incident?.incidentId ?? null, {}); } }
      for (const row of db.prepare('SELECT incident_id FROM handoff_incidents WHERE ack_at IS NOT NULL AND ack_synced=0').all()) syncAck(row.incident_id);
      await tick();
    },
    disable({ reason }) {
      check(typeof reason === 'string' && reason.length >= 1 && reason.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(reason), 'PITCH_HANDOFF_REASON_INVALID');
      return transact(at => {
        const meta = db.prepare('SELECT disabled_at FROM handoff_meta WHERE id=1').get();
        if (meta.disabled_at !== null) return { disabled: true, at: meta.disabled_at, replayed: true };
        db.prepare('UPDATE handoff_meta SET disabled_at=?,disabled_reason=? WHERE id=1').run(at, reason);
        const cancelled = db.prepare("UPDATE handoff_stages SET status='CANCELLED',finished_at=?,result=? WHERE status IN ('PENDING','RETRY_WAIT')")
          .run(at, JSON.stringify({ reason: 'KILL_SWITCH' }), ).changes;
        event('ESCALATION_DISABLED', null, { reason, cancelledStages: cancelled });
        return { disabled: true, at, cancelledStages: cancelled, replayed: false };
      });
    },
    async close() {
      if (closed) return; closed = true; clearTimeout(timer); aborter.abort();
      await Promise.allSettled([...running]); db.close();
    }
  });
}
