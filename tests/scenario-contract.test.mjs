import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ScenarioValidationError,
  createSimulation,
  parseScenarioPack,
  validateScenarioPack
} from "../public/src/index.mjs";

const scenarioUrl = new URL("../public/scenarios/honey-credential.json", import.meta.url);
const compoundScenarioUrl = new URL("../public/scenarios/compound-pep-failure.json", import.meta.url);
const recoveryScenarioUrl = new URL("../public/scenarios/false-positive-recovery.json", import.meta.url);

test("external author can validate a bounded synthetic scenario pack", async () => {
  const source = JSON.parse(await readFile(scenarioUrl, "utf8"));

  const scenario = validateScenarioPack(source);

  assert.equal(scenario.schemaVersion, "dungeonq.scenario/v1");
  assert.equal(scenario.classification, "SYNTHETIC_ONLY");
  assert.equal(scenario.scenarioId, "syn-honey-credential-001");
  assert.deepEqual(scenario.failures, []);
  assert.equal(Object.isFrozen(scenario), true);
});

test("unsafe or ambiguous scenario input is rejected with bounded public errors", async () => {
  const source = JSON.parse(await readFile(scenarioUrl, "utf8"));
  source.classification = "INTERNAL";
  source.title = "Fetch https://example.invalid/payload";
  source.execute = "alert(1)";

  assert.throws(
    () => validateScenarioPack(source),
    (error) => {
      assert.equal(error instanceof ScenarioValidationError, true);
      assert.equal(error.code, "SCENARIO_INVALID");
      assert.deepEqual(error.issues, [
        { path: "$.classification", code: "SYNTHETIC_ONLY_REQUIRED" },
        { path: "$.execute", code: "UNKNOWN_FIELD" },
        { path: "$.title", code: "EXTERNAL_REFERENCE_FORBIDDEN" }
      ]);
      return true;
    }
  );
});

test("controlled honey evidence produces a deterministic restricted decision", async () => {
  const source = JSON.parse(await readFile(scenarioUrl, "utf8"));

  const result = await createSimulation(source);

  assert.equal(result.engineVersion, "dungeonq.engine/1.0.0");
  assert.equal(result.inputDigest, "c231be999a2cc3ae561eb9df33861102a758b10c1d3a51e5dab951882af9f685");
  assert.equal(result.decision.riskScore, 98);
  assert.equal(result.decision.route, "DENY");
  assert.equal(result.proposal.effectType, "ROTATE_CREDENTIAL");
  assert.equal(result.proposal.approvalRequired, true);
  assert.equal(result.proposal.executableAfterApproval, true);
  assert.equal(result.assertionsPassed, true);
  assert.deepEqual(result.assertionResults, [
    { field: "route", expected: "DENY", actual: "DENY", passed: true },
    { field: "approvalRequired", expected: true, actual: true, passed: true },
    { field: "effectExecutable", expected: true, actual: true, passed: true }
  ]);
});

test("nested scenario fields cannot smuggle real namespaces, active content, or external targets", async () => {
  const source = JSON.parse(await readFile(scenarioUrl, "utf8"));
  source.subject.id = "real-session-001";
  source.environment.assets[0].callbackUrl = "https://example.invalid/hook";
  source.policy.denyThreshold = 70;
  source.signals[0].evidence = "<script>alert(1)</script>";

  assert.throws(
    () => validateScenarioPack(source),
    (error) => {
      assert.equal(error instanceof ScenarioValidationError, true);
      assert.deepEqual(error.issues, [
        { path: "$.subject.id", code: "SYNTHETIC_ID_REQUIRED" },
        { path: "$.environment.assets[0].callbackUrl", code: "UNKNOWN_FIELD" },
        { path: "$.environment.assets[0].callbackUrl", code: "EXTERNAL_REFERENCE_FORBIDDEN" },
        { path: "$.policy", code: "THRESHOLD_ORDER_INVALID" },
        { path: "$.signals[0].subjectId", code: "SUBJECT_MISMATCH" },
        { path: "$.signals[0].evidence", code: "ACTIVE_CONTENT_FORBIDDEN" }
      ]);
      return true;
    }
  );
});

