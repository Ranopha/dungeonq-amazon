import { resolve } from 'node:path';
import { verifyWorkspacePilot } from './lib/workspace-pilot-verifier.mjs';
const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length) throw Error('PASS_RECORDED_WORKSPACE_EVIDENCE_DIRECTORY');
console.log(JSON.stringify(await verifyWorkspacePilot(resolve(directory)), null, 2));
