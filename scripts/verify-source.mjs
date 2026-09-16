import { fileURLToPath } from 'node:url';
import { verifySource } from './lib/source-manifest.mjs';
import { resolve } from 'node:path';

if (process.argv.length > 3) {
  process.stderr.write('Use: npm run verify:source -- [SOURCE_DIRECTORY]\n');
  process.exitCode = 2;
} else {
  const result = await verifySource(process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../', import.meta.url)));
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.passed) process.exitCode = 1;
}
