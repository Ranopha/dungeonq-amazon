import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runEmailAcceptance } from '../server/email-acceptance.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) throw Error('PASS_NEW_OUTPUT_DIRECTORY');
const output = args.length ? resolve(args[1]) : await mkdtemp(join(tmpdir(), 'dungeonq-email-proof-'));
if (args.length) await mkdir(output, { mode: 0o700 });
const installation = await mkdtemp(join(tmpdir(), 'dungeonq-email-private-'));
const { report } = await runEmailAcceptance({ directory: installation });
await writeFile(join(output, 'proof.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify({ output, passed: report.passed, checks: report.checks.length, externalEmailSent: false,
  liveOAuthProviderUsed: false, inboxDeliveryProven: false, privateInstallationIncluded: false }) + '\n');
