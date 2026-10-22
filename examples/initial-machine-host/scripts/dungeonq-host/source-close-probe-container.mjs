// 只由可信宿主在該場 gateway 容器執行。沒有任意路徑、URL、SQL 或 context 參數。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readJournalReadOnly, recomputeJournalChain } from '/app/runtime/evidence-seal.mjs';
const input = JSON.parse(process.argv[1]);
const config = JSON.parse(readFileSync('/run/dungeonq/gateway.json', 'utf8'));
const dbPath = '/state/gateway/runtime.sqlite';
const exportPath = '/state/gateway/m9-journal-export.sqlite';
const receiptPath = '/state/gateway/m9-fence-receipt.json';
const api = async (path, payload) => {
  const response = await fetch('http://127.0.0.1:4200' + path, { method: payload ? 'POST' : 'GET', redirect: 'error',
    signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${config.credentials.owner}`, 'content-type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined });
  assert.equal(response.status, 200, 'CLOSE_CONTROL_UNKNOWN'); return response.json();
};
const state = async () => {
  const row = (await api('/api/status')).contexts.find(item => item.contextId === 'diverted');
  assert(row, 'CLOSE_CONTEXT_MISSING'); return row;
};
const position = () => {
  const chain = recomputeJournalChain(readJournalReadOnly(dbPath));
  assert.equal(chain.status, 'LINKED', 'CLOSE_CHAIN_BROKEN');
  return { journalSequence: chain.linkedThrough, journalHead: chain.head };
};
const lookup = async () => {
  if (!existsSync(receiptPath)) return null;
  const saved = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(saved.actionId, input.actionId, 'CLOSE_FENCE_ACTION_MISMATCH');
  const current = await state();
  return current.state === 'FENCED' && current.epoch === saved.epoch + 1
    && current.fenceReason === `${saved.proposalId}: ${saved.reason}`
    ? { actionId: saved.actionId, contextId: 'diverted', epoch: current.epoch, state: current.state } : null;
};
let result;
switch (input.action) {
  case 'state': { const row = await state(); result = { contextId: row.contextId, epoch: row.epoch, state: row.state }; break; }
  case 'inventory': result = await api('/api/status'); break;
  case 'evidence': result = await api('/api/evidence'); break;
  case 'position': result = { ...(await state()), ...position() }; break;
  case 'lookup': result = await lookup(); break;
  case 'fence': {
    assert(typeof input.actionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.actionId), 'CLOSE_ACTION_INVALID');
    // 已有嘗試時僅讀回，絕不重送不明的 apply。
    if (existsSync(receiptPath)) { result = await lookup(); assert(result, 'CLOSE_FENCE_UNKNOWN'); break; }
    const current = await state();
    assert(current.state === 'ACTIVE' && current.epoch === input.expectedEpoch, 'CLOSE_STATE_CONFLICT');
    const reason = `M9 source close ${input.actionId}`;
    const preview = await api('/api/policy/preview', { contextId: 'diverted', action: 'FENCE', reason });
    assert(preview.epoch === input.expectedEpoch, 'CLOSE_PREVIEW_CONFLICT');
    writeFileSync(receiptPath + '.tmp', JSON.stringify({ actionId: input.actionId, proposalId: preview.proposalId,
      digest: preview.digest, epoch: preview.epoch, reason }), { flag: 'wx', mode: 0o600, flush: true });
    renameSync(receiptPath + '.tmp', receiptPath);
    await api('/api/policy/apply', { proposalId: preview.proposalId, digest: preview.digest, confirmation: 'APPLY' });
    result = await lookup(); assert(result, 'CLOSE_FENCE_UNKNOWN'); break;
  }
  case 'export': {
    assert.equal((await state()).state, 'FENCED', 'CLOSE_EXPORT_REQUIRES_FENCE');
    assert(!existsSync(exportPath), 'CLOSE_EXPORT_ALREADY_EXISTS');
    const before = position();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { db.exec("VACUUM INTO '/state/gateway/m9-journal-export.sqlite'"); } finally { db.close(); }
    const after = position(); assert.deepEqual(after, before, 'CLOSE_EXPORT_CHANGED');
    const copied = recomputeJournalChain(readJournalReadOnly(exportPath));
    assert(copied.head === before.journalHead && copied.linkedThrough === before.journalSequence, 'CLOSE_EXPORT_MISMATCH');
    result = { ...before, sha256: createHash('sha256').update(readFileSync(exportPath)).digest('hex') }; break;
  }
  default: throw Error('CLOSE_OPERATION_DENIED');
}
process.stdout.write(JSON.stringify(result));
