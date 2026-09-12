import { DatabaseSync } from 'node:sqlite';
import { lstatSync, openSync, closeSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { requireThat, canonicalJson, digest } from './contracts.mjs';

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT;
INSERT INTO meta VALUES ('clock', 0);
CREATE TABLE configuration (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE tenants (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 1) STRICT;
CREATE TABLE users (id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id), username TEXT NOT NULL,
 password TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 1, UNIQUE(tenant,username)) STRICT;
CREATE TABLE sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), epoch INTEGER NOT NULL,
 created INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires INTEGER NOT NULL) STRICT;
CREATE TABLE recovery (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id)) STRICT;
CREATE TABLE intents (hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
 purpose TEXT NOT NULL, manifest TEXT NOT NULL, expires INTEGER NOT NULL) STRICT;
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL, next_at INTEGER NOT NULL) STRICT;
CREATE TABLE workers (hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, tenant TEXT NOT NULL REFERENCES tenants(id),
 expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE assets (tenant TEXT NOT NULL REFERENCES tenants(id), id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'ACTIVE', last_job TEXT, PRIMARY KEY(tenant,id)) STRICT;
CREATE TABLE observations (tenant TEXT NOT NULL, id TEXT NOT NULL, asset TEXT NOT NULL, version INTEGER NOT NULL,
 observed_at INTEGER NOT NULL, PRIMARY KEY(tenant,id), FOREIGN KEY(tenant,asset) REFERENCES assets(tenant,id)) STRICT;
CREATE TABLE grants (id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id), owner TEXT NOT NULL REFERENCES users(id),
 body TEXT NOT NULL, signature TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE jobs (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, grant_id TEXT NOT NULL REFERENCES grants(id),
 event_id TEXT NOT NULL, asset TEXT NOT NULL, version INTEGER NOT NULL, worker TEXT NOT NULL,
 lease TEXT NOT NULL, signature TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('CLAIMED','FENCED','COMPLETED')),
 receipt TEXT, UNIQUE(tenant,asset,version), UNIQUE(tenant,event_id,asset),
 FOREIGN KEY(tenant,asset) REFERENCES assets(tenant,id)) STRICT;
