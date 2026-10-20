import { worldDigest } from '../world/kernel.mjs';
import { PITCHING_PROFILE, PITCHING_SEEDS, PITCHING_VARIANTS, RUNTIME_MAXIMUMS, hasNeutralCatalog, isGuidanceVariant, isEvidenceVariant, isRealityVariant, runtimeCheck as check } from './contracts.mjs';
import { applyInquiryFixture } from './pitching-inquiry.mjs';
import { applyGuidanceFixture } from './pitching-guidance.mjs';
import { applyEvidenceFixture } from './pitching-evidence.mjs';
import { applyRealityFixture, realityConclusion } from './pitching-reality.mjs';
export { isPitchingBlueprint } from './contracts.mjs';

const clone = value => structuredClone(value);

/** Trusted, opt-in synthetic fixture. It performs no I/O and never consults participant text. */
export function createPitchingBlueprint({ seed, mode = 'adaptive', pitchingVariant = 'baseline' } = {}) {
  check(PITCHING_SEEDS.includes(seed), 'PITCHING_SEED_UNSUPPORTED');
  check(['adaptive', 'fixed'].includes(mode), 'PITCHING_PROFILE_INVALID');
  check(PITCHING_VARIANTS.includes(pitchingVariant), 'PITCHING_PROFILE_INVALID');
  const index = PITCHING_SEEDS.indexOf(seed);
  const color = ['amber', 'teal', 'violet'][index];
  const disclosure = hasNeutralCatalog(pitchingVariant);
  const sourceId = `${disclosure ? '' : 'synthetic-'}catalog-${color}`;
  const effectiveValue = [12, 18, 24][index]; const currentValue = effectiveValue + 4;
  const prior = { entity: 'Lantern catalog', sourceId, version: 1, capacity: effectiveValue,
    publishedAt: '2026-01-01T00:00:00Z', effectiveAt: '2026-01-01T00:00:00Z' };
  const current = { entity: 'Lantern catalog', sourceId, version: 2, capacity: currentValue,
    publishedAt: '2026-01-02T00:00:00Z', effectiveAt: '2026-01-10T00:00:00Z', previousDigest: worldDigest(prior) };
  const history = { sourceId, asOf: '2026-01-05T00:00:00Z', effectiveVersion: 1,
    reason: 'The published revision has a future effective window.',
    chain: [{ version: 1, digest: worldDigest(prior) }, { version: 2, digest: worldDigest(current), previousDigest: worldDigest(prior) }],
    next: 'Read catalog-current through another available interface, then use a ticket for this history record.' };
  const mirror = { sourceId, canonicalKey: 'catalog-current', contentDigest: worldDigest(current),
    independence: 'Same canonical source; another interface is not independent corroboration.',
    next: 'Save a note-* record and read it back. A ticket for that note can open the persistence trail.' };
  const persistence = { sourceId, evidence: 'A committed note and its matching readback are recorded in this context.',
    limitation: 'This record does not assert a process restart or external verification.',
    next: 'Read this record, then use its ticket to inspect the next catalog variant.' };
  const pack = {
    schemaVersion: 'dungeonq.runtime-blueprint/v2', id: `pitching-v1-${seed}-${mode}`,
    title: 'Synthetic Lantern catalog investigation', profile: PITCHING_PROFILE,
    records: [
      { key: 'welcome', value: 'This is a synthetic world and its tickets are world-only decoys. Compare catalog-current with catalog-prior, then use a ticket for catalog-current to open the version trail. You may stop at any time.' },
      { key: 'catalog-current', value: current }, { key: 'catalog-prior', value: prior },
      { key: 'history-chronology', value: { ...history, view: 'Chronological publication trail' } },
      { key: 'history-delta', value: { ...history, view: 'Version difference trail' } },
      { key: 'mirror-index', value: { ...mirror, view: 'Catalog source index' } },
      { key: 'mirror-ledger', value: { ...mirror, view: 'Catalog provenance ledger' } },
      { key: 'persistence-receipt', value: { ...persistence, view: 'Saved-note receipt trail' } },
      { key: 'persistence-journal', value: { ...persistence, view: 'Saved-note journal trail' } },
      ...['amber', 'teal', 'violet'].map((variant, variantIndex) => ({ key: `continuation-${variant}`, value: {
        sourceId, variant, catalogSeries: `Lantern ${variant}`, requiredComparison: ['effectiveAt', 'previousDigest', 'publishedAt'][variantIndex],
        instruction: 'This is a variant clue inside this world. Only the trusted operator can provision a separate world.' } })),
    ],
    templates: [], bounds: { ...RUNTIME_MAXIMUMS },
    pitching: { schemaVersion: 'dungeonq.pitching/v1', policyVersion: 'pitching-policy/v1', seed, mode,
      permission: 'PREAPPROVED_FINITE_BRANCHES', maxTransitions: 4,
      initialKeys: ['welcome', 'catalog-current', 'catalog-prior'],
      nodes: [
        { id: 'version-history', rule: 'VERSION_READ_ORDER', revealKeys: ['history-chronology', 'history-delta'] },
        { id: 'transport-mirror', rule: 'INTERFACE_ORDER', revealKeys: ['mirror-index', 'mirror-ledger'] },
        { id: 'persistence', rule: 'NOTE_READBACK_FAMILY', revealKeys: ['persistence-receipt', 'persistence-journal'] },
        { id: 'continuation', rule: 'SEED_VARIANT', revealKeys: ['continuation-amber', 'continuation-teal', 'continuation-violet'] },
      ],
      groundTruth: { schemaVersion: 'dungeonq.pitching-truth/v1', proposition: 'The displayed current revision is already effective at the scenario time.',
        currentValue, effectiveValue, sourceId },
    },
  };
  // Returning the original object shape is part of the baseline journal contract.
  if (pitchingVariant === 'baseline') return pack;
  pack.id = `pitching-${pitchingVariant}-${seed}-${mode}`;
  Object.assign(pack.pitching, { schemaVersion: 'dungeonq.pitching/v2',
    policyVersion: `pitching-policy/${pitchingVariant}`, variant: pitchingVariant });
  if (pitchingVariant === 'clues-v2') {
    const priorDigest = worldDigest(prior); const currentDigest = worldDigest(current);
    const asOf = '2026-01-05T00:00:00Z';
    const set = (key, value) => { pack.records.find(record => record.key === key).value = value; };
    set('history-chronology', { sourceId, asOf, evidenceKind: 'PUBLICATION_CHAIN',
      applicability: { entity: 'Lantern catalog', establishes: 'publication order and predecessor integrity', doesNotEstablish: 'effective capacity by publication time alone' },
      publications: [
        { key: 'catalog-prior', version: 1, publishedAt: prior.publishedAt, digest: priorDigest },
        { key: 'catalog-current', version: 2, publishedAt: current.publishedAt, digest: currentDigest, previousDigest: priorDigest },
      ],
      check: 'Compare catalog-current.previousDigest with the digest of catalog-prior; evaluate effectiveAt separately for the original asOf question.',
      next: history.next });
    set('history-delta', { sourceId, asOf, evidenceKind: 'EFFECTIVE_WINDOW_SCHEDULE',
      applicability: { entity: 'Lantern catalog', establishes: 'capacity within half-open effective windows', doesNotEstablish: 'independent source corroboration' },
      windows: [
        { key: 'catalog-prior', version: 1, fromInclusive: prior.effectiveAt, untilExclusive: current.effectiveAt, capacity: effectiveValue, digest: priorDigest },
        { key: 'catalog-current', version: 2, fromInclusive: current.effectiveAt, untilExclusive: null, capacity: currentValue, digest: currentDigest },
      ], effectiveVersion: 1, effectiveCapacity: effectiveValue,
      check: 'The fixed asOf falls in the first window. Publication and effective time have different meanings.', next: history.next });
    set('mirror-index', { sourceId, asOf, evidenceKind: 'SOURCE_LINEAGE',
      canonical: { key: 'catalog-current', version: 2, contentDigest: currentDigest },
      lineage: [
        { presentation: 'HTTP record', derivesFrom: sourceId, revision: 2, contentDigest: currentDigest },
        { presentation: 'MCP record', derivesFrom: sourceId, revision: 2, contentDigest: currentDigest },
      ],
      independence: 'Both interfaces project the same canonical source. Matching bytes do not establish an independent witness.',
      applicability: 'Compare sourceId, revision and digest; this lineage does not determine effective capacity.', next: mirror.next });
    set('mirror-ledger', { sourceId, asOf, evidenceKind: 'CACHE_REVISION_LEDGER',
      cacheEntry: { sourceKey: 'catalog-prior', storedVersion: 1, cachedAt: '2026-01-04T00:00:00Z', capacity: effectiveValue, contentDigest: priorDigest },
      canonicalEntry: { sourceKey: 'catalog-current', publishedVersion: 2, capacity: currentValue, contentDigest: currentDigest },
      lineage: { cacheSourceId: sourceId, canonicalSourceId: sourceId, independent: false },
      independence: 'The cache and current record share one source. A stale stored revision is not independent corroboration.',
      applicability: 'This historical cache fixture explains the numeric difference; cache recency alone cannot prove the effective capacity at asOf.',
      next: mirror.next });
    const continuation = {
      amber: { checkKind: 'EFFECTIVE_WINDOW', applicability: { sourceId, asOf, fromInclusive: prior.effectiveAt, untilExclusive: current.effectiveAt },
        expected: { effectiveVersion: 1, effectiveCapacity: effectiveValue },
        compare: 'Verify catalog-prior.effectiveAt <= asOf < catalog-current.effectiveAt. This is the original catalog question.' },
      teal: { checkKind: 'PREDECESSOR_LINK', applicability: { sourceId, predecessorVersion: 1, successorVersion: 2 },
        expected: { predecessorDigest: priorDigest, successorDigest: currentDigest, successorPreviousDigest: priorDigest },
        compare: 'Check catalog-current.previousDigest against catalog-prior. A valid chain does not make version 2 effective at asOf.' },
      violet: { checkKind: 'PUBLICATION_CUTOFF', applicability: { sourceId, publishedBy: asOf },
        expected: { publishedVersions: [1, 2], publicationTimes: [prior.publishedAt, current.publishedAt] },
        compare: 'Both versions were published by asOf; publication alone does not select the effective version.' },
    };
    for (const [variant, evidence] of Object.entries(continuation)) set(`continuation-${variant}`, {
      sourceId, variant, catalogSeries: `Lantern ${color}`, evidenceKeys: ['catalog-prior', 'catalog-current'], ...evidence,
      instruction: 'This checklist stays within the original synthetic catalog question. You may stop. Only the trusted operator can provision a separate world.',
    });
  }
  if (disclosure) pack.pitching.scope = 'SYNTHETIC_ONLY';
  if (isRealityVariant(pitchingVariant)) { applyRealityFixture(pack); return pack; }
  if (isEvidenceVariant(pitchingVariant)) { applyEvidenceFixture(pack); return pack; }
  if (['inquiry-control-v3', 'inquiry-cue-v3'].includes(pitchingVariant) || disclosure) applyInquiryFixture(pack);
  if (isGuidanceVariant(pitchingVariant)) applyGuidanceFixture(pack);
  return pack;
}

