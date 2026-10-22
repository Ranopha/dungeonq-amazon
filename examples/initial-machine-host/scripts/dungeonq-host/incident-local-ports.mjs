// DungeonQ 事件結束流程的本機注入介面（DQ-HANDOFF-015 M7）。
//
// 只用執行環境與 FileOrigin 已有的 API 組成 incident-close.mjs 需要的 world、evidence、revocation 介面，
// 適用 LOCAL_PROOF_KERNEL（同一 OS 使用者的程序層）與之後的整合入口。不寄送、不呼叫模型、不連外。
//
// 執行環境目前沒有的撤銷 API（以 revocation 介面的 UNSUPPORTED 明確停止，不自行繞過）：
// - 單張錯誤 ticket 撤銷：ticket 綁定 context 與 epoch，只能隨 context 封鎖（FENCE）推進 epoch 一起失效。
// - 單一工作程序授權（變動授權）撤銷：同樣綁定 epoch，只能隨 FENCE 失效。
// - 不封鎖 context 而單獨推進 epoch：沒有對應命令。
// 封鎖仍為 ACTIVE 的 context 一律交給 incident-close.mjs 經政策與處置連接器執行，本模組拒絕直接封鎖。
import { randomUUID, createHash } from 'node:crypto';
import { readJournalReadOnly, recomputeJournalChain } from '../../vendor/dungeonq-runtime/runtime/evidence-seal.mjs';

export const LOCAL_PORT_LIMITS = Object.freeze({ maxTicketUsePages: 50, ticketUsePageSize: 500, httpTimeoutMs: 5_000, maxResponseBytes: 16 * 1024 * 1024 });

export class LocalPortError extends Error {
  constructor(code) { super(code); this.name = 'LocalPortError'; this.code = code; }
}
const fail = code => { throw new LocalPortError(code); };
const sha = value => createHash('sha256').update(value).digest('hex');

