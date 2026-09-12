import { canonicalJson, sha256Hex } from "./canonical.mjs";
import { validateScenarioPack } from "./scenario.mjs";

export const ENGINE_VERSION = "dungeonq.engine/1.0.0";

const POSITIVE_SIGNAL_WEIGHT = Object.freeze({
  HONEY_CREDENTIAL_USED: 1,
  CREDENTIAL_REPLAY: 0.9,
  PRIVILEGE_PROBE: 0.75,
  ANOMALOUS_BEHAVIOR: 0.5
});

const NEGATIVE_SIGNAL_WEIGHT = Object.freeze({
  FRESH_REAUTH: 0.75,
  COUNTER_EVIDENCE: 0.6
});

const SOURCE_TRUST_WEIGHT = Object.freeze({
  CONTROLLED_HONEY: 1,
  IDENTITY_CONTROL: 0.9,
  EDGE_TELEMETRY: 0.8,
  ENDPOINT_TELEMETRY: 0.75,
  USER_REAUTH: 0.9,
  UNTRUSTED_MODEL: 0
});

const INDEPENDENCE_BONUS_MINIMUM = 40;

const BASE_CAPABILITIES = Object.freeze([
  "APPLY_EFFECT",
  "EXPORT_EVIDENCE",
  "PRODUCTION_RESPONSE",
  "REQUEST_APPROVAL",
  "SIMULATE_EFFECT",
  "VIEW_EVIDENCE"
]);

