// 操作者用的有限研究 host；不建立 tunnel、不發布 edge、不呼叫模型。
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [sourceArg, directoryArg, participantArg, variant = 'baseline', mode = 'serve', seedArg = '29', transport = 'https'] = process.argv.slice(2);
const seed = Number(seedArg);
if (!sourceArg || !directoryArg || !participantArg || !['baseline', 'entry-v2', 'clues-v2', 'inquiry-control-v3', 'inquiry-cue-v3', 'disclosed-v4', 'neutral-v4'].includes(variant)
  || !['serve', 'restore'].includes(mode) || ![17, 29, 43].includes(seed) || !['https', 'loopback'].includes(transport))
  throw Error('Use source-directory private-data-directory private-participant-directory variant [serve|restore] [17|29|43] [https|loopback]');
process.umask(0o077);
const source = resolve(sourceArg), directory = resolve(directoryArg), participant = resolve(participantArg);
const moduleAt = name => import(pathToFileURL(join(source, name)).href);
const { openRuntimeReference } = await moduleAt('runtime/reference.mjs');
const { createRuntimeClient } = await moduleAt('sdk/runtime-client.mjs');
const save = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const ref = await openRuntimeReference({ directory, presentation: 'pitching-v1', pitchingSeed: seed,
  pitchingMode: 'adaptive', pitchingVariant: variant, network: false, hostBroker: false });
const owner = createRuntimeClient({ origin: ref.origin, token: ref.credentials.owner });
let gateway, closing = false;
async function capture(prefix) {
  save(`${prefix}-evidence.json`, await ref.evidence());
  save(`${prefix}-status.json`, await owner.status());
  save(`${prefix}-control.json`, await owner.pitchStatus());
}
async function stop() {
  if (closing) return;
  closing = true;
  try {
    await gateway?.close();
    await capture('after');
    for (const incident of (await owner.pitchStatus()).incidents) {
      if (!incident.acknowledgement) await owner.acknowledgeIncident({ incidentId: incident.incidentId });
      if (!incident.resolution) await owner.resolveIncident({ incidentId: incident.incidentId, resolution: 'REVIEWED' });
    }
    save('resolved-control.json', await owner.pitchStatus());
    if (gateway) save('gateway-status.json', gateway.status());
  } finally { await ref.close(); }
  console.log(JSON.stringify({ state: 'CLOSED', variant }));
}
process.once('SIGTERM', () => { stop().catch(error => { console.error(error.code || error.message); process.exitCode = 1; }); });
// The caller must signal only this parent PID, never the entire child process group.
if (mode === 'restore') {
  await capture('restored');
  await ref.close();
  console.log(JSON.stringify({ state: 'RESTORED_AND_CLOSED', variant }));
} else {
  try {
    await capture('before');
    mkdirSync(participant, { recursive: true, mode: 0o700 });
    let participantConfig;
    if (transport === 'https') {
      const configPath = join(directory, 'public-gateway.json');
      save('public-gateway.json', { schemaVersion: 'dungeonq.public-gateway/v1', publicOrigin: 'https://dungeonq.talkidino.com',
        basePath: '', runtimeOrigin: ref.origin, mcpOrigin: new URL(ref.mcpEndpoint).origin,
        credentialsPath: join(directory, 'credentials.json'), participantNames: ['actor'] });
      const { startPublicGateway } = await moduleAt('runtime/public-gateway.mjs');
      gateway = await startPublicGateway({ configPath, port: 8788 });
      participantConfig = { origin: 'https://dungeonq.talkidino.com', token: ref.credentials.actor };
    } else {
      participantConfig = { transport: 'loopback', origin: ref.origin,
        mcpOrigin: new URL(ref.mcpEndpoint).origin, token: ref.credentials.actor };
    }
    writeFileSync(join(participant, 'participant.json'), JSON.stringify(participantConfig), { mode: 0o600 });
    save('run-info.json', { pid: process.pid, source, variant, seed, transport, runtimeOrigin: ref.origin,
      mcpEndpoint: ref.mcpEndpoint, ...(gateway ? { gatewayOrigin: gateway.origin } : {}), startedAt: new Date().toISOString() });
    console.log(JSON.stringify({ state: 'READY', variant, seed, transport, pid: process.pid, ...(gateway ? { gatewayPort: gateway.port } : {}) }));
    // Independent local expiry complements the edge expiry and participant budget.
    const timer = setTimeout(() => stop().catch(() => { process.exitCode = 1; }), 15 * 60 * 1000);
    timer.unref();
  } catch (error) { await ref.close(); throw error; }
}
