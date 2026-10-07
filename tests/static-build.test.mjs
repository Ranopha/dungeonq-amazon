import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { buildStaticSite } from '../scripts/build-static.mjs';
import { createStaticServer } from '../scripts/serve.mjs';
import { collectStaticAssets, assetManifest, STATIC_TYPES, BUILD_MARKER } from '../scripts/lib/static-assets.mjs';
import { checkSyntax } from '../scripts/syntax-check.mjs';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'dq-static-build-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function serve(t, root) {
  const server = createStaticServer({ rootUrl: root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('Node build preserves every public byte, supplies the browser SDK and serves matching MIME/relative assets', async t => {
  const root = await temporary(t); const output = join(root, 'site');
  const source = await collectStaticAssets(publicRoot); const before = assetManifest(source);
  const result = await buildStaticSite({ output });
  const manifest = JSON.parse(await readFile(join(output, BUILD_MARKER), 'utf8'));
  assert.equal(result.sourceFiles, source.length);
  assert.equal(result.files, source.length + 1);
  assert.equal(result.apiHosted, false);
  assert.deepEqual(assetManifest(await collectStaticAssets(publicRoot)), before);
  for (const entry of source) assert.deepEqual(await readFile(join(output, entry.path)), entry.data, entry.path);
  const sdk = await readFile(new URL('../sdk/runtime-client.mjs', import.meta.url));
  assert.deepEqual(await readFile(join(output, 'runtime/client.mjs')), sdk);
  const origin = await serve(t, output);
  for (const { path, bytes } of manifest.entries) {
    const response = await fetch(origin + '/' + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), STATIC_TYPES[extname(path)], path);
    assert.equal(Number(response.headers.get('content-length')), bytes, path);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(output, path)), path);
  }
  const page = await (await fetch(origin + '/')).text();
  for (const [, dependency] of page.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)) {
    assert.equal((await fetch(new URL(dependency, origin + '/'))).status, 200, dependency);
  }
  const main = await (await fetch(origin + '/assets/app.mjs')).text();
  for (const [, dependency] of main.matchAll(/from\s+["']([^"']+)["']/g)) {
    assert.equal((await fetch(new URL(dependency, origin + '/assets/app.mjs'))).status, 200, dependency);
  }
  assert.equal((await fetch(origin + '/runtime/')).status, 200);
  assert.equal((await fetch(origin + '/api/operate')).status, 404, 'static preview must not pretend to host the API');
  assert.equal((await fetch(origin + '/' + BUILD_MARKER)).status, 404, 'build marker is not a browser asset');
  const second = await buildStaticSite({ output });
  assert.equal(second.contentDigest, result.contentDigest, 'repeat build must preserve the identical asset inventory');
});

test('build refuses unrelated or modified output and leaves existing data untouched', async t => {
  const root = await temporary(t); const output = join(root, 'site'); await mkdir(output);
  await writeFile(join(output, 'valuable.json'), '{"keep":true}');
  await assert.rejects(buildStaticSite({ output }), { code: 'BUILD_OUTPUT_NOT_OWNED' });
  assert.equal(await readFile(join(output, 'valuable.json'), 'utf8'), '{"keep":true}');
  const built = join(root, 'built'); await buildStaticSite({ output: built });
  await writeFile(join(built, 'manual.json'), '{"keep":true}');
  await assert.rejects(buildStaticSite({ output: built }), { code: 'BUILD_OUTPUT_MODIFIED' });
  assert.equal(await readFile(join(built, 'manual.json'), 'utf8'), '{"keep":true}');
  const alias = join(root, 'alias'); await symlink(output, alias);
  await assert.rejects(buildStaticSite({ output: alias }), { code: 'BUILD_OUTPUT_DENIED' });
  await assert.rejects(buildStaticSite({ output: join(publicRoot, 'nested') }), { code: 'BUILD_OUTPUT_MUST_BE_OUTSIDE_SOURCE' });
});

test('static build and server reject private names, unrecognized assets, links and traversal without exposing bytes', async t => {
  const root = await temporary(t); const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'index.html'), '<!doctype html><title>Fixture</title>');
  const secret = join(root, 'private.json'); await writeFile(secret, '{"private":"DO_NOT_SERVE"}');
  const output = join(root, 'build');
  await symlink(secret, join(source, 'linked.json'));
  await assert.rejects(buildStaticSite({ sourceRoot: source, output, runtimeClient: null }), { code: 'STATIC_SYMLINK_DENIED' });
  const origin = await serve(t, source);
  assert.equal((await fetch(origin + '/linked.json')).status, 404);
  await rm(join(source, 'linked.json'));
  await link(secret, join(source, 'hardlink.json'));
  await assert.rejects(buildStaticSite({ sourceRoot: source, output, runtimeClient: null }), { code: 'STATIC_FILE_DENIED' });
  assert.equal((await fetch(origin + '/hardlink.json')).status, 404);
  await rm(join(source, 'hardlink.json'));
  for (const [name, code] of [['credentials.json', 'STATIC_PATH_DENIED'], ['script.sh', 'STATIC_FILE_DENIED']]) {
    await writeFile(join(source, name), 'DO_NOT_SERVE');
    await assert.rejects(buildStaticSite({ sourceRoot: source, output, runtimeClient: null }), { code });
    assert.equal((await fetch(origin + '/' + name)).status, 404);
    await rm(join(source, name));
  }
  for (const path of ['/%2e%2e/private.json', '/%2e%2e%2fprivate.json', '/.env', '/package.json', '/index.html%00']) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
  assert.equal((await fetch(origin + '/', { method: 'POST' })).status, 405);
  const deniedHost = await new Promise((resolve, reject) => {
    const probe = request(origin + '/', { headers: { Host: 'example.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    probe.once('error', reject); probe.end();
  });
  assert.equal(deniedHost, 403);
  const head = await fetch(origin + '/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal(head.headers.get('x-content-type-options'), 'nosniff');
});

test('syntaxcheck parses actual nested modules without executing them and fails for invalid or absent JavaScript', async t => {
  const root = await temporary(t);
  for (const path of ['runtime', 'examples/consumer', 'public/assets']) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, 'runtime/server.mjs'), 'throw new Error("must never execute during syntax check");');
  await writeFile(join(root, 'examples/consumer/cli.mjs'), 'export const run = () => 1;');
  await writeFile(join(root, 'public/assets/app.js'), 'const value = 1;');
  const options = { root, paths: ['runtime', 'examples', 'public'] };
  const good = await checkSyntax(options);
  assert.equal(good.passed, true); assert.equal(good.checkedFiles, 3);
  assert.equal(good.semanticTypeChecking, false);
  await writeFile(join(root, 'examples/consumer/cli.mjs'), 'export const = ;');
  const bad = await checkSyntax(options);
  assert.equal(bad.passed, false);
  assert.deepEqual(bad.failures.map(item => item.path), ['examples/consumer/cli.mjs']);
  assert.match(bad.failures[0].error, /SyntaxError/);
  await assert.rejects(checkSyntax({ root, paths: ['missing'] }), /NO_JAVASCRIPT_SOURCES_CHECKED/);
});
