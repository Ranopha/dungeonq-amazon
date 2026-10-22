import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceCloseLauncher } from './source-close.mjs';

test('容器 journal 複本摘要不符時停止封存，不撤權、不寄送、不重送結案', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dq-source-close-negative-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const incidentId = `incident-${'c'.repeat(64)}`, events = [];
  let sends = 0, exports = 0;
  const context = { contextId: 'diverted', state: 'FENCED', epoch: 2 };
  const launcher = createSourceCloseLauncher({ directory, alert: { incidentId, eventId: 'source-1' },
    gateway: async input => {
      if (input.action === 'state') return context;
      if (input.action === 'inventory') return { contexts: [context], policies: [] };
      if (input.action === 'position') return { ...context, journalSequence: 1, journalHead: 'a'.repeat(64) };
      if (input.action === 'evidence') return { canonical: { verifier: { status: 'VERIFIED' }, events: [] } };
      if (input.action === 'export') { exports++; return { sha256: 'b'.repeat(64) }; }
      throw Error('unexpected control operation');
    }, source: async () => ({ status: 200, body: { epoch: 2 } }),
    participant: async () => ({ status: 403, body: { error: { code: 'CONTEXT_FENCED' } } }),
    copyJournal: async path => writeFileSync(path, 'different bytes'),
    health: { measure: async () => { throw Error('already fenced: health action must not run'); } },
    legitimate: { stop: async () => {}, state: async () => ({ running: false }) },
    sender: { notifier: { channels: [{ name: 'TEST', role: 'PRIMARY', send: async () => { sends++; throw Error('must not send'); } }] } },
    handoffStatus: () => ({}), events, emit: (kind, detail) => events.push({ kind, detail }) });
  const value = { incidentId, request: { kind: 'START_CLOSE', close: { verdict: 'DRILL', severity: 'LOW', identityConfirmed: false,
    owner: '測試維護者', rootCause: Object.fromEntries(['detection', 'wrongTicket', 'notification', 'response', 'documentation']
      .map(key => [key, { finding: '測試觀察', improvement: '人工確認' }])) } }, acknowledgement: { at: Date.now() }, submittedAt: Date.now() };
  assert.throws(() => launcher({ ...value, incidentId: 'another-event' }), /CLOSE_SCOPE_DENIED/);
  assert.throws(() => launcher.validate({ ...value, request: { kind: 'START_CLOSE', close: { ...value.request.close, rootCause: {} } } }),
    error => error.code === 'CLOSE_INPUT_INVALID');
  assert.equal(existsSync(join(directory, 'sealer')), false, '輸入尚未通過時不產生封存副作用');
  const result = await launcher(value);
  assert.equal(result.status, 'HALTED'); assert.equal(result.step, 'SEAL_EVIDENCE');
  assert.equal(sends, 0); assert.equal(exports, 1);
  assert.throws(() => launcher(value), /CLOSE_ALREADY_ATTEMPTED/);
});
