import { canonicalJson, sha256Hex } from "./canonical.mjs";

async function digestMatches(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.digest !== "string") {
    return false;
  }
  const { digest, ...payload } = record;
  return (await sha256Hex(canonicalJson(payload))) === digest;
}

export async function verifyEvidenceBundle(bundle) {
  try {
    if (
      !bundle ||
      typeof bundle !== "object" ||
      Array.isArray(bundle) ||
      typeof bundle.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(bundle.digest) ||
      bundle.bundleVersion !== "dungeonq.evidence/v1" ||
      bundle.claimBoundary !== "SYNTHETIC_SIMULATION_ONLY"
    ) {
      return Object.freeze({ valid: false, reason: "EVIDENCE_INVALID" });
    }

    if (!(await digestMatches(bundle))) {
      return Object.freeze({ valid: false, reason: "DIGEST_MISMATCH" });
    }

    if (!bundle.proposal || typeof bundle.inputDigest !== "string") {
      return Object.freeze({ valid: false, reason: "EVIDENCE_INVALID" });
    }
    const { digest: proposalDigest, ...proposalPayload } = bundle.proposal;
    const expectedProposalDigest = await sha256Hex(
      canonicalJson({ inputDigest: bundle.inputDigest, ...proposalPayload })
    );
    if (proposalDigest !== expectedProposalDigest) {
      return Object.freeze({ valid: false, reason: "PROPOSAL_DIGEST_MISMATCH" });
    }

    if (bundle.approvalRecord !== null && !(await digestMatches(bundle.approvalRecord))) {
      return Object.freeze({ valid: false, reason: "APPROVAL_DIGEST_MISMATCH" });
    }

    if (!Array.isArray(bundle.receipts)) {
      return Object.freeze({ valid: false, reason: "EVIDENCE_INVALID" });
    }
    for (const [index, receipt] of bundle.receipts.entries()) {
      if (receipt?.sequence !== index + 1 || !(await digestMatches(receipt))) {
        return Object.freeze({ valid: false, reason: "RECEIPT_DIGEST_MISMATCH" });
      }
    }

    if (!Array.isArray(bundle.audit)) {
      return Object.freeze({ valid: false, reason: "EVIDENCE_INVALID" });
    }
    let previousDigest = null;
    for (const [index, entry] of bundle.audit.entries()) {
      if (
        entry?.sequence !== index + 1 ||
        entry?.previousDigest !== previousDigest ||
        !(await digestMatches(entry))
      ) {
        return Object.freeze({ valid: false, reason: "AUDIT_CHAIN_MISMATCH" });
      }
      previousDigest = entry.digest;
    }
    if ((await sha256Hex(canonicalJson(bundle.audit))) !== bundle.commandTranscriptDigest) {
      return Object.freeze({ valid: false, reason: "COMMAND_TRANSCRIPT_MISMATCH" });
    }

    if (bundle.receipts.length > 0) {
      const latestReceipt = bundle.receipts.at(-1);
      if (
        bundle.targetReadback?.targetAssetId !== latestReceipt.targetAssetId ||
        bundle.targetReadback?.state !== latestReceipt.afterState
      ) {
        return Object.freeze({ valid: false, reason: "READBACK_MISMATCH" });
      }
    }

    return Object.freeze({ valid: true, reason: "EVIDENCE_VALID" });
  } catch {
    return Object.freeze({ valid: false, reason: "EVIDENCE_INVALID" });
  }
}
