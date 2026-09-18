import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { evaluateRuntimeGate, DEFAULT_RUNTIME_CHECKS } from '../scripts/runtime-gate.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const expectedCommit = 'a'.repeat(40); const expectedTree = 'b'.repeat(40);
const options = { expectedCommit, expectedTree };
function report() {
  return { schemaVersion: 'dungeonq.runtime-acceptance/v1', profile: 'LOCAL_REFERENCE',
    source: { commit: expectedCommit, tree: expectedTree, dirtyWorktree: false, contentDigest: 'c'.repeat(64) },
    startedAt: '2026-09-18T00:00:00.000Z', finishedAt: '2026-09-18T00:01:00.000Z',
    checks: DEFAULT_RUNTIME_CHECKS.map(id => ({ id, status: 'PASS', evidence: [`evidence/${id}.json`] })) };
}
const has = (result, code) => result.findings.some(finding => finding.code === code);

test('exact clean candidate with every explicit passing check admits only the declared reference scope', () => {
  const value = report(); const original = structuredClone(value);
  const result = evaluateRuntimeGate(value, options);
  assert.equal(result.passed, true); assert.equal(result.fullGate, true);
  assert.equal(result.admission, 'FULL_REFERENCE_CHECKS_PASSED');
  assert.equal(result.productionAdmission, 'NOT_ASSESSED'); assert.equal(result.evidenceAuthenticity, 'NOT_INDEPENDENTLY_VERIFIED');
  assert.deepEqual(value, original);
});

test('local reference without independently passing isolation fails the full gate', () => {
  for (const status of ['INCONCLUSIVE', 'SKIPPED', 'NEUTRAL', 'UNKNOWN', 'FAIL', 'pass', null, undefined]) {
    const value = report(); value.checks.find(check => check.id === 'isolation').status = status;
    const result = evaluateRuntimeGate(value, options);
    assert.equal(result.passed, false); assert.ok(has(result, 'CHECK_NOT_PASS'));
  }
  const value = report(); value.checks = value.checks.filter(check => check.id !== 'isolation');
  assert.ok(has(evaluateRuntimeGate(value, options), 'MISSING_CHECK'));
});

test('mandatory checks must occur exactly once with no substituted or extra IDs', () => {
  const duplicate = report(); duplicate.checks.push(structuredClone(duplicate.checks[0]));
  assert.ok(has(evaluateRuntimeGate(duplicate, options), 'DUPLICATE_CHECK'));
  const missing = report(); missing.checks.pop();
  assert.ok(has(evaluateRuntimeGate(missing, options), 'MISSING_CHECK'));
  const extra = report(); extra.checks.push({ id: 'browser-green', status: 'PASS', evidence: ['fixture.json'] });
  assert.ok(has(evaluateRuntimeGate(extra, options), 'UNEXPECTED_CHECK'));
  const replacement = report(); replacement.checks[0].id = 'HTTP';
  assert.ok(has(evaluateRuntimeGate(replacement, options), 'CHECK_SCHEMA_INVALID'));
  for (const requiredChecks of [[], ['http', 'http'], ['invalid id'], 'http']) assert.ok(has(evaluateRuntimeGate(report(), { ...options, requiredChecks }), 'REQUIRED_CHECKS_INVALID'));
});

test('candidate commit, tree and clean-worktree assertion are separate required facts', () => {
  for (const field of ['commit', 'tree']) {
    const value = report(); value.source[field] = 'd'.repeat(40);
    assert.ok(has(evaluateRuntimeGate(value, options), 'CANDIDATE_MISMATCH'));
  }
  const dirty = report(); dirty.source.dirtyWorktree = true;
  assert.ok(has(evaluateRuntimeGate(dirty, options), 'DIRTY_CANDIDATE_DENIED'));
  delete dirty.source.dirtyWorktree;
  assert.ok(has(evaluateRuntimeGate(dirty, options), 'CANDIDATE_CLEANLINESS_UNCONFIRMED'));
  assert.ok(has(evaluateRuntimeGate(report(), { expectedCommit: 'main', expectedTree }), 'EXPECTED_CANDIDATE_INVALID'));
});

