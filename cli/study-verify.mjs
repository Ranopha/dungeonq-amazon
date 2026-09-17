import { lstat, readFile } from 'node:fs/promises';
import { replayStudy } from '../study/experiment.mjs';
try {
  if (process.argv.length !== 3) throw new Error('用法：npm run study:verify -- EVIDENCE_FILE');
  const info = await lstat(process.argv[2]);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) throw new Error('STUDY_EVIDENCE_FILE_INVALID');
  const result = replayStudy(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(process.argv[2]))));
  process.stdout.write(`${JSON.stringify({ ...result, claim: 'CAUSAL_REPLAY_NOT_GENERAL_DECEPTION_EFFICACY' })}\n`);
} catch (error) { process.stderr.write(`${error.code ?? error.message}\n`); process.exitCode = 1; }
