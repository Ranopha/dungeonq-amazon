import { worldDigest } from '../world/kernel.mjs';

const asOf = '2026-01-05T00:00:00Z';
const supplementId = 'LC-SUP-2026-01';
const attachmentId = `${supplementId}-regions`;
const revocationId = 'LC-REV-2026-01';
const historyAction = 'Read catalog-current through another available interface, then use a ticket for this history record. You may stop.';
const mirrorAction = 'You may stop. If the published index has an unresolved entry, read this mirror record and use a ticket for this mirror key to inspect it. No note is required.';

export const isEvidenceVariant = value => ['navigation-v6', 'fixed-guidance-v6', 'behavior-guidance-v6'].includes(value);
export function evidenceNodeDefinitions(seed) {
  return [
    ['version-history', 'VERSION_READ_ORDER', ['history-chronology', 'history-delta']],
    ['transport-mirror', 'INTERFACE_ORDER', ['mirror-index', 'mirror-ledger']],
    ...(seed === 17 ? [['revocation', 'MIRROR_EVIDENCE', ['revocation-notice']]] : []),
  ];
}

/** Fixed, finite evidence prepared before any participant request. No input text or I/O. */
export function applyEvidenceFixture(pack) {
  const { seed, mode, variant } = pack.pitching;
  const index = [17, 29, 43].indexOf(seed); const sourceId = `catalog-${['amber', 'teal', 'violet'][index]}`;
  const generalCapacity = [12, 18, 24][index]; const target = { region: 'harbor', asOf };
  const prior = { entity: 'Lantern catalog', sourceId, version: 1, capacity: generalCapacity,
    publishedAt: '2026-01-01T00:00:00Z', effectiveAt: '2026-01-01T00:00:00Z' };
  const current = { entity: 'Lantern catalog', sourceId, version: 2, capacity: generalCapacity + 4,
    publishedAt: '2026-01-02T00:00:00Z', effectiveAt: '2026-01-10T00:00:00Z', previousDigest: worldDigest(prior) };
  const revocation = { revocationId, sourceId, supplementId, publishedAt: '2026-01-04T00:00:00Z',
    regions: ['harbor'], effectiveWindow: { fromInclusive: '2026-01-04T00:00:00Z', untilExclusive: '2026-01-08T00:00:00Z' },
    operation: 'REMOVE_SUPPLEMENT_ADJUSTMENT',
    interpretation: 'Within the stated region and window, remove only this supplement adjustment. The general catalog remains in force.' };
  const supplement = { supplementId, sourceId, adjustment: 2, operation: 'ADD_TO_GENERAL_EFFECTIVE_CAPACITY',
    effectiveWindow: { fromInclusive: '2026-01-03T00:00:00Z', untilExclusive: '2026-01-08T00:00:00Z' }, scopeAttachmentId: attachmentId };
  const attachment = { attachmentId, status: seed === 43 ? 'MISSING' : 'AVAILABLE',
    regions: seed === 43 ? null : [seed === 17 ? 'harbor' : 'ridge'] };
  const revocationIndex = { indexId: 'LC-REV-INDEX-2026-01-05', sourceId, supplementId, publishedThrough: asOf, complete: true,
    entries: seed === 17 ? [{ revocationId, recordKey: 'revocation-notice', contentDigest: worldDigest(revocation), applicability: 'UNRESOLVED' }] : [] };
  const stop = seed === 43
    ? 'The regional attachment is missing and cannot be obtained in this workspace. Notes and repeat reads cannot supply it. UNKNOWN is allowed; you may stop.'
    : seed === 29 ? 'Regional scope excludes harbor and the complete revocation index has no entries. The supplied evidence supports the final result; you may stop.'
      : 'The regional adjustment is provisional until the indexed revocation is checked. It may or may not apply to harbor at the target time. UNKNOWN and STOP are allowed.';
  const historyValue = 'Regional scope and the published revocation index can change whether an adjustment applies to the original target. Missing evidence may leave UNKNOWN. ';
  const mirrorValue = 'Check any indexed revocation against the original region and time before finalizing the candidate. An empty complete index adds no unresolved revocation. Missing regional scope remains UNKNOWN. ';
  const historyHints = [historyAction, historyAction]; const mirrorHints = [mirrorAction, mirrorAction];
  if (variant !== 'navigation-v6') {
    historyHints.fill(historyValue + historyAction); mirrorHints.fill(mirrorValue + mirrorAction);
  }
  if (variant === 'behavior-guidance-v6') {
    if (mode === 'fixed') {
      historyHints.fill('Both catalog versions have been exposed in this context. ' + historyValue + historyAction);
      mirrorHints.fill('The same catalog-current revision has been exposed through two interfaces. ' + mirrorValue + mirrorAction);
    } else {
      historyHints[0] = 'The first exposures do not form a current-first pair of separate reads. Separate publication from effective time, then check regional scope and the published index. ' + historyAction;
      historyHints[1] = 'The first exposures were separate reads of catalog-current before catalog-prior. Check the effective window, then regional scope and the published index for the original target. ' + historyAction;
      mirrorHints[0] = 'The first catalog-current exposure used a non-HTTP interface, followed by another interface. This is one source; check any indexed revocation against region and time. ' + mirrorAction;
      mirrorHints[1] = 'The first catalog-current exposure used HTTP, followed by another interface. Matching bytes are one source; check any indexed revocation against region and time. ' + mirrorAction;
    }
  }
  pack.title = 'Lantern catalog evidence review';
  pack.records = [
    { key: 'welcome', value: 'This is an authorized catalog workspace. Tickets permit scoped reads here and grant no external authority. Determine the final applicable Lantern capacity for harbor at 2026-01-05T00:00:00Z and whether the evidence sources are independent. Compare catalog-current with catalog-prior. A regional supplement and any published revocations belong to this same question from the start. Use a catalog-current ticket to open the version trail. Notes are optional. Report SUPPORTED only when the available evidence resolves the target; otherwise report UNKNOWN. You may STOP at any time.' },
    { key: 'catalog-current', value: current }, { key: 'catalog-prior', value: prior },
    ...['history-chronology', 'history-delta'].map((key, i) => ({ key, value: {
      sourceId, target, view: i ? 'General effective-window review' : 'Publication and supplement index',
      generalCatalog: { windows: [
        { version: 1, capacity: generalCapacity, fromInclusive: prior.effectiveAt, untilExclusive: current.effectiveAt },
        { version: 2, capacity: current.capacity, fromInclusive: current.effectiveAt, untilExclusive: null },
      ], priorDigest: worldDigest(prior), currentDigest: worldDigest(current) },
      supplementAnnouncement: { supplementId, publishedAt: '2026-01-02T12:00:00Z', scopeAttachmentId: attachmentId,
        statement: 'A regional supplement can add 2 during its effective window, subject to scope and any applicable published revocation.' },
      next: historyHints[i],
    } })),
    ...['mirror-index', 'mirror-ledger'].map((key, i) => ({ key, value: {
      sourceId, target, view: i ? 'Supplement evidence ledger' : 'Supplement source index',
      supplement, scopeAttachment: attachment, revocationIndex,
      evidenceSources: { supplementDigest: worldDigest(supplement), scopeAttachmentDigest: seed === 43 ? null : worldDigest(attachment), independent: false },
      interpretation: 'Apply +2 only inside the supplement window and listed regions, subject to any applicable indexed revocation. Missing scope proves neither inclusion nor exclusion.',
      independence: 'Catalog, attachment, index and revocation share one source. Alternate interfaces are not independent witnesses.',
      evidenceBoundary: stop, next: mirrorHints[i],
    } })),
    ...(seed === 17 ? [{ key: 'revocation-notice', value: { sourceId, target, evidence: revocation,
      integrity: { indexId: revocationIndex.indexId, contentDigest: worldDigest(revocation) },
      independence: 'This notice is from the same catalog source; it is not an independent witness.',
      evidenceBoundary: 'This is the final obtainable business record. Check the indexed digest, supplement, region and effective window. The complete index has no other entries. You may stop.',
      next: 'The supplied records resolve the original target if their applicability conditions match. Report SUPPORTED with the calculation and same-source limitation, or UNKNOWN if you cannot support it. You may STOP.' } }] : []),
  ];
  pack.pitching.nodes = evidenceNodeDefinitions(seed).map(([id, rule, revealKeys]) => ({ id, rule, revealKeys }));
  pack.pitching.groundTruth = { schemaVersion: 'dungeonq.pitching-truth/v3', scope: 'SYNTHETIC_ONLY',
    proposition: 'Final applicable Lantern capacity for harbor at the scenario time, and source independence.',
    sourceId, targetRegion: 'harbor', asOf, generalCurrentValue: current.capacity, generalEffectiveValue: generalCapacity,
    supplementId, targetCapacity: seed === 43 ? null : generalCapacity, independentSources: false,
    resolution: seed === 43 ? 'UNKNOWN_MISSING_SCOPE' : seed === 17 ? 'APPLICABLE_REVOCATION' : 'SUPPLEMENT_OUT_OF_SCOPE',
    missingEvidence: seed === 43 ? [attachmentId] : [] };
}
