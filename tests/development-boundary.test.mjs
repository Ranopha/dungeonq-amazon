import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

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
  await assert.rejects(access(new URL(".github/workflows", root)), { code: "ENOENT" });
  const config = await readFile(new URL("vite.config.ts", root), "utf8");
  assert.doesNotMatch(config, /@openai\/sites-vite-plugin|\bsites\s*\(/u);
  const ignore = await readFile(new URL(".gitignore", root), "utf8");
  assert.ok(ignore.split(/\r?\n/u).includes("/.openai/hosting.json"));
});
