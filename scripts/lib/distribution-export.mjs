import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, lstat, mkdir } from 'node:fs/promises';
import { resolve, join, dirname, relative, sep, posix } from 'node:path';
import { hasReleaseSecret, isPublicSourcePath } from './release-paths.mjs';
import { verifySource } from './source-manifest.mjs';

const exec = promisify(execFile);
// Both distributions share the same tested dependency graph. Branding is an explicit document/metadata overlay.
export const PUBLIC_SOURCE_PATHS = Object.freeze([
  '.gitignore', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json',
  'tsconfig.json', 'vite.config.ts', 'next.config.ts', 'app', 'assistant', 'astra', 'cli', 'deploy',
  'public', 'server', 'tests', 'workbench', 'world', 'study', 'scripts/lib',
  'scripts/amazon.mjs', 'scripts/astra.mjs', 'scripts/astra-proof.mjs',
  'scripts/world.mjs', 'scripts/world-proof.mjs', 'scripts/study.mjs', 'scripts/study-proof.mjs',
  'scripts/topology.mjs', 'scripts/topology-proof.mjs',
  'scripts/defense.mjs', 'scripts/defense-proof.mjs',
  'scripts/email-proof.mjs',
  'scripts/workspace-pilot-verify.mjs', 'scripts/defense-pilot-verify.mjs',
  'scripts/workspace-pilot-host.mjs', 'scripts/workspace-pilot-client.mjs',
  'scripts/doctor.mjs', 'scripts/demo-proof.mjs', 'scripts/mcp-client.mjs', 'scripts/prepare-release.mjs',
  'scripts/verify-source.mjs', 'scripts/audit.mjs', 'scripts/check-isolation.mjs', 'scripts/company-acceptance.mjs',
  'scripts/serve.mjs', 'scripts/verify.mjs', 'scripts/verify-assistant-evidence.mjs',
  'scripts/verify-company-report.mjs', 'scripts/workbench.mjs',
]);
const sharedDocuments = ['docs/STUDY_LAB.md', 'docs/STUDY_RESULTS.md', 'docs/WORLD_LAB.md',
  'docs/contracts/STUDY_V1.md', 'docs/contracts/WORLD_V1.md', 'evidence/study-v1',
  'docs/TOPOLOGY_LAB.md', 'docs/TOPOLOGY_RESULTS.md', 'docs/contracts/TOPOLOGY_V2.md', 'evidence/topology-v2',
  'docs/DEFENSE_LAB.md', 'docs/OSS_REVIEW_GUIDE.md', 'docs/contracts/DEFENSE_GOVERNANCE_V1.md', 'evidence/defense-v1',
  'docs/WORKSPACE_LAB.md', 'docs/DEFENSE_PILOT_RESULTS.md', 'docs/contracts/ORDERS_WORKSPACE_V1.md',
  'evidence/workspace-pilot-v1', 'evidence/defense-pilot-v1',
  'docs/EMAIL_NOTIFICATIONS.md', 'docs/START_HERE.zh-TW.md', 'evidence/email-v1',
  'media/study-evidence.png', 'media/study-trace.png', 'media/topology-evidence.png', 'media/topology-observer.png'];
const targets = {
  amazon: { name: 'dungeonq-amazon', description: 'Synthetic assistant governance, persistent abstract worlds and consent-based causal studies with local MCP and replayable evidence.' },
  astra: { name: 'dungeonq-astra', description: 'Bounded Astra governance rehearsal and synthetic causal studies with separate authority, local MCP and replayable evidence.' },
};

