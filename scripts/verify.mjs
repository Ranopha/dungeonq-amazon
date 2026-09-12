#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { canonicalJson, createLabSession, createSimulation, parseScenarioPack, verifyEvidenceBundle } from "../public/src/index.mjs";

const SCENARIOS = Object.freeze([
  "honey-credential.json",
  "compound-pep-failure.json",
  "false-positive-recovery.json"
]);

async function verifyScenario(filename, index) {
  const text = await readFile(new URL(`../public/scenarios/${filename}`, import.meta.url), "utf8");
  const scenario = parseScenarioPack(text);
  const firstSimulation = await createSimulation(scenario);
  const secondSimulation = await createSimulation(scenario);
  const deterministic = canonicalJson(firstSimulation) === canonicalJson(secondSimulation);
  const session = await createLabSession(scenario);
  const simulation = await session.simulate({ actorId: "syn-verifier-runner-001", actorType: "SYSTEM" });

  let lifecycle = "SIMULATION_ONLY";
  if (simulation.proposal.executableAfterApproval) {
    await session.requestApproval({ actorId: "syn-verifier-agent-001", actorType: "AGENT" });
    await session.approve({
      actorId: "syn-verifier-human-001",
      actorType: "HUMAN",
      proposalDigest: simulation.proposal.digest,
      revision: simulation.proposal.revision
    });
    const applied = await session.apply({
      actorId: "syn-verifier-broker-001",
      actorType: "SYSTEM",
      proposalDigest: simulation.proposal.digest,
      revision: simulation.proposal.revision,
      idempotencyKey: `syn-verifier-apply-${index + 1}`
    });
    const receiptResult = await session.verify({ receipt: applied.receipt });
    if (!receiptResult.valid) throw new Error("RECEIPT_VERIFY_FAILED");
    await session.rollback({
      actorId: "syn-verifier-recovery-001",
      actorType: "HUMAN",
      idempotencyKey: `syn-verifier-rollback-${index + 1}`
    });
    lifecycle = "COMPENSATED";
  }

  const evidence = await session.exportEvidence();
  const evidenceVerification = await verifyEvidenceBundle(evidence);
  const passed = deterministic && evidence.assertionsPassed && evidenceVerification.valid;
  return {
    filename,
    scenarioId: scenario.scenarioId,
    passed,
    deterministic,
    route: evidence.decision.route,
    assertionsPassed: evidence.assertionsPassed,
    lifecycle,
    evidenceVerified: evidenceVerification.valid,
    evidenceDigest: evidence.digest
  };
}

const results = [];
for (const [index, filename] of SCENARIOS.entries()) {
  results.push(await verifyScenario(filename, index));
}

const report = {
  reportVersion: "dungeonq.verification/v1",
  claimBoundary: "SYNTHETIC_SIMULATION_ONLY",
  scenarioCount: results.length,
  passed: results.every((result) => result.passed),
  results
};
process.stdout.write(`${canonicalJson(report)}\n`);
if (!report.passed) process.exitCode = 1;
