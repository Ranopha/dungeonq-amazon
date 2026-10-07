import { readFile, writeFile, mkdir, mkdtemp, rename, rm, readdir, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, sep, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { collectStaticAssets, readStaticAsset, assetManifest, BUILD_MARKER, requireStatic } from './lib/static-assets.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
export async function buildStaticSite({ sourceRoot = join(repository, 'public'), output = join(repository, 'dist/static'), runtimeClient = join(repository, 'sdk/runtime-client.mjs') } = {}) {
  sourceRoot = resolve(sourceRoot); output = resolve(output);
  const relation = relative(sourceRoot, output); const inverse = relative(output, sourceRoot);
  requireStatic((relation === '..' || relation.startsWith('..' + sep)) && (inverse === '..' || inverse.startsWith('..' + sep)), 'BUILD_OUTPUT_MUST_BE_OUTSIDE_SOURCE');
  const entries = await collectStaticAssets(sourceRoot);
  if (runtimeClient) {
    requireStatic(!entries.some(entry => entry.path === 'runtime/client.mjs'), 'STATIC_DESTINATION_COLLISION');
    const data = await readStaticAsset(dirname(runtimeClient), 'runtime-client.mjs');
    entries.push({ path: 'runtime/client.mjs', data, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  const manifest = { schemaVersion: 'dungeonq.static-build/v1', profile: 'STATIC_ASSETS_ONLY', entries: assetManifest(entries) };
  let previous = false;
  const info = await lstat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info) {
    requireStatic(info.isDirectory() && !info.isSymbolicLink(), 'BUILD_OUTPUT_DENIED');
    previous = true;
    if ((await readdir(output)).length) {
      const markerPath = join(output, BUILD_MARKER); const markerInfo = await lstat(markerPath).catch(() => null);
      requireStatic(markerInfo?.isFile() && !markerInfo.isSymbolicLink() && markerInfo.nlink === 1 && markerInfo.size < 1048576, 'BUILD_OUTPUT_NOT_OWNED');
      const saved = JSON.parse(await readFile(markerPath, 'utf8'));
      requireStatic(saved.schemaVersion === manifest.schemaVersion && saved.profile === manifest.profile, 'BUILD_OUTPUT_NOT_OWNED');
      requireStatic(JSON.stringify(saved.entries) === JSON.stringify(assetManifest(await collectStaticAssets(output, { markerAllowed: true }))), 'BUILD_OUTPUT_MODIFIED');
    }
  }
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), '.dq-static-'));
  const backup = staging + '-previous'; let moved = false;
  try {
    for (const { path, data } of entries) {
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await writeFile(join(staging, path), data, { flag: 'wx' });
    }
    await writeFile(join(staging, BUILD_MARKER), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    requireStatic(JSON.stringify(manifest.entries) === JSON.stringify(assetManifest(await collectStaticAssets(staging, { markerAllowed: true }))), 'BUILD_READBACK_FAILED');
    if (previous) { await rename(output, backup); moved = true; }
    try { await rename(staging, output); } catch (error) { if (moved) { await rename(backup, output); moved = false; } throw error; }
    if (moved) await rm(backup, { recursive: true });
    return { schemaVersion: manifest.schemaVersion, output, files: entries.length, sourceFiles: entries.length - (runtimeClient ? 1 : 0),
      contentDigest: createHash('sha256').update(JSON.stringify(manifest.entries)).digest('hex'), profile: manifest.profile, apiHosted: false };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    requireStatic(args.length === 0 || args.length === 2 && args[0] === '--out' && args[1], 'USE_BUILD_STATIC_OPTIONAL_OUT_DIRECTORY');
    console.log(JSON.stringify(await buildStaticSite(args.length ? { output: args[1] } : {})));
  } catch (error) { console.error(error.code ?? error.message); process.exitCode = 1; }
}
