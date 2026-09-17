import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runDefenseAcceptance } from '../server/defense-acceptance.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) throw Error('PASS_NEW_OUTPUT_DIRECTORY');
const output = args.length ? resolve(args[1]) : await mkdtemp(join(tmpdir(), 'dungeonq-defense-proof-'));
if (args.length) await mkdir(output, { mode: 0o700 });
const installation = await mkdtemp(join(tmpdir(), 'dungeonq-defense-private-'));
const result = await runDefenseAcceptance({ directory: installation });
for (const [name, value] of [['proof.json', result.report], ['world.json', result.worldEvidence], ['governance.json', result.governanceEvidence]]) {
  await writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
process.stdout.write(JSON.stringify({ output, passed: result.report.passed, checks: result.report.checks.length,
  claim: result.report.claim, paidProviderApiCalls: 0, privateInstallationIncluded: false }) + '\n');
