import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openPrivateWorldDatabase } from '../server/world-store.mjs';
import { insist } from './transport.mjs';

export function openAuxiliary(path, schema, metadata) {
  const existed = existsSync(path);
  if (existed) insist(lstatSync(path).size > 0, 'AUXILIARY_STORAGE_INCOMPLETE');
  const expected = new DatabaseSync(':memory:'); expected.exec(schema);
  const structure = db => db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.sql);
  const schemaText = JSON.stringify(structure(expected)); expected.close();
  const db = openPrivateWorldDatabase(path);
  try {
    if (existed) {
      insist(db.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'AUXILIARY_STORAGE_CORRUPT');
      insist(JSON.stringify(structure(db)) === schemaText, 'AUXILIARY_SCHEMA_CHANGED');
      insist(db.prepare(`SELECT count(*) AS n FROM ${metadata} WHERE id=1`).get().n === 1
        && db.prepare(`SELECT count(*) AS n FROM ${metadata}`).get().n === 1, 'AUXILIARY_STORAGE_INCOMPLETE');
    } else db.exec(schema);
    return db;
  } catch(e) { db.close(); throw e; }
}
