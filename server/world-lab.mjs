import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceWorld, createWorld, projectWorld, validateWorldPack, worldDigest } from '../world/kernel.mjs';
import { openWorldStore, requireWorld, worldError } from './world-store.mjs';
import { startWorldHttp } from './world-observer.mjs';
import { startWorldMcpServer } from './world-mcp.mjs';
import { createOrdersWorkspace } from './orders-workspace.mjs';

export function localArtifactCredential(worldId, epoch) {
  return Buffer.from(worldDigest({ domain: 'dungeonq.local-artifact/v1', worldId, epoch }), 'hex').toString('base64url');
}

export async function startWorldLab({ dataDir, pack, actorPort = 0, observerPort = 0, mcpPort = 0, onAccess = () => {}, localArtifact = false,
  presentation = 'disclosed/v1' }) {
  requireWorld(typeof dataDir === 'string' && isAbsolute(dataDir), 'STORAGE_PATH_INVALID');
  const admitted = validateWorldPack(pack);
  requireWorld(typeof onAccess === 'function' && typeof localArtifact === 'boolean', 'WORLD_CALLBACK_INVALID');
  requireWorld(['disclosed/v1', 'orders-workspace/v1'].includes(presentation)
    && (presentation !== 'orders-workspace/v1' || localArtifact), 'WORLD_PRESENTATION_INVALID');
  if (presentation === 'orders-workspace/v1') requireWorld(admitted.hypotheses.some(row => row.id === 'origin-record-confirmed')
    && admitted.hypotheses.some(row => row.id === 'not-confirmed'), 'WORLD_PRESENTATION_PACK_MISMATCH');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const info = await lstat(dataDir);
  requireWorld(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'STORAGE_NOT_PRIVATE');
  const store = openWorldStore({ path: join(dataDir, 'world.sqlite'), pack: admitted });
  const identity = store.snapshot();
  const actorToken = randomBytes(32).toString('base64url');
  const observerToken = randomBytes(32).toString('base64url');
  const touch = () => onAccess({ worldId: identity.worldId, epoch: identity.epoch, packDigest: worldDigest(admitted) });
  const actorStore = {
    snapshot() { touch(); return store.snapshot(); },
    command(envelope) { touch(); return store.command(envelope); },
    resolveView(envelope) {
      const bundle = store.exportEvidence();
      requireWorld(Number.isSafeInteger(envelope.expectedRevision) && envelope.expectedRevision >= 0
        && envelope.expectedRevision <= bundle.events.length, 'REVISION_CONFLICT');
      let state = createWorld(bundle.pack, { worldId: bundle.worldId, epoch: bundle.epoch });
      for (const event of bundle.events.slice(0, envelope.expectedRevision)) state = advanceWorld(state, event.command).state;
      return projectWorld(state);
    },
  };
  const issue = () => {
    touch(); const view = store.snapshot();
    requireWorld(view.receipts.length > 0, 'LOCAL_OUTCOME_REQUIRED');
    // A public synthetic fixture value, not a secret or an origin credential.
    const credential = localArtifactCredential(view.worldId, view.epoch);
    return { profile: 'SYNTHETIC_ONLY', kind: 'SYNTHETIC_RESOURCE_CREDENTIAL', worldId: view.worldId, epoch: view.epoch, credential, scope: 'DUNGEON_ONLY' };
  };
  const artifact = localArtifact ? { issue, read(credential) {
    requireWorld(typeof credential === 'string' && /^[A-Za-z0-9_-]{43}$/.test(credential), 'CREDENTIAL_INVALID');
    requireWorld(credential === issue().credential, 'LOCAL_CREDENTIAL_REJECTED');
    return { profile: 'SYNTHETIC_ONLY', recordId: 'synthetic-relay-record', quantity: 7, scope: 'DUNGEON_ONLY' };
  } } : undefined;
  let actor; let mcp; let child; let ready = false; let closed = false; let retryTimer; let deliveryTimer;
  let observerUrl; let inflight = 0; let deliveryAt = 0; let observerSequence = 0;
  const children = new Set();
  function deliver() {
    if (closed || !ready || !child?.connected) return;
    if (inflight && Date.now() - deliveryAt < 1000) return;
    const pending = store.exportEvidence().events.filter(event => event.sequence > observerSequence).slice(0, 64);
    if (!pending.length) return;
    inflight = pending.at(-1).sequence; deliveryAt = Date.now();
    child.send({ type: 'append', events: pending, latestSequence: store.snapshot().revision }, error => { if (error) child?.kill(); });
  }
  function startObserver(first = false) {
    return new Promise((resolve, reject) => {
      ready = false; inflight = 0;
      const current = fork(fileURLToPath(new URL('./world-observer.mjs', import.meta.url)), [], {
        execPath: process.execPath, execArgv: [], env: { NODE_NO_WARNINGS: '1' }, serialization: 'json',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child = current; children.add(current); let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(worldError('OBSERVER_START_TIMEOUT')); current.kill(); } }, 5000);
      current.on('message', message => {
        if (closed || child !== current) return;
        try {
          if (message?.type === 'ready') {
            requireWorld(Object.keys(message).length === 4 && /^http:\/\/127\.0\.0\.1:\d+$/.test(message.url), 'OBSERVER_REPLY_INVALID');
            const events = store.exportEvidence().events;
            requireWorld(Number.isSafeInteger(message.sequence) && message.sequence >= 0 && message.sequence <= events.length
              && message.digest === (events[message.sequence - 1]?.digest ?? null), 'OBSERVER_CHECKPOINT_MISMATCH');
            observerSequence = message.sequence;
            // A persisted checkpoint is also a valid acknowledgment after a lost IPC reply.
            for (const event of store.pending()) if (event.sequence <= observerSequence) store.ack(event.sequence, event.digest);
            if (observerUrl) requireWorld(observerUrl === message.url, 'OBSERVER_ORIGIN_CHANGED');
            observerUrl = message.url; observerPort = Number(new URL(observerUrl).port); ready = true;
            clearTimeout(timer); settled = true; resolve(); deliver();
          } else if (message?.type === 'ack') {
            requireWorld(Object.keys(message).length === 3 && ready, 'OBSERVER_REPLY_INVALID');
            store.ack(message.sequence, message.digest);
            observerSequence = Math.max(observerSequence, message.sequence);
            if (message.sequence === inflight) { inflight = 0; deliver(); }
          } else throw worldError('OBSERVER_REPLY_INVALID');
        } catch { current.kill(); }
      });
      current.once('error', () => { if (!settled) { clearTimeout(timer); settled = true; reject(worldError('OBSERVER_START_FAILED')); } });
      current.once('exit', () => {
        children.delete(current); clearTimeout(timer);
        if (child === current) ready = false;
        if (!settled) { settled = true; reject(worldError('OBSERVER_START_FAILED')); }
        if (!closed && !first) retryTimer = setTimeout(() => { startObserver().catch(() => {}); }, 1000);
        else if (!closed && first && observerUrl) retryTimer = setTimeout(() => { startObserver().catch(() => {}); }, 1000);
      });
      current.send({ type: 'bootstrap', path: join(dataDir, 'observer.sqlite'), pack: admitted,
        worldId: identity.worldId, epoch: identity.epoch, token: observerToken, port: observerPort,
        latestSequence: store.snapshot().revision }, error => { if (error) current.kill(); });
    });
  }
  async function close() {
    if (closed) return; closed = true; clearTimeout(retryTimer); clearInterval(deliveryTimer);
    if (actor) await actor.close();
    if (mcp) await mcp.close();
    await Promise.all([...children].map(current => new Promise(resolve => {
      if (current.exitCode !== null || current.signalCode !== null) return resolve();
      const timer = setTimeout(() => current.kill('SIGKILL'), 1500);
      current.once('exit', () => { clearTimeout(timer); resolve(); }); current.kill('SIGTERM');
    })));
    store.close();
  }
  try {
    await startObserver(true);
    const workspace = presentation === 'orders-workspace/v1'
      ? createOrdersWorkspace({ store: actorStore, artifact, seed: admitted.seed, onChange: deliver }) : null;
    actor = await startWorldHttp({ role: 'actor', token: actorToken, port: actorPort,
      snapshot: () => workspace ? workspace.snapshot() : actorStore.snapshot(),
      command: envelope => { if (workspace) return workspace.command(envelope); const result = actorStore.command(envelope); deliver(); return result; },
      artifact: workspace ? { issue: workspace.issue, read: workspace.read } : artifact,
      variant: workspace ? 'orders' : localArtifact ? 'defense' : 'world' });
    mcp = await startWorldMcpServer({ store: actorStore, accessToken: actorToken, onChange: deliver, artifact, workspace, port: mcpPort });
    deliveryTimer = setInterval(deliver, 1000); deliveryTimer.unref();
    return { actorUrl: actor.url, observerUrl, actorToken, observerToken, mcpEndpoint: mcp.endpoint, mcpToken: actorToken, worldId: identity.worldId,
      // Trusted assembly handles; these are not exposed as actor tools.
      snapshot: () => store.snapshot(), exportEvidence: () => store.exportEvidence(),
      get observerProcessId() { return child?.pid ?? null; }, close };
  } catch (error) { await close(); throw error; }
}
