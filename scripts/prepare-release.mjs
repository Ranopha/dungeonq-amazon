import { prepareRelease } from './lib/release-builder.mjs';
import { fileURLToPath } from 'node:url';

const [output, ...extra] = process.argv.slice(2);
if (!output || extra.length) {
  process.stderr.write('Use: npm run release:prepare -- NEW_DIRECTORY_OUTSIDE_CHECKOUT\n');
  process.exitCode = 2;
} else {
  try {
    const report = await prepareRelease({ root: fileURLToPath(new URL('../', import.meta.url)), output });
    process.stdout.write(JSON.stringify(report) + '\n');
  } catch (error) {
    process.stderr.write((/^RELEASE_[A-Z_]+$/u.test(error.message) ? error.message : 'RELEASE_PREPARATION_FAILED') + '\n');
    process.exitCode = 1;
  }
}
