import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { join, resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { verifySource } from './source-manifest.mjs';
import { hasReleaseSecret, isPublicSourcePath } from './release-paths.mjs';

const exec = promisify(execFile);

export async function prepareRelease({ root, output }) {
  root = resolve(root); output = resolve(output);
  const rel = relative(root, output);
  if (!rel.startsWith('..') || rel === '..') throw new Error('RELEASE_OUTSIDE_CHECKOUT_REQUIRED');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!['dungeonq-amazon', 'dungeonq-astra'].includes(pkg.name) || pkg.repository?.url !== `git+https://github.com/Ranopha/${pkg.name}.git`) {
    throw new Error('RELEASE_PUBLIC_CHECKOUT_REQUIRED');
  }
  const git = async args => (await exec('git', args, { cwd: root, maxBuffer: 4_194_304 })).stdout;
  if ((await git(['status', '--porcelain', '--untracked-files=all'])).trim()) throw new Error('RELEASE_CLEAN_COMMIT_REQUIRED');
  const commit = (await git(['rev-parse', 'HEAD'])).trim();
  const files = (await git(['ls-files', '-z'])).split('\0').filter(Boolean);
  if (!files.length || files.length > 10000 || files.some(path => !isPublicSourcePath(path))) throw new Error('RELEASE_SOURCE_PATH_DENIED');
  // Validate all inputs before creating a destination. No Git history, ignored files or lab state.
  const source = [];
  for (const path of files) {
    if (['RELEASE_MANIFEST.json', 'SBOM.cdx.json'].includes(path)) continue;
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576) throw new Error('RELEASE_SOURCE_TYPE_DENIED');
    const data = await readFile(join(root, path));
    if (hasReleaseSecret(data.toString())) {
      throw new Error('RELEASE_SECRET_PATTERN_DENIED');
    }
    source.push([path, data]);
  }
  const sbom = (await exec('npm', ['sbom', '--sbom-format=cyclonedx', '--package-lock-only'], {
    cwd: root, maxBuffer: 4_194_304, timeout: 60000
  })).stdout;
  source.push(['SBOM.cdx.json', Buffer.from(JSON.stringify(JSON.parse(sbom)) + '\n')]);
  if ((await git(['status', '--porcelain', '--untracked-files=all'])).trim()
    || (await git(['rev-parse', 'HEAD'])).trim() !== commit) throw new Error('RELEASE_SOURCE_CHANGED');
  await mkdir(output, { mode: 0o700 });
  const entries = [];
  for (const [path, data] of source) {
    await mkdir(dirname(join(output, path)), { recursive: true });
    await writeFile(join(output, path), data, { flag: 'wx' });
    entries.push({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(join(output, 'RELEASE_MANIFEST.json'), JSON.stringify({ schemaVersion: 'dungeonq.source-release/v1',
    profile: 'SYNTHETIC_ONLY', privateHistoryIncluded: false, sourceCommit: commit,
    generatedAt: new Date().toISOString(), entries }, null, 2) + '\n', { flag: 'wx' });
  const verified = await verifySource(output);
  if (!verified.passed) throw new Error('RELEASE_INVENTORY_FAILED');
  return { passed: true, sourceCommit: commit, files: entries.length, authenticityProven: false };
}
