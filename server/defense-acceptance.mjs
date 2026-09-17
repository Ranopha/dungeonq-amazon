import assert from 'node:assert/strict';
import https from 'node:https';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDefenseLab } from './defense-lab.mjs';
import { referenceClient } from './reference-transport.mjs';
import { replayWorld } from '../world/kernel.mjs';
import { digest } from './contracts.mjs';

// CA-verified local HTTPS browser-protocol client. It does not bypass TLS or attest human presence.
export function defenseOwnerClient(lab) {
  const jar = new Map();
  const call = (path, { method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = https.request(lab.web.origin + path, { method, ca: lab.tls.cert, rejectUnauthorized: true,
      headers: { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(method === 'POST' ? { Origin: lab.web.origin, 'Content-Type': 'application/json', 'X-DQ-CSRF': body?.__csrf ?? '' } : {}) } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        for (const value of response.headers['set-cookie'] ?? []) { const pair = value.split(';')[0]; const index = pair.indexOf('=');
          if (pair.slice(index + 1)) jar.set(pair.slice(0, index), pair.slice(index + 1)); else jar.delete(pair.slice(0, index)); }
        try { resolve({ status: response.statusCode, json: JSON.parse(text) }); } catch { reject(Error('OWNER_RESPONSE_INVALID')); }
      });
    });
    request.setTimeout(10_000, () => request.destroy(Error('OWNER_TIMEOUT'))); request.on('error', reject);
    // CSRF is a header, never part of the closed application body.
    if (payload !== undefined) { const clean = { ...body }; delete clean.__csrf; request.end(JSON.stringify(clean)); } else request.end();
  });
  const post = async (path, body) => { const context = await call('/api/context'); assert.equal(context.status, 200);
    return call(path, { method: 'POST', body: { ...body, __csrf: context.json.csrfToken } }); };
  return { call, post, login: password => post('/api/login', { tenantId: 'tenant-lab', username: 'owner-lab', password }) };
}