const FAILURE_BLOCKS = Object.freeze({
  CAMPAIGN_STORE_UNAVAILABLE: ["SIMULATE_EFFECT"],
  EVIDENCE_AUTHORITY_UNAVAILABLE: ["APPLY_EFFECT", "REQUEST_APPROVAL", "SIMULATE_EFFECT"],
  BUDGET_EXHAUSTED: ["APPLY_EFFECT", "SIMULATE_EFFECT"],
  APPROVAL_UNAVAILABLE: ["APPLY_EFFECT", "REQUEST_APPROVAL"],
  ROUTE_INDEX_STALE: ["PRODUCTION_RESPONSE"],
  PEP_CONTEXT_MISSING: ["PRODUCTION_RESPONSE"],
  STATION_DECOMMISSION_PENDING: ["APPLY_EFFECT"]
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function calculateRisk(signals) {
  const assessments = signals.map((signal) => {
    const polarity = signal.kind in NEGATIVE_SIGNAL_WEIGHT ? "NEGATIVE" : "POSITIVE";
    const kindWeight =
      polarity === "NEGATIVE" ? NEGATIVE_SIGNAL_WEIGHT[signal.kind] : POSITIVE_SIGNAL_WEIGHT[signal.kind];
    const sourceTrustWeight = SOURCE_TRUST_WEIGHT[signal.sourceClass];
    const effectiveContribution = Math.round(signal.confidence * kindWeight * sourceTrustWeight * 100) / 100;
    return Object.freeze({
      signalId: signal.id,
      sourceClass: signal.sourceClass,
      polarity,
      sourceTrustWeight,
      effectiveContribution,
      independenceEligible:
        polarity === "POSITIVE" && sourceTrustWeight > 0 && effectiveContribution >= INDEPENDENCE_BONUS_MINIMUM
    });
  });
  const positiveAssessments = assessments.filter((assessment) => assessment.polarity === "POSITIVE");
  const strongestPositive = Math.max(0, ...positiveAssessments.map((assessment) => assessment.effectiveContribution));
  const eligibleIds = new Set(
    assessments.filter((assessment) => assessment.independenceEligible).map((assessment) => assessment.signalId)
  );
  const independentGroups = new Set(
    signals.filter((signal) => eligibleIds.has(signal.id)).map((signal) => signal.independenceGroup)
  ).size;
  const independenceBonus = Math.min(20, Math.max(0, independentGroups - 1) * 10);
  const strongestCounter = Math.max(
    0,
    ...assessments
      .filter((assessment) => assessment.polarity === "NEGATIVE")
      .map((assessment) => assessment.effectiveContribution)
  );
  return Object.freeze({
    riskScore: clamp(Math.round(strongestPositive + independenceBonus - strongestCounter), 0, 100),
    signalAssessments: Object.freeze(assessments)
  });
}

function routeForRisk(riskScore, policy) {
  if (riskScore >= policy.denyThreshold) return "DENY";
  if (riskScore >= policy.quarantineThreshold) return "QUARANTINE";
  if (riskScore >= policy.deceptionThreshold) return "ALLOW_DECEPTION";
  return "NO_ADDITIONAL_RESTRICTION";
}

function composeConstraints(failures) {
  const allowed = new Set(BASE_CAPABILITIES);
  for (const failure of failures) {
    for (const capability of FAILURE_BLOCKS[failure] ?? []) {
      allowed.delete(capability);
    }
  }
  return Object.freeze({
    failures: Object.freeze([...failures].sort()),
    allowedCapabilities: Object.freeze([...allowed].sort()),
    blockedCapabilities: Object.freeze(BASE_CAPABILITIES.filter((capability) => !allowed.has(capability)).sort())
  });
}

function evaluateAssertions(scenario, decision, proposal) {
  return [
    { field: "route", expected: scenario.expected.route, actual: decision.route, passed: scenario.expected.route === decision.route },
    {
      field: "approvalRequired",
      expected: scenario.expected.approvalRequired,
      actual: proposal.approvalRequired,
      passed: scenario.expected.approvalRequired === proposal.approvalRequired
    },
    {
      field: "effectExecutable",
      expected: scenario.expected.effectExecutable,
      actual: proposal.executableAfterApproval,
      passed: scenario.expected.effectExecutable === proposal.executableAfterApproval
    }
  ];
}

export async function createSimulation(input) {
  const scenario = validateScenarioPack(input);
  const inputDigest = await sha256Hex(canonicalJson(scenario));
  const { riskScore, signalAssessments } = calculateRisk(scenario.signals);
  const constraints = composeConstraints(scenario.failures);
  const baseRoute = routeForRisk(riskScore, scenario.policy);
  const route = scenario.failures.includes("PEP_CONTEXT_MISSING") ? "DENY" : baseRoute;
  const decision = Object.freeze({
    riskScore,
    route,
    reasonCodes: scenario.signals.map((signal) => signal.kind).sort(),
    signalAssessments
  });
  const target = scenario.environment.assets.find((asset) => asset.id === scenario.requestedEffect.targetAssetId);
  const withinScope = scenario.requestedEffect.scope <= scenario.policy.maxAutomatedScope;
  const withinBudget = scenario.requestedEffect.costUnits <= scenario.policy.budgetUnits;
  const approvalRequired = scenario.policy.approvalRequiredEffects.includes(scenario.requestedEffect.type);
  const proposalBase = {
    scenarioId: scenario.scenarioId,
    revision: 1,
    effectType: scenario.requestedEffect.type,
    targetAssetId: scenario.requestedEffect.targetAssetId,
    scope: scenario.requestedEffect.scope,
    costUnits: scenario.requestedEffect.costUnits,
    approvalRequired,
    executableAfterApproval:
      approvalRequired &&
      Boolean(target) &&
      withinScope &&
      withinBudget &&
      constraints.allowedCapabilities.includes("APPLY_EFFECT"),
    expectedBeforeState: target?.initialState ?? "UNKNOWN",
    recovery:
      scenario.requestedEffect.type === "RELEASE_NEW_CONTEXT"
        ? Object.freeze({ priorContextState: "REMAINS_REVOKED", createsFreshContext: true })
        : null
  };
  const proposal = Object.freeze({
    ...proposalBase,
    digest: await sha256Hex(canonicalJson({ inputDigest, ...proposalBase }))
  });
  const invariantResults = Object.freeze([
    { id: "DQ-INV-001", passed: true, detail: "Synthetic sentinel and namespace validated" },
    {
      id: "DQ-INV-002",
      passed: constraints.allowedCapabilities.every((capability) => BASE_CAPABILITIES.includes(capability)),
      detail: "Failure composition only removed capabilities"
    },
    { id: "DQ-INV-003", passed: approvalRequired, detail: "Approval gate is present for the requested effect" },
    { id: "DQ-INV-004", passed: true, detail: "Proposal digest and revision are frozen before apply" },
    {
      id: "DQ-INV-007",
      passed:
        !scenario.failures.includes("PEP_CONTEXT_MISSING") ||
        (decision.route === "DENY" && !constraints.allowedCapabilities.includes("PRODUCTION_RESPONSE")),
      detail: "Missing edge context cannot produce a simulated production response"
    },
    {
      id: "DQ-INV-008",
      passed:
        scenario.requestedEffect.type !== "RELEASE_NEW_CONTEXT" ||
        (scenario.signals.some((signal) => signal.kind === "FRESH_REAUTH") &&
          proposal.expectedBeforeState === "CONTEXT_REVOKED" &&
          proposal.recovery?.priorContextState === "REMAINS_REVOKED" &&
          proposal.recovery?.createsFreshContext === true),
      detail: "Fresh authentication creates a new context without reviving the revoked context"
    }
  ]);
  const assertionResults = Object.freeze(evaluateAssertions(scenario, decision, proposal));
  const requiredInvariantsPassed = scenario.expected.requiredInvariantIds.every((requiredId) =>
    invariantResults.some((result) => result.id === requiredId && result.passed)
  );

  return Object.freeze({
    engineVersion: ENGINE_VERSION,
    scenario,
    inputDigest,
    decision,
    constraints,
    proposal,
    invariantResults,
    assertionResults,
    assertionsPassed: assertionResults.every((result) => result.passed) && requiredInvariantsPassed
  });
}