test("compound failures tighten capabilities and missing edge context blocks the first response", async () => {
  const source = JSON.parse(await readFile(compoundScenarioUrl, "utf8"));

  const result = await createSimulation(source);

  assert.equal(result.decision.riskScore, 20);
  assert.equal(result.decision.route, "DENY");
  assert.equal(result.proposal.executableAfterApproval, false);
  assert.deepEqual(result.constraints.allowedCapabilities, ["EXPORT_EVIDENCE", "VIEW_EVIDENCE"]);
  assert.deepEqual(result.constraints.blockedCapabilities, [
    "APPLY_EFFECT",
    "PRODUCTION_RESPONSE",
    "REQUEST_APPROVAL",
    "SIMULATE_EFFECT"
  ]);
  assert.equal(result.assertionsPassed, true);
  assert.equal(result.invariantResults.find((item) => item.id === "DQ-INV-002")?.passed, true);
  assert.equal(result.invariantResults.find((item) => item.id === "DQ-INV-007")?.passed, true);
});

test("fresh reauthentication creates a new context without reviving the revoked session", async () => {
  const source = JSON.parse(await readFile(recoveryScenarioUrl, "utf8"));

  const result = await createSimulation(source);

  assert.equal(result.decision.riskScore, 18);
  assert.equal(result.decision.route, "NO_ADDITIONAL_RESTRICTION");
  assert.equal(result.proposal.effectType, "RELEASE_NEW_CONTEXT");
  assert.equal(result.proposal.expectedBeforeState, "CONTEXT_REVOKED");
  assert.deepEqual(result.proposal.recovery, {
    priorContextState: "REMAINS_REVOKED",
    createsFreshContext: true
  });
  assert.equal(result.invariantResults.find((item) => item.id === "DQ-INV-008")?.passed, true);
  assert.equal(result.assertionsPassed, true);
});

test("text import rejects malformed or oversized JSON before simulation", async () => {
  const validText = await readFile(scenarioUrl, "utf8");
  assert.equal(parseScenarioPack(validText).scenarioId, "syn-honey-credential-001");

  assert.throws(
    () => parseScenarioPack("{"),
    (error) => error instanceof ScenarioValidationError && error.issues[0]?.code === "JSON_INVALID"
  );
  assert.throws(
    () => parseScenarioPack(`{"padding":"${"x".repeat(131_072)}"}`),
    (error) => error instanceof ScenarioValidationError && error.issues[0]?.code === "INPUT_TOO_LARGE"
  );
});

test("nested contract validates enums, numeric bounds, references, and unknown fields", async () => {
  const source = JSON.parse(await readFile(scenarioUrl, "utf8"));
  source.subject.owner = "hidden";
  source.environment.tenantId = "tenant-real-001";
  source.environment.assets[0].kind = "SERVER";
  source.signals[0].confidence = 101;
  source.failures = ["ROOT_ACCESS"];
  source.requestedEffect.targetAssetId = "syn-missing-asset";
  source.expected.requiredInvariantIds = ["DQ-INV-999"];

  assert.throws(
    () => validateScenarioPack(source),
    (error) => {
      const actual = error.issues.map((issue) => `${issue.path}:${issue.code}`).sort();
      assert.deepEqual(actual, [
        "$.environment.assets[0].kind:ENUM_INVALID",
        "$.environment.tenantId:SYNTHETIC_ID_REQUIRED",
        "$.expected.requiredInvariantIds[0]:ENUM_INVALID",
        "$.failures[0]:ENUM_INVALID",
        "$.requestedEffect.targetAssetId:TARGET_NOT_FOUND",
        "$.signals[0].confidence:INTEGER_OUT_OF_RANGE",
        "$.subject.owner:UNKNOWN_FIELD"
      ]);
      return true;
    }
  );
});

