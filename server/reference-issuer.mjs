import { randomBytes, verify } from 'node:crypto';
import { Store } from './store.mjs';
import { seedVault } from './totp.mjs';
import { exact, requireThat, id, integer, digest, token, tokenHash, canonicalJson } from './contracts.mjs';

export const ROTATION_DOMAIN = 'dungeonq.reference-rotation/v1\n';
export function rotationManifest(input) {
  exact(input, ['schemaVersion', 'profile', 'tenantId', 'assetId', 'expectedGeneration', 'epoch', 'cleanConsumer', 'expiresAt']);
  requireThat(input.schemaVersion === 'dungeonq.reference-rotation/v1' && input.profile === 'SYNTHETIC_ONLY', 'PROFILE_NOT_AUTHORIZED');
  id(input.tenantId); id(input.assetId); id(input.cleanConsumer);
  integer(input.expectedGeneration, 0, 99); integer(input.epoch, 1, 1_000_000); integer(input.expiresAt, 0, Number.MAX_SAFE_INTEGER);
  return { ...input };
}

// 獨立 DB／custody key／測試授權 signer；不是 production connector，亦不接受 containment Grant。
export function openReferenceIssuer({ path, custodyKey, authorizationPublicKey, clock = Date.now, profile = 'SYNTHETIC_ONLY' }) {
  requireThat(profile === 'SYNTHETIC_ONLY', 'PROFILE_NOT_AUTHORIZED');
  requireThat(authorizationPublicKey?.type === 'public' && authorizationPublicKey.asymmetricKeyType === 'ed25519', 'SIGNER_INVALID');
  const vault = seedVault(custodyKey); const db = new Store(path, clock);
  const pin = digest({ key: custodyKey.toString('base64url'), signer: authorizationPublicKey.export({ type: 'spki', format: 'der' }).toString('base64') });
  try { db.transaction(() => {
    const prior = db.get("SELECT value FROM configuration WHERE key='reference-issuer'");
    requireThat(!prior || prior.value === pin, 'ISSUER_PIN_MISMATCH');
    if (!prior) {
      db.run("INSERT INTO configuration VALUES ('reference-issuer',?)", pin);
      db.run('CREATE TABLE issuer_asset (tenant TEXT NOT NULL,asset TEXT NOT NULL,generation INTEGER NOT NULL,epoch INTEGER NOT NULL,consumer TEXT NOT NULL,sealed TEXT NOT NULL,key_hash TEXT NOT NULL,PRIMARY KEY(tenant,asset)) STRICT');
      db.run('CREATE TABLE issuer_consumers (id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,tenant TEXT NOT NULL,retired INTEGER NOT NULL DEFAULT 0) STRICT');
      db.run('CREATE TABLE issuer_receipts (id TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT');
    }
  }); } catch (error) { db.close(); throw error; }
  function read(tenant, asset) { const row = db.get('SELECT * FROM issuer_asset WHERE tenant=? AND asset=?', tenant, asset); requireThat(row, 'SCOPE_INVALID'); return row; }
  function consumerIdentity(credential) {
    const identity = db.get('SELECT * FROM issuer_consumers WHERE hash=?', tokenHash(credential));
    requireThat(identity, 'CONSUMER_DENIED'); return identity;
  }
  return Object.freeze({
    bootstrap(input) {
      exact(input, ['tenantId', 'assetId', 'consumers']); id(input.tenantId); id(input.assetId);
      requireThat(Array.isArray(input.consumers) && input.consumers.length === 2 && new Set(input.consumers).size === 2, 'SCOPE_INVALID'); input.consumers.forEach(id);
      return db.transaction(() => {
        requireThat(!db.get('SELECT * FROM issuer_asset'), 'BOOTSTRAP_CLOSED');
        const key = randomBytes(32);
        db.run('INSERT INTO issuer_asset VALUES (?,?,0,1,?,?,?)', input.tenantId, input.assetId, input.consumers[0],
          vault.seal(key, `${input.tenantId}/${input.assetId}/0`), tokenHash(key.toString('base64url')));
        return Object.fromEntries(input.consumers.map(consumer => {
          const value = token(); db.run('INSERT INTO issuer_consumers(id,hash,tenant) VALUES (?,?,?)', consumer, tokenHash(value), input.tenantId); return [consumer, value];
        }));
      });
    },
    acquire(consumerCredential, assetId) {
      id(assetId);
      return db.transaction(() => {
        const identity = consumerIdentity(consumerCredential); const row = read(identity.tenant, assetId);
        requireThat(row.consumer === identity.id, 'CONSUMER_FENCED');
        return vault.open(row.sealed, `${row.tenant}/${row.asset}/${row.generation}`).toString('base64url');
      });
    },
    business(input) {
      exact(input, ['tenantId', 'assetId', 'apiKey']);
      const { tenantId, assetId, apiKey } = input;
      id(tenantId); id(assetId);
      return db.transaction(() => {
        const row = read(tenantId, assetId); requireThat(tokenHash(apiKey) === row.key_hash, 'KEY_REJECTED');
        return { profile: 'SYNTHETIC_ONLY', orderId: 'synthetic-order-41', quantity: 7, generation: row.generation };
      });
    },
    rotate(envelope) {
      exact(envelope, ['body', 'signature']); const body = rotationManifest(envelope.body);
      requireThat(typeof envelope.signature === 'string' && envelope.signature.length === 86
        && verify(null, Buffer.from(ROTATION_DOMAIN + canonicalJson(body)), authorizationPublicKey, Buffer.from(envelope.signature, 'base64url')), 'SIGNATURE_INVALID');
      return db.transaction(now => {
        const row = read(body.tenantId, body.assetId);
        requireThat(body.epoch === row.epoch && body.expiresAt > now && body.expiresAt <= now + 300_000, 'ROTATION_FENCED');
        const previous = db.get('SELECT body FROM issuer_receipts WHERE id=?', digest(body));
        if (previous) return { ...JSON.parse(previous.body), replay: true };
        requireThat(row.generation === body.expectedGeneration && row.consumer !== body.cleanConsumer, 'ROTATION_CONFLICT');
        requireThat(db.get('SELECT id FROM issuer_consumers WHERE id=? AND tenant=? AND retired=0', body.cleanConsumer, body.tenantId), 'CONSUMER_DENIED');
        const key = randomBytes(32); const generation = row.generation + 1;
        db.run('UPDATE issuer_consumers SET retired=1 WHERE id=?', row.consumer);
        db.run('UPDATE issuer_asset SET generation=?,consumer=?,sealed=?,key_hash=? WHERE tenant=? AND asset=?', generation, body.cleanConsumer,
          vault.seal(key, `${row.tenant}/${row.asset}/${generation}`), tokenHash(key.toString('base64url')), row.tenant, row.asset);
        const result = { schemaVersion: 'dungeonq.reference-issuer-receipt/v1', profile: 'SYNTHETIC_ONLY',
          manifestDigest: digest(body), tenantId: row.tenant, assetId: row.asset, generation, consumer: body.cleanConsumer,
          issuerReadback: read(row.tenant, row.asset).generation === generation, businessVerified: false, replay: false };
        db.run('INSERT INTO issuer_receipts VALUES (?,?)', digest(body), canonicalJson(result));
        return result;
      });
    },
    receipt(manifestDigest) { requireThat(typeof manifestDigest === 'string' && /^[a-f0-9]{64}$/u.test(manifestDigest), 'SCHEMA_INVALID'); const result = db.get('SELECT body FROM issuer_receipts WHERE id=?', manifestDigest); return result ? JSON.parse(result.body) : null; },
    fence() { return db.transaction(() => { db.run('UPDATE issuer_asset SET epoch=epoch+1'); }); },
    close: () => db.close()
  });
}
