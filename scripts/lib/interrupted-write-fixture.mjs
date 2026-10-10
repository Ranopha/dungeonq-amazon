import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntimeGateway } from '../../runtime/server.mjs';
import { startOrigin, startCollector } from '../../runtime/services.mjs';
import { body, newToken, request, send, serve } from '../../runtime/transport.mjs';

// Owned local test fixture only. Fault injection is in this test proxy, never an API option.
export async function interruptedWriteFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dq-write-recovery-'));
  const credentials = Object.fromEntries(['owner', 'actor', 'other', 'ordinary', 'seal', 'producer', 'reader', 'witness'].map(key => [key, newToken()]));
  let origin, collector, gateway, fault = 'none', writeAttempts = 0;
  async function start() {
    gateway = await startRuntimeGateway({ directory, credentials, originOrigin: origin.origin, collectorOrigin: collector.origin,
      presentation: 'participant-v1', network: false, hostBroker: false,
      facadeFactory: stateOrigin => serve(async (req, res) => {
        const admitted = await body(req);
        const write = admitted.body.operation === 'write';
        if (write) writeAttempts++;
        if (write && fault === 'before-commit') { fault = 'none'; res.destroy(); return; }
        const result = await request(stateOrigin, '/execute', undefined, admitted);
        if (write && fault === 'after-commit') { fault = 'none'; res.destroy(); return; }
        send(res, 200, result);
      }) });
  }
  try {
    origin = await startOrigin({ path: join(directory, 'origin.sqlite'), normalToken: credentials.ordinary, witnessToken: credentials.witness });
    collector = await startCollector({ path: join(directory, 'collector.sqlite'), producerToken: credentials.producer, readerToken: credentials.reader });
    await start();
  } catch (error) { await gateway?.close(); await collector?.close(); await origin?.close(); rmSync(directory, { recursive: true, force: true }); throw error; }
  return {
    directory, credentials,
    get gateway() { return gateway; }, get writeAttempts() { return writeAttempts; },
    fault(value) { if (!['none', 'before-commit', 'after-commit'].includes(value)) throw Error('INVALID_FIXTURE_FAULT'); fault = value; },
    async restart() { await gateway.close(); await start(); },
    async close() { await gateway.close(); await collector.close(); await origin.close(); rmSync(directory, { recursive: true, force: true }); }
  };
}
