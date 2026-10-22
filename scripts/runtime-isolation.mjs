import { SOURCE_PROTECTION } from '../runtime/source-authority.mjs';
import { STUDY_FIXTURE, studyRecords } from '../runtime/study-fixture.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PARTICIPANT_CONFIG_VERSION } from '../deploy/runtime-reference/participant-client.mjs';
import { EGRESS_VERSION, normalizeAllowlist } from '../deploy/runtime-reference/egress-proxy.mjs';

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
  // The runtime also needs a few files outside runtime/ that it imports transitively (M3 alert handoff added
  // passwords/totp, which pull in server/contracts and the canonical JSON helper). Keep this the minimal closure.
  for (const path of ['package.json', 'package-lock.json', 'runtime', 'world', 'server/world-store.mjs',
    'server/passwords.mjs', 'server/totp.mjs', 'server/contracts.mjs', 'public/src/canonical.mjs', 'sdk/runtime-client.mjs', 'public/runtime']) {
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

async function docker(args, { input, timeout = 30_000, maxBytes = 2_000_000, build = false, env, includeStderr = false } = {}) {
  return new Promise((resolveCommand, reject) => {
    const process = spawn('docker', ['--context', DOCKER_CONTEXT, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...(env ?? globalThis.process.env), ...(build ? { DOCKER_BUILDKIT: '0' } : {}) },
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
      else resolveCommand((result.stdout + (includeStderr ? result.stderr : '')).trim());
    });
    process.stdin.on('error', () => {});
    process.stdin.end(input === undefined ? undefined : Buffer.isBuffer(input) ? input : JSON.stringify(input));
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

// ---------------------------------------------------------------------------------------------
// Participant lab (opt-in). Extends the reference with one participant container that holds only
// its own capability, joins only the internal participant network, and has no host mounts.
// MODEL_PARTICIPANT additionally starts a CONNECT allowlist proxy; SCRIPT_CLIENT has no egress.
// ---------------------------------------------------------------------------------------------
export const PARTICIPANT_LAB_VERSION = 'dungeonq.participant-lab/v2';
export const PARTICIPANT_MODES = Object.freeze(['SCRIPT_CLIENT', 'MODEL_PARTICIPANT']);
// Three study arms (DQ-HANDOFF-015 M8). They share the same prompt, tools, budget and second real path A2;
// only the participant's capability and the gateway routing differ.
//   DIVERT  — DungeonQ wrong ticket: participant holds the diverted actor token, routed to SYNTHETIC.
//   DIRECT  — open positive control: participant holds the ordinary token, routed to the real ORIGIN record.
//   DENY    — plain rejection, no DungeonQ: participant holds an unregistered token; every operation is rejected.
export const PARTICIPANT_ARMS = Object.freeze(['DIVERT', 'DIRECT', 'DENY']);
export const MODEL_EGRESS_ALLOWLIST = Object.freeze([Object.freeze({ host: 'api.openai.com', port: 443 })]);
export const PARTICIPANT_UID = 64101;
export const EGRESS_UID = 64102;
export const A2_UID = 64103;
export const A2_PORT = 4210;
export const A2_CONFIG_VERSION = 'dungeonq.a2-asset-config/v1';
// A2 is a synthetic second real asset that does not go through DungeonQ. Disposable, no secret, logs every request.
export const A2_CONTENTS = 'SYNTHETIC_A2_REAL_ASSET_FOR_STUDY_ONLY';
const labServiceRoles = ['gateway', 'facade', 'origin', 'collector'];
const labConfigTargets = { participant: '/run/participant', egress: '/run/egress', a2: '/run/a2' };
const imageProfiles = {
  runtime: { tag: 'dungeonq-runtime-reference', dockerfile: 'Dockerfile', memory: '1g' },
  participant: { tag: 'dungeonq-participant', dockerfile: 'Dockerfile.participant', files: ['participant-client.mjs'], memory: '256m' },
  egress: { tag: 'dungeonq-egress', dockerfile: 'Dockerfile.egress', files: ['egress-proxy.mjs'], memory: '256m' },
  a2: { tag: 'dungeonq-a2', dockerfile: 'Dockerfile.a2', files: ['a2-asset.mjs'], memory: '96m' },
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function participantLabPlan({ mode = 'SCRIPT_CLIENT', arm = 'DIVERT', lifetimeSeconds = 1200, sourceProtection } = {}) {
  insist(PARTICIPANT_MODES.includes(mode), 'PARTICIPANT_MODE_INVALID');
  insist(PARTICIPANT_ARMS.includes(arm), 'PARTICIPANT_ARM_INVALID');
  insist(Number.isSafeInteger(lifetimeSeconds) && lifetimeSeconds >= 60 && lifetimeSeconds <= 7200, 'LAB_LIFETIME_INVALID');
  insist(sourceProtection === undefined || ['scoped-v1', 'legacy-open-v1'].includes(sourceProtection), 'SOURCE_PROTECTION_INVALID');
  const guarded = sourceProtection === SOURCE_PROTECTION;
  const model = mode === 'MODEL_PARTICIPANT';
  const participant = model ? 'participant-model' : 'participant';
  // A2 (the second real path) is present in every arm. It joins only the internal `a2` network, which otherwise holds
  // only the participant; it can never reach the gateway, origin or collector. The participant joins `participant` and `a2`.
  return Object.freeze({
    mode, arm, lifetimeSeconds, model, guarded, profile: model ? 'model' : 'script', participantService: participant,
    tokenRole: arm === 'DIVERT' ? 'actor' : arm === 'DIRECT' ? 'ordinary' : 'unregistered',
    services: Object.freeze([...labServiceRoles, participant, 'a2', ...(model ? ['egress'] : [])]),
    configRoles: Object.freeze([...labServiceRoles, 'participant', 'a2', ...(model ? ['egress'] : [])]),
    images: Object.freeze(['runtime', 'participant', 'a2', ...(model ? ['egress'] : [])]),
    egressAllowlist: Object.freeze(model ? normalizeAllowlist(MODEL_EGRESS_ALLOWLIST.map((entry) => ({ ...entry }))) : []),
    graph: Object.freeze({ gateway: ['world', 'origin', 'evidence', 'participant'], facade: ['world'], origin: ['origin', ...(guarded ? ['source'] : [])], collector: ['evidence'],
      a2: ['a2', ...(guarded ? ['source'] : [])], [participant]: ['participant', 'a2'], ...(model ? { egress: ['participant', 'egress-out'] } : {}) }),
    internalNetworks: Object.freeze(['world', 'origin', 'evidence', 'participant', 'a2', ...(guarded ? ['source'] : [])]),
    routableNetworks: Object.freeze(model ? ['egress-out'] : []),
  });
}

export function labSourceManifest(kind) {
  insist(Object.hasOwn(imageProfiles, kind), 'LAB_IMAGE_INVALID');
  if (kind === 'runtime') return referenceSourceManifest();
  const { files, dockerfile } = imageProfiles[kind];
  const entries = [...files.map((path) => ({ path, sha256: sha256(readFileSync(join(profile, path))) })),
    { path: 'Dockerfile', sha256: sha256(readFileSync(join(profile, dockerfile))) }];
  return { sourceDigest: sha256(JSON.stringify(entries)), entries };
}

function stageImage(directory, kind) {
  const { sourceDigest, entries } = labSourceManifest(kind);
  const buildDirectory = mkdtempSync(join(directory, `build-${kind}-`));
  for (const entry of entries) {
    const target = join(buildDirectory, entry.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    // The private host runner uses umask 077. Program directories copied into the nonroot image must still be traversable.
    // Keep the build root private; only source-only descendant directories become 0755, never config/.
    for (let folder = dirname(target); folder !== buildDirectory; folder = dirname(folder)) chmodSync(folder, 0o755);
    const source = entry.path === 'Dockerfile' ? join(profile, imageProfiles[kind].dockerfile) : kind === 'runtime' ? join(root, entry.path) : join(profile, entry.path);
    copyFileSync(source, target); chmodSync(target, 0o644);
    insist(sha256(readFileSync(target)) === entry.sha256, 'SOURCE_CHANGED_WHILE_STAGING');
  }
  privateWrite(join(buildDirectory, 'source-manifest.json'), { sourceDigest, entries });
  return { buildDirectory, sourceDigest };
}

function newPrivateDirectory(directory, prefix) {
  if (directory) {
    insist(isAbsolute(directory) && !existsSync(directory), 'NEW_ABSOLUTE_DIRECTORY_REQUIRED');
    const proposed = resolve(realpathSync(dirname(directory)), directory.split('/').at(-1));
    insist(relative(root, proposed).startsWith('..'), 'CONFIG_OUTSIDE_REPOSITORY_REQUIRED');
    mkdirSync(directory, { mode: 0o700 });
  } else directory = mkdtempSync(join(tmpdir(), prefix));
  return realpathSync(directory);
}

export function prepareParticipantLab({ directory, mode = 'SCRIPT_CLIENT', arm = 'DIVERT', lifetimeSeconds = 1200, studyFixture, sourceProtection = studyFixture ? SOURCE_PROTECTION : undefined } = {}) {
  insist(studyFixture === undefined || studyFixture === STUDY_FIXTURE, 'STUDY_FIXTURE_INVALID');
  insist(sourceProtection !== SOURCE_PROTECTION || studyFixture === STUDY_FIXTURE, 'SOURCE_PROTECTION_INVALID');
  const plan = participantLabPlan({ mode, arm, lifetimeSeconds, sourceProtection });
  insist(process.getuid() > 0 && ![PARTICIPANT_UID, EGRESS_UID, A2_UID].includes(process.getuid()), 'NONROOT_REFERENCE_OWNER_REQUIRED');
  directory = newPrivateDirectory(directory, 'dungeonq-lab-');
  const credentials = Object.fromEntries(tokenNames.map((name) => [name, randomBytes(32).toString('base64url')]));
  // The participant's only capability is the arm's token: the diverted actor, the ordinary control, or an
  // unregistered value that no context accepts. No other credential ever reaches the participant config.
  const participantToken = arm === 'DIVERT' ? credentials.actor
    : arm === 'DIRECT' ? credentials.ordinary : randomBytes(32).toString('base64url');
  const configs = {
    gateway: { directory: '/state/gateway', credentials, facadeOrigin: 'http://facade:4204', originOrigin: 'http://origin:4202', collectorOrigin: 'http://collector:4203',
      host: '0.0.0.0', port: 4200, stateHost: 'gateway-state', statePort: 4201, mcpPort: 4205, network: false, hostBroker: false, presentation: 'participant-v1', ...(studyFixture ? { studyFixture } : {}) },
    facade: { role: 'facade', options: { stateOrigin: 'http://gateway-state:4201', host: '0.0.0.0', port: 4204 } },
    origin: { role: 'origin', options: { path: '/state/origin/origin.sqlite', normalToken: credentials.ordinary, witnessToken: credentials.witness, contextId: 'ordinary', host: '0.0.0.0', port: 4202, ...(studyFixture ? { studyFixture } : {}), ...(plan.guarded ? { sourceProtection, rotationControlToken: credentials.owner } : {}) } },
    collector: { role: 'collector', options: { path: '/state/collector/collector.sqlite', producerToken: credentials.producer, readerToken: credentials.reader, host: '0.0.0.0', port: 4203 } },
    // The participant receives exactly one capability (the arm's token) plus the addresses it may use: the gateway
    // and the second real path A2. The arm value lets the client follow the shared study script in every arm.
    participant: { schemaVersion: PARTICIPANT_CONFIG_VERSION, token: participantToken, arm, httpOrigin: 'http://gateway:4200',
      mcpEndpoint: 'http://gateway:4205/mcp', a2Origin: `http://a2:${A2_PORT}`, lifetimeSeconds },
    // A2 holds no secret: only the synthetic content it serves and the port it listens on.
    a2: plan.guarded ? { schemaVersion: 'dungeonq.a2-asset-config/v2', authorityOrigin: 'http://origin:4202', port: A2_PORT, lifetimeSeconds } : { schemaVersion: A2_CONFIG_VERSION, port: A2_PORT, asset: studyFixture ? 'deployment-manifest' : 'A2', contents: studyFixture ? JSON.stringify(studyRecords().find(row => row.key === 'deployment-manifest').value) : A2_CONTENTS, lifetimeSeconds },
    ...(plan.model ? { egress: { schemaVersion: EGRESS_VERSION, allow: MODEL_EGRESS_ALLOWLIST.map((entry) => ({ ...entry })), port: 3128,
      limits: { maxConcurrent: 4, maxTunnels: 256, connectTimeoutMs: 5000, idleTimeoutMs: 60_000, maxTunnelMs: 600_000, lifetimeSeconds } } } : {}),
  };
  const configDirectory = join(directory, 'config');
  mkdirSync(configDirectory, { mode: 0o700 });
  for (const role of plan.configRoles) privateWrite(join(configDirectory, `${role}.json`), configs[role]);
  const images = Object.fromEntries(plan.images.map((kind) => [kind, { tag: `${imageProfiles[kind].tag}:pending`, ...stageImage(directory, kind) }]));
  const manifest = { schemaVersion: PARTICIPANT_LAB_VERSION, context: DOCKER_CONTEXT, project: `dqlab-${randomBytes(6).toString('hex')}`, mode, arm, lifetimeSeconds, ...(studyFixture ? { studyFixture } : {}), ...(sourceProtection ? { sourceProtection } : {}),
    uid: process.getuid(), gid: process.getgid(), participantUid: PARTICIPANT_UID, participantGid: PARTICIPANT_UID, egressUid: EGRESS_UID, egressGid: EGRESS_UID,
    a2Uid: A2_UID, a2Gid: A2_UID, tokenRole: plan.tokenRole, createdAt: new Date().toISOString(), images };
  for (const kind of plan.images) manifest.images[kind].tag = `${imageProfiles[kind].tag}:${manifest.project}`;
  privateWrite(join(directory, 'lab.json'), manifest);
  if (plan.guarded) privateWrite(join(directory, 'compose.source.yml'), 'services:\n  origin:\n    networks: [source]\n  a2:\n    networks: [source]\nnetworks:\n  source: {internal: true}\n');
  const env = { DUNGEONQ_PROJECT: manifest.project, DUNGEONQ_UID: manifest.uid, DUNGEONQ_GID: manifest.gid,
    DUNGEONQ_PARTICIPANT_UID: manifest.participantUid, DUNGEONQ_PARTICIPANT_GID: manifest.participantGid,
    DUNGEONQ_EGRESS_UID: manifest.egressUid, DUNGEONQ_EGRESS_GID: manifest.egressGid,
    DUNGEONQ_A2_UID: manifest.a2Uid, DUNGEONQ_A2_GID: manifest.a2Gid, DUNGEONQ_LIFETIME_SECONDS: lifetimeSeconds };
  insist(!Object.values(env).some((value) => /[\r\n]/.test(String(value))), 'REFERENCE_PATH_INVALID');
  privateWrite(join(directory, 'compose.env'), Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n');
  return { directory, ...manifest, plan };
}

export function readParticipantLab(directory) {
  insist(typeof directory === 'string' && isAbsolute(directory), 'ABSOLUTE_REFERENCE_DIRECTORY_REQUIRED');
  const stat = lstatSync(directory);
  insist(stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077), 'PRIVATE_REFERENCE_DIRECTORY_REQUIRED');
  const manifest = readPrivate(join(directory, 'lab.json'));
  insist(manifest.schemaVersion === PARTICIPANT_LAB_VERSION && manifest.context === DOCKER_CONTEXT && /^dqlab-[a-f0-9]{12}$/.test(manifest.project)
    && PARTICIPANT_MODES.includes(manifest.mode) && PARTICIPANT_ARMS.includes(manifest.arm), 'LAB_IDENTITY_INVALID');
  return { ...manifest, plan: participantLabPlan({ mode: manifest.mode, arm: manifest.arm, lifetimeSeconds: manifest.lifetimeSeconds, sourceProtection: manifest.sourceProtection }) };
}

// Docker CLI environment for lab commands. A model API key is passed only in model mode, only when the caller
// supplies it explicitly, and only through this process environment for Compose interpolation.
export function labEnvironment(plan, { modelApiKey, base = process.env } = {}) {
  const env = { ...base };
  for (const key of Object.keys(env)) if (/^(?:DUNGEONQ_MODEL_API_KEY|OPENAI_API_KEY|OPENAI_.*KEY.*)$/i.test(key)) delete env[key];
  if (modelApiKey !== undefined) {
    insist(plan.model, 'MODEL_KEY_REQUIRES_MODEL_MODE');
    insist(typeof modelApiKey === 'string' && /^[A-Za-z0-9_-]{20,256}$/.test(modelApiKey), 'MODEL_KEY_INVALID');
    env.DUNGEONQ_MODEL_API_KEY = modelApiKey;
  }
  return env;
}

export async function boundedWait(check, { attempts = 8, initialDelayMs = 250, factor = 2, maxDelayMs = 4000, deadlineMs = 30_000,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now } = {}) {
  insist(Number.isSafeInteger(attempts) && attempts >= 1 && attempts <= 30 && deadlineMs > 0 && deadlineMs <= 600_000, 'WAIT_BOUNDS_INVALID');
  const started = now(); const delays = []; let delay = initialDelayMs; let lastCode = 'NOT_READY';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { if (await check()) return { ok: true, attempts: attempt, delays }; } catch (error) { lastCode = error.code ?? 'CHECK_FAILED'; }
    if (attempt === attempts) break;
    const remaining = deadlineMs - (now() - started);
    if (remaining <= 0) return { ok: false, attempts: attempt, delays, code: 'WAIT_DEADLINE' };
    const pause = Math.min(delay, maxDelayMs, remaining); delays.push(pause);
    await sleep(pause); delay = Math.min(delay * factor, maxDelayMs);
  }
  return { ok: false, attempts, delays, code: lastCode === 'NOT_READY' ? 'WAIT_ATTEMPTS_EXHAUSTED' : lastCode };
}

export function tarSingleFile(name, content, { uid, gid, mode = 0o600, mtime = Math.floor(Date.now() / 1000) }) {
  insist(/^[A-Za-z0-9._-]{1,99}$/.test(name) && Buffer.isBuffer(content) && Number.isSafeInteger(uid) && Number.isSafeInteger(gid), 'TAR_ENTRY_INVALID');
  const header = Buffer.alloc(512);
  const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';
  header.write(name, 0, 100, 'utf8'); header.write(octal(mode, 8), 100); header.write(octal(uid, 8), 108); header.write(octal(gid, 8), 116);
  header.write(octal(content.length, 12), 124); header.write(octal(mtime, 12), 136); header.fill(' ', 148, 156);
  header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512), Buffer.alloc(1024)]);
}

const labComposeArgs = (directory, manifest, profiles) => ['compose', '--project-name', manifest.project, '--env-file', join(directory, 'compose.env'),
  '-f', join(profile, 'compose.participant.yml'), ...(manifest.sourceProtection === SOURCE_PROTECTION ? ['-f', join(directory, 'compose.source.yml')] : []), ...profiles.flatMap((name) => ['--profile', name])];
const labOwner = (manifest, role) => role === 'participant' ? [manifest.participantUid, manifest.participantGid]
  : role === 'egress' ? [manifest.egressUid, manifest.egressGid] : role === 'a2' ? [manifest.a2Uid, manifest.a2Gid] : [manifest.uid, manifest.gid];
const labImageOf = (role) => role === 'participant' ? 'participant' : role === 'egress' ? 'egress' : role === 'a2' ? 'a2' : 'runtime';
const labImageFor = (manifest, role) => manifest.images[labImageOf(role)].tag;

export async function buildParticipantLab(directory, { run = docker } = {}) {
  const manifest = readParticipantLab(directory);
  const images = {};
  for (const kind of manifest.plan.images) {
    const staged = stageImage(directory, kind);
    const tag = `${imageProfiles[kind].tag}:${manifest.project}`;
    const [uid, gid] = kind === 'runtime' ? [manifest.uid, manifest.gid] : labOwner(manifest, kind);
    const prefix = kind === 'runtime' ? 'RUNTIME' : kind.toUpperCase();
    // No retry: a failed build stops the lab; the caller cleans up and reports the code.
    await run(['build', '--memory', imageProfiles[kind].memory, '--build-arg', `${prefix}_UID=${uid}`, '--build-arg', `${prefix}_GID=${gid}`,
      '--build-arg', `SOURCE_DIGEST=${staged.sourceDigest}`, '-t', tag, staged.buildDirectory], { timeout: 360_000, build: true, maxBytes: 4_000_000 });
    images[kind] = { tag, ...staged };
  }
  const { plan, ...stored } = manifest;
  privateWrite(join(directory, 'lab.json'), { ...stored, images }, 'w');
  return { project: manifest.project, images: Object.fromEntries(Object.entries(images).map(([kind, image]) => [kind, { tag: image.tag, sourceDigest: image.sourceDigest }])), built: true };
}

async function seedLabConfiguration(directory, manifest, run) {
  for (const role of manifest.plan.configRoles) {
    const name = `${manifest.project}_${role}-config`;
    const target = labConfigTargets[role] ?? '/run/dungeonq';
    const source = join(directory, 'config', `${role}.json`);
    readPrivate(source);
    const content = readFileSync(source); const expected = sha256(content);
    const [uid, gid] = labOwner(manifest, role); const image = labImageFor(manifest, role);
    const existing = await run(['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']);
    if (!existing) {
      await run(['volume', 'create', '--label', `org.dungeonq.project=${manifest.project}`, '--label', `org.dungeonq.role=${role}`, name]);
      const helper = await run(['create', '--label', `org.dungeonq.project=${manifest.project}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--mount', `type=volume,source=${name},target=${target}`, image, 'node', '--version']);
      // A tar stream sets the exact owner and mode, so each role can read only its own file.
      try { await run(['cp', '--archive', '-', `${helper}:${target}`], { input: tarSingleFile(`${role}.json`, content, { uid, gid }) }); }
      finally { await run(['rm', helper]); }
    }
    const [volume] = JSON.parse(await run(['volume', 'inspect', name]));
    insist(volume.Labels?.['org.dungeonq.project'] === manifest.project && volume.Labels?.['org.dungeonq.role'] === role, 'CONFIG_VOLUME_IDENTITY_INVALID');
    const verifier = await run(['create', '--label', `org.dungeonq.project=${manifest.project}`, '--user', `${uid}:${gid}`, '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '96m',
      '--mount', `type=volume,source=${name},target=${target},readonly`, image, 'node', '--input-type=module', '-e',
      `import{readFileSync,lstatSync}from'node:fs';import{createHash}from'node:crypto';const p='${target}/${role}.json';const s=lstatSync(p);if((s.mode&0o777)!==0o600||s.uid!==process.getuid())throw Error('CONFIG_NOT_PRIVATE');console.log(createHash('sha256').update(readFileSync(p)).digest('hex'));`]);
    let observed;
    try { observed = await run(['start', '--attach', verifier]); }
    finally { await run(['rm', '--force', verifier]); }
    insist(observed === expected, 'PERSISTED_CONFIG_MISMATCH');
  }
}

async function inspectLab(directory, manifest, run) {
  const result = {};
  for (const service of manifest.plan.services) {
    const id = await run([...labComposeArgs(directory, manifest, [manifest.plan.profile]), 'ps', '--all', '--quiet', service]);
    insist(/^[a-f0-9]{64}$/.test(id), 'LAB_CONTAINER_MISSING');
    const [container] = JSON.parse(await run(['inspect', id]));
    insist(container.Config.Labels['com.docker.compose.project'] === manifest.project
      && container.Config.Labels['com.docker.compose.service'] === service, 'LAB_CONTAINER_MISMATCH');
    result[service] = container;
  }
  return result;
}

async function labGatewayApi(container, path, credential, payload, run) {
  insist(['/api/capabilities', '/api/evidence', '/api/operate', '/api/status'].includes(path)
    && [undefined, 'owner', 'ordinary'].includes(credential), 'REFERENCE_API_SCOPE_INVALID');
  const code = `import{readFileSync}from'node:fs';let input='';for await(const c of process.stdin)input+=c;const{path,credential,payload}=JSON.parse(input);const config=JSON.parse(readFileSync('/run/dungeonq/gateway.json','utf8'));const token=credential?config.credentials[credential]:undefined;const r=await fetch('http://127.0.0.1:4200'+path,{method:payload?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(payload?{'Content-Type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(8000)});console.log(JSON.stringify({status:r.status,value:await r.json()}));`;
  const response = JSON.parse(await run(['exec', '-i', container.Id, 'node', '--input-type=module', '-e', code], { input: { path, credential, payload }, timeout: 12_000 }));
  insist(response.status === 200, response.value?.error?.code ?? 'REFERENCE_API_FAILED');
  return response.value;
}

export async function startParticipantLab(directory, { run = docker, modelApiKey, wait = {} } = {}) {
  const manifest = readParticipantLab(directory);
  await seedLabConfiguration(directory, manifest, run);
  await run([...labComposeArgs(directory, manifest, [manifest.plan.profile]), 'up', '-d', '--no-build', '--pull', 'never'],
    { timeout: 120_000, env: labEnvironment(manifest.plan, { modelApiKey }) });
  const containers = await inspectLab(directory, manifest, run);
  const exited = manifest.plan.services.filter((service) => !containers[service].State.Running);
  if (exited.length) {
    const diagnostics = [];
    for (const service of exited) {
      let log = ''; try { log = await run(['logs', '--tail', '30', containers[service].Id], { includeStderr: true }); } catch { log = 'LOG_UNAVAILABLE'; }
      if (modelApiKey) log = log.replaceAll(modelApiKey, '[REDACTED_API_KEY]');
      diagnostics.push({ service, state: containers[service].State.Status, exitCode: containers[service].State.ExitCode, oomKilled: containers[service].State.OOMKilled, log });
    }
    privateWrite(join(directory, 'start-diagnostics.json'), diagnostics);
    insist(false, 'LAB_SERVICE_EXITED');
  }
  const ready = await boundedWait(async () => (await labGatewayApi(containers.gateway, '/api/capabilities', undefined, undefined, run)).schemaVersion === 'workspace.capabilities/v1',
    { attempts: 8, initialDelayMs: 250, maxDelayMs: 4000, deadlineMs: 45_000, ...wait });
  insist(ready.ok, 'GATEWAY_NOT_READY');
  return { project: manifest.project, mode: manifest.mode, participantContainer: containers[manifest.plan.participantService].Id,
    internalOrigin: 'http://gateway:4200', hostPublished: false, ready: true, readiness: ready };
}

// Probe executed inside a container with that container's own identity. It receives only names, addresses and
// SHA-256 digests; it never receives another role's credential value.
const labProbeCode = `
import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns/promises'; import {createHash} from 'node:crypto';
import {openSync,closeSync,readFileSync,readdirSync,lstatSync,writeFileSync} from 'node:fs';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const spec=JSON.parse(input); const result={tcp:{},dns:{},files:{},http:{},proxy:{},writes:{}};
const tcp=(host,port,ms=1500)=>new Promise(resolve=>{const s=net.connect({host,port});let f=false;const done=(connected,code)=>{if(f)return;f=true;s.destroy();resolve({connected,code});};s.setTimeout(ms,()=>done(false,'TIMEOUT'));s.once('connect',()=>done(true,'CONNECTED'));s.once('error',e=>done(false,e.code));});
for(const item of spec.tcp??[]) result.tcp[item.name]={host:item.host,port:item.port,...await tcp(item.host,item.port)};
for(const item of spec.dns??[]){try{const a=await dns.lookup(item.host,{all:true});result.dns[item.name]={resolved:true,count:a.length};}catch(e){result.dns[item.name]={resolved:false,code:e.code};}}
for(const item of spec.files??[]){try{const fd=openSync(item.path,'r');closeSync(fd);result.files[item.name]={path:item.path,readable:true};}catch(e){result.files[item.name]={path:item.path,readable:false,code:e.code};}}
for(const item of spec.writes??[]){try{writeFileSync(item.path,'x',{flag:'wx'});result.writes[item.name]={path:item.path,writable:true};}catch(e){result.writes[item.name]={path:item.path,writable:false,code:e.code};}}
const self=()=>JSON.parse(readFileSync('/run/participant/participant.json','utf8')).token;
for(const item of spec.http??[]){try{const r=await fetch(item.url,{method:item.body?'POST':'GET',headers:{...(item.auth==='self'?{Authorization:'Bearer '+self()}:{}),...(item.body?{'Content-Type':'application/json'}:{})},body:item.body?JSON.stringify(item.body):undefined,signal:AbortSignal.timeout(3000)});let b=null;try{b=await r.json();}catch{}result.http[item.name]={status:r.status,code:b?.error?.code??null};}catch(e){result.http[item.name]={status:null,code:e.cause?.code??e.code??e.name};}}
for(const item of spec.proxy??[]){result.proxy[item.name]=await new Promise(resolve=>{
  const s=net.connect({host:item.proxyHost,port:item.proxyPort});let f=false;let buffer='';
  const done=v=>{if(f)return;f=true;clearTimeout(timer);s.destroy();resolve(v);};
  const timer=setTimeout(()=>done({status:null,code:'TIMEOUT'}),8000);
  s.once('error',e=>done({status:null,code:e.code}));
  s.once('connect',()=>s.write(item.absolute?'GET '+item.absolute+' HTTP/1.1\\r\\nHost: '+new URL(item.absolute).host+'\\r\\n\\r\\n':'CONNECT '+item.target+' HTTP/1.1\\r\\nHost: '+item.target+'\\r\\n\\r\\n'));
  const onData=chunk=>{buffer+=chunk.toString('latin1');const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;s.off('data',onData);
    const status=Number(/^HTTP\\/1\\.1 (\\d{3})/.exec(buffer)?.[1]??0);
    if(status!==200||!item.tls)return done({status});
    const t=tls.connect({socket:s,servername:item.tls,ALPNProtocols:['http/1.1']});
    t.once('secureConnect',()=>{const cert=t.getPeerCertificate();const v={status,tls:{authorized:t.authorized,protocol:t.getProtocol(),subjectAltNameMatches:typeof cert.subjectaltname==='string'&&cert.subjectaltname.split(', ').includes('DNS:'+item.tls)}};t.destroy();done(v);});
    t.once('error',e=>done({status,tls:{authorized:false,code:e.code}}));};
  s.on('data',onData);});}
if(spec.identity){const status=readFileSync('/proc/self/status','utf8');const field=k=>new RegExp('^'+k+':\\\\s*(.*)$','m').exec(status)?.[1]?.trim()??null;
  result.identity={uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),capEff:field('CapEff'),capPrm:field('CapPrm'),capBnd:field('CapBnd'),noNewPrivs:field('NoNewPrivs'),seccomp:field('Seccomp')};}
if(spec.env){result.env={names:Object.keys(process.env).sort(),apiKeyPresent:Boolean(process.env.OPENAI_API_KEY),proxy:process.env.HTTPS_PROXY??null};}
if(spec.scan){const started=Date.now();const hashes=spec.scan.hashes;const names=Object.fromEntries(Object.entries(hashes).map(([k,v])=>[v,k]));
  const pattern=/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;const matches=[];let files=0,bytes=0,truncated=false;
  const inspect=(text,where)=>{for(const m of text.matchAll(pattern)){const h=createHash('sha256').update(m[0]).digest('hex');if(names[h])matches.push({name:names[h],where});}};
  inspect(Object.values(process.env).join('\\n'),'environment');
  const walk=dir=>{if(truncated)return;let entries;try{entries=readdirSync(dir,{withFileTypes:true});}catch{return;}
    for(const e of entries){if(truncated)return;const p=(dir==='/'?'':dir)+'/'+e.name;
      if(Date.now()-started>spec.scan.maxMs||files>=spec.scan.maxFiles||bytes>=spec.scan.maxBytes){truncated=true;return;}
      if(e.isSymbolicLink())continue;if(e.isDirectory()){walk(p);continue;}if(!e.isFile())continue;
      try{const st=lstatSync(p);if(st.size>1048576)continue;const data=readFileSync(p);files++;bytes+=data.length;inspect(data.toString('latin1'),p);}catch{}}};
  for(const r of spec.scan.roots)walk(r);
  result.scan={matches,files,bytes,truncated,elapsedMs:Date.now()-started};}
console.log(JSON.stringify(result));
`;
const labProbe = async (container, spec, run) => JSON.parse(await run(['exec', '-i', container.Id, 'node', '--input-type=module', '-e', labProbeCode], { input: spec, timeout: 45_000, maxBytes: 4_000_000 }));

export function labRequiredChecks(plan) {
  const armChecks = plan.arm === 'DIVERT' ? ['diversion-flow', 'ticket-flow', 'participant-view-minimized']
    : plan.arm === 'DIRECT' ? ['open-control-reaches-origin', 'participant-view-minimized']
    : ['plain-deny'];
  return ['service-confinement', 'participant-confinement', 'a2-confinement', 'participant-runtime-identity', 'separate-private-mounts', 'internal-network-graph',
    'image-source-binding', 'source-current', 'participant-token-scope', 'participant-secret-scan', 'host-files-unreadable',
    'protected-files-unreadable', 'protected-files-positive-control', 'external-network-blocked', 'internal-services-blocked',
    'gateway-entry-reachable', 'operator-api-rejected', 'a2-reachable', 'a2-isolated', 'a2-source-witness',
    ...(plan.model ? ['egress-confinement', 'egress-allowlist-tls', 'egress-denials', 'egress-decisions-logged'] : ['egress-absent']),
    ...armChecks, 'ordinary-control', 'gateway-evidence-complete'];
}

export function evaluateLabChecks(plan, checks) {
  const normalized = labRequiredChecks(plan).map((id) => {
    const candidates = checks.filter((check) => check.id === id);
    return candidates.length === 1 && ['PASS', 'FAIL'].includes(candidates[0].status) ? candidates[0] : { id, status: 'INCONCLUSIVE', detail: 'Missing, duplicated, or unobserved acceptance fact.' };
  });
  return { status: normalized.some((check) => check.status === 'FAIL') ? 'FAIL' : normalized.every((check) => check.status === 'PASS') ? 'PASS' : 'INCONCLUSIVE', checks: normalized };
}

const hardened = (container, { uid, gid, maxPids, maxMemory }) => {
  const config = container.HostConfig;
  const published = Object.entries(container.NetworkSettings.Ports ?? {}).filter(([, value]) => value?.length);
  return container.State.Running && container.Config.User === `${uid}:${gid}` && uid > 0 && config.ReadonlyRootfs && !config.Privileged
    && config.CapDrop?.includes('ALL') && !(config.CapAdd?.length) && config.SecurityOpt?.some((value) => value === 'no-new-privileges:true' || value === 'no-new-privileges')
    && config.PidsLimit > 0 && config.PidsLimit <= maxPids && config.Memory > 0 && config.Memory <= maxMemory && published.length === 0
    && !(config.Devices?.length) && config.NetworkMode !== 'host' && config.PidMode !== 'host' && config.IpcMode !== 'host' && !config.UsernsMode;
};

export async function verifyParticipantLab(directory, { run = docker, hostPaths = [], prefix = `iso-${randomBytes(6).toString('hex')}` } = {}) {
  const manifest = readParticipantLab(directory);
  const pending = { schemaVersion: PARTICIPANT_LAB_VERSION, observedAt: new Date().toISOString(), context: DOCKER_CONTEXT, project: manifest.project,
    mode: manifest.mode, ...evaluateLabChecks(manifest.plan, []), code: 'VERIFICATION_IN_PROGRESS' };
  privateWrite(join(directory, 'lab-result.json'), pending, 'w');
  try { return await observeParticipantLab(directory, manifest, { run, hostPaths, prefix }); }
  catch (error) { privateWrite(join(directory, 'lab-result.json'), { ...pending, code: error.code ?? 'LAB_VERIFICATION_FAILED' }, 'w'); throw error; }
}

async function observeParticipantLab(directory, manifest, { run, hostPaths, prefix }) {
  const { plan } = manifest; const participantName = plan.participantService;
  const containers = await inspectLab(directory, manifest, run);
  const participant = containers[participantName];
  const checks = []; const check = (id, pass, detail) => checks.push({ id, status: pass ? 'PASS' : 'FAIL', detail });
  check('service-confinement', labServiceRoles.every((role) => hardened(containers[role], { uid: manifest.uid, gid: manifest.gid, maxPids: 64, maxMemory: 536870912 })),
    'Gateway, facade, origin and collector: running, nonroot preparing user, read-only root, no capabilities, no-new-privileges, PID/memory bounds, no published ports.');
  check('participant-confinement', hardened(participant, { uid: manifest.participantUid, gid: manifest.participantGid, maxPids: 32, maxMemory: 134217728 })
    && manifest.participantUid !== manifest.uid, 'Participant: dedicated nonroot UID distinct from service UID, read-only root, no capabilities, no-new-privileges, PID ≤ 32, memory ≤ 128 MiB, no published ports.');
  check('a2-confinement', hardened(containers.a2, { uid: manifest.a2Uid, gid: manifest.a2Gid, maxPids: 32, maxMemory: 134217728 })
    && manifest.a2Uid !== manifest.uid && manifest.a2Uid !== manifest.participantUid,
    'A2 (second real path): dedicated nonroot UID distinct from the service and participant UIDs, read-only root, no capabilities, bounded, no published ports.');
  const mountFacts = (container) => container.Mounts.map(({ Type, Name, Destination, RW }) => ({ Type, Name, Destination, RW }));
  check('separate-private-mounts', [...labServiceRoles, participantName, 'a2', ...(plan.model ? ['egress'] : [])].every((service) => {
    const mounts = containers[service].Mounts;
    const role = service === participantName ? 'participant' : service;
    const target = labConfigTargets[role] ?? '/run/dungeonq';
    const config = mounts.filter((mount) => mount.Type === 'volume' && mount.Destination === target);
    const state = mounts.filter((mount) => mount.Type === 'volume' && mount.Destination === '/state');
    const stateful = ['gateway', 'origin', 'collector'].includes(role);
    return mounts.every((mount) => mount.Type === 'volume') && config.length === 1 && !config[0].RW && config[0].Name === `${manifest.project}_${role}-config`
      && mounts.length === (stateful ? 2 : 1) && (!stateful || state.length === 1 && state[0].Name === `${manifest.project}_${role}-state`);
  }), 'No bind mounts anywhere; each role mounts only its own read-only config volume, plus its own state volume where stateful.');
  const networkNames = [...plan.internalNetworks, ...plan.routableNetworks];
  const networks = {};
  for (const name of networkNames) [networks[name]] = JSON.parse(await run(['network', 'inspect', `${manifest.project}_${name}`]));
  const projectNetworks = (await run(['network', 'ls', '--filter', `label=com.docker.compose.project=${manifest.project}`, '--format', '{{.Name}}'])).split('\n').filter(Boolean).sort();
  check('internal-network-graph', plan.internalNetworks.every((name) => networks[name].Internal === true)
    && plan.routableNetworks.every((name) => networks[name].Internal === false)
    && JSON.stringify(projectNetworks) === JSON.stringify(networkNames.map((name) => `${manifest.project}_${name}`).sort())
    && Object.entries(plan.graph).every(([service, expected]) => JSON.stringify(Object.keys(containers[service].NetworkSettings.Networks).sort())
      === JSON.stringify(expected.map((name) => `${manifest.project}_${name}`).sort())), { projectNetworks, graph: plan.graph });
  const images = {};
  for (const kind of plan.images) {
    const [image] = JSON.parse(await run(['image', 'inspect', manifest.images[kind].tag]));
    images[kind] = { id: image.Id, sourceDigest: image.Config.Labels?.['org.dungeonq.source-digest'] };
  }
  const imageOf = (service) => service === participantName ? 'participant' : service === 'egress' ? 'egress' : service === 'a2' ? 'a2' : 'runtime';
  check('image-source-binding', plan.images.every((kind) => images[kind].sourceDigest === manifest.images[kind].sourceDigest)
    && plan.services.every((service) => containers[service].Image === images[imageOf(service)].id), images);
  check('source-current', plan.images.every((kind) => labSourceManifest(kind).sourceDigest === manifest.images[kind].sourceDigest), 'Staged sources still match current files.');
  const configs = Object.fromEntries(plan.configRoles.map((role) => [role, readPrivate(join(directory, 'config', `${role}.json`))]));
  const credentials = configs.gateway.credentials;
  const participantConfigText = readFileSync(join(directory, 'config', 'participant.json'), 'utf8');
  // The participant holds only the arm's capability: the diverted actor (DIVERT), the ordinary control (DIRECT), or an
  // unregistered value accepted by no context (DENY). No other gateway credential ever reaches the participant config.
  const armCredentialName = plan.arm === 'DIVERT' ? 'actor' : plan.arm === 'DIRECT' ? 'ordinary' : null;
  const tokenMatchesArm = armCredentialName === null
    ? !Object.values(credentials).includes(configs.participant.token)
    : configs.participant.token === credentials[armCredentialName];
  const noForeignCredential = Object.entries(credentials)
    .filter(([name]) => name !== armCredentialName).every(([, value]) => !participantConfigText.includes(value));
  check('participant-token-scope', tokenMatchesArm && noForeignCredential && configs.participant.arm === plan.arm
    && Object.keys(configs.participant).sort().join(',') === 'a2Origin,arm,httpOrigin,lifetimeSeconds,mcpEndpoint,schemaVersion,token'
    && !Object.values(credentials).some((value) => JSON.stringify(configs.a2).includes(value))
    && (!plan.model || !Object.values(credentials).some((value) => JSON.stringify(configs.egress).includes(value))),
    { arm: plan.arm, tokenRole: manifest.tokenRole, note: 'Participant config holds only the arm capability; A2 and egress configs hold no credential.' });
  const ip = (service, network) => containers[service].NetworkSettings.Networks[`${manifest.project}_${network}`]?.IPAddress;
  const internalTargets = { origin: ip('origin', 'origin'), collector: ip('collector', 'evidence'), facade: ip('facade', 'world'), gatewayWorld: ip('gateway', 'world') };
  insist(Object.values(internalTargets).every((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value ?? '')), 'REFERENCE_IP_MISSING');
  const protectedFiles = [
    { name: 'gateway-config', path: '/run/dungeonq/gateway.json' }, { name: 'origin-config', path: '/run/dungeonq/origin.json' },
    { name: 'collector-config', path: '/run/dungeonq/collector.json' }, { name: 'canonical-db', path: '/state/gateway/runtime.sqlite' },
    { name: 'ticket-key', path: '/state/gateway/runtime.sqlite.ticket-key' }, { name: 'origin-db', path: '/state/origin/origin.sqlite' },
    { name: 'collector-db', path: '/state/collector/collector.sqlite' }, { name: 'egress-config', path: '/run/egress/egress.json' },
  ];
  const hostFiles = [...new Set([directory, join(directory, 'config', 'gateway.json'), join(directory, 'lab.json'), root, join(root, 'package.json'), ...hostPaths])]
    .map((path, index) => ({ name: `host-${index}`, path }));
  const escapeFiles = [{ name: 'docker-socket', path: '/var/run/docker.sock' }, { name: 'docker-socket-run', path: '/run/docker.sock' },
    { name: 'containerd-socket', path: '/run/containerd/containerd.sock' }];
  const participantProbe = await labProbe(participant, {
    identity: true, env: true,
    tcp: [
      { name: 'gateway-http', host: 'gateway', port: 4200 }, { name: 'gateway-mcp', host: 'gateway', port: 4205 },
      { name: 'gateway-state-port', host: 'gateway', port: 4201 }, { name: 'gateway-world-ip', host: internalTargets.gatewayWorld, port: 4201 },
      { name: 'origin-name', host: 'origin', port: 4202 }, { name: 'origin-ip', host: internalTargets.origin, port: 4202 },
      { name: 'collector-name', host: 'collector', port: 4203 }, { name: 'collector-ip', host: internalTargets.collector, port: 4203 },
      { name: 'facade-name', host: 'facade', port: 4204 }, { name: 'facade-ip', host: internalTargets.facade, port: 4204 },
      { name: 'external-ip-https', host: '1.1.1.1', port: 443 }, { name: 'external-ip-dns', host: '8.8.8.8', port: 53 },
      { name: 'external-name-https', host: 'api.openai.com', port: 443 }, { name: 'egress-proxy', host: 'egress', port: 3128 },
      { name: 'a2', host: 'a2', port: A2_PORT },
    ],
    dns: [{ name: 'external', host: 'api.openai.com' }, { name: 'gateway-state-alias', host: 'gateway-state' }],
    files: [...protectedFiles, ...hostFiles, ...escapeFiles, { name: 'own-config', path: '/run/participant/participant.json' }],
    writes: [{ name: 'root-filesystem', path: `/opt/participant/write-${prefix}` }, { name: 'config-volume', path: `/run/participant/write-${prefix}` }],
    http: [
      { name: 'operator-status', url: 'http://gateway:4200/api/status', auth: 'self' },
      { name: 'operator-evidence', url: 'http://gateway:4200/api/evidence', auth: 'self' },
      { name: 'operator-policy', url: 'http://gateway:4200/api/policy/preview', auth: 'self', body: { contextId: 'diverted', action: 'FENCE' } },
      { name: 'a2-get', url: `http://a2:${A2_PORT}/` },
    ],
    proxy: plan.model ? [
      { name: 'allowed-tls', proxyHost: 'egress', proxyPort: 3128, target: 'api.openai.com:443', tls: 'api.openai.com' },
      { name: 'other-host', proxyHost: 'egress', proxyPort: 3128, target: 'example.com:443' },
      { name: 'allowed-host-other-port', proxyHost: 'egress', proxyPort: 3128, target: 'api.openai.com:80' },
      { name: 'internal-gateway', proxyHost: 'egress', proxyPort: 3128, target: 'gateway:4200' },
      { name: 'ip-literal', proxyHost: 'egress', proxyPort: 3128, target: '1.1.1.1:443' },
      { name: 'plain-http', proxyHost: 'egress', proxyPort: 3128, absolute: 'http://example.com/' },
    ] : [],
    scan: { hashes: Object.fromEntries(Object.entries(credentials).map(([name, value]) => [name, sha256(value)])),
      roots: ['/run', '/tmp', '/opt', '/etc', '/home', '/root', '/var', '/srv', '/mnt', '/media', '/state', '/app'], maxFiles: 8000, maxBytes: 48_000_000, maxMs: 15_000 },
  }, run);
  const p = participantProbe;
  check('participant-runtime-identity', p.identity?.uid === manifest.participantUid && p.identity?.gid === manifest.participantGid
    && p.identity?.capEff === '0000000000000000' && p.identity?.capPrm === '0000000000000000' && p.identity?.noNewPrivs === '1' && p.identity?.seccomp === '2'
    && p.writes['root-filesystem']?.writable === false && p.writes['config-volume']?.writable === false
    && (plan.model ? p.env?.proxy === 'http://egress:3128' : p.env?.proxy === null && p.env?.apiKeyPresent === false),
    { identity: p.identity, writes: p.writes, env: p.env });
  // The participant holds only the arm's credential (DIVERT→actor, DIRECT→ordinary) or, for DENY, a value that is no
  // gateway credential at all, so the credential-hash scan over the whole container finds only that one or nothing.
  const expectedScanName = plan.arm === 'DIVERT' ? 'actor' : plan.arm === 'DIRECT' ? 'ordinary' : null;
  check('participant-secret-scan', p.scan && !p.scan.truncated && p.scan.files > 0
    && (expectedScanName === null
      ? p.scan.matches.length === 0
      : p.scan.matches.every((match) => match.name === expectedScanName && match.where === '/run/participant/participant.json')
        && p.scan.matches.some((match) => match.name === expectedScanName)), { arm: plan.arm, scan: p.scan });
  check('host-files-unreadable', hostFiles.every((file) => p.files[file.name]?.readable === false)
    && escapeFiles.every((file) => p.files[file.name]?.readable === false), { host: hostFiles.map((file) => p.files[file.name]), escape: escapeFiles.map((file) => p.files[file.name]) });
  const positiveFiles = {};
  for (const role of ['gateway', 'origin', 'collector', ...(plan.model ? ['egress'] : [])]) {
    const own = protectedFiles.filter((file) => file.name.startsWith(role) || role === 'gateway' && ['canonical-db', 'ticket-key'].includes(file.name));
    positiveFiles[role] = await labProbe(containers[role], { files: own }, run);
  }
  const positiveExpected = protectedFiles.filter((file) => plan.model || file.name !== 'egress-config');
  const positiveObserved = Object.values(positiveFiles).flatMap((value) => Object.values(value.files));
  check('protected-files-unreadable', protectedFiles.every((file) => p.files[file.name]?.readable === false) && p.files['own-config']?.readable === true,
    protectedFiles.map((file) => p.files[file.name]));
  check('protected-files-positive-control', positiveObserved.length === positiveExpected.length && positiveObserved.every((file) => file.readable === true), positiveFiles);
  const blocked = (name) => p.tcp[name]?.connected === false;
  check('external-network-blocked', ['external-ip-https', 'external-ip-dns', 'external-name-https'].every(blocked), {
    tcp: ['external-ip-https', 'external-ip-dns', 'external-name-https'].map((name) => p.tcp[name]), dns: p.dns.external });
  check('internal-services-blocked', ['gateway-state-port', 'gateway-world-ip', 'origin-name', 'origin-ip', 'collector-name', 'collector-ip', 'facade-name', 'facade-ip'].every(blocked)
    && p.dns['gateway-state-alias']?.resolved === false, { tcp: Object.fromEntries(Object.entries(p.tcp).filter(([name]) => !name.startsWith('external') && !name.startsWith('gateway-http') && name !== 'gateway-mcp')), alias: p.dns['gateway-state-alias'] });
  check('gateway-entry-reachable', p.tcp['gateway-http']?.connected === true && p.tcp['gateway-mcp']?.connected === true, [p.tcp['gateway-http'], p.tcp['gateway-mcp']]);
  check('operator-api-rejected', ['operator-status', 'operator-evidence', 'operator-policy'].every((name) => p.http[name]?.status === 401), p.http);
  // A2 (second real path): the participant reaches it directly, but A2 is confined to its own internal network and
  // cannot reach the gateway, origin or collector. The probe above already issued one A2 request; A2 logs it as the source witness.
  check('a2-reachable', p.tcp.a2?.connected === true && p.http['a2-get']?.status === (plan.guarded ? 403 : 200), { tcp: p.tcp.a2, http: p.http['a2-get'] });
  const a2Probe = await labProbe(containers.a2, { tcp: [
    { name: 'gateway', host: 'gateway', port: 4200 }, { name: 'gateway-state', host: 'gateway', port: 4201 },
    { name: 'origin', host: 'origin', port: 4202 }, { name: 'collector', host: 'collector', port: 4203 }, { name: 'facade', host: 'facade', port: 4204 },
  ], dns: [{ name: 'gateway', host: 'gateway' }] }, run);
  check('a2-isolated', ['gateway', 'gateway-state', 'collector', 'facade'].every((name) => a2Probe.tcp[name]?.connected === false) && a2Probe.tcp.origin?.connected === plan.guarded, a2Probe.tcp);
  const a2Log = (await run(['logs', containers.a2.Id], { timeout: 15_000 })).split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const a2Served = a2Log.filter((entry) => entry.event === 'A2_REQUEST');
  check('a2-source-witness', a2Log.some((entry) => entry.event === 'A2_READY') && a2Served.length >= 1
    && a2Served.every((entry) => Number.isInteger(entry.seq)), { ready: a2Log.some((entry) => entry.event === 'A2_READY'), requests: a2Served.length });
  if (plan.model) {
    const egress = containers.egress;
    check('egress-confinement', hardened(egress, { uid: manifest.egressUid, gid: manifest.egressGid, maxPids: 32, maxMemory: 134217728 }), 'Egress proxy: dedicated nonroot UID, read-only root, no capabilities, bounded, no published ports.');
    const allowed = p.proxy['allowed-tls'];
    check('egress-allowlist-tls', allowed?.status === 200 && allowed.tls?.authorized === true && allowed.tls?.subjectAltNameMatches === true,
      { ...allowed, note: 'TLS handshake only; no HTTP request or model call was sent.' });
    check('egress-denials', ['other-host', 'allowed-host-other-port', 'internal-gateway', 'ip-literal'].every((name) => p.proxy[name]?.status === 403)
      && p.proxy['plain-http']?.status === 405 && blocked('external-name-https'), p.proxy);
    const logs = (await run(['logs', egress.Id], { timeout: 15_000 })).split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const decisions = logs.filter((entry) => entry.decision);
    check('egress-decisions-logged', decisions.filter((entry) => entry.decision === 'ALLOWED' && entry.target === 'api.openai.com:443').length === 1
      && decisions.filter((entry) => entry.decision === 'DENIED').length >= 5 && decisions.every((entry) => entry.decision !== 'ALLOWED' || plan.egressAllowlist.includes(entry.target)),
      decisions.map(({ decision, code, target, bytesUp, bytesDown }) => ({ decision, code, target, bytesUp, bytesDown })));
  } else {
    const egressContainers = (await run(['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${manifest.project}`,
      '--filter', 'label=com.docker.compose.service=egress'])).split('\n').filter(Boolean);
    check('egress-absent', blocked('egress-proxy') && Object.keys(p.proxy).length === 0 && egressContainers.length === 0 && plan.routableNetworks.length === 0,
      { egressProxy: p.tcp['egress-proxy'], egressContainers: egressContainers.length, routableNetworks: plan.routableNetworks });
  }
  const api = (path, credential, payload) => labGatewayApi(containers.gateway, path, credential, payload, run);
  const before = await api('/api/evidence', 'owner');
  // Every arm runs the same study flow; only the routing differs. DIRECT (open control) reads the real record and
  // does not attempt workspace tickets it cannot hold; DIVERT and DENY run the full flow.
  const behavior = plan.arm === 'DIRECT' ? { tickets: false, accept: false, pivotToA2: true } : { tickets: true, accept: true, pivotToA2: true };
  const study = JSON.parse(await run(['exec', '-i', participant.Id, 'node', '/opt/participant/client.mjs', 'study', '/run/participant/participant.json'],
    { input: { prefix, behavior }, timeout: 60_000 }));
  const ordinaryId = `${prefix}-ordinary-control`;
  const ordinary = await api('/api/operate', 'ordinary', { requestId: ordinaryId, operation: 'read', args: { key: 'welcome' } });
  const evidence = await api('/api/evidence', 'owner');
  const studyStep = (name) => study.steps.find((entry) => entry.name === name);
  const servedTo = (name, destination) => { const entry = studyStep(name); return entry?.ok === true && evidence.events.filter((event) => event.requestId === entry.requestId
    && event.family === 'http' && event.destination === destination && event.outcome === 'SERVED').length === 1; };
  if (plan.arm === 'DIVERT') {
    check('diversion-flow', ['snapshot', 'read'].every((name) => servedTo(name, 'SYNTHETIC'))
      && !evidence.events.some((event) => event.contextId === 'diverted' && event.destination === 'ORIGIN'),
      { steps: study.steps.map(({ name, family, status, code, ok }) => ({ name, family, status, code, ok })) });
    check('ticket-flow', servedTo('issue-ticket', 'SYNTHETIC') && servedTo('use-ticket', 'SYNTHETIC') && study.markers.acceptedAtMs !== null, study.markers);
    check('participant-view-minimized', study.observed?.routeFieldSeen === false, 'No participant-visible result carried routing metadata.');
  } else if (plan.arm === 'DIRECT') {
    check('open-control-reaches-origin', ['snapshot', 'read'].every((name) => servedTo(name, 'ORIGIN'))
      && !evidence.events.some((event) => event.destination === 'SYNTHETIC'),
      { steps: study.steps.map(({ name, family, status, code, ok }) => ({ name, family, status, code, ok })) });
    check('participant-view-minimized', study.observed?.routeFieldSeen === false, 'Open-control ORIGIN results carried no internal routing metadata.');
  } else {
    const participantRequestIds = new Set(study.steps.filter((entry) => entry.family === 'http').map((entry) => entry.requestId));
    check('plain-deny', study.steps.filter((entry) => entry.family === 'http').every((entry) => entry.ok === false)
      && !evidence.events.some((event) => participantRequestIds.has(event.requestId)) && study.markers.acceptedAtMs === null,
      { steps: study.steps.map(({ name, family, status, code, ok }) => ({ name, family, status, code, ok })) });
  }
  const first = before.scope?.witness; const last = evidence.scope?.witness;
  // The ordinary control reaches ORIGIN in every arm. DIRECT additionally admits the participant's own ordinary reads,
  // so the exact count is checked by ordinary-admission-census below; here we require at least the control admission.
  // The participant-v1 surface carries no _route, so the control is confirmed by the real record it returned and by the
  // authoritative operator evidence census (contextId ordinary, destination ORIGIN, served), not a participant-visible field.
  check('ordinary-control', (manifest.studyFixture ? ordinary.value?.application === 'LedgerDesk' : ordinary.record?.quantity === 7) && ordinary._route === undefined
    && evidence.events.filter((event) => event.requestId === ordinaryId && event.contextId === 'ordinary'
    && event.destination === 'ORIGIN' && event.outcome === 'SERVED').length === 1 && first && last && last.accepted >= first.accepted + 1
    && last.rejected === first.rejected && last.stateDigest === first.stateDigest && last.acceptedContexts.every((context) => context === 'ordinary'),
    { requestId: ordinaryId, record: ordinary.record, before: first && { accepted: first.accepted, rejected: first.rejected }, after: last && { accepted: last.accepted, rejected: last.rejected } });
  // Diversion is required only for the DIVERT arm; DIRECT and DENY legitimately observe no synthetic diversion.
  const evPass = (id) => evidence.checks?.some((item) => item.id === id && item.status === 'PASS');
  const commonEvidence = ['canonical-replay', 'origin-state-unchanged', 'no-diverted-origin-admission',
    'independent-route-census', 'ordinary-admission-census', 'dispatch-outcomes-known'];
  check('gateway-evidence-complete', commonEvidence.every(evPass) && (plan.arm !== 'DIVERT' || (evidence.status === 'PASS' && evPass('real-diversion-observed'))),
    { arm: plan.arm, status: evidence.status, checks: evidence.checks?.map(({ id, status }) => ({ id, status })) });
  const result = { schemaVersion: PARTICIPANT_LAB_VERSION, observedAt: new Date().toISOString(), context: DOCKER_CONTEXT, project: manifest.project, mode: manifest.mode,
    arm: plan.arm, prefix, images, study: { markers: study.markers, stepCount: study.steps.length, observed: study.observed, a2RequestsObserved: a2Served.length },
    ...evaluateLabChecks(plan, checks),
    facts: { containers: Object.fromEntries(plan.services.map((service) => [service, { id: containers[service].Id, image: containers[service].Image,
      user: containers[service].Config.User, readOnlyRoot: containers[service].HostConfig.ReadonlyRootfs, privileged: containers[service].HostConfig.Privileged,
      capDrop: containers[service].HostConfig.CapDrop, securityOpt: containers[service].HostConfig.SecurityOpt, memoryBytes: containers[service].HostConfig.Memory,
      pidsLimit: containers[service].HostConfig.PidsLimit, nanoCpus: containers[service].HostConfig.NanoCpus,
      networks: Object.keys(containers[service].NetworkSettings.Networks), mounts: mountFacts(containers[service]) }])),
      networks: Object.fromEntries(Object.entries(networks).map(([name, network]) => [name, { id: network.Id, internal: network.Internal }])),
      gatewayEvidence: { status: evidence.status, sha256: sha256(JSON.stringify(evidence)), eventCount: evidence.events.length } },
    limitations: ['Artificial resources and disposable credentials only; no production asset or real model request.',
      'All containers share one dedicated Linux VM kernel; this is not a container-escape assessment.',
      'The Docker administrator and the gateway remain trusted. Network and file results are point-in-time observations.',
      plan.model ? 'Model mode verified only the allowlisted TLS handshake; the API key is visible to the Docker administrator through container inspection.'
        : 'Script mode has no egress path; external probes were connection attempts that did not complete.'] };
  privateWrite(join(directory, 'lab-result.json'), result, 'w');
  return result;
}

export async function runParticipantLabScript(directory, { run = docker, prefix = `drill-${randomBytes(6).toString('hex')}` } = {}) {
  const manifest = readParticipantLab(directory);
  const containers = await inspectLab(directory, manifest, run);
  return JSON.parse(await run(['exec', '-i', containers[manifest.plan.participantService].Id, 'node', '/opt/participant/client.mjs', 'script',
    '/run/participant/participant.json'], { input: { prefix }, timeout: 60_000 }));
}

// Run the shared three-arm study flow and collect the participant's steps, markers and the A2 source witness (from the
// A2 container log). The host uses these to compute acceptance, recognition time and stop-pursuing. It drives only the
// participant container and reads a container log; it makes no model call. The default behavior suits the arm.
export async function runParticipantLabStudy(directory, { run = docker, prefix = `study-${randomBytes(6).toString('hex')}`, behavior } = {}) {
  const manifest = readParticipantLab(directory);
  const containers = await inspectLab(directory, manifest, run);
  const armBehavior = behavior ?? (manifest.arm === 'DIRECT' ? { tickets: false, accept: false, pivotToA2: true } : { tickets: true, accept: true, pivotToA2: true });
  const study = JSON.parse(await run(['exec', '-i', containers[manifest.plan.participantService].Id, 'node', '/opt/participant/client.mjs', 'study',
    '/run/participant/participant.json'], { input: { prefix, behavior: armBehavior }, timeout: 60_000 }));
  const a2SourceWitness = (await run(['logs', containers.a2.Id], { timeout: 15_000 })).split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).filter((entry) => entry.event === 'A2_REQUEST');
  return { arm: manifest.arm, prefix, behavior: armBehavior, study, a2SourceWitness };
}

// Removes every container, network, volume and image created for this lab project. Each step is attempted once;
// failures are reported with the residual inventory instead of being retried.
export async function stopParticipantLab(directory, { run = docker, removeImages = true } = {}) {
  const manifest = readParticipantLab(directory);
  const errors = [];
  const attempt = async (step, work) => { try { await work(); } catch (error) { errors.push({ step, code: error.code ?? 'STOP_STEP_FAILED' }); } };
  const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);
  await attempt('compose-down', () => run([...labComposeArgs(directory, manifest, ['script', 'model']), 'down', '--volumes', '--remove-orphans', '--timeout', '10'],
    { timeout: 120_000, env: labEnvironment(manifest.plan) }));
  await attempt('helper-containers', async () => {
    const ids = lines(await run(['ps', '--all', '--quiet', '--filter', `label=org.dungeonq.project=${manifest.project}`]));
    if (ids.length) await run(['rm', '--force', ...ids]);
  });
  for (const role of [...labServiceRoles, 'participant', 'a2', 'egress']) {
    await attempt(`config-volume-${role}`, async () => {
      const name = `${manifest.project}_${role}-config`;
      if (await run(['volume', 'ls', '--quiet', '--filter', `name=^${name}$`])) await run(['volume', 'rm', name]);
    });
  }
  if (removeImages) for (const kind of Object.keys(imageProfiles)) {
    await attempt(`image-${kind}`, async () => {
      const tag = `${imageProfiles[kind].tag}:${manifest.project}`;
      if (await run(['image', 'ls', '--quiet', tag])) await run(['image', 'rm', tag]);
    });
  }
  const residual = { containers: [], networks: [], volumes: [], images: [] };
  await attempt('residual-inventory', async () => {
    residual.containers = lines(await run(['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${manifest.project}`]))
      .concat(lines(await run(['ps', '--all', '--quiet', '--filter', `label=org.dungeonq.project=${manifest.project}`])));
    residual.networks = lines(await run(['network', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${manifest.project}`]));
    residual.volumes = lines(await run(['volume', 'ls', '--quiet', '--filter', `name=^${manifest.project}_`]));
    if (removeImages) residual.images = lines(await run(['image', 'ls', '--quiet', '--filter', `reference=*:${manifest.project}`]));
  });
  const clean = errors.length === 0 && Object.values(residual).every((items) => items.length === 0);
  return { project: manifest.project, stopped: clean, errors, residual, imagesRemoved: removeImages };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const reference = ['prepare', 'build', 'up', 'verify', 'down'];
  const lab = { 'lab-build': buildParticipantLab, 'lab-up': startParticipantLab, 'lab-verify': verifyParticipantLab,
    'lab-script': runParticipantLabScript, 'lab-study': runParticipantLabStudy, 'lab-down': stopParticipantLab };
  insist(reference.includes(command) || command === 'lab-prepare' || Object.hasOwn(lab, command), 'USAGE_PREPARE_BUILD_UP_VERIFY_DOWN_OR_LAB');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    insist(['--directory', '--mode', '--arm'].includes(rest[index]) && typeof rest[index + 1] === 'string' && !Object.hasOwn(options, rest[index]), 'ARGUMENT_INVALID');
    options[rest[index]] = rest[index + 1];
  }
  insist(command === 'lab-prepare' || (!options['--mode'] && !options['--arm']), 'ARGUMENT_INVALID');
  const directory = options['--directory'];
  if (!['prepare', 'lab-prepare'].includes(command)) insist(directory, 'DIRECTORY_ARGUMENT_REQUIRED');
  let result;
  if (command === 'prepare') result = prepareReference({ directory });
  else if (command === 'lab-prepare') { const { plan, ...prepared } = prepareParticipantLab({ directory, mode: options['--mode'] ?? 'SCRIPT_CLIENT', arm: options['--arm'] ?? 'DIVERT' }); result = prepared; }
  else if (reference.includes(command)) result = await ({ build: buildReference, up: startReference, verify: verifyReference, down: stopReference }[command])(directory);
  else result = await lab[command](directory);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (['verify', 'lab-verify'].includes(command) && result.status !== 'PASS') process.exitCode = 1;
  if (command === 'lab-down' && !result.stopped) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  process.stderr.write(JSON.stringify({ status: 'INCONCLUSIVE', code: error.code ?? 'REFERENCE_FAILED', detail: error.detail }) + '\n'); process.exitCode = 1;
});
