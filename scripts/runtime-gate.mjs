import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const DEFAULT_RUNTIME_CHECKS = Object.freeze([
  'http', 'mcp', 'ssh', 'postgres', 'host', 'wrong-ticket', 'persistence',
  'mutation', 'origin-untouched', 'adversarial', 'isolation',
]);
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const allowedFields = (value, required, optional = []) => record(value)
  && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => [...required, ...optional].includes(key));
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z') ? parsed : null;
}
const evidenceRef = value => typeof value === 'string' && value.length <= 2048 && value.trim().length > 0
  && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);

/** Pure report admission. References are required, but their contents are not read here. */
export function evaluateRuntimeGate(report, { expectedCommit, expectedTree, requiredChecks = DEFAULT_RUNTIME_CHECKS } = {}) {
  const findings = [];
  const fail = (code, checkId) => findings.push({ code, ...(checkId === undefined ? {} : { checkId }) });
  const requirementsValid = Array.isArray(requiredChecks) && requiredChecks.length > 0 && requiredChecks.length <= 100
    && requiredChecks.every(identifier) && new Set(requiredChecks).size === requiredChecks.length;
  const required = requirementsValid ? [...requiredChecks] : [];
  const fullGate = requirementsValid && DEFAULT_RUNTIME_CHECKS.every(id => required.includes(id));
  if (!requirementsValid) fail('REQUIRED_CHECKS_INVALID');
  if (!sha(expectedCommit) || !sha(expectedTree)) fail('EXPECTED_CANDIDATE_INVALID');
  if (!allowedFields(report, ['schemaVersion', 'source', 'checks', 'profile', 'startedAt', 'finishedAt'])) fail('REPORT_SCHEMA_INVALID');
  if (report?.schemaVersion !== 'dungeonq.runtime-acceptance/v1') fail('REPORT_VERSION_UNSUPPORTED');
  if (typeof report?.profile !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(report.profile)) fail('REPORT_PROFILE_INVALID');
  const source = report?.source;
  if (!allowedFields(source, ['commit', 'tree'], ['dirtyWorktree', 'contentDigest']) || !sha(source?.commit) || !sha(source?.tree)
    || (Object.hasOwn(source ?? {}, 'dirtyWorktree') && typeof source.dirtyWorktree !== 'boolean')
    || (Object.hasOwn(source ?? {}, 'contentDigest') && (typeof source.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(source.contentDigest)))) fail('REPORT_SOURCE_INVALID');
  if (source?.commit !== expectedCommit || source?.tree !== expectedTree) fail('CANDIDATE_MISMATCH');
  if (fullGate && source?.dirtyWorktree !== false) fail(source?.dirtyWorktree === true ? 'DIRTY_CANDIDATE_DENIED' : 'CANDIDATE_CLEANLINESS_UNCONFIRMED');
  const start = timestamp(report?.startedAt); const finish = timestamp(report?.finishedAt);
  if (start === null || finish === null || finish < start) fail('REPORT_TIME_INVALID');
  const rows = report?.checks;
  const seen = new Set();
  if (!Array.isArray(rows) || rows.length > 100) fail('REPORT_CHECKS_INVALID');
  else for (const check of rows) {
    const id = identifier(check?.id) ? check.id : undefined;
    if (!allowedFields(check, ['id', 'status', 'evidence']) || id === undefined) { fail('CHECK_SCHEMA_INVALID', id); continue; }
    if (seen.has(id)) fail('DUPLICATE_CHECK', id);
    seen.add(id);
    if (!required.includes(id)) fail('UNEXPECTED_CHECK', id);
    if (check.status !== 'PASS') fail('CHECK_NOT_PASS', id);
    if (!Array.isArray(check.evidence) || check.evidence.length < 1 || check.evidence.length > 100
      || !check.evidence.every(evidenceRef) || new Set(check.evidence).size !== check.evidence.length) fail('EVIDENCE_REFERENCE_INVALID', id);
  }
  for (const id of required) if (!seen.has(id)) fail('MISSING_CHECK', id);
  const passed = findings.length === 0;
  return {
    schemaVersion: 'dungeonq.runtime-gate/v1', passed,
    admission: passed ? (fullGate ? 'FULL_REFERENCE_CHECKS_PASSED' : 'SCOPED_CHECKS_PASSED') : 'DENIED',
    fullGate, requiredChecks: required,
    source: { commit: sha(source?.commit) ? source.commit : null, tree: sha(source?.tree) ? source.tree : null },
    productionAdmission: 'NOT_ASSESSED', evidenceAuthenticity: 'NOT_INDEPENDENTLY_VERIFIED', findings,
  };
}

export async function runRuntimeGateCli(args, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const usage = 'Usage: node scripts/runtime-gate.mjs --report FILE --commit COMMIT_SHA --tree TREE_SHA\n';
  const options = {};
  if (args.length !== 6) { stderr.write(usage); return 2; }
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!['--report', '--commit', '--tree'].includes(flag) || Object.hasOwn(options, flag) || !value || value.startsWith('--')) {
      stderr.write(usage); return 2;
    }
    options[flag] = value;
  }
  if (!options['--report'] || !sha(options['--commit']) || !sha(options['--tree'])) { stderr.write(usage); return 2; }
  try {
    const bytes = await readFile(options['--report']);
    if (bytes.length > 1_048_576) throw Error('REPORT_LIMIT');
    const report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const result = evaluateRuntimeGate(report, { expectedCommit: options['--commit'], expectedTree: options['--tree'] });
    stdout.write(JSON.stringify(result) + '\n'); return result.passed ? 0 : 1;
  } catch {
    stderr.write(JSON.stringify({ schemaVersion: 'dungeonq.runtime-gate/v1', passed: false, admission: 'DENIED', error: 'REPORT_UNREADABLE_OR_INVALID' }) + '\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runRuntimeGateCli(process.argv.slice(2));
}
