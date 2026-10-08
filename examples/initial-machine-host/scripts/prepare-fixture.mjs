import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { installHostLayout,prepareInstallation } from '../plugins/dungeonq-host-integration/src/target-witness.ts';
const root=resolve(import.meta.dirname,'..');
await installHostLayout(root);
await writeFile(join(root,'.local/dungeonq-host/target/target.txt'),randomBytes(32),{flag:'wx',mode:0o600});
await prepareInstallation(root,true);
console.log(JSON.stringify({status:'PREPARED',profile:'ARTIFICIAL_FILE_ONLY'}));
