import { fileURLToPath } from 'node:url';
import { verifySource } from './lib/source-manifest.mjs';

if (process.argv.length !== 2) {
  process.stderr.write('Use: npm run verify:source (from an official source distribution)\n');
  process.exitCode = 2;
} else {
  const result = await verifySource(fileURLToPath(new URL('../', import.meta.url)));
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.passed) process.exitCode = 1;
}
