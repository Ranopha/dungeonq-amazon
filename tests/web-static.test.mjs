import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createStaticServer } from "../scripts/serve.mjs";

const rootUrl = new URL("../public/", import.meta.url);

test("judge-facing page has explicit synthetic boundary and no inline executable content", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /DungeonQ/u);
  assert.match(html, /SYNTHETIC_SIMULATION_ONLY/u);
  assert.match(html, /id="scenario-editor"/u);
  assert.match(html, /id="run-simulation"/u);
  assert.match(html, /id="human-approve"/u);
  assert.match(html, /id="export-evidence"/u);
  assert.match(html, /id="probe-unapproved-apply"/u);
  assert.match(html, /id="probe-tampered-receipt"/u);
  assert.match(html, /id="adversarial-result"/u);
  assert.match(html, /id="judge-quick-run"/u);
  assert.match(html, /id="judge-guide"/u);
  assert.match(html, /id="adapter-parity"/u);
  assert.match(html, /id="adapter-digest"/u);
  assert.match(html, /Bring your own dungeon/u);
  assert.match(html, /dungeonq_scenario_admit/u);
  assert.match(html, /Apache-2\.0/u);
  assert.doesNotMatch(html, /noindex/u);
  assert.doesNotMatch(html, /owner-only|unlicensed/iu);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/iu);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/iu);
});

test("local static server applies a strict browser boundary and rejects traversal", async (context) => {
  const server = createStaticServer({ rootUrl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-security-policy")?.includes("default-src 'self'"), true);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.match(await page.text(), /DungeonQ/u);

  const traversal = await fetch(`${origin}/%2e%2e/package.json`);
  assert.equal(traversal.status, 404);
  const unsupported = await fetch(`${origin}/index.exe`);
  assert.equal(unsupported.status, 404);
});
