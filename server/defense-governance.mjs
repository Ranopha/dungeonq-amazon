import { createPublicKey, sign, verify } from 'node:crypto';
import { ROTATION_DOMAIN, rotationManifest } from './reference-issuer.mjs';
import { exact, id, integer, requireThat, digest, canonicalJson } from './contracts.mjs';

const CHECKS = ['oldKeyDenied', 'newKeyBusiness', 'oldConsumerDenied', 'decoyKeyDenied'];
const hash = value => requireThat(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'SCHEMA_INVALID');

// 只由治理核心組裝。簽章、目標登錄與結果記錄不可提供給 Actor／MCP。
export function createDefenseGovernance({ db, rotationPrivateKey, governancePublicKey, principal, worker, consumeIntent }) {
  let publicKey;
  db.transaction(() => {
    const pinned = db.get("SELECT value FROM configuration WHERE key='rotation-signer'");
    if (rotationPrivateKey === undefined) { requireThat(!pinned, 'ROTATION_KEY_REQUIRED'); return; }
    requireThat(rotationPrivateKey?.type === 'private' && rotationPrivateKey.asymmetricKeyType === 'ed25519', 'ROTATION_SIGNER_INVALID');
    publicKey = createPublicKey(rotationPrivateKey);
    const identity = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    requireThat(identity !== governancePublicKey.export({ type: 'spki', format: 'der' }).toString('base64'), 'ROTATION_KEY_NOT_SEPARATE');
    requireThat(!pinned || pinned.value === identity, 'ROTATION_KEY_PIN_MISMATCH');
    if (!pinned) db.run("INSERT INTO configuration VALUES ('rotation-signer',?)", identity);
  });
  const enabled = () => requireThat(publicKey, 'ROTATION_NOT_CONFIGURED');
  const tenantEpoch = tenant => db.get('SELECT epoch FROM tenants WHERE id=?', tenant)?.epoch;
  function target(tenant, asset) {
    const row = db.get('SELECT * FROM rotation_targets WHERE tenant=? AND asset=?', tenant, asset);
    requireThat(row, 'ROTATION_TARGET_UNAVAILABLE'); return row;
  }
  function request(tenant, requestId) {
    id(requestId);
    const row = db.get('SELECT * FROM rotation_requests WHERE tenant=? AND id=?', tenant, requestId);
    requireThat(row, 'ROTATION_UNAVAILABLE');
    const manifest = rotationManifest(JSON.parse(row.manifest));
    requireThat(manifest.tenantId === row.tenant && manifest.assetId === row.asset && digest(manifest) === row.digest,
      'ROTATION_INTEGRITY');
    return { ...row, manifest };
  }
  function scopeCurrent(row, now) {
    const current = target(row.tenant, row.asset);
    const machine = db.get('SELECT * FROM workers WHERE tenant=? AND id=?', row.tenant, row.worker);
    return row.governance_epoch === tenantEpoch(row.tenant)
      && current.epoch === row.manifest.epoch && current.generation === row.manifest.expectedGeneration
      && current.consumer === row.manifest.cleanConsumer && !!machine && !machine.revoked && machine.expires > now;
  }
  const authorityActive = (row, now) => scopeCurrent(row, now) && row.manifest.expiresAt > now;
  function view(row, now) {
    const active = authorityActive(row, now);
    let state = row.state;
    if (['AWAITING_HUMAN', 'APPROVED', 'CLAIMED', 'UNKNOWN'].includes(state)) {
      if (row.manifest.expiresAt <= now) state = 'EXPIRED';
      else if (!active) state = 'FENCED';
    }
    return { requestId: row.id, incidentId: row.incident, assetId: row.asset, workerId: row.worker,
      manifest: row.manifest, manifestDigest: row.digest, domain: ROTATION_DOMAIN, state, storedState: row.state,
      authorizationActive: active && ['APPROVED', 'CLAIMED'].includes(row.state),
      approvedBy: row.approved_by, approvedAt: row.approved_at, claimedAt: row.claimed_at,
      completedAt: row.completed_at, receipt: row.receipt ? JSON.parse(row.receipt) : null,
      checks: row.checks ? JSON.parse(row.checks) : null };
  }
  function activeRequest(row, now) {
    requireThat(authorityActive(row, now) && row.state !== 'FENCED', 'ROTATION_FENCED');
  }
  function validatedReceipt(value, row) {
    exact(value, ['schemaVersion', 'profile', 'manifestDigest', 'tenantId', 'assetId', 'generation',
      'consumer', 'issuerReadback', 'businessVerified', 'replay']);
    requireThat(value.schemaVersion === 'dungeonq.reference-issuer-receipt/v1' && value.profile === 'SYNTHETIC_ONLY'
      && value.manifestDigest === row.digest && value.tenantId === row.tenant && value.assetId === row.asset
      && value.generation === row.manifest.expectedGeneration + 1 && value.consumer === row.manifest.cleanConsumer
      && value.issuerReadback === true && value.businessVerified === false && typeof value.replay === 'boolean', 'ROTATION_RECEIPT_INVALID');
    return { ...value, replay: false };
  }
  const local = Object.freeze({
    rotationVerificationKey() {
      enabled(); return { domain: ROTATION_DOMAIN, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) };
    },
    registerRotationTarget(input) {
      enabled(); exact(input, ['tenantId', 'assetId', 'expectedGeneration', 'epoch', 'cleanConsumer']);
      id(input.tenantId); id(input.assetId); id(input.cleanConsumer);
      integer(input.expectedGeneration, 0, 99); integer(input.epoch, 1, 1_000_000);
      return db.transaction(now => {
        requireThat(db.get('SELECT id FROM assets WHERE tenant=? AND id=?', input.tenantId, input.assetId), 'SCOPE_INVALID');
        const prior = db.get('SELECT * FROM rotation_targets WHERE tenant=? AND asset=?', input.tenantId, input.assetId);
        if (prior) {
          requireThat(prior.registration === canonicalJson(input), 'ROTATION_TARGET_CONFLICT');
          return { registered: true, replay: true, generation: prior.generation, epoch: prior.epoch };
        }
        requireThat(db.get('SELECT count(*) AS n FROM rotation_targets WHERE tenant=?', input.tenantId).n < 100, 'ROTATION_CAPACITY');
        db.run('INSERT INTO rotation_targets VALUES (?,?,?,?,?,?)', input.tenantId, input.assetId,
          input.expectedGeneration, input.epoch, input.cleanConsumer, canonicalJson(input));
        db.audit(now, input.tenantId, 'ROTATION_TARGET_REGISTERED', input.assetId,
          { generation: input.expectedGeneration, epoch: input.epoch, consumer: input.cleanConsumer });
        return { registered: true, replay: false, generation: input.expectedGeneration, epoch: input.epoch };
      });
    },
    recordDecoyContact(input) {
      enabled(); exact(input, ['tenantId', 'incidentId', 'assetId', 'worldId', 'eventDigest']);
      id(input.tenantId); id(input.incidentId); id(input.assetId);
      requireThat(typeof input.worldId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(input.worldId), 'IDENTIFIER_INVALID');
      hash(input.eventDigest);
      return db.transaction(now => {
        target(input.tenantId, input.assetId);
        const prior = db.get('SELECT * FROM decoy_incidents WHERE tenant=? AND id=?', input.tenantId, input.incidentId);
        if (prior) {
          requireThat(prior.asset === input.assetId && prior.world === input.worldId && prior.event_digest === input.eventDigest,
            'DECOY_INCIDENT_CONFLICT');
          return { incidentId: input.incidentId, recorded: true, replay: true, notificationEventId: prior.audit_seq };
        }
        requireThat(db.get('SELECT count(*) AS n FROM decoy_incidents WHERE tenant=?', input.tenantId).n < 1000, 'DECOY_CAPACITY');
        const sequence = db.audit(now, input.tenantId, 'DECOY_CONTACT', input.incidentId,
          { assetId: input.assetId, worldId: input.worldId, eventDigest: input.eventDigest,
            source: 'CONFIGURED_LOCAL_DECOY', actorClassification: 'UNDETERMINED' });
        db.run('INSERT INTO decoy_incidents VALUES (?,?,?,?,?,?,?)', input.tenantId, input.incidentId, input.assetId,
          input.worldId, input.eventDigest, now, sequence);
        return { incidentId: input.incidentId, recorded: true, replay: false, notificationEventId: sequence };
      });
    },
    rotationRequestsToReconcile(input) {
      enabled(); exact(input, ['tenantId']); id(input.tenantId);
      return db.transaction(now => db.all("SELECT id FROM rotation_requests WHERE tenant=? AND claimed_at IS NOT NULL AND state IN ('CLAIMED','UNKNOWN','FENCED') ORDER BY id LIMIT 100", input.tenantId)
        .map(row => view(request(input.tenantId, row.id), now)));
    },
    recordRotationOutcome(input) {
      enabled(); exact(input, ['tenantId', 'requestId', 'manifestDigest', 'status', 'receipt', 'checks']);
      id(input.tenantId); id(input.requestId); hash(input.manifestDigest);
      requireThat(['COMPLETED', 'UNKNOWN', 'FAILED'].includes(input.status), 'SCHEMA_INVALID');
      exact(input.checks, CHECKS);
      requireThat(CHECKS.every(key => typeof input.checks[key] === 'boolean'), 'SCHEMA_INVALID');
      return db.transaction(now => {
        const row = request(input.tenantId, input.requestId);
        requireThat(row.digest === input.manifestDigest && row.claimed_at !== null, 'ROTATION_RESULT_UNBOUND');
        const authorizedAtReadback = authorityActive(row, now) && row.state !== 'FENCED';
        const receipt = input.receipt === null ? null : validatedReceipt(input.receipt, row);
        const encodedReceipt = receipt ? canonicalJson(receipt) : null;
        const encodedChecks = canonicalJson(input.checks);
        if (input.status === 'COMPLETED') requireThat(receipt && CHECKS.every(key => input.checks[key]), 'ROTATION_READBACK_REQUIRED');
        if (['COMPLETED', 'FAILED'].includes(row.state)) {
          requireThat(row.state === input.status && row.receipt === encodedReceipt && row.checks === encodedChecks, 'ROTATION_RESULT_CONFLICT');
          return view(row, now);
        }
        requireThat(['CLAIMED', 'UNKNOWN', 'FENCED'].includes(row.state), 'ROTATION_RESULT_UNBOUND');
        if (input.status === 'COMPLETED') {
          const current = target(row.tenant, row.asset);
          requireThat(current.generation === row.manifest.expectedGeneration && current.epoch === row.manifest.epoch,
            'ROTATION_TARGET_CONFLICT');
          db.run('UPDATE rotation_targets SET generation=? WHERE tenant=? AND asset=?', receipt.generation, row.tenant, row.asset);
        }
        // 撤銷／過期不丟棄已發生的效果；只接受可信 Broker 提供的精確收據與四項讀回。
        const state = row.state === 'FENCED' && input.status === 'UNKNOWN' ? 'FENCED' : input.status;
        db.run('UPDATE rotation_requests SET state=?,receipt=?,checks=?,completed_at=? WHERE tenant=? AND id=?',
          state, encodedReceipt, encodedChecks, input.status === 'COMPLETED' ? now : null, row.tenant, row.id);
        db.audit(now, row.tenant, 'ROTATION_RESULT', row.id, { incidentId: row.incident, manifestDigest: row.digest,
          state, receiptDigest: receipt ? digest(receipt) : null, checks: input.checks, authorizationActive: authorizedAtReadback });
        return view(request(row.tenant, row.id), now);
      });
    }
  });
  const application = Object.freeze({
    rotationStatus(sessionToken) {
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'READ_STATUS');
        const incidents = db.all('SELECT * FROM decoy_incidents WHERE tenant=? ORDER BY observed_at DESC,id LIMIT 100', session.tenant)
          .map(row => {
            const notification = db.get('SELECT status,receipt FROM notifications WHERE id=? AND tenant=?', row.audit_seq, session.tenant);
            return { incidentId: row.id, assetId: row.asset, worldId: row.world, eventDigest: row.event_digest,
              observedAt: row.observed_at, actorClassification: 'UNDETERMINED',
              notification: { eventId: row.audit_seq, state: notification?.status ?? 'UNAVAILABLE', receipt: notification?.receipt ?? null } };
          });
        const requests = db.all('SELECT id FROM rotation_requests WHERE tenant=? ORDER BY id LIMIT 100', session.tenant)
          .map(row => view(request(session.tenant, row.id), now));
        return { incidents, requests };
      });
    },
    refreshRotation(sessionToken, input) {
      enabled(); exact(input, ['requestId']); id(input.requestId);
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'APPROVE_ROTATION');
        const row = request(session.tenant, input.requestId);
        requireThat(['AWAITING_HUMAN', 'APPROVED'].includes(row.state) && row.claimed_at === null && row.signature === null
          && row.manifest.expiresAt <= now, 'ROTATION_REFRESH_DENIED');
        requireThat(scopeCurrent(row, now), 'ROTATION_FENCED');
        const machine = db.get('SELECT expires FROM workers WHERE tenant=? AND id=?', row.tenant, row.worker);
        const manifest = rotationManifest({ ...row.manifest, expiresAt: Math.min(now + 300_000, machine.expires) });
        db.run("DELETE FROM intents WHERE purpose='APPROVE_ROTATION' AND manifest=?", row.digest);
        db.run("UPDATE rotation_requests SET manifest=?,digest=?,state='AWAITING_HUMAN',approved_by=NULL,approved_at=NULL WHERE tenant=? AND id=?",
          canonicalJson(manifest), digest(manifest), row.tenant, row.id);
        db.audit(now, row.tenant, 'ROTATION_PROPOSAL_REFRESHED', session.user_id,
          { requestId: row.id, incidentId: row.incident, previousManifestDigest: row.digest,
            manifestDigest: digest(manifest), previousExpiresAt: row.manifest.expiresAt, expiresAt: manifest.expiresAt });
        return view(request(row.tenant, row.id), now);
      });
    },
    approveRotation(sessionToken, input) {
      enabled(); exact(input, ['requestId', 'manifestDigest', 'intentToken']); hash(input.manifestDigest);
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'APPROVE_ROTATION');
        const row = request(session.tenant, input.requestId);
        requireThat(row.digest === input.manifestDigest, 'ROTATION_CHANGED');
        requireThat(row.state === 'AWAITING_HUMAN', 'ROTATION_ALREADY_DECIDED');
        activeRequest(row, now);
        consumeIntent(session, input.intentToken, 'APPROVE_ROTATION', row.digest, now);
        db.run("UPDATE rotation_requests SET state='APPROVED',approved_by=?,approved_at=? WHERE tenant=? AND id=?",
          session.user_id, now, row.tenant, row.id);
        db.audit(now, row.tenant, 'ROTATION_APPROVED', session.user_id,
          { requestId: row.id, incidentId: row.incident, manifestDigest: row.digest, authorization: 'SINGLE_OWNER_AUTHORIZED' });
        return view(request(row.tenant, row.id), now);
      });
    }
  });
  const execution = Object.freeze({
    requestRotation(workerToken, input) {
      enabled(); exact(input, ['requestId', 'incidentId']); id(input.requestId); id(input.incidentId);
      return db.transaction(now => {
        const machine = worker(workerToken, now);
        const previous = db.get('SELECT id,worker,incident FROM rotation_requests WHERE tenant=? AND (id=? OR incident=?)',
          machine.tenant, input.requestId, input.incidentId);
        if (previous) {
          requireThat(previous.id === input.requestId && previous.incident === input.incidentId && previous.worker === machine.id,
            'ROTATION_REQUEST_CONFLICT');
          return view(request(machine.tenant, previous.id), now);
        }
        requireThat(db.get('SELECT count(*) AS n FROM rotation_requests WHERE tenant=?', machine.tenant).n < 100, 'ROTATION_CAPACITY');
        const incident = db.get('SELECT * FROM decoy_incidents WHERE tenant=? AND id=?', machine.tenant, input.incidentId);
        requireThat(incident, 'DECOY_INCIDENT_UNAVAILABLE');
        const current = target(machine.tenant, incident.asset);
        requireThat(current.generation === JSON.parse(current.registration).expectedGeneration, 'ROTATION_TARGET_COMPLETED');
        const manifest = rotationManifest({ schemaVersion: 'dungeonq.reference-rotation/v1', profile: 'SYNTHETIC_ONLY',
          tenantId: machine.tenant, assetId: current.asset, expectedGeneration: current.generation, epoch: current.epoch,
          cleanConsumer: current.consumer, expiresAt: Math.min(now + 300_000, machine.expires) });
        db.run(`INSERT INTO rotation_requests(tenant,id,incident,asset,worker,governance_epoch,manifest,digest,state)
          VALUES (?,?,?,?,?,?,?,?,'AWAITING_HUMAN')`, machine.tenant, input.requestId, input.incidentId, current.asset,
        machine.id, tenantEpoch(machine.tenant), canonicalJson(manifest), digest(manifest));
        db.audit(now, machine.tenant, 'ROTATION_REQUESTED', machine.id,
          { requestId: input.requestId, incidentId: input.incidentId, manifestDigest: digest(manifest), domain: ROTATION_DOMAIN });
        return view(request(machine.tenant, input.requestId), now);
      });
    },
    claimRotation(workerToken, input) {
      enabled(); exact(input, ['requestId']); id(input.requestId);
      return db.transaction(now => {
        const machine = worker(workerToken, now);
        const row = request(machine.tenant, input.requestId);
        requireThat(row.worker === machine.id, 'ROTATION_UNAVAILABLE');
        if (row.state === 'COMPLETED') return { requestId: row.id, incidentId: row.incident, manifestDigest: row.digest,
          state: 'COMPLETED', receipt: JSON.parse(row.receipt), checks: JSON.parse(row.checks), replay: true };
        activeRequest(row, now);
        requireThat(row.state !== 'UNKNOWN', 'ROTATION_RECONCILIATION_REQUIRED');
        requireThat(['APPROVED', 'CLAIMED'].includes(row.state) && row.approved_by !== null, 'HUMAN_APPROVAL_REQUIRED');
        const reservation = db.get('SELECT request_id FROM rotation_claims WHERE tenant=? AND asset=? AND generation=?',
          row.tenant, row.asset, row.manifest.expectedGeneration);
        requireThat(!reservation || reservation.request_id === row.id, 'ROTATION_GENERATION_CLAIMED');
        if (!reservation) db.run('INSERT INTO rotation_claims VALUES (?,?,?,?)', row.tenant, row.asset, row.manifest.expectedGeneration, row.id);
        const replay = row.state === 'CLAIMED';
        const signature = row.signature ?? sign(null, Buffer.from(ROTATION_DOMAIN + canonicalJson(row.manifest)), rotationPrivateKey).toString('base64url');
        requireThat(verify(null, Buffer.from(ROTATION_DOMAIN + canonicalJson(row.manifest)), publicKey,
          Buffer.from(signature, 'base64url')), 'ROTATION_INTEGRITY');
        if (!replay) {
          db.run("UPDATE rotation_requests SET state='CLAIMED',claimed_at=?,signature=? WHERE tenant=? AND id=?", now, signature, row.tenant, row.id);
          db.audit(now, row.tenant, 'ROTATION_CLAIMED', machine.id,
            { requestId: row.id, incidentId: row.incident, manifestDigest: row.digest });
        }
        return { requestId: row.id, incidentId: row.incident, manifestDigest: row.digest, state: 'CLAIMED',
          permit: { body: row.manifest, signature }, replay };
      });
    }
  });
  return { local, application, execution };
}
