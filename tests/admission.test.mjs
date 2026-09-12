import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { admitScenarioPack } from "../public/src/admission.mjs";
import { ScenarioValidationError } from "../public/src/scenario.mjs";

const fixtureUrl = new URL("../public/scenarios/honey-credential.json", import.meta.url);

async function loadFixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

test("Scenario admission creates a fresh validated session through the authoritative parser", async () => {
  const candidate = await loadFixture();
  const admitted = await admitScenarioPack(candidate);

  assert.equal(admitted.scenario.scenarioId, candidate.scenarioId);
  assert.equal(Object.isFrozen(admitted.scenario), true);
  assert.deepEqual(admitted.session.getSnapshot(), {
    state: "VALIDATED",
    revision: 1,
    scenarioId: candidate.scenarioId,
    targetState: candidate.environment.assets.find(
      (asset) => asset.id === candidate.requestedEffect.targetAssetId
    ).initialState,
    simulation: null,
    approvalRequest: null,
    approvalRecord: null,
    receipts: [],
    audit: []
  });
});

test("Scenario admission rejects active content without creating a session", async () => {
  const candidate = await loadFixture();
  candidate.summary = "<img src=x onerror=alert(1)>";

  await assert.rejects(
    () => admitScenarioPack(candidate),
    (error) =>
      error instanceof ScenarioValidationError &&
      error.code === "SCENARIO_INVALID" &&
      error.issues.some((issue) => issue.code === "ACTIVE_CONTENT_FORBIDDEN")
  );
});

test("Scenario admission enforces the serialized 128 KiB limit for object input", async () => {
  const candidate = await loadFixture();
  candidate.padding = "x".repeat(132_000);

  await assert.rejects(
    () => admitScenarioPack(candidate),
    (error) =>
      error instanceof ScenarioValidationError &&
      error.issues.length === 1 &&
      error.issues[0].code === "INPUT_TOO_LARGE"
  );
});

test("Scenario admission converts unserializable object input into a bounded validation error", async () => {
  const candidate = await loadFixture();
  candidate.loop = candidate;

  await assert.rejects(
    () => admitScenarioPack(candidate),
    (error) =>
      error instanceof ScenarioValidationError &&
      error.code === "SCENARIO_INVALID" &&
      error.issues.length === 1 &&
      error.issues[0].code === "INPUT_SERIALIZATION_FAILED"
  );
});