test('evidence references cannot be absent, empty, duplicated or malformed', () => {
  for (const evidence of [undefined, [], [''], [' '], [1], ['same.json', 'same.json'], ['line\nbreak'], [' padded ']]) {
    const value = report(); value.checks[0].evidence = evidence;
    assert.ok(has(evaluateRuntimeGate(value, options), 'EVIDENCE_REFERENCE_INVALID'));
  }
});

test('malformed report versions, dates and shapes fail without treating self-reported passed as authority', () => {
  for (const value of [null, [], {}, { ...report(), schemaVersion: 'dungeonq.runtime-acceptance/v2' }, { ...report(), passed: true },
    { ...report(), startedAt: 'yesterday' }, { ...report(), finishedAt: '2026-09-17T23:59:00Z' },
    { ...report(), startedAt: '2026-02-30T00:00:00Z' }, { ...report(), checks: {} },
    { ...report(), source: { commit: expectedCommit, tree: expectedTree, dirtyWorktree: 'false' } }]) {
    assert.equal(evaluateRuntimeGate(value, options).passed, false);
  }
});

test('explicit reduced check sets remain scoped and cannot be mistaken for the full admission gate', () => {
  const value = report(); value.checks = value.checks.filter(check => check.id === 'http'); delete value.source.dirtyWorktree;
  const result = evaluateRuntimeGate(value, { ...options, requiredChecks: ['http'] });
  assert.equal(result.passed, true); assert.equal(result.fullGate, false); assert.equal(result.admission, 'SCOPED_CHECKS_PASSED');
  assert.equal(evaluateRuntimeGate(value, options).passed, false);
});

test('gate CLI exits nonzero for inconclusive, unreadable and mismatched reports, and rejects unknown arguments', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dq-runtime-gate-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'acceptance.json');
  const args = ['scripts/runtime-gate.mjs', '--report', path, '--commit', expectedCommit, '--tree', expectedTree];
  await writeFile(path, JSON.stringify(report()));
  const success = await exec(process.execPath, args, { cwd: root }); assert.equal(JSON.parse(success.stdout).passed, true);
  const value = report(); value.checks.at(-1).status = 'INCONCLUSIVE'; await writeFile(path, JSON.stringify(value));
  await assert.rejects(exec(process.execPath, args, { cwd: root }), error => error.code === 1 && JSON.parse(error.stdout).passed === false);
  await writeFile(path, '{invalid');
  await assert.rejects(exec(process.execPath, args, { cwd: root }), error => error.code === 1 && JSON.parse(error.stderr).error === 'REPORT_UNREADABLE_OR_INVALID');
  await assert.rejects(exec(process.execPath, [...args, '--allow-missing-isolation'], { cwd: root }), error => error.code === 2);
});

test('CI template remains outside active workflows with pinned read-only actions and no deployment credentials', async () => {
  const template = await readFile(new URL('../deploy/runtime-ci.template.yml', import.meta.url), 'utf8');
  assert.match(template, /DISABLED TEMPLATE ONLY/); assert.match(template, /contents: read/); assert.match(template, /persist-credentials: false/);
  assert.match(template, /merge_group:/); assert.match(template, /runtime-gate\.mjs/); assert.match(template, /--isolation-report/);
  const actions = [...template.matchAll(/uses:\s+(\S+)/g)].map(match => match[1]);
  assert.equal(actions.length, 2); assert.ok(actions.every(action => /@[a-f0-9]{40}$/.test(action)));
  assert.doesNotMatch(template, /secrets\.|pull_request_target|contents:\s*write|id-token:\s*write|gh\s+(?:api|repo)/);
});