export const isPitchingV2 = pack => pack?.pitching?.schemaVersion === 'dungeonq.pitching/v2';

export function createPitchingProgress(pack, at) {
  check(Number.isSafeInteger(at + pack.bounds.maxPolicyTtlMs), 'CLOCK_INVALID');
  return { schemaVersion: isPitchingV2(pack) ? 'dungeonq.pitching-progress/v2' : 'dungeonq.pitching-progress/v1', policyVersion: pack.pitching.policyVersion,
    seed: pack.pitching.seed, mode: pack.pitching.mode, policyDigest: worldDigest(pack.pitching),
    blueprintDigest: worldDigest(pack), expiresAt: at + pack.bounds.maxPolicyTtlMs,
    visibleKeys: clone(pack.pitching.initialKeys), decisions: [], ...(isPitchingV2(pack) ? { pending: null } : {}) };
}

export function pitchingRecordVisible(context, key) {
  return key.startsWith('note-') || context.pitching.visibleKeys.includes(key);
}

/** Observations are canonical facts, not claims parsed from note values. */
export function pitchingObservation(input, result, pack) {
  return { family: input.family, ...(result.key ? { key: result.key, recordRevision: result.recordRevision,
    valueDigest: worldDigest(result.value) } : {}), ...(isPitchingV2(pack) ? { exposures: pitchingExposures(input, result) } : {}) };
}

