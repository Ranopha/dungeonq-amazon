import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openStudyStore } from '../server/study-store.mjs';
import { openStudyObserver } from '../server/study-observer.mjs';
import { replayStudy } from '../study/experiment.mjs';
import { worldDigest } from '../world/kernel.mjs';

const design = { schemaVersion: 'dungeonq.study-design/v1', title: '合成研究驗收', seed: 17, trainingRounds: 2, probeBudget: 1,
  labels: { signalOn: '琥珀光', signalOff: '無光', structureOn: '三角紋', structureOff: '圓紋' } };
const assignment = { design, arm: 'CORRELATED', rule: 'structure' };
const consent = { type: 'consent', accepted: true, participantMode: 'SCRIPTED_FIXTURE' };
const predict = choiceId => ({ type: 'predict', choiceId, predictedSuccess: null, hypothesis: 'unknown', confidence: null, suspicion: null });
const envelope = (revision, command) => ({ requestId: `request_${revision}`, expectedRevision: revision, command });
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'dungeonq-study-runtime-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('Study SQLite 重啟保存承諾／指派／事前預測與防重送，身分和條件漂移拒絕', async t => {
  const path = join(await directory(t), 'study.sqlite');
  let store = openStudyStore({ path, ...assignment }); t.after(() => store.close());
  const initial = store.snapshot(); const first = store.command(envelope(0, consent));
  const prediction = envelope(1, predict(first.view.choices[0].id)); store.command(prediction);
  const evidence = store.exportEvidence(); assert.equal(replayStudy(evidence).valid, true);
  store.close(); store = openStudyStore({ path, ...assignment });
  assert.deepEqual(store.exportEvidence(), evidence); assert.equal(store.snapshot().assignmentCommit, initial.assignmentCommit);
  assert.equal(store.snapshot().phase, 'ACT'); assert.deepEqual(store.snapshot().pendingPrediction, prediction.command);
  assert.deepEqual(store.command(envelope(0, consent)), { ...first, replayed: true });
  assert.equal(store.snapshot().revision, 2);
  assert.throws(() => store.command(envelope(0, { type: 'withdraw' })), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => store.command({ ...envelope(0, consent), requestId: 'stale' }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => openStudyStore({ path, ...assignment, arm: 'DISCRIMINATING' }), { code: 'STUDY_ASSIGNMENT_MISMATCH' });
  assert.throws(() => openStudyStore({ path, ...assignment, rule: 'signal' }), { code: 'STUDY_ASSIGNMENT_MISMATCH' });
  assert.throws(() => openStudyStore({ path, ...assignment, nonce: 'b'.repeat(64) }), { code: 'STUDY_ASSIGNMENT_MISMATCH' });
  assert.throws(() => openStudyStore({ path, ...assignment, worldId: 'other-world' }), { code: 'STUDY_IDENTITY_MISMATCH' });
  assert.throws(() => openStudyStore({ path, ...assignment, design: { ...design, title: '其他設計' } }), { code: 'STUDY_DESIGN_MISMATCH' });
});

test('積壓滿時普通互動停止，僅退出有一筆保留容量且不能再繼續', async t => {
  const path = join(await directory(t), 'study.sqlite');
  let store = openStudyStore({ path, ...assignment, maxPending: 2 }); t.after(() => store.close());
  const first = store.command(envelope(0, consent)); store.command(envelope(1, predict(first.view.choices[0].id)));
  assert.equal(store.pending().length, 2);
  assert.throws(() => store.command(envelope(2, { type: 'act' })), { code: 'OBSERVER_BACKLOG_FULL' });
  assert.throws(() => store.command(envelope(2, { type: 'withdraw', thenAct: true })), { code: 'STUDY_FIELDS_INVALID' });
  assert.equal(store.snapshot().revision, 2);
  const withdrawn = store.command(envelope(2, { type: 'withdraw' }));
  assert.equal(withdrawn.view.phase, 'WITHDRAWN'); assert.equal(store.pending().length, 3);
  assert.equal(withdrawn.view.inventory.length, 0); assert.ok(withdrawn.view.debrief);
  assert.equal(worldDigest(withdrawn.view.debrief.assignment), withdrawn.view.assignmentCommit);
  assert.equal(store.command(envelope(2, { type: 'withdraw' })).replayed, true);
  for (const event of store.pending()) store.ack(event.sequence, event.digest);
  assert.throws(() => store.command(envelope(3, { type: 'act' })), { code: 'STUDY_FINISHED' });
  assert.throws(() => store.command(envelope(3, { type: 'withdraw' })), { code: 'STUDY_FINISHED' });
  store.close(); store = openStudyStore({ path, ...assignment, maxPending: 2 });
  assert.equal(store.snapshot().phase, 'WITHDRAWN'); assert.equal(store.exportEvidence().events.length, 3);
});

