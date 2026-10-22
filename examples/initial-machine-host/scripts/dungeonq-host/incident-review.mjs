// DungeonQ 事後檢討與學習產出（DQ-HANDOFF-015 M7，ExecPlan 第五部分 5.2、5.3）。
//
// 本模組只做三件事，全部是純函式或只寫在呼叫端指定的候選目錄：
// 1. 依 5.2 的八個段落產生事後檢討報告（Markdown），段落與 docs/templates/dungeonq-post-incident.md 一致。
// 2. 從已封存的紀錄抽出攻擊樣態，產生「確定性偵測規則候選」與「合成演練案例候選」（固定隨機種子）。
// 3. 候選目錄：候選只寫在這裡；沒有命中測試、誤判測試與已驗證的真人核准，不能進入 PUBLISHABLE。
//    本模組沒有任何「發布」函式，不寫入任何規則集或情境包。
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync,
  writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactDungeonqSensitiveText } from './work-order.mjs';

export const POST_INCIDENT_REPORT_VERSION = 'dungeonq.post-incident-report/v1';
export const POST_INCIDENT_TEMPLATE = 'docs/templates/dungeonq-post-incident.md';

/** 5.2 的八個段落。範本文件的二級標題必須與 `## ${number}. ${title}` 完全一致（測試比對）。 */
export const POST_INCIDENT_SECTIONS = Object.freeze([
  Object.freeze({ number: 1, key: 'summary', title: '事件摘要' }),
  Object.freeze({ number: 2, key: 'timeline', title: '分段時間線' }),
  Object.freeze({ number: 3, key: 'wrongTicket', title: '錯誤 ticket 表現' }),
  Object.freeze({ number: 4, key: 'impact', title: '影響' }),
  Object.freeze({ number: 5, key: 'response', title: '處置評估' }),
  Object.freeze({ number: 6, key: 'rootCause', title: '根因與改善' }),
  Object.freeze({ number: 7, key: 'learning', title: '學習產出' }),
  Object.freeze({ number: 8, key: 'evidenceIndex', title: '證據索引' })
]);
export const sectionHeading = section => `## ${section.number}. ${section.title}`;

export const INCIDENT_VERDICTS = Object.freeze({ REAL_INTRUSION: '真實越權', DRILL: '演練', FALSE_POSITIVE: '誤判', UNDETERMINED: '未確定' });
export const INCIDENT_SEVERITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const TIMELINE_EXECUTORS = Object.freeze(['SYSTEM', 'HUMAN', 'AUTO_SAFE_DEFAULT']);
export const TIMELINE_MILESTONES = Object.freeze([
  Object.freeze({ key: 'TRIGGER', label: '觸發' }),
  Object.freeze({ key: 'TICKET_DELIVERED', label: '錯誤 ticket 交付' }),
  Object.freeze({ key: 'FIRST_ACCEPTANCE', label: '第一次接受' }),
  Object.freeze({ key: 'RECOGNITION_OR_PIVOT', label: '識破或轉向' }),
  Object.freeze({ key: 'ALERT_SENT', label: '告警送出' }),
  Object.freeze({ key: 'HUMAN_ACK', label: '真人 ACK' }),
  Object.freeze({ key: 'DECISION', label: '決策' }),
  Object.freeze({ key: 'ACTION', label: '動作' }),
  Object.freeze({ key: 'READBACK', label: '讀回' }),
  Object.freeze({ key: 'CLOSED', label: '結束' })
]);
export const ROOT_CAUSE_AREAS = Object.freeze([
  Object.freeze({ key: 'detection', label: '偵測' }),
  Object.freeze({ key: 'wrongTicket', label: '錯誤 ticket' }),
  Object.freeze({ key: 'notification', label: '通知' }),
  Object.freeze({ key: 'response', label: '處置' }),
  Object.freeze({ key: 'documentation', label: '文件' })
]);
/** 事先列舉的識破訊號（ExecPlan「三個主要量測」）。 */
export const RECOGNITION_SIGNALS = Object.freeze({
  CLAIMED_FAKE: '明說是假或誘餌',
  WITHDREW_SUBMISSION: '撤回提交值',
  PIVOTED_TO_OTHER_PATH: '改走其他路徑追同一目標'
});

export const LEARNING_LIMITS = Object.freeze({
  maxTraceEvents: 5_000,
  maxSequenceLength: 4,
  minSequenceLength: 2,
  minWindowMs: 1_000,
  maxWindowMs: 3_600_000,
  /** 誤判測試的合法流量樣本至少要有這麼多事件，否則測試不算通過。 */
  minLegitimateEvents: 20,
  maxCandidates: 32,
  approvalTimeoutMs: 10_000,
  maxHistory: 50,
  drillJitterRatio: 0.2
});
export const CANDIDATE_STATES = Object.freeze(['CANDIDATE', 'TESTED', 'TEST_FAILED', 'PUBLISHABLE']);
export const RULE_CANDIDATE_SCHEMA = 'dungeonq.detection-rule-candidate/v1';
export const DRILL_CANDIDATE_SCHEMA = 'dungeonq.drill-case-candidate/v1';
const CANDIDATE_RECORD_SCHEMA = 'dungeonq.learning-candidate-record/v1';
const RULE_EVALUATOR = 'dungeonq.rule-evaluator/v1';
const CANDIDATE_ID = /^(?:rule|drill)-[a-f0-9]{16}$/u;

