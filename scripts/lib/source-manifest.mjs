import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isPublicSourcePath } from './release-paths.mjs';

const excluded = new Set(['.git', 'node_modules', 'dist', '.vinext', '.next', '.wrangler', '.DS_Store',
  'tsconfig.tsbuildinfo', 'next-env.d.ts']);
const validPath = value => isPublicSourcePath(value)
  && !value.split('/').some(part => excluded.has(part)) && value !== 'RELEASE_MANIFEST.json';

export async function verifySource(root) {
  const findings = [];
  const files = new Map();
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name) || (prefix === '' && entry.name === 'RELEASE_MANIFEST.json')) continue;
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) findings.push({ path, code: 'SYMLINK_DENIED' });
      else if (entry.isDirectory()) await walk(join(directory, entry.name), path + '/');
      else if (entry.isFile()) files.set(path, join(directory, entry.name));
      else findings.push({ path, code: 'NON_FILE_DENIED' });
    }
  }
  try {
    const manifestPath = join(root, 'RELEASE_MANIFEST.json');
    const info = await lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576) throw new Error('MANIFEST_INVALID');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.schemaVersion !== 'dungeonq.source-release/v1' || manifest.profile !== 'SYNTHETIC_ONLY'
      || manifest.privateHistoryIncluded !== false || !Array.isArray(manifest.entries)
      || manifest.entries.length < 1 || manifest.entries.length > 10000) throw new Error('MANIFEST_INVALID');
    await walk(root);
    const seen = new Set();
    for (const entry of manifest.entries) {
      if (!entry || !validPath(entry.path) || seen.has(entry.path) || !/^[a-f0-9]{64}$/u.test(entry.sha256)
        || !Number.isInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 1048576) {
        findings.push({ code: 'ENTRY_INVALID' }); continue;
      }
      seen.add(entry.path);
      if (!files.has(entry.path)) { findings.push({ path: entry.path, code: 'MISSING_FILE' }); continue; }
      const info = await lstat(files.get(entry.path));
      if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes) {
        findings.push({ path: entry.path, code: 'SIZE_OR_TYPE_MISMATCH' }); continue;
      }
      const bytes = await readFile(files.get(entry.path));
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) findings.push({ path: entry.path, code: 'HASH_MISMATCH' });
    }
    for (const path of files.keys()) if (!seen.has(path)) findings.push({ path, code: 'UNLISTED_FILE' });
  } catch { findings.push({ code: 'MANIFEST_UNREADABLE_OR_INVALID' }); }
  return { schemaVersion: 'dungeonq.source-check/v1', profile: 'SYNTHETIC_ONLY',
    passed: findings.length === 0, files: files.size, authenticityProven: false, findings };
}
