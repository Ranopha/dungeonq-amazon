import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export function selectDockerContext(value = 'colima-dungeonq-rehearsal') {
  if (value !== 'colima-dungeonq-rehearsal' && !/^dungeonq-[a-z0-9][a-z0-9-]{0,62}$/.test(value)) {
    throw new Error('DEDICATED_DOCKER_CONTEXT_REQUIRED');
  }
  return value;
}
export const DOCKER_CONTEXT = selectDockerContext(process.env.DUNGEONQ_DOCKER_CONTEXT);
export const REFERENCE_VERSION = 'dungeonq.runtime-isolation/v1';
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = join(root, 'deploy/runtime-reference');
const roles = ['gateway', 'facade', 'origin', 'collector'];
const graph = { gateway: ['world', 'origin', 'evidence'], facade: ['world'], origin: ['origin'], collector: ['evidence'] };
const tokenNames = ['owner', 'actor', 'other', 'ordinary', 'seal', 'producer', 'reader', 'witness'];
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const insist = (condition, code) => { if (!condition) fail(code); };
const privateWrite = (path, value, flag = 'wx') => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag });

function readPrivate(path) {
  const stat = lstatSync(path);
  insist(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && !(stat.mode & 0o077), 'PRIVATE_REFERENCE_FILE_REQUIRED');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readReference(directory) {
  insist(typeof directory === 'string' && isAbsolute(directory), 'ABSOLUTE_REFERENCE_DIRECTORY_REQUIRED');
  const stat = lstatSync(directory);
  insist(stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077), 'PRIVATE_REFERENCE_DIRECTORY_REQUIRED');
  const manifest = readPrivate(join(directory, 'reference.json'));
  insist(manifest.schemaVersion === REFERENCE_VERSION && manifest.context === DOCKER_CONTEXT
    && /^dqref-[a-f0-9]{12}$/.test(manifest.project), 'REFERENCE_IDENTITY_INVALID');
  return manifest;
}

function sourceEntries(source, entries, prefix) {
  const info = lstatSync(source);
  insist(!info.isSymbolicLink(), 'SOURCE_SYMLINK_DENIED');
  if (info.isDirectory()) {
    for (const name of readdirSync(source).sort()) sourceEntries(join(source, name), entries, `${prefix}/${name}`);
  } else {
    insist(info.isFile() && info.size <= 2_000_000 && /\.(?:mjs|json|html|css|svg|png)$/.test(source), 'SOURCE_FILE_DENIED');
    entries.push({ path: prefix, sha256: createHash('sha256').update(readFileSync(source)).digest('hex') });
  }
}

export function referenceSourceManifest() {
  insist(existsSync(join(root, 'runtime/server.mjs')), 'GATEWAY_IMPLEMENTATION_REQUIRED');
  const entries = [];
  for (const path of ['package.json', 'package-lock.json', 'runtime', 'world', 'server/world-store.mjs', 'sdk/runtime-client.mjs', 'public/runtime']) {
    sourceEntries(join(root, path), entries, path);
  }
  entries.push({ path: 'Dockerfile', sha256: createHash('sha256').update(readFileSync(join(profile, 'Dockerfile'))).digest('hex') });
  const sourceDigest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { sourceDigest, entries };
}

