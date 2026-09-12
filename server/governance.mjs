import { sign, verify, createPublicKey, randomUUID, randomBytes } from 'node:crypto';
import { seedVault, matchOtp, base32 } from './totp.mjs';
import { notificationDispatcher } from './notifications.mjs';
import { Store } from './store.mjs';
import { hashPassword, verifyPassword, passwordText } from './passwords.mjs';
import { authorize, capabilities, MEMBER_ROLES } from './authorization.mjs';
import { GovernanceError, requireThat, exact, id, integer, digest, token, tokenHash, grantDraft, memberChange, canonicalJson } from './contracts.mjs';

const MINUTE = 60_000;
const DAY = 86_400_000;
const SIGN_DOMAIN = 'dungeonq.lab-governance/v1\n';
const bytes = body => Buffer.from(SIGN_DOMAIN + canonicalJson(body));

// 此工廠只由可信的伺服器組裝端使用；不是 HTTP／MCP 的可呼叫管理入口。
export async function openGovernance({ path, privateKey, keyId, clock = Date.now, profile = 'SYNTHETIC_ONLY', factorKey }) {
  requireThat(profile === 'SYNTHETIC_ONLY', 'PROFILE_NOT_AUTHORIZED');
  requireThat(privateKey?.type === 'private' && privateKey.asymmetricKeyType === 'ed25519', 'SIGNER_INVALID');
  id(keyId);
  const publicKey = createPublicKey(privateKey);
  const dummyPassword = await hashPassword(token());
  const db = new Store(path, clock);
  let vault;
  try {
    db.transaction(() => {
      const factorPin = db.get("SELECT value FROM configuration WHERE key='factor-key'");
      if (factorKey !== undefined) {
        vault = seedVault(factorKey);
        const pin = digest(factorKey.toString('base64url'));
        requireThat(!factorPin || factorPin.value === pin, 'TOTP_KEY_PIN_MISMATCH');
        if (!factorPin) db.run("INSERT INTO configuration VALUES ('factor-key',?)", pin);
      } else requireThat(!factorPin, 'TOTP_KEY_REQUIRED');
      const identity = canonicalJson({ keyId, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') });
      const pinned = db.get("SELECT value FROM configuration WHERE key='signer'");
      requireThat(!pinned || pinned.value === identity, 'SIGNER_PIN_MISMATCH');
      if (!pinned) db.run("INSERT INTO configuration VALUES ('signer',?)", identity);
    });
  } catch (error) { db.close(); throw error; }
  const envelope = body => ({ body, signature: sign(null, bytes(body), privateKey).toString('base64url') });
  const checkEnvelope = ({ body, signature }) => {
    requireThat(body?.keyId === keyId && typeof signature === 'string' && signature.length === 86
      && verify(null, bytes(body), publicKey, Buffer.from(signature, 'base64url')), 'SIGNATURE_INVALID');
    return body;
  };

  function principal(sessionToken, now, action) {
    const hash = tokenHash(sessionToken);
    const row = db.get(`SELECT s.*,u.tenant,u.username,u.password,u.role,u.disabled,u.setup_expires,u.epoch AS user_epoch
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=?`, hash);
    requireThat(row && !row.disabled && row.setup_expires === null && row.epoch === row.user_epoch && row.expires > now && row.last_seen + 15 * MINUTE > now,
      'AUTH_REQUIRED');
    authorize(row.role, action);
    db.run('UPDATE sessions SET last_seen=? WHERE hash=?', now, hash);
    return row;
  }
  function worker(workerToken, now) {
    const row = db.get('SELECT * FROM workers WHERE hash=?', tokenHash(workerToken));
    requireThat(row && !row.revoked && row.expires > now, 'WORKER_AUTH_REQUIRED');
    return row;
  }
  function rate(operation, tenant, account, source) {
    id(tenant); id(account); id(source);
    const allowed = db.transaction(now => {
      db.run('DELETE FROM rate_limits WHERE expires<=?', now);
      const counters = [
        { key: digest(['global', operation]), max: 120, window: MINUTE },
        { key: digest(['source', operation, source]), max: 30, window: MINUTE },
        { key: digest(['account', operation, tenant, account]), max: 8, window: 10 * MINUTE, progressive: true }
      ];
      // 全球桶先消耗，避免對多個未知帳號無限建立 counter。
      for (const counter of counters) {
        const row = db.get('SELECT * FROM rate_limits WHERE key=?', counter.key);
        if (row && (row.count >= counter.max || row.next_at > now)) return false;
        const count = (row?.count ?? 0) + 1;
        const next = now + (counter.progressive && count > 3 ? Math.min(30_000, 1000 * 2 ** (count - 4)) : 0);
        db.run(`INSERT INTO rate_limits VALUES (?,?,?,?) ON CONFLICT(key)
          DO UPDATE SET count=excluded.count,next_at=excluded.next_at`, counter.key, count,
        row?.expires ?? now + counter.window, next);
      }
      return true;
    });
    requireThat(allowed, 'AUTH_RATE_LIMIT');
  }
  function newSession(user, now) {
    const value = token();
    db.run('DELETE FROM sessions WHERE expires<=? OR last_seen<=?', now, now - 15 * MINUTE);
    // 每帳號保留最多八個 Session；舊 Session 與其意圖一起撤銷。
    const stale = db.all('SELECT hash FROM sessions WHERE user_id=? ORDER BY created DESC,hash LIMIT -1 OFFSET 7', user.id);
    for (const row of stale) db.run('DELETE FROM sessions WHERE hash=?', row.hash);
    db.run('INSERT INTO sessions VALUES (?,?,?,?,?,?)', tokenHash(value), user.id, user.epoch, now, now, now + 8 * 60 * MINUTE);
    return { sessionToken: value, expiresAt: now + 8 * 60 * MINUTE,
      principal: { schemaVersion: 'dungeonq.lab-principal/v1', tenantId: user.tenant, principalId: user.id,
        role: user.role, authentication: authentication(user.id), phishingResistant: false } };
  }
  function authentication(userId) {
    return db.get("SELECT user_id FROM factors WHERE user_id=? AND state='ACTIVE'", userId) ? 'PASSWORD_TOTP' : 'PASSWORD';
  }
  function verifyFactor(userId, code, now) {
    const factor = db.get("SELECT * FROM factors WHERE user_id=? AND state='ACTIVE'", userId);
    if (!factor) { requireThat(code === undefined, 'AUTH_FAILED'); return; }
    requireThat(vault, 'TOTP_KEY_REQUIRED');
    const step = matchOtp(vault.open(factor.sealed, userId), code, now, factor.last_step);
    requireThat(step !== null, 'AUTH_FAILED');
    db.run('UPDATE factors SET last_step=? WHERE user_id=?', step, userId);
  }
  function auditDenial(tenant, kind) {
    db.transaction(now => db.audit(now, tenant, kind, 'authentication'));
  }
  function authTransaction(tenant, kind, operation) {
    try { return db.transaction(operation); }
    catch (error) {
      if (['AUTH_FAILED', 'TOTP_ENROLLMENT_INVALID'].includes(error.code)) auditDenial(tenant, kind);
      throw error;
    }
  }
  function consumeIntent(session, intentToken, purpose, manifestDigest, now) {
    const intent = db.get('SELECT * FROM intents WHERE hash=?', tokenHash(intentToken));
    requireThat(intent && intent.session_hash === session.hash && intent.purpose === purpose
      && intent.manifest === manifestDigest && intent.expires > now, 'INTENT_INVALID');
    db.run('DELETE FROM intents WHERE hash=?', intent.hash);
  }
  function scope(draft) {
    for (const asset of draft.assetIds) requireThat(db.get('SELECT id FROM assets WHERE tenant=? AND id=?', draft.tenantId, asset), 'SCOPE_INVALID');
    requireThat(draft.dependencyDigest === digest({ tenantId: draft.tenantId, assetIds: draft.assetIds,
      connectorVersion: draft.connectorVersion }), 'DEPENDENCY_DRIFT');
  }
  function validGrant(grantId, tenant, now) {
    const row = db.get('SELECT * FROM grants WHERE id=? AND tenant=?', grantId, tenant);
    requireThat(row, 'GRANT_UNAVAILABLE');
    const grant = checkEnvelope({ body: JSON.parse(row.body), signature: row.signature });
    requireThat(grant.tenantId === tenant && grant.grantId === row.id && grant.ownerId === row.owner
      && grant.profile === 'SYNTHETIC_ONLY' && grant.expiresAt > now
      && grant.epoch === db.get('SELECT epoch FROM tenants WHERE id=?', tenant).epoch, 'GRANT_INACTIVE');
    scope(grant);
    return { row, grant };
  }
  function fenceTenant(tenant) {
    db.run('UPDATE tenants SET epoch=epoch+1 WHERE id=?', tenant);
    db.run("UPDATE outbox SET status='FENCED' WHERE job IN (SELECT id FROM jobs WHERE tenant=? AND state='CLAIMED')", tenant);
    db.run("UPDATE jobs SET state='FENCED' WHERE tenant=? AND state='CLAIMED'", tenant);
  }
  function memberState(user, now) {
    return user.disabled ? 'DISABLED' : user.setup_expires === null ? 'ACTIVE' : user.setup_expires <= now ? 'SETUP_EXPIRED' : 'SETUP_PENDING';
  }
  function memberTarget(session, draft) {
    requireThat(session.tenant === draft.tenantId, 'TENANT_DENIED');
    const target = db.get('SELECT * FROM users WHERE tenant=? AND username=?', session.tenant, draft.username);
    if (draft.action === 'CREATE') {
      requireThat(!target, 'MEMBER_EXISTS');
      requireThat(db.get('SELECT count(*) AS n FROM users WHERE tenant=?', session.tenant).n < 100, 'MEMBER_CAPACITY');
    } else {
      requireThat(target && MEMBER_ROLES.includes(target.role) && target.id !== session.user_id, 'MEMBER_UNAVAILABLE');
      requireThat(target.epoch === draft.expectedEpoch, 'MEMBER_STALE');
      requireThat(!target.disabled, 'MEMBER_UNAVAILABLE');
      if (draft.action === 'CHANGE_ROLE') requireThat(target.setup_expires === null && target.role !== draft.role, 'MEMBER_STATE');
      else requireThat(target.role === draft.role, 'MEMBER_STALE');
      if (draft.action === 'REISSUE_SETUP') requireThat(target.setup_expires !== null, 'MEMBER_STATE');
    }
    return target;
  }

  // 人類 API 共用同一發布實作；Response adapter 不取得 signer 或繞過 intent。
  function publishFor(session, draft, intentToken, now) {
    requireThat(session.tenant === draft.tenantId, 'TENANT_DENIED');
    requireThat(draft.expiresAt > now && draft.expiresAt <= now + 30 * DAY, 'GRANT_EXPIRY');
    scope(draft);
    consumeIntent(session, intentToken, 'PUBLISH_GRANT', digest(draft), now);
    const grant = envelope({ ...draft, schemaVersion: 'dungeonq.lab-grant/v1', grantId: randomUUID(),
      ownerId: session.user_id, epoch: db.get('SELECT epoch FROM tenants WHERE id=?', session.tenant).epoch,
      issuedAt: now, authentication: authentication(session.user_id), authorization: 'SINGLE_OWNER_AUTHORIZED', keyId });
    db.run('INSERT INTO grants(id,tenant,owner,body,signature) VALUES (?,?,?,?,?)', grant.body.grantId,
      session.tenant, session.user_id, canonicalJson(grant.body), grant.signature);
    db.audit(now, session.tenant, 'GRANT_PUBLISHED', session.user_id,
      { grantId: grant.body.grantId, manifestDigest: digest(draft) });
    return grant;
  }
  function responseRow(tenant, requestId) {
    id(requestId);
    const row = db.get('SELECT * FROM response_requests WHERE tenant=? AND id=?', tenant, requestId);
    requireThat(row, 'RESPONSE_UNAVAILABLE');
    const draft = grantDraft(JSON.parse(row.draft));
    requireThat(digest(draft) === row.digest && draft.tenantId === tenant
      && draft.assetIds.length === 1 && draft.assetIds[0] === row.asset, 'RESPONSE_INTEGRITY');
    return { ...row, draft };
  }
  function responseView(row, now) {
    let state = row.draft.expiresAt <= now ? 'EXPIRED' : 'AWAITING_HUMAN';
    if (row.grant_id) {
      try { validGrant(row.grant_id, row.tenant, now); state = 'APPROVED'; }
      catch (error) { if (!['GRANT_INACTIVE'].includes(error.code)) throw error; state = 'AUTHORIZATION_INACTIVE'; }
    }
    const job = db.get('SELECT id,state,receipt FROM jobs WHERE tenant=? AND worker=? AND event_id=? AND asset=?',
      row.tenant, row.worker, row.event_id, row.asset);
    if (job) state = job.state;
    const receipt = job?.receipt ? JSON.parse(job.receipt) : null;
    if (receipt) checkEnvelope(receipt);
    return { requestId: row.id, assetId: row.asset, eventId: row.event_id, expectedVersion: row.version,
      draft: row.draft, manifestDigest: row.digest, state, grantId: row.grant_id, jobId: job?.id ?? null, receipt };
  }

  const application = Object.freeze({
    async login(input, source) {
      exact(input, Object.hasOwn(input ?? {}, 'otp') ? ['tenantId', 'username', 'password', 'otp'] : ['tenantId', 'username', 'password']);
      input = { ...input };
      rate('login', input.tenantId, input.username, source);
      const user = db.get('SELECT * FROM users WHERE tenant=? AND username=?', input.tenantId, input.username);
      let good = false;
      try { good = await verifyPassword(input.password, user?.password ?? dummyPassword); }
      catch (error) { if (error.code !== 'PASSWORD_INVALID') throw error; }
      if (!user || user.disabled || user.setup_expires !== null || !good) { auditDenial(input.tenantId, 'LOGIN_REJECTED'); throw new GovernanceError('AUTH_FAILED'); }
      return authTransaction(input.tenantId, 'LOGIN_REJECTED', now => {
        const current = db.get('SELECT * FROM users WHERE id=?', user.id);
        requireThat(current && !current.disabled && current.setup_expires === null && current.epoch === user.epoch && current.password === user.password, 'AUTH_FAILED');
        verifyFactor(user.id, input.otp, now);
        db.audit(now, user.tenant, 'LOGIN_SUCCEEDED', user.id);
        return newSession(current, now);
      });
    },
    status(sessionToken) {
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'READ_STATUS');
        return { tenantId: session.tenant, principalId: session.user_id, role: session.role,
          capabilities: capabilities(session.role), authentication: authentication(session.user_id), totpAvailable: !!vault,
          profile: 'SYNTHETIC_ONLY', fidoRequired: false, serverNow: now,
          assets: db.all('SELECT id,version,state,last_job FROM assets WHERE tenant=? ORDER BY id', session.tenant),
          grants: db.all('SELECT id,used,body,signature FROM grants WHERE tenant=? ORDER BY id', session.tenant).map(row => {
            const body = checkEnvelope({ body: JSON.parse(row.body), signature: row.signature });
            const epoch = db.get('SELECT epoch FROM tenants WHERE id=?', session.tenant).epoch;
            return { id: row.id, used: row.used, assetIds: body.assetIds, expiresAt: body.expiresAt,
              maxEffects: body.maxEffects, state: body.epoch !== epoch ? 'REVOKED' : body.expiresAt <= now ? 'EXPIRED' : 'ACTIVE' };
          }) };
      });
    },
    logout(sessionToken) {
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'LOGOUT');
        db.run('DELETE FROM sessions WHERE hash=?', session.hash);
        db.audit(now, session.tenant, 'LOGOUT', session.user_id);
        return { loggedOut: true };
      });
    },
    previewGrant(sessionToken, input) {
      const draft = grantDraft(input);
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'PREVIEW_GRANT');
        requireThat(session.tenant === draft.tenantId, 'TENANT_DENIED');
        requireThat(draft.expiresAt > now && draft.expiresAt <= now + 30 * DAY, 'GRANT_EXPIRY');
        scope(draft);
        return { draft, digest: digest(draft), summary: { affectedAssets: draft.assetIds,
          action: '僅隔離本地合成目標', maximumEffects: draft.maxEffects, productionEffects: false } };
      });
    },
    async reauthenticate(sessionToken, input, source) {
      exact(input, Object.hasOwn(input ?? {}, 'otp') ? ['password', 'purpose', 'manifestDigest', 'otp'] : ['password', 'purpose', 'manifestDigest']);
      input = { ...input };
      requireThat(['PUBLISH_GRANT', 'REVOKE_GRANTS', 'RENEW_RECOVERY', 'MANAGE_MEMBERS', 'ENROLL_TOTP', 'REMOVE_TOTP'].includes(input.purpose)
        && typeof input.manifestDigest === 'string' && /^[a-f0-9]{64}$/u.test(input.manifestDigest), 'SCHEMA_INVALID');
      const initial = db.transaction(now => principal(sessionToken, now, input.purpose));
      rate('reauth', initial.tenant, initial.username, source);
      if (!await verifyPassword(input.password, initial.password)) {
        auditDenial(initial.tenant, 'REAUTH_REJECTED'); throw new GovernanceError('AUTH_FAILED');
      }
      return authTransaction(initial.tenant, 'REAUTH_REJECTED', now => {
        const session = principal(sessionToken, now, input.purpose);
        requireThat(session.epoch === initial.epoch, 'AUTH_REQUIRED');
        verifyFactor(session.user_id, input.otp, now);
        const value = token();
        db.run('DELETE FROM intents WHERE expires<=? OR session_hash=?', now, session.hash);
        db.run('INSERT INTO intents VALUES (?,?,?,?,?)', tokenHash(value), session.hash,
          input.purpose, input.manifestDigest, now + 5 * MINUTE);
        db.audit(now, session.tenant, 'INTENT_ISSUED', session.user_id,
          { purpose: input.purpose, manifestDigest: input.manifestDigest });
        return { intentToken: value, expiresAt: now + 5 * MINUTE };
      });
    },
    publishGrant(sessionToken, input, intentToken) {
      const draft = grantDraft(input);
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'PUBLISH_GRANT');
        return publishFor(session, draft, intentToken, now);
      });
    },
    responses(sessionToken) {
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'READ_STATUS');
        return db.all('SELECT id FROM response_requests WHERE tenant=? ORDER BY id LIMIT 100', session.tenant)
          .map(row => responseView(responseRow(session.tenant, row.id), now));
      });
    },
    approveResponse(sessionToken, input) {
      exact(input, ['requestId', 'manifestDigest', 'intentToken']);
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'PUBLISH_GRANT');
        const row = responseRow(session.tenant, input.requestId);
        requireThat(input.manifestDigest === row.digest, 'RESPONSE_CHANGED');
        requireThat(!row.grant_id, 'RESPONSE_ALREADY_APPROVED');
        const owner = db.get('SELECT * FROM workers WHERE id=? AND tenant=?', row.worker, row.tenant);
        requireThat(owner && !owner.revoked && owner.expires > now, 'WORKER_AUTH_REQUIRED');
        const asset = db.get('SELECT version,state FROM assets WHERE tenant=? AND id=?', row.tenant, row.asset);
        requireThat(asset.version === row.version && asset.state === 'ACTIVE', 'ASSET_CONFLICT');
        const grant = publishFor(session, row.draft, input.intentToken, now);
        db.run('UPDATE response_requests SET grant_id=? WHERE tenant=? AND id=?', grant.body.grantId, row.tenant, row.id);
        db.audit(now, row.tenant, 'RESPONSE_APPROVED', session.user_id, { requestId: row.id, manifestDigest: row.digest });
        return responseView(responseRow(row.tenant, row.id), now);
      });
    },
    revokeGrants(sessionToken, intentToken) {
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'REVOKE_GRANTS');
        consumeIntent(session, intentToken, 'REVOKE_GRANTS', digest({ tenantId: session.tenant, action: 'REVOKE_GRANTS' }), now);
        fenceTenant(session.tenant);
        db.audit(now, session.tenant, 'GRANTS_REVOKED', session.user_id);
        return { revoked: true };
      });
    },
    renewRecoveryCodes(sessionToken, intentToken) {
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'RENEW_RECOVERY');
        consumeIntent(session, intentToken, 'RENEW_RECOVERY', digest({ tenantId: session.tenant,
          principalId: session.user_id, action: 'RENEW_RECOVERY' }), now);
        db.run('DELETE FROM recovery WHERE user_id=?', session.user_id);
        const recoveryCodes = makeRecoveryCodes(session.user_id);
        db.audit(now, session.tenant, 'RECOVERY_CODES_REPLACED', session.user_id,
          { notification: 'NOT_CONFIGURED' });
        return { recoveryCodes, notification: 'NOT_CONFIGURED' };
      });
    },
    async recover(input, source) {
      exact(input, ['tenantId', 'username', 'recoveryCode', 'newPassword']);
      input = { ...input };
      rate('recovery', input.tenantId, input.username, source);
      let codeHash;
      try { codeHash = tokenHash(input.recoveryCode); } catch { throw new GovernanceError('RECOVERY_FAILED'); }
      passwordText(input.newPassword, true);
      // 成本有界且在驗證 code 前一致計算，避免帳號／code 時序枚舉。
      const replacement = await hashPassword(input.newPassword);
      const result = db.transaction(now => {
        const user = db.get('SELECT * FROM users WHERE tenant=? AND username=?', input.tenantId, input.username);
        if (!user || user.disabled || (user.setup_expires !== null && user.setup_expires <= now)
          || !db.get('SELECT hash FROM recovery WHERE hash=? AND user_id=?', codeHash, user.id)) {
          db.audit(now, input.tenantId, 'RECOVERY_REJECTED', 'authentication');
          return null;
        }
        db.run('DELETE FROM recovery WHERE user_id=?', user.id);
        db.run('DELETE FROM sessions WHERE user_id=?', user.id);
        db.run('UPDATE users SET password=?,epoch=epoch+1,setup_expires=NULL WHERE id=?', replacement, user.id);
        const factorRemoved = authentication(user.id) === 'PASSWORD_TOTP';
        db.run('DELETE FROM factors WHERE user_id=?', user.id);
        const grantsRevoked = capabilities(user.role).includes('PUBLISH_GRANT');
        if (grantsRevoked) fenceTenant(user.tenant);
        const recoveryCodes = makeRecoveryCodes(user.id);
        db.audit(now, user.tenant, user.setup_expires !== null ? 'MEMBER_ACTIVATED' : grantsRevoked ? 'ACCOUNT_RECOVERED_GRANTS_REVOKED' : 'ACCOUNT_RECOVERED', user.id,
          { notification: 'NOT_CONFIGURED', factorRemoved });
        return { recovered: true, recoveryCodes, grantsRevoked, factorRemoved, notification: 'NOT_CONFIGURED' };
      });
      requireThat(result, 'RECOVERY_FAILED');
      return result;
    },
    beginTotp(sessionToken, intentToken) {
      requireThat(vault, 'TOTP_KEY_REQUIRED');
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'ENROLL_TOTP');
        requireThat(authentication(session.user_id) === 'PASSWORD', 'TOTP_ALREADY_ENABLED');
        consumeIntent(session, intentToken, 'ENROLL_TOTP', digest({ tenantId: session.tenant,
          principalId: session.user_id, action: 'ENROLL_TOTP' }), now);
        const seed = randomBytes(20);
        db.run(`INSERT INTO factors VALUES (?,?,'PENDING',?,?,-1) ON CONFLICT(user_id)
          DO UPDATE SET sealed=excluded.sealed,state='PENDING',session_hash=excluded.session_hash,expires=excluded.expires,last_step=-1`,
        session.user_id, vault.seal(seed, session.user_id), session.hash, now + 5 * MINUTE);
        return { secret: base32(seed), algorithm: 'SHA1', digits: 6, period: 30, expiresAt: now + 5 * MINUTE };
      });
    },
    confirmTotp(sessionToken, input, source) {
      exact(input, ['otp']);
      const initial = db.transaction(now => principal(sessionToken, now, 'ENROLL_TOTP'));
      rate('totp', initial.tenant, initial.username, source);
      return authTransaction(initial.tenant, 'TOTP_CONFIRM_REJECTED', now => {
        const session = principal(sessionToken, now, 'ENROLL_TOTP');
        const factor = db.get('SELECT * FROM factors WHERE user_id=?', session.user_id);
        requireThat(factor && factor.state === 'PENDING' && factor.session_hash === session.hash && factor.expires > now, 'TOTP_ENROLLMENT_INVALID');
        const step = matchOtp(vault.open(factor.sealed, session.user_id), input.otp, now);
        requireThat(step !== null, 'AUTH_FAILED');
        db.run("UPDATE factors SET state='ACTIVE',last_step=?,session_hash=NULL,expires=0 WHERE user_id=?", step, session.user_id);
        db.run('UPDATE users SET epoch=epoch+1 WHERE id=?', session.user_id);
        db.run('DELETE FROM sessions WHERE user_id=?', session.user_id);
        db.audit(now, session.tenant, 'TOTP_ENABLED', session.user_id);
        return { enabled: true, loginRequired: true };
      });
    },
    removeTotp(sessionToken, intentToken) {
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'REMOVE_TOTP');
        requireThat(authentication(session.user_id) === 'PASSWORD_TOTP', 'TOTP_NOT_ENABLED');
        consumeIntent(session, intentToken, 'REMOVE_TOTP', digest({ tenantId: session.tenant,
          principalId: session.user_id, action: 'REMOVE_TOTP' }), now);
        db.run('DELETE FROM factors WHERE user_id=?', session.user_id);
        db.run('UPDATE users SET epoch=epoch+1 WHERE id=?', session.user_id);
        db.run('DELETE FROM sessions WHERE user_id=?', session.user_id);
        db.audit(now, session.tenant, 'TOTP_REMOVED', session.user_id);
        return { removed: true, loginRequired: true };
      });
    },
    notifications(sessionToken) {
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'MANAGE_MEMBERS');
        return db.all('SELECT id,status,attempts,next_at,receipt FROM notifications WHERE tenant=? ORDER BY id DESC LIMIT 100', session.tenant);
      });
    },
    members(sessionToken) {
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'MANAGE_MEMBERS');
        return db.all('SELECT id,username,role,epoch,disabled,setup_expires FROM users WHERE tenant=? ORDER BY username', session.tenant)
          .map(user => ({ principalId: user.id, username: user.username, role: user.role, epoch: user.epoch,
            state: memberState(user, now), setupExpiresAt: user.setup_expires }));
      });
    },
    previewMemberChange(sessionToken, input) {
      const draft = memberChange(input);
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'MANAGE_MEMBERS');
        const target = memberTarget(session, draft);
        return { draft, digest: digest(draft), before: target ? { role: target.role, epoch: target.epoch, state: memberState(target, now) } : null,
          summary: { tenantId: session.tenant, username: draft.username, action: draft.action, role: draft.role,
            revokesExistingAccess: draft.action !== 'CREATE', setupLifetimeMs: ['CREATE', 'REISSUE_SETUP'].includes(draft.action) ? DAY : null,
            changesTenantGrants: false, notification: 'NOT_CONFIGURED' } };
      });
    },
    async applyMemberChange(sessionToken, input, intentToken) {
      const draft = memberChange(input);
      // 在昂貴 Hash 前驗證身分／意圖，完成後再次交易核對，不能用等待時間換範圍。
      db.transaction(now => {
        const session = principal(sessionToken, now, 'MANAGE_MEMBERS'); memberTarget(session, draft);
        const intent = db.get('SELECT * FROM intents WHERE hash=?', tokenHash(intentToken));
        requireThat(intent && intent.session_hash === session.hash && intent.purpose === 'MANAGE_MEMBERS'
          && intent.manifest === digest(draft) && intent.expires > now, 'INTENT_INVALID');
      });
      const password = draft.action === 'CREATE' ? await hashPassword(token()) : null;
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'MANAGE_MEMBERS');
        const target = memberTarget(session, draft);
        consumeIntent(session, intentToken, 'MANAGE_MEMBERS', digest(draft), now);
        const userId = target?.id ?? randomUUID();
        let setupCode;
        if (draft.action === 'CREATE') {
          db.run('INSERT INTO users(id,tenant,username,password,role,setup_expires) VALUES (?,?,?,?,?,?)', userId,
            session.tenant, draft.username, password, draft.role, now + DAY);
        } else {
          db.run('DELETE FROM sessions WHERE user_id=?', userId);
          db.run('DELETE FROM recovery WHERE user_id=?', userId);
          db.run('UPDATE users SET epoch=epoch+1 WHERE id=?', userId);
          if (draft.action === 'CHANGE_ROLE') db.run('UPDATE users SET role=? WHERE id=?', draft.role, userId);
          if (draft.action === 'DISABLE') db.run('UPDATE users SET disabled=1 WHERE id=?', userId);
          if (draft.action === 'REISSUE_SETUP') db.run('UPDATE users SET setup_expires=? WHERE id=?', now + DAY, userId);
        }
        if (['CREATE', 'REISSUE_SETUP'].includes(draft.action)) {
          setupCode = token(); db.run('INSERT INTO recovery VALUES (?,?)', tokenHash(setupCode), userId);
        }
        db.audit(now, session.tenant, 'MEMBER_CHANGE_APPLIED', session.user_id, { targetId: userId,
          manifestDigest: digest(draft), action: draft.action, role: draft.role, notification: 'NOT_CONFIGURED' });
        const current = db.get('SELECT * FROM users WHERE id=?', userId);
        return { applied: true, username: draft.username, role: current.role, epoch: current.epoch, state: memberState(current, now),
          setupExpiresAt: current.setup_expires, ...(setupCode ? { setupCode } : {}), notification: 'NOT_CONFIGURED' };
      });
    },
    evidence(sessionToken) {
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'READ_EVIDENCE');
        db.verifyAudit();
        return { schemaVersion: 'dungeonq.lab-evidence/v1', profile: 'SYNTHETIC_ONLY',
          receipts: db.all("SELECT receipt FROM jobs WHERE tenant=? AND state='COMPLETED' ORDER BY id", session.tenant)
            .map(row => JSON.parse(row.receipt)),
          events: db.all('SELECT body,digest FROM audit ORDER BY seq').filter(row => JSON.parse(row.body).tenant === session.tenant)
            .map(row => ({ body: JSON.parse(row.body), digest: row.digest })) };
      });
    }
  });

  function makeRecoveryCodes(userId) {
    const codes = Array.from({ length: 8 }, token);
    for (const code of codes) db.run('INSERT INTO recovery VALUES (?,?)', tokenHash(code), userId);
    return codes;
  }
  const local = Object.freeze({
    // 僅可信部署組裝端的合成身分配置；不可從 HTTP／MCP 呼叫。
    async provisionMember(input) {
      exact(input, ['tenantId', 'username', 'password', 'role']); id(input.tenantId); id(input.username);
      requireThat(MEMBER_ROLES.includes(input.role), 'UNSUPPORTED_CAPABILITY');
      input = { ...input };
      requireThat(db.get('SELECT id FROM tenants WHERE id=?', input.tenantId), 'TENANT_DENIED');
      const password = await hashPassword(input.password);
      return db.transaction(now => {
        requireThat(db.get('SELECT count(*) AS n FROM users WHERE tenant=?', input.tenantId).n < 100, 'MEMBER_CAPACITY');
        requireThat(!db.get('SELECT id FROM users WHERE tenant=? AND username=?', input.tenantId, input.username), 'MEMBER_EXISTS');
        const userId = randomUUID();
        db.run('INSERT INTO users(id,tenant,username,password,role) VALUES (?,?,?,?,?)', userId,
          input.tenantId, input.username, password, input.role);
        const recoveryCodes = makeRecoveryCodes(userId);
        db.audit(now, input.tenantId, 'LOCAL_MEMBER_PROVISIONED', userId, { role: input.role });
        return { principalId: userId, recoveryCodes };
      });
    },
    disableMember(input) {
      exact(input, ['tenantId', 'username']); id(input.tenantId); id(input.username);
      return db.transaction(now => {
        const user = db.get('SELECT * FROM users WHERE tenant=? AND username=?', input.tenantId, input.username);
        requireThat(user && MEMBER_ROLES.includes(user.role), 'MEMBER_UNAVAILABLE');
        db.run('UPDATE users SET disabled=1,epoch=epoch+1 WHERE id=?', user.id);
        db.run('DELETE FROM sessions WHERE user_id=?', user.id);
        db.run('DELETE FROM recovery WHERE user_id=?', user.id);
        db.audit(now, input.tenantId, 'LOCAL_MEMBER_DISABLED', user.id);
        return { disabled: true };
      });
    },
    async bootstrap(input) {
      exact(input, ['tenantId', 'username', 'password', 'assetIds']);
      id(input.tenantId); id(input.username);
      requireThat(Array.isArray(input.assetIds) && input.assetIds.length > 0 && input.assetIds.length <= 100
        && new Set(input.assetIds).size === input.assetIds.length, 'SCOPE_INVALID');
      input.assetIds.forEach(id);
      input = { ...input, assetIds: [...input.assetIds] };
      requireThat(!db.get('SELECT id FROM tenants WHERE id=?', input.tenantId), 'BOOTSTRAP_CLOSED');
      const password = await hashPassword(input.password);
      return db.transaction(now => {
        requireThat(!db.get('SELECT id FROM tenants WHERE id=?', input.tenantId), 'BOOTSTRAP_CLOSED');
        const userId = randomUUID();
        db.run('INSERT INTO tenants(id) VALUES (?)', input.tenantId);
        db.run('INSERT INTO users(id,tenant,username,password) VALUES (?,?,?,?)', userId, input.tenantId, input.username, password);
        for (const asset of input.assetIds) db.run('INSERT INTO assets(tenant,id) VALUES (?,?)', input.tenantId, asset);
        const recoveryCodes = makeRecoveryCodes(userId);
        db.audit(now, input.tenantId, 'LOCAL_BOOTSTRAP', userId);
        return { tenantId: input.tenantId, recoveryCodes };
      });
    },
    provisionWorker(input) {
      exact(input, ['tenantId', 'workerId', 'expiresAt']); id(input.tenantId); id(input.workerId);
      integer(input.expiresAt, 0, Number.MAX_SAFE_INTEGER);
      return db.transaction(now => {
        requireThat(db.get('SELECT id FROM tenants WHERE id=?', input.tenantId), 'TENANT_DENIED');
        requireThat(input.expiresAt > now && input.expiresAt <= now + 30 * DAY, 'WORKER_EXPIRY');
        const value = token();
        db.run('INSERT INTO workers(hash,id,tenant,expires) VALUES (?,?,?,?)', tokenHash(value), input.workerId, input.tenantId, input.expiresAt);
        db.audit(now, input.tenantId, 'LOCAL_WORKER_PROVISIONED', input.workerId);
        return { workerToken: value };
      });
    },
    revokeWorker(workerId) {
      id(workerId);
      return db.transaction(now => {
        const current = db.get('SELECT * FROM workers WHERE id=?', workerId);
        requireThat(current, 'WORKER_AUTH_REQUIRED');
        db.run('UPDATE workers SET revoked=1 WHERE id=?', workerId);
        db.audit(now, current.tenant, 'LOCAL_WORKER_REVOKED', workerId);
      });
    },
    recordObservation(input) {
      exact(input, ['tenantId', 'eventId', 'assetId', 'version']);
      id(input.tenantId); id(input.eventId); id(input.assetId); integer(input.version, 0, 1_000_000);
      return db.transaction(now => {
        const asset = db.get('SELECT * FROM assets WHERE tenant=? AND id=?', input.tenantId, input.assetId);
        requireThat(asset && asset.version === input.version, 'OBSERVATION_SCOPE');
        const previous = db.get('SELECT * FROM observations WHERE tenant=? AND id=?', input.tenantId, input.eventId);
        if (previous) {
          requireThat(previous.asset === input.assetId && previous.version === input.version, 'EVENT_CONFLICT');
          return { recorded: true, replay: true };
        }
        db.run('INSERT INTO observations VALUES (?,?,?,?,?)', input.tenantId, input.eventId, input.assetId, input.version, now);
        db.audit(now, input.tenantId, 'LOCAL_SYNTHETIC_OBSERVATION', input.eventId);
        return { recorded: true, replay: false };
      });
    }
  });

  const execution = Object.freeze({
    inspect(workerToken) {
      return db.transaction(now => {
        const machine = worker(workerToken, now);
        return { profile: 'SYNTHETIC_ONLY', tenantId: machine.tenant, serverNow: now,
          assets: db.all('SELECT id,version,state FROM assets WHERE tenant=? ORDER BY id', machine.tenant),
          observations: db.all('SELECT id,asset,version,observed_at FROM observations WHERE tenant=? ORDER BY observed_at DESC LIMIT 20', machine.tenant),
          responses: db.all('SELECT id FROM response_requests WHERE tenant=? AND worker=? ORDER BY id LIMIT 100', machine.tenant, machine.id)
            .map(row => responseView(responseRow(machine.tenant, row.id), now)),
          verificationKey: { keyId, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) } };
      });
    },
    requestResponse(workerToken, input) {
      exact(input, ['requestId', 'eventId', 'assetId', 'expectedVersion']);
      id(input.requestId); id(input.eventId); id(input.assetId); integer(input.expectedVersion, 0, 1_000_000);
      return db.transaction(now => {
        const machine = worker(workerToken, now);
        const prior = db.get('SELECT id FROM response_requests WHERE tenant=? AND id=?', machine.tenant, input.requestId);
        if (prior) {
          const row = responseRow(machine.tenant, prior.id);
          requireThat(row.worker === machine.id && row.event_id === input.eventId && row.asset === input.assetId
            && row.version === input.expectedVersion, 'RESPONSE_CONFLICT');
          return responseView(row, now);
        }
        requireThat(db.get('SELECT count(*) AS n FROM response_requests WHERE tenant=?', machine.tenant).n < 100, 'RESPONSE_CAPACITY');
        const asset = db.get('SELECT version,state FROM assets WHERE tenant=? AND id=?', machine.tenant, input.assetId);
        requireThat(asset && asset.version === input.expectedVersion && asset.state === 'ACTIVE', 'ASSET_CONFLICT');
        const observed = db.get('SELECT * FROM observations WHERE tenant=? AND id=?', machine.tenant, input.eventId);
        requireThat(observed && observed.asset === input.assetId && observed.version === input.expectedVersion
          && observed.observed_at + 5 * MINUTE > now, 'OBSERVATION_UNAVAILABLE');
        const draft = grantDraft({ schemaVersion: 'dungeonq.lab-grant-draft/v1', tenantId: machine.tenant,
          profile: 'SYNTHETIC_ONLY', assetIds: [input.assetId], effect: 'SYNTHETIC_CONTAINMENT',
          connectorVersion: 'sqlite-fixture/v1', runbookVersion: 'containment/v1',
          dependencyDigest: digest({ tenantId: machine.tenant, assetIds: [input.assetId], connectorVersion: 'sqlite-fixture/v1' }),
          expiresAt: observed.observed_at + 5 * MINUTE, maxEffects: 1, maxConcurrent: 1, leaseMs: 60_000 });
        db.run('INSERT INTO response_requests VALUES (?,?,?,?,?,?,?,?,NULL)', input.requestId, machine.tenant,
          machine.id, input.eventId, input.assetId, input.expectedVersion, canonicalJson(draft), digest(draft));
        db.audit(now, machine.tenant, 'RESPONSE_REQUESTED', machine.id,
          { requestId: input.requestId, manifestDigest: digest(draft), effect: 'SYNTHETIC_CONTAINMENT' });
        return responseView(responseRow(machine.tenant, input.requestId), now);
      });
    },
    applyResponse(workerToken, requestId) {
      const row = db.transaction(now => {
        const machine = worker(workerToken, now);
        const row = responseRow(machine.tenant, requestId);
        requireThat(row.worker === machine.id, 'RESPONSE_UNAVAILABLE');
        requireThat(row.grant_id, 'HUMAN_APPROVAL_REQUIRED');
        return row;
      });
      // Claim/Apply 各自核對有效授權及 CAS；跨步驟 crash 由原 event/asset/version 重播找回。
      const claim = execution.claim(workerToken, { grantId: row.grant_id, eventId: row.event_id,
        assetId: row.asset, expectedVersion: row.version });
      return execution.apply(workerToken, claim.jobId);
    },
    claim(workerToken, input) {
      exact(input, ['grantId', 'eventId', 'assetId', 'expectedVersion']);
      requireThat(typeof input.grantId === 'string' && /^[a-f0-9-]{36}$/u.test(input.grantId), 'SCHEMA_INVALID');
      id(input.eventId); id(input.assetId); integer(input.expectedVersion, 0, 1_000_000);
      return db.transaction(now => {
        const machine = worker(workerToken, now);
        const { row, grant } = validGrant(input.grantId, machine.tenant, now);
        requireThat(grant.assetIds.includes(input.assetId), 'SCOPE_INVALID');
        const prior = db.get('SELECT * FROM jobs WHERE tenant=? AND asset=? AND version=?', machine.tenant, input.assetId, input.expectedVersion);
        if (prior) {
          requireThat(prior.grant_id === input.grantId && prior.event_id === input.eventId && prior.worker === machine.id, 'CLAIM_CONFLICT');
          return { jobId: prior.id, state: prior.state, replay: true };
        }
        const observation = db.get('SELECT * FROM observations WHERE tenant=? AND id=?', machine.tenant, input.eventId);
        requireThat(observation && observation.asset === input.assetId && observation.version === input.expectedVersion
          && observation.observed_at + 5 * MINUTE > now, 'OBSERVATION_UNAVAILABLE');
        const asset = db.get('SELECT * FROM assets WHERE tenant=? AND id=?', machine.tenant, input.assetId);
        requireThat(asset.version === input.expectedVersion && asset.state === 'ACTIVE', 'ASSET_CONFLICT');
        const concurrent = db.get("SELECT count(*) AS n FROM jobs WHERE grant_id=? AND state='CLAIMED'", row.id).n;
        requireThat(row.used < grant.maxEffects && concurrent < grant.maxConcurrent, 'BUDGET_EXHAUSTED');
        const jobId = randomUUID();
        const lease = envelope({ schemaVersion: 'dungeonq.lab-effect-lease/v1', profile: 'SYNTHETIC_ONLY',
          jobId, tenantId: machine.tenant, workerId: machine.id, grantId: row.id, grantDigest: digest(grant),
          eventId: input.eventId, assetId: input.assetId, expectedVersion: input.expectedVersion,
          effect: grant.effect, epoch: grant.epoch, expiresAt: Math.min(now + grant.leaseMs, grant.expiresAt, machine.expires), keyId });
        db.run(`INSERT INTO jobs(id,tenant,grant_id,event_id,asset,version,worker,lease,signature,state)
          VALUES (?,?,?,?,?,?,?,?,?,'CLAIMED')`, jobId, machine.tenant, row.id, input.eventId, input.assetId,
        input.expectedVersion, machine.id, canonicalJson(lease.body), lease.signature);
        db.run('UPDATE grants SET used=used+1 WHERE id=?', row.id);
        db.run("INSERT INTO outbox VALUES (?,'PENDING')", jobId);
        db.audit(now, machine.tenant, 'EFFECT_CLAIMED', machine.id, { jobId, leaseDigest: digest(lease.body) });
        return { jobId, state: 'CLAIMED', replay: false };
      });
    },
    pending(workerToken) {
      return db.transaction(now => {
        const machine = worker(workerToken, now);
        return db.all("SELECT j.id,j.state FROM jobs j JOIN outbox o ON o.job=j.id WHERE j.tenant=? AND j.worker=? AND o.status='PENDING' ORDER BY j.id",
          machine.tenant, machine.id);
      });
    },
    apply(workerToken, jobId) {
      requireThat(typeof jobId === 'string' && /^[a-f0-9-]{36}$/u.test(jobId), 'SCHEMA_INVALID');
      return db.transaction(now => {
        const machine = worker(workerToken, now);
        const job = db.get('SELECT * FROM jobs WHERE id=? AND tenant=? AND worker=?', jobId, machine.tenant, machine.id);
        requireThat(job, 'JOB_UNAVAILABLE');
        if (job.state === 'COMPLETED') {
          const receipt = JSON.parse(job.receipt); checkEnvelope(receipt);
          return receipt;
        }
        requireThat(job.state === 'CLAIMED', 'JOB_FENCED');
        let lease;
        try {
          lease = checkEnvelope({ body: JSON.parse(job.lease), signature: job.signature });
          const { grant } = validGrant(job.grant_id, machine.tenant, now);
          requireThat(lease.jobId === job.id && lease.tenantId === machine.tenant && lease.workerId === machine.id
            && lease.assetId === job.asset && lease.expectedVersion === job.version && lease.eventId === job.event_id
            && lease.grantId === job.grant_id && lease.grantDigest === digest(grant)
            && lease.effect === 'SYNTHETIC_CONTAINMENT' && lease.profile === 'SYNTHETIC_ONLY'
            && lease.epoch === grant.epoch && lease.expiresAt > now, 'LEASE_INACTIVE');
          const asset = db.get('SELECT * FROM assets WHERE tenant=? AND id=?', machine.tenant, job.asset);
          requireThat(asset.version === job.version && asset.state === 'ACTIVE', 'ASSET_CONFLICT');
        } catch (error) {
          db.run("UPDATE jobs SET state='FENCED' WHERE id=?", jobId);
          db.run("UPDATE outbox SET status='FENCED' WHERE job=?", jobId);
          db.audit(now, machine.tenant, 'EFFECT_FENCED', machine.id, { jobId, reason: error.code ?? 'INVALID_RECORD' });
          return { state: 'FENCED', reason: error.code ?? 'INVALID_RECORD' };
        }
        // 僅 SQLite 合成接點：效果、讀回、Receipt、Outbox 在同一交易。
        // 外部 Provider 不得使用此處的單庫原子性宣稱。
        const result = db.run("UPDATE assets SET state='CONTAINED',version=version+1,last_job=? WHERE tenant=? AND id=? AND version=? AND state='ACTIVE'",
          jobId, machine.tenant, job.asset, job.version);
        requireThat(result.changes === 1, 'ASSET_CONFLICT');
        const after = db.get('SELECT version,state,last_job FROM assets WHERE tenant=? AND id=?', machine.tenant, job.asset);
        requireThat(after.version === job.version + 1 && after.state === 'CONTAINED' && after.last_job === jobId, 'READBACK_FAILED');
        const receipt = envelope({ schemaVersion: 'dungeonq.lab-effect-receipt/v1', profile: 'SYNTHETIC_ONLY',
          jobId, tenantId: machine.tenant, grantId: job.grant_id, leaseDigest: digest(lease),
          assetId: job.asset, before: { version: job.version, state: 'ACTIVE' }, after: { ...after },
          verifiedAt: now, state: 'COMPLETED', keyId });
        db.run("UPDATE jobs SET state='COMPLETED',receipt=? WHERE id=?", canonicalJson(receipt), jobId);
        db.run("UPDATE outbox SET status='DONE' WHERE job=?", jobId);
        db.audit(now, machine.tenant, 'EFFECT_VERIFIED', machine.id, { jobId, receiptDigest: digest(receipt.body) });
        return receipt;
      });
    }
  });
  return Object.freeze({ application, local, execution, notifications: notificationDispatcher(db), close: () => db.close() });
}

