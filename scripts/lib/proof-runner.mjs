import assert from 'node:assert/strict';
import https from 'node:https';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicKey, createHash } from 'node:crypto';
import { openAmazonLab } from '../../server/amazon-lab.mjs';
import { createMcpTools, startMcpServer } from '../../server/mcp.mjs';
import { createAssistantBridge } from '../../server/assistant-bridge.mjs';
import { startWorkbench } from '../../server/workbench.mjs';
import { verifyReceipt } from '../../server/governance.mjs';

// This test driver controls BOTH disposable fixture roles. It is not an agent
// capability, a human-presence proof, or a way to attach to an existing lab.
export async function runProof({ output } = {}) {
  const destination = output ? resolve(output) : await mkdtemp(join(tmpdir(), 'dungeonq-proof-evidence-'));
  if (output) await mkdir(destination, { mode: 0o700 }); // Never overwrite, merge or follow an existing target.
  const scenario = await readFile(new URL('../../assistant/scenarios/after-hours.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const report = { schemaVersion: 'dungeonq.proof-run/v1', profile: 'SYNTHETIC_ONLY',
    version: pkg.version, generatedAt: new Date().toISOString(),
    approvalMode: 'AUTOMATED_HUMAN_ROLE_FIXTURE', humanPresenceProven: false,
    scope: 'FRESH_LOCAL_LAB_ONLY', passed: false, checks: [], artifacts: [],
    limitations: ['No production targets', 'No external sensor-truth claim', 'Receipt signature does not authenticate the export envelope',
      'The test driver controls the human fixture; the runtime MCP assistant cannot approve'] };
  let lab; let mcp; let bridge; let web; let ownedDirectory; let stage = 'STARTUP';
  const stop = async () => {
    try { await web?.close(); } finally {
      try { await bridge?.close(); } finally { try { await mcp?.close(); } finally { lab?.close(); } }
    }
    web = bridge = mcp = lab = undefined;
  };
  const start = async directory => {
    ownedDirectory ??= await mkdtemp(join(tmpdir(), 'dungeonq-proof-lab-'));
    lab = await openAmazonLab({ scenario, directory: directory ?? ownedDirectory });
    mcp = await startMcpServer({ tools: createMcpTools({ execution: lab.core.execution, workerToken: lab.workerToken }), accessToken: lab.accessToken });
    bridge = await createAssistantBridge({ endpoint: mcp.endpoint, accessToken: lab.accessToken, scenario: lab.scenario, seedObservation: lab.seedObservation });
    web = await startWorkbench({ application: lab.core.application, tls: lab.tls, assistant: bridge });
    const jar = new Map();
    const call = (path, body, headers = {}) => new Promise((resolveCall, reject) => {
      const request = https.request(web.origin + path, { method: body === undefined ? 'GET' : 'POST', ca: lab.tls.cert,
        headers: { Cookie: [...jar].map(([key, value]) => key + '=' + value).join('; '),
          ...(body === undefined ? {} : { Origin: web.origin, 'Content-Type': 'application/json' }), ...headers } }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; if (text.length > 524288) request.destroy(new Error('RESPONSE_LIMIT')); });
        response.on('error', reject);
        response.on('end', () => {
          for (const value of response.headers['set-cookie'] ?? []) {
            const [key, val] = value.split(';')[0].split('='); if (val) jar.set(key, val); else jar.delete(key);
          }
          try { resolveCall({ status: response.statusCode, json: JSON.parse(text) }); }
          catch { reject(new Error('JSON_REQUIRED')); }
        });
      });
      request.setTimeout(5000, () => request.destroy(new Error('REQUEST_TIMEOUT')));
      request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const post = async (path, body, headers) => call(path, body, { 'X-DQ-CSRF': (await call('/api/context')).json.csrfToken, ...headers });
    return { call, post };
  };
  const check = async (name, action) => {
    stage = name; const details = await action();
    report.checks.push({ name, passed: true, ...(details ? { details } : {}) });
  };
  const writeArtifact = async (name, content) => {
    await writeFile(join(destination, name), content, { flag: 'wx', mode: 0o600 });
    report.artifacts.push({ name, sha256: createHash('sha256').update(content).digest('hex') });
  };
  try {
    let api = await start();
    const password = lab.password;
    await check('AUTHENTICATED_HTTPS_AND_REAL_MCP', async () => {
      assert.equal((await api.call('/api/assistant/context')).status, 401);
      assert.equal((await api.post('/api/login', { tenantId: 'tenant-lab', username: 'owner-lab', password })).status, 200);
      assert.equal((await api.post('/api/assistant/command', { command: 'request' }, { 'X-DQ-CSRF': '' })).status, 403);
      assert.equal(bridge.info.tools.length, 6);
      assert.ok(!bridge.info.tools.some(tool => /approve|publish|bootstrap/u.test(tool)));
      return { protocol: bridge.info.protocolVersion, transport: bridge.info.transport, tools: bridge.info.tools };
    });
    const before = (await api.post('/api/assistant/command', { command: 'status' })).json.result;
    const beforeHumanAssets = (await api.call('/api/context')).json.state.assets;
    assert.deepEqual(beforeHumanAssets.map(({ id, version, state }) => ({ id, version, state })), before.assets);
    // Pin before receiving an evidence artifact, not from that artifact's envelope.
    const pinned = before.verificationKey;
    const publicKey = createPublicKey(pinned.publicKey);
    const analysis = await api.post('/api/assistant/command', { command: 'analyze' });
    await check('SCENARIO_ANALYSIS', async () => {
      assert.equal(analysis.status, 200); assert.equal(analysis.json.failed, false);
      assert.equal(analysis.json.result.assertionsPassed, true);
      assert.equal(analysis.json.result.decision.route, 'DENY');
      return { scenarioId: lab.scenario.scenarioId, route: analysis.json.result.decision.route };
    });
    stage = 'RESPONSE_REQUEST';
    const requested = await api.post('/api/assistant/command', { command: 'request' });
    assert.equal(requested.status, 200); assert.equal(requested.json.failed, false);
    const row = requested.json.result;
    await check('UNAPPROVED_APPLY_AND_AGENT_APPROVAL_REJECTED', async () => {
      assert.equal(row.state, 'AWAITING_HUMAN');
      const denied = await api.post('/api/assistant/command', { command: 'apply', requestId: row.requestId });
      assert.equal(denied.json.result.error, 'HUMAN_APPROVAL_REQUIRED');
      assert.equal((await api.post('/api/assistant/command', { command: 'approve', requestId: row.requestId })).status, 400);
      assert.deepEqual((await api.call('/api/context')).json.state.assets, beforeHumanAssets);
      return { code: 'HUMAN_APPROVAL_REQUIRED', assetsUnchanged: true };
    });
    let receipt; let evidence;
    await check('EXACT_REAUTHENTICATED_APPROVAL_AND_READBACK', async () => {
      const intent = await api.post('/api/intents', { password, purpose: 'PUBLISH_GRANT', manifestDigest: row.manifestDigest });
      assert.equal(intent.status, 200);
      const approved = await api.post('/api/assistant/approve', { requestId: row.requestId, manifestDigest: row.manifestDigest, intentToken: intent.json.intentToken });
      assert.equal(approved.status, 200); assert.equal(approved.json.state, 'APPROVED');
      const applied = await api.post('/api/assistant/command', { command: 'apply', requestId: row.requestId });
      assert.equal(applied.status, 200); assert.equal(applied.json.failed, false);
      receipt = applied.json.result;
      assert.equal(receipt.body.after.state, 'CONTAINED'); assert.equal(receipt.body.after.version, 1);
      const after = (await api.call('/api/context')).json.state.assets;
      assert.deepEqual(after.filter(asset => asset.id !== row.assetId), beforeHumanAssets.filter(asset => asset.id !== row.assetId));
      assert.equal(after.find(asset => asset.id === row.assetId).version, 1);
      return { manifestDigest: row.manifestDigest, target: row.assetId, unrelatedAssetsUnchanged: true };
    });
    await check('PINNED_SIGNATURE_AND_TAMPER_DETECTION', async () => {
      assert.equal((await api.post('/api/assistant/command', { command: 'verify', requestId: row.requestId })).json.result.valid, true);
      assert.equal((await api.post('/api/assistant/command', { command: 'tamper', requestId: row.requestId })).json.result.valid, false);
      evidence = (await api.post('/api/assistant/command', { command: 'export', requestId: row.requestId })).json.result;
      assert.equal(verifyReceipt(evidence.response.receipt, publicKey, pinned.keyId), true);
      const altered = structuredClone(evidence); altered.response.receipt.body.after.version += 1;
      assert.equal(verifyReceipt(altered.response.receipt, publicKey, pinned.keyId), false);
      await writeArtifact('evidence.json', JSON.stringify(evidence, null, 2) + '\n');
      await writeArtifact('tampered-evidence.json', JSON.stringify(altered, null, 2) + '\n');
      await writeArtifact('trusted-public-key.pem', pinned.publicKey);
      report.keyId = pinned.keyId;
      return { originalValid: true, tamperedValid: false, keyPinnedBeforeExport: true };
    });
    await check('REPLAY_RETURNS_SAME_RECEIPT_WITHOUT_SECOND_EFFECT', async () => {
      const replay = await api.post('/api/assistant/command', { command: 'replay', requestId: row.requestId });
      assert.deepEqual(replay.json.result, receipt);
      assert.equal((await api.call('/api/context')).json.state.assets.find(asset => asset.id === row.assetId).version, 1);
    });
    await check('FULL_STACK_RESTART_PRESERVES_ACCOUNT_AND_RECEIPT', async () => {
      await stop(); api = await start(ownedDirectory);
      assert.equal(lab.password, undefined);
      assert.equal((await api.post('/api/login', { tenantId: 'tenant-lab', username: 'owner-lab', password })).status, 200);
      const exported = await api.post('/api/assistant/command', { command: 'export', requestId: row.requestId });
      assert.deepEqual(exported.json.result.response.receipt, receipt);
      assert.equal(verifyReceipt(exported.json.result.response.receipt, publicKey, pinned.keyId), true);
      assert.equal((await api.call('/api/context')).json.state.assets.find(asset => asset.id === row.assetId).version, 1);
    });
    report.passed = true;
  } catch {
    report.checks.push({ name: stage, passed: false });
    report.error = 'PROOF_FAILED'; // No credential-bearing exception dumps.
  } finally {
    try { await stop(); } catch { report.passed = false; report.error = 'CLEANUP_FAILED'; }
    // Only the fresh temporary fixture made above is removed, never a caller-supplied lab.
    if (ownedDirectory) {
      try { await rm(ownedDirectory, { recursive: true, force: true }); }
      catch { report.passed = false; report.error = 'CLEANUP_FAILED'; }
    }
  }
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { report, destination };
}
