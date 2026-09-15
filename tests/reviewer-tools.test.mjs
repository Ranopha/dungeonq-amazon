import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { supportedNode, inspectSetup } from '../scripts/lib/doctor.mjs';
import { runProof } from '../scripts/lib/proof-runner.mjs';
import { verifySource } from '../scripts/lib/source-manifest.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
test('安裝診斷拒絕舊 Node，不修改設定且不需要 port', async () => {
  for (const version of ['v24.15.0', '24.16.0', '25.0.0']) assert.equal(supportedNode(version), true);
  for (const version of ['24.14.9', '22.19.0', 'nonsense']) assert.equal(supportedNode(version), false);
  const report = await inspectSetup({ checkPorts: false });
  assert.equal(report.ready, true);
  assert.equal(report.checks.length, 5);
  assert.ok(report.checks.every(check => check.passed));
});

test('完整 reviewer proof 與離線反驗不外傳 fixture 秘密，重播／重啟保持證據', { timeout: 60000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dungeonq-reviewer-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const output = join(temp, 'proof');
  const { report } = await runProof({ output });
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.checks.length, 7);
  assert.equal(report.humanPresenceProven, false);
  assert.equal(report.approvalMode, 'AUTOMATED_HUMAN_ROLE_FIXTURE');
  const files = await readdir(output);
  assert.deepEqual(files.sort(), ['evidence.json', 'report.json', 'tampered-evidence.json', 'trusted-public-key.pem']);
  for (const artifact of report.artifacts) {
    const bytes = await readFile(join(output, artifact.name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    assert.doesNotMatch(bytes.toString(), /"(?:password|privateKey|workerToken|accessToken|factorKey|sessionToken|intentToken|csrfToken)"\s*:/u);
  }
  const verifier = ['scripts/verify-assistant-evidence.mjs', join(output, 'evidence.json'), join(output, 'trusted-public-key.pem'), report.keyId];
  const valid = await exec(process.execPath, verifier, { cwd: root, timeout: 10000 });
  assert.equal(JSON.parse(valid.stdout).receiptValid, true);
  await assert.rejects(exec(process.execPath, [verifier[0], join(output, 'tampered-evidence.json'), ...verifier.slice(2)],
    { cwd: root, timeout: 10000 }), error => error.code === 1 && JSON.parse(error.stdout).receiptValid === false);
  await assert.rejects(exec(process.execPath, [...verifier.slice(0, 3), 'wrong-key-id'], { cwd: root, timeout: 10000 }),
    error => error.code === 1);
  const original = await readFile(join(output, 'report.json'));
  await assert.rejects(runProof({ output }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(join(output, 'report.json')), original);
  const link = join(temp, 'link');
  await symlink(output, link);
  await assert.rejects(runProof({ output: link }), { code: 'EEXIST' });
});

test('reviewer CLI 拒絕現有 lab／未知參數且 doctor 可機讀', async () => {
  await assert.rejects(exec(process.execPath, ['scripts/demo-proof.mjs', '--data-dir', '.'], { cwd: root, timeout: 10000 }),
    error => error.code === 2 && /Use:/u.test(error.stderr));
  const result = await exec(process.execPath, ['scripts/doctor.mjs', '--json', '--skip-ports'], { cwd: root, timeout: 10000 });
  assert.equal(JSON.parse(result.stdout).ready, true);
});

test('proof 啟動失敗會非零退出、保留失敗報告並回收自己新建的 fixture', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dungeonq-proof-failure-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const existing = (await readdir(tmpdir())).filter(name => name.startsWith('dungeonq-proof-lab-')).sort();
  const output = join(temp, 'failed-proof');
  await assert.rejects(exec(process.execPath, ['scripts/demo-proof.mjs', '--out', output],
    { cwd: root, timeout: 10000, env: { ...process.env, PATH: temp } }), error => error.code === 1 && /Result: FAIL/u.test(error.stdout));
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
  assert.equal(report.passed, false);
  assert.equal(report.error, 'PROOF_FAILED');
  assert.equal(report.checks[0].name, 'STARTUP');
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('dungeonq-proof-lab-')).sort(), existing);
  assert.deepEqual(await readdir(output), ['report.json']);
});

test('source manifest 拒絕篡改、遺失、未列檔案、重複與路徑逃逸', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dungeonq-manifest-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = 'synthetic fixture\n';
  const entry = { path: 'sample.txt', bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex') };
  const manifest = entries => JSON.stringify({ schemaVersion: 'dungeonq.source-release/v1', profile: 'SYNTHETIC_ONLY',
    privateHistoryIncluded: false, entries });
  const save = entries => writeFile(join(temp, 'RELEASE_MANIFEST.json'), manifest(entries));
  await writeFile(join(temp, 'sample.txt'), source); await save([entry]);
  assert.equal((await verifySource(temp)).passed, true);
  await writeFile(join(temp, 'sample.txt'), source.replace('synthetic', 'Synthetic'));
  assert.ok((await verifySource(temp)).findings.some(item => item.code === 'HASH_MISMATCH'));
  await writeFile(join(temp, 'sample.txt'), source); await save([entry, entry]);
  assert.ok((await verifySource(temp)).findings.some(item => item.code === 'ENTRY_INVALID'));
  await save([{ ...entry, path: '../outside' }]);
  assert.ok((await verifySource(temp)).findings.some(item => item.code === 'ENTRY_INVALID'));
  await save([{ ...entry, path: 'missing.txt' }]);
  const last = await verifySource(temp);
  assert.ok(last.findings.some(item => item.code === 'MISSING_FILE'));
  assert.ok(last.findings.some(item => item.code === 'UNLISTED_FILE'));
});
