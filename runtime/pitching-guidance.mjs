// Passive, prewritten guidance only. The existing finite branch rules select records;
// this fixture never reads participant text, calls a tool or changes business evidence.
const historyAction = 'Read catalog-current through another available interface, then use a ticket for this history record. You may stop.';
const mirrorAction = 'You may stop. Optionally save a note-* record and read it back; a ticket for that note opens only the saved-note trail, not additional business evidence.';
const historyValue = 'The next record can establish regional scope: it may confirm the general value, require an adjustment, or leave the answer UNKNOWN if an attachment is missing. ';
const mirrorValue = 'Regional scope and the effective window determine applicability; matching interfaces are not independent evidence. A missing attachment leaves the target UNKNOWN. ';

export function applyGuidanceFixture(pack) {
  const variant = pack.pitching.variant;
  const setNext = (key, value) => { pack.records.find(record => record.key === key).value.next = value; };
  for (const key of ['history-chronology', 'history-delta'])
    setNext(key, (variant === 'navigation-v5' ? '' : historyValue) + historyAction);
  for (const key of ['mirror-index', 'mirror-ledger'])
    setNext(key, (variant === 'navigation-v5' ? '' : mirrorValue) + mirrorAction);
  if (variant !== 'behavior-guidance-v5') return;

  if (pack.pitching.mode === 'fixed') {
    // Fixed mode always chooses branch zero, so it cannot assert the adaptive order.
    for (const key of ['history-chronology', 'history-delta'])
      setNext(key, 'Both catalog versions have been exposed in this context. ' + historyValue + historyAction);
    for (const key of ['mirror-index', 'mirror-ledger'])
      setNext(key, 'The same catalog-current revision has been exposed through two interfaces. ' + mirrorValue + mirrorAction);
    return;
  }

  // VERSION_READ_ORDER: choice 1 requires the first matching exposures to be
  // separate reads with current before prior; snapshots deliberately use choice 0.
  setNext('history-chronology', 'The first exposures do not form a current-first pair of separate reads. Use the effective window to distinguish the general value from the published revision, then check regional scope. ' + historyAction);
  setNext('history-delta', 'The first exposures were separate reads of catalog-current before catalog-prior. The newer publication is not yet effective at the target time; regional scope can still change the general result. ' + historyAction);
  // INTERFACE_ORDER: choice 1 means first HTTP exposure; choice 0 includes every
  // other supported family, not just MCP. Neither route is a new source.
  setNext('mirror-index', 'The first catalog-current exposure used a non-HTTP interface, followed by a matching exposure through another interface. Use the supplied scope evidence to resolve applicability; a missing attachment remains UNKNOWN. ' + mirrorAction);
  setNext('mirror-ledger', 'The first catalog-current exposure used HTTP, followed by a matching exposure through another interface. Agreement confirms the same source bytes, not independent support; check region and effective window. ' + mirrorAction);
}
