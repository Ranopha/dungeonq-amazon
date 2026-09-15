import { runProof } from './lib/proof-runner.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out' || !args[1])) {
  process.stderr.write('Use: npm run demo:proof -- [--out NEW_OUTPUT_DIRECTORY]\n');
  process.exitCode = 2;
} else {
  try {
    process.stdout.write('Synthetic proof harness: automated driver controls BOTH fixture roles. Not a human-presence proof.\n');
    const { report, destination } = await runProof({ output: args[1] });
    for (const check of report.checks) process.stdout.write((check.passed ? 'PASS ' : 'FAIL ') + check.name + '\n');
    process.stdout.write('Result: ' + (report.passed ? 'PASS' : 'FAIL') + '\nEvidence directory: ' + destination + '\n');
    process.stdout.write(report.error === 'CLEANUP_FAILED'
      ? 'Cleanup was not confirmed. Keep the local temporary fixture private and investigate before sharing output.\n'
      : 'The disposable private lab was closed and removed. Only synthetic evidence and a public key are exported.\n');
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(error.code === 'EEXIST'
      ? 'OUTPUT_EXISTS: choose a new evidence directory; nothing was overwritten.\n'
      : 'PROOF_SETUP_FAILED: check Node/OpenSSL with npm run doctor and use a new writable output directory.\n');
    process.exitCode = 1;
  }
}
