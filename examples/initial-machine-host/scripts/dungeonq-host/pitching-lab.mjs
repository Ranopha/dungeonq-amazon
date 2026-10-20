import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRuntimeSource } from '../../plugins/dungeonq-host-integration/src/runtime-bridge.ts';
import { captureTargetWitness, targetWitnessUnchanged } from '../../plugins/dungeonq-host-integration/src/target-witness.ts';
import { dungeonqTargetRelativePath } from '../../plugins/dungeonq-host-integration/src/contracts.ts';
import { startRuntimeGateway } from '../../vendor/dungeonq-runtime/runtime/server.mjs';
import { openPitchOwnerLock } from '../../vendor/dungeonq-runtime/runtime/pitch-owner-lock.mjs';
import { insist, newToken, privateJson, request } from '../../vendor/dungeonq-runtime/runtime/transport.mjs';
import { isRealityVariant } from '../../vendor/dungeonq-runtime/runtime/pitching-reality.mjs';
import { hostSourceDigest, startHostWorker } from './adversarial-lab.mjs';

const sourceRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** 初號機人工 FileOrigin 與配球共用真 gateway；不載入歷史 installation 或正式資料。 */
export async function startHostPitching({ directory, repoRoot = sourceRoot, seed = 17,
  variant = 'combined-v7', mode = 'adaptive', port = 0 } = {}) {
  insist(typeof directory === 'string', 'PRIVATE_DIRECTORY_REQUIRED');
  insist(isRealityVariant(variant) && [17, 29, 43].includes(seed)
    && ['adaptive', 'fixed'].includes(mode), 'PITCHING_PROFILE_INVALID');
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  insist(info.isDirectory() && !info.isSymbolicLink() && !(info.mode & 0o077), 'PRIVATE_DIRECTORY_REQUIRED');
  const source = verifyRuntimeSource(repoRoot);
  const hostDigest = hostSourceDigest();
  // Own the directory before creating source/configuration or starting any child process.
  const lock = openPitchOwnerLock({ path: join(directory, 'pitch-owner.sqlite') });
  const children = []; let gateway; let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    try { await gateway?.close(); }
    finally { try { for (const child of children.reverse()) await child.close(); } finally { lock.close(); } }
  };
  try {
    const fixtureRoot = join(directory, 'fixture');
    const targetPath = join(fixtureRoot, dungeonqTargetRelativePath);
    const configurationPath = join(directory, 'host-pitching.json');
    if (!existsSync(configurationPath)) {
      // Never reinterpret an existing target or legacy lab as a fresh v7 fixture.
      insist(!existsSync(targetPath) && !existsSync(join(directory, 'runtime.sqlite'))
        && !existsSync(join(directory, 'configuration.json')), 'FRESH_FIXTURE_REQUIRED');
      mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
      let segmentPath = directory;
      for (const segment of ['fixture', ...dungeonqTargetRelativePath.split('/').slice(0, -1)]) {
        segmentPath = join(segmentPath, segment); const segmentInfo = lstatSync(segmentPath);
        insist(segmentInfo.isDirectory() && !segmentInfo.isSymbolicLink() && !(segmentInfo.mode & 0o077), 'PRIVATE_DIRECTORY_REQUIRED');
      }
      writeFileSync(targetPath, `ARTIFICIAL_INITIAL_MACHINE_V7_${randomBytes(24).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    }
    const currentWitness = await captureTargetWitness(fixtureRoot);
    const configuration = privateJson(configurationPath, () => ({
      schemaVersion: 'dungeonq.initial-machine-pitching/v1', profile: 'SYNTHETIC_ONLY',
      source: { commit: source.commit, version: source.version, hostDigest }, seed, variant, mode,
      createdAt: new Date().toISOString(), baseline: currentWitness,
      credentials: Object.fromEntries(['owner', 'actor', 'other', 'ordinary', 'seal', 'producer', 'reader', 'witness'].map(key => [key, newToken()])),
    }));
    insist(configuration.schemaVersion === 'dungeonq.initial-machine-pitching/v1'
      && configuration.source.commit === source.commit && configuration.source.version === source.version
      && configuration.source.hostDigest === hostDigest && configuration.seed === seed
      && configuration.variant === variant && configuration.mode === mode, 'HOST_PROFILE_MISMATCH');
    insist(targetWitnessUnchanged(configuration.baseline, currentWitness), 'TARGET_CHANGED_SINCE_PREPARE');
    const credentials = configuration.credentials;
    const origin = await startHostWorker('origin', { targetPath, baseline: configuration.baseline,
      directory: join(directory, 'origin'), normalToken: credentials.ordinary, witnessToken: credentials.witness,
      accessPolicy: { tenantId: 'reference', principalId: 'ordinary-connector', readTarget: true,
        readOtherRecords: true, writeOtherRecords: true, issueTickets: true } });
    children.push(origin);
    const collector = await startHostWorker('collector', { path: join(directory, 'collector.sqlite'),
      producerToken: credentials.producer, readerToken: credentials.reader });
    children.push(collector);
    gateway = await startRuntimeGateway({ directory, credentials, originOrigin: origin.origin,
      collectorOrigin: collector.origin, port, network: false, hostBroker: false,
      presentation: 'pitching-v1', pitchingSeed: seed, pitchingMode: mode, pitchingVariant: variant, pitchOwnerLock: lock,
      facadeFactory: async stateOrigin => { const child = await startHostWorker('facade', { stateOrigin }); children.push(child); return child; } });
    const checkpoint = async () => {
      const runtime = await gateway.evidence();
      const witness = await request(origin.origin, '/witness', credentials.witness, undefined, { maxResponse: 16_777_216 });
      const unchanged = targetWitnessUnchanged(configuration.baseline, await captureTargetWitness(fixtureRoot));
      const currentSource = verifyRuntimeSource(repoRoot);
      const sourceUnchanged = currentSource.commit === source.commit && hostSourceDigest() === hostDigest;
      const acceptedOnlyOrdinary = witness.acceptedContexts.every(context => context === 'ordinary');
      return { schemaVersion: 'dungeonq.initial-machine-pitching-checkpoint/v1', at: new Date().toISOString(),
        source: configuration.source, seed, variant, mode,
        status: runtime.status === 'PASS' && unchanged && sourceUnchanged && acceptedOnlyOrdinary ? 'PASS' : 'FAIL',
        targetUnchanged: unchanged, sourceUnchanged, acceptedOnlyOrdinary, witness, runtime,
        claim: 'LOCAL_ARTIFICIAL_HOST_INTEGRATION_NOT_MODEL_EFFICACY' };
    };
    return { ...gateway, directory, credentials, source: configuration.source, configuration,
      originService: origin, checkpoint, close };
  } catch (error) { await close(); throw error; }
}
