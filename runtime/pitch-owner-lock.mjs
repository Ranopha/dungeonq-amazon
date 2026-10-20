import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { openAuxiliary } from './auxiliary.mjs';
import { insist } from './transport.mjs';

const VERSION = 'dungeonq.pitch-owner-lock/v1';
const SCHEMA = 'CREATE TABLE pitch_owner_lock_meta (id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL)';
const locked = error => [5, 6].includes(Number(error?.errcode) & 255)
  || /database (?:table )?is locked/i.test(error?.message ?? '');

/** Cooperative single-host gateway ownership, held for the whole gateway lifetime.
 * Keep this handle alive and release it only after all dispatches have settled and
 * the canonical store has closed. An available lock proves no other cooperating
 * owner holds this file, not that an external notification or other effect stopped.
 * BEGIN IMMEDIATE keeps SQLite's write lock across calls. OS process termination
 * releases it; no PID file, elapsed-time inference, or stale-file deletion is used.
 */
export function openPitchOwnerLock({ path } = {}) {
  insist(typeof path === 'string' && isAbsolute(path), 'STORAGE_PATH_INVALID');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  insist(parent.isDirectory() && !parent.isSymbolicLink() && !(parent.mode & 0o022), 'STORAGE_DIRECTORY_INVALID');
  let db; let transaction = false;
  try {
    db = openAuxiliary(path, SCHEMA, 'pitch_owner_lock_meta');
    // This lock is an admission decision: a second gateway fails immediately.
    db.exec('PRAGMA busy_timeout=0;');
    const existing = db.prepare('SELECT config FROM pitch_owner_lock_meta WHERE id=1').get();
    if (existing) insist(existing.config === VERSION, 'PITCH_OWNER_LOCK_VERSION');
    else db.prepare('INSERT INTO pitch_owner_lock_meta VALUES(1,?)').run(VERSION);
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    const bootId = randomUUID(); let closed = false;
    return Object.freeze({ bootId, close() {
      if (closed) return; closed = true;
      try { db.exec('ROLLBACK'); }
      finally { transaction = false; db.close(); }
    } });
  } catch (error) {
    if (transaction) { try { db.exec('ROLLBACK'); } catch { /* close below releases ownership */ } }
    try { db?.close(); } catch { /* retain the original admission error */ }
    if (locked(error)) throw Object.assign(new Error('PITCH_GATEWAY_ALREADY_RUNNING'), { code: 'PITCH_GATEWAY_ALREADY_RUNNING' });
    throw error;
  }
}
