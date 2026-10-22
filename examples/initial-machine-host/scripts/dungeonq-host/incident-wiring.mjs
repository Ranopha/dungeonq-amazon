// DungeonQ 事件結束流程的正式接線（DQ-HANDOFF-015 M7 → M3）。
//
// M7 結束協調器（incident-close.mjs）與候選目錄（incident-review.mjs）只定義注入介面；本模組用 M3 的正式實作接上：
// - notifier：通知被誤傷者。寄送一律經 M3 寄送器（alert-sender.mjs 的 createDungeonqAlertSender）的管道，
//   收件人固定是 M3 祕密檔設定的使用者本人；recipientId 不在登錄名單一律 REJECTED，不寄送。
//   切換規則沿用 M3：主管道沒有回 ACCEPTED 就改走備援；結果不明（UNKNOWN）不重送。
// - approval：候選核准的真人身分驗證。沿用 M3 的 ACK 操作員帳號（ack-operator.mjs，Argon2id＋選用 TOTP），
//   並綁定候選摘要與測試摘要；核准證明（密碼、驗證碼）只在記憶體比對，不寫入任何檔案。
//
// 本模組不直接讀祕密檔：寄送時由 M3 的管道在當下讀取；帳號檔（只有密碼雜湊與 TOTP 種子）由 M3 的 loadAckAccountFile 讀取。
// 沒有計時器、輪詢或背景工作；每次呼叫都有時限，結果不明就停止並如實記錄。
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { loadAckAccountFile } from '../../vendor/dungeonq-runtime/runtime/pitch-handoff.mjs';
import { verifyPassword } from '../../vendor/dungeonq-runtime/server/passwords.mjs';
import { matchOtp } from '../../vendor/dungeonq-runtime/server/totp.mjs';
import { readHidden } from './ack-operator.mjs';
import { DUNGEONQ_ACK_ACCOUNT, DUNGEONQ_PRIVATE_ROOT, createDungeonqAlertSender } from './alert-sender.mjs';
import { canonicalJson, checkSensitiveContent, openCandidateStore, sha256 } from './incident-review.mjs';

export const INCIDENT_WIRING_VERSION = 'dungeonq.incident-wiring/v1';

/**
 * 已登錄的通知對象。v1 的 M3 管道只能寄給祕密檔設定的單一收件人（Gmail smtp.json 的 user、LINE line.json 的 to），
 * 所以名單只能有一筆，代表使用者本人。M7 的通訊錄（legitimateConsumers／flaggedSubjectOwners）要寄給使用者時填這個代號。
 */
export const DUNGEONQ_INCIDENT_RECIPIENT_OWNER = 'owner';
export const DUNGEONQ_INCIDENT_RECIPIENTS = Object.freeze([
  Object.freeze({ recipientId: DUNGEONQ_INCIDENT_RECIPIENT_OWNER, label: '使用者本人（M3 祕密檔設定的收件人）' })
]);
export const INCIDENT_NOTIFY_PREFIXES = Object.freeze({ NOTICE: '[DungeonQ 處置通知]', DRILL: '[DungeonQ 演練通知]' });
export const DUNGEONQ_APPROVAL_STATE_DIRECTORY = join(DUNGEONQ_PRIVATE_ROOT, 'approvals');

export const INCIDENT_WIRING_LIMITS = Object.freeze({
  /** 每個管道一次寄送的時限；M7 的 notifyTimeoutMs 必須容得下兩個管道依序嘗試（見 recommendedCloseLimits）。 */
  channelTimeoutMs: 4_500,
  maxSubjectLength: 200,
  maxBodyLength: 2_000,
  /** 每事件、每 UTC 日最多實際交給管道的次數（含失敗）；達上限一律 REJECTED。 */
  maxSendsPerIncident: 10,
  maxSendsPerDay: 20,
  maxLedgerEntries: 5_000,
  /** 候選核准：15 分鐘內最多 5 次失敗，之後一律拒絕到窗口過去。 */
  approvalMaxFailuresPerWindow: 5,
  approvalFailureWindowMs: 15 * 60_000,
  maxApprovalRecords: 500,
  maxStateBytes: 256 * 1024
});

