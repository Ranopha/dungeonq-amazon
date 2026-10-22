// M9 Colima 來源事件 → 既有 M7。控制 RPC 由可信主機注入，參與者不可選取。
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { authorizeDungeonqResponseAction } from '../../packages/policy/src/dungeonq-response-action.ts';
import { openDungeonqResponseConnector } from '../../plugins/dungeonq-host-integration/src/response-actions.ts';
import { createM1SealerPort, normalizeCloseInput, openIncidentClose } from './incident-close.mjs';
import { generateSealKey, git } from './evidence-sealer.mjs';
import { createIncidentWiring } from './incident-wiring.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const ok = result => { assert.equal(result.status, 200, 'CLOSE_SOURCE_UNKNOWN'); return result.body; };

export function createSourceCloseLauncher({ directory, alert, gateway, source, participant, probeTicket, copyJournal,
  health, legitimate, sender, handoffStatus, events, emit, observationMs = 5000 }) {
  let attempt;
  const inputFor = value => {
    assert(value.incidentId === alert.incidentId && value.request.kind === 'START_CLOSE', 'CLOSE_SCOPE_DENIED');
    const { request, acknowledgement } = value;
    const rotationDecisionAt = events.find(row => row.kind === 'HUMAN_ROTATE_DECISION')?.detail.submittedAt;
    const normalized = normalizeCloseInput({ incidentId: alert.incidentId, contexts: ['diverted'], verdict: request.close.verdict, severity: request.close.severity,
      identityConfirmed: request.close.identityConfirmed, isolation: 'CONTAINER_ISOLATED', closureReason: 'HUMAN',
      rootCause: Object.fromEntries(Object.entries(request.close.rootCause ?? {}).map(([key, row]) => [key, { ...row, owner: request.close.owner }])),
      followUps: [], ...(Number.isFinite(rotationDecisionAt) ? { humanDecisionAt: new Date(rotationDecisionAt).toISOString() } : {}),
      acknowledgement: { at: new Date(acknowledgement.at).toISOString(), verified: true },
      notification: { contact: 'DungeonQ 值班管理員', directory: { legitimateConsumers: [{ recipientId: 'owner', consumerId: 'scoped-source-consumer' }],
        flaggedSubjectOwners: [{ recipientId: 'owner', subject: 'context:diverted' }] } } });
    delete normalized.schemaVersion;
    return normalized;
  };
  const launch = value => {
    assert(!attempt, 'CLOSE_ALREADY_ATTEMPTED');
    const input = inputFor(value);
    attempt = run(input); return attempt;
  };
  launch.validate = inputFor;
  return launch;

  async function run(input) {
    const { incidentId } = input;
    const caseDirectory = join(directory, 'incident-close');
    const sealDir = join(directory, 'sealer'), anchorRepo = join(directory, 'anchor'), dbDirectory = join(directory, 'journal-export');
    for (const path of [caseDirectory, dbDirectory, anchorRepo]) mkdirSync(path, { mode: 0o700 });
    const { publicKeyPath } = generateSealKey(sealDir);
    await git(anchorRepo, ['init', '-b', 'main']);
    await git(anchorRepo, ['config', 'user.name', 'DungeonQ evidence sealer']);
    await git(anchorRepo, ['config', 'user.email', 'sealer@localhost']);
    const db = join(dbDirectory, 'runtime.sqlite');
    const registry = { registryId: 'scoped-source-lab', registryVersion: '2', entries: [
      { targetId: 'source-credential', kind: 'CREDENTIAL', assetId: 'credential:scoped-source', boundIncidentId: null },
      { targetId: 'diverted-context', kind: 'FLAGGED_CONTEXT', assetId: 'context:diverted', boundIncidentId: incidentId }
    ] };
    const fence = {
      readState: () => gateway({ action: 'state' }),
      apply: ({ actionId }, expected) => gateway({ action: 'fence', actionId, expectedEpoch: expected.epoch }),
      lookup: ({ actionId }) => gateway({ action: 'lookup', actionId }),
      verifyEffect: async ({ actionId }) => ({ confirmed: (await gateway({ action: 'lookup', actionId }))?.state === 'FENCED', detail: 'EXACT_FENCE_ACTION_READBACK' }),
      rollback: null
    };
    const connector = openDungeonqResponseConnector({ directory: join(directory, 'response-ledger'), registry: () => registry,
      executors: { 'A-1': fence }, health, observationMs, executorTimeoutMs: 20000, escalate: async detail => emit('CLOSE_ESCALATION', detail) });
    const scopedConnector = { ...connector, execute: bundle => {
      assert(bundle.request.incidentId === incidentId && bundle.request.targetId === 'diverted-context', 'CLOSE_EXECUTION_SCOPE_DENIED');
      const authorization = authorizeDungeonqResponseAction({ decision: bundle.decision, input: bundle.input,
        request: bundle.request, purpose: 'EXECUTE_A_CLASS' });
      assert(authorization.authorized, 'CLOSE_POLICY_DENIED');
      emit('CLOSE_POLICY_AUTHORIZATION', { incidentId, targetId: bundle.request.targetId, authorized: authorization.authorized });
      return connector.execute(bundle);
    } };
    const wiring = createIncidentWiring({ caseDirectory, sender, prefix: 'DRILL' });
    let frozen = false;
    const probeContext = async () => {
      const response = await participant({ action: 'workspace', operation: 'snapshot' });
      return { denied: response.status === 403 && response.body?.error?.code === 'CONTEXT_FENCED', code: response.body?.error?.code ?? 'UNKNOWN' };
    };
    const inventory = async () => {
      const snapshot = await gateway({ action: 'inventory' });
      const context = snapshot.contexts.find(row => row.contextId === 'diverted');
      assert(context, 'CLOSE_CONTEXT_MISSING');
      const revoked = context.state === 'FENCED';
      const current = ok(await source({ action: 'status' }));
      return { items: [
        { itemId: 'context:diverted', kind: 'WORLD_CONTEXT', contextId: 'diverted', epoch: context.epoch, state: revoked ? 'REVOKED' : 'ACTIVE' },
        { itemId: 'tickets:diverted', kind: 'WRONG_TICKET_SET', contextId: 'diverted', epoch: 1, state: revoked && context.epoch > 1 ? 'REVOKED' : 'ACTIVE' },
        ...snapshot.policies.filter(row => row.contextId === 'diverted').map(row => ({ itemId: `grant:${row.policyId}`, kind: 'WORKER_GRANT',
          contextId: 'diverted', epoch: row.epoch, state: revoked && context.epoch > row.epoch ? 'REVOKED' : 'ACTIVE' })),
        { itemId: 'source:previous', kind: 'ORIGIN_PREVIOUS_CREDENTIAL', epoch: 1, state: current.epoch > 1 ? 'REVOKED' : 'ACTIVE' }
      ] };
    };
    try {
      const closer = openIncidentClose({ directory: caseDirectory, input, limits: wiring.closeLimits, ports: {
        response: { connector: scopedConnector, registry: () => registry, health, signal: { kind: 'REAL_ASSET_REQUESTED', eventId: alert.eventId } },
        legitimate,
        world: {
          freeze: async () => {
            const state = await gateway({ action: 'state' });
            frozen = state.state === 'FENCED' && state.epoch > 1 && (await probeContext()).denied;
            return { frozen };
          },
          readFreeze: async () => { const position = await gateway({ action: 'position' });
            return { frozen: frozen && position.state === 'FENCED', journalSequence: position.journalSequence, journalHead: position.journalHead }; }
        },
        evidence: { collect: async () => {
          const evidence = await gateway({ action: 'evidence' });
          assert.equal(evidence.canonical?.verifier?.status, 'VERIFIED', 'CLOSE_CANONICAL_UNVERIFIED');
          const exported = await gateway({ action: 'export' });
          await copyJournal(db);
          assert.equal(hash(readFileSync(db)), exported.sha256, 'CLOSE_JOURNAL_COPY_MISMATCH');
          const witness = ok(await source({ action: 'witness' }));
          const snapshot = await gateway({ action: 'inventory' });
          const handoff = handoffStatus();
          const acceptedAt = handoff.incidents.find(row => row.incidentId === incidentId)?.measurements?.providerAcceptedAt;
          const outbox = Number.isFinite(acceptedAt) ? [{ acceptedAt, incidentId }] : [];
          emit('CLOSE_JOURNAL_EXPORTED', exported);
          return { artifacts: [
            { name: 'runtime-journal', data: evidence.canonical },
            { name: 'outbox', data: { incidents: [{ incidentId, contextId: 'diverted' }], outbox, handoff } },
            { name: 'origin-witness', data: witness },
            { name: 'ticket-uses', data: { tracking: false, uses: [], reason: 'CONTAINER_TICKET_LEDGER_NOT_CONFIGURED',
              observedOperations: evidence.canonical.events.filter(row => row.operation === 'use-ticket') } },
            { name: 'legit-health', data: await legitimate.report() },
            { name: 'response-ledger', data: { status: connector.incidentStatus(incidentId), audit: connector.listAudit({ incidentId }) } },
            { name: 'agent-tool-log', data: { mode: 'SCRIPT_CLIENT', processPrefixRows: events.length,
              processPrefixSha256: hash(events.map(row => JSON.stringify(row) + '\n').join('')),
              records: events.filter(row => row.detail?.role === 'participant' || ['SCRIPTED_SELF_STOP', 'PARTICIPANT_ENTERED'].includes(row.kind))
                .map(row => ({ seq: row.seq, at: row.at, kind: row.kind, action: row.detail.action ?? null,
                  operation: row.detail.operation ?? null, status: row.detail.value?.status ?? null })) } },
            { name: 'ticket-ledger', data: { tracking: false, tickets: [], updates: [], snapshotContexts: snapshot.contexts.map(row => ({ contextId: row.contextId, state: row.state, epoch: row.epoch })) } }
          ], facts: { realAssetReads: witness.events.filter(row => row.kind === 'TARGET_ALLOWED' && row.requestId.startsWith('participant-')).length } };
        } },
        revocation: { inventory, revoke: async () => { throw Error('CLOSE_UNEXPECTED_ACTIVE_RIGHT'); },
          probe: async ({ item }) => {
            if (item.kind === 'WRONG_TICKET_SET') { const result = await probeTicket();
              return { denied: result.status === 403 && result.body?.error?.code === 'CONTEXT_FENCED', code: result.body?.error?.code ?? 'UNKNOWN' }; }
            if (item.kind !== 'ORIGIN_PREVIOUS_CREDENTIAL') return probeContext();
            const results = await source({ action: 'probe', credential: 'old' });
            return { denied: results.length === 4 && results.every(row => row.status === 403), code: 'FOUR_SOURCE_PATHS' };
          } },
        sealer: createM1SealerPort({ db, sealDir, anchorRepo, publicKeyPath }), notifier: wiring.notifier
      } });
      const result = await closer.run();
      emit('HUMAN_CLOSE_RESULT', { ...result, caseDirectory, evidenceTrust: 'LOCAL_ANCHOR' });
      return result;
    } finally { connector.close(); }
  }
}
