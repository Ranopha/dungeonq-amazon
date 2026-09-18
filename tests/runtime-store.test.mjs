import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openRuntimeStore } from '../runtime/store.mjs';
import { validateRuntimeBlueprint } from '../runtime/contracts.mjs';

const blueprint = () => JSON.parse(readFileSync(new URL('../runtime/blueprints/default.json', import.meta.url), 'utf8'));
const token = letter => letter.repeat(40);
const registration = (contextId = 'context-a', tenantId = 'tenant-a', worldId = 'world-a', disposition = 'DIVERT', credential = token('a')) =>
  ({ contextId, tenantId, worldId, disposition, token: credential });
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dungeonq-runtime-test-'));
  const path = join(directory, 'runtime.sqlite'); let time = 1000000; let store;
  const configuration = { path, clock: () => time, ...options };
  const open = () => { store = openRuntimeStore(configuration); return store; };
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  return { path, directory, configuration, open, setTime: value => { time = value; } };
}
const error = code => cause => cause.code === code;
const execute = (store, requestId, operation, args = {}, contextId = 'context-a', family = 'http') =>
  store.execute({ contextId, family, requestId, operation, args });
const grant = (store, overrides = {}) => store.grantMutation({ policyId: 'policy-a', contextId: 'context-a', expectedRevision: 0,
  allowedTemplates: ['follow-up', 'review-delay'], maxMutations: 2, expiresAt: 1060000,
  authority: { kind: 'OWNER', principalId: 'owner-a' }, ...overrides });
const mutate = (store, observationId, overrides = {}) => store.mutate({ policyId: 'policy-a', contextId: 'context-a', observationId,
  requestId: 'mutation-a', expectedRevision: 0, template: 'follow-up', ...overrides });

