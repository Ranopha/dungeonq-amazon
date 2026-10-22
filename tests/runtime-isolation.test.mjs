import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DOCKER_CONTEXT, selectDockerContext, compareIsolationContinuity, evaluateIsolation, prepareReference, readReference, referenceSourceManifest } from '../scripts/runtime-isolation.mjs';

test('runner context selection requires an explicit dedicated name without changing the default', () => {
  assert.equal(selectDockerContext(), 'colima-dungeonq-rehearsal');
  assert.equal(selectDockerContext('dungeonq-ci'), 'dungeonq-ci');
  for (const value of ['', 'default', 'production', 'dungeonq-', 'dungeonq-../default', 'dungeonq-ci\n']) {
    assert.throws(() => selectDockerContext(value), /DEDICATED_DOCKER_CONTEXT_REQUIRED/);
  }
});

function prepared(t) {
  const parent = mkdtempSync(join(tmpdir(), 'dq-isolation-test-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return prepareReference({ directory: join(parent, 'reference') });
}

test('reference preparation separates credentials and never stages configuration or repository metadata', (t) => {
  const value = prepared(t);
  assert.equal(value.context, DOCKER_CONTEXT);
  assert.equal(value.uid, process.getuid());
  const read = (role) => JSON.parse(readFileSync(join(value.directory, 'config', `${role}.json`), 'utf8'));
  const gateway = read('gateway');
  assert.equal(new Set(Object.values(gateway.credentials)).size, 8);
  assert.ok(Object.values(gateway.credentials).every((token) => /^[A-Za-z0-9_-]{43}$/.test(token)));
  assert.deepEqual(Object.keys(read('facade').options).sort(), ['host', 'port', 'stateOrigin']);
  assert.equal(read('origin').options.normalToken, gateway.credentials.ordinary);
  assert.equal(read('origin').options.witnessToken, gateway.credentials.witness);
  assert.equal(read('collector').options.producerToken, gateway.credentials.producer);
  assert.equal(read('collector').options.readerToken, gateway.credentials.reader);
  for (const role of ['gateway', 'facade', 'origin', 'collector']) {
    assert.equal(lstatSync(join(value.directory, 'config', `${role}.json`)).mode & 0o777, 0o600);
  }
  const staged = JSON.parse(readFileSync(join(value.buildDirectory, 'source-manifest.json'), 'utf8'));
  assert.equal(staged.sourceDigest, value.sourceDigest);
  assert.equal(createHash('sha256').update(JSON.stringify(staged.entries)).digest('hex'), value.sourceDigest);
  assert.ok(staged.entries.every((entry) => !entry.path.startsWith('.git') && !entry.path.includes('config/gateway')));
  assert.equal(existsSync(join(value.buildDirectory, 'config')), false);
  assert.equal(lstatSync(join(value.buildDirectory, 'runtime/blueprints')).mode & 0o777, 0o755);
  assert.equal(lstatSync(join(value.buildDirectory, 'runtime/blueprints/default.json')).mode & 0o777, 0o644);
  assert.equal(referenceSourceManifest().sourceDigest, value.sourceDigest);
});

test('preparation refuses reuse and manifest reads reject non-private permissions', (t) => {
  const value = prepared(t);
  const original = readFileSync(join(value.directory, 'config/gateway.json'), 'utf8');
  assert.throws(() => prepareReference({ directory: value.directory }), /NEW_ABSOLUTE_DIRECTORY_REQUIRED/);
  assert.equal(readFileSync(join(value.directory, 'config/gateway.json'), 'utf8'), original);
  assert.equal(readReference(value.directory).project, value.project);
  chmodSync(join(value.directory, 'reference.json'), 0o644);
  assert.throws(() => readReference(value.directory), /PRIVATE_REFERENCE_FILE_REQUIRED/);
});

test('isolation acceptance fails closed for missing, duplicate, failed, or unobserved facts', () => {
  const missing = evaluateIsolation([]);
  assert.equal(missing.status, 'INCONCLUSIVE');
  const complete = missing.checks.map(({ id }) => ({ id, status: 'PASS', detail: 'Unit fixture only, not live evidence.' }));
  assert.equal(evaluateIsolation(complete).status, 'PASS');
  assert.equal(evaluateIsolation(complete.slice(1)).status, 'INCONCLUSIVE');
  assert.equal(evaluateIsolation([...complete, complete[0]]).status, 'INCONCLUSIVE');
  assert.equal(evaluateIsolation(complete.map((entry, index) => index ? entry : { ...entry, status: 'NOT_RUN' })).status, 'INCONCLUSIVE');
  assert.equal(evaluateIsolation(complete.map((entry, index) => index ? entry : { ...entry, status: 'FAIL' })).status, 'FAIL');
});

test('continuity compares mount identity independent of Docker ordering and detects volume or event replacement', () => {
  const checks = evaluateIsolation([]).checks.map(({ id }) => ({ id, status: 'PASS' }));
  checks.find((check) => check.id === 'origin-witness-continuity').detail = { before: { accepted: 1 }, after: { accepted: 1 } };
  const containers = Object.fromEntries(['gateway', 'facade', 'origin', 'collector'].map((role) => [role, { id: `before-${role}`, mounts: [
    { Type: 'volume', Name: `${role}-config`, Destination: '/run/dungeonq', RW: false },
    { Type: 'volume', Name: `${role}-state`, Destination: '/state', RW: true },
  ] }]));
  const before = { context: DOCKER_CONTEXT, project: 'unit-fixture', status: 'PASS', sourceDigest: 'fixture', images: [{ id: 'image-fixture' }],
    checks, facts: { containers, gatewayEvidence: { eventIds: ['first', 'second'], eventCount: 2 } } };
  const after = structuredClone(before);
  for (const [role, container] of Object.entries(after.facts.containers)) { container.id = `after-${role}`; container.mounts.reverse(); }
  after.facts.gatewayEvidence = { eventIds: ['first', 'second', 'third', 'fourth'], eventCount: 4 };
  assert.equal(compareIsolationContinuity(before, after).status, 'PASS');
  const replaced = structuredClone(after);
  replaced.facts.containers.origin.mounts[0].Name = 'different-volume';
  assert.equal(compareIsolationContinuity(before, replaced).status, 'FAIL');
  const missing = structuredClone(after);
  missing.facts.gatewayEvidence.eventIds = ['third', 'fourth'];
  assert.equal(compareIsolationContinuity(before, missing).status, 'FAIL');
  assert.equal(compareIsolationContinuity({}, {}).status, 'INCONCLUSIVE');
});

// ---- Participant lab (opt-in): configuration, flags, allowlist, mode switching and bounded failure paths ----
import net from 'node:net';
import { readdirSync } from 'node:fs';
import { boundedWait, buildParticipantLab, evaluateLabChecks, labEnvironment, labRequiredChecks, labSourceManifest, participantLabPlan, prepareParticipantLab,
  readParticipantLab, startParticipantLab, stopParticipantLab, tarSingleFile, MODEL_EGRESS_ALLOWLIST, PARTICIPANT_UID, EGRESS_UID, A2_UID } from '../scripts/runtime-isolation.mjs';
import { createEgressProxy, egressDecision, isPublicAddress, normalizeAllowlist, parseConnectTarget } from '../deploy/runtime-reference/egress-proxy.mjs';
import { readParticipantConfig, runParticipantScript, runParticipantStudy } from '../deploy/runtime-reference/participant-client.mjs';
import { openRuntimeReference } from '../runtime/reference.mjs';

function preparedLab(t, mode, arm = 'DIVERT') {
  const parent = mkdtempSync(join(tmpdir(), 'dq-lab-test-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return prepareParticipantLab({ directory: join(parent, 'lab'), mode, arm, lifetimeSeconds: 300 });
}

test('lab plan: every arm carries A2; script has no egress; model adds only the allowlist proxy', () => {
  const script = participantLabPlan();
  assert.equal(script.mode, 'SCRIPT_CLIENT'); assert.equal(script.profile, 'script'); assert.equal(script.arm, 'DIVERT'); assert.equal(script.tokenRole, 'actor');
  assert.deepEqual(script.services, ['gateway', 'facade', 'origin', 'collector', 'participant', 'a2']);
  assert.deepEqual(script.images, ['runtime', 'participant', 'a2']); assert.deepEqual(script.egressAllowlist, []); assert.deepEqual(script.routableNetworks, []);
  assert.deepEqual(script.graph.participant, ['participant', 'a2']); assert.deepEqual(script.graph.a2, ['a2']); assert.ok(script.graph.gateway.includes('participant') && !script.graph.gateway.includes('a2'));
  assert.ok(script.internalNetworks.includes('a2'));
  assert.ok(!labRequiredChecks(script).some((id) => id.startsWith('egress-') && id !== 'egress-absent'));
  assert.ok(['a2-confinement', 'a2-reachable', 'a2-isolated', 'a2-source-witness'].every((id) => labRequiredChecks(script).includes(id)));
  // Arm selects the participant capability and the arm-specific flow checks.
  assert.deepEqual(participantLabPlan({ arm: 'DIRECT' }).tokenRole, 'ordinary');
  assert.deepEqual(participantLabPlan({ arm: 'DENY' }).tokenRole, 'unregistered');
  assert.ok(labRequiredChecks(participantLabPlan({ arm: 'DIVERT' })).includes('diversion-flow'));
  assert.ok(labRequiredChecks(participantLabPlan({ arm: 'DIRECT' })).includes('open-control-reaches-origin'));
  assert.ok(labRequiredChecks(participantLabPlan({ arm: 'DENY' })).includes('plain-deny'));
  const model = participantLabPlan({ mode: 'MODEL_PARTICIPANT' });
  assert.equal(model.profile, 'model'); assert.equal(model.participantService, 'participant-model');
  assert.deepEqual(model.egressAllowlist, ['api.openai.com:443']); assert.deepEqual(model.routableNetworks, ['egress-out']);
  assert.deepEqual(model.graph['participant-model'], ['participant', 'a2']); assert.deepEqual(model.graph.egress, ['participant', 'egress-out']);
  assert.ok(labRequiredChecks(model).includes('egress-allowlist-tls') && !labRequiredChecks(model).includes('egress-absent'));
  for (const bad of [{ mode: 'MODEL' }, { mode: 'script' }, { lifetimeSeconds: 10 }, { lifetimeSeconds: 99999 }, { lifetimeSeconds: 1.5 }, { arm: 'OTHER' }]) {
    assert.throws(() => participantLabPlan(bad), /PARTICIPANT_MODE_INVALID|PARTICIPANT_ARM_INVALID|LAB_LIFETIME_INVALID/);
  }
});

test('lab preparation gives the participant only its arm token, an A2 path and a dedicated identity', (t) => {
  const lab = preparedLab(t, 'SCRIPT_CLIENT');
  const read = (role) => JSON.parse(readFileSync(join(lab.directory, 'config', `${role}.json`), 'utf8'));
  const gateway = read('gateway'); const participant = read('participant'); const a2 = read('a2');
  assert.deepEqual(Object.keys(participant).sort(), ['a2Origin', 'arm', 'httpOrigin', 'lifetimeSeconds', 'mcpEndpoint', 'schemaVersion', 'token']);
  assert.equal(participant.token, gateway.credentials.actor); assert.equal(participant.arm, 'DIVERT'); assert.match(participant.a2Origin, /^http:\/\/a2:\d+$/);
  const text = JSON.stringify(participant);
  for (const [name, value] of Object.entries(gateway.credentials)) if (name !== 'actor') assert.ok(!text.includes(value), name);
  for (const value of Object.values(gateway.credentials)) assert.ok(!JSON.stringify(a2).includes(value));
  assert.equal(gateway.presentation, 'participant-v1'); assert.equal(gateway.stateHost, 'gateway-state');
  assert.equal(gateway.network, false); assert.equal(gateway.hostBroker, false);
  assert.equal(read('facade').options.stateOrigin, 'http://gateway-state:4201');
  assert.equal(existsSync(join(lab.directory, 'config', 'egress.json')), false);
  assert.ok(lab.participantUid === PARTICIPANT_UID && lab.egressUid === EGRESS_UID && lab.a2Uid === A2_UID
    && lab.uid !== lab.participantUid && lab.a2Uid !== lab.participantUid && lab.a2Uid !== lab.uid);
  const env = readFileSync(join(lab.directory, 'compose.env'), 'utf8');
  assert.match(env, /DUNGEONQ_LIFETIME_SECONDS="300"/); assert.match(env, /DUNGEONQ_PARTICIPANT_UID="64101"/); assert.match(env, /DUNGEONQ_A2_UID="64103"/);
  for (const value of Object.values(gateway.credentials)) assert.ok(!env.includes(value));
  for (const role of ['gateway', 'facade', 'origin', 'collector', 'participant', 'a2']) assert.equal(lstatSync(join(lab.directory, 'config', `${role}.json`)).mode & 0o777, 0o600);
  const participantBuild = readdirSync(lab.directory).find((name) => name.startsWith('build-participant-'));
  assert.deepEqual(readdirSync(join(lab.directory, participantBuild)).sort(), ['Dockerfile', 'participant-client.mjs', 'source-manifest.json']);
  const a2Build = readdirSync(lab.directory).find((name) => name.startsWith('build-a2-'));
  assert.deepEqual(readdirSync(join(lab.directory, a2Build)).sort(), ['Dockerfile', 'a2-asset.mjs', 'source-manifest.json']);
  assert.equal(lab.images.participant.sourceDigest, labSourceManifest('participant').sourceDigest);
  assert.equal(lab.images.a2.sourceDigest, labSourceManifest('a2').sourceDigest);
  assert.equal(readParticipantLab(lab.directory).plan.profile, 'script'); assert.equal(readParticipantLab(lab.directory).arm, 'DIVERT');
  chmodSync(join(lab.directory, 'lab.json'), 0o644);
  assert.throws(() => readParticipantLab(lab.directory), /PRIVATE_REFERENCE_FILE_REQUIRED/);
});

test('each arm writes the matching participant token: actor, ordinary, or an unregistered value', (t) => {
  const divert = preparedLab(t, 'SCRIPT_CLIENT', 'DIVERT');
  const direct = preparedLab(t, 'SCRIPT_CLIENT', 'DIRECT');
  const deny = preparedLab(t, 'SCRIPT_CLIENT', 'DENY');
  const token = (lab) => JSON.parse(readFileSync(join(lab.directory, 'config', 'participant.json'), 'utf8')).token;
  const creds = (lab) => JSON.parse(readFileSync(join(lab.directory, 'config', 'gateway.json'), 'utf8')).credentials;
  assert.equal(token(divert), creds(divert).actor);
  assert.equal(token(direct), creds(direct).ordinary);
  assert.ok(!Object.values(creds(deny)).includes(token(deny)));
  assert.equal(readParticipantLab(deny.directory).arm, 'DENY');
});

test('model mode adds a credential-free egress configuration with the exact allowlist', (t) => {
  const lab = preparedLab(t, 'MODEL_PARTICIPANT');
  const egress = JSON.parse(readFileSync(join(lab.directory, 'config', 'egress.json'), 'utf8'));
  const gateway = JSON.parse(readFileSync(join(lab.directory, 'config', 'gateway.json'), 'utf8'));
  assert.deepEqual(egress.allow, MODEL_EGRESS_ALLOWLIST.map((entry) => ({ ...entry })));
  for (const value of Object.values(gateway.credentials)) assert.ok(!JSON.stringify(egress).includes(value));
  assert.equal(egress.limits.lifetimeSeconds, 300); assert.ok(egress.limits.maxTunnels <= 256);
  assert.deepEqual(Object.keys(lab.images).sort(), ['a2', 'egress', 'participant', 'runtime']);
});

test('model API key passes only in model mode and never from ambient variables', () => {
  const script = participantLabPlan(); const model = participantLabPlan({ mode: 'MODEL_PARTICIPANT' });
  const base = { PATH: '/bin', OPENAI_API_KEY: 'ambient-key-value-000000000000', DUNGEONQ_MODEL_API_KEY: 'ambient-key-value-111111111111' };
  assert.deepEqual(labEnvironment(script, { base }), { PATH: '/bin' });
  assert.deepEqual(labEnvironment(model, { base }), { PATH: '/bin' });
  assert.throws(() => labEnvironment(script, { base, modelApiKey: 'sk-test_aaaaaaaaaaaaaaaaaaaa' }), /MODEL_KEY_REQUIRES_MODEL_MODE/);
  assert.throws(() => labEnvironment(model, { base, modelApiKey: 'bad key\n' }), /MODEL_KEY_INVALID/);
  assert.equal(labEnvironment(model, { base, modelApiKey: 'sk-test_aaaaaaaaaaaaaaaaaaaa' }).DUNGEONQ_MODEL_API_KEY, 'sk-test_aaaaaaaaaaaaaaaaaaaa');
});

test('egress allowlist accepts only exact host:port names and public resolved addresses', () => {
  const allow = normalizeAllowlist([{ host: 'api.openai.com', port: 443 }]);
  assert.deepEqual(allow, ['api.openai.com:443']);
  assert.deepEqual(parseConnectTarget('API.OpenAI.com:443'), { host: 'api.openai.com', port: 443 });
  assert.equal(egressDecision('api.openai.com:443', allow).allowed, true);
  for (const [target, code] of [['api.openai.com:80', 'DESTINATION_DENIED'], ['example.com:443', 'DESTINATION_DENIED'], ['evil.api.openai.com:443', 'DESTINATION_DENIED'],
    ['api.openai.com.evil.test:443', 'DESTINATION_DENIED'], ['1.1.1.1:443', 'TARGET_INVALID'], ['[::1]:443', 'TARGET_INVALID'], ['gateway:4200', 'TARGET_INVALID'],
    ['api.openai.com', 'TARGET_INVALID'], ['user@api.openai.com:443', 'TARGET_INVALID'], ['api.openai.com:0', 'TARGET_INVALID'], ['api.openai.com:70000', 'TARGET_INVALID']]) {
    assert.deepEqual([target, egressDecision(target, allow).code], [target, code]);
  }
  for (const bad of [[], [{ host: '1.1.1.1', port: 443 }], [{ host: 'api.openai.com', port: 443, extra: true }], [{ host: 'a.b', port: 443 }, { host: 'a.b', port: 443 }]]) {
    assert.throws(() => normalizeAllowlist(bad), /EGRESS_ALLOWLIST_INVALID/);
  }
  for (const address of ['10.0.0.1', '127.0.0.1', '172.20.0.2', '192.168.5.2', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '2001:db8::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['162.159.140.245', '104.18.33.45', '2606:4700::6812:212d']) assert.equal(isPublicAddress(address), true, address);
});

async function proxyRequest(port, line) {
  return new Promise((resolveRequest, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }); let data = '';
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('timeout')); });
    socket.once('connect', () => socket.write(line));
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (/^HTTP\/1\.1 200/.test(data) && data.includes('\r\n\r\n') && !data.includes('PONG')) socket.write('PING');
      if (data.includes('PONG') || (!/^HTTP\/1\.1 200/.test(data) && data.includes('\r\n\r\n'))) { socket.destroy(); resolveRequest(data); }
    });
    socket.once('error', reject);
  });
}

