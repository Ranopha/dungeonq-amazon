import { readFileSync, statSync } from 'node:fs';
import { replayWorld } from '../world/kernel.mjs';

try {
  if (process.argv.length !== 3) throw new Error('用法：npm run world:verify -- evidence.json');
  if (statSync(process.argv[2]).size > 2_000_000) throw new Error('WORLD_EVIDENCE_TOO_LARGE');
  const result = replayWorld(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  process.stdout.write(`${JSON.stringify({ ...result, claim: 'LOCAL_CAUSAL_REPLAY_NOT_DECEPTION_EFFICACY' })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ valid: false, error: error.code ?? error.message })}\n`);
  process.exitCode = 1;
}