test('runtime contexts strictly admit supported families and isolate tenants and origin routing', t => {
  const f = fixture(t); const store = f.open(); store.registerContext(registration());
  store.registerContext(registration('context-b', 'tenant-b', 'world-a', 'DIVERT', token('b')));
  store.registerContext(registration('context-n', 'tenant-a', 'origin-world', 'NORMAL_AUTHORIZED', token('n')));
  for (const family of ['http', 'mcp', 'ssh', 'postgres', 'host']) assert.deepEqual(store.decide({ token: token('a'), family }),
    { contextId: 'context-a', tenantId: 'tenant-a', worldId: 'world-a', epoch: 1, disposition: 'DIVERT' });
  assert.throws(() => store.decide({ token: token('z'), family: 'http' }), error('CONTEXT_UNKNOWN'));
  assert.throws(() => store.decide({ token: token('a'), family: 'ftp' }), error('FAMILY_UNSUPPORTED'));
  assert.throws(() => store.decide({ token: token('a'), family: 'http', tenantId: 'tenant-b' }), error('INVALID_ENVELOPE'));
  assert.throws(() => execute(store, 'normal-write', 'write', { key: 'welcome', value: 'changed', expectedRevision: 0 }, 'context-n'), error('SYNTHETIC_CONTEXT_REQUIRED'));
  assert.equal(store.snapshot().worlds.length, 2);
  execute(store, 'write-a', 'write', { key: 'welcome', value: { status: 'synthetic update' }, expectedRevision: 0 });
  assert.match(execute(store, 'read-b', 'read', { key: 'welcome' }, 'context-b').value, /bounded workspace/u);
  assert.throws(() => store.recordRoute({ contextId: 'context-a', requestId: 'bad-route', family: 'http', destination: 'ORIGIN', outcome: 'SERVED' }), error('ROUTE_CROSSING_DENIED'));
  assert.throws(() => store.recordRoute({ contextId: 'context-n', requestId: 'bad-route', family: 'http', destination: 'SYNTHETIC', outcome: 'SERVED' }), error('ROUTE_CROSSING_DENIED'));
  for (const outcome of ['SERVED', 'FAILED', 'UNKNOWN']) store.recordRoute({ contextId: 'context-n', requestId: `origin-${outcome}`, family: 'http', destination: 'ORIGIN', outcome });
  assert.equal(store.evidence().events.filter(event => event.kind === 'ROUTE').length, 3);
  assert.equal(store.registerContext(registration()).replayed, true);
  assert.throws(() => store.registerContext({ ...registration(), disposition: 'NORMAL_AUTHORIZED' }), error('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.registerContext(registration('duplicate-token')), error('CONTEXT_CONFLICT'));
});

test('runtime CAS and idempotency survive restart and preserve journal prefixes', t => {
  const f = fixture(t); let store = f.open(); store.registerContext(registration());
  const before = store.evidence().events;
  const written = execute(store, 'write-a', 'write', { key: 'record-a', value: { label: 'Synthetic record', amount: 4 }, expectedRevision: 0 });
  assert.equal(written.revision, 1);
  assert.equal(execute(store, 'write-a', 'write', { key: 'record-a', value: { label: 'Synthetic record', amount: 4 }, expectedRevision: 0 }).replayed, true);
  assert.throws(() => execute(store, 'write-a', 'write', { key: 'record-a', value: 'changed replay', expectedRevision: 0 }), error('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => execute(store, 'stale', 'write', { key: 'record-a', value: 'stale', expectedRevision: 0 }), error('REVISION_CONFLICT'));
  assert.deepEqual(store.evidence().events.slice(0, before.length), before);
  const snapshot = store.snapshot(); const evidence = store.evidence(); store.close(); store = f.open();
  assert.deepEqual(store.snapshot(), snapshot); assert.deepEqual(store.evidence(), evidence);
  assert.equal(execute(store, 'read-a', 'read', { key: 'record-a' }).value.amount, 4);
  assert.equal(execute(store, 'write-a', 'write', { key: 'record-a', value: { label: 'Synthetic record', amount: 4 }, expectedRevision: 0 }).replayed, true);
  assert.equal(store.evidence().verifier.status, 'VERIFIED');
  assert.equal(store.evidence().verifier.independentWitness, false);
  assert.ok(!JSON.stringify(store.snapshot()).includes(token('a')));
  assert.ok(!JSON.stringify(store.evidence()).includes(token('a')));
});

test('runtime concurrent store handles enforce one revision and restore consistent state', t => {
  const f = fixture(t); const first = f.open(); first.registerContext(registration());
  const second = openRuntimeStore(f.configuration); t.after(() => second.close());
  execute(first, 'first', 'write', { key: 'welcome', value: 'First update', expectedRevision: 0 });
  assert.throws(() => execute(second, 'second', 'write', { key: 'welcome', value: 'Second update', expectedRevision: 0 }), error('REVISION_CONFLICT'));
  assert.equal(execute(second, 'read-second', 'read', { key: 'welcome' }).value, 'First update');
});

test('Wrong Ticket is an authenticated bounded synthetic read capability across families', t => {
  const f = fixture(t); const store = f.open(); store.registerContext(registration());
  const issued = execute(store, 'issue-a', 'issue-ticket', { scope: ['welcome'], maxUses: 2 });
  assert.equal(issued.issuer, 'dungeonq-runtime-v1'); assert.equal(issued.audience, 'dungeonq-synthetic-read-v1');
  assert.equal(issued.tenantId, 'tenant-a'); assert.equal(issued.epoch, 1);
  const args = { ticket: issued.ticket };
  const first = execute(store, 'use-a', 'use-ticket', args, 'context-a', 'mcp'); assert.equal(first.usesRemaining, 1);
  assert.equal(execute(store, 'use-a', 'use-ticket', args, 'context-a', 'mcp').replayed, true);
  assert.equal(execute(store, 'use-b', 'use-ticket', args, 'context-a', 'postgres').usesRemaining, 0);
  assert.throws(() => execute(store, 'use-c', 'use-ticket', args), error('TICKET_EXHAUSTED'));
  assert.throws(() => execute(store, 'use-write', 'use-ticket', { ...args, value: 'model request' }), error('INVALID_ENVELOPE'));
  assert.throws(() => execute(store, 'public-digest', 'use-ticket', { ticket: store.evidence().verifier.head }), error('TICKET_INVALID'));
  assert.ok(!JSON.stringify(store.evidence()).includes(issued.ticket));
});

test('Wrong Ticket rejects authenticated wrong issuer audience tenant world context epoch and scope', t => {
  const signingKey = randomBytes(32); const f = fixture(t, { signingKey }); const store = f.open(); store.registerContext(registration());
  store.registerContext(registration('context-b', 'tenant-a', 'world-a', 'DIVERT', token('b')));
  store.registerContext(registration('context-c', 'tenant-b', 'world-a', 'DIVERT', token('c')));
  store.registerContext(registration('context-d', 'tenant-a', 'world-b', 'DIVERT', token('d')));
  const issued = execute(store, 'issue-a', 'issue-ticket');
  const body = JSON.parse(Buffer.from(issued.ticket.split('.')[0], 'base64url').toString('utf8'));
  for (const [field, value] of Object.entries({ issuer: 'another-issuer', audience: 'another-audience', tenantId: 'tenant-b', worldId: 'world-b', contextId: 'context-b', epoch: 2 })) {
    const payload = Buffer.from(JSON.stringify({ ...body, [field]: value })).toString('base64url');
    const signature = createHmac('sha256', signingKey).update('ticket-v1\0').update(payload).digest('base64url');
    assert.throws(() => execute(store, `wrong-${field}`, 'use-ticket', { ticket: `${payload}.${signature}` }), error('TICKET_SCOPE_INVALID'));
  }
  for (const contextId of ['context-b', 'context-c', 'context-d']) assert.throws(() => execute(store, `wrong-${contextId}`, 'use-ticket', { ticket: issued.ticket }, contextId), error('TICKET_SCOPE_INVALID'));
  assert.throws(() => execute(store, 'wrong-key', 'use-ticket', { ticket: issued.ticket, key: 'order-41' }), error('TICKET_SCOPE_INVALID'));
  const modified = `${issued.ticket.slice(0, -1)}${issued.ticket.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => execute(store, 'wrong-signature', 'use-ticket', { ticket: modified }), error('TICKET_INVALID'));
});

test('Wrong Ticket expiry and use counts persist through restart; changed replay is denied', t => {
  const f = fixture(t); let store = f.open(); store.registerContext(registration());
  const issued = execute(store, 'issue-a', 'issue-ticket', { ttlMs: 10 }); store.close(); store = f.open();
  const used = execute(store, 'use-a', 'use-ticket', { ticket: issued.ticket }); assert.equal(used.usesRemaining, 0);
  assert.throws(() => execute(store, 'use-a', 'use-ticket', { ticket: issued.ticket, key: 'order-41' }), error('IDEMPOTENCY_CONFLICT'));
  store.close(); store = f.open();
  assert.equal(execute(store, 'use-a', 'use-ticket', { ticket: issued.ticket }).replayed, true);
  assert.throws(() => execute(store, 'use-new', 'use-ticket', { ticket: issued.ticket }), error('TICKET_EXHAUSTED'));
  f.setTime(1000010);
  assert.throws(() => execute(store, 'expired', 'use-ticket', { ticket: issued.ticket }), error('TICKET_EXPIRED'));
  assert.throws(() => execute(store, 'use-a', 'use-ticket', { ticket: issued.ticket }), error('TICKET_EXPIRED'));
  assert.throws(() => execute(store, 'issue-a', 'issue-ticket', { ttlMs: 10 }), error('TICKET_EXPIRED'));
});

test('fencing persists epoch revocation and cannot be undone through registration or cached success', t => {
  const f = fixture(t); let store = f.open(); store.registerContext(registration());
  const issued = execute(store, 'issue-a', 'issue-ticket'); grant(store);
  const fenced = store.fence({ contextId: 'context-a', reason: 'Owner suspended this context.' });
  assert.equal(fenced.epoch, 2); assert.equal(fenced.state, 'FENCED');
  assert.throws(() => store.decide({ token: token('a'), family: 'http' }), error('CONTEXT_FENCED'));
  assert.throws(() => execute(store, 'use-after-fence', 'use-ticket', { ticket: issued.ticket }), error('CONTEXT_FENCED'));
  assert.throws(() => execute(store, 'issue-a', 'issue-ticket'), error('CONTEXT_FENCED'));
  assert.throws(() => grant(store), error('CONTEXT_FENCED'));
  assert.throws(() => store.registerContext(registration()), error('CONTEXT_FENCED'));
  assert.equal(store.snapshot().contexts[0].state, 'FENCED');
  assert.throws(() => store.registerContext({ ...registration(), token: token('z') }), error('IDEMPOTENCY_CONFLICT'));
  store.close(); store = f.open(); assert.equal(store.snapshot().contexts[0].epoch, 2);
  assert.throws(() => execute(store, 'after-restart', 'snapshot'), error('CONTEXT_FENCED'));
});

test('bounded owner mutation requires recorded observations and preserves immutable history and replay', t => {
  const f = fixture(t); let store = f.open(); store.registerContext(registration());
  const observed = execute(store, 'observe-a', 'read', { key: 'welcome' });
  assert.throws(() => mutate(store, observed.observationId), error('MUTATION_POLICY_REQUIRED'));
  assert.throws(() => grant(store, { authority: { principalId: 'model-a', kind: 'MODEL' } }), error('OWNER_AUTHORITY_REQUIRED'));
  assert.throws(() => grant(store, { allowedTemplates: ['execute-code'] }), error('MUTATION_TEMPLATE_INVALID'));
  grant(store); const before = store.evidence().events; const originalRecord = execute(store, 'read-before', 'read', { key: 'welcome' });
  const changed = mutate(store, observed.observationId); assert.equal(changed.revision, 1); assert.equal(changed.remaining, 1);
  assert.deepEqual(store.evidence().events.slice(0, before.length), before);
  assert.equal(execute(store, 'read-after', 'read', { key: 'welcome' }).value, originalRecord.value);
  assert.equal(execute(store, 'read-new', 'read', { key: changed.key }).value, changed.value);
  assert.equal(mutate(store, observed.observationId).replayed, true);
  assert.throws(() => mutate(store, observed.observationId, { template: 'review-delay' }), error('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => mutate(store, observed.observationId, { requestId: 'consume-again', expectedRevision: 1 }), error('OBSERVATION_CONSUMED'));
  assert.throws(() => mutate(store, originalRecord.observationId, { requestId: 'stale-observation', expectedRevision: 1 }), error('OBSERVATION_STALE'));
  const fresh = execute(store, 'observe-b', 'snapshot');
  mutate(store, fresh.observationId, { requestId: 'mutation-b', expectedRevision: 1, template: 'review-delay' });
  const exhausted = execute(store, 'observe-c', 'snapshot');
  assert.throws(() => mutate(store, exhausted.observationId, { requestId: 'mutation-c', expectedRevision: 2 }), error('MUTATION_BUDGET_EXHAUSTED'));
  const snapshot = store.snapshot(); store.close(); store = f.open(); assert.deepEqual(store.snapshot(), snapshot);
  assert.equal(store.snapshot().policies[0].uses, 2); assert.equal(mutate(store, fresh.observationId, { requestId: 'mutation-b', expectedRevision: 1, template: 'review-delay' }).replayed, true);
});

test('mutation expiry scope CAS template bounds and participant authority fields fail closed', t => {
  const f = fixture(t); const store = f.open(); store.registerContext(registration());
  store.registerContext(registration('context-b', 'tenant-b', 'world-b', 'DIVERT', token('b')));
  const observed = execute(store, 'observe-a', 'snapshot'); grant(store, { allowedTemplates: ['follow-up'] });
  assert.throws(() => mutate(store, observed.observationId, { expectedRevision: 7 }), error('REVISION_CONFLICT'));
  assert.throws(() => mutate(store, observed.observationId, { template: 'review-delay' }), error('MUTATION_TEMPLATE_DENIED'));
  assert.throws(() => mutate(store, observed.observationId, { contextId: 'context-b' }), error('MUTATION_POLICY_REQUIRED'));
  assert.throws(() => mutate(store, 'missing-observation'), error('OBSERVATION_INVALID'));
  assert.throws(() => mutate(store, observed.observationId, { authority: { kind: 'OWNER', principalId: 'model-a' } }), error('INVALID_ENVELOPE'));
  assert.throws(() => execute(store, 'model-grant', 'grant-mutation', { authority: { kind: 'OWNER', principalId: 'model-a' } }), error('OPERATION_UNSUPPORTED'));
  f.setTime(1060000); assert.throws(() => mutate(store, observed.observationId), error('MUTATION_POLICY_EXPIRED'));
  assert.equal(store.snapshot().worlds[0].revision, 0);
});

test('declarative blueprints are pinned passive schemas with bounded records and journals', t => {
  const custom = blueprint(); custom.id = 'custom-synthetic-v1'; custom.records[0].value = 'A custom synthetic welcome.';
  custom.bounds.maxRecords = 3; custom.bounds.maxEvents = 4;
  const f = fixture(t, { blueprint: custom }); let store = f.open(); store.registerContext(registration());
  assert.equal(execute(store, 'custom-read', 'read', { key: 'welcome' }).value, custom.records[0].value);
  assert.throws(() => execute(store, 'overflow', 'write', { key: 'new-record', value: 'Synthetic', expectedRevision: 0 }), error('RECORD_LIMIT'));
  assert.throws(() => execute(store, 'active-content', 'write', { key: 'welcome', value: '<script>active</script>', expectedRevision: 0 }), error('VALUE_NOT_PASSIVE'));
  execute(store, 'write-a', 'write', { key: 'welcome', value: 'Synthetic changed', expectedRevision: 0 });
  execute(store, 'last-read', 'snapshot'); assert.throws(() => execute(store, 'journal-overflow', 'snapshot'), error('JOURNAL_LIMIT'));
  assert.equal(execute(store, 'last-read', 'snapshot').replayed, true);
  store.close(); store = f.open(); assert.equal(store.snapshot().worlds[0].revision, 1); store.close();
  const changed = structuredClone(custom); changed.title = 'Changed blueprint';
  assert.throws(() => openRuntimeStore({ ...f.configuration, blueprint: changed }), error('BLUEPRINT_MISMATCH'));
  assert.throws(() => validateRuntimeBlueprint({ ...custom, execute: 'code' }), error('INVALID_ENVELOPE'));
  const bad = structuredClone(custom); bad.templates[0].script = 'code'; assert.throws(() => validateRuntimeBlueprint(bad), error('INVALID_ENVELOPE'));
});

test('unknown incomplete and altered storage is rejected without initializing over existing data', t => {
  for (const kind of ['empty', 'foreign', 'state', 'journal']) {
    const f = fixture(t); let before;
    if (kind === 'empty') writeFileSync(f.path, '', { mode: 0o600 });
    else if (kind === 'foreign') {
      const db = new DatabaseSync(f.path); db.exec('CREATE TABLE unrelated (value TEXT)'); db.close(); chmodSync(f.path, 0o600);
    } else {
      const store = f.open(); store.registerContext(registration()); store.close(); const db = new DatabaseSync(f.path);
      if (kind === 'state') db.prepare('UPDATE runtime_meta SET state_json=?').run('{}');
      else {
        const event = JSON.parse(db.prepare('SELECT event_json FROM runtime_events WHERE sequence=1').get().event_json);
        event.command.input.disposition = 'NORMAL_AUTHORIZED'; db.prepare('UPDATE runtime_events SET event_json=? WHERE sequence=1').run(JSON.stringify(event));
      }
      db.close();
    }
    before = readFileSync(f.path);
    assert.throws(() => f.open(), error({ empty: 'STORAGE_INCOMPLETE', foreign: 'STORAGE_SCHEMA_INVALID', state: 'STATE_CORRUPT', journal: 'JOURNAL_CORRUPT' }[kind]));
    assert.deepEqual(readFileSync(f.path), before);
    if (kind === 'empty' || kind === 'foreign') assert.equal(existsSync(`${f.path}.ticket-key`), false);
  }
});

test('signing keys are independently persisted private and pinned across restart', t => {
  const f = fixture(t); let store = f.open(); store.registerContext(registration());
  const ticket = execute(store, 'issue-a', 'issue-ticket').ticket; const original = readFileSync(`${f.path}.ticket-key`);
  assert.equal(original.length, 32); store.close(); store = f.open();
  assert.equal(execute(store, 'issue-a', 'issue-ticket').ticket, ticket); store.close();
  writeFileSync(`${f.path}.ticket-key`, randomBytes(32)); assert.throws(() => f.open(), error('SIGNING_KEY_MISMATCH'));
  writeFileSync(`${f.path}.ticket-key`, original); chmodSync(`${f.path}.ticket-key`, 0o644);
  assert.throws(() => f.open(), error('STORAGE_NOT_PRIVATE')); chmodSync(`${f.path}.ticket-key`, 0o600);
  rmSync(`${f.path}.ticket-key`); assert.throws(() => f.open(), error('SIGNING_KEY_MISSING'));
});

test('injected signing keys are copied and pinned; malformed inputs and backwards time are denied', t => {
  const signingKey = randomBytes(32); const f = fixture(t, { signingKey }); const store = f.open();
  const original = Buffer.from(signingKey); store.registerContext(registration());
  assert.throws(() => execute(store, 'unknown-field', 'snapshot', { ignored: true }), error('INVALID_ENVELOPE'));
  assert.throws(() => execute(store, 'unknown-operation', 'shell', { command: 'anything' }), error('OPERATION_UNSUPPORTED'));
  const accessor = {}; Object.defineProperty(accessor, 'key', { enumerable: true, get() { throw new Error('must not run'); } });
  assert.throws(() => execute(store, 'accessor', 'read', accessor), error('VALUE_INVALID'));
  const cyclic = {}; cyclic.self = cyclic; assert.throws(() => execute(store, 'cyclic', 'write', { key: 'welcome', value: cyclic, expectedRevision: 0 }), error('VALUE_INVALID'));
  let deep = 'value'; for (let depth = 0; depth < 9; depth++) deep = { nested: deep };
  assert.throws(() => execute(store, 'deep-value', 'write', { key: 'welcome', value: deep, expectedRevision: 0 }), error('VALUE_TOO_DEEP'));
  f.setTime(999999); assert.throws(() => execute(store, 'clock-back', 'snapshot'), error('CLOCK_REGRESSION'));
  store.close(); assert.deepEqual(signingKey, original);
  assert.throws(() => openRuntimeStore({ ...f.configuration, signingKey: randomBytes(32) }), error('SIGNING_KEY_MISMATCH'));
  assert.throws(() => store.snapshot(), error('STORE_CLOSED'));
});

test('large bounded world snapshots remain replayable after restart', t => {
  const pack = blueprint(); pack.records = Array.from({ length: 32 }, (_, index) => ({ key: index === 0 ? 'welcome' : `record-${index}`, value: 'Synthetic '.repeat(100) }));
  const f = fixture(t, { blueprint: pack }); let store = f.open(); store.registerContext(registration());
  const snapshot = execute(store, 'snapshot-large', 'snapshot'); assert.equal(snapshot.records.length, 32);
  store.close(); store = f.open(); assert.deepEqual(execute(store, 'snapshot-large', 'snapshot'), { ...snapshot, replayed: true });
});

test('aggregate journal byte bounds reject new work without discarding prior history', t => {
  const pack = blueprint(); pack.bounds.maxJournalBytes = 4096;
  const f = fixture(t, { blueprint: pack }); const store = f.open(); store.registerContext(registration());
  let rejected = false; let successfulRequest;
  for (let index = 0; index < 10; index++) {
    const requestId = `snapshot-${index}`; const before = store.evidence();
    try { execute(store, requestId, 'snapshot'); successfulRequest = requestId; }
    catch (cause) {
      assert.equal(cause.code, 'JOURNAL_BYTE_LIMIT'); assert.deepEqual(store.evidence(), before); rejected = true; break;
    }
  }
  assert.equal(rejected, true); assert.equal(execute(store, successfulRequest, 'snapshot').replayed, true);
  assert.equal(store.fence({ contextId: 'context-a', reason: 'Fence despite the full workload journal.' }).state, 'FENCED');
  assert.throws(() => execute(store, successfulRequest, 'snapshot'), error('CONTEXT_FENCED'));
});

test('dedicated fence capacity remains available after event limits and across restart', t => {
  const pack = blueprint(); pack.bounds.maxEvents = 1; pack.bounds.maxRequests = 1;
  const f = fixture(t, { blueprint: pack }); let store = f.open(); store.registerContext(registration());
  assert.throws(() => execute(store, 'no-capacity', 'snapshot'), error('JOURNAL_LIMIT'));
  store.fence({ contextId: 'context-a', reason: 'Owner revocation retains dedicated capacity.' }); store.close(); store = f.open();
  assert.equal(store.snapshot().contexts[0].state, 'FENCED'); assert.equal(store.evidence().events.length, 2);
  assert.equal(store.fence({ contextId: 'context-a', reason: 'Owner revocation retains dedicated capacity.' }).replayed, true);
});
