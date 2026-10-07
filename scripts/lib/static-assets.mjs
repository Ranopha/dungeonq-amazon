import { constants } from 'node:fs';
import { open, lstat, realpath, readdir } from 'node:fs/promises';
import { extname, resolve, sep, join } from 'node:path';
import { createHash } from 'node:crypto';
import { isPublicSourcePath } from './release-paths.mjs';

export const STATIC_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
});
export const BUILD_MARKER = '.dungeonq-static-build.json';
export function requireStatic(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }
export function isStaticAsset(path) {
  return typeof path === 'string' && path.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
    && isPublicSourcePath(path) && Object.hasOwn(STATIC_TYPES, extname(path));
}
export async function staticRoot(path) {
  const info = await lstat(path);
  requireStatic(info.isDirectory() && !info.isSymbolicLink(), 'STATIC_ROOT_DENIED');
  return realpath(path);
}
export async function readStaticAsset(root, path) {
  requireStatic(isStaticAsset(path), 'STATIC_PATH_DENIED');
  const canonicalRoot = await staticRoot(root);
  let target = canonicalRoot;
  for (const part of path.split('/')) {
    target = join(target, part);
    requireStatic(!(await lstat(target)).isSymbolicLink(), 'STATIC_SYMLINK_DENIED');
  }
  requireStatic((await realpath(target)).startsWith(canonicalRoot + sep), 'STATIC_PATH_DENIED');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    requireStatic(info.isFile() && info.nlink === 1 && info.size <= 16 * 1024 * 1024, 'STATIC_FILE_DENIED');
    const data = await handle.readFile();
    requireStatic(data.length === info.size, 'STATIC_SOURCE_CHANGED');
    return data;
  } finally { await handle.close(); }
}
export async function collectStaticAssets(root, { markerAllowed = false } = {}) {
  const base = await staticRoot(root); const entries = [];
  async function walk(directory, prefix = '') {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && item.name === BUILD_MARKER && markerAllowed) continue;
      const path = prefix ? prefix + '/' + item.name : item.name;
      requireStatic(!item.isSymbolicLink(), 'STATIC_SYMLINK_DENIED');
      requireStatic(isPublicSourcePath(path) && path.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)), 'STATIC_PATH_DENIED');
      if (item.isDirectory()) await walk(join(directory, item.name), path);
      else {
        requireStatic(item.isFile() && isStaticAsset(path), 'STATIC_FILE_DENIED');
        const data = await readStaticAsset(base, path);
        entries.push({ path, data, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
      }
    }
  }
  await walk(base);
  requireStatic(entries.some(entry => entry.path === 'index.html'), 'STATIC_INDEX_REQUIRED');
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
export function assetManifest(entries) { return entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })); }