test('egress proxy tunnels only allowlisted names to public addresses, with budgets and decision logs', async (t) => {
  const echo = net.createServer((socket) => socket.on('data', () => socket.end('PONG')));
  await new Promise((done) => echo.listen(0, '127.0.0.1', done)); t.after(() => echo.close());
  const decisions = []; const resolved = { 'api.example.com': ['93.184.216.34'], 'internal.example.com': ['10.0.0.8'] };
  const proxy = createEgressProxy({ allow: [{ host: 'api.example.com', port: 443 }, { host: 'internal.example.com', port: 443 }],
    limits: { maxTunnels: 3, maxConcurrent: 2, idleTimeoutMs: 1000, connectTimeoutMs: 1000, maxTunnelMs: 2000 },
    resolveHost: async (host) => resolved[host], connect: () => net.connect({ host: '127.0.0.1', port: echo.address().port }), log: (entry) => decisions.push(entry) });
  await new Promise((done) => proxy.server.listen(0, '127.0.0.1', done)); t.after(() => proxy.server.close());
  const port = proxy.server.address().port;
  assert.match(await proxyRequest(port, 'CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n'), /^HTTP\/1\.1 200[\s\S]*PONG$/);
  assert.match(await proxyRequest(port, 'CONNECT example.org:443 HTTP/1.1\r\nHost: example.org:443\r\n\r\n'), /^HTTP\/1\.1 403/);
  assert.match(await proxyRequest(port, 'CONNECT internal.example.com:443 HTTP/1.1\r\nHost: internal.example.com:443\r\n\r\n'), /^HTTP\/1\.1 403/);
  assert.match(await proxyRequest(port, 'GET http://api.example.com/ HTTP/1.1\r\nHost: api.example.com\r\n\r\n'), /^HTTP\/1\.1 405/);
  assert.match(await proxyRequest(port, 'CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n'), /^HTTP\/1\.1 200/);
  assert.match(await proxyRequest(port, 'CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n'), /^HTTP\/1\.1 429/);
  await new Promise((done) => setTimeout(done, 50));
  assert.deepEqual(decisions.filter((entry) => entry.decision !== 'CLOSED').map(({ decision, code }) => `${decision}:${code}`), ['ALLOWED:ALLOWED', 'DENIED:DESTINATION_DENIED',
    'DENIED:RESOLVED_ADDRESS_DENIED', 'DENIED:METHOD_DENIED', 'ALLOWED:ALLOWED', 'DENIED:TUNNEL_BUDGET_EXHAUSTED']);
  assert.equal(proxy.stats().allowed, 2); assert.equal(proxy.stats().total, 3);
});