// 只需已釘選公鑰的獨立核驗器，不持有私鑰或資料庫。
export function verifyReceipt(receipt, publicKey, keyId) {
  try {
    exact(receipt, ['body', 'signature']);
    const body = receipt.body;
    exact(body, ['schemaVersion', 'profile', 'jobId', 'tenantId', 'grantId', 'leaseDigest',
      'assetId', 'before', 'after', 'verifiedAt', 'state', 'keyId']);
    exact(body.before, ['version', 'state']);
    exact(body.after, ['version', 'state', 'last_job']);
    id(body.tenantId); id(body.assetId); id(body.keyId);
    integer(body.before.version, 0, 1_000_000); integer(body.after.version, 1, 1_000_001);
    integer(body.verifiedAt, 0, Number.MAX_SAFE_INTEGER);
    requireThat(typeof body.jobId === 'string' && /^[a-f0-9-]{36}$/u.test(body.jobId)
      && typeof body.grantId === 'string' && /^[a-f0-9-]{36}$/u.test(body.grantId)
      && typeof body.leaseDigest === 'string' && /^[a-f0-9]{64}$/u.test(body.leaseDigest)
      && publicKey?.type === 'public' && publicKey.asymmetricKeyType === 'ed25519', 'RECEIPT_INVALID');
    requireThat(body.schemaVersion === 'dungeonq.lab-effect-receipt/v1' && body.profile === 'SYNTHETIC_ONLY'
      && body.keyId === keyId && body.state === 'COMPLETED' && body.before.state === 'ACTIVE'
      && body.after.state === 'CONTAINED' && body.after.version === body.before.version + 1
      && body.after.last_job === body.jobId && typeof receipt.signature === 'string'
      && receipt.signature.length === 86, 'RECEIPT_INVALID');
    return verify(null, bytes(body), publicKey, Buffer.from(receipt.signature, 'base64url'));
  } catch { return false; }
}
