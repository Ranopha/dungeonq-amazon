// gateway 的普通流量改以時間窗彙總（ADR-DQ-021）：超過舊上限 2048 筆仍照常服務，證據檢查 ordinary-admission-census
// 同時核對 journal 彙總與 gateway 嘗試。全部使用暫存目錄與人工合成憑證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openRuntimeReference } from '../runtime/reference.mjs';
import { request } from '../runtime/transport.mjs';

const directory = t => { const d = mkdtempSync(join(tmpdir(), 'dq-admission-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
async function start(t, d = directory(t)) { const r = await openRuntimeReference({ directory: d, network: false, hostBroker: false }); t.after(() => r.close()); return r; }
const census = evidence => evidence.checks.find(check => check.id === 'ordinary-admission-census');

test('普通流量超過舊上限 2048 筆仍照常服務；journal 只多幾筆時間窗；重新啟動後證據照樣通過', async t => {
  const d = directory(t); let r = await start(t, d);
  await request(r.origin, '/api/operate', r.credentials.actor, { requestId: 'diverted-1', operation: 'snapshot', args: {} });
  const total = 2100; let next = 0;
  // 4 個並行的合法消費者，每個依序送出；任何一筆失敗都讓測試失敗。
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < total) {
      const index = ++next;
      const result = await request(r.origin, '/api/operate', r.credentials.ordinary, { requestId: `legit-${index}`, operation: 'snapshot', args: {} });
      assert.equal(result._route.destination, 'ORIGIN');
    }
  }));
  const evidence = await r.evidence();
  assert.equal(evidence.status, 'PASS', JSON.stringify(evidence.checks));
  assert.equal(census(evidence).status, 'PASS');
  const events = evidence.canonical.events;
  assert.equal(events.filter(event => event.kind === 'ROUTE').length, 1, '只有被導流的那一筆逐筆寫入');
  assert.ok(events.filter(event => event.kind === 'ADMISSION').length <= 3, '普通流量只寫時間窗');
  assert.equal(evidence.canonical.admissions.total.count, total);
  assert.equal(evidence.canonical.admissions.total.outcomes.SERVED, total);
  await r.close();
  r = await start(t, d);
  const resumed = await r.evidence();
  assert.equal(resumed.status, 'PASS', JSON.stringify(resumed.checks));
  assert.equal(resumed.canonical.admissions.open, null, '正常關閉時封存最後一窗');
  assert.equal(resumed.canonical.admissions.sealed.count, total);
});

test('journal 彙總與 gateway 嘗試不一致時 ordinary-admission-census 判定 FAIL', async t => {
  const r = await start(t);
  await request(r.origin, '/api/operate', r.credentials.actor, { requestId: 'diverted-1', operation: 'snapshot', args: {} });
  for (let index = 1; index <= 3; index++) await request(r.origin, '/api/operate', r.credentials.ordinary, { requestId: `legit-${index}`, operation: 'snapshot', args: {} });
  assert.equal(census(await r.evidence()).status, 'PASS');
  // 不經 gateway 多記一筆普通入場：來源見證與 gateway 嘗試都沒有它。
  r.store.recordAdmission({ contextId: 'ordinary', requestId: 'phantom', family: 'http', outcome: 'SERVED', attemptId: 'phantom-attempt' });
  const evidence = await r.evidence();
  assert.equal(census(evidence).status, 'FAIL'); assert.equal(evidence.status, 'FAIL');
  assert.equal(evidence.checks.find(check => check.id === 'canonical-replay').status, 'PASS', '本機 journal 本身仍完整');
});