/** 以 GET／POST 呼叫本機服務；有逾時，失敗只回錯誤碼，不重試。 */
async function callJson(origin, path, token, body, signal) {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(origin)) fail('LOCAL_ORIGIN_INVALID');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), LOCAL_PORT_LIMITS.httpTimeoutMs);
  const onAbort = () => controller.abort(); signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let response;
    try {
      response = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { return fail('LOCAL_TRANSPORT_UNKNOWN'); }
    const text = await response.text();
    if (Buffer.byteLength(text) > LOCAL_PORT_LIMITS.maxResponseBytes) fail('LOCAL_RESPONSE_TOO_LARGE');
    let parsed; try { parsed = JSON.parse(text); } catch { return fail('LOCAL_RESPONSE_INVALID'); }
    if (!response.ok) {
      const code = parsed?.error?.code;
      return fail(typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(code) ? code : `LOCAL_HTTP_${response.status}`);
    }
    return parsed;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

/**
 * world 介面：freeze 停止參與者入口（注入的 intake），readFreeze 以唯讀連線讀 journal 位置。
 * @param {{ db: string, intake: { stop(args: { signal: AbortSignal }): Promise<void>, isStopped(): boolean }, dbTimeoutMs?: number }} options
 */
export function createJournalWorldPort({ db, intake, dbTimeoutMs = 2_000 }) {
  if (!intake || typeof intake.stop !== 'function' || typeof intake.isStopped !== 'function') fail('WORLD_INTAKE_REQUIRED');
  const position = () => {
    const chain = recomputeJournalChain(readJournalReadOnly(db, { timeoutMs: dbTimeoutMs }));
    if (chain.status !== 'LINKED') fail('JOURNAL_CHAIN_BROKEN');
    return { journalSequence: chain.linkedThrough, journalHead: chain.head };
  };
  return Object.freeze({
    async freeze({ signal }) { await intake.stop({ signal }); return { frozen: intake.isStopped() }; },
    async readFreeze() { return { frozen: intake.isStopped() === true, ...position() }; }
  });
}

/**
 * evidence 介面：匯出 journal、寄件佇列、來源見證、ticket 使用紀錄、合法消費者健康、處置紀錄、工單與（選用）代理工具紀錄。
 * 每個來源都只回傳摘要、編號與時間；不含憑證、ticket 或誘餌內容。
 */
export function createLocalEvidencePort({ store, pitchControl = null, fileOrigin, consumer, connector, workOrders = null, toolLog = null }) {
  if (!store || !fileOrigin || !consumer || !connector) fail('EVIDENCE_SOURCES_REQUIRED');
  return Object.freeze({
    async collect({ incidentId, contexts, signal }) {
      const evidence = store.evidence();
      const pitch = pitchControl ? pitchControl.snapshot() : null;
      const uses = [];
      let tracking = false;
      if (pitchControl?.ticketTracking) {
        tracking = true; let afterSeq = 0; let complete = false;
        for (let page = 0; page < LOCAL_PORT_LIMITS.maxTicketUsePages && !complete; page++) {
          const result = pitchControl.ticketUses({ afterSeq, limit: LOCAL_PORT_LIMITS.ticketUsePageSize });
          uses.push(...result.uses); complete = result.complete; afterSeq = result.nextAfterSeq;
        }
        if (!complete) fail('EVIDENCE_TICKET_USES_INCOMPLETE');
      }
      const witness = await callJson(fileOrigin.origin, '/witness', fileOrigin.witnessToken, undefined, signal);
      const admissions = new Map((witness.admissions ?? []).map(row => [row.seq, row.context]));
      const realAssetReads = (witness.targetReads ?? []).filter(row => contexts.includes(admissions.get(row.admission_seq))).length;
      const artifacts = [
        { name: 'runtime-journal', data: { events: evidence.events, verifier: evidence.verifier } },
        { name: 'outbox', data: { configured: pitch !== null, incidents: pitch?.incidents ?? [], outbox: pitch?.outbox ?? [] } },
        { name: 'origin-witness', data: witness },
        { name: 'ticket-uses', data: { tracking, uses } },
        { name: 'ticket-ledger', data: { tracking, tickets: pitch?.ticketLedger?.tickets ?? [], incidents: pitch?.ticketLedger?.incidents ?? [],
          updates: pitch?.ticketLedger?.updates ?? [] } },
        { name: 'legit-health', data: await consumer.report() },
        { name: 'response-ledger', data: { status: connector.incidentStatus(incidentId), audit: connector.listAudit({ incidentId }) } },
        { name: 'work-orders', data: workOrders ? workOrders.summarizeIncident(incidentId) : { workOrders: [], configured: false } },
        ...(toolLog ? [{ name: 'agent-tool-log', data: { records: toolLog() } }] : [])
      ];
      return { artifacts, facts: { realAssetReads } };
    }
  });
}

/**
 * revocation 介面（執行環境 store、pitch 控制帳本與 FileOrigin）。
 * 撤權項目：WORLD_CONTEXT（context token；封鎖會推進 epoch）、WRONG_TICKET／WRONG_TICKET_SET（epoch 綁定）、
 * WORKER_GRANT（epoch 綁定的變動授權）、ORIGIN_PREVIOUS_CREDENTIAL（A-2 過渡期的舊憑證，以 REVOKE_PREVIOUS 結束）。
 * probes.ticket／probes.credential 可另外提供「拿舊值實際試一次」的讀回（例如測試持有的 ticket 或舊憑證）。
 */
export function createRuntimeRevocationPort({ store, pitchControl = null, fileOrigin = null, probes = {}, clock = Date.now }) {
  if (!store || typeof store.snapshot !== 'function' || typeof store.execute !== 'function') fail('REVOCATION_STORE_REQUIRED');
  const contextOf = (snapshot, contextId) => snapshot.contexts.find(row => row.contextId === contextId) ?? fail('REVOCATION_CONTEXT_UNKNOWN');
  const fencedAfter = (context, epoch) => context.state !== 'ACTIVE' && context.epoch > epoch;
  const originState = signal => callJson(fileOrigin.origin, '/control/response/state', fileOrigin.controlToken, undefined, signal);
  const actionIdFor = incidentId => `dq-close-${sha(`dungeonq-close-revoke-previous\n${incidentId}`).slice(0, 32)}`;

  async function inventory({ contexts, signal }) {
    const snapshot = store.snapshot(); const items = [];
    for (const contextId of contexts) {
      const context = contextOf(snapshot, contextId);
      items.push({ itemId: `context:${contextId}`, kind: 'WORLD_CONTEXT', contextId, epoch: context.epoch, state: context.state === 'ACTIVE' ? 'ACTIVE' : 'REVOKED' });
    }
    const tickets = pitchControl?.ticketTracking ? pitchControl.snapshot().ticketLedger.tickets.filter(row => contexts.includes(row.contextId)) : null;
    if (tickets) {
      for (const ticket of tickets) {
        items.push({ itemId: `wrong-ticket:${ticket.trackId}`, kind: 'WRONG_TICKET', contextId: ticket.contextId, epoch: ticket.epoch,
          state: fencedAfter(contextOf(snapshot, ticket.contextId), ticket.epoch) ? 'REVOKED' : 'ACTIVE' });
      }
    } else {
      for (const contextId of contexts) {
        const context = contextOf(snapshot, contextId);
        items.push({ itemId: `wrong-tickets:${contextId}`, kind: 'WRONG_TICKET_SET', contextId, epoch: context.epoch, state: context.state === 'ACTIVE' ? 'ACTIVE' : 'REVOKED' });
      }
    }
    for (const policy of snapshot.policies.filter(row => contexts.includes(row.contextId))) {
      const context = contextOf(snapshot, policy.contextId);
      items.push({ itemId: `worker-grant:${policy.policyId}`, kind: 'WORKER_GRANT', contextId: policy.contextId, epoch: policy.epoch,
        state: fencedAfter(context, policy.epoch) || context.epoch !== policy.epoch || policy.expiresAt <= clock() ? 'REVOKED' : 'ACTIVE' });
    }
    if (fileOrigin) {
      const state = await originState(signal); const overlap = state.credential.overlap;
      if (overlap.state !== 'NONE') {
        items.push({ itemId: `origin-credential:epoch-${overlap.previousEpoch}`, kind: 'ORIGIN_PREVIOUS_CREDENTIAL', contextId: null,
          epoch: overlap.previousEpoch, state: overlap.state === 'REVOKED' ? 'REVOKED' : 'ACTIVE' });
      }
    }
    return { items };
  }

  async function revoke({ incidentId, item, signal }) {
    if (item.kind === 'WORLD_CONTEXT') fail('REVOCATION_REQUIRES_POLICY');
    if (item.kind !== 'ORIGIN_PREVIOUS_CREDENTIAL' || !fileOrigin) fail('REVOCATION_UNSUPPORTED');
    const actionId = actionIdFor(incidentId);
    const prior = await callJson(fileOrigin.origin, '/control/response/receipt', fileOrigin.controlToken, { actionId }, signal);
    if (prior.found === true) return { outcome: 'ALREADY_REVOKED', actionId };
    const state = await originState(signal);
    if (state.credential.overlap.state === 'REVOKED') return { outcome: 'ALREADY_REVOKED', actionId: null };
    await callJson(fileOrigin.origin, '/control/response/apply', fileOrigin.controlToken,
      { actionId, kind: 'REVOKE_PREVIOUS', incidentId, expectedRevision: state.revision }, signal);
    return { outcome: 'REVOKED', actionId };
  }

  async function probe({ item, signal }) {
    const snapshot = store.snapshot();
    if (item.kind === 'WORLD_CONTEXT') {
      const context = contextOf(snapshot, item.contextId);
      if (context.state === 'ACTIVE') return { denied: false, code: 'CONTEXT_ACTIVE' };
      try {
        store.execute({ contextId: item.contextId, family: 'http', requestId: `close-probe-${randomUUID()}`, operation: 'snapshot', args: {} });
        return { denied: false, code: 'PROBE_ALLOWED' };
      } catch (error) { return { denied: error?.code === 'CONTEXT_FENCED', code: String(error?.code ?? 'PROBE_FAILED') }; }
    }
    if (item.kind === 'WRONG_TICKET' || item.kind === 'WRONG_TICKET_SET' || item.kind === 'WORKER_GRANT') {
      const context = contextOf(snapshot, item.contextId);
      const structural = fencedAfter(context, item.epoch) || (item.kind === 'WRONG_TICKET_SET' && context.state !== 'ACTIVE');
      if (!structural) return { denied: false, code: 'EPOCH_STILL_VALID' };
      if (item.kind !== 'WORKER_GRANT' && typeof probes.ticket === 'function') return probes.ticket({ item, signal });
      return { denied: true, code: item.kind === 'WORKER_GRANT' ? 'GRANT_EPOCH_REVOKED' : 'TICKET_EPOCH_REVOKED' };
    }
    if (item.kind === 'ORIGIN_PREVIOUS_CREDENTIAL') {
      const state = await originState(signal);
      if (state.credential.overlap.state !== 'REVOKED') return { denied: false, code: `OVERLAP_${state.credential.overlap.state}` };
      if (typeof probes.credential === 'function') return probes.credential({ item, signal });
      return { denied: true, code: 'ORIGIN_PREVIOUS_REVOKED' };
    }
    return { denied: false, code: 'PROBE_UNSUPPORTED' };
  }

  return Object.freeze({ inventory, revoke, probe });
}

/**
 * legitimate 介面（結束流程第 0 步）：停止合成合法消費者並讀回，保留停止時的最後一份報告（子程序消費者停止後就讀不到）。
 * 回傳物件也可直接當 createLocalEvidencePort 的 consumer（report() 停止前讀即時報告，停止後回最後一份）與健康量測來源。
 * 只停止量測用的合成消費者；不撤銷任何合法憑證，也不影響真實的合法流量。stop 失敗時不記住結果，重跑會再試一次。
 * @param {{ consumer: { stop(): Promise<object>, report(): Promise<object>|object, measure?(args: { sinceMs: number }): Promise<object>|object } }} options
 */
export function createLegitConsumerPort({ consumer }) {
  if (!consumer || typeof consumer.stop !== 'function' || typeof consumer.report !== 'function') fail('LEGIT_CONSUMER_REQUIRED');
  let final = null; let stopping = null;
  const stop = async () => {
    stopping ??= Promise.resolve().then(() => consumer.stop()).then(report => { final = report && typeof report === 'object' ? report : { stoppedAt: null }; return final; },
      error => { stopping = null; throw error; });
    await stopping;
    return { stopped: true };
  };
  return Object.freeze({
    stop,
    async state() {
      if (final !== null) return { running: false, stoppedAt: typeof final.stoppedAt === 'string' ? final.stoppedAt : null };
      const report = await consumer.report();
      const stoppedAt = typeof report?.stoppedAt === 'string' ? report.stoppedAt : null;
      return { running: stoppedAt === null, stoppedAt };
    },
    report: async () => final ?? consumer.report(),
    measure: async args => {
      if (typeof consumer.measure !== 'function') fail('LEGIT_CONSUMER_MEASURE_UNAVAILABLE');
      return consumer.measure(args);
    }
  });
}
