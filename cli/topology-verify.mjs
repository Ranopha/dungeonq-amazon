import { lstat, readFile } from 'node:fs/promises';
import { replayTopology } from '../world/topology.mjs';
try {
  if (process.argv.length !== 3) throw Error('TOPOLOGY_EVIDENCE_ARGUMENT_INVALID');
  const info = await lstat(process.argv[2]);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) throw Error('TOPOLOGY_EVIDENCE_FILE_INVALID');
  const result = replayTopology(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(process.argv[2]))));
  process.stdout.write(`${JSON.stringify({ ...result, claim: 'CAUSAL_REPLAY_NOT_MODEL_EFFICACY_OR_INDEPENDENT_PROVENANCE' })}\n`);
} catch (error) {
  const code = error.code ?? error.message;
  process.stderr.write(`${/^[A-Z_]{1,80}$/.test(code) ? code : 'TOPOLOGY_EVIDENCE_REJECTED'}\n`); process.exitCode = 1;
}
