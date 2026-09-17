import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStudyDesign } from '../study/experiment.mjs';
import { openStudyStore, requireStudy, studyError } from './study-store.mjs';
import { startStudyHttp } from './study-observer.mjs';
import { startStudyMcpServer } from './study-mcp.mjs';

export async function startStudyLab({ dataDir, design, arm, rule, actorPort = 0, observerPort = 0, mcpPort = 0 }) {
  requireStudy(typeof dataDir === 'string' && isAbsolute(dataDir), 'STORAGE_PATH_INVALID');
  const admitted = validateStudyDesign(design);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const info = await lstat(dataDir);
  requireStudy(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'STORAGE_NOT_PRIVATE');
  const store = openStudyStore({ path: join(dataDir, 'study.sqlite'), design: admitted, arm, rule });
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
      const current = fork(fileURLToPath(new URL('./study-observer.mjs', import.meta.url)), [], {
        execPath: process.execPath, execArgv: [], env: { NODE_NO_WARNINGS: '1' }, serialization: 'json',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child = current; children.add(current); let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(studyError('OBSERVER_START_TIMEOUT')); current.kill(); } }, 5000);
      current.on('message', message => {
        if (closed || child !== current) return;
        try {
          if (message?.type === 'ready') {
            requireStudy(Object.keys(message).length === 4 && /^http:\/\/127\.0\.0\.1:\d+$/.test(message.url), 'OBSERVER_REPLY_INVALID');
            const events = store.exportEvidence().events;
            requireStudy(Number.isSafeInteger(message.sequence) && message.sequence >= 0 && message.sequence <= events.length
              && message.digest === (events[message.sequence - 1]?.digest ?? null), 'OBSERVER_CHECKPOINT_MISMATCH');
            observerSequence = message.sequence;
            // A persisted checkpoint is also a valid acknowledgment after a lost IPC reply.
            for (const event of store.pending()) if (event.sequence <= observerSequence) store.ack(event.sequence, event.digest);
            if (observerUrl) requireStudy(observerUrl === message.url, 'OBSERVER_ORIGIN_CHANGED');
            observerUrl = message.url; observerPort = Number(new URL(observerUrl).port); ready = true;
            clearTimeout(timer); settled = true; resolve(); deliver();
          } else if (message?.type === 'ack') {
            requireStudy(Object.keys(message).length === 3 && ready, 'OBSERVER_REPLY_INVALID');
            store.ack(message.sequence, message.digest);
            observerSequence = Math.max(observerSequence, message.sequence);
            if (message.sequence === inflight) { inflight = 0; deliver(); }
          } else throw studyError('OBSERVER_REPLY_INVALID');
        } catch { current.kill(); }
      });
      current.once('error', () => { if (!settled) { clearTimeout(timer); settled = true; reject(studyError('OBSERVER_START_FAILED')); } });
      current.once('exit', () => {
        children.delete(current); clearTimeout(timer);
        if (child === current) ready = false;
        if (!settled) { settled = true; reject(studyError('OBSERVER_START_FAILED')); }
        if (!closed && !first) retryTimer = setTimeout(() => { startObserver().catch(() => {}); }, 1000);
        else if (!closed && first && observerUrl) retryTimer = setTimeout(() => { startObserver().catch(() => {}); }, 1000);
      });
      current.send({ type: 'bootstrap', path: join(dataDir, 'study-observer.sqlite'), design: admitted,
        worldId: identity.worldId, epoch: identity.epoch, arm: identity.arm, rule: identity.rule, nonce: identity.nonce, token: observerToken, port: observerPort,
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
    actor = await startStudyHttp({ role: 'actor', token: actorToken, port: actorPort,
      snapshot: () => store.snapshot(), command: envelope => {
        const result = store.command(envelope);
        // The committed reply remains valid even if IPC delivery needs the durable outbox retry.
        try { deliver(); } catch { /* Pending immutable events remain available to the delivery timer. */ }
        return result;
      } });
    mcp = await startStudyMcpServer({ store, accessToken: mcpToken, onChange: deliver, port: mcpPort });
    deliveryTimer = setInterval(deliver, 1000); deliveryTimer.unref();
    return { actorUrl: actor.url, observerUrl, actorToken, observerToken, mcpEndpoint: mcp.endpoint, mcpToken, worldId: identity.worldId,
      get observerProcessId() { return child?.pid ?? null; }, close };
  } catch (error) { await close(); throw error; }
}
