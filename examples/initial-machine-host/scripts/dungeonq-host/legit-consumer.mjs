import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * DungeonQ 合成合法消費者（DQ-HANDOFF-015 M5，計畫第四部分）。
 *
 * - 用自己的合法憑證與消費者綁定，以固定頻率（預設每秒 1 次）呼叫受保護來源的業務介面。
 * - 只在實驗或演練期間運作：有最長時間、最多樣本數，停止後不再發出請求。
 * - 每次請求記錄成功與否與延遲，分「處置前、處置中（含過渡期）、處置後」三段報告。
 * - measure() 的輸出格式就是處置政策 evaluateDungeonqLegitimateHealth 的輸入格式。
 * - 連續失敗時探測間隔逐次拉長（上限 30 秒）並升級；連續失敗達上限即停止。
 * - 來源回應帶有新的憑證世代時，用消費者綁定取回新憑證並自動換用（L-3）；每個世代最多取 3 次。
 * 報告與事件不含任何憑證或綁定值。
 */

export const LEGIT_CONSUMER_SCHEMA_VERSION = 'dungeonq.legit-consumer-report/v1';
export const LEGIT_CONSUMER_PHASES = Object.freeze(['BEFORE', 'DURING', 'AFTER']);
export const LEGIT_CONSUMER_LIMITS = Object.freeze({
  defaultIntervalMs: 1_000,
  minIntervalMs: 50,
  maxIntervalMs: 5_000,
  defaultDurationMs: 10 * 60_000,
  maxDurationMs: 15 * 60_000,
  requestTimeoutMs: 2_000,
  maxBackoffMs: 30_000,
  escalateAfterConsecutiveFailures: 3,
  stopAfterConsecutiveFailures: 20,
  maxSamples: 2_000,
  minBaselineSamples: 5,
  credentialFetchAttemptsPerEpoch: 3,
  maxRecordedFailures: 50,
  ipcTimeoutMs: 5_000
});

const BINDING_HEADER = 'x-dungeonq-consumer-binding';
const EPOCH_HEADER = 'x-dungeonq-credential-epoch';
const tokenPattern = /^[A-Za-z0-9_.-]{16,2048}$/u;
const labelPattern = /^[A-Za-z0-9_-]{1,64}$/u;

export class LegitConsumerError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LegitConsumerError';
    this.code = code;
  }
}
const insist = (ok, code) => {
  if (!ok) throw new LegitConsumerError(code);
};

function segmentStats(samples) {
  const count = samples.length;
  const successes = samples.filter((sample) => sample.ok).length;
  const latencies = samples.map((sample) => sample.latencyMs).sort((left, right) => left - right);
  const percentile = (q) => (count === 0 ? null : latencies[Math.max(0, Math.ceil(q * count) - 1)]);
  return {
    count,
    successes,
    successRate: count === 0 ? null : successes / count,
    p50LatencyMs: percentile(0.5),
    p95LatencyMs: percentile(0.95)
  };
}

/** 三段統計：成功率與延遲第 50／95 百分位（最近排名法）。 */
export function summarizeLegitSamples(samples) {
  return Object.fromEntries(LEGIT_CONSUMER_PHASES.map((phase) => [phase, segmentStats(samples.filter((sample) => sample.phase === phase))]));
}

/**
 * 健康量測：baseline 是處置前整段，current 是 sinceMs 之後的樣本。
 * 處置前樣本不足時回報 0 個樣本，讓政策判定為 UNKNOWN，不用猜的基線。
 */
export function legitHealthMeasurement(samples, { sinceMs, measuredAtMs }) {
  insist(Number.isFinite(sinceMs) && Number.isFinite(measuredAtMs), 'MEASUREMENT_WINDOW_INVALID');
  const baseline = segmentStats(samples.filter((sample) => sample.phase === 'BEFORE'));
  const current = segmentStats(samples.filter((sample) => sample.startedAt >= sinceMs));
  const usable = baseline.count >= LEGIT_CONSUMER_LIMITS.minBaselineSamples && current.count > 0;
  return {
    measuredAt: new Date(measuredAtMs).toISOString(),
    sampleCount: usable ? current.count : 0,
    baseline: { successRate: baseline.successRate ?? 0, p95LatencyMs: baseline.p95LatencyMs ?? 0 },
    current: { successRate: current.successRate ?? 0, p95LatencyMs: current.p95LatencyMs ?? 0 }
  };
}

const sleep = (ms, signal) => new Promise((done) => {
  if (signal.aborted) return done();
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
});

