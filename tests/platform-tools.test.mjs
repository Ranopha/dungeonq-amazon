import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runProof } from '../scripts/lib/proof-runner.mjs';
import { readScenarioFile } from '../scripts/lib/scenario-file.mjs';
import { connectLocalMcp } from '../scripts/lib/mcp-client.mjs';
import { prepareRelease } from '../scripts/lib/release-builder.mjs';
import { verifySource } from '../scripts/lib/source-manifest.mjs';
import { createLocalFixture } from '../server/local-fixture.mjs';
import { createMcpTools, startMcpServer } from '../server/mcp.mjs';
import { token } from '../server/contracts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
async function temp(t) {
  const path = await mkdtemp(join(tmpdir(), 'dungeonq-platform-test-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
test('自帶場域完整 proof 使用輸入內容而非固定 DENY', async t => {
  const path = await temp(t);
  const scenario = structuredClone(await readScenarioFile(new URL('../assistant/scenarios/after-hours.json', import.meta.url)));
  scenario.scenarioId = 'syn-custom-judge'; scenario.seed = 'DQ-CUSTOM-JUDGE';
  scenario.signals[0].confidence = 80; scenario.expected.route = 'QUARANTINE';
  const file = join(path, 'scenario.json'); await writeFile(file, JSON.stringify(scenario));
  const first = await runProof({ output: join(path, 'one'), scenarioFile: file });
  assert.equal(first.report.passed, true, JSON.stringify(first.report));
  assert.equal(first.report.outcome, 'APPROVED_EFFECT_VERIFIED');
  assert.equal(first.report.scenarioId, scenario.scenarioId);
  assert.equal(first.report.checks[1].details.route, 'QUARANTINE');
  const second = await runProof({ output: join(path, 'two'), scenarioFile: file });
  assert.equal(second.report.inputDigest, first.report.inputDigest);
  assert.equal(second.report.decisionDigest, first.report.decisionDigest);
  assert.equal(second.report.proposalDigest, first.report.proposalDigest);
  // Wrong expected results fail, never silently relabeled as a passed proof.
  scenario.expected.route = 'DENY'; await writeFile(file, JSON.stringify(scenario));
  const failed = await runProof({ output: join(path, 'three'), scenarioFile: file });
  assert.equal(failed.report.passed, false);
  assert.equal(failed.report.checks.at(-1).name, 'SCENARIO_ANALYSIS');
  assert.deepEqual(await readdir(join(path, 'three')), ['report.json']);
});
test('政策拒絕與不支援映射的 proof 不建立 observation／request／receipt', async t => {
  const path = await temp(t);
  for (const [scenario, outcome] of [['budget-blocked', 'POLICY_BLOCKED'], ['unsupported-mapping', 'UNSUPPORTED_MAPPING_REJECTED']]) {
    const { report } = await runProof({ output: join(path, scenario), scenarioFile: join(root, 'assistant/scenarios', scenario + '.json') });
    assert.equal(report.passed, true); assert.equal(report.outcome, outcome);
    assert.equal(report.approvalMode, 'NOT_REACHED'); assert.equal(report.checks.length, 3);
    assert.equal(report.checks.at(-1).details.effectExecuted, false);
    assert.deepEqual((await readdir(join(path, scenario))).sort(), ['rejection.json', 'report.json']);
  }
});
test('場域讀取拒絕 symlink、目錄、超大、壞 UTF-8、未知欄位及真實 sentinel', async t => {
  const path = await temp(t); const file = join(path, 'candidate.json');
  const base = await readScenarioFile(new URL('../assistant/scenarios/after-hours.json', import.meta.url));
  for (const bytes of [Buffer.alloc(131073), Buffer.from([0xc3, 0x28]), JSON.stringify({ ...base, classification: 'PRODUCTION' }),
    JSON.stringify({ ...base, executeShell: 'echo fixture' })]) {
    await writeFile(file, bytes); await assert.rejects(readScenarioFile(file));
  }
  await writeFile(file, JSON.stringify(base)); await symlink(file, join(path, 'link'));
  await assert.rejects(readScenarioFile(join(path, 'link'))); await assert.rejects(readScenarioFile(path));
});
test('獨立程序 MCP client 請求／未核准拒絕／核准後 apply／重播，只持 worker token', async t => {
  const lab = await createLocalFixture(); const accessToken = token();
  const workerToken = lab.core.local.provisionWorker({ tenantId: 'tenant-lab', workerId: 'external-client', expiresAt: Date.now() + 60000 }).workerToken;
  lab.core.local.recordObservation({ tenantId: 'tenant-lab', eventId: 'event-external', assetId: 'api-orders', version: 0 });
  const server = await startMcpServer({ tools: createMcpTools({ execution: lab.core.execution, workerToken }), accessToken });
  t.after(async () => { await server.close(); await lab.close(); });
  // Deliberately do not forward the parent's environment or any human credential.
  const options = { cwd: root, timeout: 10000, env: { DQ_MCP_URL: server.endpoint, DQ_MCP_TOKEN: accessToken } };
  const call = async args => JSON.parse((await exec(process.execPath, ['scripts/mcp-client.mjs', ...args], options)).stdout);
  const listed = await call(['list']); assert.equal(listed.tools.length, 6);
  assert.ok(listed.tools.every(tool => !tool.name.includes('approve')));
  const request = (await call(['request', 'request-external', 'event-external', 'api-orders', '0'])).result;
  assert.equal(request.state, 'AWAITING_HUMAN');
  await assert.rejects(call(['apply', request.requestId]), error => error.code === 1 && JSON.parse(error.stdout).error === 'HUMAN_APPROVAL_REQUIRED');
  await assert.rejects(call(['approve', request.requestId]), error => error.code === 2);
  const app = lab.core.application;
  const human = await app.login({ tenantId: 'tenant-lab', username: 'owner-lab', password: lab.password }, 'fixture');
  const intent = await app.reauthenticate(human.sessionToken, { password: lab.password, purpose: 'PUBLISH_GRANT', manifestDigest: request.manifestDigest }, 'fixture');
  app.approveResponse(human.sessionToken, { requestId: request.requestId, manifestDigest: request.manifestDigest, intentToken: intent.intentToken });
  app.logout(human.sessionToken);
  const first = (await call(['apply', request.requestId])).result;
  assert.equal(first.body.after.state, 'CONTAINED');
  assert.deepEqual((await call(['apply', request.requestId])).result, first);
  const evidence = await call(['evidence', request.requestId]);
  assert.equal(evidence.result.receiptVerified, true);
  assert.ok(!JSON.stringify(evidence).includes(accessToken)); assert.ok(!JSON.stringify(evidence).includes(lab.password));
});
test('外部 client 不把 worker token 送到非 loopback、含 userinfo 或改寫路徑', async () => {
  for (const endpoint of ['https://example.com/mcp', 'http://localhost:4187/mcp', 'http://127.0.0.1:4187/mcp?x=1',
    'http://user@127.0.0.1:4187/mcp', 'http://127.0.0.1:4187/else']) {
    await assert.rejects(connectLocalMcp({ endpoint, accessToken: token() }), /LOCAL_MCP_CONFIGURATION_REQUIRED/u);
  }
});
test('public release builder 拒絕私人庫及未提交內容', async t => {
  const path = await temp(t); const output = path + '-unused';
  await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'private-fixture' }));
  await assert.rejects(prepareRelease({ root: path, output }), /RELEASE_PUBLIC_CHECKOUT_REQUIRED/u);
  await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'dungeonq-amazon', repository: { url: 'git+https://github.com/Ranopha/dungeonq-amazon.git' } }));
  await exec('git', ['init', '-q'], { cwd: path });
  await assert.rejects(prepareRelease({ root: path, output }), /RELEASE_CLEAN_COMMIT_REQUIRED/u);
  await assert.rejects(prepareRelease({ root: path, output: join(path, 'source') }), /RELEASE_OUTSIDE_CHECKOUT_REQUIRED/u);
});
test('public release builder 可獨立產生 SBOM／inventory，拒絕覆寫及未列入 git 的內容', async t => {
  const path = await temp(t); const checkout = join(path, 'checkout');
  const { mkdir } = await import('node:fs/promises'); await mkdir(checkout);
  const pkg = { name: 'dungeonq-amazon', version: '0.4.0', private: true,
    repository: { url: 'git+https://github.com/Ranopha/dungeonq-amazon.git' } };
  await writeFile(join(checkout, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(checkout, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version,
    lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version } } }));
  const git = args => exec('git', args, { cwd: checkout });
  await git(['init', '-q']); await git(['add', 'package.json', 'package-lock.json']);
  await git(['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic release fixture']);
  const output = join(path, 'source');
  const report = await prepareRelease({ root: checkout, output });
  assert.equal(report.passed, true); assert.equal((await verifySource(output)).passed, true);
  assert.ok(!(await readdir(output)).includes('.git'));
  await assert.rejects(prepareRelease({ root: checkout, output }), { code: 'EEXIST' });
  await writeFile(join(checkout, 'untracked.txt'), 'synthetic');
  await assert.rejects(prepareRelease({ root: checkout, output: join(path, 'two') }), /RELEASE_CLEAN_COMMIT_REQUIRED/u);
});
