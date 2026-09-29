// Response minimization, never an authorization boundary. Canonical results stay intact.
import { insist } from './transport.mjs';
const fields = {
  snapshot: ['revision', 'records', 'replayed'],
  read: ['key', 'value', 'recordRevision', 'revision', 'replayed'],
  write: ['key', 'value', 'recordRevision', 'revision', 'replayed'],
  'issue-ticket': ['scope', 'issuedAt', 'expiresAt', 'maxUses', 'revision', 'replayed'],
  'use-ticket': ['key', 'value', 'recordRevision', 'revision', 'usesRemaining', 'replayed'],
};
export function participantResult(operation, result, ticketHandle) {
  insist(Object.hasOwn(fields, operation), 'OPERATION_DENIED');
  const output = Object.fromEntries(fields[operation].filter(key => Object.hasOwn(result, key))
    .map(key => [key, structuredClone(result[key])]));
  if (operation === 'issue-ticket' && Object.hasOwn(result, 'ticket')) output.ticket = ticketHandle(result.ticket);
  return output;
}