/**
 * 啟動合法消費者。回傳的物件可切換階段、量測健康、取得報告與停止。
 * @param {object} options
 * @param {string} options.origin 受保護來源，只接受 http://127.0.0.1:<port>。
 * @param {string} options.consumerId 登錄的合法消費者代號。
 * @param {string} options.bindingToken 消費者綁定（只用來證明身分與取回新憑證）。
 * @param {string} options.credential 目前的業務憑證。
 * @param {{operation: 'snapshot'} | {operation: 'read', key: string, expectedContentsSha256?: string}} [options.probe]
 */
export function startLegitConsumer({
  origin, consumerId, bindingToken, credential, initialEpoch = 0,
  probe = { operation: 'snapshot' },
  durationMs = LEGIT_CONSUMER_LIMITS.defaultDurationMs,
  intervalMs = LEGIT_CONSUMER_LIMITS.defaultIntervalMs,
  requestTimeoutMs = LEGIT_CONSUMER_LIMITS.requestTimeoutMs,
  clock = Date.now,
  fetchImpl = fetch,
  onEscalate = () => {},
  onEvent = () => {}
}) {
  insist(typeof origin === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(origin), 'CONSUMER_ORIGIN_INVALID');
  insist(typeof consumerId === 'string' && labelPattern.test(consumerId), 'CONSUMER_ID_INVALID');
  insist(typeof bindingToken === 'string' && tokenPattern.test(bindingToken), 'CONSUMER_BINDING_INVALID');
  insist(typeof credential === 'string' && tokenPattern.test(credential) && credential !== bindingToken, 'CONSUMER_CREDENTIAL_INVALID');
  insist(Number.isSafeInteger(initialEpoch) && initialEpoch >= 0, 'CONSUMER_EPOCH_INVALID');
  insist(probe && (probe.operation === 'snapshot' && Object.keys(probe).length === 1
    || probe.operation === 'read' && typeof probe.key === 'string' && labelPattern.test(probe.key)
      && (probe.expectedContentsSha256 === undefined || /^[a-f0-9]{64}$/u.test(probe.expectedContentsSha256))), 'CONSUMER_PROBE_INVALID');
  insist(Number.isSafeInteger(durationMs) && durationMs >= 1 && durationMs <= LEGIT_CONSUMER_LIMITS.maxDurationMs, 'CONSUMER_DURATION_INVALID');
  insist(Number.isSafeInteger(intervalMs) && intervalMs >= LEGIT_CONSUMER_LIMITS.minIntervalMs
    && intervalMs <= LEGIT_CONSUMER_LIMITS.maxIntervalMs, 'CONSUMER_INTERVAL_INVALID');
  insist(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs >= 50 && requestTimeoutMs <= 10_000, 'CONSUMER_TIMEOUT_INVALID');
  insist(typeof clock === 'function' && typeof fetchImpl === 'function' && typeof onEscalate === 'function'
    && typeof onEvent === 'function', 'CONSUMER_OPTIONS_INVALID');

  const limits = LEGIT_CONSUMER_LIMITS;
  const runId = randomBytes(6).toString('hex');
  const startedAt = clock();
  const deadline = startedAt + durationMs;
  const stopController = new AbortController();
  const samples = [];
  const failures = [];
  const switches = [];
  const phases = [{ phase: 'BEFORE', at: new Date(startedAt).toISOString() }];
  const fetchAttempts = new Map();
  let phase = 'BEFORE';
  let token = credential;
  let epoch = initialEpoch;
  let consecutiveFailures = 0;
  let maxConsecutiveFailures = 0;
  let escalations = 0;
  let stopReason = null;
  let stoppedAt = null;

  const emit = (event) => {
    try { onEvent(event); } catch { /* 觀察者失敗不影響探測。 */ }
  };
  const escalate = (reason) => {
    escalations += 1;
    const escalation = { consumerId, runId, reason, consecutiveFailures, phase, at: new Date(clock()).toISOString() };
    emit({ kind: 'ESCALATION', ...escalation });
    try { onEscalate(escalation); } catch { /* 升級失敗只記在報告的計數中。 */ }
  };

  /** 以綁定取回目前憑證；每個觸發來源（世代）最多 3 次，不無限重試。 */
  const fetchCredential = async (trigger) => {
    const attempts = fetchAttempts.get(trigger) ?? 0;
    if (attempts >= limits.credentialFetchAttemptsPerEpoch || fetchAttempts.size > 64) return false;
    fetchAttempts.set(trigger, attempts + 1);
    try {
      const response = await fetchImpl(`${origin}/consumer/credential`, {
        headers: { authorization: `Bearer ${bindingToken}` }, signal: AbortSignal.timeout(requestTimeoutMs)
      });
      if (!response.ok) return false;
      const body = await response.json();
      if (typeof body?.token !== 'string' || !tokenPattern.test(body.token) || !Number.isSafeInteger(body.epoch) || body.epoch <= epoch) return false;
      token = body.token;
      epoch = body.epoch;
      const switched = { epoch, at: new Date(clock()).toISOString(), phase };
      switches.push(switched);
      emit({ kind: 'CREDENTIAL_SWITCHED', ...switched });
      return true;
    } catch {
      return false;
    }
  };

  const verifyBody = (body) => {
    if (probe.operation === 'snapshot') return Array.isArray(body?.records);
    const contents = body?.value?.contents;
    if (body?.key !== probe.key) return false;
    if (probe.expectedContentsSha256 === undefined) return true;
    return typeof contents === 'string'
      && createHash('sha256').update(Buffer.from(contents, 'base64')).digest('hex') === probe.expectedContentsSha256;
  };

  const probeOnce = async () => {
    const seq = samples.length + 1;
    const begun = clock();
    const started = performance.now();
    let ok = false;
    let code = 'OK';
    let hint = null;
    try {
      const response = await fetchImpl(`${origin}/business`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', [BINDING_HEADER]: bindingToken },
        body: JSON.stringify({
          contextId: 'ordinary', requestId: `legit-${consumerId}-${runId}-${seq}`, operation: probe.operation,
          args: probe.operation === 'read' ? { key: probe.key } : {}
        }),
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
      const header = response.headers.get(EPOCH_HEADER);
      hint = header !== null && /^\d{1,15}$/u.test(header) ? Number(header) : null;
      const body = await response.json().catch(() => null);
      if (response.ok) {
        ok = verifyBody(body);
        code = ok ? 'OK' : 'UNEXPECTED_CONTENT';
      } else {
        code = typeof body?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(body.error.code) ? body.error.code : `HTTP_${response.status}`;
      }
    } catch (error) {
      code = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'TIMEOUT' : 'TRANSPORT_ERROR';
    }
    const latencyMs = Math.round((performance.now() - started) * 1000) / 1000;
    const sample = { seq, phase, startedAt: begun, latencyMs, ok, code, epoch };
    samples.push(sample);
    emit({ kind: 'SAMPLE', seq, phase, ok, code, latencyMs, epoch });
    if (ok) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
      maxConsecutiveFailures = Math.max(maxConsecutiveFailures, consecutiveFailures);
      if (failures.length < limits.maxRecordedFailures) failures.push({ seq, phase, code, epoch });
      if (consecutiveFailures === limits.escalateAfterConsecutiveFailures) escalate('LEGIT_CONSUMER_CONSECUTIVE_FAILURES');
    }
    // L-3：來源提示有新世代，或舊憑證被拒時，用綁定換用新憑證。
    if (hint !== null && hint > epoch) await fetchCredential(`epoch:${hint}`);
    else if (code === 'ORIGIN_AUTHORITY_DENIED') await fetchCredential(`denied:${epoch}`);
  };

  const report = () => ({
    schemaVersion: LEGIT_CONSUMER_SCHEMA_VERSION,
    consumerId,
    runId,
    startedAt: new Date(startedAt).toISOString(),
    stoppedAt: stoppedAt === null ? null : new Date(stoppedAt).toISOString(),
    stopReason,
    probe: { operation: probe.operation, intervalMs, requestTimeoutMs, durationMs },
    phases: phases.map((entry) => ({ ...entry })),
    segments: summarizeLegitSamples(samples),
    complete: LEGIT_CONSUMER_PHASES.every((name) => samples.some((sample) => sample.phase === name)),
    sampleCount: samples.length,
    failures: failures.map((entry) => ({ ...entry })),
    maxConsecutiveFailures,
    escalations,
    credential: { initialEpoch, finalEpoch: epoch, switches: switches.map((entry) => ({ ...entry })) }
  });

  const done = (async () => {
    try {
      while (!stopController.signal.aborted) {
        if (clock() >= deadline) { stopReason = 'DURATION_REACHED'; break; }
        if (samples.length >= limits.maxSamples) { stopReason = 'SAMPLE_LIMIT'; break; }
        const begun = clock();
        await probeOnce();
        if (consecutiveFailures >= limits.stopAfterConsecutiveFailures) {
          stopReason = 'CONSECUTIVE_FAILURES';
          escalate('LEGIT_CONSUMER_STOPPED_AFTER_FAILURES');
          break;
        }
        // 失敗時間隔逐次加倍，最長 30 秒；成功即回到固定頻率。
        const wait = consecutiveFailures === 0 ? intervalMs : Math.min(intervalMs * 2 ** consecutiveFailures, limits.maxBackoffMs);
        await sleep(Math.max(0, wait - (clock() - begun)), stopController.signal);
      }
    } finally {
      stopReason ??= 'STOPPED';
      stoppedAt = clock();
      emit({ kind: 'STOPPED', reason: stopReason });
    }
    return report();
  })();

  return {
    runId,
    phase: () => phase,
    credentialEpoch: () => epoch,
    /** 階段只能往後：BEFORE → DURING → AFTER。 */
    setPhase(next) {
      insist(LEGIT_CONSUMER_PHASES.includes(next) && LEGIT_CONSUMER_PHASES.indexOf(next) > LEGIT_CONSUMER_PHASES.indexOf(phase), 'CONSUMER_PHASE_INVALID');
      phase = next;
      phases.push({ phase: next, at: new Date(clock()).toISOString() });
    },
    measure({ sinceMs }) {
      return legitHealthMeasurement(samples, { sinceMs, measuredAtMs: clock() });
    },
    report,
    async stop() {
      stopController.abort();
      return done;
    },
    done
  };
}