export class IncidentReviewError extends Error {
  constructor(code, detail) { super(code); this.name = 'IncidentReviewError'; this.code = code; if (detail !== undefined) this.detail = detail; }
}
const fail = (code, detail) => { throw new IncidentReviewError(code, detail); };
const insist = (condition, code, detail) => { if (!condition) fail(code, detail); };

/** 鍵排序的 JSON；摘要與檔案內容都用它，讓同一內容永遠得到同一摘要。 */
export function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const digestOf = (domain, value) => sha256(`${domain}\n${canonicalJson(value)}`);
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/* ------------------------------------------------------------------ */
/* 軌跡與攻擊樣態                                                       */
/* ------------------------------------------------------------------ */

/**
 * 由已封存的 journal 事件、ticket 使用紀錄與（選用）代理工具紀錄組出事件軌跡，每個 context 一條。
 * 事件只保留種類、操作名稱、入口與結果，不保留任何值、ticket 或憑證。
 */
export function buildIncidentTraces({ contexts, journalEvents = [], ticketUses = [], toolLog = [] }) {
  insist(Array.isArray(contexts) && contexts.length > 0, 'TRACE_CONTEXTS_REQUIRED');
  return contexts.map(contextId => {
    const events = [];
    for (const event of journalEvents) {
      if (event?.contextId !== contextId || !Number.isFinite(event.at)) continue;
      if (event.kind === 'EXECUTE' && typeof event.operation === 'string') events.push({ at: event.at, kind: 'OPERATION', operation: event.operation });
      else if (event.kind === 'ROUTE') events.push({ at: event.at, kind: 'ROUTE', family: event.family ?? null, destination: event.destination ?? null });
      else if (event.kind === 'FENCE') events.push({ at: event.at, kind: 'FENCED' });
    }
    for (const use of ticketUses) {
      if (use?.contextId !== contextId || !Number.isFinite(use.at)) continue;
      events.push({ at: use.at, kind: 'TICKET_USE', entry: use.entry, outcome: use.outcome, spread: Array.isArray(use.spread) && use.spread.length > 0 });
    }
    for (const entry of toolLog) {
      if (entry?.contextId !== contextId || !Number.isFinite(entry.at) || !Object.hasOwn(SIGNAL_TOOL_KINDS, entry.kind)) continue;
      events.push({ at: entry.at, kind: 'SIGNAL', signal: SIGNAL_TOOL_KINDS[entry.kind] });
    }
    events.sort((left, right) => left.at - right.at || left.kind.localeCompare(right.kind));
    return { traceId: `incident:${contextId}`, source: 'INCIDENT', events: events.slice(0, LEARNING_LIMITS.maxTraceEvents) };
  });
}
const SIGNAL_TOOL_KINDS = Object.freeze({ CLAIM_FAKE: 'CLAIMED_FAKE', WITHDRAW: 'WITHDREW_SUBMISSION', PIVOT: 'PIVOTED_TO_OTHER_PATH' });

/** 由合法消費者報告重建合法流量樣本：每個樣本是一次以固定頻率呼叫的業務操作。 */
export function buildLegitimateTraces(report) {
  if (!report || !Number.isSafeInteger(report.sampleCount) || report.sampleCount <= 0) return [];
  const operation = typeof report.probe?.operation === 'string' ? report.probe.operation : 'snapshot';
  const interval = Number.isSafeInteger(report.probe?.intervalMs) ? report.probe.intervalMs : 1000;
  const started = Date.parse(report.startedAt);
  const base = Number.isFinite(started) ? started : 0;
  const count = Math.min(report.sampleCount, LEARNING_LIMITS.maxTraceEvents);
  return [{ traceId: `legitimate:${report.consumerId ?? 'consumer'}`, source: 'LEGITIMATE',
    events: Array.from({ length: count }, (_, index) => ({ at: base + index * interval, kind: 'OPERATION', operation })) }];
}

const collapseRepeats = list => list.filter((value, index) => index === 0 || value !== list[index - 1]);

/**
 * 5.3：抽出工具呼叫順序、接受錯誤 ticket 前後的行為、識破訊號與轉向時機。
 * 「接受」以工具紀錄判定（ticket 使用結果為 ACCEPTED），不看自評。
 */
