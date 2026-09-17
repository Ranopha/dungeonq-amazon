import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openDefenseLab } from './defense-lab.mjs';
import { defenseOwnerClient } from './defense-acceptance.mjs';
import { digest } from './contracts.mjs';

// Scripted fixture roles, real local HTTPS and durable capture. No external mailbox.
export async function runEmailAcceptance({ directory }) {
  const report = { schemaVersion: 'dungeonq.email-proof/v1', profile: 'SYNTHETIC_ONLY', createdAt: new Date().toISOString(),
    participantMode: 'SCRIPTED_FIXTURE', verificationMode: 'LOCAL_EMAIL_CAPTURE', externalEmailSent: false,
    liveOAuthProviderUsed: false, inboxDeliveryProven: false, paidProviderApiCalls: 0,
    claim: 'RECORDED_EMAIL_ENGINEERING_NOT_EXTERNAL_DELIVERY_OR_COGNITIVE_EFFICACY', checks: [], sourceDigests: {}, passed: false };
  const mark = id => report.checks.push({ id, passed: true });
  let lab; let password;
  try {
    lab = await openDefenseLab({ directory, presentation: 'orders-workspace/v1' }); password = lab.password;
    assert.ok(password, 'A new private installation is required');
    let owner = defenseOwnerClient(lab);
    assert.equal((await owner.call('/api/email/status')).status, 401);
    const providers = (await owner.call('/api/identity/providers')).json;
    assert.ok(providers.providers.every(provider => provider.enabled === false));
    mark('EMAIL_STATUS_REQUIRES_LOGIN_AND_UNCONFIGURED_PROVIDERS_DISABLED');
    assert.equal((await owner.login(password)).status, 200);
    const email = 'owner@example.test';
    let status = (await owner.call('/api/email/status')).json;
    assert.equal(status.mode, 'LOCAL_EMAIL_CAPTURE'); assert.equal(status.recipient.state, 'UNBOUND');
    mark('DEFAULT_CAPTURE_EXPLICITLY_SIMULATED_NO_RECIPIENT');
    const intent = await owner.post('/api/intents', { password, purpose: 'MANAGE_EMAIL', manifestDigest: digest({ action: 'BIND_EMAIL', email }) });
    assert.equal(intent.status, 200);
    const started = await owner.post('/api/email/begin', { email, intentToken: intent.json.intentToken });
    assert.equal(started.status, 200); assert.equal(started.json.simulation, true);
    assert.equal((await owner.post('/api/email/confirm', { challengeId: started.json.challengeId, code: '000000', email: 'other@example.test' })).json.error, 'SCHEMA_INVALID');
    mark('BIND_REQUIRES_EXACT_FRESH_INTENT_AND_RECIPIENT_OVERRIDE_REJECTED');
    await lab.flushEmail();
    status = (await owner.call('/api/email/status')).json;
    const verification = status.captureMessages.find(message => /\b\d{6}\b/u.test(message.text));
    assert.ok(verification); const code = verification.text.match(/\b\d{6}\b/u)[0];
    const confirmed = await owner.post('/api/email/confirm', { challengeId: started.json.challengeId, code });
    assert.equal(confirmed.status, 200); assert.equal(confirmed.json.state, 'SIMULATED_VERIFIED');
    assert.notEqual((await owner.post('/api/email/confirm', { challengeId: started.json.challengeId, code })).status, 200);
    mark('SINGLE_USE_CODE_CONFIRMS_ONLY_SIMULATED_BINDING');
    await owner.post('/api/logout', {});
    assert.equal((await owner.post('/api/login', { tenantId: 'tenant-lab', username: email, password })).status, 200);
    mark('VERIFIED_EMAIL_ALIAS_AUTHENTICATES_WITH_EXISTING_PASSWORD');
    const contact = await fetch(`${lab.world.actorUrl}/api/world`, { headers: { Authorization: `Bearer ${lab.world.actorToken}` }, signal: AbortSignal.timeout(5000) });
    assert.equal(contact.status, 200);
    await lab.flushNotifications(); await lab.flushEmail();
    status = (await owner.call('/api/email/status')).json;
    const notice = status.deliveries.find(item => item.kind === 'DECOY_CONTACT');
    assert.ok(notice); assert.equal(notice.state, 'ACCEPTED');
    const message = status.captureMessages.find(item => item.id === notice.id);
    assert.ok(message); assert.equal(message.to, email);
    const defense = (await owner.call('/api/defense/status')).json;
    const incident = defense.governance.incidents[0];
    assert.equal(notice.eventId, incident.notification.eventId); assert.equal(incident.notification.state, 'DELIVERED');
    assert.ok(message.text.includes(incident.incidentId) || message.text.includes(String(notice.eventId)));
    assert.ok(!message.text.includes(password) && !message.text.includes(lab.world.actorToken));
    mark('SAME_INCIDENT_CAPTURE_ACCEPTED_FOR_VERIFIED_OWNER_WITH_NO_CREDENTIALS');
    assert.equal((await owner.post('/api/defense/apply', { requestId: lab.requestId })).json.error, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal(defense.lab.resource.generation, 0);
    mark('EMAIL_IS_NOT_APPROVAL_A_REMAINS_UNCHANGED');
    report.incident = { incidentId: incident.incidentId, eventId: notice.eventId, actorClassification: incident.actorClassification };
    report.recipient = { email, verification: 'SIMULATED_VERIFIED', loginAliasEnabled: true };
    report.message = { id: message.id, to: message.to, subject: message.subject, text: message.text,
      acceptedAt: message.acceptedAt, contentDigest: digest({ subject: message.subject, text: message.text }) };
    report.delivery = { ...notice };
    await lab.close();
    lab = await openDefenseLab({ directory, presentation: 'orders-workspace/v1' }); owner = defenseOwnerClient(lab);
    assert.equal((await owner.post('/api/login', { tenantId: 'tenant-lab', username: email, password })).status, 200);
    status = (await owner.call('/api/email/status')).json;
    assert.equal(status.deliveries.find(item => item.id === notice.id).state, 'ACCEPTED');
    assert.equal(status.captureMessages.find(item => item.id === notice.id).text, message.text);
    mark('RESTART_PRESERVES_BINDING_MESSAGE_AND_ACCEPTANCE');
    const removeIntent = await owner.post('/api/intents', { password, purpose: 'MANAGE_EMAIL', manifestDigest: digest({ action: 'REMOVE_EMAIL' }) });
    assert.equal(removeIntent.status, 200);
    assert.equal((await owner.post('/api/email/remove', { intentToken: removeIntent.json.intentToken })).status, 200);
    assert.equal((await owner.call('/api/email/status')).json.recipient.state, 'UNBOUND');
    await owner.post('/api/logout', {});
    assert.equal((await owner.post('/api/login', { tenantId: 'tenant-lab', username: email, password })).status, 401);
    assert.equal((await owner.login(password)).status, 200);
    mark('REMOVAL_REVOKES_EMAIL_ALIAS_WITH_LOCAL_ACCOUNT_RECOVERY_PRESERVED');
    for (const name of ['server/email-acceptance.mjs', 'server/email-notifications.mjs', 'server/email-transport.mjs', 'server/social-oauth.mjs', 'server/governance.mjs', 'server/store.mjs', 'server/workbench.mjs', 'server/defense-lab.mjs']) {
      report.sourceDigests[name] = createHash('sha256').update(await readFile(new URL(`../${name}`, import.meta.url))).digest('hex');
    }
    report.passed = true; return { report };
  } finally { await lab?.close(); }
}