test('bounded wait backs off, caps attempts and honours the deadline', async () => {
  const sleeps = []; const sleep = async (ms) => { sleeps.push(ms); clock += ms; }; let clock = 0; const now = () => clock;
  let calls = 0;
  assert.deepEqual(await boundedWait(async () => ++calls === 3, { attempts: 5, initialDelayMs: 100, maxDelayMs: 1000, sleep, now }), { ok: true, attempts: 3, delays: [100, 200] });
  calls = 0; sleeps.length = 0; clock = 0;
  const exhausted = await boundedWait(async () => { calls++; throw Object.assign(new Error('x'), { code: 'NOT_UP' }); }, { attempts: 6, initialDelayMs: 100, maxDelayMs: 400, deadlineMs: 60_000, sleep, now });
  assert.equal(exhausted.ok, false); assert.equal(exhausted.code, 'NOT_UP'); assert.equal(calls, 6); assert.deepEqual(sleeps, [100, 200, 400, 400, 400]);
  calls = 0; sleeps.length = 0; clock = 0;
  const deadline = await boundedWait(async () => { calls++; return false; }, { attempts: 30, initialDelayMs: 1000, maxDelayMs: 4000, deadlineMs: 5000, sleep, now });
  assert.equal(deadline.ok, false); assert.equal(deadline.code, 'WAIT_DEADLINE'); assert.ok(calls < 30); assert.ok(sleeps.reduce((a, b) => a + b, 0) <= 5000);
  await assert.rejects(() => boundedWait(async () => true, { attempts: 0 }), /WAIT_BOUNDS_INVALID/);
});

