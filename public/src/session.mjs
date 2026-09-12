import { canonicalJson, sha256Hex } from "./canonical.mjs";
import { createSimulation } from "./engine.mjs";
import { validateScenarioPack } from "./scenario.mjs";

export class LabSessionError extends Error {
  constructor(code) {
    super(code);
    this.name = "LabSessionError";
    this.code = code;
  }
}

const ACTOR_TYPES = new Set(["AGENT", "HUMAN", "SYSTEM"]);
const AFTER_STATE_BY_EFFECT = Object.freeze({
  STATIC_DECOY: "DECOY_READY",
  ISOLATE_SESSION: "ISOLATED",
  ROTATE_CREDENTIAL: "CREDENTIAL_ROTATED",
  RELEASE_NEW_CONTEXT: "FRESH_CONTEXT_ISSUED"
});

function immutableClone(value) {
  const clone = structuredClone(value);
  const freeze = (entry) => {
    if (entry && typeof entry === "object" && !Object.isFrozen(entry)) {
      Object.freeze(entry);
      Object.values(entry).forEach(freeze);
    }
    return entry;
  };
  return freeze(clone);
}

function assertActor(actorId, actorType) {
  if (typeof actorId !== "string" || !actorId.startsWith("syn-") || !ACTOR_TYPES.has(actorType)) {
    throw new LabSessionError("ACTOR_INVALID");
  }
}

function receiptPayload(receipt) {
  const payload = { ...receipt };
  delete payload.digest;
  return payload;
}

