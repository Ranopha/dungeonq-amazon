import { Store } from './store.mjs';
import { exact, id, requireThat, digest, canonicalJson } from './contracts.mjs';

export function openLocalNotificationSink({ path, tenantId, clock = Date.now }) {
  id(tenantId); const db = new Store(path, clock);
  try { db.transaction(() => {
    const pin = db.get("SELECT value FROM configuration WHERE key='sink-tenant'");
    requireThat(!pin || pin.value === tenantId, 'TENANT_DENIED');
    if (!pin) {
      db.run("INSERT INTO configuration VALUES ('sink-tenant',?)", tenantId);
      db.run('CREATE TABLE sink_receipts (id TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT');
    }
  }); } catch (error) { db.close(); throw error; }
  return Object.freeze({ profile: 'LOCAL_SINK_ONLY', tenantId,
    send(message) {
      exact(message, ['schemaVersion', 'eventId', 'tenantId', 'kind', 'subject', 'auditDigest', 'channel']);
      requireThat(message.schemaVersion === 'dungeonq.lab-notification/v1' && message.channel === 'LOCAL_SINK_ONLY'
        && message.tenantId === tenantId && Number.isSafeInteger(message.eventId) && message.eventId > 0
        && typeof message.auditDigest === 'string' && /^[a-f0-9]{64}$/u.test(message.auditDigest), 'NOTIFICATION_INVALID');
      requireThat(typeof message.kind === 'string' && /^[A-Z_]{1,64}$/u.test(message.kind)
        && typeof message.subject === 'string' && /^[a-zA-Z0-9_-]{1,64}$/u.test(message.subject), 'NOTIFICATION_INVALID');
      return db.transaction(() => {
        const receipt = { eventId: message.eventId, auditDigest: message.auditDigest, receiptId: digest(message) };
        db.run('INSERT INTO sink_receipts VALUES (?,?) ON CONFLICT(id) DO NOTHING', receipt.receiptId, canonicalJson(receipt));
        return JSON.parse(db.get('SELECT body FROM sink_receipts WHERE id=?', receipt.receiptId).body);
      });
    },
    lookup(key) { requireThat(typeof key === 'string' && /^[a-f0-9]{64}$/u.test(key), 'NOTIFICATION_INVALID'); const row = db.get('SELECT body FROM sink_receipts WHERE id=?', key); return row ? JSON.parse(row.body) : null; },
    close: () => db.close()
  });
}
