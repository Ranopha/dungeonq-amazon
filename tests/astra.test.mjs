import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ASTRA_MODEL, createAstraProvider, openAstraBudget } from '../server/astra-provider.mjs';
import { startAstraLab } from '../server/astra-runtime.mjs';

async function budgetFixture(t, limitUsd = 0.5) {
  const directory = await mkdtemp(join(tmpdir(), 'dq-astra-budget-test-'));
  const path = join(directory, 'budget.sqlite'); const budget = openAstraBudget({ path, limitUsd });
  t.after(async () => { budget.close(); await rm(directory, { recursive: true, force: true }); });
  return { path, budget };
}
const modelResponse = overrides => new Response(JSON.stringify({ id: 'resp_fixture', model: ASTRA_MODEL, status: 'completed',
  output: [{ type: 'function_call', name: 'dungeonq_command_candidate', arguments: JSON.stringify({ action: 'request', explanation: 'Request one bounded synthetic change; human approval is still required.' }) }],
  usage: { input_tokens: 200, output_tokens: 40 }, ...overrides }), { status: 200 });

test('Astra adapter uses only the official endpoint, bounded strict schema, standard processing and no retries', async t => {
  const { budget } = await budgetFixture(t); let count = 0;
  const provider = createAstraProvider({ apiKey: 'sk-test-only-key', budget, fetchImpl: async (url, config) => {
    count++; assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(config.redirect, 'error');
    const body = JSON.parse(config.body); assert.equal(body.model, ASTRA_MODEL); assert.equal(body.store, false);
    assert.equal(body.service_tier, 'default'); assert.equal(body.max_output_tokens, 768);
    assert.equal(body.parallel_tool_calls, false); assert.equal(body.tools.length, 1); assert.equal(body.tools[0].strict, true);
    assert.ok(!body.tools[0].parameters.properties.action.enum.includes('approve'));
    assert.ok(budget.status().reservedUsd > 0); return modelResponse();
  } });
  const result = await provider.propose({ task: 'prepare' });
  assert.equal(result.candidate.action, 'request'); assert.equal(result.mode, 'LIVE_OPENAI'); assert.equal(count, 1);
  assert.equal(budget.status().estimatedUsageUsd, 0.004);
  assert.ok(!JSON.stringify(result).includes('sk-test-only-key'));
});

test('Astra budget fails before model I/O, persists across reopen, and cannot be silently increased', async t => {
  const { path, budget } = await budgetFixture(t, 0.001); let calls = 0;
  const provider = createAstraProvider({ apiKey: 'sk-test-only-key', budget, fetchImpl: async () => { calls++; return modelResponse(); } });
  await assert.rejects(provider.propose({ task: 'prepare' }), { code: 'ASTRA_BUDGET_EXHAUSTED' }); assert.equal(calls, 0);
  budget.close(); assert.throws(() => openAstraBudget({ path, limitUsd: 0.5 }), { code: 'ASTRA_BUDGET_IMMUTABLE' });
  const reopened = openAstraBudget({ path, limitUsd: 0.001 }); assert.equal(reopened.status().limitUsd, 0.001); reopened.close();
});

test('Unknown provider outcomes keep their reservation and redact provider secrets', async t => {
  const { budget } = await budgetFixture(t); let calls = 0;
  const provider = createAstraProvider({ apiKey: 'sk-test-only-key', budget, fetchImpl: async () => { calls++; throw new Error('sk-never-expose-test'); } });
  await assert.rejects(provider.propose({}), { code: 'ASTRA_PROVIDER_UNKNOWN' });
  assert.equal(calls, 1); assert.equal(budget.status().unknownUsageCalls, 1); assert.ok(budget.status().reservedUsd > 0);
});

for (const [label, overrides, code] of [
  ['different model', { model: 'different-model' }, 'ASTRA_MODEL_MISMATCH'],
  ['incomplete output', { status: 'incomplete' }, 'ASTRA_RESPONSE_INCOMPLETE'],
  ['missing usage', { usage: {} }, 'ASTRA_USAGE_UNKNOWN'],
  ['multiple calls', { output: [{ type: 'function_call' }, { type: 'function_call' }] }, 'ASTRA_TOOL_NOT_ALLOWED'],
  ['approval candidate', { output: [{ type: 'function_call', name: 'dungeonq_command_candidate', arguments: '{"action":"approve","explanation":"not allowed"}' }] }, 'ASTRA_CANDIDATE_INVALID']
]) test(`Reject ${label} without a fallback model or tool execution`, async t => {
  const { budget } = await budgetFixture(t);
  const provider = createAstraProvider({ apiKey: 'sk-test-only-key', budget, fetchImpl: async () => modelResponse(overrides) });
  await assert.rejects(provider.propose({}), { code }); assert.equal(budget.status().calls, 1);
});

