// DungeonQ 事件結束協調器（DQ-HANDOFF-015 M7，ExecPlan 第五部分 5.1，驗收 C-1～C-5）。
//
// 依固定順序執行六步：凍結（第 0 步）→ 封存證據 → 撤權 → FENCE 去留 → 通知被誤傷者 → 事後檢討。
// - 第 0 步在合法消費者仍運作、健康數字仍即時時，經政策封鎖仍 ACTIVE 的攻擊方 context 並讀回；接著停止世界的新變動，
//   最後停止合法消費者，之後才封存（M9 演練發現：封存要求 journal 靜止，封鎖要求即時健康，兩者不能同時成立）。
//   第 0 步只封鎖攻擊方，不撤任何合法憑證；「先封存再撤權」的原則不變。A-1 每事件上限 1 次：政策因上限拒絕時，
//   第 0 步為剩下的 context 產生 B 級工單（M6）並停下，由人封鎖後從第 0 步續跑；不繞過政策。
// - 每一步先讀回確認才進下一步；任何一步失敗就停在該步，寫入 STEP_FAILED 並回傳 HALTED（C-1）。
// - 已完成的步驟記在案件目錄的雜湊鏈事件紀錄（close-journal.jsonl），重跑時略過；失敗的步驟由人決定重跑，
//   每步最多 3 次。協調器本身沒有計時器、輪詢或自動重試；每個外部呼叫都有逾時，逾時記為結果不明並停止。
// - 外部系統一律經注入介面（ports）。執行環境沒有個別撤銷 API 的部分，由 revocation 介面提供；
//   通知與真人身分驗證由 M3 提供（測試用假實作）。本模組不寄信、不呼叫模型、不推送遠端。
// - 第 0 步封鎖仍為 ACTIVE 的事件 context 時，一律經處置動作政策（evaluateDungeonqResponseAction）判定，
//   再交給處置連接器執行；協調器不自行決定處置動作。第 2 步（撤權）不再封鎖 context：這時合法消費者已停止、
//   健康不再即時，仍為 ACTIVE 就停下（REVOKE_CONTEXT_STILL_ACTIVE），回到第 0 步處理。
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync,
  rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DUNGEONQ_RESPONSE_ACTION_CATALOG,
  DUNGEONQ_RESPONSE_ACTION_POLICY_VERSION,
  evaluateDungeonqResponseAction,
  getDungeonqResponseActionCatalogEntry
} from '../../packages/policy/src/dungeonq-response-action.ts';
import { attestManifest } from './evidence-sealer.mjs';
import { verifyEvidence, verifyManifestAttestations } from './evidence-verify.mjs';
import { buildDrillCandidate, buildIncidentTraces, buildLegitimateTraces, buildRuleCandidates, canonicalJson, checkReportFormat,
  checkSensitiveContent, digestOf, extractAttackPattern, INCIDENT_SEVERITIES, INCIDENT_VERDICTS, openCandidateStore, renderPostIncidentReport,
  ROOT_CAUSE_AREAS, sha256, TIMELINE_MILESTONES } from './incident-review.mjs';

export const INCIDENT_CLOSE_VERSION = 'dungeonq.incident-close/v1';
export const INCIDENT_CLOSE_STEPS = Object.freeze(['FREEZE', 'SEAL_EVIDENCE', 'REVOKE', 'FENCE_DISPOSITION', 'NOTIFY_AFFECTED', 'POST_INCIDENT_REVIEW']);
export const INCIDENT_CLOSE_LIMITS = Object.freeze({
  maxRunsPerStep: 3,
  portTimeoutMs: 10_000,
  sealTimeoutMs: 120_000,
  fenceTimeoutMs: 180_000,
  notifyTimeoutMs: 10_000,
  maxContexts: 16,
  maxRevocationItems: 256,
  maxRecipients: 64,
  maxArtifacts: 16,
  maxArtifactBytes: 16 * 1024 * 1024,
  maxTotalArtifactBytes: 64 * 1024 * 1024,
  maxJournalEntries: 2_000,
  maxTextLength: 1_000
});
export const REQUIRED_EVIDENCE_ARTIFACTS = Object.freeze(['runtime-journal', 'outbox', 'origin-witness', 'ticket-uses', 'legit-health']);
export const OPTIONAL_EVIDENCE_ARTIFACTS = Object.freeze(['ticket-ledger', 'response-ledger', 'work-orders', 'agent-tool-log']);
export const CASE_FILES = Object.freeze({
  input: 'close-input.json', journal: 'close-journal.jsonl', lock: 'close.lock', manifest: 'evidence-manifest.json',
  evidenceDirectory: 'evidence', report: 'post-incident-report.md', candidates: 'candidates', bundle: 'close-bundle.json'
});
export const INCIDENT_ISOLATION_MODES = Object.freeze(['LOCAL_PROOF_KERNEL', 'CONTAINER_ISOLATED']);
const MANIFEST_SCHEMA = 'dungeonq.incident-evidence-manifest/v1';
const BUNDLE_SCHEMA = 'dungeonq.incident-close-bundle/v1';
const ARTIFACT_SCHEMA = 'dungeonq.incident-evidence-artifact/v1';
const JOURNAL_DOMAIN = 'dungeonq-incident-close-journal/v1';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const ARTIFACT_NAME = /^[a-z][a-z0-9-]{1,63}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;
/** 結束流程以名稱挑選「封鎖 context」動作；是否允許由政策判定。 */
const FENCE_ACTION_NAME = 'FENCE_CONTEXT';
/**
 * A-1 已達上限時，剩下仍在運作的 context 交給人處理：以名稱挑選 B 級「停用帳號」動作，對象是登錄表中代表該 context
 * 參與者身分的帳號（assetId 為 context-account:<contextId>）。政策只會回 REQUIRE_APPROVAL，工單由 M6 產生，系統不執行。
 */
const HUMAN_FENCE_ACTION_NAME = 'DISABLE_ACCOUNT';
export const CONTEXT_ACCOUNT_ASSET_PREFIX = 'context-account:';
/** 已生效或可能已生效的 A 級動作狀態：都可能影響合法使用者，都要納入通知判斷。 */
const EFFECTIVE_STATUSES = new Set(['EXECUTED', 'ROLLED_BACK', 'ROLLBACK_FAILED', 'UNKNOWN']);
export const AFFECTED_REASONS = Object.freeze({
  CREDENTIAL_ROTATED: '業務憑證已輪替，舊憑證已失效',
  CONTEXT_FENCED: '你先前使用的工作階段被隔離',
  CONTEXT_REVOKED: '你先前使用的工作階段在事件結束時被撤銷',
  ROUTE_CHANGED: '部分請求曾被改道',
  PERMISSION_NARROWED: '部分權限曾被收回',
  RATE_LIMITED: '請求頻率曾被限制'
});
const AFFECTED_INSTRUCTIONS = Object.freeze({
  CREDENTIAL_ROTATED: '登錄的合法消費者會用自己的綁定值自動取得新憑證；若你的整合沒有自動換用，請以消費者綁定向受保護來源的憑證端點（/consumer/credential）取得新憑證，或聯絡下方窗口。',
  CONTEXT_FENCED: '舊的工作階段不會恢復；請經獨立的身分驗證重新取得新的工作階段。',
  CONTEXT_REVOKED: '舊的工作階段不會恢復；請經獨立的身分驗證重新取得新的工作階段。',
  ROUTE_CHANGED: '如果仍有請求被導到錯誤位置，請聯絡下方窗口確認並解除。',
  PERMISSION_NARROWED: '如果仍缺少需要的權限，請聯絡下方窗口確認並恢復。',
  RATE_LIMITED: '如果仍被限流，請聯絡下方窗口確認並解除。'
});

export class IncidentCloseError extends Error {
  constructor(code, detail) { super(code); this.name = 'IncidentCloseError'; this.code = code; if (detail !== undefined) this.detail = detail; }
}
const fail = (code, detail) => { throw new IncidentCloseError(code, detail); };
const insist = (condition, code, detail) => { if (!condition) fail(code, detail); };
const errorCode = error => (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(error.code) ? error.code : 'UNEXPECTED_ERROR');
const iso = ms => new Date(ms).toISOString();
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fileDigest = path => sha256(readFileSync(path));

/* ------------------------------------------------------------------ */
/* 檔案                                                                 */
/* ------------------------------------------------------------------ */

