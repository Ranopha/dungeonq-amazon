import { inspectSetup } from './lib/doctor.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--json' && arg !== '--skip-ports') || new Set(args).size !== args.length) {
  process.stderr.write('Use: npm run doctor -- [--json] [--skip-ports]\n');
  process.exitCode = 2;
} else {
  const report = await inspectSetup({ checkPorts: !args.includes('--skip-ports') });
  if (args.includes('--json')) process.stdout.write(JSON.stringify(report) + '\n');
  else {
    process.stdout.write('DungeonQ setup: ' + (report.ready ? 'READY' : 'NEEDS_ATTENTION') + '\n');
    for (const check of report.checks) process.stdout.write((check.passed ? 'PASS ' : check.required ? 'FAIL ' : 'WARN ')
      + check.name + (check.remedy ? ': ' + check.remedy : '') + '\n');
    process.stdout.write(report.note + '\n');
    if (report.platformAcceptance === 'NOT_ACCEPTED') process.stdout.write('This platform is not yet release-accepted; do not infer OS support from the prerequisite checks.\n');
  }
  if (!report.ready) process.exitCode = 1;
}