async function runtimeFixture(t, choose, onEvent) {
  const scenario = JSON.parse(await readFile(new URL('../assistant/scenarios/after-hours.json', import.meta.url), 'utf8'));
  const summaries = []; const events = [];
  const provider = { mode: 'MOCK', model: ASTRA_MODEL, async propose(summary) {
    summaries.push(summary); return { mode: 'MOCK', model: ASTRA_MODEL,
      candidate: { action: choose(summary), explanation: 'Synthetic test candidate; no real model was called.' } };
  } };
  const runtime = await startAstraLab({ scenario, provider, onEvent: onEvent ?? (event => { events.push(event); }) });
  const directory = runtime.lab.directory;
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...runtime, events, summaries };
}

test('Astra candidate crosses real MCP, cannot self-approve, and only applies after separate reviewer authorization', async t => {
  const f = await runtimeFixture(t, summary => summary.task === 'prepare' ? 'request' : 'apply');
  const prepared = await f.bridge.command({ command: 'astra', task: 'prepare' }); const row = prepared.result;
  assert.equal(row.state, 'AWAITING_HUMAN'); assert.equal(prepared.astra.mode, 'MOCK');
  const denied = await f.bridge.command({ command: 'astra', task: 'execute' });
  assert.equal(denied.failed, true); assert.equal(denied.result.error, 'HUMAN_APPROVAL_REQUIRED');
  await assert.rejects(f.bridge.command({ command: 'approve' }), { code: 'COMMAND_UNSUPPORTED' });
  const app = f.lab.core.application;
  const auth = await app.login({ tenantId: 'tenant-lab', username: 'owner-lab', password: f.lab.password }, 'automated-fixture');
  const intent = await app.reauthenticate(auth.sessionToken, { password: f.lab.password, purpose: 'PUBLISH_GRANT', manifestDigest: row.manifestDigest }, 'automated-fixture');
  app.approveResponse(auth.sessionToken, { requestId: row.requestId, manifestDigest: row.manifestDigest, intentToken: intent.intentToken });
  const applied = await f.bridge.command({ command: 'astra', task: 'execute' });
  assert.equal(applied.result.body.after.state, 'CONTAINED');
  assert.equal((await f.bridge.command({ command: 'tamper', requestId: row.requestId })).result.valid, false);
  assert.deepEqual((await f.bridge.command({ command: 'replay', requestId: row.requestId })).result, applied.result);
  const egress = JSON.stringify(f.summaries);
  assert.ok(!egress.includes(f.lab.password)); assert.ok(!egress.includes(f.lab.accessToken));
  assert.ok(!egress.includes(f.lab.workerToken)); assert.ok(!egress.includes('owner-lab'));
  assert.ok(!egress.includes('Artificial fixture')); assert.ok(!egress.includes('syn-orders-session'));
  assert.ok(f.events.some(event => event.code === 'HUMAN_APPROVAL_REQUIRED'));
  assert.equal(new Set(f.events.map(event => event.episodeId)).size, 1);
  assert.match(f.events[0].episodeId, /^[a-f0-9-]{36}$/u);
});

test('Candidate cannot change task scope and recording failure prevents proposed action', async t => {
  const f = await runtimeFixture(t, () => 'apply');
  await assert.rejects(f.bridge.command({ command: 'astra', task: 'prepare' }), { code: 'ASTRA_TASK_SCOPE_DENIED' });
  assert.equal((await f.bridge.command({ command: 'status' })).result.responses.length, 0);
  await assert.rejects(f.bridge.command({ command: 'astra', task: 'prepare', approval: true }), { code: 'SCHEMA_INVALID' });
  const blocked = await runtimeFixture(t, () => 'request', () => { throw new Error('fixture storage unavailable'); });
  await assert.rejects(blocked.bridge.command({ command: 'astra', task: 'prepare' }));
  assert.equal((await blocked.bridge.command({ command: 'status' })).result.responses.length, 0);
});

test('Astra wait is a distinct non-effect outcome', async t => {
  const f = await runtimeFixture(t, () => 'wait');
  const result = await f.bridge.command({ command: 'astra', task: 'execute' });
  assert.equal(result.result.state, 'WAITING'); assert.equal(result.result.reason, 'NO_NEW_AUTHORITY');
  assert.equal((await f.bridge.command({ command: 'status' })).result.responses.length, 0);
});