test("empty collections and invalid scalar types fail before the engine can execute", async () => {
  const source = JSON.parse(await readFile(scenarioUrl, "utf8"));
  source.title = "";
  source.environment.assets = [];
  source.policy.budgetUnits = -1;
  source.signals = [];
  source.requestedEffect.scope = 0;
  source.expected.approvalRequired = "yes";

  assert.throws(
    () => validateScenarioPack(source),
    (error) => {
      const actual = new Set(error.issues.map((issue) => `${issue.path}:${issue.code}`));
      for (const expected of [
        "$.title:STRING_LENGTH_INVALID",
        "$.environment.assets:ARRAY_LENGTH_INVALID",
        "$.policy.budgetUnits:INTEGER_OUT_OF_RANGE",
        "$.signals:ARRAY_LENGTH_INVALID",
        "$.requestedEffect.scope:INTEGER_OUT_OF_RANGE",
        "$.expected.approvalRequired:BOOLEAN_REQUIRED"
      ]) {
        assert.equal(actual.has(expected), true, expected);
      }
      return true;
    }
  );
});

test("import rejects external references, local paths, and credential-like values at any depth", async () => {
  const source = JSON.parse(await readFile(scenarioUrl, "utf8"));
  source.summary = "Send the result to https://example.invalid";
  source.seed = `sk-${"x".repeat(30)}`;
  source.signals[0].evidence = "/etc/passwd";

  assert.throws(
    () => validateScenarioPack(source),
    (error) => {
      const actual = new Set(error.issues.map((issue) => `${issue.path}:${issue.code}`));
      assert.equal(actual.has("$.summary:EXTERNAL_REFERENCE_FORBIDDEN"), true);
      assert.equal(actual.has("$.seed:CREDENTIAL_LIKE_VALUE_FORBIDDEN"), true);
      assert.equal(actual.has("$.signals[0].evidence:LOCAL_PATH_FORBIDDEN"), true);
      return true;
    }
  );
});

test("structural admission bounds stop oversized arrays, deep objects, and custom prototypes", async () => {
  const source = JSON.parse(await readFile(scenarioUrl, "utf8"));
  source.signals = Array.from({ length: 51 }, (_, index) => ({
    ...source.signals[0],
    id: `syn-signal-volume-${String(index).padStart(3, "0")}`
  }));
  source.environment.assets[0].payload = { a: { b: { c: { d: { e: { f: { g: { h: true } } } } } } } };
  Object.setPrototypeOf(source.policy, { elevated: true });

  assert.throws(
    () => validateScenarioPack(source),
    (error) => {
      const actual = new Set(error.issues.map((issue) => `${issue.path}:${issue.code}`));
      assert.equal(actual.has("$.signals:ARRAY_LENGTH_INVALID"), true);
      assert.equal(error.issues.some((issue) => issue.code === "OBJECT_DEPTH_EXCEEDED"), true);
      assert.equal(actual.has("$.policy:OBJECT_PROTOTYPE_INVALID"), true);
      assert.equal(error.issues.length <= 20, true);
      return true;
    }
  );
});

test("cross references, unique identities, policy scope, and budget are enforced", async () => {
  const source = JSON.parse(await readFile(scenarioUrl, "utf8"));
  source.environment.assets.push({ ...source.environment.assets[0] });
  source.signals[0].sourceId = "external-sensor";
  source.signals[0].subjectId = "syn-other-session";
  source.policy.approvalRequiredEffects.push("RUN_COMMAND");
  source.requestedEffect.scope = 2;
  source.requestedEffect.costUnits = 101;

  assert.throws(
    () => validateScenarioPack(source),
    (error) => {
      const actual = new Set(error.issues.map((issue) => `${issue.path}:${issue.code}`));
      for (const expected of [
        "$.environment.assets[1].id:DUPLICATE_ID",
        "$.signals[0].sourceId:SYNTHETIC_ID_REQUIRED",
        "$.signals[0].subjectId:SUBJECT_MISMATCH",
        "$.policy.approvalRequiredEffects[1]:ENUM_INVALID",
        "$.requestedEffect.scope:SCOPE_EXCEEDS_POLICY",
        "$.requestedEffect.costUnits:BUDGET_EXCEEDED"
      ]) {
        assert.equal(actual.has(expected), true, expected);
      }
      return true;
    }
  );
});