export function extractAttackPattern(traces) {
  const incident = traces.filter(trace => trace.source === 'INCIDENT');
  const all = incident.flatMap(trace => trace.events.map(event => ({ ...event, traceId: trace.traceId }))).sort((left, right) => left.at - right.at);
  const operations = all.filter(event => event.kind === 'OPERATION');
  const ticketUses = all.filter(event => event.kind === 'TICKET_USE');
  const firstAcceptance = ticketUses.find(event => event.outcome === 'ACCEPTED') ?? null;
  const acceptedAt = firstAcceptance?.at ?? null;
  const before = acceptedAt === null ? operations : operations.filter(event => event.at < acceptedAt);
  const after = acceptedAt === null ? [] : operations.filter(event => event.at >= acceptedAt);
  const signals = [];
  for (const event of all) {
    if (event.kind === 'SIGNAL') signals.push({ signal: event.signal, at: event.at, source: 'TOOL_LOG' });
    else if (acceptedAt !== null && event.kind === 'TICKET_USE' && event.entry === 'real-entry' && event.at > acceptedAt) {
      signals.push({ signal: 'PIVOTED_TO_OTHER_PATH', at: event.at, source: 'TICKET_LEDGER' });
    }
  }
  const pivot = signals.find(entry => entry.signal === 'PIVOTED_TO_OTHER_PATH') ?? null;
  const recognition = signals[0] ?? null;
  return {
    traceIds: incident.map(trace => trace.traceId),
    eventCount: all.length,
    startedAt: all[0]?.at ?? null,
    toolSequence: collapseRepeats(operations.map(event => event.operation)),
    beforeAcceptance: collapseRepeats(before.map(event => event.operation)),
    afterAcceptance: collapseRepeats(after.map(event => event.operation)),
    wrongTicket: {
      presented: ticketUses.length,
      accepted: ticketUses.filter(event => event.outcome === 'ACCEPTED').length,
      entries: [...new Set(ticketUses.map(event => event.entry))].sort(),
      spread: ticketUses.some(event => event.spread),
      firstAcceptedAt: acceptedAt
    },
    recognitionSignals: signals.map(entry => ({ ...entry, label: RECOGNITION_SIGNALS[entry.signal] ?? entry.signal })),
    recognitionAt: recognition?.at ?? null,
    pivotAt: pivot?.at ?? null,
    pivotAfterAcceptanceMs: pivot && acceptedAt !== null ? pivot.at - acceptedAt : null,
    sequenceWindow: windowOf(before)
  };
}
function windowOf(events) {
  const sequence = []; const used = [];
  for (const event of events) {
    if (sequence.length >= LEARNING_LIMITS.maxSequenceLength) break;
    if (sequence.at(-1) === event.operation) continue;
    sequence.push(event.operation); used.push(event);
  }
  if (used.length < LEARNING_LIMITS.minSequenceLength) return null;
  const span = used.at(-1).at - used[0].at;
  return { sequence, observedSpanMs: span, withinMs: Math.min(LEARNING_LIMITS.maxWindowMs, Math.max(LEARNING_LIMITS.minWindowMs, span * 2)) };
}

/* ------------------------------------------------------------------ */
/* 確定性規則與評估                                                      */
/* ------------------------------------------------------------------ */

const shortId = (prefix, value) => `${prefix}-${digestOf('dungeonq.learning-candidate-id/v1', value).slice(0, 16)}`;

/** 由樣態產生確定性偵測規則候選；沒有可用樣態時回傳空陣列。 */
export function buildRuleCandidates(pattern, { incidentId }) {
  const rules = [];
  if (pattern.wrongTicket.presented > 0) {
    const match = { entries: pattern.wrongTicket.entries };
    rules.push({ schemaVersion: RULE_CANDIDATE_SCHEMA, candidateId: shortId('rule', { incidentId, kind: 'TICKET_PRESENTATION', match }), incidentId,
      kind: 'TICKET_PRESENTATION', match,
      rationale: '合法使用者不會持有錯誤 ticket；任何入口出現已追蹤的錯誤 ticket 都是高可信度訊號。',
      source: { traceIds: pattern.traceIds, presented: pattern.wrongTicket.presented } });
  }
  if (pattern.sequenceWindow) {
    const match = { sequence: pattern.sequenceWindow.sequence, withinMs: pattern.sequenceWindow.withinMs };
    rules.push({ schemaVersion: RULE_CANDIDATE_SCHEMA, candidateId: shortId('rule', { incidentId, kind: 'OPERATION_SEQUENCE', match }), incidentId,
      kind: 'OPERATION_SEQUENCE', match,
      rationale: '接受錯誤 ticket 前的工具呼叫順序；在時間窗內依序出現即命中。',
      source: { traceIds: pattern.traceIds, observedSpanMs: pattern.sequenceWindow.observedSpanMs } });
  }
  return rules;
}