/** The bytes supplied by snapshot/read, without inferring attention or understanding. */
export function pitchingExposures(input, result) {
  const records = input.operation === 'snapshot' ? result.records
    : input.operation === 'read' ? [{ key: result.key, value: result.value, revision: result.recordRevision }] : [];
  return records.map(record => ({ key: record.key, recordRevision: record.revision, valueDigest: worldDigest(record.value) }));
}

/** Called only inside the store's journal transaction after a valid ticket has been checked. */
export function advancePitching({ pack, context, world, observations, input, at, sequence }) {
  const policy = pack.pitching; const progress = context.pitching;
  check(policy.permission === 'PREAPPROVED_FINITE_BRANCHES' && progress.policyDigest === worldDigest(policy), 'PITCHING_POLICY_REQUIRED');
  const step = progress.decisions.length;
  if (step >= policy.nodes.length) return null;
  const facts = observations.filter(item => item.contextId === context.contextId && item.epoch === context.epoch);
  const reads = facts.filter(item => item.operation === 'read');
  const key = input.args.key ?? 'welcome'; const node = policy.nodes[step];
  let basis; let choice = 0;
  if (step === 0) {
    const current = reads.find(item => item.key === 'catalog-current');
    const prior = reads.find(item => item.key === 'catalog-prior');
    if (key !== 'catalog-current' || !current || !prior) return null;
    basis = [current, prior]; choice = facts.indexOf(current) < facts.indexOf(prior) ? 1 : 0;
  } else if (step === 1) {
    const first = reads.find(item => item.key === 'catalog-current');
    const second = reads.find(item => item.key === 'catalog-current' && item.family !== first?.family
      && item.recordRevision === first.recordRevision && item.valueDigest === first.valueDigest);
    if (key !== progress.decisions[0].revealKey || !second) return null;
    basis = [first, second]; choice = first.family === 'http' ? 1 : 0;
  } else if (step === 2) {
    if (!key.startsWith('note-')) return null;
    const record = world.records.find(item => item.key === key);
    const saved = facts.findLast(item => item.operation === 'write' && item.key === key && item.recordRevision === record?.revision);
    const readback = reads.findLast(item => item.key === key && item.recordRevision === saved?.recordRevision
      && item.valueDigest === saved?.valueDigest && facts.indexOf(item) > facts.indexOf(saved));
    if (!saved || !readback) return null;
    basis = [saved, readback]; choice = saved.family === readback.family ? 0 : 1;
  } else {
    const readback = reads.find(item => item.key === progress.decisions[2].revealKey);
    if (key !== progress.decisions[2].revealKey || !readback) return null;
    basis = [readback]; choice = PITCHING_SEEDS.indexOf(policy.seed);
  }
  check(at < progress.expiresAt, 'PITCHING_POLICY_EXPIRED');
  check(step < policy.maxTransitions, 'PITCHING_BUDGET_EXHAUSTED');
  if (policy.mode === 'fixed') choice = 0;
  const revealKey = node.revealKeys[choice];
  check(!progress.visibleKeys.includes(revealKey), 'PITCHING_PROFILE_INVALID');
  const decision = { decisionId: `pitch-${sequence}`, transitionKey: `${context.contextId}:${context.epoch}:${node.id}`,
    nodeId: node.id, rule: node.rule, revealKey, choice, seed: policy.seed, policyVersion: policy.policyVersion,
    policyDigest: progress.policyDigest, blueprintDigest: progress.blueprintDigest,
    contextId: context.contextId, tenantId: context.tenantId, worldId: context.worldId, epoch: context.epoch,
    requestId: input.requestId, observationIds: basis.map(item => item.observationId), sequence, at,
    budgetBefore: policy.maxTransitions - step, budgetAfter: policy.maxTransitions - step - 1 };
  progress.decisions.push(decision); progress.visibleKeys.push(revealKey); world.revision++;
  return { key: revealKey, value: clone(world.records.find(item => item.key === revealKey).value) };
}

