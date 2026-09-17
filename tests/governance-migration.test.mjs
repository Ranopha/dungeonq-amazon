import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { canonicalJson, digest, token, tokenHash } from '../server/contracts.mjs';

async function legacy(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dungeonq-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'v1.sqlite'); const db = new DatabaseSync(path);
  db.exec(await readFile(new URL('./fixtures/governance-v1.sql', import.meta.url), 'utf8'));
  db.exec("INSERT INTO tenants VALUES ('tenant-a',9); INSERT INTO users VALUES ('user-a','tenant-a','owner-a','synthetic-record-not-a-password',3)");
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(tokenHash(token()), 'user-a', 1, 1000, 1000, 9000);
  db.prepare('INSERT INTO recovery VALUES (?,?)').run(tokenHash(token()), 'user-a');
  db.exec("UPDATE meta SET value=7000 WHERE key='clock'; INSERT INTO configuration VALUES ('signer','synthetic-pinned-identity')");
  const event = { sequence: 1, previousDigest: null, tenant: 'tenant-a', kind: 'GRANTS_REVOKED', epoch: 9 };
  db.prepare('INSERT INTO audit VALUES (?,?,?)').run(1, canonicalJson(event), digest(event));
  db.close(); await chmod(path, 0o600);
  return { directory, path };
}

test('真實 v1 Schema 副本遷移 v7：保留資料、舊撤銷 epoch／clock／signer／證據，重開不重設', async t => {
  const f = await legacy(t);
  const copy = join(f.directory, 'verified-copy.sqlite'); await copyFile(f.path, copy); await chmod(copy, 0o600);
  assert.deepEqual(await readFile(copy), await readFile(f.path));
  const before = new DatabaseSync(f.path, { readOnly: true });
  const tables = ['meta', 'configuration', 'tenants', 'sessions', 'recovery', 'audit'];
  const rows = Object.fromEntries(tables.map(table => [table, before.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }))])); before.close();
  let db = new Store(copy, () => 7000);
  assert.equal(db.get('PRAGMA user_version').user_version, 7);
  assert.equal(db.get('SELECT setup_expires FROM users').setup_expires, null);
  assert.equal(db.get('SELECT role FROM users').role, 'TENANT_SUPER_ADMIN');
  assert.equal(db.get('SELECT disabled FROM users').disabled, 0);
  assert.equal(db.get('SELECT epoch FROM users').epoch, 3);
  for (const table of tables) assert.deepEqual(db.all(`SELECT * FROM ${table}`), rows[table]);
  assert.equal(db.verifyAudit().entries, 1);
  assert.throws(() => db.transaction(() => Promise.resolve()), error => error.code === 'ASYNC_TRANSACTION_FORBIDDEN');
  db.close(); db = new Store(copy, () => 7000);
  assert.equal(db.get('SELECT epoch FROM tenants').epoch, 9);
  assert.equal(db.get('SELECT epoch FROM sessions').epoch, 1); // 仍低於 user epoch，未把舊登入復活。
  db.close();
  const untouched = new DatabaseSync(f.path, { readOnly: true });
  assert.equal(untouched.prepare('PRAGMA user_version').get().user_version, 1); untouched.close();
});

test('v1→v2 第二步失敗會回復第一步，不留下半套角色或提高版本', async t => {
  const f = await legacy(t); const db = new DatabaseSync(f.path);
  db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0'); db.close();
  assert.throws(() => new Store(f.path), /duplicate column name/u);
  const check = new DatabaseSync(f.path, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 1);
  assert.ok(!check.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'role'));
  assert.equal(check.prepare('SELECT epoch FROM tenants').get().epoch, 9); check.close();
});

test('v2→v3 保留成員角色／停用／epoch，既有帳號不被改成待設定', async t => {
  const f = await legacy(t); const old = new DatabaseSync(f.path);
  old.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'TENANT_SUPER_ADMIN' CHECK(role IN ('TENANT_SUPER_ADMIN','MIS_OPERATOR','REVIEWER','AUDITOR')); ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)); PRAGMA user_version=2;");
  old.exec("UPDATE users SET role='AUDITOR',disabled=1"); old.close();
  const copy = join(f.directory, 'v2-copy.sqlite'); await copyFile(f.path, copy); await chmod(copy, 0o600);
  assert.deepEqual(await readFile(copy), await readFile(f.path));
  const db = new Store(copy, () => 7000);
  assert.equal(db.get('PRAGMA user_version').user_version, 7);
  assert.deepEqual(db.get('SELECT role,disabled,epoch,setup_expires FROM users'), { role: 'AUDITOR', disabled: 1, epoch: 3, setup_expires: null });
  assert.equal(db.get('SELECT epoch FROM tenants').epoch, 9); assert.equal(db.verifyAudit().entries, 1); db.close();
});