CREATE TABLE outbox (job TEXT PRIMARY KEY REFERENCES jobs(id), status TEXT NOT NULL CHECK(status IN ('PENDING','FENCED','DONE'))) STRICT;
CREATE TABLE audit (seq INTEGER PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'AUDIT_IMMUTABLE'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'AUDIT_IMMUTABLE'); END;
PRAGMA user_version=1;
`;

// v1 只可建立 Tenant Owner，故既有列明確保留 Owner；不推測其他來源身分。
const MIGRATE_V2 = `
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'TENANT_SUPER_ADMIN'
 CHECK(role IN ('TENANT_SUPER_ADMIN','MIS_OPERATOR','REVIEWER','AUDITOR'));
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1));
PRAGMA user_version=2;
`;

export class Store {
  #db;
  #clock;
  constructor(path, clock = Date.now) {
    requireThat(isAbsolute(path), 'STORAGE_PATH_INVALID');
    const parent = lstatSync(dirname(path));
    requireThat(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o077) === 0, 'STORAGE_NOT_PRIVATE');
    try { const fd = openSync(path, 'wx', 0o600); closeSync(fd); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const file = lstatSync(path);
    requireThat(file.isFile() && !file.isSymbolicLink() && file.nlink === 1 && (file.mode & 0o077) === 0, 'STORAGE_NOT_PRIVATE');
    this.#db = new DatabaseSync(path, { timeout: 5000, allowExtension: false, defensive: true });
    this.#clock = clock;
    try {
      this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
      this.#db.exec('BEGIN IMMEDIATE');
      const version = this.get('PRAGMA user_version').user_version;
      requireThat([0, 1, 2, 3, 4, 5].includes(version), 'SCHEMA_VERSION_UNSUPPORTED');
      if (version === 0) this.#db.exec(SCHEMA);
      if (version < 2) this.#db.exec(MIGRATE_V2);
      if (version < 3) this.#db.exec('ALTER TABLE users ADD COLUMN setup_expires INTEGER CHECK(setup_expires IS NULL OR setup_expires>0); PRAGMA user_version=3;');
      if (version < 4) this.#db.exec(`
        CREATE TABLE factors (user_id TEXT PRIMARY KEY REFERENCES users(id), sealed TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('PENDING','ACTIVE')), session_hash TEXT, expires INTEGER NOT NULL,
          last_step INTEGER NOT NULL DEFAULT -1) STRICT;
        CREATE TABLE notifications (id INTEGER PRIMARY KEY REFERENCES audit(seq), tenant TEXT NOT NULL,
          body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK(status IN ('PENDING','SENDING','RETRY','UNKNOWN','DELIVERED','FAILED')),
          attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, claim TEXT, deadline INTEGER,
          receipt TEXT) STRICT;
        PRAGMA user_version=4;
      `);
      if (version < 5) this.#db.exec(`
        CREATE TABLE response_requests (id TEXT NOT NULL, tenant TEXT NOT NULL REFERENCES tenants(id),
          worker TEXT NOT NULL, event_id TEXT NOT NULL, asset TEXT NOT NULL, version INTEGER NOT NULL,
          draft TEXT NOT NULL, digest TEXT NOT NULL, grant_id TEXT REFERENCES grants(id),
          PRIMARY KEY(tenant,id), FOREIGN KEY(tenant,asset) REFERENCES assets(tenant,id)) STRICT;
        PRAGMA user_version=5;
      `);
      this.#db.exec('COMMIT');
      requireThat(this.get('PRAGMA quick_check').quick_check === 'ok', 'STORAGE_CORRUPT');
      this.verifyAudit();
    } catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); this.#db.close(); throw error; }
  }
  get(sql, ...args) { const row = this.#db.prepare(sql).get(...args); return row ? { ...row } : undefined; }
  all(sql, ...args) { return this.#db.prepare(sql).all(...args).map(row => ({ ...row })); }
  run(sql, ...args) { return this.#db.prepare(sql).run(...args); }
  transaction(operation) {
    this.#db.exec('BEGIN IMMEDIATE');
    let checkpoint = false;
    try {
      const now = this.#clock();
      requireThat(Number.isSafeInteger(now) && now >= this.get("SELECT value FROM meta WHERE key='clock'").value, 'CLOCK_ROLLBACK');
      this.run("UPDATE meta SET value=? WHERE key='clock'", now);
      this.#db.exec('SAVEPOINT effect');
      checkpoint = true;
      const result = operation(now);
      requireThat(!result?.then, 'ASYNC_TRANSACTION_FORBIDDEN');
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      // 拒絕過期操作也必須保存已見時間，否則倒退後會復活 Session／Lease。
      if (checkpoint) this.#db.exec('ROLLBACK TO effect; RELEASE effect; COMMIT;');
      else this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  audit(now, tenant, kind, subject, details = {}) {
    const previous = this.get('SELECT seq,digest FROM audit ORDER BY seq DESC LIMIT 1');
    const entry = { schemaVersion: 'dungeonq.lab-audit/v1', profile: 'SYNTHETIC_ONLY',
      sequence: (previous?.seq ?? 0) + 1, previousDigest: previous?.digest ?? null, now, tenant, kind, subject, details };
    this.run('INSERT INTO audit VALUES (?,?,?)', entry.sequence, canonicalJson(entry), digest(entry));
    if (['RECOVERY_CODES_REPLACED', 'ACCOUNT_RECOVERED', 'ACCOUNT_RECOVERED_GRANTS_REVOKED',
      'MEMBER_ACTIVATED', 'MEMBER_CHANGE_APPLIED', 'GRANT_PUBLISHED', 'GRANTS_REVOKED',
      'TOTP_ENABLED', 'TOTP_REMOVED'].includes(kind)) {
      // 不複製自由 details、Token、密碼或 Seed；audit 與 queue 同一筆交易。
      this.run('INSERT INTO notifications(id,tenant,body,next_at) VALUES (?,?,?,?)', entry.sequence, tenant,
        canonicalJson({ schemaVersion: 'dungeonq.lab-notification/v1', eventId: entry.sequence,
          tenantId: tenant, kind, subject, auditDigest: digest(entry), channel: 'LOCAL_SINK_ONLY' }), now);
    }
  }
  verifyAudit() {
    let previous = null;
    let sequence = 1;
    for (const row of this.all('SELECT * FROM audit ORDER BY seq')) {
      const entry = JSON.parse(row.body);
      requireThat(row.seq === sequence && entry.sequence === sequence && entry.previousDigest === previous
        && digest(entry) === row.digest, 'AUDIT_INTEGRITY');
      previous = row.digest; sequence++;
    }
    return { entries: sequence - 1, head: previous };
  }
  close() { this.#db.close(); }
}