function stageSource(directory) {
  const { sourceDigest, entries } = referenceSourceManifest();
  const buildDirectory = mkdtempSync(join(directory, 'build-'));
  for (const entry of entries) {
    const target = join(buildDirectory, entry.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    copyFileSync(entry.path === 'Dockerfile' ? join(profile, 'Dockerfile') : join(root, entry.path), target);
    chmodSync(target, 0o644);
    insist(createHash('sha256').update(readFileSync(target)).digest('hex') === entry.sha256, 'SOURCE_CHANGED_WHILE_STAGING');
  }
  privateWrite(join(buildDirectory, 'source-manifest.json'), { sourceDigest, entries });
  return { buildDirectory, sourceDigest };
}

export function prepareReference({ directory } = {}) {
  if (directory) {
    insist(isAbsolute(directory) && !existsSync(directory), 'NEW_ABSOLUTE_DIRECTORY_REQUIRED');
    const proposed = resolve(realpathSync(dirname(directory)), directory.split('/').at(-1));
    insist(relative(root, proposed).startsWith('..'), 'CONFIG_OUTSIDE_REPOSITORY_REQUIRED');
    mkdirSync(directory, { mode: 0o700 });
  } else directory = mkdtempSync(join(tmpdir(), 'dungeonq-reference-'));
  directory = realpathSync(directory);
  const credentials = Object.fromEntries(tokenNames.map((name) => [name, randomBytes(32).toString('base64url')]));
  const configs = {
    gateway: { directory: '/state/gateway', credentials, facadeOrigin: 'http://facade:4204', originOrigin: 'http://origin:4202', collectorOrigin: 'http://collector:4203',
      host: '0.0.0.0', port: 4200, stateHost: '0.0.0.0', statePort: 4201, mcpPort: 4205, sshPort: 4206, postgresPort: 4207, network: true, hostBroker: true },
    facade: { role: 'facade', options: { stateOrigin: 'http://gateway:4201', host: '0.0.0.0', port: 4204 } },
    origin: { role: 'origin', options: { path: '/state/origin/origin.sqlite', normalToken: credentials.ordinary, witnessToken: credentials.witness, contextId: 'ordinary', host: '0.0.0.0', port: 4202 } },
    collector: { role: 'collector', options: { path: '/state/collector/collector.sqlite', producerToken: credentials.producer, readerToken: credentials.reader, host: '0.0.0.0', port: 4203 } },
  };
  const configDirectory = join(directory, 'config');
  mkdirSync(configDirectory, { mode: 0o700 });
  for (const [role, config] of Object.entries(configs)) privateWrite(join(configDirectory, `${role}.json`), config);
  const manifest = { schemaVersion: REFERENCE_VERSION, context: DOCKER_CONTEXT, project: `dqref-${randomBytes(6).toString('hex')}`,
    uid: process.getuid(), gid: process.getgid(), createdAt: new Date().toISOString(), ...stageSource(directory) };
  insist(manifest.uid > 0, 'NONROOT_REFERENCE_OWNER_REQUIRED');
  privateWrite(join(directory, 'reference.json'), manifest);
  const env = { DUNGEONQ_PROJECT: manifest.project, DUNGEONQ_CONFIG_DIR: configDirectory, DUNGEONQ_UID: manifest.uid, DUNGEONQ_GID: manifest.gid };
  insist(!Object.values(env).some((value) => /[\r\n]/.test(String(value))), 'REFERENCE_PATH_INVALID');
  privateWrite(join(directory, 'compose.env'), Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n');
  return { directory, ...manifest };
}

async function docker(args, { input, timeout = 30_000, maxBytes = 2_000_000, build = false } = {}) {
  return new Promise((resolveCommand, reject) => {
    const process = spawn('docker', ['--context', DOCKER_CONTEXT, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...globalThis.process.env, ...(build ? { DOCKER_BUILDKIT: '0' } : {}) },
    });
    const chunks = { stdout: [], stderr: [] }; let size = 0; let failure;
    const timer = setTimeout(() => { failure = 'DOCKER_OPERATION_TIMEOUT'; process.kill('SIGKILL'); }, timeout);
    for (const stream of ['stdout', 'stderr']) process[stream].on('data', (data) => {
      size += data.length;
      if (size > maxBytes) { failure = 'DOCKER_OUTPUT_LIMIT'; process.kill('SIGKILL'); }
      else chunks[stream].push(data);
    });
    process.once('error', (error) => { clearTimeout(timer); reject(error); });
    process.once('close', (code) => {
      clearTimeout(timer);
      const result = Object.fromEntries(Object.entries(chunks).map(([key, values]) => [key, Buffer.concat(values).toString('utf8')]));
      if (failure || code !== 0) reject(Object.assign(new Error(failure ?? 'DOCKER_OPERATION_FAILED'), { code: failure ?? 'DOCKER_OPERATION_FAILED', detail: result.stderr.slice(-2000) }));
      else resolveCommand(result.stdout.trim());
    });
    process.stdin.on('error', () => {});
    process.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

const composeArgs = (directory, manifest) => ['compose', '--project-name', manifest.project, '--env-file', join(directory, 'compose.env'), '-f', join(profile, 'compose.yml')];

export async function buildReference(directory) {
  const manifest = { ...readReference(directory), ...stageSource(directory) };
  privateWrite(join(directory, 'reference.json'), manifest, 'w');
  await docker(['build', '--memory', '1g', '--build-arg', `RUNTIME_UID=${manifest.uid}`, '--build-arg', `RUNTIME_GID=${manifest.gid}`,
    '--build-arg', `SOURCE_DIGEST=${manifest.sourceDigest}`, '-t', `dungeonq-runtime-reference:${manifest.project}`, manifest.buildDirectory], { timeout: 360_000, build: true, maxBytes: 4_000_000 });
  return { project: manifest.project, sourceDigest: manifest.sourceDigest, built: true };
}

export async function startReference(directory) {
  const manifest = readReference(directory);
  await seedConfiguration(directory, manifest);
  await docker([...composeArgs(directory, manifest), 'up', '-d', '--no-build', '--pull', 'never'], { timeout: 60_000 });
  const containers = await inspectReference(directory);
  insist(roles.every((role) => containers[role].State.Running), 'REFERENCE_SERVICE_EXITED');
  let ready = false;
  for (let attempt = 0; attempt < 30 && !ready; attempt++) {
    try { ready = (await gatewayApi(containers.gateway, '/api/capabilities')).schemaVersion === 'dungeonq.capability-catalogue/v1'; } catch { /* bounded startup wait */ }
    if (!ready) await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  insist(ready, 'GATEWAY_NOT_READY');
  return { project: manifest.project, gatewayContainer: containers.gateway.Id, internalOrigin: 'http://gateway:4200', hostPublished: false, ready: true };
}

async function seedConfiguration(directory, manifest) {
  const image = `dungeonq-runtime-reference:${manifest.project}`;
  for (const role of roles) {
    const name = `${manifest.project}_${role}-config`;
    const source = join(directory, 'config', `${role}.json`);
    readPrivate(source);
    const expected = createHash('sha256').update(readFileSync(source)).digest('hex');
    const existing = await docker(['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']);
    if (!existing) {
      await docker(['volume', 'create', '--label', `org.dungeonq.project=${manifest.project}`, '--label', `org.dungeonq.role=${role}`, name]);
      const helper = await docker(['create', '--label', `org.dungeonq.project=${manifest.project}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--mount', `type=volume,source=${name},target=/run/dungeonq`, image, 'node', '--version']);
      try { await docker(['cp', '--archive', source, `${helper}:/run/dungeonq/${role}.json`]); }
      finally { await docker(['rm', helper]); }
    }
    const [volume] = JSON.parse(await docker(['volume', 'inspect', name]));
    insist(volume.Labels?.['org.dungeonq.project'] === manifest.project && volume.Labels?.['org.dungeonq.role'] === role, 'CONFIG_VOLUME_IDENTITY_INVALID');
    const verifier = await docker(['create', '--label', `org.dungeonq.project=${manifest.project}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '32', '--memory', '96m', '--mount', `type=volume,source=${name},target=/run/dungeonq,readonly`, image,
      'node', '--input-type=module', '-e', `import{readFileSync,lstatSync}from'node:fs';import{createHash}from'node:crypto';const p='/run/dungeonq/${role}.json';if(lstatSync(p).mode&0o077)throw Error('CONFIG_NOT_PRIVATE');console.log(createHash('sha256').update(readFileSync(p)).digest('hex'));`]);
    let observed;
    try { observed = await docker(['start', '--attach', verifier]); }
    finally { await docker(['rm', '--force', verifier]); }
    insist(observed === expected, 'PERSISTED_CONFIG_MISMATCH');
  }
}

export async function stopReference(directory) {
  const manifest = readReference(directory);
  await docker([...composeArgs(directory, manifest), 'down', '--timeout', '10'], { timeout: 45_000 });
  return { project: manifest.project, stopped: true, namedVolumesAndPrivateConfigurationRetained: true };
}

async function inspectReference(directory) {
  const manifest = readReference(directory);
  const result = {};
  for (const role of roles) {
    const id = await docker([...composeArgs(directory, manifest), 'ps', '--all', '--quiet', role]);
    insist(/^[a-f0-9]{64}$/.test(id), 'REFERENCE_CONTAINER_MISSING');
    const [container] = JSON.parse(await docker(['inspect', id]));
    insist(container.Config.Labels['com.docker.compose.project'] === manifest.project
      && container.Config.Labels['com.docker.compose.service'] === role, 'REFERENCE_CONTAINER_MISMATCH');
    result[role] = container;
  }
  return result;
}

const probeCode = `
import net from 'node:net'; import {openSync,closeSync} from 'node:fs';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const spec=JSON.parse(input); const result={tcp:{},files:{},http:{}};
for(const item of spec.tcp??[]) result.tcp[item.name]=await new Promise(resolve=>{
  const socket=net.connect({host:item.host,port:item.port});let finished=false;
  const done=(connected,code)=>{if(finished)return;finished=true;socket.destroy();resolve({host:item.host,port:item.port,connected,code});};
  socket.setTimeout(700,()=>done(false,'TIMEOUT'));socket.once('connect',()=>done(true,'CONNECTED'));socket.once('error',e=>done(false,e.code));
});
for(const item of spec.files??[]){try{const fd=openSync(item.path,'r');closeSync(fd);result.files[item.name]={path:item.path,readable:true};}catch(e){result.files[item.name]={path:item.path,readable:false,code:e.code};}}
for(const item of spec.http??[]){try{const r=await fetch(item.url,{method:item.body?'POST':'GET',headers:item.body?{'Content-Type':'application/json'}:{},body:item.body?JSON.stringify(item.body):undefined,signal:AbortSignal.timeout(1500)});const b=await r.json();result.http[item.name]={status:r.status,code:b?.error?.code??null};}catch(e){result.http[item.name]={status:null,code:e.code??e.name};}}
console.log(JSON.stringify(result));
`;

const probe = async (container, spec) => JSON.parse(await docker(['exec', '-i', container.Id, 'node', '--input-type=module', '-e', probeCode], { input: spec, timeout: 12_000 }));

async function gatewayApi(container, path, credential, payload) {
  insist(['/api/capabilities', '/api/evidence', '/api/operate'].includes(path)
    && [undefined, 'owner', 'actor', 'ordinary'].includes(credential), 'REFERENCE_API_SCOPE_INVALID');
  const code = `import{readFileSync}from'node:fs';let input='';for await(const c of process.stdin)input+=c;const{path,credential,payload}=JSON.parse(input);const config=JSON.parse(readFileSync('/run/dungeonq/gateway.json','utf8'));const token=credential?config.credentials[credential]:undefined;const r=await fetch('http://127.0.0.1:4200'+path,{method:payload?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(payload?{'Content-Type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(8000)});console.log(JSON.stringify({status:r.status,value:await r.json()}));`;
  const response = JSON.parse(await docker(['exec', '-i', container.Id, 'node', '--input-type=module', '-e', code], { input: { path, credential, payload }, timeout: 10_000 }));
  insist(response.status === 200, response.value?.error?.code ?? 'REFERENCE_API_FAILED');
  return response.value;
}

export function evaluateIsolation(checks) {
  const required = ['container-confinement', 'separate-private-mounts', 'internal-network-graph', 'image-source-binding', 'source-current',
    'canonical-reachable', 'origin-direct-ip-blocked', 'collector-direct-ip-blocked', 'private-files-inaccessible',
    'private-files-positive-control', 'unsigned-canonical-rejected', 'control-api-rejected', 'synthetic-operation-correlated',
    'ordinary-operation-correlated', 'origin-witness-continuity', 'gateway-evidence-complete'];
  const normalized = required.map((id) => {
    const candidates = checks.filter((check) => check.id === id);
    return candidates.length === 1 && ['PASS', 'FAIL'].includes(candidates[0].status) ? candidates[0] : { id, status: 'INCONCLUSIVE', detail: 'Missing, duplicated, or unobserved acceptance fact.' };
  });
  return { status: normalized.some((check) => check.status === 'FAIL') ? 'FAIL'
    : normalized.every((check) => check.status === 'PASS') ? 'PASS' : 'INCONCLUSIVE', checks: normalized };
}

export function compareIsolationContinuity(before, after) {
  const normalizedMounts = (value) => JSON.stringify(value.map(({ Type, Name, Destination, RW }) => [Type, Name, Destination, RW])
    .sort((a, b) => a[2].localeCompare(b[2]) || a[1].localeCompare(b[1])));
  try {
    const first = before.checks.find((check) => check.id === 'origin-witness-continuity').detail.after;
    const resumed = after.checks.find((check) => check.id === 'origin-witness-continuity').detail.before;
    const facts = {
      sameReference: before.context === DOCKER_CONTEXT && after.context === DOCKER_CONTEXT && before.project === after.project,
      sameSource: before.sourceDigest === after.sourceDigest,
      sameImage: JSON.stringify(before.images.map((image) => image.id).sort()) === JSON.stringify(after.images.map((image) => image.id).sort()),
      sameVolumes: roles.every((role) => normalizedMounts(before.facts.containers[role].mounts) === normalizedMounts(after.facts.containers[role].mounts)),
      recreatedContainers: roles.every((role) => before.facts.containers[role].id !== after.facts.containers[role].id),
      witnessPreserved: JSON.stringify(first) === JSON.stringify(resumed),
      priorEventsPreserved: before.facts.gatewayEvidence.eventIds.every((id) => after.facts.gatewayEvidence.eventIds.includes(id)),
      eventCountBefore: before.facts.gatewayEvidence.eventCount, eventCountAfter: after.facts.gatewayEvidence.eventCount,
    };
    const pass = before.status === 'PASS' && after.status === 'PASS' && evaluateIsolation(before.checks).status === 'PASS'
      && evaluateIsolation(after.checks).status === 'PASS' && Object.entries(facts).filter(([key]) => !key.startsWith('eventCount')).every(([, value]) => value === true)
      && facts.eventCountAfter === facts.eventCountBefore + 2;
    return { schemaVersion: 'dungeonq.runtime-isolation-continuity/v1', status: pass ? 'PASS' : 'FAIL', sourceDigest: after.sourceDigest, facts };
  } catch { return { schemaVersion: 'dungeonq.runtime-isolation-continuity/v1', status: 'INCONCLUSIVE', code: 'CONTINUITY_EVIDENCE_MISSING' }; }
}

export async function verifyReference(directory) {
  const manifest = readReference(directory);
  const pending = { schemaVersion: REFERENCE_VERSION, observedAt: new Date().toISOString(), context: DOCKER_CONTEXT,
    project: manifest.project, sourceDigest: manifest.sourceDigest, ...evaluateIsolation([]), code: 'VERIFICATION_IN_PROGRESS' };
  // A failed attempt must never leave a previous PASS as the latest result.
  privateWrite(join(directory, 'isolation-result.json'), pending, 'w');
  try { return await observeReference(directory); }
  catch (error) {
    privateWrite(join(directory, 'isolation-result.json'), { ...pending, code: error.code ?? 'REFERENCE_FAILED' }, 'w');
    throw error;
  }
}

async function observeReference(directory) {
  const manifest = readReference(directory);
  const containers = await inspectReference(directory);
  const checks = [];
  const check = (id, pass, detail) => checks.push({ id, status: pass ? 'PASS' : 'FAIL', detail });
  check('container-confinement', roles.every((role) => {
    const container = containers[role]; const config = container.HostConfig;
    const published = Object.entries(container.NetworkSettings.Ports).filter(([, value]) => value?.length);
    return container.State.Running && container.Config.User === `${manifest.uid}:${manifest.gid}` && manifest.uid > 0
      && config.ReadonlyRootfs && !config.Privileged && config.CapDrop?.includes('ALL')
      && config.SecurityOpt?.some((value) => value === 'no-new-privileges:true' || value === 'no-new-privileges')
      && config.PidsLimit > 0 && config.PidsLimit <= 64 && config.Memory > 0 && config.Memory <= 536870912
      && published.length === 0;
  }), 'Observed running state, nonroot identity, read-only root, capabilities, privilege flag, PID and memory bounds.');
  check('separate-private-mounts', roles.every((role) => {
    const mounts = containers[role].Mounts;
    const binds = mounts.filter((mount) => mount.Type === 'bind');
    const volumes = mounts.filter((mount) => mount.Type === 'volume');
    const config = volumes.filter((mount) => mount.Destination === '/run/dungeonq');
    const state = volumes.filter((mount) => mount.Destination === '/state');
    return binds.length === 0 && config.length === 1 && !config[0].RW && config[0].Name === `${manifest.project}_${role}-config`
      && volumes.length === (role === 'facade' ? 1 : 2)
      && (role === 'facade' ? state.length === 0 : state.length === 1 && state[0].Name === `${manifest.project}_${role}-state`);
  }), 'Each role has only its own read-only configuration and, except the facade, its own named state volume.');
  const networks = {};
  for (const name of ['world', 'origin', 'evidence']) [networks[name]] = JSON.parse(await docker(['network', 'inspect', `${manifest.project}_${name}`]));
  check('internal-network-graph', Object.values(networks).every((network) => network.Internal === true)
    && roles.every((role) => JSON.stringify(Object.keys(containers[role].NetworkSettings.Networks).sort())
      === JSON.stringify(graph[role].map((name) => `${manifest.project}_${name}`).sort())), 'Observed internal network flags and each container network membership.');
  const images = {};
  for (const id of new Set(roles.map((role) => containers[role].Image))) {
    const [image] = JSON.parse(await docker(['image', 'inspect', id]));
    images[id] = { id, sourceDigest: image.Config.Labels?.['org.dungeonq.source-digest'] };
  }
  check('image-source-binding', Object.values(images).every((image) => image.sourceDigest === manifest.sourceDigest), 'Actual image IDs and source digest label match the staged source manifest.');
  check('source-current', referenceSourceManifest().sourceDigest === manifest.sourceDigest, 'Staged runtime sources and pinned Dockerfile match current files.');
  const originIp = containers.origin.NetworkSettings.Networks[`${manifest.project}_origin`]?.IPAddress;
  const collectorIp = containers.collector.NetworkSettings.Networks[`${manifest.project}_evidence`]?.IPAddress;
  insist([originIp, collectorIp].every((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value)), 'REFERENCE_IP_MISSING');
  const protectedFiles = [
    { name: 'gateway-config', path: '/run/dungeonq/gateway.json' }, { name: 'origin-config', path: '/run/dungeonq/origin.json' },
    { name: 'collector-config', path: '/run/dungeonq/collector.json' }, { name: 'canonical-db', path: '/state/gateway/runtime.sqlite' },
    { name: 'ticket-key', path: '/state/gateway/runtime.sqlite.ticket-key' }, { name: 'origin-db', path: '/state/origin/origin.sqlite' },
    { name: 'collector-db', path: '/state/collector/collector.sqlite' },
  ];
  const facadeProbe = await probe(containers.facade, { tcp: [
    { name: 'canonical', host: 'gateway', port: 4201 }, { name: 'origin', host: originIp, port: 4202 }, { name: 'collector', host: collectorIp, port: 4203 },
  ], files: protectedFiles, http: [
    { name: 'unsigned', url: 'http://gateway:4201/execute', body: { body: {}, mac: 'untrusted-reference-value' } },
    { name: 'owner', url: 'http://gateway:4200/api/status' },
  ] });
  const positiveFiles = {};
  for (const role of ['gateway', 'origin', 'collector']) {
    const own = protectedFiles.filter((file) => file.name.startsWith(role) || role === 'gateway' && ['canonical-db', 'ticket-key'].includes(file.name));
    positiveFiles[role] = await probe(containers[role], { files: own });
  }
  check('canonical-reachable', facadeProbe.tcp.canonical?.connected === true, facadeProbe.tcp.canonical);
  check('origin-direct-ip-blocked', facadeProbe.tcp.origin?.connected === false, facadeProbe.tcp.origin);
  check('collector-direct-ip-blocked', facadeProbe.tcp.collector?.connected === false, facadeProbe.tcp.collector);
  check('private-files-inaccessible', Object.values(facadeProbe.files).length === protectedFiles.length
    && Object.values(facadeProbe.files).every((file) => file.readable === false), facadeProbe.files);
  check('private-files-positive-control', Object.values(positiveFiles).flatMap((value) => Object.values(value.files)).length === protectedFiles.length
    && Object.values(positiveFiles).flatMap((value) => Object.values(value.files)).every((file) => file.readable === true), positiveFiles);
  check('unsigned-canonical-rejected', facadeProbe.http.unsigned?.status === 400 && facadeProbe.http.unsigned.code === 'PROOF_REJECTED', facadeProbe.http.unsigned);
  check('control-api-rejected', facadeProbe.http.owner?.status === 401, facadeProbe.http.owner);
  const api = (path, credential, payload) => gatewayApi(containers.gateway, path, credential, payload);
  const before = await api('/api/evidence', 'owner');
  const syntheticId = `isolation-synthetic-${randomUUID()}`;
  const ordinaryId = `isolation-ordinary-${randomUUID()}`;
  const synthetic = await api('/api/operate', 'actor', { requestId: syntheticId, operation: 'snapshot', args: {} });
  const ordinary = await api('/api/operate', 'ordinary', { requestId: ordinaryId, operation: 'snapshot', args: {} });
  const evidence = await api('/api/evidence', 'owner');
  const correlate = (requestId, contextId, destination) => evidence.events?.filter((event) => event.requestId === requestId
    && event.contextId === contextId && event.destination === destination && event.outcome === 'SERVED').length === 1;
  check('synthetic-operation-correlated', synthetic._route?.proofVerified === true && synthetic._route?.destination === 'SYNTHETIC'
    && correlate(syntheticId, 'diverted', 'SYNTHETIC'), { requestId: syntheticId, route: synthetic._route });
  check('ordinary-operation-correlated', ordinary._route?.destination === 'ORIGIN' && correlate(ordinaryId, 'ordinary', 'ORIGIN'), { requestId: ordinaryId, route: ordinary._route });
  const first = before.scope?.witness; const last = evidence.scope?.witness;
  check('origin-witness-continuity', first && last && first.stateDigest === last.stateDigest && first.configDigest === last.configDigest
    && last.accepted === first.accepted + 1 && last.rejected === first.rejected && last.acceptedContexts.every((context) => context === 'ordinary'), { before: first, after: last });
  check('gateway-evidence-complete', evidence.status === 'PASS' && ['canonical-replay', 'origin-state-unchanged', 'no-diverted-origin-admission',
    'independent-route-census', 'ordinary-admission-census', 'dispatch-outcomes-known', 'real-diversion-observed'].every((id) => evidence.checks?.some((item) => item.id === id && item.status === 'PASS')), evidence.checks);
  const result = { schemaVersion: REFERENCE_VERSION, observedAt: new Date().toISOString(), context: DOCKER_CONTEXT, project: manifest.project,
    sourceDigest: manifest.sourceDigest, images: Object.values(images), ...evaluateIsolation(checks),
    facts: { containers: Object.fromEntries(roles.map((role) => [role, { id: containers[role].Id, image: containers[role].Image,
      user: containers[role].Config.User, running: containers[role].State.Running, readOnlyRoot: containers[role].HostConfig.ReadonlyRootfs,
      privileged: containers[role].HostConfig.Privileged, capDrop: containers[role].HostConfig.CapDrop, securityOpt: containers[role].HostConfig.SecurityOpt,
      memoryBytes: containers[role].HostConfig.Memory, pidsLimit: containers[role].HostConfig.PidsLimit, nanoCpus: containers[role].HostConfig.NanoCpus,
      publishedPorts: containers[role].NetworkSettings.Ports,
      networks: Object.keys(containers[role].NetworkSettings.Networks), mounts: containers[role].Mounts.map(({ Type, Name, Destination, RW }) => ({ Type, Name, Destination, RW })) }])),
      networks: Object.fromEntries(Object.entries(networks).map(([name, network]) => [name, { id: network.Id, internal: network.Internal }])), facadeProbe, positiveFiles,
      gatewayEvidence: { schemaVersion: evidence.schemaVersion, status: evidence.status, sha256: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
        eventCount: evidence.events.length, eventIds: evidence.events.map((event) => event.eventId),
        observedEvents: evidence.events.filter((event) => [syntheticId, ordinaryId].includes(event.requestId)), canonicalVerifier: evidence.canonical?.verifier } },
    limitations: ['Disposable artificial reference only; no production assets were admitted.', 'Containers share one dedicated Linux VM kernel; this is not separate-VM isolation or a container-escape assessment.',
      'The Docker administrator remains trusted.', 'TCP denials and mount readbacks are point-in-time observations; no external destination was probed.',
      'SSH and PostgreSQL remain gateway-loopback adapters; no external PostgreSQL TLS claim.'] };
  privateWrite(join(directory, 'isolation-result.json'), result, 'w');
  return result;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  insist(['prepare', 'build', 'up', 'verify', 'down'].includes(command), 'USAGE_PREPARE_BUILD_UP_VERIFY_DOWN');
  insist(rest.length === 0 || rest.length === 2 && rest[0] === '--directory', 'DIRECTORY_ARGUMENT_REQUIRED');
  const directory = rest[1];
  if (command !== 'prepare') insist(directory, 'DIRECTORY_ARGUMENT_REQUIRED');
  const result = command === 'prepare' ? prepareReference({ directory }) : await ({ build: buildReference, up: startReference, verify: verifyReference, down: stopReference }[command])(directory);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (command === 'verify' && result.status !== 'PASS') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  process.stderr.write(JSON.stringify({ status: 'INCONCLUSIVE', code: error.code ?? 'REFERENCE_FAILED', detail: error.detail }) + '\n'); process.exitCode = 1;
});