function privateDirectory(path, create = true) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  let stat; try { stat = lstatSync(path); } catch { return fail('CASE_DIRECTORY_UNAVAILABLE'); }
  insist(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'CASE_DIRECTORY_NOT_PRIVATE');
}
function writeAtomic(path, text) {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    const descriptor = openSync(temporary, constants.O_RDONLY); try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
function appendDurable(path, line) {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, `${line}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function acquireLock(directory) {
  const path = join(directory, CASE_FILES.lock); const body = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(path, body, { flag: 'wx', mode: 0o600 }); return () => { try { if (readFileSync(path, 'utf8') === body) rmSync(path); } catch { /* gone */ } }; }
    catch (error) {
      if (error.code !== 'EEXIST') fail('CASE_DIRECTORY_UNAVAILABLE');
      let pid = null; try { pid = JSON.parse(readFileSync(path, 'utf8')).pid; } catch { /* unreadable lock is stale */ }
      let alive = false;
      if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch (probe) { alive = probe.code === 'EPERM'; } }
      insist(!alive, 'CLOSE_ALREADY_RUNNING', { pid });
      rmSync(path, { force: true });
    }
  }
  return fail('CLOSE_ALREADY_RUNNING');
}

/* ------------------------------------------------------------------ */
/* 事件紀錄（雜湊鏈、只追加）                                             */
/* ------------------------------------------------------------------ */

const journalHash = entry => sha256(`${JOURNAL_DOMAIN}\n${canonicalJson(entry)}`);

/** 讀取並驗證事件紀錄的雜湊鏈；任何一列不連續或被改都回報第一個問題。 */
export function readCloseJournal(directory) {
  const path = join(directory, CASE_FILES.journal);
  if (!existsSync(path)) return { status: 'VALID', entries: [] };
  const text = readFileSync(path, 'utf8');
  if (text !== '' && !text.endsWith('\n')) return { status: 'BROKEN', entries: [], problem: { seq: null, reason: 'PARTIAL_LINE' } };
  const entries = []; let previous = 'ROOT';
  for (const [index, line] of text.split('\n').filter(Boolean).entries()) {
    let entry; try { entry = JSON.parse(line); } catch { return { status: 'BROKEN', entries, problem: { seq: index + 1, reason: 'UNPARSEABLE' } }; }
    const { hash, ...body } = entry;
    if (body.seq !== index + 1 || body.previous !== previous || journalHash(body) !== hash) {
      return { status: 'BROKEN', entries, problem: { seq: index + 1, reason: 'CHAIN_MISMATCH' } };
    }
    entries.push(entry); previous = hash;
  }
  return { status: 'VALID', entries };
}

function openJournal(directory, clock) {
  const loaded = readCloseJournal(directory);
  insist(loaded.status === 'VALID', 'CLOSE_JOURNAL_CORRUPT', loaded.problem);
  const entries = loaded.entries;
  return {
    entries,
    append(kind, fields = {}) {
      insist(entries.length < INCIDENT_CLOSE_LIMITS.maxJournalEntries, 'CLOSE_JOURNAL_LIMIT');
      insist(!['seq', 'at', 'kind', 'previous', 'hash'].some(key => Object.hasOwn(fields, key)), 'CLOSE_JOURNAL_FIELD_RESERVED');
      const body = { seq: entries.length + 1, at: iso(clock()), kind, ...fields, previous: entries.at(-1)?.hash ?? 'ROOT' };
      const entry = { ...body, hash: journalHash(body) };
      appendDurable(join(directory, CASE_FILES.journal), JSON.stringify(entry));
      entries.push(entry);
      return entry;
    }
  };
}

/** 由事件紀錄推出每一步的狀態與已完成步驟的結果。 */
export function summarizeCloseJournal(entries) {
  const steps = Object.fromEntries(INCIDENT_CLOSE_STEPS.map(step => [step, { state: 'PENDING', runs: 0, result: null, failure: null }]));
  let closed = false;
  for (const entry of entries) {
    const row = entry.step ? steps[entry.step] : undefined;
    if (entry.kind === 'STEP_STARTED' && row) { row.runs += 1; row.state = 'RUNNING'; }
    else if (entry.kind === 'STEP_DONE' && row) { row.state = 'DONE'; row.result = entry.result; row.failure = null; }
    else if (entry.kind === 'STEP_FAILED' && row) { row.state = 'FAILED'; row.failure = { code: entry.code, detail: entry.detail ?? null, at: entry.at }; }
    else if (entry.kind === 'CLOSED') closed = true;
  }
  // 中途中斷（有開始、沒有結果）視為失敗：結果不明，需要人決定重跑。
  for (const row of Object.values(steps)) if (row.state === 'RUNNING') { row.state = 'FAILED'; row.failure = { code: 'STEP_INTERRUPTED', detail: null, at: null }; }
  return { steps, closed };
}

/* ------------------------------------------------------------------ */
/* 結束輸入                                                              */
/* ------------------------------------------------------------------ */

function cleanText(value, field, sensitiveValues) {
  insist(typeof value === 'string' && value.trim().length > 0 && value.length <= INCIDENT_CLOSE_LIMITS.maxTextLength, 'CLOSE_INPUT_INVALID', { field });
  const findings = checkSensitiveContent(value, { sensitiveValues });
  insist(findings.length === 0, 'CLOSE_INPUT_SENSITIVE', { field, kinds: findings.map(item => item.kind) });
  return value.trim();
}

/**
 * 驗證結束輸入（由執行結束流程的人提供）。自由文字欄位命中憑證、ticket、個資樣式就拒絕，不自動遮蔽。
 * 回傳可保存的正規化輸入；sensitiveValues 只用來比對，不保存。
 */
export function normalizeCloseInput(input, { sensitiveValues = [] } = {}) {
  insist(isPlainObject(input), 'CLOSE_INPUT_INVALID');
  const allowed = ['incidentId', 'contexts', 'verdict', 'severity', 'identityConfirmed', 'isolation', 'closureReason', 'rootCause',
    'followUps', 'notification', 'drillSeed', 'humanDecisionAt', 'acknowledgement'];
  for (const key of Object.keys(input)) insist(allowed.includes(key), 'CLOSE_INPUT_INVALID', { field: key });
  const { incidentId, contexts, verdict, severity, identityConfirmed, isolation, rootCause, followUps = [], notification } = input;
  insist(typeof incidentId === 'string' && IDENTIFIER.test(incidentId), 'CLOSE_INPUT_INVALID', { field: 'incidentId' });
  insist(Array.isArray(contexts) && contexts.length >= 1 && contexts.length <= INCIDENT_CLOSE_LIMITS.maxContexts
    && new Set(contexts).size === contexts.length && contexts.every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id)),
  'CLOSE_INPUT_INVALID', { field: 'contexts' });
  insist(Object.hasOwn(INCIDENT_VERDICTS, verdict), 'CLOSE_INPUT_INVALID', { field: 'verdict' });
  insist(INCIDENT_SEVERITIES.includes(severity), 'CLOSE_INPUT_INVALID', { field: 'severity' });
  insist(typeof identityConfirmed === 'boolean', 'CLOSE_INPUT_INVALID', { field: 'identityConfirmed' });
  insist(INCIDENT_ISOLATION_MODES.includes(isolation), 'CLOSE_INPUT_INVALID', { field: 'isolation' });
  insist(input.closureReason === undefined || ['HUMAN', 'AUTO_SAFE_DEFAULT'].includes(input.closureReason), 'CLOSE_INPUT_INVALID', { field: 'closureReason' });
  insist(isPlainObject(rootCause), 'CLOSE_INPUT_INVALID', { field: 'rootCause' });
  const normalizedRootCause = Object.fromEntries(ROOT_CAUSE_AREAS.map(area => {
    const row = rootCause[area.key];
    insist(isPlainObject(row) && Object.keys(row).every(key => ['finding', 'improvement', 'owner'].includes(key)), 'CLOSE_INPUT_INVALID', { field: `rootCause.${area.key}` });
    return [area.key, { finding: cleanText(row.finding, `rootCause.${area.key}.finding`, sensitiveValues),
      improvement: cleanText(row.improvement, `rootCause.${area.key}.improvement`, sensitiveValues),
      owner: cleanText(row.owner, `rootCause.${area.key}.owner`, sensitiveValues) }];
  }));
  insist(Array.isArray(followUps) && followUps.length <= 20, 'CLOSE_INPUT_INVALID', { field: 'followUps' });
  const normalizedFollowUps = followUps.map((row, index) => {
    insist(isPlainObject(row) && Object.keys(row).every(key => ['item', 'owner', 'due'].includes(key)), 'CLOSE_INPUT_INVALID', { field: `followUps[${index}]` });
    insist(row.due === undefined || (typeof row.due === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(row.due)), 'CLOSE_INPUT_INVALID', { field: `followUps[${index}].due` });
    return { item: cleanText(row.item, `followUps[${index}].item`, sensitiveValues), owner: cleanText(row.owner, `followUps[${index}].owner`, sensitiveValues),
      ...(row.due ? { due: row.due } : {}) };
  });
  insist(isPlainObject(notification) && isPlainObject(notification.directory), 'CLOSE_INPUT_INVALID', { field: 'notification' });
  const { legitimateConsumers = [], flaggedSubjectOwners = [] } = notification.directory;
  const recipient = value => typeof value === 'string' && IDENTIFIER.test(value) && checkSensitiveContent(value, { sensitiveValues }).length === 0;
  insist(Array.isArray(legitimateConsumers) && legitimateConsumers.every(row => isPlainObject(row) && recipient(row.recipientId)
    && typeof row.consumerId === 'string' && IDENTIFIER.test(row.consumerId)), 'CLOSE_INPUT_INVALID', { field: 'notification.directory.legitimateConsumers' });
  insist(Array.isArray(flaggedSubjectOwners) && flaggedSubjectOwners.every(row => isPlainObject(row) && recipient(row.recipientId)
    && typeof row.subject === 'string' && /^(?:context|source):[A-Za-z0-9_-]{1,128}$/u.test(row.subject)), 'CLOSE_INPUT_INVALID',
  { field: 'notification.directory.flaggedSubjectOwners' });
  insist(input.drillSeed === undefined || (Number.isSafeInteger(input.drillSeed) && input.drillSeed >= 0 && input.drillSeed <= 0xFFFFFFFF),
    'CLOSE_INPUT_INVALID', { field: 'drillSeed' });
  insist(input.humanDecisionAt === undefined || Number.isFinite(Date.parse(input.humanDecisionAt)), 'CLOSE_INPUT_INVALID', { field: 'humanDecisionAt' });
  const acknowledgement = input.acknowledgement;
  insist(acknowledgement === undefined || (isPlainObject(acknowledgement) && Number.isFinite(Date.parse(acknowledgement.at))
    && typeof acknowledgement.verified === 'boolean'), 'CLOSE_INPUT_INVALID', { field: 'acknowledgement' });
  return { schemaVersion: INCIDENT_CLOSE_VERSION, incidentId, contexts: [...contexts], verdict, severity, identityConfirmed, isolation,
    closureReason: input.closureReason ?? 'HUMAN', rootCause: normalizedRootCause, followUps: normalizedFollowUps,
    notification: { contact: cleanText(notification.contact, 'notification.contact', sensitiveValues),
      directory: { legitimateConsumers: legitimateConsumers.map(row => ({ recipientId: row.recipientId, consumerId: row.consumerId })),
        flaggedSubjectOwners: flaggedSubjectOwners.map(row => ({ recipientId: row.recipientId, subject: row.subject })) } },
    ...(input.drillSeed === undefined ? {} : { drillSeed: input.drillSeed }),
    ...(input.humanDecisionAt === undefined ? {} : { humanDecisionAt: new Date(input.humanDecisionAt).toISOString() }),
    ...(acknowledgement === undefined ? {} : { acknowledgement: { at: new Date(acknowledgement.at).toISOString(), verified: acknowledgement.verified } }) };
}

/* ------------------------------------------------------------------ */
/* 外部呼叫                                                              */
/* ------------------------------------------------------------------ */

/** 呼叫注入介面：一定有逾時，逾時或例外都轉成停止碼，不重試。 */
async function callPort(name, fn, args, timeoutMs, outer) {
  insist(typeof fn === 'function', 'PORT_NOT_CONFIGURED', { port: name });
  const controller = new AbortController(); let timer;
  const onAbort = () => controller.abort();
  outer?.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn({ ...args, signal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new IncidentCloseError('PORT_TIMEOUT', { port: name })); }, timeoutMs); })
    ]);
  } catch (error) {
    if (error instanceof IncidentCloseError) throw error;
    return fail('PORT_FAILED', { port: name, code: errorCode(error) });
  } finally { clearTimeout(timer); outer?.removeEventListener('abort', onAbort); }
}

/* ------------------------------------------------------------------ */
/* 決策規則                                                              */
/* ------------------------------------------------------------------ */

/**
 * 5.1 第 3 步：FENCE 去留。代理身分未確認、相關憑證未撤銷、有任何真實資產讀取、證據未封存時保留；
 * 誤判時舊 context 一律保留，合法使用者以新的獨立驗證取得新 context。
 * v1 不解除任何 FENCE（執行環境的 FENCE 不可回復，也沒有解除介面）：RELEASE_ELIGIBLE 只表示「圍堵已不再需要」。
 */
export function decideFenceDisposition({ verdict, identityConfirmed, credentialsRevoked, realAssetReads, evidenceSealed }) {
  const reasons = [];
  if (identityConfirmed !== true) reasons.push('IDENTITY_UNCONFIRMED');
  if (credentialsRevoked !== true) reasons.push('CREDENTIALS_NOT_REVOKED');
  if (!(Number.isSafeInteger(realAssetReads) && realAssetReads === 0)) reasons.push('REAL_ASSET_READ');
  if (evidenceSealed !== true) reasons.push('EVIDENCE_NOT_SEALED');
  if (verdict === 'FALSE_POSITIVE') reasons.push('FALSE_POSITIVE_OLD_CONTEXT_STAYS_ISOLATED');
  const decision = reasons.length > 0 ? 'KEEP' : 'RELEASE_ELIGIBLE';
  return { decision, reasons: reasons.length ? reasons : ['ALL_RELEASE_CONDITIONS_MET'], applied: 'NONE',
    note: decision === 'KEEP' ? null : 'RUNTIME_FENCE_IRREVERSIBLE_CONTEXT_STAYS_FENCED',
    legitimateRecovery: verdict === 'FALSE_POSITIVE' ? 'NEW_CONTEXT_AFTER_INDEPENDENT_VERIFICATION' : null };
}

/** 依事件的 A 級動作與結論，找出受影響的合法使用者（只用登錄的通訊錄）。 */
export function deriveAffectedRecipients({ actions, verdict, directory, contexts = [] }) {
  const reasons = new Map();
  const add = (recipientId, reason) => { if (!reasons.has(recipientId)) reasons.set(recipientId, new Set()); reasons.get(recipientId).add(reason); };
  const ownersOf = subject => directory.flaggedSubjectOwners.filter(row => row.subject === subject).map(row => row.recipientId);
  const falsePositive = verdict === 'FALSE_POSITIVE';
  // 誤判：事件 context 在結束時一律撤銷且不恢復，context 的擁有者都要收到通知。
  if (falsePositive) for (const contextId of contexts) for (const id of ownersOf(`context:${contextId}`)) add(id, 'CONTEXT_REVOKED');
  for (const action of actions) {
    if (!EFFECTIVE_STATUSES.has(action.status)) continue;
    const name = getDungeonqResponseActionCatalogEntry(action.actionCode)?.name ?? null;
    if (name === 'ROTATE_CREDENTIAL_WITH_OVERLAP') for (const row of directory.legitimateConsumers) add(row.recipientId, 'CREDENTIAL_ROTATED');
    if (!falsePositive) continue;
    if (name === FENCE_ACTION_NAME) for (const id of ownersOf(action.assetId)) add(id, 'CONTEXT_FENCED');
    else if (name === 'REROUTE_FLAGGED_PATH') for (const row of directory.flaggedSubjectOwners) add(row.recipientId, 'ROUTE_CHANGED');
    else if (name === 'NARROW_FLAGGED_PERMISSION') {
      const match = /^grant:((?:context|source):[A-Za-z0-9_-]{1,128}):[A-Za-z]+$/u.exec(action.assetId);
      if (match) for (const id of ownersOf(match[1])) add(id, 'PERMISSION_NARROWED');
    } else if (name === 'RATE_LIMIT_FLAGGED') for (const id of ownersOf(action.assetId)) add(id, 'RATE_LIMITED');
  }
  return [...reasons].map(([recipientId, set]) => ({ recipientId, reasons: Object.keys(AFFECTED_REASONS).filter(key => set.has(key)) }))
    .sort((left, right) => left.recipientId.localeCompare(right.recipientId));
}

/** 通知內容：發生什麼、需要做什麼、如何取得新憑證、聯絡誰。不含任何機密。 */
export function composeAffectedNotification({ incidentId, reasons, contact }) {
  const subject = `DungeonQ 事件 ${incidentId} 處置通知`;
  const body = [
    `發生什麼：事件 ${incidentId} 處理期間，系統為保護服務做了以下調整：${reasons.map(reason => AFFECTED_REASONS[reason]).join('；')}。`,
    `需要做什麼：${[...new Set(reasons.map(reason => AFFECTED_INSTRUCTIONS[reason]))].join(' ')}`,
    `聯絡窗口：${contact}。`,
    '本通知不含任何憑證或機密；任何人都不會要求你回覆密碼或憑證。'
  ].join('\n');
  return { subject, body };
}

/* ------------------------------------------------------------------ */
/* 案件驗證（外部驗證端）                                                 */
/* ------------------------------------------------------------------ */

const safeRelative = path => typeof path === 'string' && /^(?:evidence|candidates\/(?:rules|drills))\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$|^post-incident-report\.md$/u.test(path);

/**
 * 外部驗證端：只用公鑰、錨點倉庫、唯讀資料庫與案件目錄。檢查
 * (1) 每個證據檔與 manifest 的摘要一致；(2) journal 與已簽檢查點一致、封存範圍涵蓋 manifest 的 journal 位置；
 * (3) manifest 摘要等於最新的已簽聲明；(4) 有結案封存時，報告、候選與事件紀錄前綴與已簽聲明一致；(5) 事件紀錄雜湊鏈完整。
 * 永不寫入。
 */
export async function verifyIncidentCase({ directory, db, publicKey, anchorRepo, ref = 'HEAD', gitTimeoutMs = 30_000, dbTimeoutMs = 2_000 }) {
  const findings = [];
  const add = (kind, detail) => findings.push(detail === undefined ? { kind } : { kind, ...detail });
  let manifest; let manifestDigest;
  try {
    const bytes = readFileSync(join(directory, CASE_FILES.manifest));
    manifestDigest = sha256(bytes); manifest = JSON.parse(bytes.toString('utf8'));
  } catch { return { verdict: 'INCOMPLETE', findings: [{ kind: 'MANIFEST_MISSING' }], evidenceIntegrity: 'UNVERIFIED' }; }
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA || !Array.isArray(manifest.artifacts) || !isPlainObject(manifest.journal)) {
    return { verdict: 'TAMPERED', findings: [{ kind: 'MANIFEST_INVALID' }], evidenceIntegrity: 'UNVERIFIED' };
  }
  for (const artifact of manifest.artifacts) {
    if (!safeRelative(artifact?.path) || !artifact.path.startsWith(`${CASE_FILES.evidenceDirectory}/`)) { add('ARTIFACT_PATH_INVALID', { name: artifact?.name ?? null }); continue; }
    let digest = null; try { digest = fileDigest(join(directory, artifact.path)); } catch { digest = null; }
    if (digest !== artifact.sha256) add('ARTIFACT_DIGEST_MISMATCH', { name: artifact.name });
  }
  const journal = await verifyEvidence({ db, publicKey, anchorRepo, ref, dbTimeoutMs, gitTimeoutMs });
  if (journal.verdict !== 'VERIFIED') add(`JOURNAL_${journal.verdict}`, journal.firstMismatch ? { firstMismatch: journal.firstMismatch } : undefined);
  else if (journal.sealedThroughSequence < manifest.journal.sequence) add('JOURNAL_NOT_SEALED_THROUGH_MANIFEST');
  const evidence = await verifyManifestAttestations({ publicKey, anchorRepo, ref, incidentId: manifest.incidentId, kind: 'EVIDENCE', manifestDigest,
    journalSequence: manifest.journal.sequence, journalHead: manifest.journal.head, gitTimeoutMs });
  if (evidence.verdict !== 'VERIFIED') add(`MANIFEST_${evidence.verdict}`, evidence.problem ? { problem: evidence.problem } : undefined);
  const closeJournal = readCloseJournal(directory);
  if (closeJournal.status !== 'VALID') add('CLOSE_JOURNAL_CHAIN_BROKEN', { problem: closeJournal.problem });
  let closeRecord = { status: 'NOT_SEALED' };
  if (existsSync(join(directory, CASE_FILES.bundle))) {
    let bundle; let bundleDigest;
    try { const bytes = readFileSync(join(directory, CASE_FILES.bundle)); bundleDigest = sha256(bytes); bundle = JSON.parse(bytes.toString('utf8')); }
    catch { bundle = null; }
    if (bundle?.schemaVersion !== BUNDLE_SCHEMA || !Array.isArray(bundle.files) || bundle.evidenceManifestDigest !== manifestDigest
      || !isPlainObject(bundle.closeJournal) || !Number.isSafeInteger(bundle.closeJournal.entries) || bundle.closeJournal.entries < 1) add('CLOSE_BUNDLE_INVALID');
    else {
      for (const file of bundle.files) {
        if (!safeRelative(file?.path)) { add('CLOSE_FILE_PATH_INVALID'); continue; }
        let digest = null; try { digest = fileDigest(join(directory, file.path)); } catch { digest = null; }
        if (digest !== file.sha256) add('CLOSE_FILE_DIGEST_MISMATCH', { path: file.path });
      }
      const covered = closeJournal.entries[bundle.closeJournal.entries - 1];
      if (!covered || covered.hash !== bundle.closeJournal.lastHash) add('CLOSE_JOURNAL_PREFIX_MISMATCH');
      const attested = await verifyManifestAttestations({ publicKey, anchorRepo, ref, incidentId: manifest.incidentId, kind: 'CLOSE_RECORD',
        manifestDigest: bundleDigest, gitTimeoutMs });
      if (attested.verdict !== 'VERIFIED') add(`CLOSE_RECORD_${attested.verdict}`, attested.problem ? { problem: attested.problem } : undefined);
      closeRecord = { status: attested.verdict, attestation: attested.attestation ?? null, evidenceIntegrity: attested.evidenceIntegrity ?? 'UNVERIFIED' };
    }
  }
  const integrity = [journal.evidenceIntegrity, evidence.evidenceIntegrity, ...(closeRecord.evidenceIntegrity ? [closeRecord.evidenceIntegrity] : [])];
  const evidenceIntegrity = findings.length ? 'UNVERIFIED'
    : integrity.every(value => value === 'EXTERNALLY_ANCHORED') ? 'EXTERNALLY_ANCHORED' : 'SAME_HOST_SELF_ATTESTED';
  return { verdict: findings.length ? 'TAMPERED' : 'VERIFIED', incidentId: manifest.incidentId, manifestDigest, findings,
    journal: { verdict: journal.verdict, sealedThroughSequence: journal.sealedThroughSequence ?? null, unsealedEvents: journal.unsealedEvents ?? null },
    evidenceAttestation: evidence.attestation ?? null, closeRecord, evidenceIntegrity };
}

/** M1 封存程序與驗證器組成的 sealer 介面（預設實作）。 */
export function createM1SealerPort({ db, sealDir, anchorRepo, publicKeyPath, label = null, remote = null, gitTimeoutMs = 30_000, dbTimeoutMs = 2_000,
  pushRetries = 3, pushBackoffMs = 2_000 }) {
  const config = { db, sealDir, anchorRepo, label, remote, gitTimeoutMs, dbTimeoutMs, pushRetries, pushBackoffMs };
  return Object.freeze({
    attest: ({ incidentId, kind, manifestDigest, journalSequence, journalHead }) =>
      attestManifest(config, { incidentId, kind, manifestDigest, journalSequence, journalHead }),
    verify: ({ caseDirectory }) => verifyIncidentCase({ directory: caseDirectory, db, publicKey: publicKeyPath, anchorRepo, gitTimeoutMs, dbTimeoutMs })
  });
}

/* ------------------------------------------------------------------ */
/* 六個步驟（第 0 步凍結＋5.1 的五步）                                     */
/* ------------------------------------------------------------------ */

function validJournalPosition(value) {
  return isPlainObject(value) && Number.isSafeInteger(value.journalSequence) && value.journalSequence >= 0
    && typeof value.journalHead === 'string' && HEX64.test(value.journalHead);
}

async function sealEvidence(context) {
  const { caseInput, ports, directory, journal, limits, signal } = context;
  const scope = { incidentId: caseInput.incidentId, contexts: caseInput.contexts };
  await callPort('world.freeze', ports.world?.freeze, scope, limits.portTimeoutMs, signal);
  const before = await callPort('world.readFreeze', ports.world?.readFreeze, scope, limits.portTimeoutMs, signal);
  insist(before?.frozen === true && validJournalPosition(before), 'WORLD_FREEZE_NOT_CONFIRMED');
  journal.append('READBACK', { step: 'SEAL_EVIDENCE', check: 'WORLD_FROZEN', journalSequence: before.journalSequence, journalHead: before.journalHead });
  const collected = await callPort('evidence.collect', ports.evidence?.collect, scope, limits.sealTimeoutMs, signal);
  insist(isPlainObject(collected) && Array.isArray(collected.artifacts) && collected.artifacts.length <= limits.maxArtifacts, 'EVIDENCE_COLLECTION_INVALID');
  const names = collected.artifacts.map(artifact => artifact?.name);
  insist(names.every(name => typeof name === 'string' && ARTIFACT_NAME.test(name)) && new Set(names).size === names.length, 'EVIDENCE_COLLECTION_INVALID');
  const missing = REQUIRED_EVIDENCE_ARTIFACTS.filter(name => !names.includes(name));
  insist(missing.length === 0, 'EVIDENCE_ARTIFACT_MISSING', { missing });
  const realAssetReads = collected.facts?.realAssetReads;
  insist(Number.isSafeInteger(realAssetReads) && realAssetReads >= 0, 'EVIDENCE_FACTS_INVALID');
  const evidenceDirectory = join(directory, CASE_FILES.evidenceDirectory); privateDirectory(evidenceDirectory);
  let total = 0; const entries = [];
  for (const artifact of collected.artifacts) {
    const text = `${canonicalJson({ schemaVersion: ARTIFACT_SCHEMA, name: artifact.name, incidentId: caseInput.incidentId, data: artifact.data ?? null })}\n`;
    const bytes = Buffer.byteLength(text); total += bytes;
    insist(bytes <= limits.maxArtifactBytes && total <= limits.maxTotalArtifactBytes, 'EVIDENCE_TOO_LARGE', { name: artifact.name });
    const path = `${CASE_FILES.evidenceDirectory}/${artifact.name}.json`;
    writeAtomic(join(directory, path), text);
    entries.push({ name: artifact.name, path, sha256: sha256(text), bytes });
  }
  const after = await callPort('world.readFreeze', ports.world.readFreeze, scope, limits.portTimeoutMs, signal);
  insist(validJournalPosition(after) && after.journalSequence === before.journalSequence && after.journalHead === before.journalHead,
    'WORLD_CHANGED_DURING_EXPORT', { before: before.journalSequence, after: after?.journalSequence ?? null });
  const manifest = { schemaVersion: MANIFEST_SCHEMA, incidentId: caseInput.incidentId, createdAt: iso(context.clock()), isolation: caseInput.isolation,
    contexts: caseInput.contexts, journal: { sequence: before.journalSequence, head: before.journalHead }, facts: { realAssetReads }, artifacts: entries };
  const manifestText = `${canonicalJson(manifest)}\n`;
  writeAtomic(join(directory, CASE_FILES.manifest), manifestText);
  const manifestDigest = sha256(manifestText);
  journal.append('EVIDENCE_EXPORTED', { step: 'SEAL_EVIDENCE', manifestDigest, artifacts: entries.map(({ name, sha256: digest }) => ({ name, sha256: digest })) });
  const attested = await callPort('sealer.attest', ports.sealer?.attest, { incidentId: caseInput.incidentId, kind: 'EVIDENCE', manifestDigest,
    journalSequence: before.journalSequence, journalHead: before.journalHead }, limits.sealTimeoutMs, signal);
  insist(attested?.status === 'ATTESTED', 'EVIDENCE_SEAL_FAILED', { code: attested?.code ?? null });
  const verified = await callPort('sealer.verify', ports.sealer.verify, { caseDirectory: directory, incidentId: caseInput.incidentId }, limits.sealTimeoutMs, signal);
  insist(verified?.verdict === 'VERIFIED' && verified.manifestDigest === manifestDigest, 'EVIDENCE_VERIFY_FAILED',
    { verdict: verified?.verdict ?? null, findings: (verified?.findings ?? []).map(item => item.kind) });
  return { manifestDigest, journalSequence: before.journalSequence, journalHead: before.journalHead, attestationDigest: attested.attestation.digest,
    checkpointDigest: attested.attestation.checkpointDigest, evidenceIntegrity: verified.evidenceIntegrity, facts: { realAssetReads },
    artifacts: entries.length };
}

function validateInventory(value) {
  insist(isPlainObject(value) && Array.isArray(value.items) && value.items.length <= INCIDENT_CLOSE_LIMITS.maxRevocationItems, 'REVOCATION_INVENTORY_INVALID');
  const ids = new Set();
  for (const item of value.items) {
    insist(isPlainObject(item) && typeof item.itemId === 'string' && ITEM_ID.test(item.itemId) && !ids.has(item.itemId)
      && typeof item.kind === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(item.kind) && ['ACTIVE', 'REVOKED'].includes(item.state),
    'REVOCATION_INVENTORY_INVALID', { itemId: item?.itemId ?? null });
    ids.add(item.itemId);
  }
  return value.items;
}

/** 處置連接器介面（第 0 步與通知、報告共用）。 */
function responsePort(ports) {
  const response = ports.response;
  insist(response?.connector && typeof response.registry === 'function' && typeof response.health?.measure === 'function'
    && isPlainObject(response.signal), 'RESPONSE_PORT_NOT_CONFIGURED');
  return response;
}

/** 健康量測只保留判斷新舊與樣本數需要的欄位，寫進事件紀錄，供事後確認判定時的健康數字是即時的。 */
const healthFacts = (measurement, evaluatedAt) => ({ measuredAt: typeof measurement?.measuredAt === 'string' ? measurement.measuredAt : null,
  sampleCount: Number.isSafeInteger(measurement?.sampleCount) ? measurement.sampleCount : null, evaluatedAt,
  ageMs: typeof measurement?.measuredAt === 'string' ? Date.parse(evaluatedAt) - Date.parse(measurement.measuredAt) : null });

/**
 * 第 0 步：事件 context 仍為 ACTIVE 時，經處置動作政策判定後由處置連接器封鎖；協調器不自行執行。
 * 回傳是否已執行並讀回生效，以及政策是否因上限拒絕（交給人處理）。拒絕時仍交給連接器，由連接器履行拒絕稽核與升級義務。
 */
async function fenceThroughPolicy(context, item) {
  const { caseInput, ports, clock, limits, signal, journal } = context;
  const response = responsePort(ports);
  const incidentId = caseInput.incidentId;
  const entry = DUNGEONQ_RESPONSE_ACTION_CATALOG.actions.find(row => row.name === FENCE_ACTION_NAME);
  insist(entry, 'FENCE_ACTION_NOT_IN_CATALOG');
  const registry = response.registry();
  const target = registry.entries.find(row => entry.targetKinds.includes(row.kind) && row.assetId === `context:${item.contextId}`
    && (row.boundIncidentId === null || row.boundIncidentId === incidentId));
  insist(target, 'FREEZE_CONTEXT_NOT_REGISTERED', { contextId: item.contextId });
  const evaluatedAt = iso(clock());
  const legitimateHealth = await callPort('response.health.measure', response.health.measure, { sinceMs: clock() - 10_000 }, limits.portTimeoutMs, signal);
  const input = { policyVersion: DUNGEONQ_RESPONSE_ACTION_POLICY_VERSION, traceId: `close-${digestOf('close-trace', { incidentId, contextId: item.contextId }).slice(0, 24)}`,
    evaluatedAt, incidentId, signal: response.signal, actionCode: entry.code, targetId: target.targetId,
    parameters: { rateLimitDurationSeconds: entry.limits.maxDurationSeconds === null ? null : 3600 }, targetRegistry: registry,
    ...response.connector.policyInputState({ incidentId, evaluatedAt }), legitimateHealth };
  const decision = evaluateDungeonqResponseAction(input);
  journal.append('POLICY_DECISION', { step: 'FREEZE', purpose: 'EXECUTE_A_CLASS', contextId: item.contextId, actionCode: decision.actionCode,
    effect: decision.effect, reason: decision.reason, decisionDigest: decision.decisionDigest, healthStatus: decision.healthStatus,
    health: healthFacts(legitimateHealth, evaluatedAt) });
  const request = { incidentId, actionCode: entry.code, targetId: target.targetId };
  const expectedState = await callPort('response.readTargetState', () => response.connector.readTargetState(request), {}, limits.portTimeoutMs, signal);
  const result = await callPort('response.execute', () => response.connector.execute({ decision, input, request, expectedState }), {}, limits.fenceTimeoutMs, signal);
  journal.append('FREEZE_FENCE', { step: 'FREEZE', contextId: item.contextId, status: result?.status ?? null, readback: result?.readback ?? null,
    actionId: result?.actionId ?? null });
  return { executed: result?.status === 'EXECUTED' && result.readback === 'CONFIRMED',
    // 「超過上限」由政策判定；這裡只依政策的原因代碼決定要不要轉給人，不自行計數。
    limitReached: typeof decision.reason === 'string' && decision.reason.startsWith('limit_exceeded:'),
    decision, status: result?.status ?? null, resultReason: typeof result?.reason === 'string' ? result.reason.slice(0, 120) : null };
}

/**
 * A-1 已達上限、仍有 context 在運作時：每個剩下的 context 經政策判定 B 級「停用帳號」（REQUIRE_APPROVAL），
 * 由 M6 產生工單請人處理。協調器不執行任何 B 級步驟，也不繞過政策另行封鎖。
 */
async function requestHumanFence(context, items) {
  const { caseInput, ports, clock, limits, signal, journal, sensitiveValues } = context;
  const response = responsePort(ports);
  const incidentId = caseInput.incidentId;
  const contexts = items.map(item => item.contextId);
  insist(typeof ports.workOrders?.create === 'function', 'FREEZE_WORK_ORDER_PORT_NOT_CONFIGURED', { contexts });
  const entry = DUNGEONQ_RESPONSE_ACTION_CATALOG.actions.find(row => row.name === HUMAN_FENCE_ACTION_NAME);
  insist(entry, 'HUMAN_FENCE_ACTION_NOT_IN_CATALOG');
  const registry = response.registry();
  const created = [];
  for (const item of items) {
    const target = registry.entries.find(row => entry.targetKinds.includes(row.kind) && row.assetId === `${CONTEXT_ACCOUNT_ASSET_PREFIX}${item.contextId}`
      && (row.boundIncidentId === null || row.boundIncidentId === incidentId));
    insist(target, 'FREEZE_HUMAN_TARGET_NOT_REGISTERED', { contextId: item.contextId, contexts });
    const evaluatedAt = iso(clock());
    const legitimateHealth = await callPort('response.health.measure', response.health.measure, { sinceMs: clock() - 10_000 }, limits.portTimeoutMs, signal);
    const input = { policyVersion: DUNGEONQ_RESPONSE_ACTION_POLICY_VERSION,
      traceId: `close-wo-${digestOf('close-work-order-trace', { incidentId, contextId: item.contextId }).slice(0, 24)}`,
      evaluatedAt, incidentId, signal: response.signal, actionCode: entry.code, targetId: target.targetId, parameters: { rateLimitDurationSeconds: null },
      targetRegistry: registry, ...response.connector.policyInputState({ incidentId, evaluatedAt }), legitimateHealth };
    const decision = evaluateDungeonqResponseAction(input);
    journal.append('POLICY_DECISION', { step: 'FREEZE', purpose: 'CREATE_WORK_ORDER', contextId: item.contextId, actionCode: decision.actionCode,
      effect: decision.effect, reason: decision.reason, decisionDigest: decision.decisionDigest });
    const request = { incidentId, actionCode: entry.code, targetId: target.targetId };
    const workContext = {
      evidence: { summary: `結束流程第 0 步：本事件的 context 封鎖（A 級）已達政策上限，context ${item.contextId} 仍在運作，需要人封鎖。`,
        references: [response.signal.eventId], counts: { remainingContexts: items.length } },
      impact: { notes: '只影響被導入假世界的攻擊方 context；合法使用者不經該 context。' },
      requirements: { adminAccountRole: 'DungeonQ owner（本機）',
        notes: `以 owner 核准流程（/api/policy/preview → /api/policy/apply，action FENCE，contextId ${item.contextId}）封鎖後，從第 0 步重跑結束流程。` }
    };
    const outcome = await callPort('workOrders.create', () => ports.workOrders.create({ decision, input, request, context: workContext, sensitiveValues }),
      {}, limits.portTimeoutMs, signal);
    const workOrder = outcome?.workOrder;
    insist(typeof workOrder?.workOrderId === 'string' && ITEM_ID.test(workOrder.workOrderId), 'FREEZE_WORK_ORDER_NOT_CREATED', { contextId: item.contextId });
    journal.append('WORK_ORDER', { step: 'FREEZE', contextId: item.contextId, workOrderId: workOrder.workOrderId, created: outcome.created === true,
      deduplicatedBy: typeof outcome.deduplicatedBy === 'string' ? outcome.deduplicatedBy : null, status: typeof workOrder.status === 'string' ? workOrder.status : null });
    created.push({ contextId: item.contextId, workOrderId: workOrder.workOrderId });
  }
  return created;
}

/** 合法消費者介面（選配）：停止合成的量測消費者並讀回。不撤合法憑證、不影響真實合法流量。 */
async function stopLegitimateConsumer(context) {
  const { caseInput, ports, journal, limits, signal } = context;
  const port = ports.legitimate;
  if (port === undefined || port === null) {
    // 沒有合成合法消費者，或呼叫端自行停止；若仍有寫入，第 1 步會因 journal 變動停下（WORLD_CHANGED_DURING_EXPORT）。
    journal.append('READBACK', { step: 'FREEZE', check: 'LEGIT_CONSUMER', state: 'NOT_CONFIGURED' });
    return { configured: false, stopped: null };
  }
  insist(typeof port.stop === 'function' && typeof port.state === 'function', 'PORT_NOT_CONFIGURED', { port: 'legitimate' });
  const scope = { incidentId: caseInput.incidentId };
  await callPort('legitimate.stop', args => port.stop(args), scope, limits.portTimeoutMs, signal);
  const state = await callPort('legitimate.state', args => port.state(args), scope, limits.portTimeoutMs, signal);
  insist(state?.running === false, 'LEGIT_CONSUMER_STILL_RUNNING');
  journal.append('READBACK', { step: 'FREEZE', check: 'LEGIT_CONSUMER', state: 'STOPPED',
    stoppedAt: typeof state.stoppedAt === 'string' ? state.stoppedAt : null });
  return { configured: true, stopped: true };
}

/**
 * 5.1 第 0 步：凍結。順序固定：
 * (1) 合法消費者仍在運作時，仍為 ACTIVE 的事件 context 逐一經政策判定後封鎖（A-1），讀回 context 已封鎖且實際試一次被拒；
 * (2) 停止世界的新變動（關閉參與者入口）並讀回；(3) 停止合法消費者並讀回。之後第 1 步才封存。
 * 政策因上限拒絕時，為剩下的 context 產生 B 級工單並停下（FREEZE_CONTEXTS_REQUIRE_HUMAN），不停止世界、不停止合法消費者，
 * 讓人封鎖後重跑時健康數字仍是即時的。其他拒絕或未生效一律停下（FREEZE_FENCE_NOT_EXECUTED）。
 */
async function freeze(context) {
  const { caseInput, ports, journal, limits, signal } = context;
  const scope = { incidentId: caseInput.incidentId, contexts: caseInput.contexts };
  const contextItems = async () => validateInventory(await callPort('revocation.inventory', ports.revocation?.inventory, scope, limits.portTimeoutMs, signal))
    .filter(row => row.kind === 'WORLD_CONTEXT');
  const before = await contextItems();
  journal.append('READBACK', { step: 'FREEZE', check: 'CONTEXTS', items: before.map(({ itemId, state }) => ({ itemId, state })) });
  const fenced = []; const deferred = [];
  for (const item of before.filter(row => row.state === 'ACTIVE')) {
    const outcome = await fenceThroughPolicy(context, item);
    if (outcome.executed) { fenced.push(item.contextId); continue; }
    if (outcome.limitReached) { deferred.push(item); continue; }
    fail('FREEZE_FENCE_NOT_EXECUTED', { contextId: item.contextId, effect: outcome.decision.effect, reason: outcome.decision.reason,
      status: outcome.status, result: outcome.resultReason });
  }
  if (deferred.length > 0) {
    const workOrders = await requestHumanFence(context, deferred);
    fail('FREEZE_CONTEXTS_REQUIRE_HUMAN', { contexts: deferred.map(item => item.contextId), fenced, workOrders });
  }
  const after = await contextItems();
  const stillActive = after.filter(row => row.state !== 'REVOKED').map(row => row.itemId);
  insist(stillActive.length === 0 && after.length === before.length, 'FREEZE_CONTEXT_STILL_ACTIVE', { stillActive });
  const allowed = [];
  for (const item of after) {
    const probe = await callPort('revocation.probe', ports.revocation.probe, { ...scope, item }, limits.portTimeoutMs, signal);
    const denied = probe?.denied === true;
    journal.append('READBACK', { step: 'FREEZE', check: 'CONTEXT_DENIED', itemId: item.itemId, denied,
      code: typeof probe?.code === 'string' ? probe.code.slice(0, 80) : null });
    if (!denied) allowed.push(item.itemId);
  }
  insist(allowed.length === 0, 'FREEZE_CONTEXT_NOT_DENIED', { allowed });
  await callPort('world.freeze', ports.world?.freeze, scope, limits.portTimeoutMs, signal);
  const world = await callPort('world.readFreeze', ports.world?.readFreeze, scope, limits.portTimeoutMs, signal);
  insist(world?.frozen === true && validJournalPosition(world), 'WORLD_FREEZE_NOT_CONFIRMED');
  journal.append('READBACK', { step: 'FREEZE', check: 'WORLD_FROZEN', journalSequence: world.journalSequence, journalHead: world.journalHead });
  const consumer = await stopLegitimateConsumer(context);
  return { fenced, alreadyFenced: before.filter(row => row.state === 'REVOKED').map(row => row.contextId ?? row.itemId),
    worldFrozen: true, journalSequence: world.journalSequence, legitimateConsumer: consumer };
}

async function revoke(context) {
  const { caseInput, ports, journal, limits, signal } = context;
  const scope = { incidentId: caseInput.incidentId, contexts: caseInput.contexts };
  const inventory = async () => validateInventory(await callPort('revocation.inventory', ports.revocation?.inventory, scope, limits.portTimeoutMs, signal));
  const first = await inventory();
  journal.append('READBACK', { step: 'REVOKE', check: 'INVENTORY', items: first.map(({ itemId, kind, state }) => ({ itemId, itemKind: kind, state })) });
  // context 應已在第 0 步封鎖；這時合法消費者已停止、健康不再即時，不在這裡封鎖，回到第 0 步處理。
  const activeContexts = first.filter(row => row.kind === 'WORLD_CONTEXT' && row.state === 'ACTIVE').map(row => row.itemId);
  insist(activeContexts.length === 0, 'REVOKE_CONTEXT_STILL_ACTIVE', { contexts: activeContexts });
  const outcomes = [];
  for (const item of first.filter(row => row.state === 'ACTIVE')) {
    const result = await callPort('revocation.revoke', ports.revocation.revoke, { ...scope, item }, limits.portTimeoutMs, signal);
    insist(['REVOKED', 'ALREADY_REVOKED'].includes(result?.outcome), 'REVOKE_FAILED', { itemId: item.itemId });
    journal.append('REVOKED', { step: 'REVOKE', itemId: item.itemId, itemKind: item.kind, outcome: result.outcome });
    outcomes.push(item.itemId);
  }
  const final = await inventory();
  const stillActive = final.filter(row => row.state !== 'REVOKED').map(row => row.itemId);
  insist(stillActive.length === 0, 'REVOKE_INCOMPLETE', { stillActive });
  const missing = first.filter(row => !final.some(item => item.itemId === row.itemId)).map(row => row.itemId);
  insist(missing.length === 0, 'REVOKE_ITEM_DISAPPEARED', { missing });
  const allowed = [];
  for (const item of final) {
    const probe = await callPort('revocation.probe', ports.revocation.probe, { ...scope, item }, limits.portTimeoutMs, signal);
    const denied = probe?.denied === true;
    journal.append('READBACK', { step: 'REVOKE', check: 'DENIED', itemId: item.itemId, itemKind: item.kind, denied,
      code: typeof probe?.code === 'string' ? probe.code.slice(0, 80) : null });
    if (!denied) allowed.push(item.itemId);
  }
  insist(allowed.length === 0, 'REVOKE_READBACK_NOT_DENIED', { allowed });
  const kinds = {}; for (const item of final) kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
  return { items: final.length, denied: final.length, kinds, revoked: outcomes,
    contexts: final.filter(row => row.kind === 'WORLD_CONTEXT').map(row => ({ contextId: row.contextId ?? null, epoch: row.epoch ?? null })) };
}

async function decideFence(context) {
  const { caseInput, ports, journal, limits, signal, results } = context;
  const scope = { incidentId: caseInput.incidentId, contexts: caseInput.contexts };
  const items = validateInventory(await callPort('revocation.inventory', ports.revocation.inventory, scope, limits.portTimeoutMs, signal))
    .filter(row => row.kind === 'WORLD_CONTEXT');
  insist(items.length > 0, 'FENCE_CONTEXTS_MISSING');
  const decisions = items.map(item => ({ contextId: item.contextId ?? item.itemId, ...decideFenceDisposition({ verdict: caseInput.verdict,
    identityConfirmed: caseInput.identityConfirmed, credentialsRevoked: results.REVOKE !== null, realAssetReads: results.SEAL_EVIDENCE.facts.realAssetReads,
    evidenceSealed: results.SEAL_EVIDENCE !== null }) }));
  for (const decision of decisions) journal.append('FENCE_DECISION', { step: 'FENCE_DISPOSITION', ...decision });
  // 讀回：v1 不解除任何 FENCE，所以每個事件 context 都必須仍是撤銷狀態（誤判也不解除舊 context）。
  const readback = validateInventory(await callPort('revocation.inventory', ports.revocation.inventory, scope, limits.portTimeoutMs, signal))
    .filter(row => row.kind === 'WORLD_CONTEXT');
  const reopened = readback.filter(row => row.state !== 'REVOKED').map(row => row.itemId);
  insist(reopened.length === 0 && readback.length === items.length, 'FENCE_READBACK_MISMATCH', { reopened });
  journal.append('READBACK', { step: 'FENCE_DISPOSITION', check: 'CONTEXTS_STILL_FENCED', contexts: readback.map(row => row.itemId) });
  return { decisions };
}

async function notifyAffected(context) {
  const { caseInput, ports, journal, limits, signal, sensitiveValues } = context;
  insist(ports.response?.connector, 'RESPONSE_PORT_NOT_CONFIGURED');
  const actions = ports.response.connector.incidentStatus(caseInput.incidentId).actions;
  const recipients = deriveAffectedRecipients({ actions, verdict: caseInput.verdict, directory: caseInput.notification.directory,
    contexts: caseInput.contexts });
  insist(recipients.length <= limits.maxRecipients, 'NOTIFICATION_RECIPIENT_LIMIT');
  const settled = new Map();
  for (const entry of journal.entries) if (entry.kind === 'NOTIFICATION' && ['SENT', 'UNKNOWN'].includes(entry.status)) settled.set(entry.recipientId, entry.status);
  const messages = recipients.map(recipient => {
    const message = composeAffectedNotification({ incidentId: caseInput.incidentId, reasons: recipient.reasons, contact: caseInput.notification.contact });
    const findings = checkSensitiveContent(`${message.subject}\n${message.body}`, { sensitiveValues });
    insist(findings.length === 0, 'NOTIFICATION_CONTENT_SENSITIVE', { recipientId: recipient.recipientId, kinds: findings.map(item => item.kind) });
    return { recipient, message, messageDigest: digestOf('dungeonq.affected-notification/v1', message) };
  });
  const results = [];
  for (const { recipient, message, messageDigest } of messages) {
    if (settled.has(recipient.recipientId)) { results.push({ recipientId: recipient.recipientId, status: settled.get(recipient.recipientId), replayed: true }); continue; }
    const idempotencyKey = `dq-close-notify:${digestOf('dungeonq.affected-notification-key/v1', { incidentId: caseInput.incidentId, recipientId: recipient.recipientId }).slice(0, 40)}`;
    let status = 'UNKNOWN'; let receiptId = null; let code = null;
    try {
      const outcome = await callPort('notifier.send', ports.notifier?.send, { incidentId: caseInput.incidentId, recipientId: recipient.recipientId,
        idempotencyKey, subject: message.subject, body: message.body }, limits.notifyTimeoutMs, signal);
      if (outcome?.status === 'SENT' && typeof outcome.receiptId === 'string' && ITEM_ID.test(outcome.receiptId)) { status = 'SENT'; receiptId = outcome.receiptId; }
      else if (outcome?.status === 'REJECTED') { status = 'REJECTED'; code = typeof outcome.code === 'string' ? outcome.code.slice(0, 80) : 'REJECTED'; }
      else code = 'OUTCOME_UNRECOGNIZED';
    } catch (error) {
      if (error?.code === 'PORT_NOT_CONFIGURED') throw error;
      code = error?.code ?? 'PORT_FAILED';
    }
    journal.append('NOTIFICATION', { step: 'NOTIFY_AFFECTED', recipientId: recipient.recipientId, reasons: recipient.reasons, status, receiptId, code,
      idempotencyKey, messageDigest });
    results.push({ recipientId: recipient.recipientId, status, replayed: false });
  }
  const rejected = results.filter(row => row.status === 'REJECTED').map(row => row.recipientId);
  insist(rejected.length === 0, 'NOTIFICATION_REJECTED', { rejected });
  return { recipients: recipients.length, sent: results.filter(row => row.status === 'SENT').length,
    unknown: results.filter(row => row.status === 'UNKNOWN').length,
    affected: recipients.map(row => ({ ...row, notification: results.find(item => item.recipientId === row.recipientId)?.status ?? 'UNKNOWN' })) };
}

function loadVerifiedArtifacts(directory, expectedDigest) {
  const bytes = readFileSync(join(directory, CASE_FILES.manifest));
  insist(sha256(bytes) === expectedDigest, 'MANIFEST_CHANGED_AFTER_SEAL');
  const manifest = JSON.parse(bytes.toString('utf8'));
  const data = {};
  for (const artifact of manifest.artifacts) {
    insist(safeRelative(artifact.path), 'ARTIFACT_PATH_INVALID');
    const text = readFileSync(join(directory, artifact.path));
    insist(sha256(text) === artifact.sha256, 'ARTIFACT_CHANGED_AFTER_SEAL', { name: artifact.name });
    data[artifact.name] = JSON.parse(text.toString('utf8')).data;
  }
  return { manifest, data };
}

const minimum = values => { const list = values.filter(value => Number.isFinite(value)); return list.length ? Math.min(...list) : null; };

/** 由已封存的證據與事件紀錄組出 5.2 報告所需的資料。所有時間不明者為 null（報告顯示 UNKNOWN）。 */
function buildReportModel(context, { manifest, data, pattern, rules, drills, candidateStore }) {
  const { caseInput, results, journal, clock, directory } = context;
  const contexts = new Set(caseInput.contexts);
  const events = Array.isArray(data['runtime-journal']?.events) ? data['runtime-journal'].events : [];
  const caseEvents = events.filter(event => contexts.has(event.contextId));
  const uses = Array.isArray(data['ticket-uses']?.uses) ? data['ticket-uses'].uses.filter(use => contexts.has(use.contextId)) : [];
  const tickets = Array.isArray(data['ticket-ledger']?.tickets) ? data['ticket-ledger'].tickets.filter(ticket => contexts.has(ticket.contextId)) : [];
  const pitchIncidents = Array.isArray(data.outbox?.incidents) ? data.outbox.incidents.filter(row => contexts.has(row.contextId)) : [];
  const outbox = Array.isArray(data.outbox?.outbox) ? data.outbox.outbox.filter(row => pitchIncidents.some(incident => incident.incidentId === row.incidentId)) : [];
  const status = context.ports.response.connector.incidentStatus(caseInput.incidentId);
  const audit = context.ports.response.connector.listAudit({ incidentId: caseInput.incidentId });
  const firstAudit = kind => minimum(audit.filter(row => row.kind === kind).map(row => Date.parse(row.at)));
  const closedAt = clock();
  const ackAt = caseInput.acknowledgement ? Date.parse(caseInput.acknowledgement.at) : minimum(pitchIncidents.map(row => row.acknowledgement?.at));
  const ackVerified = caseInput.acknowledgement?.verified === true;
  const automaticDefault = caseInput.closureReason === 'AUTO_SAFE_DEFAULT';
  const humanDecisionAt = caseInput.humanDecisionAt ? Date.parse(caseInput.humanDecisionAt) : null;
  const times = {
    TRIGGER: minimum(caseEvents.map(event => event.at)),
    TICKET_DELIVERED: minimum([...tickets.map(ticket => ticket.issuedAt), ...caseEvents.filter(event => event.operation === 'issue-ticket').map(event => event.at)]),
    FIRST_ACCEPTANCE: pattern.wrongTicket.firstAcceptedAt,
    RECOGNITION_OR_PIVOT: pattern.recognitionAt,
    ALERT_SENT: minimum(outbox.map(row => row.acceptedAt)),
    HUMAN_ACK: ackAt,
    DECISION: humanDecisionAt ?? firstAudit('ATTEMPT_STARTED'),
    ACTION: firstAudit('ATTEMPT_STARTED'),
    READBACK: firstAudit('ATTEMPT_EXECUTED'),
    CLOSED: closedAt
  };
  const executors = { TRIGGER: 'SYSTEM', TICKET_DELIVERED: 'SYSTEM', FIRST_ACCEPTANCE: 'SYSTEM', RECOGNITION_OR_PIVOT: 'SYSTEM', ALERT_SENT: 'SYSTEM',
    HUMAN_ACK: 'HUMAN', DECISION: humanDecisionAt !== null ? 'HUMAN' : automaticDefault ? 'AUTO_SAFE_DEFAULT' : 'SYSTEM',
    ACTION: automaticDefault ? 'AUTO_SAFE_DEFAULT' : 'SYSTEM', READBACK: 'SYSTEM', CLOSED: 'SYSTEM' };
  const notes = {
    TRIGGER: '事件 context 第一次被導入假世界（journal）', TICKET_DELIVERED: '錯誤 ticket 簽發（ticket 帳本或 journal）',
    FIRST_ACCEPTANCE: '以工具紀錄判定（ticket 使用結果 ACCEPTED），不看自評',
    RECOGNITION_OR_PIVOT: pattern.recognitionSignals[0]?.label ?? '觀察期內沒有識破訊號（右設限）',
    ALERT_SENT: '寄件回執只代表已交給供應商，不代表收件或閱讀',
    HUMAN_ACK: ackAt === null ? '沒有 ACK 紀錄' : ackVerified ? '已驗證身分的 ACK' : '未驗證身分（由呼叫端轉錄，M3 前）',
    DECISION: humanDecisionAt !== null ? '管理員決策' : '處置動作政策判定（第一個 A 級動作）',
    ACTION: '第一個 A 級動作開始執行', READBACK: '第一個 A 級動作讀回生效', CLOSED: '結束流程由 HUMAN 啟動，步驟由 SYSTEM 依序執行'
  };
  const timeline = TIMELINE_MILESTONES.map(row => ({ key: row.key, label: row.label, at: times[row.key] === null ? null : iso(times[row.key]),
    executor: executors[row.key], note: times[row.key] === null && row.key !== 'RECOGNITION_OR_PIVOT' ? `${notes[row.key]}；UNKNOWN，不倒填` : notes[row.key] }));
  const health = data['legit-health']?.segments ?? null;
  const workOrders = Array.isArray(data['work-orders']?.workOrders) ? data['work-orders'].workOrders : [];
  return {
    generatedAt: iso(closedAt), isolation: caseInput.isolation,
    summary: { incidentId: caseInput.incidentId, startedAt: times.TRIGGER === null ? null : iso(times.TRIGGER), endedAt: iso(closedAt),
      severity: caseInput.severity, verdict: caseInput.verdict, identityConfirmed: caseInput.identityConfirmed },
    timeline,
    wrongTicket: { delivered: tickets.length || caseEvents.filter(event => event.operation === 'issue-ticket').length,
      accepted: pattern.wrongTicket.accepted > 0, uses: uses.length, acceptedUses: uses.filter(use => use.outcome === 'ACCEPTED').length,
      entries: pattern.wrongTicket.entries, distinctSources: new Set(uses.map(use => use.source).filter(value => value !== null && value !== undefined)).size,
      spread: pattern.wrongTicket.spread, recognitionSignals: pattern.recognitionSignals.map(entry => ({ label: entry.label, at: iso(entry.at) })) },
    impact: { realAssetReads: manifest.facts.realAssetReads, health, affectedUsers: results.NOTIFY_AFFECTED.affected.map(row => ({
      recipientId: row.recipientId, reasons: row.reasons.map(reason => AFFECTED_REASONS[reason]), notification: row.notification })) },
    response: {
      automaticActions: status.actions.map(row => ({ actionCode: row.actionCode, actionName: getDungeonqResponseActionCatalogEntry(row.actionCode)?.name ?? 'UNKNOWN',
        targetId: row.targetId, status: row.status, readback: row.readback, recordedAt: row.recordedAt })),
      workOrders: workOrders.map(row => ({ workOrderId: row.workOrderId, actionCode: row.actionCode, actionName: row.actionName, status: row.status,
        verification: row.verification })),
      revocation: { items: results.REVOKE.items, denied: results.REVOKE.denied },
      fence: results.FENCE_DISPOSITION.decisions.map(row => ({ contextId: row.contextId, decision: row.decision, reasons: row.reasons }))
    },
    rootCause: caseInput.rootCause, followUps: caseInput.followUps,
    learning: {
      pattern,
      rules: rules.map(rule => { const record = candidateStore.get(rule.candidateId);
        return { candidateId: rule.candidateId, kind: rule.kind, state: record.state, tests: record.tests,
          summary: rule.kind === 'TICKET_PRESENTATION' ? `入口 ${rule.match.entries.join('、')} 出現已追蹤的錯誤 ticket`
            : `${rule.match.sequence.join(' → ')}（${Math.round(rule.match.withinMs / 1000)} 秒內）` }; }),
      drills: drills.map(drill => ({ candidateId: drill.candidateId, seed: drill.seed, steps: drill.scenario.steps.length, state: candidateStore.get(drill.candidateId).state })),
      noNewPatternReason: rules.length + drills.length === 0
        ? '已封存的 journal 與 ticket 紀錄中，事件 context 沒有任何操作或錯誤 ticket 出示，無可抽取的工具順序或接受行為。' : null
    },
    evidenceIndex: { caseLabel: basename(directory), manifestPath: CASE_FILES.manifest, manifestDigest: results.SEAL_EVIDENCE.manifestDigest,
      attestationDigest: results.SEAL_EVIDENCE.attestationDigest, checkpointDigest: results.SEAL_EVIDENCE.checkpointDigest,
      journalSequence: results.SEAL_EVIDENCE.journalSequence, evidenceIntegrity: results.SEAL_EVIDENCE.evidenceIntegrity,
      artifacts: manifest.artifacts.map(row => ({ path: row.path, sha256: row.sha256 })) },
    closeJournalEntries: journal.entries.length
  };
}

async function postIncidentReview(context) {
  const { caseInput, ports, directory, journal, limits, signal, results, sensitiveValues } = context;
  const { manifest, data } = loadVerifiedArtifacts(directory, results.SEAL_EVIDENCE.manifestDigest);
  insist(ports.response?.connector, 'RESPONSE_PORT_NOT_CONFIGURED');
  const traces = buildIncidentTraces({ contexts: caseInput.contexts, journalEvents: data['runtime-journal']?.events ?? [],
    ticketUses: data['ticket-uses']?.uses ?? [], toolLog: data['agent-tool-log']?.records ?? [] });
  const legitimateTraces = buildLegitimateTraces(data['legit-health']);
  const pattern = extractAttackPattern(traces);
  const rules = buildRuleCandidates(pattern, { incidentId: caseInput.incidentId });
  const drill = buildDrillCandidate(traces, pattern, { incidentId: caseInput.incidentId, ...(caseInput.drillSeed === undefined ? {} : { seed: caseInput.drillSeed }) });
  const drills = drill ? [drill] : [];
  const candidateStore = openCandidateStore({ directory: join(directory, CASE_FILES.candidates), clock: context.clock });
  for (const candidate of [...rules, ...drills]) {
    const findings = checkSensitiveContent(canonicalJson(candidate), { sensitiveValues });
    insist(findings.length === 0, 'CANDIDATE_CONTENT_SENSITIVE', { candidateId: candidate.candidateId, kinds: findings.map(item => item.kind) });
    const written = candidateStore.write(candidate);
    const tested = written.state === 'CANDIDATE' || written.state === 'TEST_FAILED'
      ? candidateStore.runTests(candidate.candidateId, { recordedTraces: traces, legitimateTraces, pattern }) : written;
    journal.append('CANDIDATE_WRITTEN', { step: 'POST_INCIDENT_REVIEW', candidateId: candidate.candidateId, state: tested.state,
      testsPassed: tested.tests?.passed ?? false });
  }
  const model = buildReportModel(context, { manifest, data, pattern, rules, drills, candidateStore });
  const markdown = renderPostIncidentReport(model);
  const formatProblems = checkReportFormat(markdown, model);
  insist(formatProblems.length === 0, 'REPORT_FORMAT_INVALID', { problems: formatProblems });
  const findings = checkSensitiveContent(markdown, { sensitiveValues });
  insist(findings.length === 0, 'REPORT_CONTENT_SENSITIVE', { kinds: findings.map(item => item.kind) });
  writeAtomic(join(directory, CASE_FILES.report), markdown);
  const readBack = readFileSync(join(directory, CASE_FILES.report), 'utf8');
  insist(readBack === markdown && checkReportFormat(readBack, model).length === 0, 'REPORT_READBACK_MISMATCH');
  const reportDigest = sha256(readBack);
  journal.append('REPORT_WRITTEN', { step: 'POST_INCIDENT_REVIEW', path: CASE_FILES.report, sha256: reportDigest,
    owners: ROOT_CAUSE_AREAS.map(area => caseInput.rootCause[area.key].owner) });
  // 結案封存：報告、候選與目前為止的事件紀錄，以同一把封存金鑰簽章並錨定（CLOSE_RECORD）。
  const candidateFiles = ['rules', 'drills'].flatMap(kind => {
    try { return readdirSync(join(directory, CASE_FILES.candidates, kind)).filter(name => name.endsWith('.json')).sort().map(name => `${CASE_FILES.candidates}/${kind}/${name}`); }
    catch { return []; }
  });
  const files = [CASE_FILES.report, ...candidateFiles].map(path => ({ path, sha256: fileDigest(join(directory, path)) }));
  const position = await callPort('world.readFreeze', ports.world.readFreeze, { incidentId: caseInput.incidentId, contexts: caseInput.contexts }, limits.portTimeoutMs, signal);
  insist(validJournalPosition(position), 'WORLD_FREEZE_NOT_CONFIRMED');
  const covered = journal.append('CLOSE_RECORD_PREPARED', { step: 'POST_INCIDENT_REVIEW', files: files.length });
  const bundle = { schemaVersion: BUNDLE_SCHEMA, incidentId: caseInput.incidentId, evidenceManifestDigest: results.SEAL_EVIDENCE.manifestDigest,
    closeJournal: { entries: covered.seq, lastHash: covered.hash }, journal: { sequence: position.journalSequence, head: position.journalHead }, files };
  const bundleText = `${canonicalJson(bundle)}\n`;
  writeAtomic(join(directory, CASE_FILES.bundle), bundleText);
  const bundleDigest = sha256(bundleText);
  const attested = await callPort('sealer.attest', ports.sealer.attest, { incidentId: caseInput.incidentId, kind: 'CLOSE_RECORD', manifestDigest: bundleDigest,
    journalSequence: position.journalSequence, journalHead: position.journalHead }, limits.sealTimeoutMs, signal);
  insist(attested?.status === 'ATTESTED', 'CLOSE_RECORD_SEAL_FAILED', { code: attested?.code ?? null });
  const verified = await callPort('sealer.verify', ports.sealer.verify, { caseDirectory: directory, incidentId: caseInput.incidentId }, limits.sealTimeoutMs, signal);
  insist(verified?.verdict === 'VERIFIED' && verified.closeRecord?.status === 'VERIFIED', 'CLOSE_RECORD_VERIFY_FAILED',
    { verdict: verified?.verdict ?? null, findings: (verified?.findings ?? []).map(item => item.kind) });
  return { reportPath: CASE_FILES.report, reportDigest, bundleDigest, closeRecordAttestation: attested.attestation.digest,
    candidates: candidateStore.list(), noNewPatternReason: model.learning.noNewPatternReason, evidenceIntegrity: verified.evidenceIntegrity };
}

const STEP_FUNCTIONS = Object.freeze({
  FREEZE: freeze, SEAL_EVIDENCE: sealEvidence, REVOKE: revoke, FENCE_DISPOSITION: decideFence, NOTIFY_AFFECTED: notifyAffected, POST_INCIDENT_REVIEW: postIncidentReview
});

/* ------------------------------------------------------------------ */
/* 協調器                                                                */
/* ------------------------------------------------------------------ */

/**
 * 開啟一個事件的結束案件。directory 必須是私人目錄（0700，不存在時建立）。
 * 第一次開啟保存結束輸入；之後再開啟必須給相同輸入（CLOSE_INPUT_CHANGED），避免中途改寫結論。
 * @param {object} options
 * @param {string} options.directory 案件目錄（絕對路徑）。
 * @param {object} options.input 結束輸入（見 normalizeCloseInput）。
 * @param {object} options.ports 注入介面：world、evidence、sealer、revocation、response、notifier；選配 legitimate（第 0 步停止合成合法消費者：
 *   stop({incidentId,signal})、state({incidentId,signal}) → { running, stoppedAt? }）、workOrders（M6 工單儲存的 create，A-1 達上限時使用）。
 * @param {string[]} [options.sensitiveValues] 只在記憶體中比對的敏感原值（憑證、ticket、誘餌原文）。
 */
export function openIncidentClose({ directory, input, ports, sensitiveValues = [], clock = Date.now, limits: overrides = {} }) {
  insist(typeof directory === 'string' && isAbsolute(directory), 'CASE_DIRECTORY_INVALID');
  insist(isPlainObject(ports), 'PORTS_REQUIRED');
  const limits = { ...INCIDENT_CLOSE_LIMITS, ...overrides };
  for (const key of Object.keys(overrides)) insist(Object.hasOwn(INCIDENT_CLOSE_LIMITS, key) && Number.isSafeInteger(overrides[key]) && overrides[key] > 0
    && (key !== 'maxRunsPerStep' || overrides[key] <= INCIDENT_CLOSE_LIMITS.maxRunsPerStep), 'CLOSE_LIMITS_INVALID', { key });
  privateDirectory(directory);
  const caseInput = normalizeCloseInput(input, { sensitiveValues });
  const inputPath = join(directory, CASE_FILES.input); const inputText = `${canonicalJson(caseInput)}\n`;
  if (existsSync(inputPath)) insist(readFileSync(inputPath, 'utf8') === inputText, 'CLOSE_INPUT_CHANGED');
  else writeAtomic(inputPath, inputText);
  const inputDigest = sha256(inputText);

  async function run({ signal } = {}) {
    const release = acquireLock(directory);
    try {
      const journal = openJournal(directory, clock);
      if (journal.entries.length === 0) journal.append('CASE_OPENED', { incidentId: caseInput.incidentId, inputDigest, version: INCIDENT_CLOSE_VERSION });
      const state = summarizeCloseJournal(journal.entries);
      if (state.closed) return { status: 'CLOSED', replayed: true, steps: state.steps };
      const results = Object.fromEntries(INCIDENT_CLOSE_STEPS.map(step => [step, state.steps[step].state === 'DONE' ? state.steps[step].result : null]));
      for (const step of INCIDENT_CLOSE_STEPS) {
        if (state.steps[step].state === 'DONE') continue;
        if (state.steps[step].runs >= limits.maxRunsPerStep) {
          journal.append('STEP_FAILED', { step, code: 'STEP_RUN_LIMIT', detail: { runs: state.steps[step].runs } });
          return { status: 'HALTED', step, code: 'STEP_RUN_LIMIT', steps: summarizeCloseJournal(journal.entries).steps };
        }
        if (signal?.aborted) {
          journal.append('STEP_FAILED', { step, code: 'CLOSE_ABORTED' });
          return { status: 'HALTED', step, code: 'CLOSE_ABORTED', steps: summarizeCloseJournal(journal.entries).steps };
        }
        journal.append('STEP_STARTED', { step });
        let result;
        try {
          result = await STEP_FUNCTIONS[step]({ caseInput, ports, directory, journal, limits, signal, results, clock, sensitiveValues });
        } catch (error) {
          const code = error instanceof IncidentCloseError ? error.code : errorCode(error);
          const detail = error instanceof IncidentCloseError && error.detail !== undefined ? JSON.parse(JSON.stringify(error.detail)) : null;
          journal.append('STEP_FAILED', { step, code, detail });
          return { status: 'HALTED', step, code, detail, steps: summarizeCloseJournal(journal.entries).steps };
        }
        journal.append('STEP_DONE', { step, result });
        results[step] = result;
      }
      journal.append('CLOSED', { incidentId: caseInput.incidentId });
      return { status: 'CLOSED', replayed: false, steps: summarizeCloseJournal(journal.entries).steps, report: join(directory, CASE_FILES.report),
        results };
    } finally { release(); }
  }

  return Object.freeze({
    directory, incidentId: caseInput.incidentId, input: caseInput,
    run,
    status: () => readIncidentCloseStatus(directory)
  });
}

/** 唯讀狀態：每一步的狀態、次數、最後失敗；不需要任何外部介面。 */
export function readIncidentCloseStatus(directory) {
  const journal = readCloseJournal(directory);
  const summary = summarizeCloseJournal(journal.entries);
  return { journal: journal.status, problem: journal.problem ?? null, closed: summary.closed,
    steps: Object.fromEntries(Object.entries(summary.steps).map(([step, row]) => [step, { state: row.state, runs: row.runs, failure: row.failure }])) };
}

/* ------------------------------------------------------------------ */
/* 指令列（唯讀：狀態與外部驗證）                                          */
/* ------------------------------------------------------------------ */

const USAGE = `用法（需以 node --import tsx 執行）：
  node --import tsx scripts/dungeonq-host/incident-close.mjs status --case <案件目錄絕對路徑>
  node --import tsx scripts/dungeonq-host/incident-close.mjs verify --case <案件目錄> --db <journal 資料庫> --public-key <封存公鑰 PEM> --anchor-repo <錨點倉庫> [--ref HEAD]
執行結束流程請以程式組裝注入介面後呼叫 openIncidentClose(...).run()（見 docs/runbooks/dungeonq-incident-close.md）。
結束碼：0 正常／驗證通過；1 驗證失敗或流程未完成；2 參數錯誤。`;

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { case: { type: 'string' }, db: { type: 'string' },
      'public-key': { type: 'string' }, 'anchor-repo': { type: 'string' }, ref: { type: 'string' } } }));
  } catch { process.stderr.write(`${USAGE}\n`); return 2; }
  if (typeof values.case !== 'string' || !isAbsolute(values.case)) { process.stderr.write(`${USAGE}\n`); return 2; }
  if (command === 'status') {
    const status = readIncidentCloseStatus(realpathSync(values.case));
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return status.closed && status.journal === 'VALID' ? 0 : 1;
  }
  if (command === 'verify') {
    if (![values.db, values['public-key'], values['anchor-repo']].every(value => typeof value === 'string' && isAbsolute(value))
      || (values.ref !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/u.test(values.ref))) { process.stderr.write(`${USAGE}\n`); return 2; }
    const report = await verifyIncidentCase({ directory: values.case, db: values.db, publicKey: values['public-key'], anchorRepo: values['anchor-repo'],
      ...(values.ref ? { ref: values.ref } : {}) });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.verdict === 'VERIFIED' ? 0 : 1;
  }
  process.stderr.write(`${USAGE}\n`); return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main();