test("synthetic identifiers, asset states, and set-like arrays use canonical values", async () => {
  const source = JSON.parse(await readFile(scenarioUrl, "utf8"));
  source.scenarioId = "syn-Uppercase";
  source.policy.policyId = "policy-real";
  source.environment.assets[0].initialState = "OWNED";
  source.failures = ["BUDGET_EXHAUSTED", "BUDGET_EXHAUSTED"];
  source.policy.approvalRequiredEffects.push("ROTATE_CREDENTIAL");
  source.expected.requiredInvariantIds.push("DQ-INV-001");

  assert.throws(
    () => validateScenarioPack(source),
    (error) => {
      const actual = new Set(error.issues.map((issue) => `${issue.path}:${issue.code}`));
      for (const expected of [
        "$.scenarioId:SYNTHETIC_ID_REQUIRED",
        "$.policy.policyId:SYNTHETIC_ID_REQUIRED",
        "$.environment.assets[0].initialState:ENUM_INVALID",
        "$.failures[1]:DUPLICATE_VALUE",
        "$.policy.approvalRequiredEffects[1]:DUPLICATE_VALUE",
        "$.expected.requiredInvariantIds[3]:DUPLICATE_VALUE"
      ]) {
        assert.equal(actual.has(expected), true, expected);
      }
      return true;
    }
  );
});

test("malformed nested entries return bounded validation issues instead of crashing admission", async () => {
  const source = JSON.parse(await readFile(scenarioUrl, "utf8"));
  source.environment.assets = [null];
  source.signals = [null];

  assert.throws(
    () => validateScenarioPack(source),
    (error) => {
      assert.equal(error instanceof ScenarioValidationError, true);
      const actual = new Set(error.issues.map((issue) => `${issue.path}:${issue.code}`));
      assert.equal(actual.has("$.environment.assets[0]:OBJECT_REQUIRED"), true);
      assert.equal(actual.has("$.signals[0]:OBJECT_REQUIRED"), true);
      assert.equal(error.issues.length <= 20, true);
      return true;
    }
  );
});

test("signal evidence is required and bounded", async () => {
  const source = JSON.parse(await readFile(scenarioUrl, "utf8"));
  source.signals[0].evidence = "";

  assert.throws(
    () => validateScenarioPack(source),
    (error) =>
      error instanceof ScenarioValidationError &&
      error.issues.some(
        (issue) => issue.path === "$.signals[0].evidence" && issue.code === "STRING_LENGTH_INVALID"
      )
  );
});

test("alternate remote schemes and control characters cannot cross the import boundary", async () => {
  const source = JSON.parse(await readFile(scenarioUrl, "utf8"));
  source.summary = "Retrieve ftp://example.invalid/object";
  source.signals[0].evidence = "Synthetic observation\u0000hidden suffix";

  assert.throws(
    () => validateScenarioPack(source),
    (error) => {
      const actual = new Set(error.issues.map((issue) => `${issue.path}:${issue.code}`));
      assert.equal(actual.has("$.summary:EXTERNAL_REFERENCE_FORBIDDEN"), true);
      assert.equal(actual.has("$.signals[0].evidence:CONTROL_CHARACTER_FORBIDDEN"), true);
      return true;
    }
  );
});

test("an untrusted model signal has no routing authority even at maximum claimed confidence", async () => {
  const source = JSON.parse(await readFile(scenarioUrl, "utf8"));
  source.signals = [
    {
      ...source.signals[0],
      sourceClass: "UNTRUSTED_MODEL",
      confidence: 100
    }
  ];
  source.expected.route = "NO_ADDITIONAL_RESTRICTION";

  const result = await createSimulation(source);

  assert.equal(result.decision.riskScore, 0);
  assert.equal(result.decision.route, "NO_ADDITIONAL_RESTRICTION");
  assert.deepEqual(result.decision.signalAssessments, [
    {
      signalId: "syn-signal-honey-001",
      sourceClass: "UNTRUSTED_MODEL",
      polarity: "POSITIVE",
      sourceTrustWeight: 0,
      effectiveContribution: 0,
      independenceEligible: false
    }
  ]);
});