/* ------------------------------------------------------------------ */
/* 獨立程序模式：父程序以 IPC 控制，憑證不經過命令列或環境變數。              */
/* ------------------------------------------------------------------ */

const modulePath = fileURLToPath(import.meta.url);

/**
 * 以子程序啟動合法消費者。所有 IPC 呼叫都有逾時；父程序斷線時子程序自行停止。
 * @returns {Promise<{pid: number, runId: string, setPhase(phase: string): Promise<void>, measure(args: {sinceMs: number}): Promise<object>,
 *   report(): Promise<object>, stop(): Promise<object>, escalations: object[]}>}
 */
export async function forkLegitConsumer(options) {
  const child = fork(modulePath, ['--ipc'], { execArgv: [], env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr?.resume();
  const pending = new Map();
  const escalations = [];
  let sequence = 0;
  let exited = false;
  child.on('message', (message) => {
    if (message?.event === 'escalation') {
      if (escalations.length < 100) escalations.push(message.escalation);
      return;
    }
    const waiter = pending.get(message?.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok) waiter.done(message.value);
    else waiter.fail(new LegitConsumerError(typeof message.code === 'string' ? message.code : 'CONSUMER_IPC_FAILED'));
  });
  child.once('exit', () => {
    exited = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.fail(new LegitConsumerError('CONSUMER_EXITED'));
    }
    pending.clear();
  });
  const call = (command, extra = {}) => new Promise((done, fail) => {
    if (exited) return fail(new LegitConsumerError('CONSUMER_EXITED'));
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      fail(new LegitConsumerError('CONSUMER_IPC_TIMEOUT'));
    }, LEGIT_CONSUMER_LIMITS.ipcTimeoutMs);
    pending.set(id, { done, fail, timer });
    child.send({ id, command, ...extra });
  });
  const kill = async () => {
    if (exited) return;
    await new Promise((done) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      child.once('exit', () => { clearTimeout(timer); done(); });
      child.kill('SIGTERM');
    });
  };
  try {
    const { runId } = await call('start', { options });
    return {
      pid: child.pid,
      runId,
      escalations,
      setPhase: async (phase) => { await call('phase', { phase }); },
      measure: async ({ sinceMs }) => (await call('measure', { sinceMs })).measurement,
      report: async () => (await call('report')).report,
      async stop() {
        try {
          return (await call('stop')).report;
        } finally {
          await kill();
        }
      }
    };
  } catch (error) {
    await kill();
    throw error;
  }
}