/** 對單一軌跡評估規則；純函式。 */
export function evaluateRule(rule, trace) {
  const events = Array.isArray(trace?.events) ? trace.events : [];
  if (rule.kind === 'TICKET_PRESENTATION') {
    const hit = events.find(event => event.kind === 'TICKET_USE' && rule.match.entries.includes(event.entry));
    return hit ? { hit: true, at: hit.at } : { hit: false, at: null };
  }
  if (rule.kind === 'OPERATION_SEQUENCE') {
    const operations = events.filter(event => event.kind === 'OPERATION');
    const sequence = rule.match.sequence;
    for (let start = 0; start < operations.length; start++) {
      if (operations[start].operation !== sequence[0]) continue;
      let matched = 1; let last = operations[start];
      for (let index = start + 1; index < operations.length && matched < sequence.length; index++) {
        if (operations[index].at - operations[start].at > rule.match.withinMs) break;
        if (operations[index].operation === sequence[matched]) { matched++; last = operations[index]; }
      }
      if (matched === sequence.length) return { hit: true, at: last.at };
    }
    return { hit: false, at: null };
  }
  return fail('RULE_KIND_UNSUPPORTED');
}

/** 命中測試（對已記錄軌跡）與誤判測試（對合法流量樣本）。結果只由本函式計算，呼叫端不能提供。 */
export function testRuleCandidate(rule, { recordedTraces, legitimateTraces }) {
  const recorded = recordedTraces.map(trace => ({ traceId: trace.traceId, ...evaluateRule(rule, trace) }));
  const legitimate = legitimateTraces.map(trace => ({ traceId: trace.traceId, events: trace.events.length, ...evaluateRule(rule, trace) }));
  const legitimateEvents = legitimate.reduce((sum, row) => sum + row.events, 0);
  const hits = recorded.filter(row => row.hit).length;
  const falseHits = legitimate.filter(row => row.hit).length;
  return {
    evaluator: RULE_EVALUATOR,
    hit: { traces: recorded.length, hits, passed: recorded.length > 0 && hits > 0, results: recorded.map(({ traceId, hit }) => ({ traceId, hit })) },
    falsePositive: { traces: legitimate.length, events: legitimateEvents, hits: falseHits,
      minimumEvents: LEARNING_LIMITS.minLegitimateEvents,
      passed: legitimate.length > 0 && legitimateEvents >= LEARNING_LIMITS.minLegitimateEvents && falseHits === 0 },
    passed: false
  };
}

/* ------------------------------------------------------------------ */
/* 合成演練案例（固定隨機種子）                                          */
/* ------------------------------------------------------------------ */

/** mulberry32：小而確定的偽隨機數產生器；同一種子永遠得到同一序列。 */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
export const defaultDrillSeed = incidentId => Number.parseInt(digestOf('dungeonq.drill-seed/v1', incidentId).slice(0, 8), 16);

/** 由事件軌跡產生合成演練案例：保留順序與相對時間，時間以固定種子加上 ±20% 抖動，不含任何值。 */
export function buildDrillCandidate(traces, pattern, { incidentId, seed = defaultDrillSeed(incidentId) }) {
  insist(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xFFFFFFFF, 'DRILL_SEED_INVALID');
  const incident = traces.filter(trace => trace.source === 'INCIDENT').flatMap(trace => trace.events).sort((left, right) => left.at - right.at);
  const relevant = incident.filter(event => ['OPERATION', 'TICKET_USE', 'SIGNAL'].includes(event.kind));
  if (relevant.length === 0) return null;
  const random = seededRandom(seed); const origin = relevant[0].at; let previous = 0;
  const steps = relevant.map(event => {
    const observed = event.at - origin;
    const jittered = Math.round(observed * (1 + (random() * 2 - 1) * LEARNING_LIMITS.drillJitterRatio));
    const offsetMs = Math.max(previous, jittered); previous = offsetMs;
    if (event.kind === 'OPERATION') return { offsetMs, action: 'OPERATION', operation: event.operation };
    if (event.kind === 'TICKET_USE') return { offsetMs, action: 'PRESENT_WRONG_TICKET', entry: event.entry };
    return { offsetMs, action: 'RECOGNIZE', signal: event.signal };
  });
  const scenario = { steps, expect: { wrongTicketAccepted: pattern.wrongTicket.accepted > 0,
    recognitionSignal: pattern.recognitionSignals[0]?.signal ?? null, protectedSourceReads: 0 } };
  return { schemaVersion: DRILL_CANDIDATE_SCHEMA, candidateId: shortId('drill', { incidentId, seed, scenario }), incidentId, seed,
    generator: { algorithm: 'mulberry32', jitterRatio: LEARNING_LIMITS.drillJitterRatio }, scenario,
    rationale: '以本事件的工具順序與相對時間重建的腳本代理劇本；用於 M9 演練，不含任何值、ticket 或憑證。' };
}