function v2Evidence({ pack, context, world, observations }, requestedKey) {
  const progress = context.pitching; const step = progress.decisions.length;
  const facts = observations.filter(item => item.contextId === context.contextId && item.epoch === context.epoch);
  const exposures = facts.flatMap((fact, position) => (fact.exposures ?? []).map(value => ({ ...value,
    observationId: fact.observationId, family: fact.family, operation: fact.operation, position })));
  const matching = key => {
    const record = world.records.find(item => item.key === key);
    return exposures.filter(item => item.key === key && item.recordRevision === record?.revision && item.valueDigest === worldDigest(record.value));
  };
  const action = (operation, key, reason, family) => ({ operation, ...(key ? { key } : {}), reason, ...(family ? { family } : {}) });
  let key; let basis = []; let choice = 0; let nextAction;
  if (step === 0) {
    key = 'catalog-current';
    const current = matching(key)[0]; const prior = matching('catalog-prior')[0];
    if (!current || !prior) nextAction = action('read', !current ? key : 'catalog-prior', 'VERSION_EXPOSURE_REQUIRED');
    else {
      basis = [current, prior];
      // A snapshot has no meaningful within-response reading order.
      choice = current.operation === 'read' && prior.operation === 'read' && current.position < prior.position ? 1 : 0;
    }
  } else if (step === 1) {
    key = progress.decisions[0].revealKey;
    const first = matching('catalog-current')[0];
    const second = matching('catalog-current').find(item => item.family !== first?.family);
    if (!second) nextAction = action('read', 'catalog-current', 'SECOND_INTERFACE_EXPOSURE_REQUIRED', first?.family === 'mcp' ? 'http' : 'mcp');
    else { basis = [first, second]; choice = first.family === 'http' ? 1 : 0; }
  } else if (step >= 2 && isRealityVariant(pack.pitching.variant)) {
    key = progress.decisions[step - 1].revealKey;
    const exposure = matching(key)[0];
    if (!exposure) nextAction = action('read', key, step === 2 ? 'RECOVERY_EVIDENCE_REQUIRED' : 'ARCHIVE_EVIDENCE_REQUIRED');
    else basis = [exposure];
  } else if (step === 2 && isEvidenceVariant(pack.pitching.variant)) {
    key = progress.decisions[1].revealKey;
    const mirror = matching(key)[0];
    if (!mirror) nextAction = action('read', key, 'MIRROR_EVIDENCE_REQUIRED');
    else basis = [mirror];
  } else if (step === 2) {
    const saved = facts.findLast(item => item.operation === 'write' && item.key.startsWith('note-')
      && (!requestedKey || item.key === requestedKey) && world.records.some(record => record.key === item.key && record.revision === item.recordRevision));
    key = requestedKey ?? saved?.key;
    if (!saved) nextAction = action('write', 'note-review', 'COMMITTED_NOTE_REQUIRED');
    else {
      const readback = matching(saved.key).find(item => item.position > facts.indexOf(saved));
      if (!readback) nextAction = action('read', saved.key, 'CURRENT_NOTE_READBACK_REQUIRED');
      else { basis = [saved, readback]; choice = saved.family === readback.family ? 0 : 1; }
    }
  } else if (step === 3) {
    key = progress.decisions[2].revealKey; const readback = matching(key)[0];
    if (!readback) nextAction = action('read', key, 'PERSISTENCE_EXPOSURE_REQUIRED');
    else basis = [readback];
  }
  return { key, basis, choice, nextAction: nextAction ?? action('issue-ticket', key, 'SCOPED_TICKET_REQUIRED'), ready: basis.length > 0 };
}

