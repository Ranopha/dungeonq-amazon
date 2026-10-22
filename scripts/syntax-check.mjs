import { readdir, lstat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PUBLIC_SOURCE_PATHS } from './lib/distribution-export.mjs';

const execute = promisify(execFile);
const excluded = new Set(['node_modules', '.git', 'dist', '.next', '.vinext', '.wrangler', '__pycache__']);
export async function checkSyntax({ root = fileURLToPath(new URL('../', import.meta.url)), paths = [...PUBLIC_SOURCE_PATHS, 'scripts', 'astra-site'], concurrency = 4 } = {}) {
  root = resolve(root); const files = new Set();
  async function collect(path) {
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) throw Error('SYNTAX_SOURCE_SYMLINK_DENIED');
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) if (!excluded.has(entry)) await collect(join(path, entry));
    } else if (info.isFile() && /\.(?:mjs|cjs|js)$/.test(path)) files.add(path);
  }
  for (const path of paths) await collect(resolve(root, path));
  if (!files.size) throw Error('NO_JAVASCRIPT_SOURCES_CHECKED');
  const queue = [...files].sort(); const failures = []; let index = 0;
  async function worker() {
    for (;;) {
      const next = index++; if (next >= queue.length) return;
      try { await execute(process.execPath, ['--check', queue[next]], { timeout: 10000, maxBuffer: 65536 }); }
      catch (error) { failures.push({ path: relative(root, queue[next]), error: String(error.stderr ?? error.message).trim() }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), 8, queue.length) }, worker));
  return { schemaVersion: 'dungeonq.syntax-check/v1', checker: 'node --check', semanticTypeChecking: false, checkedFiles: queue.length,
    passed: failures.length === 0, failures: failures.sort((a, b) => a.path.localeCompare(b.path)) };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) throw Error('Use npm run syntaxcheck.');
    const report = await checkSyntax(); console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
