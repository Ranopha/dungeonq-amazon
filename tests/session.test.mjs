import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LabSessionError,
  canonicalJson,
  createLabSession,
  sha256Hex,
  verifyEvidenceBundle
} from "../public/src/index.mjs";

const scenarioUrl = new URL("../public/scenarios/honey-credential.json", import.meta.url);

async function loadScenario() {
  return JSON.parse(await readFile(scenarioUrl, "utf8"));
}

test("judge can run the governed simulation lifecycle and retain compensation evidence", async () => {
  const session = await createLabSession(await loadScenario());
  assert.equal(session.getSnapshot().state, "VALIDATED");

  const simulation = await session.simulate({ actorId: "syn-judge-001", actorType: "HUMAN" });
  assert.equal(simulation.state, "SIMULATED");
  assert.equal(simulation.decision.route, "DENY");

  const request = await session.requestApproval({ actorId: "syn-agent-001", actorType: "AGENT" });
  assert.equal(request.state, "APPROVAL_PENDING");
  assert.equal(request.proposerId, "syn-agent-001");

  await assert.rejects(
    () =>
      session.approve({
        actorId: "syn-agent-001",
        actorType: "HUMAN",
        proposalDigest: simulation.proposal.digest,
        revision: 1
      }),
    (error) => error instanceof LabSessionError && error.code === "SELF_APPROVAL_FORBIDDEN"
  );

  const approval = await session.approve({
    actorId: "syn-reviewer-001",
    actorType: "HUMAN",
    proposalDigest: simulation.proposal.digest,
    revision: 1
  });
  assert.equal(approval.state, "APPROVED");
  assert.equal(approval.record.proposalDigest, simulation.proposal.digest);

  const applied = await session.apply({
    actorId: "syn-effect-broker-001",
    actorType: "SYSTEM",
    proposalDigest: simulation.proposal.digest,
    revision: 1,
    idempotencyKey: "syn-claim-001"
  });
  assert.equal(applied.state, "APPLIED");
  assert.equal(applied.receipt.beforeState, "AVAILABLE");
  assert.equal(applied.receipt.afterState, "CREDENTIAL_ROTATED");

  const verification = await session.verify({ receipt: applied.receipt });
  assert.deepEqual(verification, { valid: true, reason: "RECEIPT_VALID", state: "VERIFIED" });

  const rollback = await session.rollback({
    actorId: "syn-recovery-001",
    actorType: "HUMAN",
    idempotencyKey: "syn-compensation-001"
  });
  assert.equal(rollback.state, "ROLLED_BACK");
  assert.equal(rollback.receipt.result, "COMPENSATED");
  assert.equal(rollback.receipt.afterState, "AVAILABLE");

  const snapshot = session.getSnapshot();
  assert.equal(snapshot.receipts.length, 2);
  assert.equal(snapshot.receipts[0].result, "APPLIED");
  assert.equal(snapshot.receipts[1].result, "COMPENSATED");
  assert.equal(snapshot.audit.every((entry, index) => entry.sequence === index + 1), true);
});

test("evidence bundle is deterministic and exposes any protected-field tamper", async () => {
  const session = await createLabSession(await loadScenario());
  await session.simulate({ actorId: "syn-judge-001", actorType: "HUMAN" });

  const first = await session.exportEvidence();
  const second = await session.exportEvidence();

  assert.deepEqual(second, first);
  assert.equal(first.bundleVersion, "dungeonq.evidence/v1");
  assert.equal(first.claimBoundary, "SYNTHETIC_SIMULATION_ONLY");
  assert.equal(first.state, "SIMULATED");
  assert.match(first.digest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(await verifyEvidenceBundle(first), { valid: true, reason: "EVIDENCE_VALID" });

  const tampered = structuredClone(first);
  tampered.decision.route = "NO_ADDITIONAL_RESTRICTION";
  assert.deepEqual(await verifyEvidenceBundle(tampered), { valid: false, reason: "DIGEST_MISMATCH" });
});

test("human UI and agent adapter actors receive the same deterministic decision and proposal digest", async () => {
  const scenario = await loadScenario();
  const humanSession = await createLabSession(scenario);
  const agentSession = await createLabSession(scenario);

  const humanRun = await humanSession.simulate({ actorId: "syn-ui-parity-001", actorType: "HUMAN" });
  const agentRun = await agentSession.simulate({ actorId: "syn-webmcp-parity-001", actorType: "AGENT" });

  assert.equal(agentRun.inputDigest, humanRun.inputDigest);
  assert.deepEqual(agentRun.decision, humanRun.decision);
  assert.equal(agentRun.proposal.digest, humanRun.proposal.digest);
});

test("evidence verification checks nested receipt digests even if the outer digest is recomputed", async () => {
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
    idempotencyKey: "syn-nested-proof-001"
  });
  const evidence = structuredClone(await session.exportEvidence());
  evidence.receipts[0].afterState = "AVAILABLE";
  const payload = { ...evidence };
  delete payload.digest;
  evidence.digest = await sha256Hex(canonicalJson(payload));

  assert.deepEqual(await verifyEvidenceBundle(evidence), {
    valid: false,
    reason: "RECEIPT_DIGEST_MISMATCH"
  });
});

test("evidence verification rejects cyclic untrusted objects with a public error", async () => {
  const cyclic = { bundleVersion: "dungeonq.evidence/v1", claimBoundary: "SYNTHETIC_SIMULATION_ONLY", digest: "0".repeat(64) };
  cyclic.self = cyclic;

  assert.deepEqual(await verifyEvidenceBundle(cyclic), { valid: false, reason: "EVIDENCE_INVALID" });
});