test('config tar entries carry the exact owner, private mode and a valid checksum', () => {
  const content = Buffer.from('{"token":"x"}');
  const tar = tarSingleFile('participant.json', content, { uid: 64101, gid: 64101, mtime: 0 });
  assert.equal(tar.length % 512, 0);
  const field = (offset, length) => tar.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '').trim();
  assert.equal(field(0, 100), 'participant.json'); assert.equal(parseInt(field(100, 8), 8), 0o600);
  assert.equal(parseInt(field(108, 8), 8), 64101); assert.equal(parseInt(field(124, 12), 8), content.length);
  const header = Buffer.from(tar.subarray(0, 512)); const stored = parseInt(field(148, 8), 8); header.fill(' ', 148, 156);
  assert.equal(header.reduce((sum, byte) => sum + byte, 0), stored);
  assert.equal(tar.subarray(512, 512 + content.length).toString(), content.toString());
  assert.throws(() => tarSingleFile('../escape.json', content, { uid: 1, gid: 1 }), /TAR_ENTRY_INVALID/);
});

test('lab acceptance fails closed for missing, duplicated or failed checks in either mode', () => {
  for (const plan of [participantLabPlan(), participantLabPlan({ mode: 'MODEL_PARTICIPANT' })]) {
    const complete = labRequiredChecks(plan).map((id) => ({ id, status: 'PASS' }));
    assert.equal(evaluateLabChecks(plan, complete).status, 'PASS');
    assert.equal(evaluateLabChecks(plan, []).status, 'INCONCLUSIVE');
    assert.equal(evaluateLabChecks(plan, complete.slice(1)).status, 'INCONCLUSIVE');
    assert.equal(evaluateLabChecks(plan, [...complete, complete[0]]).status, 'INCONCLUSIVE');
    assert.equal(evaluateLabChecks(plan, complete.map((entry, index) => index ? entry : { ...entry, status: 'FAIL' })).status, 'FAIL');
  }
});

