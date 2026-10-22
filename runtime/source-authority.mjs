// 固定人工資產的資料面能力驗證；處置決定仍由主機 @eva/policy 作成。
import { digest, equalToken, exact, insist } from './transport.mjs';
export const SOURCE_PROTECTION = 'scoped-v1';
export const SOURCE_CHANNELS = Object.freeze(['MAIN', 'A2', 'CACHE', 'EXPORT']);
export const SOURCE_SCHEMA = `CREATE TABLE IF NOT EXISTS source_authority(id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL, token_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_rotations(action_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, next_hash TEXT NOT NULL UNIQUE, epoch INTEGER NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL, receipt TEXT);
    CREATE TABLE IF NOT EXISTS source_audit(seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, previous TEXT NOT NULL, hash TEXT NOT NULL);`;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function openSourceAuthority(db, { normalToken, tenantId = 'reference', resource = 'deployment-manifest', clock = Date.now, initialize = false }) {

  if (initialize) db.prepare('INSERT INTO source_authority VALUES(1,1,?)').run(digest(normalToken));
  insist(db.prepare('SELECT count(*) AS n FROM source_authority').get().n === 1 && db.prepare('SELECT id FROM source_authority WHERE id=1').get(), 'SOURCE_AUTHORITY_STATE_MISSING');
  const state = () => db.prepare('SELECT epoch,token_hash FROM source_authority WHERE id=1').get();
  const rows = () => db.prepare('SELECT * FROM source_audit ORDER BY seq').all();
  const audit = (kind, detail) => {
    const last = db.prepare('SELECT seq,hash FROM source_audit ORDER BY seq DESC LIMIT 1').get();
    insist((last?.seq ?? 0) < 20000, 'SOURCE_AUDIT_LIMIT');
    const at = clock(), previous = last?.hash ?? 'ROOT', seq = (last?.seq ?? 0) + 1;
    db.prepare('INSERT INTO source_audit VALUES(?,?,?,?,?,?)').run(seq, at, kind, JSON.stringify(detail), previous, digest({ seq, at, kind, detail, previous }));
    return { seq, at, kind, ...detail };
  };
  function report() {
    const current = state();
    const lastRotation = db.prepare("SELECT epoch,next_hash FROM source_rotations WHERE status='EFFECTIVE' ORDER BY epoch DESC LIMIT 1").get();
    insist(lastRotation ? current.epoch === lastRotation.epoch && current.token_hash === lastRotation.next_hash
      : current.epoch === 1 && current.token_hash === digest(normalToken), 'SOURCE_AUTHORITY_STATE_INVALID');
    let previous = 'ROOT';
    const events = rows().map((row, index) => {
      const detail = JSON.parse(row.detail);
      insist(row.seq === index + 1 && row.previous === previous && row.hash === digest({ seq: row.seq, at: row.at, kind: row.kind, detail, previous }), 'SOURCE_AUDIT_INVALID');
      previous = row.hash; return { seq: row.seq, at: row.at, kind: row.kind, ...detail };
    });
    const committed = events.filter(event => event.kind === 'ROTATE_EFFECTIVE');
    insist(committed.length === current.epoch - 1 && committed.every((event, index) => event.epoch === index + 2), 'SOURCE_AUTHORITY_AUDIT_INCOMPLETE');
    return { schemaVersion: 'dungeonq.source-authority/v1', tenantId, resource, epoch: state().epoch, head: previous, events };
  }
  report();
  function authorize({ token, tenant, key, channel, requestId }) {
    insist(id(requestId) && SOURCE_CHANNELS.includes(channel), 'SOURCE_REQUEST_INVALID');
    const current = state(), tokenHash = typeof token === 'string' ? digest(token) : '';
    const staged = db.prepare("SELECT epoch FROM source_rotations WHERE next_hash=? AND status='PREPARED' AND expires>?").get(tokenHash, clock());
    const credentialEpoch = equalToken(tokenHash, current.token_hash) ? current.epoch : staged?.epoch;
    const allowed = tenant === tenantId && key === resource && Number.isSafeInteger(credentialEpoch);
    const event = audit(allowed ? 'TARGET_ALLOWED' : 'TARGET_DENIED', { requestId, channel, epoch: current.epoch, credentialEpoch: credentialEpoch ?? null, grantId: tokenHash,
      // 不接受輸入中的 tenant/role 作身分；只與受信設定的 capability 範圍比較。
      scopeMatched: tenant === tenantId && key === resource, allowed });
    return { allowed, event, epoch: credentialEpoch ?? current.epoch };
  }
  function rotate(input) {
    exact(input, ['operation', 'actionId'], ['expectedEpoch', 'nextToken']);
    insist(id(input.actionId) && ['prepare', 'commit', 'abort', 'lookup'].includes(input.operation), 'ROTATION_INVALID');
    const found = () => db.prepare('SELECT * FROM source_rotations WHERE action_id=?').get(input.actionId);
    const view = row => row ? { actionId: row.action_id, epoch: row.epoch, expiresAt: row.expires, status: row.status, ...(row.receipt ? JSON.parse(row.receipt) : {}) } : null;
    if (input.operation === 'lookup') return view(found());
    db.exec('BEGIN IMMEDIATE');
    try {
      let row = found(); const current = state();
      if (input.operation === 'prepare') {
        insist(Number.isSafeInteger(input.expectedEpoch) && typeof input.nextToken === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(input.nextToken), 'ROTATION_INVALID');
        const payloadHash = digest({ epoch: input.expectedEpoch, token: input.nextToken });
        if (row) insist(row.payload_hash === payloadHash, 'ROTATION_IDEMPOTENCY_CONFLICT');
        else {
          insist(input.expectedEpoch === current.epoch, 'CREDENTIAL_EPOCH_CONFLICT');
          insist(!db.prepare("SELECT action_id FROM source_rotations WHERE status='PREPARED' AND expires>?").get(clock()), 'ROTATION_PENDING_CONFLICT');
          const nextHash = digest(input.nextToken);
          insist(nextHash !== current.token_hash && nextHash !== digest(normalToken) && !db.prepare('SELECT action_id FROM source_rotations WHERE next_hash=?').get(nextHash), 'CREDENTIAL_REUSE_DENIED');
          db.prepare('INSERT INTO source_rotations VALUES(?,?,?,?,?,?,NULL)').run(input.actionId, payloadHash, nextHash, current.epoch + 1, clock() + 300000, 'PREPARED');
          audit('ROTATE_PREPARED', { actionId: input.actionId, epoch: current.epoch + 1 });
        }
      } else {
        insist(row, 'ROTATION_UNKNOWN');
        if (input.operation === 'commit' && row.status !== 'EFFECTIVE') {
          insist(row.status === 'PREPARED' && row.expires > clock() && row.epoch === current.epoch + 1, 'ROTATION_STALE');
          // 新憑證必須先在每個來源路徑成功，才可關閉舊憑證。
          const proven = rows().filter(item => item.kind === 'TARGET_ALLOWED').map(item => JSON.parse(item.detail));
          insist(SOURCE_CHANNELS.every(channel => proven.some(item => item.channel === channel && item.credentialEpoch === row.epoch && item.grantId === row.next_hash)), 'ROTATION_CONSUMER_NOT_READY');
          const effectiveAt = clock();
          db.prepare('UPDATE source_authority SET epoch=?,token_hash=? WHERE id=1').run(row.epoch, row.next_hash);
          db.prepare("UPDATE source_rotations SET status='EFFECTIVE',receipt=? WHERE action_id=?").run(JSON.stringify({ effectiveAt, previousEpoch: current.epoch }), input.actionId);
          audit('ROTATE_EFFECTIVE', { actionId: input.actionId, epoch: row.epoch, previousEpoch: current.epoch, effectiveAt });
        } else if (input.operation === 'abort' && row.status === 'PREPARED') {
          db.prepare("UPDATE source_rotations SET status='ABORTED' WHERE action_id=?").run(input.actionId);
          audit('ROTATE_ABORTED', { actionId: input.actionId, epoch: row.epoch });
        } else if (input.operation === 'abort') insist(row.status === 'ABORTED', 'REVOKED_CREDENTIAL_RESTORE_DENIED');
      }
      row = found(); db.exec('COMMIT'); return view(row);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return { authorize, rotate, report, status: () => ({ tenantId, resource, epoch: state().epoch }) };
}