export async function runDefenseAcceptance({ directory }) {
  const report = { schemaVersion: 'dungeonq.defense-proof/v1', profile: 'SYNTHETIC_ONLY', createdAt: new Date().toISOString(),
    approvalMode: 'SCRIPTED_OWNER_CREDENTIAL_NOT_HUMAN_PRESENCE_PROOF', participantMode: 'SCRIPTED_FIXTURE',
    claim: 'INTEGRATED_DEFENSIVE_ENGINEERING_NOT_LLM_EFFICACY_OR_PRODUCTION_ISOLATION',
    paidProviderApiCalls: 0, externalTargetRequests: 0, checks: [], sourceDigests: {}, timeline: [], passed: false };
  const mark = (name, details = {}) => { report.checks.push({ id: name, passed: true, ...details }); report.timeline.push({ event: name, at: Date.now() }); };
  let lab; let client; let owner; let password; let envelope; let view; let lastResponse;
  const connect = async () => {
    client = new Client({ name: 'DungeonQ defense acceptance', version: '0.8.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(lab.world.mcpEndpoint), { protocolVersion: '2025-11-25',
      requestInit: { headers: { Authorization: `Bearer ${lab.world.mcpToken}` } } }));
  };
  const get = async (url, token) => { const result = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    assert.equal(result.status, 200); return result.json(); };
  const act = async () => {
    envelope = { requestId: randomUUID(), expectedRevision: view.revision, command: { type: 'choose', choiceId: view.choices[0].id } };
    lastResponse = await client.callTool({ name: 'dungeonq_world_act', arguments: envelope });
    assert.ok(!lastResponse.isError); view = lastResponse.structuredContent.view;
    assert.equal(view.lastObservation.outcome, 'SUCCESS'); return view;
  };
  try {
    lab = await openDefenseLab({ directory }); password = lab.password; assert.ok(password, 'Use a new private installation directory for this proof.');
    owner = defenseOwnerClient(lab); assert.equal((await owner.login(password)).status, 200);
    const initial = (await owner.call('/api/defense/status')).json;
    assert.equal(initial.governance.incidents.length, 0); assert.equal(initial.lab.resource.generation, 0);
    mark('NO_CONTACT_NO_INCIDENT_AND_A_GENERATION_ZERO');
    await connect();
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(item => item.name), ['dungeonq_world_view', 'dungeonq_world_act', 'dungeonq_local_artifact', 'dungeonq_local_artifact_read']);
    assert.ok(tools.every(item => item.outputSchema && item.inputSchema.additionalProperties === false));
    const blocked = await client.callTool({ name: 'dungeonq_approve_rotation', arguments: {} }); assert.equal(blocked.isError, true);
    mark('ACTOR_MCP_CLOSED_TOOLS_NO_APPROVAL_OR_ORIGIN_CONTROL');
    const firstView = await client.callTool({ name: 'dungeonq_world_view', arguments: {} });
    assert.ok(!firstView.isError, JSON.stringify(firstView)); view = firstView.structuredContent;
    await lab.flushNotifications();
    let status = (await owner.call('/api/defense/status')).json;
    for (let attempt = 0; attempt < 8 && status.governance.incidents[0]?.notification.state !== 'DELIVERED'; attempt++) {
      await lab.flushNotifications(); status = (await owner.call('/api/defense/status')).json;
    }
    assert.equal(status.governance.incidents.length, 1); const incident = status.governance.incidents[0];
    assert.equal(incident.incidentId, lab.incidentId); assert.equal(incident.actorClassification, 'UNDETERMINED');
    assert.equal(incident.notification.state, 'DELIVERED');
    assert.equal(lab.notificationReceipt(incident.notification.receipt).eventId, incident.notification.eventId);
    mark('SAME_INCIDENT_ALERT_DELIVERED_AND_INDEPENDENT_SINK_READBACK');
    const unapproved = await owner.post('/api/defense/apply', { requestId: lab.requestId });
    assert.equal(unapproved.json.error, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal((await owner.call('/api/defense/status')).json.lab.resource.generation, 0);
    mark('UNAPPROVED_APPLY_DENIED_A_UNCHANGED');
    assert.equal((await client.callTool({ name: 'dungeonq_local_artifact', arguments: {} })).isError, true);
    for (let index = 0; index < 3; index++) await act();
    assert.equal(view.receipts.length, 3); assert.match(view.room.id, /^mirror-c-/u);
    mark('THREE_PERSISTED_LOCAL_SUCCESSES_AND_B_TO_C_CONTINUITY');
    const artifact = (await client.callTool({ name: 'dungeonq_local_artifact', arguments: {} })).structuredContent;
    assert.match(artifact.credential, /^[A-Za-z0-9_-]{43}$/u);
    const local = await client.callTool({ name: 'dungeonq_local_artifact_read', arguments: { credential: artifact.credential } });
    assert.equal(local.structuredContent.recordId, 'synthetic-relay-record');
    const originCall = referenceClient({ origin: lab.origin, ca: lab.tls.cert });
    await assert.rejects(originCall('/business', artifact.credential), error => error.code === 'REMOTE_REJECTED' && error.remoteCode === 'KEY_REJECTED');
    mark('EARNED_DUNGEON_TOKEN_WORKS_LOCALLY_REJECTED_BY_A_AUTHORIZATION');
    let request = status.governance.requests[0];
    assert.equal(request.incidentId, incident.incidentId);
    const intent = await owner.post('/api/intents', { password, purpose: 'APPROVE_ROTATION', manifestDigest: request.manifestDigest });
    assert.equal(intent.status, 200);
    const bad = await owner.post('/api/defense/approve', { requestId: request.requestId, manifestDigest: '0'.repeat(64), intentToken: intent.json.intentToken });
    assert.equal(bad.json.error, 'ROTATION_CHANGED');
    const approved = await owner.post('/api/defense/approve', { requestId: request.requestId, manifestDigest: request.manifestDigest, intentToken: intent.json.intentToken });
    assert.equal(approved.status, 200); assert.equal(approved.json.state, 'APPROVED');
    mark('SEPARATE_OWNER_REAUTH_EXACT_DIGEST_APPROVAL_WRONG_DIGEST_DENIED');
    const applied = await owner.post('/api/defense/apply', { requestId: request.requestId });
    assert.equal(applied.status, 200); assert.equal(applied.json.state, 'COMPLETED');
    assert.deepEqual(applied.json.checks, { oldKeyDenied: true, newKeyBusiness: true, oldConsumerDenied: true, decoyKeyDenied: true });
    assert.equal(applied.json.receipt.generation, 1);
    mark('ACTUAL_TLS_ROTATION_ALL_FOUR_INDEPENDENT_READBACKS', { checks: applied.json.checks });
    const repeated = await owner.post('/api/defense/apply', { requestId: request.requestId });
    assert.equal(repeated.json.replay, true); assert.equal(repeated.json.permit, undefined);
    mark('COMPLETED_APPLY_REPLAY_HAS_NO_NEW_PERMIT_OR_GENERATION');
    for (let index = 0; index < 3; index++) await act();
    assert.equal(view.receipts.length, 6); assert.match(view.room.id, /^mirror-d-/u);
    const after = (await owner.call('/api/defense/status')).json;
    assert.equal(after.lab.resource.generation, 1); assert.equal(after.governance.incidents.length, 1);
    mark('DUNGEON_CONTINUES_C_TO_D_AFTER_A_PROTECTION_COMPLETES');
    const retry = await client.callTool({ name: 'dungeonq_world_act', arguments: envelope });
    assert.equal(retry.structuredContent.replayed, true); assert.deepEqual(retry.structuredContent.view, view);
    assert.deepEqual(await get(`${lab.world.actorUrl}/api/world`, lab.world.actorToken), view);
    mark('HTTP_MCP_PARITY_AND_WORLD_IDEMPOTENCY');
    let observed;
    for (let attempt = 0; attempt < 80; attempt++) {
      observed = await get(`${lab.world.observerUrl}/api/observer`, lab.world.observerToken);
      if (observed.verification?.eventCount === view.revision) break;
      await delay(25);
    }
    const worldEvidence = await get(`${lab.world.observerUrl}/api/evidence`, lab.world.observerToken);
    assert.equal(replayWorld(worldEvidence).valid, true); assert.equal(worldEvidence.events.length, view.revision);
    const altered = structuredClone(worldEvidence); altered.events[0].digest = '0'.repeat(64);
    assert.throws(() => replayWorld(altered));
    mark('SEPARATE_OBSERVER_CAUSAL_REPLAY_AND_TAMPER_REJECTION');
    const governanceEvidence = (await owner.call('/api/evidence')).json;
    report.incidentId = incident.incidentId; report.worldId = view.worldId;
    report.rotation = { requestId: request.requestId, manifest: request.manifest, manifestDigest: request.manifestDigest, receipt: applied.json.receipt,
      checks: applied.json.checks, approvalPresenceAttested: false };
    report.alert = incident.notification;
    report.evidence = { worldDigest: digest(worldEvidence), governanceDigest: digest(governanceEvidence) };
    await client.close(); client = undefined; await lab.close();
    lab = await openDefenseLab({ directory }); assert.equal(lab.password, undefined);
    owner = defenseOwnerClient(lab); assert.equal((await owner.login(password)).status, 200);
    const reopened = (await owner.call('/api/defense/status')).json;
    assert.equal(reopened.lab.resource.generation, 1); assert.equal(reopened.governance.requests[0].state, 'COMPLETED');
    assert.equal(reopened.governance.incidents[0].notification.state, 'DELIVERED');
    assert.deepEqual(lab.world.snapshot(), view);
    await connect(); await act(); assert.equal(view.receipts.length, 7);
    mark('RESTART_PRESERVES_WORLD_ALERT_APPROVAL_AND_NONREVIVING_CREDENTIAL_STATE');
    for (const name of ['server/defense-lab.mjs', 'server/defense-governance.mjs', 'server/governance.mjs', 'server/store.mjs',
      'server/reference-issuer.mjs', 'server/reference-transport.mjs', 'server/world-lab.mjs', 'server/world-mcp.mjs',
      'server/world-store.mjs', 'server/world-observer.mjs', 'server/workbench.mjs', 'world/defense-map.mjs', 'world/kernel.mjs',
      'server/defense-acceptance.mjs']) report.sourceDigests[name] = createHash('sha256').update(await readFile(new URL(`../${name}`, import.meta.url))).digest('hex');
    report.passed = true;
    return { report, worldEvidence, governanceEvidence };
  } finally { await client?.close(); await lab?.close(); }
}