function fakeDocker(handlers) {
  const calls = [];
  const run = async (args, options = {}) => {
    calls.push({ args, options });
    for (const [pattern, handler] of handlers) if (pattern.test(args.join(' '))) return handler(args, options);
    return '';
  };
  return { run, calls };
}
const dockerFailure = (code) => () => { throw Object.assign(new Error(code), { code }); };

test('lab build failure stops at the first image without retry', async (t) => {
  const lab = preparedLab(t, 'SCRIPT_CLIENT');
  const docker = fakeDocker([[/^build /, dockerFailure('DOCKER_OPERATION_FAILED')]]);
  await assert.rejects(() => buildParticipantLab(lab.directory, { run: docker.run }), /DOCKER_OPERATION_FAILED/);
  assert.equal(docker.calls.length, 1); assert.equal(docker.calls[0].options.build, true);
});

test('lab start failures are bounded: compose up once, readiness wait with backoff then stop', async (t) => {
  const lab = preparedLab(t, 'SCRIPT_CLIENT');
  const volumeState = new Map();
  const base = [
    [/^volume ls --filter/, () => ''],
    [/^volume create/, (args) => { volumeState.set(args.at(-1), args[args.indexOf('--label') + 1]); return ''; }],
    [/^create /, () => 'helper-id'], [/^cp /, () => ''], [/^rm /, () => ''],
    [/^volume inspect/, (args) => { const name = args.at(-1); const role = name.replace(/^dqlab-[a-f0-9]{12}_/, '').replace(/-config$/, '');
      return JSON.stringify([{ Labels: { 'org.dungeonq.project': lab.project, 'org.dungeonq.role': role } }]); }],
    [/^start --attach/, dockerFailure('DOCKER_OPERATION_FAILED')],
  ];
  const seeding = fakeDocker(base);
  await assert.rejects(() => startParticipantLab(lab.directory, { run: seeding.run }), /DOCKER_OPERATION_FAILED/);
  assert.equal(seeding.calls.filter((call) => call.args[0] === 'compose').length, 0);
  assert.equal(seeding.calls.filter((call) => call.args.join(' ').startsWith('rm --force')).length, 1);

  const configs = Object.fromEntries(['gateway', 'facade', 'origin', 'collector', 'participant', 'a2'].map((role) =>
    [role, createHash('sha256').update(readFileSync(join(lab.directory, 'config', `${role}.json`))).digest('hex')]));
  let verifierRole;
  const seeded = [
    [/^create .*--user/, (args) => { verifierRole = /\/(\w+)\.json/.exec(args.at(-1))[1]; return 'verifier-id'; }],
    ...base.slice(0, -1),
    [/^start --attach/, () => configs[verifierRole]],
  ];
  const upFails = fakeDocker([[/^compose .* up /, dockerFailure('DOCKER_OPERATION_FAILED')], ...seeded]);
  await assert.rejects(() => startParticipantLab(lab.directory, { run: upFails.run }), /DOCKER_OPERATION_FAILED/);
  assert.equal(upFails.calls.filter((call) => call.args.includes('up')).length, 1);
  assert.ok(!('DUNGEONQ_MODEL_API_KEY' in upFails.calls.find((call) => call.args.includes('up')).options.env));

  const container = (service) => ({ Id: `${service}-id`.padEnd(64, '0'), State: { Running: true }, Config: { Labels: { 'com.docker.compose.project': lab.project, 'com.docker.compose.service': service } } });
  let gatewayChecks = 0; const sleeps = [];
  const neverReady = fakeDocker([
    [/^compose .* up /, () => ''],
    [/^compose .* ps --all --quiet/, (args) => 'a'.repeat(64) + args.at(-1)],
    [/^inspect /, (args) => JSON.stringify([container(args[1].slice(64))])],
    [/^exec /, () => { gatewayChecks++; throw Object.assign(new Error('down'), { code: 'DOCKER_OPERATION_FAILED' }); }],
    ...seeded,
  ]);
  const original = neverReady.run;
  const run = async (args, options) => { if (args[0] === 'compose' && args.includes('ps')) { const id = await original(args, options); return id.slice(0, 64); } return original(args, options); };
  const services = []; const inspectRun = async (args, options) => { if (args[0] === 'compose' && args.includes('ps')) services.push(args.at(-1)); if (args[0] === 'inspect') return JSON.stringify([container(services.at(-1))]); return run(args, options); };
  await assert.rejects(() => startParticipantLab(lab.directory, { run: inspectRun, wait: { attempts: 4, initialDelayMs: 10, maxDelayMs: 40, sleep: async (ms) => { sleeps.push(ms); } } }), /GATEWAY_NOT_READY/);
  assert.equal(gatewayChecks, 4); assert.deepEqual(sleeps, [10, 20, 40]);
});

