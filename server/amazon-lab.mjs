import { mkdtemp, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { generateKeyPairSync, createPrivateKey, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openGovernance } from './governance.mjs';
import { admitScenarioPack } from '../public/src/admission.mjs';
import { exact, requireThat, token, digest, id } from './contracts.mjs';

// An explicitly local disposable installation, not a general secret manager or cloud deployment.
export async function openAmazonLab({ directory, scenario }) {
  const admitted = await admitScenarioPack(scenario);
  admitted.scenario.environment.assets.forEach(asset => id(asset.id));
  const target = directory ?? await mkdtemp(join(tmpdir(), 'dungeonq-amazon-'));
  requireThat(isAbsolute(target), 'STORAGE_PATH_INVALID');
  const info = await lstat(target);
  requireThat(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'STORAGE_NOT_PRIVATE');
  const statePath = join(target, 'local-instance.json');
  let saved; let core; let password; let created = false;
  try {
    const stateInfo = await lstat(statePath);
    requireThat(stateInfo.isFile() && !stateInfo.isSymbolicLink() && stateInfo.nlink === 1 && (stateInfo.mode & 0o077) === 0
      && stateInfo.size <= 16_384, 'STORAGE_NOT_PRIVATE');
    saved = JSON.parse(await readFile(statePath, 'utf8'));
    exact(saved, ['version', 'profile', 'scenarioDigest', 'privateKey', 'factorKey', 'workerToken', 'accessToken']);
    requireThat(saved.version === 1 && saved.profile === 'SYNTHETIC_ONLY'
      && saved.scenarioDigest === digest(admitted.scenario), 'INSTANCE_MISMATCH');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    requireThat((await readdir(target)).length === 0, 'INSTANCE_INCOMPLETE');
    created = true;
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30',
      '-keyout', join(target, 'tls-key.pem'), '-out', join(target, 'tls-cert.pem'), '-subj', '/CN=DungeonQ Synthetic Lab',
      '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore', timeout: 15_000 });
    saved = { version: 1, profile: 'SYNTHETIC_ONLY', scenarioDigest: digest(admitted.scenario),
      privateKey: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
      factorKey: randomBytes(32).toString('base64url'), workerToken: '', accessToken: token() };
  }
  try {
    const tls = { key: await readFile(join(target, 'tls-key.pem')), cert: await readFile(join(target, 'tls-cert.pem')) };
    core = await openGovernance({ path: join(target, 'governance.sqlite'), privateKey: createPrivateKey(saved.privateKey),
      keyId: 'amazon-local-lab', factorKey: Buffer.from(saved.factorKey, 'base64url') });
    if (created) {
      password = token();
      await core.local.bootstrap({ tenantId: 'tenant-lab', username: 'owner-lab', password,
        assetIds: admitted.scenario.environment.assets.map(asset => asset.id) });
      saved.workerToken = core.local.provisionWorker({ tenantId: 'tenant-lab', workerId: 'assistant-worker', expiresAt: Date.now() + 30 * 86_400_000 }).workerToken;
      await writeFile(statePath, JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
    }
    core.execution.inspect(saved.workerToken);
    let closed = false;
    return { directory: target, scenario: admitted.scenario, core, tls, password,
      workerToken: saved.workerToken, accessToken: saved.accessToken,
      seedObservation: input => core.local.recordObservation({ tenantId: 'tenant-lab', ...input }),
      close() { if (!closed) { closed = true; core.close(); } } };
  } catch (error) { core?.close(); throw error; }
}
