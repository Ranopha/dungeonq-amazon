// 一場 M9 真人驗收：真正傳輸、本人 ACK／決策、隔離來源輪替；無模型呼叫。
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand, startIsolatedLab } from './isolated-lab.mjs';
import { persistSourceAlert, respondToSourceAlert } from './source-response.mjs';
import { openHumanSourceHandoff } from './human-source-handoff.mjs';
import { createSourceCloseLauncher } from './source-close.mjs';
import { renderHumanSourceReplay } from './human-source-replay.mjs';
import { createDungeonqAlertSender, DUNGEONQ_ACK_ACCOUNT, openLiveSendBudget } from './alert-sender.mjs';
import { loadAckAccountFile } from '../../vendor/dungeonq-runtime/runtime/pitch-handoff.mjs';

const context = 'colima-dungeonq-rehearsal';
const probe = readFileSync(new URL('./source-probe-container.mjs', import.meta.url), 'utf8');
const closeProbe = readFileSync(new URL('./source-close-probe-container.mjs', import.meta.url), 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');

export function humanSourceMetrics({ alert, handoff, response, events }) {
  const measurements = handoff?.incidents?.[0]?.measurements ?? {};
  const decision = events.find(row => row.kind === 'HUMAN_ROTATE_DECISION')?.detail;
  const verified = events.find(row => row.kind === 'ROTATION_VERIFIED')?.at ?? null;
  const commit = response?.timing?.alertToEffectiveHostBoundsMs;
  const close = events.find(row => row.kind === 'HUMAN_CLOSE_RESULT' && row.detail.status === 'CLOSED');
  const closeDecision = events.find(row => row.kind === 'HUMAN_CLOSE_DECISION')?.detail;
  const delta = (end, start) => Number.isFinite(end) && Number.isFinite(start) ? end - start : null;
  const toCommit = at => commit && Number.isFinite(at) ? commit.map(ms => ms + alert.receivedAt - at) : null;
  return {
    providerAcceptedAt: measurements.providerAcceptedAt ?? null,
    inboxArrival: measurements.inboxArrival ?? { status: 'UNKNOWN', at: null },
    verifiedHumanAckAt: measurements.verifiedHumanAckAt ?? null,
    decisionAt: decision?.submittedAt ?? null, rotationVerifiedAt: verified,
    alertToVerifiedMs: delta(verified, alert?.receivedAt),
    providerToAckMs: delta(measurements.verifiedHumanAckAt, measurements.providerAcceptedAt),
    ackToDecisionMs: delta(decision?.submittedAt, measurements.verifiedHumanAckAt),
    decisionToVerifiedMs: delta(verified, decision?.submittedAt),
    closeDecisionAt: closeDecision?.submittedAt ?? null, closedAt: close?.at ?? null,
    rotationToClosedMs: delta(close?.at, verified), providerToClosedMs: delta(close?.at, measurements.providerAcceptedAt),
    humanResponseMs: delta(verified, measurements.providerAcceptedAt),
    providerToEffectiveHostBoundsMs: toCommit(measurements.providerAcceptedAt),
    decisionToEffectiveHostBoundsMs: toCommit(decision?.submittedAt),
    sourceEffectiveAt: response?.source?.events?.find(row => row.kind === 'ROTATE_EFFECTIVE')?.effectiveAt ?? null,
    unknown: ['causal_extra_time', 'real_attacker_persistence', ...(close ? [] : ['M7_close'])],
    extraTimeFromDungeonQ: 'NOT_PROVEN', newModelObservations: 0, paidCalls: 0
  };
}

export async function runHumanSourceDrill(directory, { signal, testDriver } = {}) {
  // 在建立實驗室或寄信之前確認使用者已自行建立 TOTP 帳號；不輸出密碼紀錄或種子。
  const accountPath = testDriver?.accountPath ?? DUNGEONQ_ACK_ACCOUNT;
  const observationMode = testDriver ? 'SCRIPTED_TEST' : 'HUMAN';
  if (testDriver) assert(testDriver.sender?.delivery?.mode === 'FAKE_TRANSPORT'
    && resolve(accountPath) !== resolve(DUNGEONQ_ACK_ACCOUNT), 'TEST_REQUIRES_SEPARATE_ACCOUNT_AND_FAKE_SENDER');
  assert(loadAckAccountFile(accountPath).totp, 'HUMAN_TOTP_REQUIRED');
  assert(!existsSync(directory), 'NEW_EVIDENCE_DIRECTORY_REQUIRED');
  process.umask(0o077); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const budget = openLiveSendBudget({ path: join(directory, 'live-send-budget.json'), limits: { GMAIL_SMTP: 2, LINE_PUSH: 1 } });
  const sender = testDriver?.sender ?? createDungeonqAlertSender({ measureInbox: true, budget });
  assert(sender.delivery.configured, 'ALERT_CHANNEL_REQUIRED');
  const events = [], checks = [], samples = [];
  const emit = (kind, detail) => {
    const row = { seq: events.length + 1, at: Date.now(), kind, detail };
    events.push(row); appendFileSync(join(directory, 'process.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
  };
  const save = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const codePaths = ['human-source-drill.mjs', 'human-source-handoff.mjs', 'source-response.mjs', 'source-probe-container.mjs',
    'source-close.mjs', 'source-close-probe-container.mjs', 'human-source-replay.mjs', 'incident-close.mjs', 'incident-wiring.mjs', 'evidence-sealer.mjs'];
  save('code-manifest.json', { observationMode, files: Object.fromEntries(codePaths.map(name =>
    [name, digest(readFileSync(new URL(name, import.meta.url)))])), runtimeVersion: JSON.parse(readFileSync(new URL('../../vendor/dungeonq-runtime/package.json', import.meta.url))).version });
  const check = (name, ok, detail) => { checks.push({ name, ok, detail }); emit('CHECK', { name, ok, detail }); assert(ok, name); };
  const command = async args => {
    const result = await runCommand('docker', ['--context', context, ...args], { timeout: 30000, maxBytes: 16000000 });
    if (result.code !== 0) emit('COMMAND_FAILED', { operation: args[0], code: result.code, stderr: result.stderr });
    assert.equal(result.code, 0, 'ISOLATED_COMMAND_FAILED'); return result.stdout.trim();
  };
  let lab, ui, alert, response, status, failure, consumer, keepConsumer = true, stoppedAt = null;
  let containers = {};
  const rpc = async (role, input) => {
    emit('REQUEST', { role, ...input });
    const value = JSON.parse(await command(['exec', containers[role], 'node', '--input-type=module', '-e', probe, JSON.stringify({ role, ...input })]));
    emit('RESULT', { role, action: input.action, value }); return value;
  };
  const gateway = async input => {
    emit('CLOSE_CONTROL_REQUEST', input);
    const value = JSON.parse(await command(['exec', containers.gateway, 'node', '--input-type=module', '-e', closeProbe, JSON.stringify(input)]));
    emit('CLOSE_CONTROL_RESULT', { action: input.action, value }); return value;
  };
  try {
    emit('START', { mode: observationMode === 'HUMAN' ? 'HUMAN_ACK_SCRIPTED_PARTICIPANT' : 'SCRIPTED_TEST', modelCalls: 0, sourceProtection: 'scoped-v1',
      sendLimits: { GMAIL_SMTP: 2, LINE_PUSH: 1 }, maximumWaitMs: 540000, closeWaitMs: 420000 });
    lab = await startIsolatedLab({ directory: join(directory, 'lab'), mode: 'SCRIPT_CLIENT', arm: 'DIVERT',
      lifetimeSeconds: 1500, studyFixture: 'wrong-ticket-v1', sourceProtection: 'scoped-v1' });
    check('container-isolation', (await lab.verify()).status === 'PASS');
    const manifest = JSON.parse(readFileSync(join(lab.directory, 'lab.json'), 'utf8'));
    for (const role of ['origin', 'a2', 'participant', 'gateway']) containers[role] = await command(['ps', '-q',
      '--filter', `label=com.docker.compose.project=${manifest.project}`, '--filter', `label=com.docker.compose.service=${role}`]);
    check('exact-lab-containers', Object.values(containers).every(id => /^[a-f0-9]{12,64}$/.test(id)));
    const baseline = await rpc('origin', { action: 'probe', credential: 'current' });
    check('authorized-positive-control', baseline.every(row => row.status === 200));
    const collect = async () => {
      const rows = await rpc('origin', { action: 'probe', credential: 'current' }); samples.push(...rows); return rows;
    };
    const health = { measure: async () => {
      const rows = [...await collect()]; await delay(1000); rows.push(...await collect());
      return { measuredAt: new Date().toISOString(), sampleCount: rows.length,
        baseline: { successRate: 1, p95LatencyMs: Math.max(...baseline.map(row => row.latencyMs)) },
        current: { successRate: rows.filter(row => row.status === 200).length / rows.length, p95LatencyMs: Math.max(...rows.map(row => row.latencyMs)) } };
    } };
    // 合法消費者持續讀取，處置前與處置後另由 M5 做即時健康門檻；不是攻擊者探索流量。
    consumer = (async () => { while (keepConsumer) { await collect(); await delay(3000); } })().catch(error => {
      failure = error.code ?? 'CONSUMER_UNKNOWN'; emit('UNKNOWN', { reason: failure });
    });
    const enteredAt = Date.now(); emit('PARTICIPANT_ENTERED', { mode: 'SCRIPT_CLIENT' });
    const snapshot = await rpc('participant', { action: 'workspace', operation: 'snapshot' });
    check('overview-no-target-content', !JSON.stringify(snapshot).includes('release-9e18-green'));
    const issued = await rpc('participant', { action: 'workspace', operation: 'issue-ticket', args: { scope: ['deployment-manifest'] } });
    const ticket = issued.body.ticket; check('wrong-ticket-issued', typeof ticket === 'string');
    await rpc('participant', { action: 'workspace', operation: 'use-ticket', args: { key: 'deployment-manifest', ticket } });
    check('unauthorized-source-denied', (await rpc('participant', { action: 'alternate', channel: 'A2', credential: 'own' })).status === 403);
    const witness = (await rpc('origin', { action: 'witness' })).body;
    alert = persistSourceAlert({ directory, witness, emit });
    const legitimate = {
      stop: async () => { keepConsumer = false; await consumer; stoppedAt ??= Date.now(); emit('LEGITIMATE_STOPPED', { stoppedAt }); },
      state: async () => ({ running: keepConsumer, stoppedAt }),
      report: async () => ({ samples: [...samples], successful: samples.filter(row => row.status === 200).length, total: samples.length, stoppedAt })
    };
    const executeClose = createSourceCloseLauncher({ directory, alert, gateway,
      source: input => rpc('origin', input), participant: input => rpc('participant', input),
      copyJournal: path => command(['cp', `${containers.gateway}:/state/gateway/m9-journal-export.sqlite`, path]),
      probeTicket: () => rpc('participant', { action: 'workspace', operation: 'use-ticket', args: { key: 'deployment-manifest', ticket } }),
      health, legitimate, sender, handoffStatus: () => ui.status(), events, emit });
    ui = await openHumanSourceHandoff({ directory, alert, accountPath, sender, emit, enteredAt, observationMode, executeClose,
      ticketSummary: () => ({ tracking: true, ticketsIssued: 1, uses: 1, accepted: 1, spread: false }),
      execute: async (_value, beforeExecute) => {
        response = await respondToSourceAlert({ directory, witness, existingAlert: alert, rpc: input => rpc('origin', input), health, emit, beforeExecute });
        if (response.result.readback === 'CONFIRMED') emit('ROTATION_VERIFIED', { incidentId: alert.incidentId });
        return response;
      } });
    save('ready.json', { origin: ui.origin, incidentId: alert.incidentId, sender: sender.delivery, observationMode, paidCalls: 0 });
    // 固定腳本改路後停止，不讓人工等候製造出假的探索時間。
    for (const channel of ['CACHE', 'EXPORT']) check(`alternate-${channel}-denied`,
      (await rpc('participant', { action: 'alternate', channel, credential: 'own' })).status === 403);
    emit('SCRIPTED_SELF_STOP', { reason: 'NO_AUTHORIZED_PATH', resumed: false, modelObservation: false });
    signal?.throwIfAborted();
    await ui.sendEntry();
    const driver = testDriver?.run({ ui, alert });
    driver?.catch(error => { failure = error.code ?? error.message; emit('TEST_DRIVER_FAILURE', { reason: failure }); });
    console.log(JSON.stringify({ phase: 'WAITING_FOR_ACK_DECISION', observationMode, directory, origin: ui.origin, paidCalls: 0 }));
    const deadline = Date.now() + 540000;
    while (!signal?.aborted && !failure && Date.now() < deadline) {
      status = ui.status(); save('status.json', status);
      // 必須等 M3 決策結果落盤；不能只靠宿主執行器返回就提早關頁。
      if (ui.execution() && status.events.some(row => row.kind === 'ADMIN_DECISION_RESULT')) break;
      await delay(1000);
    }
    if (ui.running()) { emit('WAIT_INFLIGHT', { reason: 'NO_RESEND' }); while (ui.running()) await delay(1000); }
    response = ui.execution() ?? response;
    if (!response) emit('UNKNOWN', { reason: signal?.aborted ? 'USER_STOP' : failure ?? 'HUMAN_ACK_OR_DECISION_TIMEOUT', rotateSent: false });
    else {
      check('rotate-effective', response.result?.status === 'EXECUTED' && response.result?.readback === 'CONFIRMED');
      check('old-capability-denied-all-paths', (await rpc('origin', { action: 'probe', credential: 'old' })).every(row => row.status === 403));
      check('new-capability-works-all-paths', (await rpc('origin', { action: 'probe', credential: 'current' })).every(row => row.status === 200));
      console.log(JSON.stringify({ phase: 'WAITING_FOR_CLOSE', observationMode, directory, paidCalls: 0 }));
      const closeDeadline = Date.now() + 420000;
      while (!signal?.aborted && !failure && Date.now() < closeDeadline) {
        status = ui.status(); save('status.json', status);
        if (ui.closeResult() && status.events.filter(row => row.kind === 'ADMIN_DECISION_RESULT').length >= 2) break;
        await delay(1000);
      }
      while (ui.closing()) await delay(1000);
      if (!ui.closeResult()) emit('UNKNOWN', { reason: signal?.aborted ? 'USER_STOP' : 'HUMAN_CLOSE_TIMEOUT', closeSent: false });
      else check('M7-closed', ui.closeResult().status === 'CLOSED', ui.closeResult());
      if (driver) await driver;
      await delay(testDriver ? 1000 : 15000);
    }
    status = ui.status();
    emit('SOURCE_WITNESS', (await rpc('origin', { action: 'witness' })).body);
    writeFileSync(join(directory, 'a2-witness.jsonl'), await command(['logs', containers.a2]), { mode: 0o600 });
  } catch (error) {
    failure = error.code ?? error.message; emit('FAILURE', { reason: failure, rerun: false });
  } finally {
    keepConsumer = false; await consumer;
    if (ui) {
      try { await ui.close(); status = JSON.parse(readFileSync(join(directory, 'handoff-final.json'), 'utf8')); }
      catch { failure = 'HANDOFF_CLOSE_UNKNOWN'; emit('UNKNOWN', { reason: failure }); }
    }
    if (lab) {
      try { const cleanup = await lab.close(); emit('CLEANUP', cleanup);
        if (cleanup.stopped !== true) { failure = 'CLEANUP_UNKNOWN'; emit('UNKNOWN', { reason: failure }); }
      } catch { failure = 'CLEANUP_UNKNOWN'; emit('UNKNOWN', { reason: failure }); }
    }
    const metrics = humanSourceMetrics({ alert, handoff: status, response, events });
    const ack = status?.incidents?.[0]?.acknowledgement ?? null;
    const result = { schemaVersion: 'dungeonq.human-source-drill/v1',
      scope: observationMode === 'HUMAN' ? 'ISOLATED_HUMAN_SCRIPTED_PARTICIPANT' : 'ISOLATED_SCRIPTED_TEST',
      outcome: !failure && ack && response?.result?.readback === 'CONFIRMED' && ui?.closeResult()?.status === 'CLOSED'
        ? observationMode === 'HUMAN' ? 'HUMAN_CLOSED_CONFIRMED' : 'SCRIPTED_CLOSE_CONFIRMED' : 'UNKNOWN',
      observationMode, close: ui?.closeResult() ?? null,
      failure: failure ?? null, checks, acknowledgement: ack, response: response ?? null, metrics,
      legitimateHealth: { successful: samples.filter(row => row.status === 200).length, total: samples.length },
      budget: budget.snapshot(), m9Overall: 'PENDING', paidCalls: 0, newModelObservations: 0, extraTimeFromDungeonQ: 'NOT_PROVEN' };
    save('result.json', result);
    save('timeline.json', { host: events.map(({ seq, at, kind }) => ({ seq, at, iso: new Date(at).toISOString(), kind })),
      handoff: status?.events ?? [], metrics });
    writeFileSync(join(directory, 'process.sha256'), digest(readFileSync(join(directory, 'process.jsonl'))) + '\n', { mode: 0o600 });
    renderHumanSourceReplay(directory);
    console.log(JSON.stringify({ outcome: result.outcome, failure: result.failure, metrics, checks: checks.length, paidCalls: 0 }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.length === 3 && process.argv[2].startsWith('/'), 'ABSOLUTE_NEW_EVIDENCE_DIRECTORY_REQUIRED');
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
  runHumanSourceDrill(resolve(process.argv[2]), { signal: abort.signal }).catch(error => { console.error(error.code ?? error.message); process.exitCode = 1; });
}
