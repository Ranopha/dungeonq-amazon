import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPitchOwnerLock } from '../runtime/pitch-owner-lock.mjs';

const moduleUrl = new URL('../runtime/pitch-owner-lock.mjs', import.meta.url).href;
const error = code => cause => cause.code === code;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dungeonq-owner-lock-')); const path = join(directory, 'owner.sqlite');
  const handles = [];
  t.after(() => { for (const handle of handles) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path, open() { const handle = openPitchOwnerLock({ path }); handles.push(handle); return handle; } };
}
function child(t, path, action = 'hold') {
  const source = `
    import { openPitchOwnerLock } from ${JSON.stringify(moduleUrl)};
    let lock;
    try { lock = openPitchOwnerLock({ path: process.env.PITCH_TEST_PATH });
      process.send({ acquired: true, bootId: lock.bootId });
      if (process.env.PITCH_TEST_ACTION === 'close') { lock.close(); process.disconnect(); }
      else process.on('message', command => { if(command === 'close') { lock.close(); process.disconnect(); } });
    } catch(error) { process.send({ acquired: false, code: error.code }); process.disconnect(); }
  `;
  const processHandle = fork(new URL('../runtime/pitch-owner-lock.mjs', import.meta.url), [], {
    execArgv: ['--input-type=module', '--eval', source],
    env: { ...process.env, PITCH_TEST_PATH: path, PITCH_TEST_ACTION: action },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  let stderr = ''; processHandle.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-1000); });
  const exited = new Promise(resolve => processHandle.once('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    processHandle.once('message', resolve); processHandle.once('error', reject);
    processHandle.once('exit', code => reject(new Error(`Child exited before lock result (${code}): ${stderr}`)));
  });
  t.after(async () => { if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGKILL'); await exited; });
  return { processHandle, ready, exited };
}

test('owner lock refuses independent handles and rejected open cannot release the first lock', t => {
  const f = fixture(t); const first = f.open(); assert.match(first.bootId, /^[a-f0-9-]{36}$/);
  for (let index = 0; index < 3; index++) assert.throws(() => f.open(), error('PITCH_GATEWAY_ALREADY_RUNNING'));
  assert.equal(lstatSync(f.path).mode & 0o077, 0);
  first.close(); first.close(); const next = f.open(); assert.notEqual(next.bootId, first.bootId);
});

test('owner lock admits only one gateway process for a directory', async t => {
  const f = fixture(t); f.open().close();
  const first = child(t, f.path); assert.equal((await first.ready).acquired, true);
  const second = child(t, f.path, 'close');
  assert.deepEqual(await second.ready, { acquired: false, code: 'PITCH_GATEWAY_ALREADY_RUNNING' }); await second.exited;
  assert.throws(() => f.open(), error('PITCH_GATEWAY_ALREADY_RUNNING'));
  first.processHandle.send('close'); await first.exited;
  assert.ok(f.open().bootId);
});

test('owner lock is released by the OS after SIGKILL without deleting any lock file', async t => {
  const f = fixture(t); const owner = child(t, f.path); const first = await owner.ready;
  assert.equal(first.acquired, true); assert.throws(() => f.open(), error('PITCH_GATEWAY_ALREADY_RUNNING'));
  owner.processHandle.kill('SIGKILL'); assert.equal((await owner.exited).signal, 'SIGKILL');
  const recovered = f.open(); assert.notEqual(recovered.bootId, first.bootId);
  const probe = new DatabaseSync(f.path, { readOnly: true });
  try { assert.equal(probe.prepare('SELECT count(*) AS n FROM pitch_owner_lock_meta').get().n, 1); }
  finally { probe.close(); }
});

test('owner lock allows independent private directories', t => {
  const first = fixture(t); const second = fixture(t);
  assert.notEqual(first.open().bootId, second.open().bootId);
});

test('owner lock fails closed on private-path and schema violations', t => {
  const f = fixture(t);
  assert.throws(() => openPitchOwnerLock({ path: 'relative.sqlite' }), error('STORAGE_PATH_INVALID'));
  writeFileSync(f.path, 'not a database', { mode: 0o600 }); assert.throws(() => f.open()); rmSync(f.path);
  const target = join(f.directory, 'target.sqlite'); writeFileSync(target, 'private', { mode: 0o600 }); symlinkSync(target, f.path);
  assert.throws(() => f.open(), error('STORAGE_NOT_PRIVATE')); rmSync(f.path); rmSync(target);
  const lock = f.open(); lock.close(); chmodSync(f.path, 0o644);
  assert.throws(() => f.open(), error('STORAGE_NOT_PRIVATE')); chmodSync(f.path, 0o600);
  const db = new DatabaseSync(f.path); db.prepare('UPDATE pitch_owner_lock_meta SET config=?').run('future-version'); db.close();
  assert.throws(() => f.open(), error('PITCH_OWNER_LOCK_VERSION'));
});

test('owner lock does not reset or overwrite a foreign database', t => {
  const f = fixture(t); const db = new DatabaseSync(f.path); db.exec('CREATE TABLE preserved (value TEXT)');
  db.prepare('INSERT INTO preserved VALUES(?)').run('keep-me'); db.close(); chmodSync(f.path, 0o600);
  assert.throws(() => f.open(), error('AUXILIARY_SCHEMA_CHANGED'));
  const check = new DatabaseSync(f.path, { readOnly: true });
  try { assert.equal(check.prepare('SELECT value FROM preserved').get().value, 'keep-me'); }
  finally { check.close(); }
});
