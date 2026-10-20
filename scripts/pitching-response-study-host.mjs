// v5 研究 host：loopback、有界，不自動 ACK、不自動寄信或建立公開入口。
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [sourceArg, directoryArg, participantArg, variant, mode = 'serve', seedArg = '17'] = process.argv.slice(2);
const seed = Number(seedArg);
if (!sourceArg || !directoryArg || !participantArg || !['navigation-v5', 'fixed-guidance-v5', 'behavior-guidance-v5'].includes(variant)
  || !['serve', 'restore'].includes(mode) || ![17, 29, 43].includes(seed))
  throw Error('Use SOURCE PRIVATE_DATA PRIVATE_PARTICIPANT v5-variant [serve|restore] [17|29|43]');
process.umask(0o077);
const source = resolve(sourceArg), directory = resolve(directoryArg), participant = resolve(participantArg);
const moduleAt = name => import(pathToFileURL(join(source, name)).href);
const { openRuntimeReference } = await moduleAt('runtime/reference.mjs');
const { createRuntimeClient } = await moduleAt('sdk/runtime-client.mjs');
const save = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const ref = await openRuntimeReference({ directory, presentation: 'pitching-v1', pitchingSeed: seed,
  pitchingMode: 'adaptive', pitchingVariant: variant, network: false, hostBroker: false });
const owner = createRuntimeClient({ origin: ref.origin, token: ref.credentials.owner });
let closing = false;
async function capture(prefix) {
  save(`${prefix}-evidence.json`, await ref.evidence());
  save(`${prefix}-status.json`, await owner.status());
  save(`${prefix}-control.json`, await owner.pitchStatus());
  save(`${prefix}-response.json`, await owner.pitchResponseStatus());
}
async function stop() {
  if (closing) return;
  closing = true;
  try { await capture('after'); }
  finally { await ref.close(); }
  console.log(JSON.stringify({ state: 'CLOSED', variant, automaticAcknowledgement: false }));
}
process.once('SIGTERM', () => { stop().catch(error => { console.error(error.code || error.message); process.exitCode = 1; }); });
process.once('SIGINT', () => { stop().catch(error => { console.error(error.code || error.message); process.exitCode = 1; }); });
if (mode === 'restore') {
  try { await capture('restored'); } finally { await ref.close(); }
  console.log(JSON.stringify({ state: 'RESTORED_AND_CLOSED', variant }));
} else {
  try {
    await capture('before');
    mkdirSync(participant, { recursive: true, mode: 0o700 });
    writeFileSync(join(participant, 'participant.json'), JSON.stringify({ transport: 'loopback', origin: ref.origin,
      mcpOrigin: new URL(ref.mcpEndpoint).origin, token: ref.credentials.actor }), { mode: 0o600 });
    save('run-info.json', { pid: process.pid, source, variant, seed, transport: 'loopback', responseTracking: true,
      runtimeOrigin: ref.origin, mcpEndpoint: ref.mcpEndpoint, startedAt: new Date().toISOString() });
    console.log(JSON.stringify({ state: 'READY', variant, seed, transport: 'loopback', pid: process.pid, automaticAcknowledgement: false }));
    const timer = setTimeout(() => stop().catch(() => { process.exitCode = 1; }), 15 * 60 * 1000);
    timer.unref();
  } catch (error) { await ref.close(); throw error; }
}