export async function exportDistribution({ root, output, target }) {
  root = resolve(root); output = resolve(output); const configuration = targets[target];
  if (!configuration) throw new Error('EXPORT_TARGET_INVALID');
  const info = await lstat(output);
  const relativeOutput = relative(root, output);
  if (!(relativeOutput === '..' || relativeOutput.startsWith(`..${sep}`)) || !info.isDirectory() || info.isSymbolicLink() || (await readdir(output)).length) {
    throw new Error('EXPORT_REQUIRES_EMPTY_EXTERNAL_DIRECTORY');
  }
  const files = new Map();
  async function copy(path, destination = path) {
    const source = join(root, path); const stat = await lstat(source);
    if (stat.isSymbolicLink()) throw new Error('SYMLINK_NOT_EXPORTABLE');
    if (!isPublicSourcePath(destination)) throw new Error('NON_SOURCE_EXPORT_DENIED');
    if (stat.isDirectory()) {
      for (const name of (await readdir(source)).sort()) await copy(posix.join(path, name), posix.join(destination, name));
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_048_576) throw new Error('NON_SOURCE_EXPORT_DENIED');
    let data = await readFile(source);
    if (hasReleaseSecret(data.toString('utf8'))) throw new Error('EXPORT_SECRET_PATTERN_DENIED');
    if (['package.json', 'package-lock.json', 'scripts/audit.mjs', 'tests/development-boundary.test.mjs'].includes(path)) {
      data = Buffer.from(data.toString('utf8').replaceAll('github.com/Ranopha/dungeonq', `github.com/Ranopha/${configuration.name}`));
    }
    if (path === 'package.json') {
      const pkg = JSON.parse(data); pkg.name = configuration.name; pkg.description = configuration.description;
      if (target === 'amazon') delete pkg.scripts?.['astra:site'];
      data = Buffer.from(JSON.stringify(pkg, null, 2) + '\n');
    } else if (path === 'package-lock.json') {
      const lock = JSON.parse(data); lock.name = configuration.name; lock.packages[''].name = configuration.name;
      data = Buffer.from(JSON.stringify(lock, null, 2) + '\n');
    }
    if (files.has(destination)) throw new Error('EXPORT_DESTINATION_COLLISION');
    files.set(destination, data);
  }
  for (const path of PUBLIC_SOURCE_PATHS) await copy(path);
  if (target === 'astra') for (const path of ['astra-site', 'scripts/build-astra-site.mjs']) await copy(path);
  await copy('docs/SCENARIO_AUTHORING.md', 'docs/SCENARIO_PACK.md');
  for (const name of (await readdir(join(root, `${target}-release`))).sort()) await copy(posix.join(`${target}-release`, name), name);
  // This one shared reviewer guide intentionally supersedes the older branded guide.
  files.delete('docs/OSS_REVIEW_GUIDE.md');
  for (const path of sharedDocuments) await copy(posix.join('release-study', path), path);
  // Snapshot the locked graph only: no dependency installation or credential/environment export.
  const sbom = JSON.parse((await exec('npm', ['sbom', '--sbom-format=cyclonedx', '--package-lock-only'], {
    cwd: root, encoding: 'utf8', maxBuffer: 4_194_304, timeout: 60_000,
  })).stdout);
  const previousRef = sbom.metadata.component['bom-ref'];
  const releaseRef = `${configuration.name}@${sbom.metadata.component.version}`;
  sbom.metadata.component.name = configuration.name; sbom.metadata.component.description = configuration.description;
  sbom.metadata.component['bom-ref'] = releaseRef; sbom.metadata.component.purl = `pkg:npm/${releaseRef}`;
  for (const dependency of sbom.dependencies ?? []) if (dependency.ref === previousRef) dependency.ref = releaseRef;
  for (const reference of sbom.metadata.component.externalReferences ?? []) {
    reference.url = reference.url.replaceAll('github.com/Ranopha/dungeonq', `github.com/Ranopha/${configuration.name}`);
  }
  files.set('SBOM.cdx.json', Buffer.from(JSON.stringify(sbom) + '\n'));
  const entries = [];
  for (const [path, data] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    await mkdir(dirname(join(output, path)), { recursive: true });
    await writeFile(join(output, path), data, { flag: 'wx' });
    entries.push({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
  await writeFile(join(output, 'RELEASE_MANIFEST.json'), JSON.stringify({ schemaVersion: 'dungeonq.source-release/v1',
    profile: 'SYNTHETIC_ONLY', generatedAt: new Date().toISOString(), privateHistoryIncluded: false, entries }, null, 2) + '\n', { flag: 'wx' });
  const verified = await verifySource(output);
  if (!verified.passed) throw new Error('EXPORT_INVENTORY_FAILED');
  return { output, files: entries.length, manifest: 'RELEASE_MANIFEST.json', privateHistoryIncluded: false };
}
