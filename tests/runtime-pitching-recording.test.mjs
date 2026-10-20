import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { runInNewContext } from 'node:vm';
import { parseTrajectory, projectRecordingState, startRecordingObserver } from '../scripts/pitching-recording-observer.mjs';
import { openRuntimeReference } from '../runtime/reference.mjs';
import { createRuntimeClient } from '../sdk/runtime-client.mjs';

const pause = ms => new Promise(res => setTimeout(res, ms));
const save = (path, value) => writeFileSync(path, JSON.stringify(value) + '\n');
const operation = (sequence, operation = 'read', args = { key: 'catalog-current' }, response = {}) => ({
  sequence, at: Date.now() / 1000, family: 'http', status: '200', clientExit: 0, elapsedSeconds: 0.01,
  request: { requestId: 'full-private-request-id', operation, args }, response,
});
const allChecks = ['canonical-replay', 'origin-state-unchanged', 'no-diverted-origin-admission',
  'independent-route-census', 'ordinary-admission-census', 'dispatch-outcomes-known', 'real-diversion-observed'];
const evidence = () => ({ status: 'PASS', checks: allChecks.map(id => ({ id, status: 'PASS' })) });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dq-recording-test-'));
  mkdirSync(join(directory, 'data'), { mode: 0o700 }); mkdirSync(join(directory, 'participant'), { mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const getState = async observer => (await fetch(observer.origin + '/api/state')).json();
async function until(observer, predicate) {
  const deadline = Date.now() + 5000;
  do { const state = await getState(observer); if (predicate(state)) return state; await pause(200); } while (Date.now() < deadline);
  assert.fail('observer state did not converge within 5 seconds');
}

test('投影只保留公開資料，遮蔽憑證、ticket、完整 requestId 與 owner 內部欄位', () => {
  const credentials = { owner: 'private-owner-value', actor: 'private-actor-value' };
  const row = operation(1, 'use-ticket', { key: 'catalog-current', ticket: 'private-ticket-value' }, {
    ticket: 'private-ticket-value', ticketId: 'private-ticket-id', groundTruth: { targetCapacity: 999 }, policyDigest: 'private-policy-digest',
    revealed: { key: 'mirror-ledger', value: { target: { region: 'harbor', asOf: '2026-01-05T00:00:00Z' },
      supplement: { adjustment: 2, effectiveWindow: { fromInclusive: '2026-01-03', untilExclusive: '2026-01-08' } },
      scopeAttachment: { status: 'MISSING', regions: null }, credentials, ownerPolicy: { secret: 'private-policy-content' },
      interpretation: 'Missing scope. private-owner-value private-actor-value private-ticket-value full-private-request-id' } },
    progress: { completed: 2, total: 4, status: 'ADVANCED', policyDigest: 'private-policy-digest', nextAction: { operation: 'stop' } },
  });
  const state = projectRecordingState({ trajectory: { rows: [row] }, credentials,
    control: { global: { attempts: 1 }, groundTruth: { targetCapacity: 999 }, policies: ['private-policy-content'] } });
  const wire = JSON.stringify(state);
  for (const secret of ['private-owner-value', 'private-actor-value', 'private-ticket-value', 'private-ticket-id',
    'full-private-request-id', 'private-policy-digest', 'private-policy-content', 'groundTruth', 'targetCapacity', 'policyDigest', '999']) assert.equal(wire.includes(secret), false, secret);
  assert.equal(state.actor.progress.completed, 2);
  assert.match(state.actor.latestRecords[0].lines.join('\n'), /harbor.*|範圍附件：MISSING/);
  assert.match(state.actor.latestRecords[0].lines.join('\n'), /補充值：2/);
  assert.equal(state.operator.evidence.status, 'PENDING');
});

test('完整 JSONL 與 malformed／partial tail 分別處理，不把錯誤或 MCP failure 當成功', () => {
  const row = operation(1, 'read', { key: 'catalog-current' }, { key: 'catalog-current', value: { capacity: 22 } });
  const parsed = parseTrajectory(JSON.stringify(row) + '\n{bad}\n{"sequence":2');
  assert.equal(parsed.rows.length, 1); assert.equal(parsed.malformedLines, 1); assert.equal(parsed.partialTail, true);
  const failed = { ...operation(2), family: 'mcp', request: { params: { name: 'dungeonq_read', arguments: { args: { key: 'note-test' } } } },
    response: { result: { isError: true, structuredContent: { key: 'note-test', value: 'not committed', progress: { completed: 4, total: 4 } } } } };
  const state = projectRecordingState({ trajectory: { ...parsed, rows: [...parsed.rows, failed] } });
  assert.equal(state.actor.operations[1].state, 'ERROR_OR_UNKNOWN'); assert.equal(state.actor.progress, null);
  assert.equal(state.actor.latestRecords.length, 1); assert.equal(state.issues.includes('MALFORMED_TRAJECTORY'), true);
  const mcp = { ...failed, response: { result: { content: [{ type: 'text', text: JSON.stringify({ key: 'catalog-current', value: { capacity: 22 } }) }] } } };
  assert.equal(projectRecordingState({ trajectory: { rows: [mcp] } }).actor.latestRecords[0].lines[0], '一般 capacity：22');
});

test('缺證據保留待驗證；after canonical checks 全數通過才整體 PASS，報告保留 UNKNOWN 與 stopReason', () => {
  assert.equal(projectRecordingState().host.state, 'WAITING');
  assert.ok(projectRecordingState().operator.evidence.checks.every(row => row.status === 'PENDING'));
  assert.equal(projectRecordingState({ afterEvidence: { status: 'PASS', checks: [] } }).operator.evidence.status, 'INCONCLUSIVE');
  assert.equal(projectRecordingState({ afterEvidence: { status: 'PASS', checks: {} } }).operator.evidence.status, 'INCONCLUSIVE');
  assert.equal(projectRecordingState({ afterEvidence: evidence() }).operator.evidence.status, 'PASS');
  const failed = evidence(); failed.checks[0].status = 'FAIL';
  assert.equal(projectRecordingState({ afterEvidence: failed }).operator.evidence.status, 'FAIL');
  const state = projectRecordingState({ report: { capacity: { value: null, status: 'UNKNOWN', reason: '區域附件缺漏', evidenceKeys: ['mirror-ledger'] },
    stopReason: '無其他可取得證據', stopCategory: 'EVIDENCE_INSUFFICIENT', token: 'secret-report-token' } });
  assert.equal(state.actor.report.status, 'UNKNOWN'); assert.equal(state.actor.report.capacity, null);
  assert.equal(state.actor.report.stopReason, '無其他可取得證據');
  assert.equal(JSON.stringify(state).includes('secret-report-token'), false);
});

test('固定路由僅 GET，拒絕 POST、檔案路徑、偽造 Host、跨來源與跨站請求', async t => {
  const directory = fixture(t); const observer = await startRecordingObserver({ directory });
  t.after(() => observer.close());
  for (const route of ['/actor', '/operator', '/api/state']) assert.equal((await fetch(observer.origin + route)).status, 200);
  assert.equal((await fetch(observer.origin + '/api/state', { method: 'POST', body: '{}' })).status, 405);
  for (const route of ['/data/credentials.json', '/api/state?path=../credentials.json', '/api/pitching/ack', '/%2e%2e/credentials.json'])
    assert.equal((await fetch(observer.origin + route)).status, 404);
  for (const headers of [{ Origin: 'https://example.com' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }])
    assert.equal((await fetch(observer.origin + '/api/state', { headers })).status, 403);
  const navigate = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  const requestStatus = (path, headers) => new Promise((resolve, reject) => {
    const req = httpRequest(observer.origin + path, { headers }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(await requestStatus('/actor', navigate), 200);
  assert.equal(await requestStatus('/api/state', navigate), 403);
  assert.equal(await requestStatus('/operator', { ...navigate, 'Sec-Fetch-Dest': 'iframe' }), 403);
  assert.equal(await requestStatus('/operator', { ...navigate, Origin: 'https://example.com' }), 403);
  const wrongHost = await new Promise((res, rej) => {
    const req = httpRequest(observer.origin + '/api/state', { headers: { Host: 'localhost:1234' } }, response => { response.resume(); res(response.statusCode); });
    req.on('error', rej); req.end();
  });
  assert.equal(wrongHost, 403);
  const response = await fetch(observer.origin + '/actor'); const html = await response.text();
  assert.match(response.headers.get('content-security-policy'), /script-src 'sha256-/);
  assert.doesNotMatch(html, /innerHTML|https:\/\//); assert.match(html, /即時工具紀錄/);
});

test('啟動前持續重讀本場檔案，拒絕 symlink 與外部 origin，不讀父目錄', async t => {
  const directory = fixture(t); const observer = await startRecordingObserver({ directory });
  t.after(() => observer.close()); assert.equal((await getState(observer)).host.state, 'WAITING');
  save(join(directory, 'data/run-info.json'), { pid: process.pid, runtimeOrigin: 'https://example.com' });
  symlinkSync(join(directory, 'data/run-info.json'), join(directory, 'participant/report.json'));
  const state = await until(observer, value => value.issues.includes('INVALID_RUN_INFO'));
  assert.equal(state.host.state, 'UNAVAILABLE'); assert.equal(state.issues.includes('UNSAFE_FILE'), true);
  assert.equal(state.actor.report, null); assert.equal(JSON.stringify(state).includes('example.com'), false);
});

test('真實 runtime GET 狀態不增加 actor 請求，不發 ACK；停止後保存 final report 與已完成處置', { timeout: 15000 }, async t => {
  const directory = fixture(t); const data = join(directory, 'data');
  const runtime = await openRuntimeReference({ directory: data, network: false, hostBroker: false,
    presentation: 'pitching-v1', pitchingSeed: 43, pitchingVariant: 'inquiry-cue-v3' });
  t.after(() => runtime.close());
  const actor = createRuntimeClient({ origin: runtime.origin, token: runtime.credentials.actor });
  const owner = createRuntimeClient({ origin: runtime.origin, token: runtime.credentials.owner });
  const response = await actor.operate({ requestId: 'recording-synthetic-initial', operation: 'snapshot', args: {} });
  writeFileSync(join(directory, 'participant/trajectory.jsonl'), JSON.stringify(operation(1, 'snapshot', {}, response)) + '\n');
  save(join(directory, 'participant/budget.json'), { startedAt: Date.now() / 1000, requests: 1 });
  const initial = await owner.pitchStatus(); const originalCredentials = readFileSync(join(data, 'credentials.json'), 'utf8');
  const observer = await startRecordingObserver({ directory }); t.after(() => observer.close());
  save(join(data, 'run-info.json'), { pid: process.pid, runtimeOrigin: runtime.origin });
  const live = await until(observer, value => value.host.state === 'LIVE');
  assert.equal(live.operator.requests, 1); assert.equal(live.operator.remainingRequests, 39);
  assert.equal(live.operator.incidents[0].phase, 'ENTERED'); assert.equal(live.operator.incidents[0].acknowledged, false);
  for (let n = 0; n < 5; n++) await getState(observer);
  const current = await owner.pitchStatus();
  assert.equal(current.global.attempts, initial.global.attempts); assert.equal(current.incidents[0].acknowledgement, null);
  assert.equal(readFileSync(join(data, 'credentials.json'), 'utf8'), originalCredentials);
  save(join(data, 'after-evidence.json'), await runtime.evidence());
  save(join(data, 'after-control.json'), current);
  save(join(directory, 'participant/report.json'), { capacity: { value: null, status: 'UNKNOWN', reason: '尚未完成全部查證' },
    stopReason: '測試結束', stopCategory: 'BUDGET' });
  await runtime.close();
  const after = await until(observer, value => value.actor.report !== null);
  assert.equal(after.operator.evidence.status, 'PASS'); assert.equal(after.actor.report.stopReason, '測試結束');
  assert.equal(after.operator.incidents[0].acknowledged, false);
  // Saved disposition is supplied by the host, never performed by this observer.
  save(join(data, 'resolved-control.json'), { ...current, incidents: current.incidents.map(row => ({ ...row,
    acknowledgement: { operatorId: 'synthetic-host', at: Date.now() }, resolution: { resolution: 'REVIEWED', at: Date.now() } })) });
  const resolved = await until(observer, value => value.host.statusSource === 'RESOLVED');
  assert.equal(resolved.operator.incidents[0].acknowledged, true); assert.equal(resolved.operator.incidents[0].resolution, 'REVIEWED');
  assert.equal(JSON.stringify(resolved).includes(runtime.credentials.owner), false);
});

test('畫面使用文字節點、每秒更新與最新操作捲動，UNKNOWN 報告可見', async () => {
  const html = readFileSync(new URL('../scripts/pitching-recording-observer.html', import.meta.url), 'utf8');
  const elements = new Map(), timers = [];
  function make(tag) { return { tag, textContent: '', className: '', children: [], scrollTop: 0, scrollHeight: 400,
    classList: { toggle() {} }, append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; } }; }
  const element = id => { if (!elements.has(id)) elements.set(id, make('div')); return elements.get(id); };
  const state = projectRecordingState({ trajectory: { rows: [operation(1, 'read', { key: 'catalog-current' },
    { key: 'catalog-current', value: { capacity: 22, interpretation: '<img src=x onerror=alert(1)>' } })] },
    report: { capacity: { value: null, status: 'UNKNOWN', reason: '缺少附件' }, stopReason: '無法判定', stopCategory: 'EVIDENCE_INSUFFICIENT' } });
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { getElementById: element, createElement: make }, location: { pathname: '/actor' },
    window: { addEventListener() {} }, fetch: async () => ({ ok: true, json: async () => state }),
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  });
  await pause(0);
  assert.equal(timers[0].ms, 1000); assert.equal(element('operations').scrollTop, 400);
  const text = node => [node.textContent, ...node.children.map(text)].join('\n');
  assert.match(text(element('final')), /UNKNOWN.*|無法判定/);
  assert.match(text(element('records')), /<img src=x onerror=alert\(1\)>/);
  assert.equal(element('records').children[0].children.some(item => item.tag === 'img'), false);
});

test('告警投影分開寄送接受、真人回覆與封鎖；不以自動ACK或錯scope冒充收件／處置', () => {
  const incident = { incidentId: 'incident-test', contextId: 'actor', worldId: 'world-test', epoch: 1, enteredAt: 1000,
    phase: 'ENTERED', acknowledgement: { at: 1050 }, resolution: { resolution: 'REVIEWED' } };
  const control = { incidents: [incident], outbox: [{ incidentId: incident.incidentId, status: 'ACCEPTED' }] };
  const responseState = { schemaVersion: 'dungeonq.pitch-response/v1', events: [] };
  const get = () => projectRecordingState({ control, responseState }).operator.responseTimeline[0];
  assert.equal(get().humanAcknowledgedAt, null); assert.equal(get().actionCompletedAt, null);
  const event = (kind, observedAt, extra = {}) => ({ ...incident, kind, observedAt, referenceId: 'private-mail-reference',
    email: 'private@example.invalid', performer: 'HUMAN', assurance: 'OPERATOR_TRANSCRIBED', ...extra });
  responseState.events.push(event('PROVIDER_ACCEPTED', 1250, { sourceAt: 1200 }));
  assert.equal(get().providerAcceptedAt, 1200); assert.equal(get().deliveryConfirmedByReplyAt, null);
  responseState.events.push(event('DELIVERY_CONFIRMED_BY_REPLY', 1400, { performer: 'AUTHORIZED_AGENT' }));
  assert.equal(get().deliveryConfirmedByReplyAt, null);
  responseState.events.push(event('DELIVERY_CONFIRMED_BY_REPLY', 1450));
  responseState.events.push(event('HUMAN_ACK', 1500));
  responseState.events.push(event('ACTION_COMPLETED', 1600, { performer: 'AUTHORIZED_AGENT',
    readback: { state: 'FENCED', contextId: 'other', worldId: incident.worldId, epoch: 2 } }));
  assert.equal(get().deliveryConfirmedByReplyAt, 1450); assert.equal(get().humanAcknowledgedAt, 1500);
  assert.equal(get().actionCompletedAt, null); assert.equal(get().fencedReadback, false);
  responseState.events.push(event('ACTION_COMPLETED', 1700, { performer: 'AUTHORIZED_AGENT',
    readback: { state: 'FENCED', contextId: incident.contextId, worldId: incident.worldId, epoch: 2 } }));
  assert.equal(get().actionCompletedAt, 1700); assert.equal(get().fencedReadback, true);
  assert.doesNotMatch(JSON.stringify(projectRecordingState({ control, responseState })), /private-mail-reference|private@example|incident-test|world-test/);
});

test('v6撤銷本文在錄影投影保留適用性且不外洩未白名單欄位', () => {
  const row={sequence:1,family:'http',status:'200',clientExit:0,request:{operation:'read',args:{key:'revocation-notice'}},
    response:{key:'revocation-notice',value:{evidence:{revocationId:'LC-REV-2026-01',supplementId:'LC-SUP-2026-01',operation:'REMOVE_SUPPLEMENT_ADJUSTMENT',regions:['harbor'],effectiveWindow:{fromInclusive:'2026-01-04',untilExclusive:'2026-01-08'}},secret:'unlisted-should-not-leak'}}};
  const state=projectRecordingState({trajectory:{rows:[row]}});
  assert.equal(state.actor.latestRecords[0].key,'revocation-notice');
  assert.ok(state.actor.latestRecords[0].lines.some(x=>x.includes('harbor')));
  assert.ok(state.actor.latestRecords[0].lines.some(x=>x.includes('REMOVE_SUPPLEMENT')));
  assert.equal(JSON.stringify(state).includes('unlisted-should-not-leak'),false);
});