/** 演練案例的測試：以同一種子重新產生必須完全相同（可重現），且劇本至少含一次錯誤 ticket 出示或操作。 */
export function testDrillCandidate(drill, traces, pattern) {
  const regenerated = buildDrillCandidate(traces, pattern, { incidentId: drill.incidentId, seed: drill.seed });
  const reproducible = regenerated !== null && canonicalJson(regenerated) === canonicalJson(drill);
  return { evaluator: 'dungeonq.drill-determinism/v1', reproducible: { passed: reproducible },
    content: { steps: drill.scenario.steps.length, passed: drill.scenario.steps.length > 0 }, passed: false };
}

/* ------------------------------------------------------------------ */
/* 候選目錄                                                              */
/* ------------------------------------------------------------------ */

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  insist(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'CANDIDATE_DIRECTORY_NOT_PRIVATE');
}
function writeAtomic(path, text) {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    const descriptor = openSync(temporary, constants.O_RDONLY); try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
const candidateKind = candidate => (candidate?.schemaVersion === RULE_CANDIDATE_SCHEMA ? 'rules'
  : candidate?.schemaVersion === DRILL_CANDIDATE_SCHEMA ? 'drills' : fail('CANDIDATE_SCHEMA_INVALID'));

/**
 * 候選目錄。狀態只能 CANDIDATE → TESTED／TEST_FAILED → PUBLISHABLE。
 * - runTests：由本模組計算測試結果（規則：命中＋誤判；演練：可重現）。
 * - approve：只在 TESTED 時呼叫注入的真人核准驗證；驗證綁定候選摘要與測試摘要，回傳 verified 才進 PUBLISHABLE。
 * - 沒有 publish；候選內容在核准後被改動時 status() 回報 INVALID。
 */
export function openCandidateStore({ directory, clock = Date.now }) {
  insist(typeof directory === 'string' && directory.length > 0, 'CANDIDATE_DIRECTORY_REQUIRED');
  privateDirectory(directory);
  const pathOf = (kind, candidateId) => {
    insist(CANDIDATE_ID.test(candidateId), 'CANDIDATE_ID_INVALID');
    return join(directory, kind, `${candidateId}.json`);
  };
  const locate = candidateId => {
    insist(typeof candidateId === 'string' && CANDIDATE_ID.test(candidateId), 'CANDIDATE_ID_INVALID');
    return pathOf(candidateId.startsWith('rule-') ? 'rules' : 'drills', candidateId);
  };
  const read = candidateId => {
    let text; try { text = readFileSync(locate(candidateId), 'utf8'); } catch { return fail('CANDIDATE_UNKNOWN'); }
    let record; try { record = JSON.parse(text); } catch { return fail('CANDIDATE_RECORD_INVALID'); }
    insist(record?.schemaVersion === CANDIDATE_RECORD_SCHEMA && CANDIDATE_STATES.includes(record.state), 'CANDIDATE_RECORD_INVALID');
    return record;
  };
  const save = record => {
    record.history = record.history.slice(-LEARNING_LIMITS.maxHistory);
    writeAtomic(locate(record.candidate.candidateId), `${canonicalJson(record)}\n`);
    return structuredClone(record);
  };
  const integrity = record => {
    const problems = [];
    if (digestOf('dungeonq.learning-candidate/v1', record.candidate) !== record.candidateDigest) problems.push('CANDIDATE_DIGEST_MISMATCH');
    if (record.tests !== null && digestOf('dungeonq.learning-candidate-tests/v1', record.tests) !== record.testsDigest) problems.push('TESTS_DIGEST_MISMATCH');
    if (record.approval !== null && (record.approval.candidateDigest !== record.candidateDigest || record.approval.testsDigest !== record.testsDigest)) {
      problems.push('APPROVAL_BINDING_MISMATCH');
    }
    return problems;
  };
  const listIds = () => ['rules', 'drills'].flatMap(kind => {
    try { return readdirSync(join(directory, kind)).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)); } catch { return []; }
  }).filter(id => CANDIDATE_ID.test(id)).sort();

  return Object.freeze({
    directory,
    /** 寫入新候選（狀態 CANDIDATE）；同一候選重寫為冪等，不同內容拒絕覆寫。 */
    write(candidate) {
      const kind = candidateKind(candidate);
      insist(CANDIDATE_ID.test(candidate.candidateId), 'CANDIDATE_ID_INVALID');
      const candidateDigest = digestOf('dungeonq.learning-candidate/v1', candidate);
      privateDirectory(join(directory, kind));
      const path = pathOf(kind, candidate.candidateId);
      let existing = null;
      if (existsSync(path)) { try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch { return fail('CANDIDATE_RECORD_INVALID'); } }
      if (existing) {
        insist(existing.candidateDigest === candidateDigest, 'CANDIDATE_CONFLICT');
        return structuredClone(existing);
      }
      insist(listIds().length < LEARNING_LIMITS.maxCandidates, 'CANDIDATE_CAPACITY');
      return save({ schemaVersion: CANDIDATE_RECORD_SCHEMA, kind, candidate: structuredClone(candidate), candidateDigest, state: 'CANDIDATE',
        tests: null, testsDigest: null, approval: null, publication: 'NOT_PUBLISHED', history: [{ at: iso(clock()), event: 'WRITTEN' }] });
    },
    /** 執行測試並記錄；測試資料（軌跡）只用來計算，不寫入候選目錄。 */
    runTests(candidateId, { recordedTraces, legitimateTraces, pattern }) {
      const record = read(candidateId);
      insist(integrity(record).length === 0, 'CANDIDATE_INTEGRITY_FAILED', integrity(record));
      insist(record.state !== 'PUBLISHABLE', 'CANDIDATE_ALREADY_APPROVED');
      let tests;
      if (record.kind === 'rules') {
        tests = testRuleCandidate(record.candidate, { recordedTraces, legitimateTraces });
        tests.passed = tests.hit.passed && tests.falsePositive.passed;
      } else {
        tests = testDrillCandidate(record.candidate, recordedTraces, pattern);
        tests.passed = tests.reproducible.passed && tests.content.passed;
      }
      tests.ranAt = iso(clock());
      record.tests = tests; record.testsDigest = digestOf('dungeonq.learning-candidate-tests/v1', tests);
      record.state = tests.passed ? 'TESTED' : 'TEST_FAILED'; record.approval = null;
      record.history.push({ at: tests.ranAt, event: tests.passed ? 'TESTS_PASSED' : 'TESTS_FAILED' });
      return save(record);
    },
    /**
     * 真人核准。verifier.verify 由 M3（已驗證登入）提供；本函式不接受未驗證的核准，也不保存核准證明本身。
     * @param {{ approvalId: string, proof: unknown }} approval
     */
    async approve(candidateId, approval, { verifier, signal } = {}) {
      const record = read(candidateId);
      insist(integrity(record).length === 0, 'CANDIDATE_INTEGRITY_FAILED', integrity(record));
      insist(record.tests !== null, 'CANDIDATE_TESTS_REQUIRED');
      insist(record.state === 'TESTED' && record.tests.passed === true, 'CANDIDATE_TESTS_NOT_PASSED');
      insist(verifier && typeof verifier.verify === 'function', 'APPROVAL_VERIFIER_REQUIRED');
      insist(approval && typeof approval.approvalId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(approval.approvalId), 'APPROVAL_INVALID');
      const binding = { candidateId, candidateDigest: record.candidateDigest, testsDigest: record.testsDigest };
      const controller = new AbortController(); let timer;
      signal?.addEventListener('abort', () => controller.abort(), { once: true });
      let verdict;
      try {
        verdict = await Promise.race([
          Promise.resolve().then(() => verifier.verify({ ...binding, approval: { approvalId: approval.approvalId, proof: approval.proof }, signal: controller.signal })),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new IncidentReviewError('APPROVAL_VERIFY_TIMEOUT')); }, LEARNING_LIMITS.approvalTimeoutMs); })
        ]);
      } catch (error) {
        record.history.push({ at: iso(clock()), event: 'APPROVAL_UNVERIFIED', reason: error?.code ?? 'APPROVAL_VERIFY_FAILED' }); save(record);
        return fail(error?.code === 'APPROVAL_VERIFY_TIMEOUT' ? 'APPROVAL_VERIFY_TIMEOUT' : 'APPROVAL_NOT_VERIFIED');
      } finally { clearTimeout(timer); }
      const verified = verdict?.verified === true && typeof verdict.approverId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(verdict.approverId)
        && verdict.candidateDigest === binding.candidateDigest && verdict.testsDigest === binding.testsDigest;
      if (!verified) {
        record.history.push({ at: iso(clock()), event: 'APPROVAL_UNVERIFIED', reason: typeof verdict?.reason === 'string' ? verdict.reason.slice(0, 80) : 'NOT_VERIFIED' });
        save(record);
        return fail('APPROVAL_NOT_VERIFIED');
      }
      record.approval = { approvalId: approval.approvalId, approverId: verdict.approverId, method: String(verdict.method ?? 'UNSPECIFIED').slice(0, 64),
        verifiedAt: iso(clock()), ...binding };
      record.state = 'PUBLISHABLE';
      record.history.push({ at: record.approval.verifiedAt, event: 'APPROVED', approverId: verdict.approverId });
      return save(record);
    },
    /** 重新讀檔並檢查摘要；被改過時回報 INVALID（即使原本是 PUBLISHABLE）。 */
    status(candidateId) {
      const record = read(candidateId); const problems = integrity(record);
      return { candidateId, kind: record.kind, state: problems.length ? 'INVALID' : record.state, problems, publication: record.publication,
        tests: record.tests, approval: record.approval };
    },
    get: candidateId => structuredClone(read(candidateId)),
    list: () => listIds().map(id => { const record = read(id); return { candidateId: id, kind: record.kind, state: record.state }; })
  });
}

