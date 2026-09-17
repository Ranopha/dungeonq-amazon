import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, lstat, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exportDistribution, PUBLIC_SOURCE_PATHS } from '../scripts/lib/distribution-export.mjs';
import { prepareRelease } from '../scripts/lib/release-builder.mjs';
import { verifySource } from '../scripts/lib/source-manifest.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
async function temp(t) { const path = await mkdtemp(join(tmpdir(), 'dungeonq-release-package-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function file(root, path, content) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
function metadata(name = 'dungeonq') { return { name, version: '0.6.0', private: true, license: 'Apache-2.0',
  repository: { url: `git+https://github.com/Ranopha/${name}.git` }, scripts: { study: 'node scripts/study.mjs', world: 'node scripts/world.mjs', 'astra:site': 'node scripts/build-astra-site.mjs' } }; }
async function writeMetadata(root, name) {
  const pkg = metadata(name); await file(root, 'package.json', JSON.stringify(pkg));
  await file(root, 'package-lock.json', JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
    packages: { '': { name: pkg.name, version: pkg.version, license: pkg.license } } }));
}
async function exportFixture(t) {
  const base = await temp(t); const source = join(base, 'source'); await mkdir(source);
  const directories = new Set(['app', 'assistant', 'astra', 'cli', 'deploy', 'public', 'server', 'tests', 'workbench', 'world', 'study', 'scripts/lib']);
  for (const path of PUBLIC_SOURCE_PATHS) {
    if (directories.has(path)) await file(source, `${path}/synthetic.txt`, 'synthetic fixture');
    else await file(source, path, 'synthetic fixture');
  }
  await writeMetadata(source, 'dungeonq');
  for (const path of ['world/kernel.mjs', 'study/experiment.mjs', 'study/designs/archive.json', 'astra-site/index.html',
    'scripts/build-astra-site.mjs', 'docs/SCENARIO_AUTHORING.md']) await file(source, path, 'synthetic fixture');
  for (const target of ['amazon', 'astra']) await file(source, `${target}-release/README.md`, `Synthetic ${target}`);
  for (const path of ['STUDY_LAB.md', 'STUDY_RESULTS.md', 'WORLD_LAB.md', 'contracts/STUDY_V1.md', 'contracts/WORLD_V1.md', 'TOPOLOGY_LAB.md', 'TOPOLOGY_RESULTS.md', 'contracts/TOPOLOGY_V2.md']) {
    await file(source, `release-study/docs/${path}`, 'Synthetic public documentation');
  }
  await file(source, 'release-study/evidence/study-v1/reference-proof.json', '{"profile":"SYNTHETIC_CAUSAL_STUDY"}');
  await file(source, 'release-study/evidence/topology-v2/proof.json', '{"profile":"SYNTHETIC_TOPOLOGY_WORKFLOW"}');
  for (const path of ['study-evidence.png', 'study-trace.png', 'topology-evidence.png', 'topology-observer.png']) await file(source, `release-study/media/${path}`, 'synthetic media fixture');
  return { base, source };
}

test('兩種乾淨匯出皆含world/study及英文證據；Amazon不宣告Astra網站建置', async t => {
  const { base, source } = await exportFixture(t);
  for (const target of ['amazon', 'astra']) {
    const output = join(base, target); await mkdir(output);
    const result = await exportDistribution({ root: source, output, target }); assert.ok(result.files > 30);
    assert.equal((await verifySource(output)).passed, true);
    for (const path of ['world/kernel.mjs', 'study/experiment.mjs', 'scripts/world.mjs', 'scripts/world-proof.mjs',
      'scripts/study.mjs', 'scripts/study-proof.mjs', 'docs/STUDY_LAB.md', 'docs/STUDY_RESULTS.md',
      'docs/contracts/STUDY_V1.md', 'docs/WORLD_LAB.md', 'docs/contracts/WORLD_V1.md', 'evidence/study-v1/reference-proof.json',
      'media/study-evidence.png', 'media/study-trace.png', 'scripts/topology.mjs', 'scripts/topology-proof.mjs',
      'docs/TOPOLOGY_LAB.md', 'docs/TOPOLOGY_RESULTS.md', 'docs/contracts/TOPOLOGY_V2.md', 'evidence/topology-v2/proof.json']) {
      assert.equal((await lstat(join(output, path))).isFile(), true, path);
    }
    const pkg = JSON.parse(await readFile(join(output, 'package.json'))); assert.equal(pkg.name, `dungeonq-${target}`); assert.equal(pkg.version, '0.6.0');
    const sbom = JSON.parse(await readFile(join(output, 'SBOM.cdx.json')));
    assert.equal(sbom.metadata.component.name, pkg.name); assert.equal(sbom.metadata.component.purl, `pkg:npm/${pkg.name}@0.6.0`);
    assert.ok(sbom.dependencies.some(row => row.ref === `${pkg.name}@0.6.0`));
    if (target === 'amazon') {
      assert.equal(pkg.scripts['astra:site'], undefined); await assert.rejects(lstat(join(output, 'scripts/build-astra-site.mjs')), { code: 'ENOENT' });
    } else assert.equal((await lstat(join(output, 'scripts/build-astra-site.mjs'))).isFile(), true);
    assert.ok(!(await readdir(output)).includes('.git')); assert.ok(!(await readdir(output)).includes('release-study'));
    await assert.rejects(exportDistribution({ root: source, output, target }), /EXPORT_REQUIRES_EMPTY_EXTERNAL_DIRECTORY/);
  }
});

test('來源匯出遇本機安裝／token／symlink即拒絕，輸出保持空白', async t => {
  for (const kind of ['installation', 'token', 'symlink']) await t.test(kind, async t => {
    const { base, source } = await exportFixture(t); const output = join(base, 'out'); await mkdir(output);
    if (kind === 'installation') await file(source, 'world/world-installation.json', '{}');
    else if (kind === 'token') await file(source, 'study/accidental.json', JSON.stringify({ actorToken: 'synthetic-private-capability' }));
    else await symlink(join(source, 'world/kernel.mjs'), join(source, 'study/link.mjs'));
    await assert.rejects(exportDistribution({ root: source, output, target: 'amazon' }), /NON_SOURCE_EXPORT_DENIED|EXPORT_SECRET_PATTERN_DENIED|SYMLINK_NOT_EXPORTABLE/);
    assert.deepEqual(await readdir(output), []);
  });
});

test('public release重建拒絕已追蹤的study安裝紀錄，不寫輸出', async t => {
  const base = await temp(t); const checkout = join(base, 'checkout'); await mkdir(checkout); await writeMetadata(checkout, 'dungeonq-amazon');
  await file(checkout, 'study-installation.json', '{}');
  const git = args => exec('git', args, { cwd: checkout });
  await git(['init', '-q']); await git(['add', 'package.json', 'package-lock.json', 'study-installation.json']);
  await git(['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic packaging fixture']);
  const output = join(base, 'release');
  await assert.rejects(prepareRelease({ root: checkout, output }), /RELEASE_SOURCE_PATH_DENIED/);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
});

test('即使manifest摘要吻合，私人安裝／DB／憑證路徑仍不算合格公開來源', async t => {
  const base = await temp(t);
  for (const path of ['study-installation.json', 'world-installation.json', 'topology-installation.json', 'world.sqlite', 'study.sqlite-wal', 'tokens.json', '.env.local']) {
    const directory = join(base, path.replaceAll('.', '_')); await mkdir(directory); const data = Buffer.from('{}');
    await file(directory, path, data);
    await file(directory, 'RELEASE_MANIFEST.json', JSON.stringify({ schemaVersion: 'dungeonq.source-release/v1', profile: 'SYNTHETIC_ONLY', privateHistoryIncluded: false,
      entries: [{ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }] }));
    assert.equal((await verifySource(directory)).passed, false, path);
  }
});

test('實際套件版本／lock一致，所有已宣告本機CLI皆存在', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'))); const lock = JSON.parse(await readFile(join(root, 'package-lock.json')));
  assert.equal(pkg.version, lock.version); assert.equal(pkg.version, lock.packages[''].version);
  for (const script of Object.values(pkg.scripts)) for (const match of script.matchAll(/\b((?:scripts|cli)\/[A-Za-z0-9/_.-]+\.mjs)\b/gu)) {
    assert.equal((await lstat(join(root, match[1]))).isFile(), true, match[1]);
  }
  if (pkg.name !== 'dungeonq') for (const path of ['docs/STUDY_LAB.md', 'docs/STUDY_RESULTS.md', 'evidence/study-v1/reference-proof.json']) {
    assert.equal((await lstat(join(root, path))).isFile(), true, path);
  }
});
