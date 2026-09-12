import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyEvidenceBundle } from "../public/src/index.mjs";

const rootUrl = new URL("../", import.meta.url);

test("CLI runs an external scenario through the same engine and emits verifiable evidence", async () => {
  const result = spawnSync(
    process.execPath,
    ["cli/run.mjs", "--scenario", "public/scenarios/honey-credential.json"],
    { cwd: rootUrl, encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const bundle = JSON.parse(result.stdout);
  assert.equal(bundle.scenarioId, "syn-honey-credential-001");
  assert.equal(bundle.state, "SIMULATED");
  assert.equal(bundle.decision.route, "DENY");
  assert.deepEqual(await verifyEvidenceBundle(bundle), { valid: true, reason: "EVIDENCE_VALID" });
});

test("CLI emits evidence but exits nonzero when authored expectations do not match", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dungeonq-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const scenario = JSON.parse(await readFile(new URL("../public/scenarios/honey-credential.json", import.meta.url), "utf8"));
  scenario.expected.route = "ALLOW_DECEPTION";
  const scenarioPath = join(directory, "assertion-mismatch.json");
  await writeFile(scenarioPath, JSON.stringify(scenario), "utf8");

  const result = spawnSync(process.execPath, ["cli/run.mjs", "--scenario", scenarioPath], {
    cwd: rootUrl,
    encoding: "utf8"
  });

  assert.equal(result.status, 3, result.stderr);
  const bundle = JSON.parse(result.stdout);
  assert.equal(bundle.assertionsPassed, false);
  assert.equal(bundle.decision.route, "DENY");
  assert.deepEqual(await verifyEvidenceBundle(bundle), { valid: true, reason: "EVIDENCE_VALID" });
});

test("CLI refuses a lifecycle when compound controls block the effect", () => {
  const result = spawnSync(
    process.execPath,
    ["cli/run.mjs", "--scenario", "public/scenarios/compound-pep-failure.json", "--lifecycle"],
    { cwd: rootUrl, encoding: "utf8" }
  );

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), { status: "failed", code: "EFFECT_BLOCKED", details: [] });
});