test('SQLite 故障回滾 state／journal／outbox／dedup，重試只生效一次', async t => {
  const path = join(await directory(t), 'study.sqlite');
  const store = openStudyStore({ path, ...assignment }); t.after(() => store.close());
  const raw = new DatabaseSync(path); t.after(() => raw.close());
  raw.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON study_outbox BEGIN SELECT RAISE(ABORT, 'synthetic storage interruption'); END;");
  assert.throws(() => store.command(envelope(0, consent)));
  assert.equal(store.snapshot().revision, 0); assert.equal(store.pending().length, 0); assert.equal(store.exportEvidence().events.length, 0);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM study_requests').get().n, 0);
  raw.exec('DROP TRIGGER fail_outbox'); store.command(envelope(0, consent));
  assert.equal(store.command(envelope(0, consent)).replayed, true); assert.equal(store.snapshot().revision, 1);
});

test('restore 檢出 state／journal／request／outbox 破壞而保留原庫', async t => {
  const base = await directory(t);
  for (const target of ['state', 'event', 'outbox', 'request']) await t.test(target, () => {
    const path = join(base, `${target}.sqlite`); const store = openStudyStore({ path, ...assignment });
    store.command(envelope(0, consent)); store.close(); const raw = new DatabaseSync(path);
    if (target === 'state') {
      const state = JSON.parse(raw.prepare('SELECT state_json FROM study_meta').get().state_json);
      state.participantMode = 'HUMAN_DECLARED'; raw.prepare('UPDATE study_meta SET state_json=?').run(JSON.stringify(state));
    } else if (target === 'event') {
      const event = JSON.parse(raw.prepare('SELECT event_json FROM study_events').get().event_json);
      event.observation.message = '無法由已承諾條件產生'; raw.prepare('UPDATE study_events SET event_json=?').run(JSON.stringify(event));
    } else if (target === 'outbox') raw.exec('DELETE FROM study_outbox');
    else raw.exec("UPDATE study_requests SET payload_hash='changed'");
    raw.close(); assert.throws(() => openStudyStore({ path, ...assignment }));
    const check = new DatabaseSync(path); assert.equal(check.prepare('SELECT count(*) AS n FROM study_events').get().n, 1); check.close();
  });
});

test('Observer 獨立保存／重播／重送ACK，錯誤因果整批回滾，缺號拒絕', async t => {
  const base = await directory(t); const actor = openStudyStore({ path: join(base, 'study.sqlite'), ...assignment }); t.after(() => actor.close());
  const first = actor.command(envelope(0, consent)); actor.command(envelope(1, predict(first.view.choices[0].id)));
  const bundle = actor.exportEvidence(); const options = { ...bundle, path: join(base, 'observer.sqlite') };
  let observer = openStudyObserver(options); t.after(() => observer.close());
  assert.throws(() => observer.append([bundle.events[1]], 2), { code: 'EVENT_SEQUENCE_INVALID' });
  const changed = structuredClone(bundle.events[1]); changed.observation.message = '錯誤因果';
  assert.throws(() => observer.append([bundle.events[0], changed], 2), { code: 'EVENT_CAUSALITY_INVALID' });
  assert.equal(observer.snapshot().events.length, 0);
  const ack = observer.append([bundle.events[0]], 2); assert.equal(observer.snapshot().lag, 1);
  assert.deepEqual(observer.append([bundle.events[0]], 2), ack); assert.equal(observer.snapshot().events.length, 1);
  observer.append(bundle.events, 2); assert.deepEqual(observer.exportEvidence(), bundle);
  assert.equal(observer.snapshot().summary.efficacyClaim, 'NOT_ESTABLISHED_FOR_HUMANS_OR_LLMS');
  observer.close(); observer = openStudyObserver(options); assert.equal(observer.snapshot().verification.eventCount, 2);
  assert.throws(() => actor.ack(1, '0'.repeat(64)), { code: 'ACK_MISMATCH' }); assert.equal(actor.pending().length, 2);
});

test('雙 store 共用最新 revision，不能以舊狀態跳過預測', async t => {
  const path = join(await directory(t), 'study.sqlite');
  const a = openStudyStore({ path, ...assignment }); const b = openStudyStore({ path, ...assignment }); t.after(() => { a.close(); b.close(); });
  assert.throws(() => a.command(envelope(0, { type: 'act' })), { code: 'STUDY_PHASE_INVALID' });
  const first = a.command(envelope(0, consent));
  assert.throws(() => b.command({ ...envelope(0, consent), requestId: 'other' }), { code: 'REVISION_CONFLICT' });
  b.command(envelope(1, predict(first.view.choices[0].id)));
  assert.equal(replayStudy(a.exportEvidence()).eventCount, 2);
});
