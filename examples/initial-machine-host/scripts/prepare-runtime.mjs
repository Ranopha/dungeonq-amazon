import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dungeonqRuntimeCommit } from '../plugins/dungeonq-host-integration/src/contracts.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const destination = resolve(root, 'vendor/dungeonq-runtime');
if (existsSync(destination)) throw Error('NEW_RUNTIME_DIRECTORY_REQUIRED');
mkdirSync(dirname(destination), { recursive: true });
const source = process.argv[2] ?? 'https://github.com/Ranopha/dungeonq-amazon.git';
execFileSync('git', ['clone', '--no-hardlinks', '--no-checkout', source, destination], { stdio: 'inherit' });
execFileSync('git', ['-C', destination, '-c', 'advice.detachedHead=false', 'checkout', '--detach', dungeonqRuntimeCommit], { stdio: 'inherit' });
execFileSync('npm', ['ci', '--ignore-scripts'], { cwd: destination, stdio: 'inherit' });
process.stdout.write('Pinned artificial runtime prepared. No model or external notification was started.\n');