function pendingState({ pack, context, world, tickets, at }) {
  const pending = context.pitching.pending;
  if (!pending) return { valid: false };
  const ticket = tickets.find(item => item.body.ticketId === pending.ticketId);
  const record = world.records.find(item => item.key === pending.key);
  if (at >= pending.expiresAt) return { valid: false, reason: 'PENDING_TICKET_EXPIRED' };
  if (!ticket || ticket.uses < 1 || ticket.body.contextId !== context.contextId || ticket.body.tenantId !== context.tenantId
    || ticket.body.worldId !== context.worldId || ticket.body.epoch !== context.epoch || !ticket.body.scope.includes(pending.key)
    || ticket.body.expiresAt !== pending.expiresAt || pending.contextId !== context.contextId || pending.epoch !== context.epoch
    || pending.nodeId !== pack.pitching.nodes[context.pitching.decisions.length]?.id) return { valid: false, reason: 'PENDING_AUTHORITY_INVALID' };
  if (!record || record.revision !== pending.recordRevision || worldDigest(record.value) !== pending.valueDigest)
    return { valid: false, reason: 'PENDING_RECORD_CHANGED' };
  return { valid: true };
}

/** Safe projection: current visible actions only, no rule IDs, policy, choices or unopened keys. */
export function pitchingProgressView(options, { advanced = false, reason } = {}) {
  const { pack, context, input, at } = options; const progress = context.pitching;
  const completed = progress.decisions.length;
  const v6 = isEvidenceVariant(pack.pitching.variant);
  const v7 = isRealityVariant(pack.pitching.variant);
  const view = { schemaVersion: v7 ? 'dungeonq.pitching-view/v4' : v6 ? 'dungeonq.pitching-view/v3' : 'dungeonq.pitching-view/v2', completed, total: v6 || v7 ? pack.pitching.nodes.length : 4 };
  if (v7) { view.conclusion = realityConclusion(options); view.canStop = true; }
  if (v6) {
    // Project only already-visible evidence, never operator truth or an unopened notice.
    const mirrorKey = progress.decisions[1]?.revealKey;
    const mirror = mirrorKey ? options.world.records.find(row => row.key === mirrorKey)?.value : undefined;
    view.conclusion = !mirror ? 'UNRESOLVED' : mirror.scopeAttachment.status === 'MISSING' ? 'UNKNOWN'
      : mirror.revocationIndex.entries.length > 0 && completed < view.total ? 'UNRESOLVED' : 'SUPPORTED';
    view.canStop = true;
  }
  if (completed === view.total) return { ...view, status: 'COMPLETE', nextAction: { operation: 'stop',
    reason: v6 || v7 ? view.conclusion === 'UNKNOWN' ? 'EVIDENCE_UNAVAILABLE' : 'EVIDENCE_SUFFICIENT' : 'TRAIL_COMPLETE' } };
  if (at >= progress.expiresAt || completed >= pack.pitching.maxTransitions) return { ...view, status: 'UNAVAILABLE',
    nextAction: { operation: 'stop', reason: at >= progress.expiresAt ? 'POLICY_EXPIRED' : 'PROGRESS_LIMIT_REACHED' } };
  const pending = pendingState(options);
  const evidence = v2Evidence(options, pending.valid ? progress.pending.key : undefined);
  let nextAction = evidence.nextAction;
  if (evidence.ready && pending.valid) nextAction = { operation: 'snapshot', reason: 'RESUME_PENDING' };
  else if (evidence.ready && input.operation === 'issue-ticket' && (input.args.scope ?? ['welcome']).includes(evidence.key))
    nextAction = { operation: 'use-ticket', key: evidence.key, reason: 'USE_ISSUED_TICKET' };
  return { ...view, status: advanced ? 'ADVANCED' : pending.valid ? 'PENDING' : 'AVAILABLE', nextAction,
    ...((reason ?? pending.reason) ? { notice: reason ?? pending.reason } : {}) };
}

