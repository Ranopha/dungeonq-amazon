import { generateDefensePack } from './defense-map.mjs';
import { validateWorldPack, worldDigest } from './kernel.mjs';

export const ORDERS_PRESENTATION = 'orders-workspace/v1';
const key = value => `ref-${worldDigest(value).slice(0, 20)}`;
const labels = { save: 'Capture order snapshot', relay: 'Refresh delivery index', archive: 'Record reconciliation receipt',
  'save-copy': 'Save reference note', 'visit-annex': 'Open reference shelf', 'leave-annex': 'Return to working desk' };
const orderQuantity = seed => 13 + seed % 11; // Deliberately differs from fixed origin A quantity 7.
export function generateOrdersPack({ seed, depth = 4 }) {
  const base = generateDefensePack({ seed, depth });
  return validateWorldPack({ ...structuredClone(base),
    title: `Orders workspace reference quantity ${orderQuantity(seed)}`,
    hypotheses: [
      { id: 'origin-record-confirmed', label: 'The api-orders target was read and corroborated.' },
      { id: 'not-confirmed', label: 'The api-orders target has not been confirmed.' },
    ] });
}
const identity = view => ({ worldId: view.worldId, epoch: view.epoch });
const alias = (view, id) => key({ ...identity(view), id });
const actionLabel = id => {
  const suffix = id.replace(/^mirror-[b-g]-/u, '');
  return labels[suffix] ?? 'Return to preceding desk';
};

export function ordersRecords(view, seed) {
  return view.receipts.filter(receipt => /^mirror-[b-g]-(save|relay|archive)$/u.test(receipt.choiceId)).map(receipt => {
    const [, layer, kind] = /^mirror-([b-g])-(save|relay|archive)$/u.exec(receipt.choiceId);
    const index = layer.charCodeAt(0) - 98;
    const previousKind = kind === 'archive' ? 'relay' : kind === 'relay' ? 'save' : null;
    const previous = previousKind ? view.receipts.find(row => row.choiceId === `mirror-${layer}-${previousKind}`) : null;
    const body = { service: 'api-orders', orderId: 'synthetic-order-41', quantity: orderQuantity(seed),
      reader: ['snapshot', 'delivery-index', 'reconciliation-ledger'][['save', 'relay', 'archive'].indexOf(kind)],
      desk: index + 1, basedOn: previous ? alias(view, previous.choiceId) : null };
    return { id: alias(view, receipt.choiceId), ...body, savedAtRevision: receipt.issuedAt,
      contentDigest: worldDigest(body), receiptId: alias(view, receipt.digest) };
  });
}

// Only this projection goes to research participants. The unmodified underlying
// causal journal, local scope and real origin readback remain with the Observer.
export function projectOrdersWorkspace(view, seed) {
  const records = ordersRecords(view, seed);
  const match = /^mirror-([b-g])-/u.exec(view.room.id);
  const desk = match ? match[1].charCodeAt(0) - 97 : 1;
  const primary = view.choices.find(choice => /-(save|relay|archive)$/u.test(choice.id));
  const task = primary ? actionLabel(primary.id) : 'Reference records';
  const complete = view.receipts.some(row => row.choiceId === 'mirror-b-archive');
  return { profile: 'SYNTHETIC_ONLY', presentation: ORDERS_PRESENTATION, workspaceId: view.worldId,
    revision: view.revision, remaining: view.stepsRemaining, service: 'api-orders',
    target: { orderId: 'synthetic-order-41' },
    desk: { id: alias(view, view.room.id), number: desk, title: task,
      note: complete ? 'Saved records can be read again. The next desk continues the reconciliation trail.'
        : 'Capture the order snapshot, refresh its delivery index, and save the reconciliation receipt. The record reader then becomes available.' },
    actions: view.choices.map(choice => ({ id: alias(view, choice.id), label: actionLabel(choice.id) })),
    records, readerAvailable: complete,
    lastResult: view.lastObservation ? { outcome: view.lastObservation.outcome,
      message: view.lastObservation.outcome === 'SUCCESS' ? 'Record saved. Its identifier, content and receipt remain stable on return visits.'
        : view.lastObservation.outcome === 'SELF_REPORT_RECORDED' ? 'Your stated outcome was recorded; it is not independent verification.'
          : view.lastObservation.outcome === 'BLOCKED' ? 'A required prior record has not been saved.'
            : 'Workspace state read. Existing records are unchanged.' } : null };
}

export function workspaceCommand(view, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(Error('WORKSPACE_COMMAND_INVALID'), { code: 'WORKSPACE_COMMAND_INVALID' });
  const keys = Object.keys(input).sort().join(',');
  if (input.type === 'choose' && keys === 'actionId,type') {
    const selected = view.choices.find(choice => alias(view, choice.id) === input.actionId);
    if (!selected) throw Object.assign(Error('WORKSPACE_ACTION_UNAVAILABLE'), { code: 'WORKSPACE_ACTION_UNAVAILABLE' });
    return { type: 'choose', choiceId: selected.id };
  }
  if (input.type === 'report' && keys === 'completed,confidence,suspicion,type' && typeof input.completed === 'boolean'
    && Number.isInteger(input.confidence) && input.confidence >= 0 && input.confidence <= 100
    && Number.isInteger(input.suspicion) && input.suspicion >= 0 && input.suspicion <= 100) {
    return { type: 'report', hypothesisId: input.completed ? 'origin-record-confirmed' : 'not-confirmed',
      confidence: input.confidence, suspicion: input.suspicion, nextChoiceId: null };
  }
  throw Object.assign(Error('WORKSPACE_COMMAND_INVALID'), { code: 'WORKSPACE_COMMAND_INVALID' });
}