export async function createLabSession(input) {
  const scenario = validateScenarioPack(input);
  let state = "VALIDATED";
  let revision = 1;
  let simulation = null;
  let approvalRequest = null;
  let approvalRecord = null;
  let targetState = scenario.environment.assets.find(
    (asset) => asset.id === scenario.requestedEffect.targetAssetId
  )?.initialState;
  const receipts = [];
  const audit = [];
  const claims = new Map();
  let operationQueue = Promise.resolve();

  function enqueue(operation) {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => undefined);
    return result;
  }

  async function appendAudit(eventType, actorId, actorType, details) {
    const sequence = audit.length + 1;
    const previousDigest = audit.at(-1)?.digest ?? null;
    const payloadDigest = await sha256Hex(canonicalJson(details));
    const base = { sequence, eventType, actorId, actorType, state, revision, payloadDigest, previousDigest };
    const entry = immutableClone({ ...base, digest: await sha256Hex(canonicalJson(base)) });
    audit.push(entry);
    return entry;
  }

  function snapshot() {
    return immutableClone({
      state,
      revision,
      scenarioId: scenario.scenarioId,
      targetState,
      simulation,
      approvalRequest,
      approvalRecord,
      receipts,
      audit
    });
  }

  async function simulate({ actorId, actorType }) {
    return enqueue(async () => {
      assertActor(actorId, actorType);
      if (state !== "VALIDATED") throw new LabSessionError("STATE_TRANSITION_INVALID");
      simulation = await createSimulation(scenario);
      state = "SIMULATED";
      await appendAudit("SIMULATION_CREATED", actorId, actorType, {
        inputDigest: simulation.inputDigest,
        proposalDigest: simulation.proposal.digest,
        assertionsPassed: simulation.assertionsPassed
      });
      return immutableClone({ state, ...simulation });
    });
  }

  async function requestApproval({ actorId, actorType }) {
    return enqueue(async () => {
      assertActor(actorId, actorType);
      if (state !== "SIMULATED") throw new LabSessionError("STATE_TRANSITION_INVALID");
      if (!simulation.proposal.executableAfterApproval) throw new LabSessionError("EFFECT_BLOCKED");
      if (!simulation.proposal.approvalRequired) throw new LabSessionError("APPROVAL_NOT_REQUIRED");
      const requestBase = {
        scenarioId: scenario.scenarioId,
        proposerId: actorId,
        proposalDigest: simulation.proposal.digest,
        revision
      };
      approvalRequest = immutableClone({
        ...requestBase,
        requestId: `syn-approval-request-${(await sha256Hex(canonicalJson(requestBase))).slice(0, 16)}`
      });
      state = "APPROVAL_PENDING";
      await appendAudit("APPROVAL_REQUESTED", actorId, actorType, approvalRequest);
      return immutableClone({ state, ...approvalRequest });
    });
  }

  async function approve({ actorId, actorType, proposalDigest, revision: expectedRevision }) {
    return enqueue(async () => {
      assertActor(actorId, actorType);
      if (state !== "APPROVAL_PENDING") throw new LabSessionError("STATE_TRANSITION_INVALID");
      if (actorType !== "HUMAN") throw new LabSessionError("HUMAN_APPROVAL_REQUIRED");
      if (actorId === approvalRequest.proposerId) throw new LabSessionError("SELF_APPROVAL_FORBIDDEN");
      if (proposalDigest !== simulation.proposal.digest || expectedRevision !== revision) {
        throw new LabSessionError("APPROVAL_STALE");
      }
      const recordBase = {
        scenarioId: scenario.scenarioId,
        approverId: actorId,
        proposalDigest,
        revision,
        requestId: approvalRequest.requestId,
        decision: "APPROVED"
      };
      approvalRecord = immutableClone({
        ...recordBase,
        digest: await sha256Hex(canonicalJson(recordBase))
      });
      state = "APPROVED";
      await appendAudit("APPROVAL_GRANTED", actorId, actorType, approvalRecord);
      return immutableClone({ state, record: approvalRecord });
    });
  }

  async function apply({ actorId, actorType, proposalDigest, revision: expectedRevision, idempotencyKey }) {
    return enqueue(async () => {
      assertActor(actorId, actorType);
      if (typeof idempotencyKey !== "string" || !idempotencyKey.startsWith("syn-")) {
        throw new LabSessionError("IDEMPOTENCY_KEY_INVALID");
      }
      const priorClaim = claims.get(idempotencyKey);
      if (priorClaim) {
        if (
          priorClaim.operation !== "APPLY" ||
          priorClaim.proposalDigest !== proposalDigest ||
          priorClaim.revision !== expectedRevision
        ) {
          throw new LabSessionError("IDEMPOTENCY_CONFLICT");
        }
        return immutableClone({ state, receipt: priorClaim.receipt, replayed: true });
      }
      if (state !== "APPROVED") throw new LabSessionError("STATE_TRANSITION_INVALID");
      if (proposalDigest !== simulation.proposal.digest || expectedRevision !== revision) {
        throw new LabSessionError("EFFECT_STALE");
      }
      if (approvalRecord?.proposalDigest !== proposalDigest || targetState !== simulation.proposal.expectedBeforeState) {
        throw new LabSessionError("EXPECTED_STATE_MISMATCH");
      }
      const beforeState = targetState;
      const afterState = AFTER_STATE_BY_EFFECT[simulation.proposal.effectType];
      const base = {
        receiptVersion: "dungeonq.receipt/v1",
        receiptId: `syn-receipt-${receipts.length + 1}`,
        scenarioId: scenario.scenarioId,
        sequence: receipts.length + 1,
        result: "APPLIED",
        effectType: simulation.proposal.effectType,
        targetAssetId: simulation.proposal.targetAssetId,
        beforeState,
        afterState,
        proposalDigest,
        approvalDigest: approvalRecord.digest,
        idempotencyKey,
        compensatesReceiptDigest: null
      };
      const receipt = immutableClone({ ...base, digest: await sha256Hex(canonicalJson(base)) });
      targetState = afterState;
      receipts.push(receipt);
      claims.set(idempotencyKey, { operation: "APPLY", proposalDigest, revision: expectedRevision, receipt });
      state = "APPLIED";
      await appendAudit("EFFECT_APPLIED", actorId, actorType, receipt);
      return immutableClone({ state, receipt, replayed: false });
    });
  }

  async function verify({ receipt }) {
    return enqueue(async () => {
      if (!receipt || typeof receipt !== "object" || typeof receipt.digest !== "string") {
        throw new LabSessionError("RECEIPT_INVALID");
      }
      const calculated = await sha256Hex(canonicalJson(receiptPayload(receipt)));
      const stored = receipts.find((item) => item.receiptId === receipt.receiptId);
      if (calculated !== receipt.digest || !stored || stored.digest !== receipt.digest) {
        return immutableClone({ valid: false, reason: "DIGEST_MISMATCH", state });
      }
      if (receipt.result === "APPLIED" && state === "APPLIED") state = "VERIFIED";
      await appendAudit("RECEIPT_VERIFIED", "syn-verifier-001", "SYSTEM", {
        receiptId: receipt.receiptId,
        receiptDigest: receipt.digest
      });
      return immutableClone({ valid: true, reason: "RECEIPT_VALID", state });
    });
  }

  async function rollback({ actorId, actorType, idempotencyKey }) {
    return enqueue(async () => {
      assertActor(actorId, actorType);
      if (typeof idempotencyKey !== "string" || !idempotencyKey.startsWith("syn-")) {
        throw new LabSessionError("IDEMPOTENCY_KEY_INVALID");
      }
      const priorClaim = claims.get(idempotencyKey);
      if (priorClaim) {
        if (
          priorClaim.operation !== "ROLLBACK" ||
          priorClaim.proposalDigest !== simulation.proposal.digest ||
          priorClaim.revision !== revision
        ) {
          throw new LabSessionError("IDEMPOTENCY_CONFLICT");
        }
        return immutableClone({ state, receipt: priorClaim.receipt, replayed: true });
      }
      if (!new Set(["APPLIED", "VERIFIED"]).has(state)) throw new LabSessionError("STATE_TRANSITION_INVALID");
      const appliedReceipt = receipts.find((receipt) => receipt.result === "APPLIED");
      const base = {
        receiptVersion: "dungeonq.receipt/v1",
        receiptId: `syn-receipt-${receipts.length + 1}`,
        scenarioId: scenario.scenarioId,
        sequence: receipts.length + 1,
        result: "COMPENSATED",
        effectType: simulation.proposal.effectType,
        targetAssetId: simulation.proposal.targetAssetId,
        beforeState: targetState,
        afterState: appliedReceipt.beforeState,
        proposalDigest: simulation.proposal.digest,
        approvalDigest: approvalRecord.digest,
        idempotencyKey,
        compensatesReceiptDigest: appliedReceipt.digest
      };
      const receipt = immutableClone({ ...base, digest: await sha256Hex(canonicalJson(base)) });
      targetState = receipt.afterState;
      receipts.push(receipt);
      claims.set(idempotencyKey, {
        operation: "ROLLBACK",
        proposalDigest: simulation.proposal.digest,
        revision,
        receipt
      });
      state = "ROLLED_BACK";
      await appendAudit("EFFECT_COMPENSATED", actorId, actorType, receipt);
      return immutableClone({ state, receipt, replayed: false });
    });
  }

  async function exportEvidence() {
    return enqueue(async () => {
      if (state === "VALIDATED") throw new LabSessionError("SIMULATION_REQUIRED");
      const commandTranscriptDigest = await sha256Hex(canonicalJson(audit));
      const base = {
        bundleVersion: "dungeonq.evidence/v1",
        engineVersion: simulation.engineVersion,
        generatedAtMode: "DETERMINISTIC_SEQUENCE",
        claimBoundary: "SYNTHETIC_SIMULATION_ONLY",
        scenarioId: scenario.scenarioId,
        seed: scenario.seed,
        inputDigest: simulation.inputDigest,
        commandTranscriptDigest,
        state,
        targetReadback: Object.freeze({
          targetAssetId: simulation.proposal.targetAssetId,
          state: targetState
        }),
        decision: simulation.decision,
        constraints: simulation.constraints,
        proposal: simulation.proposal,
        approvalRecord,
        receipts,
        invariantResults: simulation.invariantResults,
        assertionResults: simulation.assertionResults,
        assertionsPassed: simulation.assertionsPassed,
        audit
      };
      return immutableClone({ ...base, digest: await sha256Hex(canonicalJson(base)) });
    });
  }

  return Object.freeze({
    getSnapshot: snapshot,
    simulate,
    requestApproval,
    approve,
    apply,
    verify,
    rollback,
    exportEvidence
  });
}