function runIpcWorker() {
  let consumer = null;
  const reply = (id, value) => process.send?.({ id, ok: true, value });
  process.on('message', async (message) => {
    const id = message?.id;
    try {
      if (message?.command === 'start') {
        insist(consumer === null, 'CONSUMER_ALREADY_STARTED');
        consumer = startLegitConsumer({ ...message.options, onEscalate: (escalation) => process.send?.({ event: 'escalation', escalation }) });
        reply(id, { runId: consumer.runId });
      } else {
        insist(consumer !== null, 'CONSUMER_NOT_STARTED');
        if (message?.command === 'phase') { consumer.setPhase(message.phase); reply(id, {}); }
        else if (message?.command === 'measure') reply(id, { measurement: consumer.measure({ sinceMs: message.sinceMs }) });
        else if (message?.command === 'report') reply(id, { report: consumer.report() });
        else if (message?.command === 'stop') reply(id, { report: await consumer.stop() });
        else throw new LegitConsumerError('CONSUMER_COMMAND_UNKNOWN');
      }
    } catch (error) {
      process.send?.({ id, ok: false, code: error?.code ?? 'CONSUMER_FAILED' });
    }
  });
  const shutdown = () => {
    void (consumer ? consumer.stop() : Promise.resolve()).finally(() => process.exit(0));
  };
  process.once('disconnect', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath && process.argv.includes('--ipc') && typeof process.send === 'function') runIpcWorker();
