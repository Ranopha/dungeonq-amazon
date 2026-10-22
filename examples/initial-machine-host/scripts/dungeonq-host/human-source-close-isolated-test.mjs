// 手動執行的隔離整合驗證。測試帳號、假寄送器、腳本決策；不得算入真人場數。
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAckOperatorRecord, writeAckOperatorFile } from './ack-operator.mjs';
import { otpAt } from '../../vendor/dungeonq-runtime/server/totp.mjs';
import { runHumanSourceDrill } from './human-source-drill.mjs';

const directory = resolve(process.argv[2]);
assert(process.argv[2]?.startsWith('/'), 'NEW_ABSOLUTE_DIRECTORY_REQUIRED');
mkdirSync(directory, { mode: 0o700 });
const password = 'M9 scripted isolated test only';
const account = await createAckOperatorRecord({ password, totp: true });
const accountPath = join(directory, 'test-account.json'); writeAckOperatorFile(accountPath, account.record);
const messages = [];
const sender = { delivery: { configured: true, mode: 'FAKE_TRANSPORT' }, notifier: { channels: [{ name: 'TEST', role: 'PRIMARY',
  send: async message => { messages.push(message); return { state: 'ACCEPTED', receiptId: 'scripted-receipt' }; } }] } };
await runHumanSourceDrill(join(directory, 'run'), { testDriver: { accountPath, sender, run: async ({ ui, alert }) => {
  const post = async (path, input) => {
    const response = await fetch(ui.origin + path, { method: 'POST', headers: { Origin: ui.origin, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
  };
  const link = JSON.stringify(messages).match(/\/ack\/incident-[a-f0-9]{64}\/([A-Za-z0-9_-]{43})/); assert(link);
  const logged = await post('/ack/verify', { incidentId: alert.incidentId, handle: link[1], password, totp: otpAt(account.seed, Math.floor(Date.now() / 30000)) });
  const session = { incidentId: alert.incidentId, summaryToken: logged.summaryToken };
  const decide = async request => {
    const token = await post('/ack/decision/token', session);
    let view = await post('/ack/decision', { ...session, decisionToken: token.decisionToken, request });
    const end = Date.now() + 150000;
    while (!view.result && Date.now() < end) { await delay(1000); view = await post('/ack/decision/status', { ...session, decisionId: view.decisionId }); }
    return view;
  };
  assert.equal((await decide({ kind: 'EXECUTE_A_CLASS', actionCode: 'A-2', targetId: 'source-credential' })).result.outcome, 'EXECUTED');
  await delay(2000);
  const rootCause = Object.fromEntries(['detection', 'wrongTicket', 'notification', 'response', 'documentation'].map(key => [key,
    { finding: '隔離腳本觀察；真人效果尚未驗收。', improvement: '保留完整證據，再由真人完成同一路徑。' }]));
  const closed = await decide({ kind: 'START_CLOSE', close: { verdict: 'DRILL', severity: 'LOW', identityConfirmed: false,
    rootCause, owner: '測試維護者' } });
  assert.equal(closed.result.outcome, 'CLOSED', JSON.stringify(closed));
} } });
const result = JSON.parse(readFileSync(join(directory, 'run/result.json'), 'utf8'));
assert.equal(result.outcome, 'SCRIPTED_CLOSE_CONFIRMED', result.failure);
assert.equal(messages.length, 2, 'entry and M7 notification use fake sender');
assert.equal(result.paidCalls, 0);
console.log(JSON.stringify({ status: 'PASS', observationMode: 'SCRIPTED_TEST', externalSends: 0, modelCalls: 0, checks: result.checks.length }));