/** M7 openIncidentClose 的 limits 建議值：通知時限＝兩個管道依序嘗試＋2 秒餘裕。 */
export function recommendedCloseLimits(limits = INCIDENT_WIRING_LIMITS) {
  return Object.freeze({ notifyTimeoutMs: 2 * limits.channelTimeoutMs + 2_000 });
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;
const CHANNEL_STATES = new Set(['ACCEPTED', 'RETRY', 'FAILED', 'UNKNOWN', 'QUOTA']);

const coded = (code, detail) => Object.assign(new Error(code), { code, ...(detail === undefined ? {} : { detail }) });
const insist = (condition, code) => { if (!condition) throw coded(code); };
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);

function limitsFrom(overrides = {}) {
  insist(isPlainObject(overrides), 'INCIDENT_WIRING_LIMITS_INVALID');
  for (const [key, value] of Object.entries(overrides)) {
    insist(Object.hasOwn(INCIDENT_WIRING_LIMITS, key) && Number.isSafeInteger(value) && value > 0, 'INCIDENT_WIRING_LIMITS_INVALID');
  }
  return Object.freeze({ ...INCIDENT_WIRING_LIMITS, ...overrides });
}

function privateDirectory(path) {
  insist(typeof path === 'string' && isAbsolute(path), 'INCIDENT_WIRING_DIRECTORY_INVALID');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  insist(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'INCIDENT_WIRING_DIRECTORY_NOT_PRIVATE');
  return path;
}

function appendDurable(path, value) {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify(value)}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeAtomic(path, text) {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    const descriptor = openSync(temporary, constants.O_RDONLY); try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** 讀取私人檔案（0600、一般檔、非連結）；不存在回 null。 */
function readPrivateFile(path, maxBytes) {
  let info;
  try { info = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw coded('INCIDENT_WIRING_STATE_UNREADABLE'); }
  insist(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.size <= maxBytes, 'INCIDENT_WIRING_STATE_NOT_PRIVATE');
  return readFileSync(path, 'utf8');
}

/** 有時限、遵守外層 signal 的呼叫；逾時或中止時對內層發出 abort，並以 UNKNOWN 結束（不重送）。 */
async function bounded(task, timeoutMs, outer) {
  const controller = new AbortController();
  let timer; let onAbort;
  try {
    return await Promise.race([
      Promise.resolve().then(() => task(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(coded('TIMEOUT')); }, timeoutMs);
        onAbort = () => { controller.abort(); reject(coded('ABORTED')); };
        if (outer?.aborted) onAbort(); else outer?.addEventListener('abort', onAbort, { once: true });
      })
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) outer?.removeEventListener('abort', onAbort);
  }
}