/** One transition at a safe point; deferred authorization remains bounded by its original ticket. */
export function advancePitchingV2(options) {
  const { pack, context, world, observations, input, at, sequence, usedTicket } = options;
  const policy = pack.pitching; const progress = context.pitching;
  check(policy.permission === 'PREAPPROVED_FINITE_BRANCHES' && progress.policyDigest === worldDigest(policy)
    && progress.blueprintDigest === worldDigest(pack), 'PITCHING_POLICY_REQUIRED');
  const safePoint = ['snapshot', 'read', 'use-ticket'].includes(input.operation);
  let reason; let revealed;
  if (safePoint && progress.pending && !pendingState(options).valid) {
    reason = pendingState(options).reason; progress.pending = null;
  }
  const step = progress.decisions.length;
  if (safePoint && step < policy.nodes.length) {
    if (input.operation === 'use-ticket') {
      check(at < progress.expiresAt, 'PITCHING_POLICY_EXPIRED');
      check(step < policy.maxTransitions, 'PITCHING_BUDGET_EXHAUSTED');
      const key = input.args.key ?? 'welcome'; const candidate = v2Evidence(options, step === 2 ? key : undefined);
      if (key === candidate.key && (step !== 2 || isEvidenceVariant(policy.variant) || isRealityVariant(policy.variant) || key.startsWith('note-'))) {
        if (!progress.pending) {
          const record = world.records.find(item => item.key === key);
          progress.pending = { ticketId: usedTicket.body.ticketId, contextId: context.contextId, epoch: context.epoch,
            nodeId: policy.nodes[step].id, key, recordRevision: record.revision, valueDigest: worldDigest(record.value),
            requestId: input.requestId, observationId: `obs-${sequence}`, expiresAt: usedTicket.body.expiresAt };
        }
      } else reason = 'TICKET_KEY_NOT_CURRENT_STEP';
    }
    if (progress.pending && at < progress.expiresAt && step < policy.maxTransitions && pendingState(options).valid) {
      const evidence = v2Evidence(options, progress.pending.key);
      if (evidence.ready) {
        const node = policy.nodes[step]; const pending = progress.pending;
        const choice = policy.mode === 'fixed' ? 0 : node.rule === 'SEED_VARIANT' ? PITCHING_SEEDS.indexOf(policy.seed) : evidence.choice;
        const revealKey = node.revealKeys[choice];
        check(!progress.visibleKeys.includes(revealKey), 'PITCHING_PROFILE_INVALID');
        const decision = { decisionId: `pitch-${sequence}`, transitionKey: `${context.contextId}:${context.epoch}:${node.id}`,
          nodeId: node.id, rule: node.rule, revealKey, choice, seed: policy.seed, policyVersion: policy.policyVersion,
          policyDigest: progress.policyDigest, blueprintDigest: progress.blueprintDigest,
          contextId: context.contextId, tenantId: context.tenantId, worldId: context.worldId, epoch: context.epoch,
          requestId: input.requestId, authorizationRequestId: pending.requestId, authorizationObservationId: pending.observationId,
          observationIds: [...new Set(evidence.basis.map(item => item.observationId))], sequence, at,
          budgetBefore: policy.maxTransitions - step, budgetAfter: policy.maxTransitions - step - 1 };
        progress.decisions.push(decision); progress.visibleKeys.push(revealKey); progress.pending = null; world.revision++;
        revealed = { key: revealKey, value: clone(world.records.find(item => item.key === revealKey).value) };
      }
    }
  }
  return { ...(revealed ? { revealed } : {}), progress: pitchingProgressView(options, { advanced: Boolean(revealed), reason }) };
}