test('lab stop attempts every cleanup step once and reports residue instead of retrying', async (t) => {
  const lab = preparedLab(t, 'MODEL_PARTICIPANT');
  const docker = fakeDocker([
    [/^compose .* down /, dockerFailure('DOCKER_OPERATION_TIMEOUT')],
    [/^ps --all --quiet --filter label=org\.dungeonq\.project/, () => 'leftover-helper'],
    [/^ps --all --quiet --filter label=com\.docker\.compose\.project/, () => 'still-running'],
    [/^volume ls --quiet --filter name=\^dqlab-[a-f0-9]{12}_participant-config\$/, () => 'present'],
    [/^volume ls --quiet --filter name=\^dqlab-[a-f0-9]{12}_\s*$/, () => ''],
    [/^image ls --quiet dungeonq-egress/, () => 'image-id'],
  ]);
  const result = await stopParticipantLab(lab.directory, { run: docker.run });
  assert.equal(result.stopped, false);
  assert.deepEqual(result.errors, [{ step: 'compose-down', code: 'DOCKER_OPERATION_TIMEOUT' }]);
  assert.ok(result.residual.containers.includes('still-running'));
  const joined = docker.calls.map((call) => call.args.join(' '));
  assert.equal(joined.filter((line) => line.includes(' down ')).length, 1);
  assert.ok(joined.some((line) => /--profile script --profile model down --volumes --remove-orphans/.test(line)));
  assert.ok(joined.includes('rm --force leftover-helper'));
  assert.ok(joined.some((line) => /^volume rm dqlab-[a-f0-9]{12}_participant-config$/.test(line)));
  assert.ok(joined.some((line) => /^image rm dungeonq-egress:dqlab-/.test(line)));
});