test('v3 欄位衝突時保留 v2 版本及資料，不自動略過未知結構', async t => {
  const f = await legacy(t); const old = new DatabaseSync(f.path);
  old.exec('ALTER TABLE users ADD COLUMN setup_expires INTEGER; PRAGMA user_version=2;'); old.close();
  assert.throws(() => new Store(f.path), /duplicate column name/u);
  const read = new DatabaseSync(f.path, { readOnly: true });
  assert.equal(read.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(read.prepare('SELECT epoch FROM tenants').get().epoch, 9); read.close();
});

test('v3→v4 建立通知表失敗會回復 factors 並保留舊資料與版本', async t => {
  const f = await legacy(t); const old = new DatabaseSync(f.path);
  old.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'TENANT_SUPER_ADMIN'; ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0; ALTER TABLE users ADD COLUMN setup_expires INTEGER; PRAGMA user_version=3; CREATE TABLE notifications(id INTEGER);"); old.close();
  assert.throws(() => new Store(f.path), /already exists/u);
  const read = new DatabaseSync(f.path, { readOnly: true });
  assert.equal(read.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(read.prepare("SELECT name FROM sqlite_master WHERE name='factors'").get(), undefined);
  assert.equal(read.prepare('SELECT epoch FROM tenants').get().epoch, 9); read.close();
});

test('v4→v5 衝突不覆寫未知 response 表，也不提升版本或重設撤銷', async t => {
  const f = await legacy(t);
  const current = new Store(f.path, () => 7000); current.close();
  const old = new DatabaseSync(f.path);
  old.exec('DROP TABLE response_requests; CREATE TABLE response_requests(marker TEXT); INSERT INTO response_requests VALUES (\'synthetic-original\'); PRAGMA user_version=4;');
  old.close();
  assert.throws(() => new Store(f.path), /already exists/u);
  const read = new DatabaseSync(f.path, { readOnly: true });
  assert.equal(read.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(read.prepare('SELECT marker FROM response_requests').get().marker, 'synthetic-original');
  assert.equal(read.prepare('SELECT epoch FROM tenants').get().epoch, 9);
  assert.equal(read.prepare('SELECT COUNT(*) AS count FROM audit').get().count, 1); read.close();
});

test('v6→v7 保留既有撤銷與證據；信箱表衝突時全部回復', async t => {
  for (const conflict of [false, true]) {
    const f = await legacy(t); const current = new Store(f.path, () => 7000);
    const evidence = current.all('SELECT * FROM audit'); current.close();
    const old = new DatabaseSync(f.path);
    old.exec('DROP TABLE external_identities; DROP TABLE email_outbox; DROP TABLE email_challenges; DROP TABLE email_bindings; PRAGMA user_version=6;');
    if (conflict) old.exec("CREATE TABLE email_challenges(marker TEXT); INSERT INTO email_challenges VALUES ('retain-me');");
    old.close();
    if (conflict) {
      assert.throws(() => new Store(f.path), /already exists/u);
      const read = new DatabaseSync(f.path);
      assert.equal(read.prepare('PRAGMA user_version').get().user_version, 6);
      assert.equal(read.prepare("SELECT name FROM sqlite_schema WHERE name='email_bindings'").get(), undefined);
      assert.equal(read.prepare('SELECT marker FROM email_challenges').get().marker, 'retain-me'); read.close();
    } else {
      const upgraded = new Store(f.path, () => 7000);
      assert.equal(upgraded.get('PRAGMA user_version').user_version, 7);
      assert.equal(upgraded.get('SELECT epoch FROM tenants').epoch, 9);
      assert.deepEqual(upgraded.all('SELECT * FROM audit'), evidence);
      assert.equal(upgraded.get('SELECT count(*) AS n FROM email_outbox').n, 0); upgraded.close();
    }
  }
});
