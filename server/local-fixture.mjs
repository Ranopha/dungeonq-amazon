import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openGovernance } from './governance.mjs';

// 可丟棄本機 Fixture；不接收任意路徑、企業帳密或可執行場景。
export async function createLocalFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dungeonq-workbench-'));
  let core;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
      '-keyout', join(directory, 'tls-key.pem'), '-out', join(directory, 'tls-cert.pem'),
      '-subj', '/CN=DungeonQ Local Fixture', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore', timeout: 15_000 });
    const tls = { key: await readFile(join(directory, 'tls-key.pem')), cert: await readFile(join(directory, 'tls-cert.pem')) };
    const privateKey = generateKeyPairSync('ed25519').privateKey;
    core = await openGovernance({ path: join(directory, 'governance.sqlite'), privateKey, keyId: 'local-lab-v1', factorKey: randomBytes(32) });
    const password = randomBytes(20).toString('base64url');
    await core.local.bootstrap({ tenantId: 'tenant-lab', username: 'owner-lab', password, assetIds: ['api-orders', 'api-inventory'] });
    const members = [];
    for (const [username, role] of [['mis-lab', 'MIS_OPERATOR'], ['reviewer-lab', 'REVIEWER'], ['auditor-lab', 'AUDITOR']]) {
      const memberPassword = randomBytes(20).toString('base64url');
      await core.local.provisionMember({ tenantId: 'tenant-lab', username, password: memberPassword, role });
      members.push({ username, role, password: memberPassword });
    }
    let closed = false;
    return { core, tls, password, members, close: async () => {
      if (closed) return; closed = true; core.close(); await rm(directory, { recursive: true, force: true });
    } };
  } catch (error) { core?.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