/** 單一工作佇列：同一個實例的呼叫依序執行，避免同一帳本被並行寫入。 */
function serial() {
  let tail = Promise.resolve();
  return task => {
    const run = tail.then(task, task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

/* ------------------------------------------------------------------ */
/* 通知（M7 第 4 步）                                                    */
/* ------------------------------------------------------------------ */

function channelsOf(sender) {
  insist(isPlainObject(sender) && isPlainObject(sender.notifier) && Array.isArray(sender.notifier.channels), 'INCIDENT_NOTIFY_SENDER_INVALID');
  const channels = sender.notifier.channels.map(channel => {
    insist(isPlainObject(channel) && typeof channel.name === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/u.test(channel.name)
      && ['PRIMARY', 'FALLBACK'].includes(channel.role) && typeof channel.send === 'function', 'INCIDENT_NOTIFY_SENDER_INVALID');
    return channel;
  });
  insist(channels.length <= 2 && new Set(channels.map(channel => channel.role)).size === channels.length, 'INCIDENT_NOTIFY_SENDER_INVALID');
  // 切換順序與 M3 入場告警相同：先主管道，再備援。
  return channels.sort((left, right) => (left.role === right.role ? 0 : left.role === 'PRIMARY' ? -1 : 1));
}

function recipientsOf(recipients) {
  insist(Array.isArray(recipients) && recipients.length === 1, 'INCIDENT_NOTIFY_RECIPIENTS_INVALID');
  const [entry] = recipients;
  insist(isPlainObject(entry) && typeof entry.recipientId === 'string' && IDENTIFIER.test(entry.recipientId), 'INCIDENT_NOTIFY_RECIPIENTS_INVALID');
  return new Set([entry.recipientId]);
}

function cleanLine(value) {
  return String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ' ');
}

/**
 * M7 的 notifier 介面：send({ incidentId, recipientId, idempotencyKey, subject, body, signal })
 * → { status: 'SENT', receiptId } 或 { status: 'REJECTED', code }；結果不明時丟出 NOTIFY_RESULT_UNKNOWN（M7 記為 UNKNOWN，不重寄）。
 *
 * @param {object} options
 * @param {ReturnType<typeof createDungeonqAlertSender>} options.sender M3 寄送器（測試用 createDungeonqAlertSender({ channels }) 注入假管道）。
 * @param {string} options.ledgerDirectory 通知帳本目錄（0700）；只存摘要、狀態與時間，不存內容或收件位址。
 * @param {{ recipientId: string }[]} [options.recipients] 登錄名單；v1 只能一筆（使用者本人）。
 * @param {'NOTICE'|'DRILL'} [options.prefix] 主旨前綴。
 * @param {string[]} [options.sensitiveValues] 只在記憶體比對的敏感原值；命中就拒絕寄送。
 */
export function createIncidentNotifier({ sender, ledgerDirectory, recipients = DUNGEONQ_INCIDENT_RECIPIENTS, prefix = 'NOTICE',
  sensitiveValues = [], clock = Date.now, limits: overrides } = {}) {
  const limits = limitsFrom(overrides);
  const channels = channelsOf(sender);
  const registered = recipientsOf(recipients);
  insist(Object.hasOwn(INCIDENT_NOTIFY_PREFIXES, prefix), 'INCIDENT_NOTIFY_PREFIX_INVALID');
  insist(Array.isArray(sensitiveValues) && sensitiveValues.every(value => typeof value === 'string'), 'INCIDENT_NOTIFY_SENSITIVE_VALUES_INVALID');
  insist(typeof clock === 'function', 'INCIDENT_NOTIFY_CLOCK_INVALID');
  const directory = privateDirectory(ledgerDirectory);
  const ledgerPath = join(directory, 'incident-notifications.jsonl');
  const entries = [];
  const existing = readPrivateFile(ledgerPath, limits.maxLedgerEntries * 1024);
  if (existing !== null) {
    insist(existing === '' || existing.endsWith('\n'), 'INCIDENT_NOTIFY_LEDGER_CORRUPT');
    for (const line of existing.split('\n').filter(Boolean)) {
      let entry; try { entry = JSON.parse(line); } catch { throw coded('INCIDENT_NOTIFY_LEDGER_CORRUPT'); }
      insist(isPlainObject(entry) && typeof entry.kind === 'string', 'INCIDENT_NOTIFY_LEDGER_CORRUPT');
      entries.push(entry);
    }
  }
  const record = entry => {
    insist(entries.length < limits.maxLedgerEntries, 'INCIDENT_NOTIFY_LEDGER_FULL');
    const value = { at: new Date(clock()).toISOString(), ...entry };
    appendDurable(ledgerPath, value);
    entries.push(value);
    return value;
  };
  const queue = serial();

  async function deliver({ incidentId, recipientId, idempotencyKey, subject, body, signal }) {
    insist(typeof incidentId === 'string' && IDENTIFIER.test(incidentId), 'INCIDENT_NOTIFY_INPUT_INVALID');
    insist(typeof idempotencyKey === 'string' && idempotencyKey.length > 0 && idempotencyKey.length <= 200, 'INCIDENT_NOTIFY_INPUT_INVALID');
    insist(signal === undefined || signal instanceof AbortSignal, 'INCIDENT_NOTIFY_INPUT_INVALID');
    const keyDigest = sha256(`dungeonq.incident-notify-key/v1\n${idempotencyKey}`);
    const refuse = code => { record({ kind: 'REFUSED', incidentId, recipientId: typeof recipientId === 'string' && IDENTIFIER.test(recipientId) ? recipientId : null, keyDigest, code }); return { status: 'REJECTED', code }; };
    // 收件人只來自登錄名單；名單外的代號不寄送、不轉成任何位址。
    if (typeof recipientId !== 'string' || !registered.has(recipientId)) return refuse('RECIPIENT_NOT_REGISTERED');
    // 同一冪等鍵：已送出就回同一張回執；結果不明或寄送中斷就不重送；只有明確被拒才允許人重跑時再試。
    const prior = entries.filter(entry => entry.keyDigest === keyDigest);
    const sent = prior.find(entry => entry.kind === 'OUTCOME' && entry.status === 'SENT');
    if (sent) return { status: 'SENT', receiptId: sent.receiptId };
    // 寄送中斷：最後一次 ATTEMPT 之後沒有 OUTCOME（例如程序在寄送途中結束），結果不明。
    let open = false;
    for (const entry of prior) {
      if (entry.kind === 'ATTEMPT') open = true;
      else if (entry.kind === 'OUTCOME') open = false;
    }
    if (open || prior.some(entry => entry.kind === 'OUTCOME' && entry.status === 'UNKNOWN')) throw coded('NOTIFY_RESULT_UNKNOWN');
    if (typeof subject !== 'string' || typeof body !== 'string' || subject.trim() === '' || body.trim() === ''
      || subject.length > limits.maxSubjectLength || body.length > limits.maxBodyLength) return refuse('NOTIFY_CONTENT_INVALID');
    const fullSubject = `${INCIDENT_NOTIFY_PREFIXES[prefix]} ${cleanLine(subject).trim()}`;
    const text = `${fullSubject}\n\n${cleanLine(body).replace(/\r\n?/gu, '\n')}`;
    if (checkSensitiveContent(`${fullSubject}\n${text}`, { sensitiveValues }).length > 0) return refuse('NOTIFY_CONTENT_SENSITIVE');
    if (channels.length === 0) return refuse('DELIVERY_NOT_CONFIGURED');
    const now = clock();
    const attempts = entries.filter(entry => entry.kind === 'ATTEMPT');
    if (attempts.filter(entry => entry.incidentId === incidentId).length + channels.length > limits.maxSendsPerIncident
      || attempts.filter(entry => utcDay(Date.parse(entry.at)) === utcDay(now)).length + channels.length > limits.maxSendsPerDay) {
      return refuse('NOTIFY_LIMIT_REACHED');
    }
    const messageDigest = sha256(`dungeonq.incident-notify-message/v1\n${canonicalJson({ subject: fullSubject, text })}`);
    let unknown = false;
    for (const channel of channels) {
      if (signal?.aborted) { unknown = true; break; }
      record({ kind: 'ATTEMPT', incidentId, recipientId, keyDigest, channel: channel.name, messageDigest });
      let state = 'UNKNOWN'; let receipt = null;
      try {
        const result = await bounded(inner => channel.send({ idempotencyKey: `${idempotencyKey}:${channel.name}`, subject: fullSubject, text },
          { signal: inner }), limits.channelTimeoutMs, signal);
        state = CHANNEL_STATES.has(result?.state) ? result.state : 'UNKNOWN';
        receipt = state === 'ACCEPTED' && typeof result.receiptId === 'string' && result.receiptId.length > 0 ? result.receiptId : null;
        if (state === 'ACCEPTED' && receipt === null) state = 'UNKNOWN';
      } catch {
        state = 'UNKNOWN';
      }
      record({ kind: 'RESULT', keyDigest, channel: channel.name, state, receiptDigest: receipt === null ? null : sha256(receipt) });
      if (state === 'ACCEPTED') {
        // 回執只代表已交給供應商；M7 的編號只收代號字元，所以只保存供應商回執的摘要。
        const receiptId = `notify:${channel.name}:${sha256(`${channel.name}\n${receipt}`).slice(0, 32)}`;
        record({ kind: 'OUTCOME', keyDigest, incidentId, status: 'SENT', channel: channel.name, receiptId });
        return { status: 'SENT', receiptId };
      }
      if (state === 'UNKNOWN') unknown = true;
      // 沒有回 ACCEPTED（被拒、結果不明、額度、暫時性錯誤）就改走下一個管道；同一管道不在這次呼叫內重送。
    }
    if (unknown) {
      record({ kind: 'OUTCOME', keyDigest, incidentId, status: 'UNKNOWN', code: 'NOTIFY_RESULT_UNKNOWN' });
      throw coded('NOTIFY_RESULT_UNKNOWN');
    }
    record({ kind: 'OUTCOME', keyDigest, incidentId, status: 'REJECTED', code: 'ALL_CHANNELS_FAILED' });
    return { status: 'REJECTED', code: 'ALL_CHANNELS_FAILED' };
  }

  return Object.freeze({
    version: INCIDENT_WIRING_VERSION,
    send: args => queue(() => deliver(isPlainObject(args) ? args : {})),
    /** 唯讀檢視：管道（名稱與角色）、登錄名單代號與帳本（只有摘要、狀態與時間）。 */
    inspect: Object.freeze({
      channels: () => channels.map(({ name, role }) => ({ name, role })),
      recipients: () => [...registered],
      entries: () => entries.map(entry => ({ ...entry })),
      ledgerPath
    })
  });
}

/* ------------------------------------------------------------------ */
/* 候選核准（5.3：真人核准）                                             */
/* ------------------------------------------------------------------ */

const APPROVAL_STATE_SCHEMA = 'dungeonq.incident-approval-state/v1';

/**
 * M7 候選目錄的 approval 介面：verify({ candidateId, candidateDigest, testsDigest, approval: { approvalId, proof }, signal })
 * → { verified, approverId, method, candidateDigest, testsDigest }（失敗時 { verified: false, reason }）。
 *
 * proof 必須是 { password, totp?, candidateDigest, testsDigest }：審查者看過的兩個摘要要與待核准的候選一致（綁定），
 * 身分以 M3 的 ACK 操作員帳號驗證（Argon2id 密碼；帳號啟用 TOTP 時必填，同一驗證碼步數不能重用）。
 *
 * @param {object} options
 * @param {string} [options.accountPath] M3 ACK 操作員帳號檔（0600）。
 * @param {string} options.stateDirectory 核准狀態目錄（0700）：TOTP 最後步數、失敗次數、核准紀錄；不存密碼或驗證碼。
 */
export function createIncidentApprovalVerifier({ accountPath = DUNGEONQ_ACK_ACCOUNT, stateDirectory, clock = Date.now, limits: overrides } = {}) {
  const limits = limitsFrom(overrides);
  insist(typeof accountPath === 'string' && isAbsolute(accountPath), 'INCIDENT_APPROVAL_ACCOUNT_PATH_INVALID');
  insist(typeof clock === 'function', 'INCIDENT_APPROVAL_CLOCK_INVALID');
  const directory = privateDirectory(stateDirectory);
  const statePath = join(directory, 'approval-state.json');
  const load = () => {
    const text = readPrivateFile(statePath, limits.maxStateBytes);
    if (text === null) return { schemaVersion: APPROVAL_STATE_SCHEMA, operators: {}, failures: [], approvals: [] };
    let state; try { state = JSON.parse(text); } catch { throw coded('INCIDENT_APPROVAL_STATE_CORRUPT'); }
    insist(state?.schemaVersion === APPROVAL_STATE_SCHEMA && isPlainObject(state.operators) && Array.isArray(state.failures)
      && Array.isArray(state.approvals), 'INCIDENT_APPROVAL_STATE_CORRUPT');
    return state;
  };
  const save = state => writeAtomic(statePath, `${JSON.stringify(state)}\n`);
  const queue = serial();

  async function check({ candidateId, candidateDigest, testsDigest, approval, signal }) {
    insist(signal === undefined || signal instanceof AbortSignal, 'INCIDENT_APPROVAL_INPUT_INVALID');
    const now = clock();
    const state = load();
    state.failures = state.failures.filter(at => Number.isFinite(at) && at > now - limits.approvalFailureWindowMs);
    const deny = (reason, counted = true) => {
      if (counted) state.failures.push(now);
      save(state);
      return { verified: false, reason };
    };
    if (state.failures.length >= limits.approvalMaxFailuresPerWindow) return deny('APPROVAL_RATE_LIMIT', false);
    if (typeof candidateId !== 'string' || !/^(?:rule|drill)-[a-f0-9]{16}$/u.test(candidateId) || !HEX64.test(candidateDigest ?? '')
      || !HEX64.test(testsDigest ?? '') || !isPlainObject(approval) || typeof approval.approvalId !== 'string' || !IDENTIFIER.test(approval.approvalId)) {
      return deny('APPROVAL_REQUEST_INVALID');
    }
    const proof = approval.proof;
    if (!isPlainObject(proof) || typeof proof.password !== 'string' || (proof.totp !== undefined && typeof proof.totp !== 'string')) {
      return deny('APPROVAL_PROOF_INVALID');
    }
    // 綁定：審查者確認的摘要必須就是這次要核准的候選與測試結果。
    if (proof.candidateDigest !== candidateDigest || proof.testsDigest !== testsDigest) return deny('DIGEST_BINDING_MISMATCH');
    const reused = state.approvals.find(row => row.approvalId === approval.approvalId);
    if (reused && (reused.candidateId !== candidateId || reused.candidateDigest !== candidateDigest || reused.testsDigest !== testsDigest)) {
      return deny('APPROVAL_ID_REUSED');
    }
    let account;
    try { account = loadAckAccountFile(accountPath); } catch { return deny('ACCOUNT_UNAVAILABLE', false); }
    if (signal?.aborted) throw coded('ABORTED');
    let passwordOk = false;
    try { passwordOk = await verifyPassword(proof.password, account.password); }
    catch (error) { if (error?.code === 'AUTH_CAPACITY') return deny('APPROVAL_RATE_LIMIT', false); passwordOk = false; }
    if (signal?.aborted) throw coded('ABORTED');
    if (!passwordOk) return deny('CREDENTIALS_INVALID');
    let step = null;
    if (account.totp) {
      const last = Number.isSafeInteger(state.operators[account.operatorId]?.lastTotpStep) ? state.operators[account.operatorId].lastTotpStep : -1;
      step = matchOtp(account.totp, proof.totp, clock(), last);
      if (step === null) return deny('TOTP_INVALID');
      state.operators[account.operatorId] = { lastTotpStep: step };
    }
    const method = account.totp ? 'PASSWORD_TOTP' : 'PASSWORD';
    state.approvals.push({ approvalId: approval.approvalId, candidateId, candidateDigest, testsDigest, approverId: account.operatorId, method,
      at: new Date(now).toISOString() });
    state.approvals = state.approvals.slice(-limits.maxApprovalRecords);
    save(state);
    return { verified: true, approverId: account.operatorId, method, candidateDigest, testsDigest };
  }

  return Object.freeze({
    version: INCIDENT_WIRING_VERSION,
    verify: args => queue(() => check(isPlainObject(args) ? args : {})),
    /** 唯讀：最近的核准紀錄與目前失敗次數（不含任何密碼或驗證碼）。 */
    inspect: Object.freeze({
      approvals: () => load().approvals.map(row => ({ ...row })),
      failures: () => load().failures.filter(at => at > clock() - limits.approvalFailureWindowMs).length,
      statePath
    })
  });
}

/**
 * 組出 M7 需要的兩個介面。寄送器預設是 M3 的正式寄送器（啟動時只檢查祕密檔屬性，寄送當下才由管道讀檔）。
 * @returns {{ notifier: ReturnType<typeof createIncidentNotifier>, approval: ReturnType<typeof createIncidentApprovalVerifier>, delivery: object }}
 */
export function createIncidentWiring({ caseDirectory, sender = createDungeonqAlertSender(), approvalStateDirectory = DUNGEONQ_APPROVAL_STATE_DIRECTORY,
  accountPath = DUNGEONQ_ACK_ACCOUNT, prefix = 'NOTICE', sensitiveValues = [], clock = Date.now, limits } = {}) {
  insist(typeof caseDirectory === 'string' && isAbsolute(caseDirectory), 'INCIDENT_WIRING_DIRECTORY_INVALID');
  return Object.freeze({
    notifier: createIncidentNotifier({ sender, ledgerDirectory: join(caseDirectory, 'notifications'), prefix, sensitiveValues, clock, limits }),
    approval: createIncidentApprovalVerifier({ accountPath, stateDirectory: approvalStateDirectory, clock, limits }),
    delivery: sender.delivery ?? null,
    closeLimits: recommendedCloseLimits(limitsFrom(limits))
  });
}

/* ------------------------------------------------------------------ */
/* 指令列                                                                */
/* ------------------------------------------------------------------ */

const CONFIG_STATE_TEXT = Object.freeze({ PRESENT: '已設定', MISSING: '找不到設定檔', NOT_PRIVATE: '設定檔權限不是 0600 或不是一般檔案',
  INVALID_PATH: '設定路徑不是絕對路徑', UNREADABLE: '無法檢查設定檔' });

const USAGE = `用法（需以 node --import tsx 執行，或 pnpm dungeonq:incident-wiring）：
  node --import tsx scripts/dungeonq-host/incident-wiring.mjs notify-status
      顯示 M3 寄送器的管道設定（只看祕密檔是否存在與權限，不讀內容、不寄送）。
  node --import tsx scripts/dungeonq-host/incident-wiring.mjs approve --case <案件目錄絕對路徑> --candidate <候選代號> [--account <帳號檔>] [--state <核准狀態目錄>]
      顯示候選摘要與測試結果，確認後以 ACK 操作員帳號（密碼不回顯；啟用 TOTP 時必填）核准候選。
結束碼：0 成功；1 失敗或未核准；2 參數錯誤。`;

async function approveCommand(values) {
  if (typeof values.case !== 'string' || !isAbsolute(values.case) || typeof values.candidate !== 'string'
    || !/^(?:rule|drill)-[a-f0-9]{16}$/u.test(values.candidate)
    || (values.account !== undefined && !isAbsolute(values.account)) || (values.state !== undefined && !isAbsolute(values.state))) {
    process.stderr.write(`${USAGE}\n`); return 2;
  }
  const store = openCandidateStore({ directory: join(resolve(values.case), 'candidates') });
  const status = store.status(values.candidate);
  const record = store.get(values.candidate);
  const out = text => process.stderr.write(`${text}\n`);
  out(`候選 ${values.candidate}（${status.kind === 'rules' ? '偵測規則' : '演練案例'}），狀態 ${status.state}`);
  out(`候選摘要：${record.candidateDigest}`);
  out(`測試摘要：${record.testsDigest ?? '（尚未測試）'}`);
  out(`測試結果：${status.tests?.passed === true ? '通過' : '未通過或未執行'}`);
  out(`候選內容：${canonicalJson(record.candidate).slice(0, 1_500)}`);
  if (status.state !== 'TESTED' || status.tests?.passed !== true) { out('只有測試通過（TESTED）的候選可以核准；未核准。'); return 1; }
  const accountPath = values.account ?? DUNGEONQ_ACK_ACCOUNT;
  let account;
  try { account = loadAckAccountFile(accountPath); } catch { out(`ACK 操作員帳號未設定或不符規則：${accountPath}（先執行 pnpm dungeonq:ack-operator enroll）`); return 1; }
  const confirm = await readHidden(`看過以上內容並核准，請輸入候選摘要的前 12 個字元（${record.candidateDigest.slice(0, 4)}…）：`);
  if (confirm.trim() !== record.candidateDigest.slice(0, 12)) { out('確認字元不符，未核准。'); return 1; }
  const password = await readHidden(`帳號 ${account.operatorId} 的密碼（不回顯）：`);
  const totp = account.totp ? await readHidden('驗證器 App 的 6 位數驗證碼：') : undefined;
  const verifier = createIncidentApprovalVerifier({ accountPath, stateDirectory: values.state ?? DUNGEONQ_APPROVAL_STATE_DIRECTORY });
  const approvalId = `approval-${randomBytes(8).toString('hex')}`;
  try {
    const approved = await store.approve(values.candidate, { approvalId, proof: { password, totp: totp?.trim(), candidateDigest: record.candidateDigest,
      testsDigest: record.testsDigest } }, { verifier });
    out(`已核准：${values.candidate} → ${approved.state}（核准者 ${approved.approval.approverId}，方式 ${approved.approval.method}，編號 ${approvalId}）。`);
    out('PUBLISHABLE 只代表可以由人發布；發布仍要依手冊第 8 節由人手動加入規則集或情境包。');
    return 0;
  } catch (error) {
    out(`未核准：${error?.code ?? 'APPROVAL_FAILED'}`);
    return 1;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { case: { type: 'string' }, candidate: { type: 'string' },
      account: { type: 'string' }, state: { type: 'string' } } }));
  } catch { process.stderr.write(`${USAGE}\n`); return 2; }
  if (command === 'notify-status') {
    const sender = createDungeonqAlertSender();
    const lines = [
      `寄送設定：${sender.delivery.configured ? '已接上' : '未接上（不會對外寄送）'}；主管道 Gmail ${CONFIG_STATE_TEXT[sender.delivery.primary] ?? sender.delivery.primary}、`
        + `備援 LINE ${CONFIG_STATE_TEXT[sender.delivery.fallback] ?? sender.delivery.fallback}（只檢查設定檔是否存在與權限，沒有讀內容、沒有寄送）。`,
      `登錄的通知對象：${DUNGEONQ_INCIDENT_RECIPIENTS.map(row => `${row.recipientId}（${row.label}）`).join('、')}。`,
      ...sender.delivery.notice
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return sender.delivery.configured ? 0 : 1;
  }
  if (command === 'approve') return approveCommand(values);
  process.stderr.write(`${USAGE}\n`); return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }, error => { process.stderr.write(`${error?.code ?? error?.message ?? 'FAILED'}\n`); process.exitCode = 1; });
}
