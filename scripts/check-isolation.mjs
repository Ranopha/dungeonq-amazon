import { readFile } from 'node:fs/promises';
import { validateIsolationPlan } from '../server/isolation-plan.mjs';

try {
  const bytes = await readFile(new URL('../deploy/lab-isolation.json', import.meta.url));
  if (bytes.length > 65536) throw new Error('MANIFEST_LIMIT');
  process.stdout.write(JSON.stringify(validateIsolationPlan(JSON.parse(bytes))) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ configurationValid: false, error: error.code ?? 'MANIFEST_INVALID' }) + '\n'); process.exitCode = 1;
}
