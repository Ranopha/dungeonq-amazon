import { randomBytes, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTopologyAssignment, exactTopology } from '../world/topology.mjs';
import { openTopologyStore, requireTopology, topologyError } from './topology-store.mjs';
import { startTopologyHttp } from './topology-observer.mjs';
import { startTopologyMcpServer } from './topology-mcp.mjs';

export async function startTopologyLab({ dataDir, seed, arm, participantMode, actorPort = 0, observerPort = 0, mcpPort = 0, maxPending = 64 }) {
  requireTopology(typeof dataDir === 'string' && isAbsolute(dataDir), 'STORAGE_PATH_INVALID');
  for (const port of [actorPort, observerPort, mcpPort]) requireTopology(Number.isInteger(port) && port >= 0 && port <= 65535, 'PORT_INVALID');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const info = await lstat(dataDir);
  requireTopology(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'STORAGE_NOT_PRIVATE');
  const manifestPath = join(dataDir, 'topology-installation.json'); let installation;
  try {
    const info = await lstat(manifestPath);
    requireTopology(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o077) === 0 && info.size <= 4096, 'INSTALLATION_NOT_PRIVATE');
    installation = JSON.parse(await readFile(manifestPath, 'utf8'));
    exactTopology(installation, ['schemaVersion', 'seed', 'arm', 'participantMode', 'worldId', 'epoch']);
    requireTopology(installation.schemaVersion === 'dungeonq.topology-installation/v2', 'INSTALLATION_VERSION_UNSUPPORTED');
    validateTopologyAssignment(installation);
    requireTopology((seed === undefined || seed === installation.seed) && (arm === undefined || arm === installation.arm)
      && (participantMode === undefined || participantMode === installation.participantMode), 'INSTALLATION_ASSIGNMENT_MISMATCH');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    for (const name of ['topology.sqlite', 'topology-observer.sqlite']) {
      let exists = false; try { await lstat(join(dataDir, name)); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      requireTopology(!exists, 'INSTALLATION_INCOMPLETE');
    }
    const assignment = validateTopologyAssignment({ seed: seed ?? 19, arm: arm ?? 'TREATMENT', participantMode: participantMode ?? 'SCRIPTED_FIXTURE' });
    installation = { schemaVersion: 'dungeonq.topology-installation/v2', ...assignment, worldId: randomUUID(), epoch: randomUUID() };
    await writeFile(manifestPath, JSON.stringify(installation) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const store = openTopologyStore({ path: join(dataDir, 'topology.sqlite'), ...installation, maxPending });
  const identity = store.exportEvidence();
  const actorToken = randomBytes(32).toString('base64url');
  const observerToken = randomBytes(32).toString('base64url');
  const mcpToken = randomBytes(32).toString('base64url');
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
      const current = fork(fileURLToPath(new URL('./topology-observer.mjs', import.meta.url)), [], {
        execPath: process.execPath, execArgv: [], env: { NODE_NO_WARNINGS: '1' }, serialization: 'json',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child = current; children.add(current); let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(topologyError('OBSERVER_START_TIMEOUT')); current.kill(); } }, 5000);
      current.on('message', message => {
        if (closed || child !== current) return;
        try {
          if (message?.type === 'ready') {
            requireTopology(Object.keys(message).length === 4 && /^http:\/\/127\.0\.0\.1:\d+$/.test(message.url), 'OBSERVER_REPLY_INVALID');
            const events = store.exportEvidence().events;
            requireTopology(Number.isSafeInteger(message.sequence) && message.sequence >= 0 && message.sequence <= events.length
              && message.digest === (events[message.sequence - 1]?.digest ?? null), 'OBSERVER_CHECKPOINT_MISMATCH');
            observerSequence = message.sequence;
            // A persisted checkpoint is also a valid acknowledgment after a lost IPC reply.
            for (const event of store.pending()) if (event.sequence <= observerSequence) store.ack(event.sequence, event.digest);
            if (observerUrl) requireTopology(observerUrl === message.url, 'OBSERVER_ORIGIN_CHANGED');
            observerUrl = message.url; observerPort = Number(new URL(observerUrl).port); ready = true;
            clearTimeout(timer); settled = true; resolve(); deliver();
          } else if (message?.type === 'ack') {
            requireTopology(Object.keys(message).length === 3 && ready, 'OBSERVER_REPLY_INVALID');
            store.ack(message.sequence, message.digest);
            observerSequence = Math.max(observerSequence, message.sequence);
            if (message.sequence === inflight) { inflight = 0; deliver(); }
          } else throw topologyError('OBSERVER_REPLY_INVALID');
        } catch { current.kill(); }
      });
      current.once('error', () => { if (!settled) { clearTimeout(timer); settled = true; reject(topologyError('OBSERVER_START_FAILED')); } });
      current.once('exit', () => {
        children.delete(current); clearTimeout(timer);
        if (child === current) ready = false;
        if (!settled) { settled = true; reject(topologyError('OBSERVER_START_FAILED')); }
        if (!closed && !first) retryTimer = setTimeout(() => { startObserver().catch(() => {}); }, 1000);
        else if (!closed && first && observerUrl) retryTimer = setTimeout(() => { startObserver().catch(() => {}); }, 1000);
      });
      current.send({ type: 'bootstrap', path: join(dataDir, 'topology-observer.sqlite'), seed: identity.seed,
        worldId: identity.worldId, epoch: identity.epoch, arm: identity.arm, participantMode: identity.participantMode, token: observerToken, port: observerPort,
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
    actor = await startTopologyHttp({ role: 'actor', token: actorToken, port: actorPort,
      snapshot: () => store.snapshot(), command: envelope => {
        const result = store.command(envelope);
        // The committed reply remains valid even if IPC delivery needs the durable outbox retry.
        try { deliver(); } catch { /* Pending immutable events remain available to the delivery timer. */ }
        return result;
      } });
    mcp = await startTopologyMcpServer({ store, accessToken: mcpToken, onChange: deliver, port: mcpPort });
    deliveryTimer = setInterval(deliver, 1000); deliveryTimer.unref();
    return { actorUrl: actor.url, observerUrl, actorToken, observerToken, mcpEndpoint: mcp.endpoint, mcpToken, worldId: identity.worldId,
      get observerProcessId() { return child?.pid ?? null; }, close };
  } catch (error) { await close(); throw error; }
}