test('scripted participant completes diversion and ticket flows over HTTP and MCP without routing metadata', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dq-lab-client-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await openRuntimeReference({ directory, network: false, hostBroker: false, presentation: 'participant-v1' });
  t.after(() => runtime.close());
  const config = { schemaVersion: 'dungeonq.participant-config/v2', token: runtime.credentials.actor, arm: 'DIVERT',
    httpOrigin: runtime.origin, mcpEndpoint: runtime.mcpEndpoint, a2Origin: 'http://a2:4210', lifetimeSeconds: 60 };
  const result = await runParticipantScript(config, { prefix: 'unit-flow' });
  assert.deepEqual(result.steps.filter((step) => !step.ok).map((step) => step.name), []);
  assert.equal(result.observed.routeFieldSeen, false);
  assert.ok(result.observed.httpTicketIsHandle && result.observed.mcpTicketIsHandle);
  assert.ok(result.observed.httpTicketValueMatchesRead && result.observed.mcpTicketValueMatchesRead);
  assert.equal(result.observed.mcpTools.length, 5);
  const evidence = await (await fetch(runtime.origin + '/api/evidence', { headers: { Authorization: `Bearer ${runtime.credentials.owner}` } })).json();
  const ids = result.steps.filter((step) => step.requestId).map((step) => step.requestId);
  assert.ok(ids.every((id) => evidence.events.some((event) => event.requestId === id && event.destination === 'SYNTHETIC' && event.outcome === 'SERVED')));
  assert.equal(evidence.scope.witness.accepted, 0);
  const denied = await runParticipantScript({ ...config, token: 'not-a-valid-participant-token-0000000000' }, { prefix: 'unit-denied' });
  assert.ok(denied.steps.filter((step) => step.name !== 'capabilities').every((step) => !step.ok));
  await assert.rejects(() => runParticipantScript(config, { prefix: '../bad' }), /REQUEST_PREFIX_INVALID/);
  const path = join(directory, 'participant.json');
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  assert.equal(readParticipantConfig(path).token, config.token);
  writeFileSync(path, JSON.stringify({ ...config, owner: 'x' }), { mode: 0o600 });
  assert.throws(() => readParticipantConfig(path), /PARTICIPANT_CONFIG_INVALID/);
  chmodSync(path, 0o644);
  assert.throws(() => readParticipantConfig(path), /PRIVATE_CONFIG_REQUIRED/);
});