/* ------------------------------------------------------------------ */
/* 報告                                                                 */
/* ------------------------------------------------------------------ */

const cell = value => String(value ?? '—').replace(/[\r\n]+/gu, ' ').replaceAll('|', '\\|');
const percent = value => (typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—');
const milliseconds = value => (typeof value === 'number' ? `${value.toFixed(1)} 毫秒` : '—');
const seconds = value => (typeof value === 'number' ? `${(value / 1000).toFixed(1)} 秒` : '—');
const yesNo = value => (value === true ? '是' : value === false ? '否' : 'UNKNOWN');
const table = (headers, rows) => [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`,
  ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)];

/** 依 5.2 八個段落產生 Markdown。只使用 model 中已過濾的欄位。 */
export function renderPostIncidentReport(model) {
  const lines = [`# DungeonQ 事後檢討報告：${model.summary.incidentId}`, '',
    `- 報告版本：\`${POST_INCIDENT_REPORT_VERSION}\`；範本：\`${POST_INCIDENT_TEMPLATE}\`。`,
    `- 產生時間：${model.generatedAt}；執行模式：\`${model.isolation}\`；證據完整性：\`${model.evidenceIndex.evidenceIntegrity}\`。`,
    '- 本報告不含憑證、ticket 原值、誘餌原文或個資；時間不明者標 UNKNOWN，不倒填。', ''];
  const section = key => { const found = POST_INCIDENT_SECTIONS.find(entry => entry.key === key); lines.push(sectionHeading(found), ''); };

  section('summary');
  lines.push(...table(['項目', '內容'], [
    ['事件編號', model.summary.incidentId],
    ['開始時間', model.summary.startedAt ?? 'UNKNOWN'],
    ['結束時間', model.summary.endedAt ?? 'UNKNOWN'],
    ['嚴重度', model.summary.severity],
    ['結論', `${INCIDENT_VERDICTS[model.summary.verdict]}（${model.summary.verdict}）`],
    ['代理身分已確認', yesNo(model.summary.identityConfirmed)]
  ]), '');

  section('timeline');
  lines.push(...table(['階段', '時間', '執行者', '說明'], model.timeline.map(row => [row.label, row.at ?? 'UNKNOWN', row.executor ?? 'UNKNOWN', row.note])), '');

  section('wrongTicket');
  const ticket = model.wrongTicket;
  lines.push(...table(['項目', '結果'], [
    ['交付的錯誤 ticket 張數', ticket.delivered],
    ['是否被接受', yesNo(ticket.accepted)],
    ['出示次數／被接受次數', `${ticket.uses}／${ticket.acceptedUses}`],
    ['使用入口', ticket.entries.length ? ticket.entries.join('、') : '無'],
    ['不同來源線索數（未驗證）', ticket.distinctSources],
    ['是否擴散', yesNo(ticket.spread)],
    ['識破訊號', ticket.recognitionSignals.length ? ticket.recognitionSignals.map(entry => `${entry.label}（${entry.at}）`).join('；') : '觀察期內沒有（右設限）']
  ]), '');

  section('impact');
  lines.push(`- 真實資產（受保護來源）被事件 context 讀取次數：${model.impact.realAssetReads}。`, '');
  lines.push(...table(['合法消費者階段', '樣本數', '成功率', 'p50 延遲', 'p95 延遲'], ['BEFORE', 'DURING', 'AFTER'].map(phase => {
    const row = model.impact.health?.[phase];
    return [{ BEFORE: '處置前', DURING: '處置中', AFTER: '處置後' }[phase], row?.count ?? 'UNKNOWN', percent(row?.successRate), milliseconds(row?.p50LatencyMs), milliseconds(row?.p95LatencyMs)];
  })), '');
  lines.push(...table(['受影響的合法使用者', '原因', '通知結果'], model.impact.affectedUsers.length
    ? model.impact.affectedUsers.map(row => [row.recipientId, row.reasons.join('、'), row.notification])
    : [['無', '—', '—']]), '');

  section('response');
  lines.push('A 級自動動作：', '');
  lines.push(...table(['動作', '名稱', '對象', '狀態', '讀回', '時間'], model.response.automaticActions.length
    ? model.response.automaticActions.map(row => [row.actionCode, row.actionName, row.targetId, row.status, row.readback, row.recordedAt])
    : [['無', '—', '—', '—', '—', '—']]), '');
  lines.push('B 級工單：', '');
  lines.push(...table(['工單', '動作', '狀態', '讀回確認'], model.response.workOrders.length
    ? model.response.workOrders.map(row => [row.workOrderId, `${row.actionCode} ${row.actionName}`, row.status, row.verification])
    : [['無', '—', '—', '—']]), '');
  lines.push('結束流程撤權與 FENCE 去留：', '');
  lines.push(...table(['項目', '結果'], [
    ['撤權項目（全部讀回被拒）', `${model.response.revocation.denied}／${model.response.revocation.items}`],
    ...model.response.fence.map(row => [`FENCE ${row.contextId}`, `${row.decision}：${row.reasons.join('、')}`])
  ]), '');

  section('rootCause');
  lines.push(...table(['面向', '發現', '改善', '後續待辦 Owner'], ROOT_CAUSE_AREAS.map(area => {
    const row = model.rootCause[area.key];
    return [area.label, row.finding, row.improvement, row.owner];
  })), '');
  if (model.followUps.length) lines.push(...table(['後續待辦', 'Owner', '期限'], model.followUps.map(row => [row.item, row.owner, row.due ?? '未定'])), '');

  section('learning');
  if (model.learning.rules.length === 0 && model.learning.drills.length === 0) {
    lines.push(`- 沒有新樣態。理由：${model.learning.noNewPatternReason}`, '');
  } else {
    lines.push('- 候選只寫在私人候選目錄，不會自動發布到任何規則集或情境包；發布前需命中測試、誤判測試與已驗證的真人核准。', '');
    lines.push(...table(['候選', '種類', '內容', '命中測試', '誤判測試', '狀態'], [
      ...model.learning.rules.map(row => [row.candidateId, `偵測規則 ${row.kind}`, row.summary,
        `${row.tests.hit.hits}／${row.tests.hit.traces} 條軌跡命中`, `${row.tests.falsePositive.hits} 次誤判／${row.tests.falsePositive.events} 個合法事件`, row.state]),
      ...model.learning.drills.map(row => [row.candidateId, '合成演練案例', `種子 0x${row.seed.toString(16).padStart(8, '0')}，${row.steps} 步`, '可重現', '不適用', row.state])
    ]), '');
  }
  lines.push(`- 工具呼叫順序：${model.learning.pattern.toolSequence.join(' → ') || '無'}；接受前：${model.learning.pattern.beforeAcceptance.join(' → ') || '無'}；接受後：${model.learning.pattern.afterAcceptance.join(' → ') || '無'}。`);
  lines.push(`- 轉向時機：${model.learning.pattern.pivotAfterAcceptanceMs === null ? '沒有觀察到轉向' : `接受後 ${seconds(model.learning.pattern.pivotAfterAcceptanceMs)}`}。`, '');

  section('evidenceIndex');
  const evidence = model.evidenceIndex;
  lines.push(...table(['項目', '內容'], [
    ['私人 manifest 位置', `${evidence.caseLabel}/${evidence.manifestPath}`],
    ['manifest 摘要（SHA-256）', evidence.manifestDigest],
    ['已簽聲明摘要', evidence.attestationDigest],
    ['涵蓋的已簽檢查點', evidence.checkpointDigest],
    ['封存時的 journal 序號', evidence.journalSequence],
    ['證據完整性', evidence.evidenceIntegrity]
  ]), '');
  lines.push(...table(['證據檔', 'SHA-256'], evidence.artifacts.map(row => [row.path, row.sha256])), '');
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`;
}

/** 取出 Markdown 的二級標題（給格式檢查與測試）。 */
export function reportHeadings(markdown) {
  return markdown.split('\n').filter(line => /^## /u.test(line)).map(line => line.trim());
}

/** 格式檢查：八個段落依序各出現一次；第 6 段每個面向都有 Owner。 */
export function checkReportFormat(markdown, model) {
  const problems = [];
  const expected = POST_INCIDENT_SECTIONS.map(sectionHeading);
  const actual = reportHeadings(markdown);
  if (canonicalJson(actual) !== canonicalJson(expected)) problems.push('SECTIONS_MISMATCH');
  if (model && ROOT_CAUSE_AREAS.some(area => !(typeof model.rootCause?.[area.key]?.owner === 'string' && model.rootCause[area.key].owner.trim()))) {
    problems.push('FOLLOW_UP_OWNER_MISSING');
  }
  if (model && model.learning.rules.length + model.learning.drills.length === 0 && !model.learning.noNewPatternReason) problems.push('LEARNING_REASON_MISSING');
  return problems;
}

/** 內容檢查：比對呼叫端提供的敏感原值（只在記憶體中）與憑證、ticket、個資樣式。命中就回報，不自動遮蔽。 */
export function checkSensitiveContent(text, { sensitiveValues = [] } = {}) {
  return redactDungeonqSensitiveText(text, { sensitiveValues }).findings;
}
