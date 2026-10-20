// Response minimization, never an authorization boundary. Canonical results stay intact.
import { insist } from './transport.mjs';
const fields = {
  snapshot: ['revision', 'records', 'replayed', 'progress', 'revealed'],
  read: ['key', 'value', 'recordRevision', 'revision', 'replayed', 'progress', 'revealed'],
  write: ['key', 'value', 'recordRevision', 'revision', 'replayed', 'progress'],
  'issue-ticket': ['scope', 'issuedAt', 'expiresAt', 'maxUses', 'revision', 'replayed', 'progress'],
  'use-ticket': ['key', 'value', 'recordRevision', 'revision', 'usesRemaining', 'replayed', 'revealed', 'progress'],
};
export function participantResult(operation, result, ticketHandle) {
  insist(Object.hasOwn(fields, operation), 'OPERATION_DENIED');
  const output = Object.fromEntries(fields[operation].filter(key => Object.hasOwn(result, key))
    .map(key => [key, structuredClone(result[key])]));
  if (operation === 'issue-ticket' && Object.hasOwn(result, 'ticket')) output.ticket = ticketHandle(result.ticket);
  return output;
}
