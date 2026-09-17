import { mkdtemp, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openGovernance } from './governance.mjs';
import { openReferenceIssuer } from './reference-issuer.mjs';
import { startReferenceTransport, referenceClient } from './reference-transport.mjs';
import { openLocalNotificationSink } from './local-notification-sink.mjs';
import { openEmailCapture, createSmtpEmailTransport } from './email-transport.mjs';
import { createSocialOAuth } from './social-oauth.mjs';
import { startWorldLab, localArtifactCredential } from './world-lab.mjs';
import { startWorkbench } from './workbench.mjs';
import { generateDefensePack } from '../world/defense-map.mjs';
import { generateOrdersPack } from '../world/orders-workspace.mjs';
import { exact, requireThat, token, tokenHash, digest, id } from './contracts.mjs';

const TENANT = 'tenant-lab';
const ASSET = 'api-orders';
const emptyChecks = () => ({ oldKeyDenied: false, newKeyBusiness: false, oldConsumerDenied: false, decoyKeyDenied: false });
const privatePem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });

// A fixed, self-hosted reference profile. No arbitrary endpoint, production secret,
// exploit, or shell can be supplied by a participant. The host itself remains trusted.
export async function openDefenseLab({ directory, seed = 42, depth = 4, webPort = 0, actorPort = 0, mcpPort = 0,
  createTransport = startReferenceTransport, presentation = 'disclosed/v1', emailConfig, identityConfig }) {
  requireThat(typeof createTransport === 'function', 'TRANSPORT_FACTORY_INVALID');
  requireThat(['disclosed/v1', 'orders-workspace/v1'].includes(presentation), 'PRESENTATION_INVALID');
  const pack = presentation === 'orders-workspace/v1' ? generateOrdersPack({ seed, depth }) : generateDefensePack({ seed, depth });
  const target = directory ?? await mkdtemp(join(tmpdir(), 'dungeonq-defense-'));
  requireThat(isAbsolute(target), 'STORAGE_PATH_INVALID');
  const info = await lstat(target);
  requireThat(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'STORAGE_NOT_PRIVATE');
  const statePath = join(target, 'defense-installation.json');
  let saved; let created = false; let password; let core; let issuer; let transport; let sink; let world; let web; let emailTransport; let identity;
  let timer; let dispatching; let emailDispatching; let pending; let closed = false; let resource = { assetId: ASSET, generation: null, readbackAt: null };
  let contactRecorded = false;
  try {
    const stateInfo = await lstat(statePath);
    requireThat(stateInfo.isFile() && !stateInfo.isSymbolicLink() && stateInfo.nlink === 1
      && (stateInfo.mode & 0o077) === 0 && stateInfo.size <= 32_768, 'STORAGE_NOT_PRIVATE');
    saved = JSON.parse(await readFile(statePath, 'utf8'));
    exact(saved, ['version', 'profile', 'seed', 'depth', 'packDigest', 'privateKey', 'rotationPrivateKey',
      'factorKey', 'custodyKey', 'brokerToken', 'workerToken', 'consumers', 'oldKey', 'incidentId', 'requestId',
      ...(saved.version === 2 ? ['presentation'] : [])]);
    requireThat([1, 2].includes(saved.version) && (saved.presentation ?? 'disclosed/v1') === presentation
      && saved.profile === 'SYNTHETIC_ONLY' && saved.seed === seed
      && saved.depth === depth && saved.packDigest === digest(pack), 'INSTANCE_MISMATCH');
    exact(saved.consumers, ['old-consumer', 'clean-consumer']);
    for (const value of [saved.brokerToken, saved.workerToken, saved.oldKey, ...Object.values(saved.consumers)]) tokenHash(value);
    id(saved.incidentId); id(saved.requestId);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    requireThat((await readdir(target)).length === 0, 'INSTANCE_INCOMPLETE');
    created = true;
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30',
      '-keyout', join(target, 'tls-key.pem'), '-out', join(target, 'tls-cert.pem'), '-subj', '/CN=DungeonQ Defense Reference',
      '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore', timeout: 15_000 });
    saved = { version: 2, profile: 'SYNTHETIC_ONLY', presentation, seed, depth, packDigest: digest(pack),
      privateKey: privatePem(), rotationPrivateKey: privatePem(), factorKey: randomBytes(32).toString('base64url'),
      custodyKey: randomBytes(32).toString('base64url'), brokerToken: token(), workerToken: '', consumers: {}, oldKey: '',
      incidentId: `incident-${randomBytes(8).toString('hex')}`, requestId: `rotation-${randomBytes(8).toString('hex')}` };
  }
  async function close() {
    if (closed) return; closed = true; clearInterval(timer);
    await web?.close(); await world?.close(); await pending?.catch(() => {}); await dispatching?.catch(() => {}); await emailDispatching?.catch(() => {});
    await transport?.close(); identity?.close(); emailTransport?.close(); sink?.close(); issuer?.close(); core?.close();
  }
  try {
    const tls = { key: await readFile(join(target, 'tls-key.pem')), cert: await readFile(join(target, 'tls-cert.pem')) };
    const rotationKey = createPrivateKey(saved.rotationPrivateKey);
    emailTransport = emailConfig ? createSmtpEmailTransport(emailConfig)
      : openEmailCapture({ path: join(target, 'email-capture.sqlite'), key: Buffer.from(saved.factorKey, 'base64url') });
    core = await openGovernance({ path: join(target, 'governance.sqlite'), privateKey: createPrivateKey(saved.privateKey),
      keyId: 'defense-local-lab', factorKey: Buffer.from(saved.factorKey, 'base64url'), rotationPrivateKey: rotationKey, emailTransport });
    issuer = openReferenceIssuer({ path: join(target, 'origin.sqlite'), custodyKey: Buffer.from(saved.custodyKey, 'base64url'),
      authorizationPublicKey: createPublicKey(rotationKey) });
    sink = openLocalNotificationSink({ path: join(target, 'notification-sink.sqlite'), tenantId: TENANT });
    if (created) {
      password = token();
      await core.local.bootstrap({ tenantId: TENANT, username: 'owner-lab', password, assetIds: [ASSET] });
      saved.workerToken = core.local.provisionWorker({ tenantId: TENANT, workerId: 'defense-worker', expiresAt: Date.now() + 30 * 86_400_000 }).workerToken;
      saved.consumers = issuer.bootstrap({ tenantId: TENANT, assetId: ASSET, consumers: ['old-consumer', 'clean-consumer'] });
      saved.oldKey = issuer.acquire(saved.consumers['old-consumer'], ASSET);
      await writeFile(statePath, JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
    }
    core.execution.inspect(saved.workerToken);
    core.local.registerRotationTarget({ tenantId: TENANT, assetId: ASSET, expectedGeneration: 0, epoch: 1, cleanConsumer: 'clean-consumer' });
    transport = await createTransport({ issuer, tls, brokerToken: saved.brokerToken, tenantId: TENANT, assetId: ASSET });
    const call = referenceClient({ origin: transport.origin, ca: tls.cert });
    async function rejected(path, credential, expectedCode) {
      try { await call(path, credential); return false; }
      catch (error) {
        if (error.code === 'REMOTE_REJECTED' && error.remoteCode === expectedCode) return true;
        throw error; // A timeout, unavailable origin or malformed token is not proof of denial.
      }
    }
    // Read actual persisted resource generation; reopening never restores the old key.
    let currentKey;
    try { currentKey = (await call('/acquire', saved.consumers['old-consumer'])).apiKey; }
    catch (error) {
      if (error.remoteCode !== 'CONSUMER_FENCED') throw error;
      currentKey = (await call('/acquire', saved.consumers['clean-consumer'])).apiKey;
    }
    const initialBusiness = await call('/business', currentKey);
    resource = { assetId: ASSET, generation: initialBusiness.generation, readbackAt: Date.now() };
    async function flushNotifications() {
      if (dispatching) return dispatching;
      dispatching = core.notifications.dispatch(sink);
      try { return await dispatching; } finally { dispatching = undefined; }
    }
    async function flushEmail() {
      if (emailDispatching) return emailDispatching;
      emailDispatching = core.emailNotifications.dispatch({ timeoutMs: 5000 });
      try { return await emailDispatching; } finally { emailDispatching = undefined; }
    }
    world = await startWorldLab({ dataDir: join(target, 'dungeon'), pack, actorPort, mcpPort, localArtifact: true, presentation,
      onAccess(context) {
        if (contactRecorded) return;
        core.local.recordDecoyContact({ tenantId: TENANT, incidentId: saved.incidentId, assetId: ASSET,
          worldId: context.worldId, eventDigest: digest({ schemaVersion: 'dungeonq.decoy-contact/v1', ...context }) });
        core.execution.requestRotation(saved.workerToken, { requestId: saved.requestId, incidentId: saved.incidentId });
        contactRecorded = true;
        void flushNotifications().catch(() => {}); // Durable pending/unknown state remains visible to the Owner.
        void flushEmail().catch(() => {});
      } });
    async function verifyReceipt(requestId, manifestDigest, receipt) {
      const checks = emptyChecks();
      try {
        requireThat(receipt?.manifestDigest === manifestDigest && receipt.tenantId === TENANT && receipt.assetId === ASSET, 'ROTATION_RECEIPT_INVALID');
        checks.oldKeyDenied = await rejected('/business', saved.oldKey, 'KEY_REJECTED');
        const clean = await call('/acquire', saved.consumers['clean-consumer']);
        const business = await call('/business', clean.apiKey);
        checks.newKeyBusiness = business.profile === 'SYNTHETIC_ONLY' && business.generation === receipt.generation
          && business.orderId === 'synthetic-order-41' && business.quantity === 7;
        checks.oldConsumerDenied = await rejected('/acquire', saved.consumers['old-consumer'], 'CONSUMER_FENCED');
        const view = world.snapshot();
        checks.decoyKeyDenied = await rejected('/business', localArtifactCredential(view.worldId, view.epoch), 'KEY_REJECTED');
        requireThat(Object.values(checks).every(value => value === true), 'ROTATION_READBACK_REQUIRED');
        const result = core.local.recordRotationOutcome({ tenantId: TENANT, requestId, manifestDigest, status: 'COMPLETED', receipt, checks });
        resource = { assetId: ASSET, generation: business.generation, readbackAt: Date.now() };
        return result;
      } catch {
        return core.local.recordRotationOutcome({ tenantId: TENANT, requestId, manifestDigest, status: 'UNKNOWN', receipt, checks });
      }
    }
    async function reconcileRotation(requestId) {
      requireThat(requestId === saved.requestId, 'ROTATION_UNAVAILABLE');
      const row = core.local.rotationRequestsToReconcile({ tenantId: TENANT }).find(item => item.requestId === requestId);
      requireThat(row, 'ROTATION_RECONCILIATION_UNAVAILABLE');
      let receipt;
      try { receipt = await call('/receipt', saved.brokerToken, { manifestDigest: row.manifestDigest }); } catch { /* No new effect. */ }
      if (!receipt) return core.local.recordRotationOutcome({ tenantId: TENANT, requestId,
        manifestDigest: row.manifestDigest, status: 'UNKNOWN', receipt: null, checks: emptyChecks() });
      return verifyReceipt(requestId, row.manifestDigest, receipt);
    }
    async function executeRotation(requestId) {
      requireThat(requestId === saved.requestId, 'ROTATION_UNAVAILABLE');
      // Revalidate current approval immediately before dispatch. Permits never leave this assembly.
      const claim = core.execution.claimRotation(saved.workerToken, { requestId });
      if (claim.state === 'COMPLETED') return { ...claim, authorizationActive: false };
      let receipt;
      try { receipt = await call('/rotate', saved.brokerToken, claim.permit); }
      catch {
        core.local.recordRotationOutcome({ tenantId: TENANT, requestId, manifestDigest: claim.manifestDigest,
          status: 'UNKNOWN', receipt: null, checks: emptyChecks() });
        return reconcileRotation(requestId); // Lost reply: lookup, never issue another mutation.
      }
      return verifyReceipt(requestId, claim.manifestDigest, receipt);
    }
    function serial(action, requestId) {
      requireThat(!pending, 'ROTATION_BUSY');
      pending = action(requestId);
      return pending.finally(() => { pending = undefined; });
    }
    const defense = Object.freeze({
      status() {
        const view = world.snapshot();
        return { profile: 'SYNTHETIC_ONLY', presentation, campaigns: [{ incidentId: saved.incidentId,
          worldId: view.worldId, seed, steps: view.revision, currentMap: view.room.id, localSuccesses: view.receipts.length,
          phase: view.stepsRemaining > 0 ? 'BOUNDED_WORLD_ACTIVE' : 'WORLD_BUDGET_EXHAUSTED' }], resource: { ...resource },
        notificationChannel: 'LOCAL_SINK_ONLY', emailChannel: emailTransport.mode, runtimeIsolation: 'NOT_PRODUCTION_ISOLATION',
        limitation: 'One fixed synthetic origin and bounded campaign. Local decoy contact does not establish AI identity or origin compromise. Same-host services are not a production isolation boundary.' };
      },
      runRotation: requestId => serial(executeRotation, requestId),
      reconcileRotation: requestId => serial(reconcileRotation, requestId)
    });
    identity = createSocialOAuth({ configuration: identityConfig ?? {}, local: core.local, application: core.application });
    web = await startWorkbench({ application: core.application, tls, port: webPort, defense, identity });
    timer = setInterval(() => { void flushNotifications().catch(() => {}); void flushEmail().catch(() => {}); }, 1000); timer.unref();
    // Handles below are for the local owner/test assembly, never Actor tools or public evidence.
    return { directory: target, password, tls, core, world, defense, web, origin: transport.origin,
      incidentId: saved.incidentId, requestId: saved.requestId, flushNotifications, flushEmail,
      notificationReceipt: receiptId => sink.lookup(receiptId), close };
  } catch (error) { await close(); throw error; }
}
