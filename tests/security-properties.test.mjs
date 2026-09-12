import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { LabSessionError, createLabSession, createSimulation } from "../public/src/index.mjs";

const scenarioUrl = new URL("../public/scenarios/honey-credential.json", import.meta.url);

async function loadScenario() {
  return JSON.parse(await readFile(scenarioUrl, "utf8"));
}

test("every compound-failure combination is monotonic and can only remove capabilities", async () => {
  const failures = [
    "CAMPAIGN_STORE_UNAVAILABLE",
    "EVIDENCE_AUTHORITY_UNAVAILABLE",
    "BUDGET_EXHAUSTED",
    "APPROVAL_UNAVAILABLE",
    "ROUTE_INDEX_STALE",
    "PEP_CONTEXT_MISSING",
    "STATION_DECOMMISSION_PENDING"
  ];
  const baseline = await createSimulation(await loadScenario());
  const baselineCapabilities = new Set(baseline.constraints.allowedCapabilities);

  for (let mask = 1; mask < 2 ** failures.length; mask += 1) {
    const scenario = await loadScenario();
    scenario.failures = failures.filter((_, index) => (mask & (1 << index)) !== 0);
    const result = await createSimulation(scenario);
    assert.equal(
      result.constraints.allowedCapabilities.every((capability) => baselineCapabilities.has(capability)),
      true,
      `failure mask ${mask} expanded authority`
    );
  }
});

test("exact idempotency replay is stable while a conflicting claim is rejected", async () => {
  const session = await createLabSession(await loadScenario());
  const simulation = await session.simulate({ actorId: "syn-judge-001", actorType: "HUMAN" });
  await session.requestApproval({ actorId: "syn-agent-001", actorType: "AGENT" });
  await session.approve({
    actorId: "syn-reviewer-001",
    actorType: "HUMAN",
    proposalDigest: simulation.proposal.digest,
    revision: simulation.proposal.revision
  });
  const command = {
    actorId: "syn-broker-001",
    actorType: "SYSTEM",
    proposalDigest: simulation.proposal.digest,
    revision: simulation.proposal.revision,
    idempotencyKey: "syn-claim-stable-001"
  };

  const first = await session.apply(command);
  const replay = await session.apply(command);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(session.getSnapshot().receipts.length, 1);

  await assert.rejects(
    () => session.apply({ ...command, revision: 2 }),
    (error) => error instanceof LabSessionError && error.code === "IDEMPOTENCY_CONFLICT"
  );
});

test("stale human approval and tampered receipt fail closed", async () => {
  const session = await createLabSession(await loadScenario());
  const simulation = await session.simulate({ actorId: "syn-judge-001", actorType: "HUMAN" });
  await session.requestApproval({ actorId: "syn-agent-001", actorType: "AGENT" });

  await assert.rejects(
    () =>
      session.approve({
        actorId: "syn-reviewer-001",
        actorType: "HUMAN",
        proposalDigest: simulation.proposal.digest,
        revision: 2
      }),
    (error) => error instanceof LabSessionError && error.code === "APPROVAL_STALE"
  );

  await session.approve({
    actorId: "syn-reviewer-001",
    actorType: "HUMAN",
    proposalDigest: simulation.proposal.digest,
    revision: simulation.proposal.revision
  });
  const applied = await session.apply({
    actorId: "syn-broker-001",
    actorType: "SYSTEM",
    proposalDigest: simulation.proposal.digest,
    revision: simulation.proposal.revision,
    idempotencyKey: "syn-claim-tamper-001"
  });
  const tampered = { ...applied.receipt, afterState: "AVAILABLE" };

  assert.deepEqual(await session.verify({ receipt: tampered }), {
    valid: false,
    reason: "DIGEST_MISMATCH",
    state: "APPLIED"
  });
});

test("compensation uses an idempotent claim and preserves the first compensation receipt", async () => {
  const session = await createLabSession(await loadScenario());
  const simulation = await session.simulate({ actorId: "syn-judge-001", actorType: "HUMAN" });
  await session.requestApproval({ actorId: "syn-agent-001", actorType: "AGENT" });
  await session.approve({
    actorId: "syn-reviewer-001",
    actorType: "HUMAN",
    proposalDigest: simulation.proposal.digest,
    revision: simulation.proposal.revision
  });
  await session.apply({
    actorId: "syn-broker-001",
    actorType: "SYSTEM",
    proposalDigest: simulation.proposal.digest,
    revision: simulation.proposal.revision,
    idempotencyKey: "syn-apply-before-rollback-001"
  });
  const command = {
    actorId: "syn-recovery-001",
    actorType: "HUMAN",
    idempotencyKey: "syn-rollback-stable-001"
  };

  const first = await session.rollback(command);
  const replay = await session.rollback(command);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(session.getSnapshot().receipts.length, 2);
});

test("an effect without an explicit human-approval policy remains non-executable", async () => {
  const scenario = await loadScenario();
  scenario.policy.approvalRequiredEffects = [];
  scenario.expected.approvalRequired = false;
  scenario.expected.effectExecutable = false;
  scenario.expected.requiredInvariantIds = [];

  const simulation = await createSimulation(scenario);

  assert.equal(simulation.proposal.approvalRequired, false);
  assert.equal(simulation.proposal.executableAfterApproval, false);
  assert.equal(simulation.assertionsPassed, true);
});
