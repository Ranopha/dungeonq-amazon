import { digest, exact, insist, seal, unseal } from './transport.mjs';

export const REFUSAL_DOMAIN = 'dungeonq.canonical-refusal/v1';
// Domain refusals only. Storage, authentication, projection and transport failures
// remain unknown even if they happen to carry a plausible error code.
const refusals = new Set(['INVALID_ENVELOPE', 'IDENTIFIER_INVALID', 'REQUEST_ID_INVALID',
  'REVISION_INVALID', 'REVISION_CONFLICT', 'VALUE_NOT_PASSIVE', 'VALUE_TOO_LARGE',
  'VALUE_TOO_DEEP', 'VALUE_INVALID', 'RECORD_UNKNOWN', 'RECORD_LIMIT',
  'TICKET_INVALID', 'TICKET_SCOPE_INVALID', 'TICKET_TTL_INVALID', 'TICKET_USES_INVALID',
  'TICKET_LIMIT', 'TICKET_UNKNOWN', 'TICKET_EXPIRED', 'TICKET_EXHAUSTED',
  'TICKET_CONTEXT_INVALID', 'TICKET_AUTHORITY_INVALID', 'IDEMPOTENCY_CONFLICT']);

export function executeOutcome(store, input, admitted, key) {
  const before = store.evidence().verifier;
  try { return { result: store.execute(input) }; }
  catch (error) {
    // execute is synchronous and transactional. A successful independent replay
    // after rollback must match the exact pre-call journal and state checkpoint.
    // This proves no NEW canonical effect in this attempt, not that an earlier
    // request with the same identity never took effect.
    if (!refusals.has(error.code)) throw error;
    const after = store.evidence().verifier;
    if (digest(before) !== digest(after) || after.status !== 'VERIFIED') throw error;
    return { refusal: seal({ outcome: 'REFUSED', code: error.code,
      contextId: input.contextId, family: input.family, requestId: input.requestId,
      operation: input.operation, inputDigest: digest(admitted), commandDigest: digest({ kind: 'EXECUTE', input }),
      checkpoint: { head: after.head, stateDigest: after.stateDigest, eventCount: after.eventCount }
    }, key, REFUSAL_DOMAIN) };
  }
}

export function verifyRefusal(proof, key, expected) {
  const value = unseal(proof, key, REFUSAL_DOMAIN);
  exact(value, ['outcome', 'code', 'contextId', 'family', 'requestId', 'operation', 'inputDigest', 'checkpoint'], ['commandDigest']);
  if (value.commandDigest !== undefined) insist(/^[a-f0-9]{64}$/.test(value.commandDigest), 'REFUSAL_INVALID');
  exact(value.checkpoint, ['head', 'stateDigest', 'eventCount']);
  insist(value.outcome === 'REFUSED' && refusals.has(value.code), 'REFUSAL_INVALID');
  for (const field of ['contextId', 'family', 'requestId']) insist(value[field] === expected[field], 'REFUSAL_MISMATCH');
  if (expected.operation !== undefined) insist(value.operation === expected.operation, 'REFUSAL_MISMATCH');
  if (expected.inputDigest !== undefined) insist(value.inputDigest === expected.inputDigest, 'REFUSAL_MISMATCH');
  insist(/^[a-f0-9]{64}$/.test(value.inputDigest) && /^[a-f0-9]{64}$/.test(value.checkpoint.stateDigest)
    && Number.isSafeInteger(value.checkpoint.eventCount) && value.checkpoint.eventCount >= 0, 'REFUSAL_INVALID');
  return value;
}
