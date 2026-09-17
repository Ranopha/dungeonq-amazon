import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startStudyInstallation } from '../scripts/study.mjs';
import { worldDigest } from '../world/kernel.mjs';

const designPath = fileURLToPath(new URL('../study/designs/archive.json', import.meta.url));
const design = JSON.parse(await readFile(designPath, 'utf8'));
const manifest = { schemaVersion: 'dungeonq.study-installation/v1', designDigest: worldDigest(design), arm: 'CORRELATED', rule: 'structure' };
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'dungeonq-study-installation-test-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
async function rejectInstallation(options, error) {
  await assert.rejects(async () => {
    const unexpected = await startStudyInstallation(options);
    await unexpected.close(); throw new Error('UNEXPECTED_INSTALLATION_SUCCESS');
  }, error);
}
async function json(base, path, token, body) {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); return response.json();
}
async function evidenceWithEvents(lab, count) {
  const deadline = Date.now() + 5000;
  do {
    const evidence = await json(lab.observerUrl, '/api/evidence', lab.observerToken);
    if (evidence.events.length === count) return evidence;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error('STUDY_OBSERVER_WAIT_TIMEOUT');
}

test('新安裝建立0700暫存目錄／0600 manifest，重啟保留指派、nonce、revision並拒絕漂移', async t => {
  const labs = []; let dataDir;
  t.after(async () => { for (const lab of labs) await lab.close(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });
  const first = await startStudyInstallation({ '--arm': 'CORRELATED', '--rule': 'structure' }); labs.push(first); dataDir = first.dataDir;
  assert.equal((await lstat(dataDir)).mode & 0o777, 0o700);
  const manifestPath = join(dataDir, 'study-installation.json');
  assert.equal((await lstat(manifestPath)).mode & 0o777, 0o600);
  const savedManifest = await readFile(manifestPath, 'utf8'); assert.deepEqual(JSON.parse(savedManifest), manifest);
  const initial = await json(first.actorUrl, '/api/study', first.actorToken);
  const command = { requestId: 'installation-consent', expectedRevision: 0,
    command: { type: 'consent', accepted: true, participantMode: 'UI_CHECK' } };
  const accepted = await json(first.actorUrl, '/api/study/command', first.actorToken, command);
  assert.equal(accepted.view.revision, 1); assert.equal(accepted.view.phase, 'PREDICT');
  const before = await evidenceWithEvents(first, 1);
  assert.equal(before.arm, 'CORRELATED'); assert.equal(before.rule, 'structure'); assert.match(before.nonce, /^[a-f0-9]{64}$/);
  await first.close();
  // Omitting arm/rule on restart exercises the persisted installation assignment.
  const restarted = await startStudyInstallation({ '--data-dir': dataDir }); labs.push(restarted);
  const current = await json(restarted.actorUrl, '/api/study', restarted.actorToken);
  assert.equal(current.revision, 1); assert.equal(current.worldId, initial.worldId); assert.equal(current.epoch, initial.epoch);
  assert.equal(current.assignmentCommit, initial.assignmentCommit);
  assert.deepEqual(await evidenceWithEvents(restarted, 1), before);
  assert.deepEqual(await json(restarted.actorUrl, '/api/study/command', restarted.actorToken, command), { ...accepted, replayed: true });
  for (const key of ['actorToken', 'observerToken', 'mcpToken']) assert.notEqual(first[key], restarted[key]);
  await restarted.close();
  await rejectInstallation({ '--data-dir': dataDir, '--arm': 'DISCRIMINATING' }, /STUDY_INSTALLATION_MISMATCH/);
  await rejectInstallation({ '--data-dir': dataDir, '--rule': 'signal' }, /STUDY_INSTALLATION_MISMATCH/);
  const changedDesign = join(dataDir, 'different-design.json');
  await writeFile(changedDesign, JSON.stringify({ ...design, title: '其他合成研究' }), { mode: 0o600 });
  await rejectInstallation({ '--data-dir': dataDir, '--design': changedDesign }, /STUDY_INSTALLATION_MISMATCH/);
  assert.equal(await readFile(manifestPath, 'utf8'), savedManifest);
});

test('非法ports於任何目錄／manifest／DB建立之前拒絕', async t => {
  const base = await directory(t); let index = 0;
  for (const name of ['--actor-port', '--observer-port', '--mcp-port']) {
    for (const value of ['-1', '65536', '1.5', 'abc', '123456', '']) {
      const dataDir = join(base, `rejected-port-${++index}`);
      await rejectInstallation({ '--data-dir': dataDir, [name]: value }, /STUDY_PORT_INVALID/);
      await assert.rejects(lstat(dataDir), { code: 'ENOENT' });
    }
  }
  const existing = join(base, 'existing-private'); await mkdir(existing, { mode: 0o700 });
  await rejectInstallation({ '--data-dir': existing, '--mcp-port': '65536' }, /STUDY_PORT_INVALID/);
  await assert.rejects(lstat(join(existing, 'study-installation.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(existing, 'study.sqlite')), { code: 'ENOENT' });
});

test('不安全資料目錄與設計檔拒絕，沒有初始化研究DB', async t => {
  const base = await directory(t);
  const publicDir = join(base, 'public-directory'); await mkdir(publicDir, { mode: 0o755 }); await chmod(publicDir, 0o755);
  await rejectInstallation({ '--data-dir': publicDir }, /STUDY_DIRECTORY_NOT_PRIVATE/);
  const privateDir = join(base, 'private-directory'); await mkdir(privateDir, { mode: 0o700 });
  const linkedDir = join(base, 'linked-directory'); await symlink(privateDir, linkedDir);
  await rejectInstallation({ '--data-dir': linkedDir }, /STUDY_DIRECTORY_NOT_PRIVATE/);
  const linkedDesign = join(base, 'linked-design.json'); await symlink(designPath, linkedDesign);
  await rejectInstallation({ '--data-dir': privateDir, '--design': linkedDesign }, /STUDY_DESIGN_FILE_INVALID/);
  await rejectInstallation({ '--data-dir': privateDir, '--design': privateDir }, /STUDY_DESIGN_FILE_INVALID/);
  const largeDesign = join(base, 'oversized-design.json'); await writeFile(largeDesign, ' '.repeat(131073), { mode: 0o600 });
  await rejectInstallation({ '--data-dir': privateDir, '--design': largeDesign }, /STUDY_DESIGN_FILE_INVALID/);
  await assert.rejects(lstat(join(privateDir, 'study-installation.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(publicDir, 'study.sqlite')), { code: 'ENOENT' });
});

test('manifest寬鬆權限、符號連結、硬連結、非檔案或超量內容拒絕', async t => {
  const base = await directory(t);
  for (const kind of ['permissions', 'symlink', 'hardlink', 'directory', 'oversized']) await t.test(kind, async () => {
    const dataDir = join(base, kind); await mkdir(dataDir, { mode: 0o700 });
    const path = join(dataDir, 'study-installation.json');
    if (kind === 'directory') await mkdir(path, { mode: 0o700 });
    else if (kind === 'symlink' || kind === 'hardlink') {
      const target = join(dataDir, 'manifest-target.json'); await writeFile(target, JSON.stringify(manifest), { mode: 0o600 });
      if (kind === 'symlink') await symlink(target, path); else await link(target, path);
    } else {
      await writeFile(path, kind === 'oversized' ? ' '.repeat(8193) : JSON.stringify(manifest), { mode: 0o600 });
      if (kind === 'permissions') await chmod(path, 0o644);
    }
    await rejectInstallation({ '--data-dir': dataDir }, /STUDY_INSTALLATION_INVALID/);
    await assert.rejects(lstat(join(dataDir, 'study.sqlite')), { code: 'ENOENT' });
  });
});
