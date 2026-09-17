import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startAstraLab } from '../server/astra-runtime.mjs';
import { readScenarioFile } from './lib/scenario-file.mjs';
import { digest } from '../server/contracts.mjs';

const options = new Map(); const args = process.argv.slice(2);
let runtime; let destination;
try {
  if (args.length % 2) throw new Error('OPTIONS_INVALID');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--out', '--scenario', '--max-usd', '--live'].includes(args[i]) || options.has(args[i])) throw new Error('OPTIONS_INVALID');
    options.set(args[i], args[i + 1]);
  }
  if (options.get('--live') !== 'confirmed') throw new Error('LIVE_COST_CONFIRMATION_REQUIRED');
  const scenario = await readScenarioFile(options.has('--scenario') ? resolve(options.get('--scenario')) : new URL('../assistant/scenarios/after-hours.json', import.meta.url));
  destination = options.has('--out') ? resolve(options.get('--out')) : await mkdtemp(join(tmpdir(), 'dungeonq-astra-proof-'));
  if (options.has('--out')) await mkdir(destination, { mode: 0o700 });
  const events = [];
  const report = { schemaVersion: 'dungeonq.astra-proof/v1', profile: 'SYNTHETIC_ONLY', model: 'gpt-6-astra',
    passed: false, generatedAt: new Date().toISOString(), humanPresenceProven: false,
    approvalMode: 'AUTOMATED_REVIEWER_FIXTURE', authority: 'LOCAL_TEST_OBSERVATION_NOT_PROVIDER_ATTESTATION',
    modelCallsPlanned: 2, scenarioDigest: digest(scenario), checks: [], artifacts: [],
    limitations: ['No production assets', 'Test driver owns both fixture roles; model does not', 'Model response IDs are local observations, not signed provider attestations', 'Pinned receipt key is a local lab key', 'Usage cost is an estimate; provider invoice is authoritative'] };
  let stage = 'STARTUP';
  const check = (name, action) => { stage = name; action(); report.checks.push({ name, passed: true }); };
  const artifact = async (name, value) => {
    await writeFile(join(destination, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    report.artifacts.push({ name, canonicalDigest: digest(value) });
  };
  try {
    runtime = await startAstraLab({ scenario, apiKey: process.env.OPENAI_API_KEY, limitUsd: Number(options.get('--max-usd') ?? 0.5), onEvent: event => { events.push(event); } });
    const bridge = runtime.bridge;
    stage = 'LIVE_ASTRA_PREPARE';
    const prepared = await bridge.command({ command: 'astra', task: 'prepare' });
    const row = prepared.result;
    check(stage, () => { assert.equal(prepared.astra.mode, 'LIVE_OPENAI'); assert.equal(prepared.astra.candidate.action, 'request'); assert.equal(row.state, 'AWAITING_HUMAN'); });
    const before = (await bridge.command({ command: 'status' })).result.assets;
    const denied = await bridge.command({ command: 'apply', requestId: row.requestId });
    check('UNAPPROVED_APPLY_BLOCKED', () => { assert.equal(denied.failed, true); assert.equal(denied.result.error, 'HUMAN_APPROVAL_REQUIRED'); });
    await assert.rejects(bridge.command({ command: 'approve' }), { code: 'COMMAND_UNSUPPORTED' });
    check('NO_AGENT_APPROVAL_TOOL', () => { assert.ok(!bridge.info.tools.some(name => /approve|publish/u.test(name))); });
    // Fresh HTTPS/CSRF reviewer fixture. Its password is never in the model adapter or exported evidence.
    const jar = new Map();
    const call = (path, body, headers = {}) => new Promise((resolveCall, reject) => {
      const request = https.request(runtime.web.origin + path, { method: body === undefined ? 'GET' : 'POST', ca: runtime.lab.tls.cert,
        headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(body === undefined ? {} : { Origin: runtime.web.origin, 'Content-Type': 'application/json' }), ...headers } }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; if (text.length > 524288) request.destroy(new Error('BODY_LIMIT')); });
        response.on('end', () => { for (const value of response.headers['set-cookie'] ?? []) { const [k, v] = value.split(';')[0].split('='); if (v) jar.set(k, v); else jar.delete(k); } try { resolveCall({ status: response.statusCode, json: JSON.parse(text) }); } catch { reject(new Error('JSON_REQUIRED')); } });
        response.on('error', reject);
      });
      request.setTimeout(5000, () => request.destroy(new Error('TIMEOUT'))); request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const post = async (path, body) => call(path, body, { 'X-DQ-CSRF': (await call('/api/context')).json.csrfToken });
    stage = 'INDEPENDENT_REVIEWER_FIXTURE';
    assert.equal((await post('/api/login', { tenantId: 'tenant-lab', username: 'owner-lab', password: runtime.lab.password })).status, 200);
    const intent = await post('/api/intents', { password: runtime.lab.password, purpose: 'PUBLISH_GRANT', manifestDigest: row.manifestDigest });
    const approval = await post('/api/assistant/approve', { requestId: row.requestId, manifestDigest: row.manifestDigest, intentToken: intent.json.intentToken });
    check(stage, () => { assert.equal(approval.status, 200); assert.equal(approval.json.state, 'APPROVED'); });
    stage = 'LIVE_ASTRA_EXECUTE';
    const applied = await bridge.command({ command: 'astra', task: 'execute' });
    check(stage, () => { assert.equal(applied.astra.mode, 'LIVE_OPENAI'); assert.equal(applied.astra.candidate.action, 'apply'); assert.equal(applied.result.body.after.state, 'CONTAINED'); assert.equal(applied.result.body.after.version, 1); });
    const after = (await bridge.command({ command: 'status' })).result.assets;
    check('UNRELATED_ASSETS_UNCHANGED', () => { assert.deepEqual(after.filter(item => item.id !== row.assetId), before.filter(item => item.id !== row.assetId)); });
    const verified = await bridge.command({ command: 'verify', requestId: row.requestId });
    const tamper = await bridge.command({ command: 'tamper', requestId: row.requestId });
    const replay = await bridge.command({ command: 'replay', requestId: row.requestId });
    check('SIGNATURE_TAMPER_AND_REPLAY', () => { assert.equal(verified.result.valid, true); assert.equal(tamper.result.valid, false); assert.deepEqual(replay.result, applied.result); });
    const evidence = await bridge.command({ command: 'export', requestId: row.requestId });
    await artifact('assistant-evidence.json', evidence.result);
    await artifact('model-events.json', events);
    await artifact('mcp-trace.json', evidence.trace);
    report.passed = true;
  } catch (error) { report.failedStage = stage; report.error = error.code ?? 'ASSERTION_OR_SETUP_FAILED'; }
  finally {
    if (runtime) {
      report.budget = runtime.budget.status();
      if (!report.passed && events.length) await artifact('model-events.json', events);
      await runtime.close();
      process.stdout.write(`Private fixture and persistent cost ledger retained locally: ${runtime.lab.directory}\n`);
    }
    await artifact('report.json', { ...report, artifactDigestScope: 'artifact JSON values excluding report itself' });
  }
  process.stdout.write(JSON.stringify({ outcome: report.passed ? 'PASS' : 'NOT_COMPLETED', checks: report.checks.length, failedStage: report.failedStage,
    error: report.error, evidenceDirectory: destination, budget: report.budget }) + '\n');
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  await runtime?.close(); process.stderr.write(`Astra proof stopped: ${error.code ?? error.message}\n`); process.exitCode = 1;
}
