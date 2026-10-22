// DQ-HANDOFF-015 M2：錯誤 ticket 經真實 gateway、HTTP/MCP、重啟與信任入口的端到端行為。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startRuntimeGateway } from '../runtime/server.mjs';
import { startCollector, startFacade, startOrigin } from '../runtime/services.mjs';
import { newToken, request } from '../runtime/transport.mjs';

const op = (requestId, operation = 'snapshot', args = {}) => ({ requestId, operation, args });
const rejected = code => error => error.code === code;
const RECOGNIZABLE = /wrong|decoy|fake|bait|trap|honey|lure|canary|synthetic|dungeon|divert|假|誘餌/iu;

async function fixture(t, { tracking = {}, presentation = 'pitching-v1', limits } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dq-wrong-ticket-'));
  const credentials = Object.fromEntries(['owner', 'actor', 'other', 'ordinary', 'seal', 'producer', 'reader', 'witness'].map(key => [key, newToken()]));
  const origin = await startOrigin({ path: join(directory, 'origin.sqlite'), normalToken: credentials.ordinary, witnessToken: credentials.witness });
  const collector = await startCollector({ path: join(directory, 'collector.sqlite'), producerToken: credentials.producer, readerToken: credentials.reader });
  let gateway;
  const start = async () => {
    gateway = await startRuntimeGateway({ directory, credentials, originOrigin: origin.origin, collectorOrigin: collector.origin,
      network: false, hostBroker: false, presentation, ...(tracking === null ? {} : { wrongTicketTracking: tracking }),
      ...(limits ? { pitchingLimits: limits } : {}), facadeFactory: stateOrigin => startFacade({ stateOrigin }) });
    return gateway;
  };
  await start();
  t.after(async () => { await gateway.close(); await collector.close(); await origin.close(); rmSync(directory, { recursive: true, force: true }); });
  return { credentials, origin, directory, get r() { return gateway; }, async restart() { await gateway.close(); return start(); } };
}
const actor = (f, input, token = f.credentials.actor) => request(f.r.origin, '/api/operate', token, input);
const owner = (f, path, input) => request(f.r.origin, path, f.credentials.owner, input);
async function mcp(f) {
  const client = new Client({ name: 'wrong-ticket-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(f.r.mcpEndpoint), { requestInit: { headers: { Authorization: 'Bearer ' + f.credentials.actor } } }));
  return client;
}
async function allUses(f) {
  const uses = []; let afterSeq = 0;
  for (let page = 0; page < 100; page++) {
    const result = await owner(f, '/api/pitching/ticket-uses', { afterSeq, limit: 500 });
    uses.push(...result.uses); afterSeq = result.nextAfterSeq; if (result.complete) break;
  }
  return uses;
}

test('T-1 錯誤 ticket 在 HTTP 與 MCP 都能用；紀錄一致、重訪不變、重啟後不變', async t => {
  const f = await fixture(t);
  await actor(f, op('read-current', 'read', { key: 'catalog-current' }));
  await actor(f, op('read-prior', 'read', { key: 'catalog-prior' }));
  const issued = await actor(f, op('issue', 'issue-ticket', { scope: ['catalog-current'], maxUses: 4, ttlMs: 600000 }));
  const first = await actor(f, op('use-http', 'use-ticket', { ticket: issued.ticket, key: 'catalog-current' }));
  const client = await mcp(f);
  let second;
  try {
    const called = await client.callTool({ name: 'dungeonq_use_ticket', arguments: { requestId: 'use-mcp', args: { ticket: issued.ticket, key: 'catalog-current' } } });
    assert.equal(called.isError, undefined); second = called.structuredContent;
  } finally { await client.close(); }
  const replay = await actor(f, op('use-http', 'use-ticket', { ticket: issued.ticket, key: 'catalog-current' }));
  await f.restart();
  const third = await actor(f, op('use-after-restart', 'use-ticket', { ticket: issued.ticket, key: 'catalog-current' }));
  const revisit = await actor(f, op('revisit', 'read', { key: 'catalog-current' }));
  for (const result of [second, replay, third, revisit]) {
    assert.deepEqual([result.key, result.value, result.recordRevision], [first.key, first.value, first.recordRevision]);
  }
  assert.deepEqual([first.usesRemaining, second.usesRemaining, replay.usesRemaining, third.usesRemaining], [3, 2, 3, 1]);
  assert.equal(replay.replayed, true);
  const uses = await allUses(f);
  assert.deepEqual(uses.map(row => [row.entry, row.contextId, row.outcome, row.replayed]),
    [['http', 'diverted', 'ACCEPTED', false], ['mcp', 'diverted', 'ACCEPTED', false], ['http', 'diverted', 'ACCEPTED', true], ['http', 'diverted', 'ACCEPTED', false]]);
  assert(uses.every(row => row.spread.length === 0 && row.source === '127.0.0.1'));
  const ledger = (await owner(f, '/api/pitching/status')).ticketLedger;
  assert.equal(ledger.useCount, 4); assert.equal(ledger.tickets.length, 1);
  assert.equal(ledger.tickets[0].contextId, 'diverted'); assert.equal(ledger.tickets[0].entry, 'http');
  assert.equal(ledger.tickets[0].incidentId, (await owner(f, '/api/pitching/status')).incidents[0].incidentId);
  assert.equal(ledger.updates.length, 1); assert.equal(ledger.updates[0].kind, 'FIRST_USE');
  assert.equal(ledger.incidents[0].pendingUses, 3, 'D9: later uses wait for the five-minute digest');
});

test('T-2／T-3 受保護來源、控制介面、其他世界都不接受；每次出現都記錄並標記擴散', async t => {
  const f = await fixture(t);
  const before = await f.r.evidence();
  const issued = await actor(f, op('issue', 'issue-ticket', { scope: ['catalog-current'], maxUses: 2 }));
  const otherBefore = f.r.store.snapshot().worlds.find(world => world.worldId === 'other-world');
  await assert.rejects(actor(f, op('other-world', 'use-ticket', { ticket: issued.ticket, key: 'catalog-current' }), f.credentials.other), rejected('TICKET_INVALID'));
  await assert.rejects(actor(f, op('ordinary-origin', 'use-ticket', { ticket: issued.ticket, key: 'catalog-current' }), f.credentials.ordinary), rejected('ORIGIN_AUTHORITY_DENIED'));
  for (const path of ['/api/pitching/status', '/api/status', '/api/evidence']) {
    await assert.rejects(request(f.r.origin, path, issued.ticket), rejected('UNAUTHORIZED'));
  }
  await assert.rejects(request(f.r.origin, '/api/policy/preview', issued.ticket, { contextId: 'diverted', action: 'FENCE' }), rejected('UNAUTHORIZED'));
  await assert.rejects(actor(f, op('as-bearer'), issued.ticket), rejected('CONTEXT_UNKNOWN'));
  // None of the refused presentations consumed the ticket in its own world.
  const own = await actor(f, op('own-use', 'use-ticket', { ticket: issued.ticket, key: 'catalog-current' }));
  assert.equal(own.usesRemaining, 1);
  const uses = await allUses(f);
  assert.deepEqual(uses.map(row => [row.entry, row.position, row.contextId, row.outcome, row.spread.join('+')]), [
    ['http', 'ARGUMENT', 'other', 'REFUSED', 'CONTEXT'],
    ['http', 'ARGUMENT', 'ordinary', 'REFUSED', 'CONTEXT'],
    ['control', 'CREDENTIAL', null, 'REFUSED', 'CONTEXT'], ['control', 'CREDENTIAL', null, 'REFUSED', 'CONTEXT'],
    ['control', 'CREDENTIAL', null, 'REFUSED', 'CONTEXT'], ['control', 'CREDENTIAL', null, 'REFUSED', 'CONTEXT'],
    ['http', 'CREDENTIAL', null, 'REFUSED', 'CONTEXT'],
    ['http', 'ARGUMENT', 'diverted', 'ACCEPTED', '']]);
  assert.equal(uses[0].code, 'TICKET_INVALID'); assert.equal(uses[1].code, 'ORIGIN_AUTHORITY_DENIED');
  const status = await owner(f, '/api/pitching/status');
  assert.equal(status.ticketLedger.incidents[0].severity, 'CRITICAL'); assert.equal(status.ticketLedger.incidents[0].spreadUses, 7);
  assert.equal(status.ticketLedger.updates[0].severity, 'CRITICAL', 'the first presentation was already a spread');
  assert.deepEqual(status.ticketLedger.tickets[0].spread, ['CONTEXT']);
  // Source witness: no protected operation was accepted and the other world did not change.
  const evidence = await f.r.evidence();
  assert.equal(evidence.scope.witness.accepted, 0); assert.equal(evidence.scope.witness.stateDigest, before.scope.witness.stateDigest);
  for (const id of ['origin-state-unchanged', 'no-diverted-origin-admission']) assert.equal(evidence.checks.find(check => check.id === id).status, 'PASS');
  assert.deepEqual(f.r.store.snapshot().worlds.find(world => world.worldId === 'other-world'), otherBefore);
});

test('T-4 信任入口以 real-entry 延續原 context：同一假世界、留紀錄、來源零讀取', async t => {
  const f = await fixture(t);
  const issued = await actor(f, op('issue', 'issue-ticket', { scope: ['catalog-current'], maxUses: 3, ttlMs: 600000 }));
  const participantUse = await actor(f, op('participant-use', 'use-ticket', { ticket: issued.ticket, key: 'catalog-current' }));
  const witnessBefore = (await f.r.evidence()).scope.witness;
  // A trusted host entrance resolved its public alias to this handle and continues the issuing context.
  const continued = await f.r.dispatch({ token: f.credentials.actor, family: 'http', requestId: 'real-entry-use', operation: 'use-ticket',
    args: { ticket: issued.ticket, key: 'catalog-current' }, entry: { type: 'real-entry', client: 'host-entry/1', source: '198.51.100.7' } });
  assert.deepEqual([continued.key, continued.value, continued.recordRevision, continued.usesRemaining],
    [participantUse.key, participantUse.value, participantUse.recordRevision, 1]);
  assert.equal(Object.hasOwn(continued, '_route'), false);
  const asCredential = await f.r.dispatch({ token: f.credentials.actor, family: 'http', requestId: 'real-entry-read', operation: 'read',
    args: { key: 'catalog-current' }, entry: { type: 'real-entry', source: '198.51.100.7', ticket: issued.ticket, position: 'CREDENTIAL' } });
  assert.deepEqual(asCredential.value, participantUse.value);
  await assert.rejects(f.r.dispatch({ token: f.credentials.actor, family: 'http', requestId: 'bad-entry', operation: 'snapshot', args: {},
    entry: { type: 'admin' } }), rejected('TICKET_ENTRY_INVALID'));
  const uses = await allUses(f);
  assert.deepEqual(uses.slice(1).map(row => [row.entry, row.position, row.contextId, row.source, row.spread.join('+'), row.outcome]), [
    ['real-entry', 'ARGUMENT', 'diverted', '198.51.100.7', 'SOURCE', 'ACCEPTED'],
    ['real-entry', 'CREDENTIAL', 'diverted', '198.51.100.7', 'SOURCE', 'ACCEPTED']]);
  const evidence = await f.r.evidence();
  assert.equal(evidence.scope.witness.accepted, 0); assert.equal(evidence.scope.witness.highWater, witnessBefore.highWater, 'origin saw no admission at all');
  assert(evidence.events.filter(event => ['real-entry-use', 'real-entry-read'].includes(event.requestId)).every(event => event.destination === 'SYNTHETIC'));
});

test('T-5 大量使用時入列不超過上限，紀錄筆數等於實際出示次數', async t => {
  const f = await fixture(t);
  const issued = await actor(f, op('issue', 'issue-ticket', { scope: ['catalog-current'], maxUses: 8, ttlMs: 600000 }));
  const total = 40; let accepted = 0;
  for (let n = 0; n < total; n++) {
    try { await actor(f, op(`flood-${n}`, 'use-ticket', { ticket: issued.ticket, key: 'catalog-current' })); accepted++; }
    catch (error) { assert.equal(error.code, 'TICKET_EXHAUSTED'); }
  }
  assert.equal(accepted, 8);
  const uses = await allUses(f);
  assert.equal(uses.length, total);
  assert.equal(uses.filter(row => row.outcome === 'ACCEPTED').length, 8); assert.equal(uses.filter(row => row.outcome === 'REFUSED').length, 32);
  const ledger = (await owner(f, '/api/pitching/status')).ticketLedger;
  assert.equal(ledger.updates.length, 1, 'one immediate update; the rest wait for the digest window');
  assert.equal(ledger.updates[0].useCount + ledger.incidents[0].pendingUses, total);
  assert.equal(ledger.tickets[0].accepted, 8);
  assert.deepEqual(new Set((await owner(f, '/api/pitching/status')).outbox.map(row => row.idempotencyKey)).size, 1, 'entry alert outbox untouched');
});

test('T-6 對外外觀：只有公開欄位、預設期限與合法 ticket 相同、不含可辨識字樣', async t => {
  const f = await fixture(t);
  const issued = await actor(f, op('issue', 'issue-ticket', { scope: ['catalog-current'] }));
  // Ticket fields plus the ordinary response envelope (`revision`, `replayed`), nothing internal.
  assert.deepEqual(Object.keys(issued).sort(), ['expiresAt', 'issuedAt', 'maxUses', 'replayed', 'revision', 'scope', 'ticket']);
  assert.equal(issued.replayed, false);
  // Same defaults as the host's real ticket issuer (FileOrigin): one use, sixty seconds.
  assert.equal(issued.expiresAt - issued.issuedAt, 60000); assert.equal(issued.maxUses, 1);
  assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
  const bytes = Buffer.from(issued.ticket, 'base64url'); assert.equal(bytes.length, 32);
  assert.throws(() => JSON.parse(bytes.toString('utf8')));
  const { ticket, ...visible } = issued; assert.doesNotMatch(JSON.stringify(visible), RECOGNIZABLE);
  const used = await actor(f, op('use', 'use-ticket', { ticket, key: 'catalog-current' }));
  for (const key of ['ticketId', 'issuer', 'audience', 'schemaVersion', 'contextId', 'worldId', 'epoch', '_route', 'trackId']) {
    assert.equal(Object.hasOwn(used, key), false, key); assert.equal(Object.hasOwn(issued, key), false, key);
  }
});

test('失敗關閉：帳本寫不進時不交付 ticket、不執行使用；其他操作仍可用', async t => {
  const f = await fixture(t, { tracking: { maxUses: 2, maxTrackedTickets: 1 } });
  const issued = await actor(f, op('issue', 'issue-ticket', { scope: ['catalog-current'], maxUses: 4 }));
  await assert.rejects(actor(f, op('issue-2', 'issue-ticket', { scope: ['catalog-current'] })), rejected('SERVICE_UNAVAILABLE'));
  await assert.rejects(actor(f, op('issue-2', 'issue-ticket', { scope: ['catalog-current'] })), rejected('SERVICE_UNAVAILABLE'), 'retry never leaks an untracked handle');
  await actor(f, op('use-1', 'use-ticket', { ticket: issued.ticket, key: 'catalog-current' }));
  await actor(f, op('use-2', 'use-ticket', { ticket: issued.ticket, key: 'catalog-current' }));
  const observed = () => f.r.store.snapshot().observations.filter(row => row.operation === 'use-ticket').length;
  const count = observed();
  await assert.rejects(actor(f, op('use-3', 'use-ticket', { ticket: issued.ticket, key: 'catalog-current' })), rejected('SERVICE_UNAVAILABLE'));
  assert.equal(observed(), count, 'an unrecorded presentation had no canonical effect');
  assert.equal((await actor(f, op('still-usable'))).revision >= 0, true);
  const ledger = (await owner(f, '/api/pitching/status')).ticketLedger;
  assert.equal(ledger.useCount, 2); assert.equal(ledger.refusedAtCapacity, 1); assert.equal((await allUses(f)).length, 2);
});

test('相容性：未啟用時行為與狀態形狀不變；不能套在非配球 profile 或舊資料夾', async t => {
  const f = await fixture(t, { tracking: null });
  const issued = await actor(f, op('issue', 'issue-ticket', { scope: ['catalog-current'] }));
  await actor(f, op('use', 'use-ticket', { ticket: issued.ticket, key: 'catalog-current' }));
  const status = await owner(f, '/api/pitching/status');
  assert.equal(Object.hasOwn(status, 'ticketLedger'), false);
  await assert.rejects(owner(f, '/api/pitching/ticket-uses', {}), rejected('PITCH_TICKET_TRACKING_DISABLED'));
  await f.r.close();
  await assert.rejects(startRuntimeGateway({ directory: f.directory, credentials: f.credentials, presentation: 'pitching-v1', wrongTicketTracking: {},
    network: false, hostBroker: false, originOrigin: f.origin.origin, collectorOrigin: 'http://127.0.0.1:9' }), rejected('AUXILIARY_SCHEMA_CHANGED'));
  await assert.rejects(startRuntimeGateway({ directory: f.directory, credentials: f.credentials, presentation: 'participant-v1', wrongTicketTracking: {} }),
    rejected('PITCH_TICKET_TRACKING_REQUIRES_PITCHING'));
  await f.restart();
});
