import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDefenseAcceptance } from '../server/defense-acceptance.mjs';
import { defenseOwnerClient } from '../server/defense-acceptance.mjs';
import { openDefenseLab } from '../server/defense-lab.mjs';
import { startReferenceTransport } from '../server/reference-transport.mjs';

test('真MCP／HTTPS同事故閉環：收件、獨立核准、A輪換、四項讀回、Dungeon續行、重啟', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dungeonq-defense-test-'));
  const { report } = await runDefenseAcceptance({ directory });
  assert.equal(report.passed, true); assert.equal(report.checks.length, 13);
  assert.equal(report.paidProviderApiCalls, 0); assert.equal(report.rotation.approvalPresenceAttested, false);
});

for (const commitBeforeLostReply of [true, false]) test(`TLS broker結果不明只查收據不再輪換；原效果${commitBeforeLostReply ? '已提交' : '未提交'}`, async t => {
  let mutations = 0;
  const directory = await mkdtemp(join(tmpdir(), 'dungeonq-defense-unknown-'));
  const lab = await openDefenseLab({ directory, createTransport: options => startReferenceTransport({ ...options,
    issuer: { ...options.issuer, rotate(permit) { mutations++; if (commitBeforeLostReply) options.issuer.rotate(permit);
      throw Error('Synthetic lost reply'); } } }) });
  t.after(() => lab.close());
  const owner = defenseOwnerClient(lab); assert.equal((await owner.login(lab.password)).status, 200);
  const contact = await fetch(`${lab.world.actorUrl}/api/world`, { headers: { Authorization: `Bearer ${lab.world.actorToken}` } });
  assert.equal(contact.status, 200);
  const row = (await owner.call('/api/defense/status')).json.governance.requests[0];
  const intent = await owner.post('/api/intents', { password: lab.password, purpose: 'APPROVE_ROTATION', manifestDigest: row.manifestDigest });
  assert.equal((await owner.post('/api/defense/approve', { requestId: row.requestId, manifestDigest: row.manifestDigest, intentToken: intent.json.intentToken })).status, 200);
  const result = await owner.post('/api/defense/apply', { requestId: row.requestId });
  assert.equal(result.json.state, commitBeforeLostReply ? 'COMPLETED' : 'UNKNOWN'); assert.equal(mutations, 1);
  if (commitBeforeLostReply) assert.ok(Object.values(result.json.checks).every(value => value === true));
  else {
    assert.equal(result.json.receipt, null); assert.ok(Object.values(result.json.checks).every(value => value === false));
    assert.equal((await owner.post('/api/defense/apply', { requestId: row.requestId })).json.error, 'ROTATION_RECONCILIATION_REQUIRED');
    assert.equal((await owner.post('/api/defense/reconcile', { requestId: row.requestId })).json.state, 'UNKNOWN');
    assert.equal((await owner.call('/api/defense/status')).json.lab.resource.generation, 0); assert.equal(mutations, 1);
  }
});
