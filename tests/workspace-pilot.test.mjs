import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyWorkspacePilot } from '../scripts/lib/workspace-pilot-verifier.mjs';
const local = new URL('../docs/evidence/workspace-pilot-v1/', import.meta.url);
let source;
try { await access(local); source = local; } catch { source = new URL('../evidence/workspace-pilot-v1/', import.meta.url); }
test('保存全數 workspace pilot 並重播精確 Actor 觀察，不把完成映射宣稱為認知證明', async () => {
  const result = await verifyWorkspacePilot(source.pathname);
  assert.equal(result.valid, true); assert.equal(result.n, 2);
  assert.equal(result.mechanicalMetricCount, 2); assert.equal(result.semanticReviewRequired, true);
  assert.equal(result.claim, 'RECORDED_DATA_ACCEPTANCE_NOT_PROOF_OF_ORIGIN_BELIEF');
});
test('篡改 pilot 讀回不能被離線驗證接受', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dq-workspace-record-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(source, root, { recursive: true });
  const path = join(root, 'a-transcript.json'); const rows = JSON.parse(await readFile(path, 'utf8'));
  rows.find(row => row.request.name === 'orders_read').observation.quantity = 7;
  await writeFile(path, JSON.stringify(rows));
  await assert.rejects(verifyWorkspacePilot(root));
});
