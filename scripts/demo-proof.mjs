import { runProof } from './lib/proof-runner.mjs';

const args = process.argv.slice(2);
const options = new Map();
let valid = args.length % 2 === 0;
for (let i = 0; i < args.length; i += 2) {
  if (!['--out', '--scenario'].includes(args[i]) || !args[i + 1] || options.has(args[i])) valid = false;
  options.set(args[i], args[i + 1]);
}
if (!valid) {
  process.stderr.write('Use: npm run demo:proof -- [--scenario SYNTHETIC_JSON_FILE] [--out NEW_OUTPUT_DIRECTORY]\n');
  process.exitCode = 2;
} else {
  try {
    process.stdout.write('Synthetic proof harness: automated driver controls BOTH fixture roles. Not a human-presence proof.\n');
    const { report, destination } = await runProof({ output: options.get('--out'), scenarioFile: options.get('--scenario') });
    for (const check of report.checks) process.stdout.write((check.passed ? 'PASS ' : 'FAIL ') + check.name + '\n');
    process.stdout.write('Result: ' + (report.passed ? 'PASS' : 'FAIL') + ' / ' + report.outcome + '\nEvidence directory: ' + destination + '\n');
    process.stdout.write(report.error === 'CLEANUP_FAILED'
      ? 'Cleanup was not confirmed. Keep the local temporary fixture private and investigate before sharing output.\n'
      : 'The disposable private lab was closed and removed. Only synthetic reports/evidence and, when applicable, a public key are exported.\n');
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(error.code === 'EEXIST'
      ? 'OUTPUT_EXISTS: choose a new evidence directory; nothing was overwritten.\n'
      : 'PROOF_SETUP_FAILED: check the bounded SYNTHETIC_ONLY scenario, Node/OpenSSL and a new writable output directory.\n');
    process.exitCode = 1;
  }
}