test('three-arm study: acceptance, recognition and A2 pivot are observable per arm without routing metadata', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dq-lab-study-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await openRuntimeReference({ directory, network: false, hostBroker: false, presentation: 'participant-v1' });
  t.after(() => runtime.close());
  // A2 is a separate container at run time; here a stub stands in for its address so the pivot is observable.
  const fetcher = (url, init) => String(url).startsWith('http://a2')
    ? Promise.resolve(new Response(JSON.stringify({ asset: 'A2', contents: 'x', seq: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }))
    : fetch(url, init);
  const base = { schemaVersion: 'dungeonq.participant-config/v2', httpOrigin: runtime.origin, mcpEndpoint: runtime.mcpEndpoint, a2Origin: 'http://a2:4210', lifetimeSeconds: 60 };

  // DIVERT: the wrong ticket is accepted (use-ticket returns a value), the pivot to A2 is recorded, nothing leaks _route.
  const divert = await runParticipantStudy({ ...base, token: runtime.credentials.actor, arm: 'DIVERT' }, { prefix: 'study-divert', fetcher });
  assert.equal(divert.observed.routeFieldSeen, false);
  assert.notEqual(divert.markers.acceptedAtMs, null);
  assert.notEqual(divert.markers.firstA2AtMs, null);
  assert.ok(divert.steps.find((s) => s.name === 'use-ticket')?.ok === true);
  const evidence = await (await fetch(runtime.origin + '/api/evidence', { headers: { Authorization: `Bearer ${runtime.credentials.owner}` } })).json();
  assert.ok(evidence.events.some((e) => e.requestId === 'study-divert-use-ticket' && e.destination === 'SYNTHETIC' && e.outcome === 'SERVED'));

  // DIRECT: the ordinary control reaches the real origin record; no ticket is attempted and nothing is accepted.
  const direct = await runParticipantStudy({ ...base, token: runtime.credentials.ordinary, arm: 'DIRECT' },
    { prefix: 'study-direct', behavior: { tickets: false, accept: false, pivotToA2: true }, fetcher });
  assert.equal(direct.observed.routeFieldSeen, false);
  assert.equal(direct.markers.acceptedAtMs, null);
  assert.ok(['snapshot', 'read'].every((name) => direct.steps.find((s) => s.name === name)?.ok === true));
  assert.ok(!direct.steps.some((s) => s.name === 'use-ticket'));

  // DENY: no DungeonQ. Every gateway operation is rejected; nothing is accepted. The participant can still reach A2.
  const deny = await runParticipantStudy({ ...base, token: 'unregistered-value-00000000000000000000', arm: 'DENY' }, { prefix: 'study-deny', fetcher });
  assert.equal(deny.markers.acceptedAtMs, null);
  assert.ok(deny.steps.filter((s) => s.family === 'http').every((s) => s.ok === false));
  assert.notEqual(deny.markers.firstA2AtMs, null);

  // Scripted recognition is recorded when requested (else it is right-censored).
  const recognized = await runParticipantStudy({ ...base, token: runtime.credentials.actor, arm: 'DIVERT' },
    { prefix: 'study-recog', behavior: { recognizeAfterSteps: 1 }, fetcher });
  assert.notEqual(recognized.markers.recognizedAtMs, null);
  assert.ok(recognized.steps.some((s) => s.family === 'marker' && s.operation === 'CLAIM_FAKE'));
});
