import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("開發套件只指向新庫並保持禁止 npm 發布", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.repository.url, "git+https://github.com/Ranopha/dungeonq-amazon.git");
  assert.equal(pkg.bugs.url, "https://github.com/Ranopha/dungeonq-amazon/issues");
  assert.equal(pkg.homepage, "https://github.com/Ranopha/dungeonq-amazon#readme");
});

test("開發工作樹沒有參賽 Sites 綁定或自動部署流程", async () => {
  await assert.rejects(access(new URL(".openai/hosting.json", root)), { code: "ENOENT" });
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  if (['dungeonq-amazon', 'dungeonq-astra'].includes(pkg.name)) {
    assert.deepEqual(await readdir(new URL('.github/workflows', root)), ['ci.yml']);
    const ci = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
    assert.match(ci, /permissions:\s+contents: read/u);
    assert.match(ci, /persist-credentials: false/u);
    assert.doesNotMatch(ci, /secrets\.|pull_request_target|contents: write|id-token: write|\b(?:deploy|publish|wrangler|ssh)\b/iu);
    assert.ok([...ci.matchAll(/uses:\s+([^\s]+)/gu)].every(match => /@[a-f0-9]{40}$/u.test(match[1])));
  } else {
    await assert.rejects(access(new URL(".github/workflows", root)), { code: "ENOENT" });
  }
  assert.equal(pkg.scripts.dev, 'node scripts/serve.mjs');
  assert.equal(pkg.scripts.build, 'node scripts/build-static.mjs');
  assert.equal(pkg.scripts.start, 'node scripts/serve.mjs --built');
  assert.equal(pkg.scripts.syntaxcheck, 'node scripts/syntax-check.mjs');
  assert.equal(pkg.scripts.typecheck, undefined);
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of ['vinext', 'react', 'react-dom', 'react-server-dom-webpack', 'vite', 'wrangler', '@cloudflare/vite-plugin', '@cloudflare/workers-types', '@openai/sites-vite-plugin']) {
    assert.equal(dependencies[name], undefined, name);
  }
  for (const path of ['vite.config.ts', 'next.config.ts', 'tsconfig.json', 'app/page.tsx', 'app/layout.tsx']) {
    await assert.rejects(access(new URL(path, root)), { code: 'ENOENT' });
  }
  const ignore = await readFile(new URL(".gitignore", root), "utf8");
  assert.ok(ignore.split(/\r?\n/u).includes("/.openai/hosting.json"));
});
