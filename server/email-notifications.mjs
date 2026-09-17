import { randomUUID, randomInt, randomBytes, createHmac, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { GovernanceError, requireThat, exact, digest, canonicalJson, id } from './contracts.mjs';

const MINUTE = 60_000;
const MODES = ['LOCAL_EMAIL_CAPTURE', 'SMTP'];
const OWNER = 'TENANT_SUPER_ADMIN';
export function normalizeEmail(value) {
  requireThat(typeof value === 'string' && value.length <= 254 && !/[\r\n\x00-\x1f\x7f]/u.test(value), 'EMAIL_INVALID');
  const email = value.trim().toLowerCase();
  const [local, domain, extra] = email.split('@');
  requireThat(!extra && local && local.length <= 64 && domain && domain.length <= 253
    && /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/u.test(local)
    && domain.includes('.') && domain.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part)), 'EMAIL_INVALID');
  return email;
}
const masked = email => email ? `${email[0]}***@${email.split('@')[1]}` : null;

// 僅可信伺服器組裝端注入 transport／OAuth proof；Application 沒有自由寄信或提供者自稱入口。
export function createEmailNotifications({ db, factorKey, transport, principal, consumeIntent, rate, newSession, authentication }) {
  const mode = transport?.mode ?? 'NOT_CONFIGURED';
  requireThat(!transport || (MODES.includes(mode) && typeof transport.send === 'function'
    && (mode !== 'LOCAL_EMAIL_CAPTURE' || typeof transport.preview === 'function')), 'EMAIL_TRANSPORT_INVALID');
  requireThat(!transport || (Buffer.isBuffer(factorKey) && factorKey.length === 32), 'EMAIL_KEY_REQUIRED');
  const key = factorKey ? createHmac('sha256', factorKey).update('dungeonq.email-custody/v1').digest() : null;
  const hashEmail = email => { requireThat(key, 'EMAIL_KEY_REQUIRED'); return createHmac('sha256', key).update(`address\n${email}`).digest('hex'); };
  const codeHash = (challengeId, code) => createHmac('sha256', key).update(`verification\n${challengeId}\n${code}`).digest('hex');
  function seal(value, binding) {
    requireThat(key, 'EMAIL_KEY_REQUIRED');
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(binding));
    const payload = Buffer.concat([cipher.update(canonicalJson(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString('base64url');
  }
  function open(value, binding) {
    try {
      requireThat(key && typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value), 'EMAIL_CUSTODY_INVALID');
      const bytes = Buffer.from(value, 'base64url');
      requireThat(bytes.length > 28 && bytes.toString('base64url') === value, 'EMAIL_CUSTODY_INVALID');
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(binding)); cipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
    } catch { throw new GovernanceError('EMAIL_CUSTODY_INVALID'); }
  }
  function sealBinding(email, binding) {
    return seal({ email, userId: binding.user_id, tenant: binding.tenant, version: binding.version,
      userEpoch: binding.user_epoch, state: binding.state, method: binding.method, verifiedAt: binding.verified_at },
    `email-binding:${binding.user_id}:${binding.version}`);
  }
  function address(binding) {
    if (!binding?.sealed) return null;
    const value = open(binding.sealed, `email-binding:${binding.user_id}:${binding.version}`);
    requireThat(value.userId === binding.user_id && value.tenant === binding.tenant && value.version === binding.version
      && value.userEpoch === binding.user_epoch && value.state === binding.state && value.method === binding.method
      && value.verifiedAt === binding.verified_at && hashEmail(value.email) === binding.email_hash, 'EMAIL_BINDING_INTEGRITY');
    return value.email;
  }
  const modeEligible = binding => binding.method === mode || binding.method === 'OAUTH_VERIFIED';
  function activeOwner(user, binding) {
    return user && binding && user.role === OWNER && !user.disabled && user.setup_expires === null
      && user.tenant === binding.tenant && user.epoch === binding.user_epoch;
  }
  function eligible(binding, user) {
    return activeOwner(user, binding) && binding.state === 'VERIFIED' && modeEligible(binding);
  }
  function fence(userId) {
    db.run("UPDATE email_outbox SET status='FENCED',claim=NULL,deadline=NULL WHERE user_id=? AND status IN ('PENDING','RETRY')", userId);
    // 已呼叫外部傳送的結果可能尚未回來，撤銷不能宣稱已收回郵件。
    db.run("UPDATE email_outbox SET status='UNKNOWN',claim=NULL,deadline=NULL WHERE user_id=? AND status='SENDING'", userId);
    db.run("UPDATE email_challenges SET state='CANCELED' WHERE user_id=? AND state='PENDING'", userId);
  }
  function replaceBinding(user, email, method, now, verified = false) {
    const prior = db.get('SELECT * FROM email_bindings WHERE user_id=?', user.user_id ?? user.id);
    const userId = user.user_id ?? user.id;
    const conflict = db.get('SELECT user_id FROM email_bindings WHERE tenant=? AND email_hash=?', user.tenant, hashEmail(email));
    requireThat(!conflict || conflict.user_id === userId, 'EMAIL_UNAVAILABLE');
    fence(userId);
    const version = (prior?.version ?? 0) + 1;
    const next = { user_id: userId, tenant: user.tenant, version, user_epoch: user.user_epoch ?? user.epoch,
      state: verified ? 'VERIFIED' : 'PENDING', method, verified_at: verified ? now : null };
    db.run(`INSERT INTO email_bindings VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
      email_hash=excluded.email_hash,sealed=excluded.sealed,version=excluded.version,user_epoch=excluded.user_epoch,
      state=excluded.state,method=excluded.method,verified_at=excluded.verified_at`, userId, user.tenant, hashEmail(email),
    sealBinding(email, next), version, next.user_epoch, next.state, method, next.verified_at);
    return version;
  }
  function enqueue({ now, tenant, userId, version, userEpoch, eventId, challengeId = null, kind, email, text }) {
    const source = db.get('SELECT digest FROM audit WHERE seq=?', eventId);
    const messageId = randomUUID();
    const payload = { id: messageId, to: email, subject: kind === 'VERIFY_EMAIL' ? 'DungeonQ 信箱驗證' : 'DungeonQ 誘餌接觸通知', text,
      tenantId: tenant, userId, bindingVersion: version, eventId, auditDigest: source.digest, kind };
    db.run(`INSERT INTO email_outbox(id,tenant,user_id,binding_version,user_epoch,event_id,challenge_id,kind,mode,sealed,next_at,created)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, messageId, tenant, userId, version, userEpoch, eventId, challengeId, kind, mode,
    seal(payload, `email-outbox:${messageId}`), now, now);
  }
  db.setEmailEnqueuer(entry => {
    if (!transport) return;
    const bindings = db.all("SELECT * FROM email_bindings WHERE tenant=? AND state='VERIFIED'", entry.tenant);
    for (const binding of bindings) {
      const user = db.get('SELECT * FROM users WHERE id=?', binding.user_id);
      if (!eligible(binding, user)) continue;
      enqueue({ now: entry.now, tenant: entry.tenant, userId: user.id, version: binding.version,
        userEpoch: user.epoch, eventId: entry.sequence, kind: 'DECOY_CONTACT', email: address(binding),
        text: `DungeonQ 已記錄合成誘餌接觸。\n事件：${entry.sequence}\n租戶：${entry.tenant}\n事故：${entry.subject}\n稽核摘要：${digest(entry)}\n此通知不代表已辨識真實入侵者或完成防護。請登入管理台檢閱與核准。` });
    }
  });
  // 重啟／逾期 claim 的原寄送結果未知，永遠不以重新派送推測。
  function expireClaims(now) {
    db.run("UPDATE email_outbox SET status='UNKNOWN',claim=NULL,deadline=NULL WHERE status='SENDING' AND deadline<=?", now);
  }
  function jobEligible(row, now) {
    const binding = db.get('SELECT * FROM email_bindings WHERE user_id=?', row.user_id);
    const user = db.get('SELECT * FROM users WHERE id=?', row.user_id);
    if (!activeOwner(user, binding) || row.tenant !== binding.tenant || binding.version !== row.binding_version
      || row.user_epoch !== user.epoch || row.mode !== mode || !modeEligible(binding)) return false;
    if (row.kind === 'DECOY_CONTACT') return binding.state === 'VERIFIED';
    const challenge = db.get('SELECT * FROM email_challenges WHERE id=?', row.challenge_id);
    return binding.state === 'PENDING' && challenge?.state === 'PENDING' && challenge.expires > now
      && challenge.binding_version === binding.version && challenge.user_epoch === user.epoch;
  }
  function verifiedMessage(row) {
    const payload = open(row.sealed, `email-outbox:${row.id}`);
    const source = db.get('SELECT body,digest FROM audit WHERE seq=?', row.event_id);
    const event = source && JSON.parse(source.body);
    const binding = db.get('SELECT * FROM email_bindings WHERE user_id=?', row.user_id);
    requireThat(event && digest(event) === source.digest && payload.auditDigest === source.digest
      && event.sequence === row.event_id && event.tenant === row.tenant
      && event.kind === (row.kind === 'VERIFY_EMAIL' ? 'EMAIL_VERIFICATION_REQUESTED' : 'DECOY_CONTACT')
      && payload.id === row.id && payload.tenantId === row.tenant && payload.userId === row.user_id
      && payload.bindingVersion === row.binding_version && payload.eventId === row.event_id && payload.kind === row.kind
      && payload.to === address(binding) && normalizeEmail(payload.to) === payload.to, 'EMAIL_INTEGRITY');
    return { id: payload.id, to: payload.to, subject: payload.subject, text: payload.text };
  }
  function status(session, now) {
    expireClaims(now);
    const binding = db.get('SELECT * FROM email_bindings WHERE user_id=?', session.user_id);
    const user = db.get('SELECT * FROM users WHERE id=?', session.user_id);
    const email = binding?.state !== 'REMOVED' ? address(binding) : null;
    const valid = eligible(binding, user);
    const challenge = db.get("SELECT * FROM email_challenges WHERE user_id=? AND state='PENDING' AND expires>? ORDER BY expires DESC LIMIT 1", session.user_id, now);
    const pending = challenge && binding?.version === challenge.binding_version && challenge.user_epoch === user.epoch
      && challenge.mode === mode && challenge.session_hash === session.hash;
    const rows = db.all('SELECT * FROM email_outbox WHERE user_id=? AND tenant=? ORDER BY created DESC,rowid DESC LIMIT 50', session.user_id, session.tenant);
    const state = !binding || binding.state === 'REMOVED' ? 'UNBOUND'
      : !activeOwner(user, binding) || !modeEligible(binding) ? 'REVERIFICATION_REQUIRED'
        : binding.state === 'PENDING' ? 'PENDING' : binding.method === 'LOCAL_EMAIL_CAPTURE' ? 'SIMULATED_VERIFIED' : 'VERIFIED';
    return { schemaVersion: 'dungeonq.email-status/v1', mode, configured: !!transport,
      recipient: { email, maskedEmail: masked(email), state, version: binding?.version ?? 0,
        verifiedAt: binding?.verified_at ?? null, verificationMethod: binding?.method ?? null, loginAliasEnabled: !!valid },
      pendingChallenge: pending ? { challengeId: challenge.id, email, expiresAt: challenge.expires,
        attemptsRemaining: 5 - challenge.attempts, simulation: mode === 'LOCAL_EMAIL_CAPTURE' } : null,
      linkedIdentities: valid ? db.all('SELECT provider,mode,verified_at AS linkedAt FROM external_identities WHERE user_id=? AND binding_version=? AND user_epoch=?',
        session.user_id, binding.version, user.epoch) : [],
      deliveries: rows.map(row => ({ id: row.id, kind: row.kind, eventId: row.event_id, state: row.status,
        attempts: row.attempts, nextAttemptAt: ['PENDING', 'RETRY'].includes(row.status) ? row.next_at : null,
        providerMessageId: row.provider_message_id, createdAt: row.created,
        maskedRecipient: masked(open(row.sealed, `email-outbox:${row.id}`).to), mode: row.mode })),
      captureMessages: mode === 'LOCAL_EMAIL_CAPTURE' ? transport.preview(rows.filter(row => row.mode === mode).map(row => row.id)) : [],
      claimBoundary: mode === 'SMTP' ? 'SMTP_ACCEPTANCE_NOT_INBOX_DELIVERY' : mode === 'LOCAL_EMAIL_CAPTURE' ? 'LOCAL_SIMULATION_ONLY' : 'NOT_CONFIGURED' };
  }
  function socialInput(input, linking) {
    exact(input, linking ? ['provider', 'subject', 'email', 'mode', 'intentToken'] : ['provider', 'subject', 'email', 'mode']);
    requireThat(['google', 'github'].includes(input.provider) && ['REAL_VERIFIED', 'SIMULATED'].includes(input.mode)
      && typeof input.subject === 'string' && /^[A-Za-z0-9._:@/-]{1,255}$/u.test(input.subject), 'SOCIAL_IDENTITY_INVALID');
    requireThat(key, 'EMAIL_KEY_REQUIRED');
    return { ...input, email: normalizeEmail(input.email) };
  }
  const application = Object.freeze({
    emailStatus(sessionToken) { return db.transaction(now => status(principal(sessionToken, now, 'MANAGE_EMAIL'), now)); },
    beginEmailVerification(sessionToken, input, source) {
      exact(input, ['email', 'intentToken']);
      const email = normalizeEmail(input.email);
      requireThat(transport, 'EMAIL_NOT_CONFIGURED');
      const initial = db.transaction(now => principal(sessionToken, now, 'MANAGE_EMAIL'));
      rate('email-begin', initial.tenant, initial.username, source);
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'MANAGE_EMAIL');
        consumeIntent(session, input.intentToken, 'MANAGE_EMAIL', digest({ action: 'BIND_EMAIL', email }), now);
        const counterKey = digest(['email-verification', session.user_id]);
        const counter = db.get('SELECT * FROM rate_limits WHERE key=? AND expires>?', counterKey, now);
        requireThat(!counter || counter.count < 3, 'EMAIL_RATE_LIMIT');
        db.run(`INSERT INTO rate_limits VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,expires=excluded.expires,next_at=excluded.next_at`,
          counterKey, (counter?.count ?? 0) + 1, counter?.expires ?? now + 15 * MINUTE, now);
        const version = replaceBinding(session, email, mode, now);
        const challengeId = randomUUID(); const code = String(randomInt(1_000_000)).padStart(6, '0');
        db.run(`INSERT INTO email_challenges(id,user_id,tenant,session_hash,user_epoch,binding_version,code_hash,mode,expires,state)
          VALUES (?,?,?,?,?,?,?,?,?,'PENDING')`, challengeId, session.user_id, session.tenant, session.hash, session.user_epoch,
        version, codeHash(challengeId, code), mode, now + 10 * MINUTE);
        const eventId = db.audit(now, session.tenant, 'EMAIL_VERIFICATION_REQUESTED', session.user_id, { challengeId, mode });
        enqueue({ now, tenant: session.tenant, userId: session.user_id, version, userEpoch: session.user_epoch, eventId, challengeId,
          kind: 'VERIFY_EMAIL', email, text: `${mode === 'LOCAL_EMAIL_CAPTURE' ? '本機模擬驗證；不證明真實信箱所有權。\n' : ''}DungeonQ 信箱驗證碼：${code}\n十分鐘內有效，只可使用一次。請勿轉交此驗證碼。` });
        return { challengeId, email, expiresAt: now + 10 * MINUTE, simulation: mode === 'LOCAL_EMAIL_CAPTURE', state: 'PENDING' };
      });
    },
    confirmEmailVerification(sessionToken, input, source) {
      exact(input, ['challengeId', 'code']);
      requireThat(typeof input.challengeId === 'string' && /^[a-f0-9-]{36}$/u.test(input.challengeId), 'EMAIL_CHALLENGE_INVALID');
      const initial = db.transaction(now => principal(sessionToken, now, 'MANAGE_EMAIL'));
      rate('email-confirm', initial.tenant, initial.username, source);
      const result = db.transaction(now => {
        const session = principal(sessionToken, now, 'MANAGE_EMAIL');
        const challenge = db.get('SELECT * FROM email_challenges WHERE id=? AND user_id=? AND tenant=?', input.challengeId, session.user_id, session.tenant);
        const binding = db.get('SELECT * FROM email_bindings WHERE user_id=?', session.user_id);
        requireThat(challenge && challenge.session_hash === session.hash && challenge.user_epoch === session.user_epoch
          && challenge.binding_version === binding?.version && binding.state === 'PENDING'
          && challenge.mode === mode && challenge.expires > now, 'EMAIL_CHALLENGE_INVALID');
        requireThat(challenge.state !== 'LOCKED', 'EMAIL_VERIFICATION_LOCKED');
        requireThat(challenge.state === 'PENDING', 'EMAIL_CHALLENGE_INVALID');
        const good = typeof input.code === 'string' && /^\d{6}$/u.test(input.code)
          && timingSafeEqual(Buffer.from(codeHash(challenge.id, input.code)), Buffer.from(challenge.code_hash));
        if (!good) {
          const attempts = challenge.attempts + 1;
          db.run('UPDATE email_challenges SET attempts=?,state=? WHERE id=?', attempts, attempts >= 5 ? 'LOCKED' : 'PENDING', challenge.id);
          db.audit(now, session.tenant, 'EMAIL_VERIFICATION_REJECTED', session.user_id, { challengeId: challenge.id, attempts });
          return { error: attempts >= 5 ? 'EMAIL_VERIFICATION_LOCKED' : 'EMAIL_CODE_INVALID' };
        }
        db.run("UPDATE email_challenges SET state='CONFIRMED' WHERE id=?", challenge.id);
        const email = address(binding);
        db.run("UPDATE email_bindings SET state='VERIFIED',verified_at=?,sealed=? WHERE user_id=?", now,
          sealBinding(email, { ...binding, state: 'VERIFIED', verified_at: now }), session.user_id);
        db.run("UPDATE email_outbox SET status='FENCED' WHERE challenge_id=? AND status IN ('PENDING','RETRY')", challenge.id);
        db.audit(now, session.tenant, 'EMAIL_VERIFIED', session.user_id, { version: binding.version, verificationMethod: mode, simulation: mode === 'LOCAL_EMAIL_CAPTURE' });
        return { verified: true, simulation: mode === 'LOCAL_EMAIL_CAPTURE', email, verificationMethod: mode,
          state: mode === 'LOCAL_EMAIL_CAPTURE' ? 'SIMULATED_VERIFIED' : 'VERIFIED' };
      });
      if (result.error) throw new GovernanceError(result.error);
      return result;
    },
    removeEmailBinding(sessionToken, input) {
      exact(input, ['intentToken']);
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'MANAGE_EMAIL');
        consumeIntent(session, input.intentToken, 'MANAGE_EMAIL', digest({ action: 'REMOVE_EMAIL' }), now);
        fence(session.user_id);
        db.run("UPDATE email_bindings SET state='REMOVED',email_hash=NULL,sealed=NULL,version=version+1,verified_at=NULL WHERE user_id=?", session.user_id);
        db.audit(now, session.tenant, 'EMAIL_REMOVED', session.user_id);
        return { removed: true };
      });
    }
  });
  const local = Object.freeze({
    linkExternalIdentity(sessionToken, input) {
      const proof = socialInput(input, true);
      return db.transaction(now => {
        const session = principal(sessionToken, now, 'MANAGE_EMAIL');
        consumeIntent(session, proof.intentToken, 'MANAGE_EMAIL', digest({ action: 'LINK_IDENTITY', provider: proof.provider }), now);
        const identity = db.get('SELECT * FROM external_identities WHERE provider=? AND subject=?', proof.provider, proof.subject);
        const priorProvider = db.get('SELECT * FROM external_identities WHERE user_id=? AND provider=?', session.user_id, proof.provider);
        requireThat((!identity || identity.user_id === session.user_id && identity.mode === proof.mode)
          && (!priorProvider || priorProvider.subject === proof.subject && priorProvider.mode === proof.mode), 'SOCIAL_IDENTITY_CONFLICT');
        const version = replaceBinding(session, proof.email, proof.mode === 'REAL_VERIFIED' ? 'OAUTH_VERIFIED' : 'LOCAL_EMAIL_CAPTURE', now, true);
        db.run(`INSERT INTO external_identities VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(provider,subject) DO UPDATE SET
          email_hash=excluded.email_hash,binding_version=excluded.binding_version,user_epoch=excluded.user_epoch,verified_at=excluded.verified_at`,
        proof.provider, proof.subject, session.user_id, hashEmail(proof.email), proof.mode, version, session.user_epoch, now);
        db.audit(now, session.tenant, 'SOCIAL_IDENTITY_LINKED', session.user_id, { provider: proof.provider, mode: proof.mode, version });
        return { linked: true, provider: proof.provider, email: proof.email, simulation: proof.mode === 'SIMULATED' };
      });
    },
    async loginExternalIdentity(input) {
      const proof = socialInput(input, false);
      return db.transaction(now => {
        const identity = db.get('SELECT * FROM external_identities WHERE provider=? AND subject=? AND mode=?', proof.provider, proof.subject, proof.mode);
        const user = identity && db.get('SELECT * FROM users WHERE id=?', identity.user_id);
        const binding = identity && db.get('SELECT * FROM email_bindings WHERE user_id=?', identity.user_id);
        requireThat(identity && activeOwner(user, binding) && binding.state === 'VERIFIED'
          && binding.version === identity.binding_version && user.epoch === identity.user_epoch
          && identity.email_hash === hashEmail(proof.email) && identity.email_hash === binding.email_hash && address(binding) === proof.email
          && binding.method === (proof.mode === 'REAL_VERIFIED' ? 'OAUTH_VERIFIED' : 'LOCAL_EMAIL_CAPTURE')
          && (proof.mode === 'REAL_VERIFIED' || mode === 'LOCAL_EMAIL_CAPTURE'), 'SOCIAL_IDENTITY_UNAVAILABLE');
        requireThat(authentication(user.id) !== 'PASSWORD_TOTP', 'SOCIAL_TOTP_STEP_UP_REQUIRED');
        db.audit(now, user.tenant, 'SOCIAL_LOGIN_SUCCEEDED', user.id, { provider: proof.provider, mode: proof.mode });
        return newSession(user, now);
      });
    }
  });
  const dispatcher = Object.freeze({
    async dispatch({ timeoutMs = 2000 } = {}) {
      requireThat(Number.isInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 5000, 'SCHEMA_INVALID');
      if (!transport) return { state: 'IDLE', mode };
      const job = db.transaction(now => {
        expireClaims(now);
        for (const row of db.all("SELECT * FROM email_outbox WHERE status IN ('PENDING','RETRY') ORDER BY created,id LIMIT 100")) {
          if (!jobEligible(row, now)) db.run("UPDATE email_outbox SET status='FENCED' WHERE id=?", row.id);
        }
        const row = db.get("SELECT * FROM email_outbox WHERE status IN ('PENDING','RETRY') AND next_at<=? ORDER BY created,id LIMIT 1", now);
        if (!row) return null;
        if (!jobEligible(row, now)) { db.run("UPDATE email_outbox SET status='FENCED' WHERE id=?", row.id); return null; }
        const message = verifiedMessage(row); const claim = randomUUID();
        db.run("UPDATE email_outbox SET status='SENDING',claim=?,deadline=?,attempts=attempts+1 WHERE id=?", claim, now + timeoutMs + 1000, row.id);
        return { ...row, claim, message, attempts: row.attempts + 1 };
      });
      if (!job) return { state: 'IDLE', mode };
      let outcome = 'UNKNOWN'; let providerMessageId = null; let timer;
      try {
        // send 在 claim 交易結束後立即呼叫；從不跨 await 持有 SQLite 交易。
        const sending = transport.send(Object.freeze(job.message));
        const result = await Promise.race([sending, new Promise(resolve => { timer = setTimeout(() => resolve({ state: 'UNKNOWN' }), timeoutMs); })]);
        if (result?.state === 'ACCEPTED' && typeof result.providerMessageId === 'string'
          && /^[\x21-\x7e]{1,255}$/u.test(result.providerMessageId)) { outcome = 'ACCEPTED'; providerMessageId = result.providerMessageId; }
        else if (['RETRY', 'FAILED', 'UNKNOWN'].includes(result?.state)) outcome = result.state;
      } catch { /* Provider 錯誤可能含機密；結果未知，不保存或重寄。 */ }
      finally { clearTimeout(timer); }
      return db.transaction(now => {
        const current = db.get('SELECT * FROM email_outbox WHERE id=?', job.id);
        if (current.status !== 'SENDING' || current.claim !== job.claim) return { id: job.id, state: current.status, attempts: current.attempts, mode };
        if (outcome === 'RETRY' && job.attempts >= 5) outcome = 'FAILED';
        if (outcome === 'RETRY' && !jobEligible(current, now)) outcome = 'FENCED';
        db.run('UPDATE email_outbox SET status=?,next_at=?,claim=NULL,deadline=NULL,provider_message_id=? WHERE id=?',
          outcome, now + Math.min(60_000, 1000 * 2 ** job.attempts), providerMessageId, job.id);
        db.audit(now, job.tenant, 'EMAIL_DISPATCH_RESULT', job.user_id, { messageId: job.id, eventId: job.event_id, state: outcome, attempts: job.attempts, mode });
        return { id: job.id, state: outcome, attempts: job.attempts, mode };
      });
    }
  });
  return Object.freeze({ application, local, dispatcher,
    loginUser(tenant, email) {
      id(tenant);
      if (!key) return undefined;
      const binding = db.get("SELECT * FROM email_bindings WHERE tenant=? AND email_hash=? AND state='VERIFIED'", tenant, hashEmail(email));
      const user = binding && db.get('SELECT * FROM users WHERE id=?', binding.user_id);
      return eligible(binding, user) && address(binding) === email ? user : undefined;
    }
  });
}
