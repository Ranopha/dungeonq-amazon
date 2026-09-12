import { randomUUID } from 'node:crypto';
import { requireThat, exact, digest, id } from './contracts.mjs';

// 僅由可信組裝端取得。沒有 HTTP 派送入口或任意收件網址。
export function notificationDispatcher(db) {
  async function bounded(call, timeoutMs) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(call), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('UNKNOWN')), timeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  function receipt(value, message) {
    exact(value, ['eventId', 'auditDigest', 'receiptId']);
    requireThat(value.eventId === message.eventId && value.auditDigest === message.auditDigest
      && value.receiptId === digest(message), 'DELIVERY_RECEIPT_INVALID');
    return value.receiptId;
  }
  return Object.freeze({
    async dispatch(sink, { timeoutMs = 2000 } = {}) {
      requireThat(sink?.profile === 'LOCAL_SINK_ONLY' && typeof sink.send === 'function' && typeof sink.lookup === 'function', 'NOTIFICATION_SINK_UNSUPPORTED');
      id(sink.tenantId);
      requireThat(Number.isInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 5000, 'SCHEMA_INVALID');
      const job = db.transaction(now => {
        db.run("UPDATE notifications SET status='UNKNOWN',claim=NULL WHERE status='SENDING' AND deadline<=?", now);
        const row = db.get("SELECT * FROM notifications WHERE tenant=? AND status IN ('PENDING','RETRY','UNKNOWN') AND next_at<=? ORDER BY id LIMIT 1", sink.tenantId, now);
        if (!row) return null;
        const source = db.get('SELECT body,digest FROM audit WHERE seq=?', row.id);
        const event = JSON.parse(source.body);
        requireThat(digest(event) === source.digest && digest(JSON.parse(row.body)) === digest({
          schemaVersion: 'dungeonq.lab-notification/v1', eventId: row.id, tenantId: event.tenant,
          kind: event.kind, subject: event.subject, auditDigest: source.digest, channel: 'LOCAL_SINK_ONLY'
        }) && event.tenant === sink.tenantId, 'NOTIFICATION_INTEGRITY');
        const claim = randomUUID();
        db.run("UPDATE notifications SET status='SENDING',claim=?,deadline=? WHERE id=?", claim, now + 10_000, row.id);
        return { ...row, claim };
      });
      if (!job) return { state: 'IDLE', channel: 'LOCAL_SINK_ONLY' };
      const message = Object.freeze(JSON.parse(job.body));
      let outcome = 'UNKNOWN'; let proof = null;
      try {
        // UNKNOWN 絕不自動重送；查無收據也可能是原送件仍在執行。
        const value = await bounded(() => job.status === 'UNKNOWN' ? sink.lookup(digest(message)) : sink.send(message), timeoutMs);
        if (value === null && job.status === 'UNKNOWN') outcome = 'UNKNOWN';
        else if (value?.state === 'NOT_ACCEPTED' && job.status !== 'UNKNOWN') {
          exact(value, ['state']); outcome = 'RETRY';
        } else { proof = receipt(value, message); outcome = 'DELIVERED'; }
      } catch { /* 不保存 Provider 原始錯誤，可能包含秘密。 */ }
      return db.transaction(now => {
        const current = db.get('SELECT * FROM notifications WHERE id=?', job.id);
        requireThat(current.status === 'SENDING' && current.claim === job.claim, 'DELIVERY_FENCED');
        const attempts = job.attempts + (job.status === 'UNKNOWN' ? 0 : 1);
        if (outcome === 'RETRY' && attempts >= 5) outcome = 'FAILED';
        db.run('UPDATE notifications SET status=?,attempts=?,next_at=?,claim=NULL,deadline=NULL,receipt=? WHERE id=?',
          outcome, attempts, now + Math.min(60_000, 1000 * 2 ** attempts), proof, job.id);
        db.audit(now, job.tenant, 'NOTIFICATION_RESULT', 'local-dispatcher', { eventId: job.id, state: outcome, attempts, receipt: proof });
        return { id: job.id, state: outcome, attempts, channel: 'LOCAL_SINK_ONLY' };
      });
    }
  });
}
