// Participant transport for a fixed local coordinator; not a generic HTTP client.
import { readFile, lstat } from 'node:fs/promises';
import assert from 'node:assert/strict';
const [accessPath, encoded, ...extra] = process.argv.slice(2);
assert.ok(accessPath && encoded && !extra.length, 'Use client ACCESS_FILE JSON_REQUEST');
const info = await lstat(accessPath);
assert.ok(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.size < 2048);
const access = JSON.parse(await readFile(accessPath, 'utf8'));
assert.match(access.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
assert.match(access.token, /^[A-Za-z0-9_-]{43}$/u);
const request = JSON.parse(encoded);
assert.ok(Buffer.byteLength(encoded) < 16_384);
const response = await fetch(`${access.origin}/rpc`, { method: 'POST', redirect: 'error',
  signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access.token}` },
  body: JSON.stringify(request) });
process.stdout.write(JSON.stringify(await response.json()) + '\n');
if (!response.ok) process.exitCode = 1;
