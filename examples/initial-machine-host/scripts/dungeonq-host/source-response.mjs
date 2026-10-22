import { createHash } from 'node:crypto';
import { openSync, closeSync, fsyncSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUNGEONQ_RESPONSE_ACTION_POLICY_VERSION, DUNGEONQ_RESPONSE_ACTION_CATALOG, evaluateDungeonqResponseAction } from '../../packages/policy/src/dungeonq-response-action.ts';
import { openDungeonqResponseConnector } from '../../plugins/dungeonq-host-integration/src/response-actions.ts';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requireOk = value => { if (value.status !== 200) throw Object.assign(Error('SOURCE_CONTROL_UNKNOWN'), { code: 'SOURCE_CONTROL_UNKNOWN' }); return value.body; };
// 可信主機持有 RPC；此介面不暴露給 participant，也不能選任意 URL／程式。
export function sourceAlertIdentity(witness) {
  const denial = witness.events.find(row => row.kind === 'TARGET_DENIED' && row.requestId.startsWith('participant-'));
  if (!denial) throw Error('SOURCE_ALERT_MISSING');
  const incidentId = `incident-${hash({ head: witness.head, seq: denial.seq })}`;
  return { denial, incidentId };
}
export function persistSourceAlert({ directory, witness, emit }) {
  const { denial, incidentId } = sourceAlertIdentity(witness);
  const alert = { schemaVersion: 'dungeonq.source-alert/v1', incidentId, eventId: `source-${denial.seq}`, observedAt: denial.at,
    receivedAt: Date.now(), sourceHead: witness.head, scope: { tenantId: witness.tenantId, resource: witness.resource },
    delivery: 'LOCAL_INBOX', externalDelivery: 'UNKNOWN', humanAck: 'UNKNOWN' };
  const path = join(directory, 'alert.json');
  writeFileSync(path, JSON.stringify(alert, null, 2), { flag: 'wx', mode: 0o600 });
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  if (hash(JSON.parse(readFileSync(path, 'utf8'))) !== hash(alert)) throw Error('ALERT_READBACK_FAILED');
  emit('ALERT_RECEIVED', alert);
  return alert;
}
export async function respondToSourceAlert({ directory, witness, rpc, health, emit, observationMs = 5000, existingAlert, beforeExecute }) {
  const { denial, incidentId } = sourceAlertIdentity(witness);
  const alert = existingAlert ?? persistSourceAlert({ directory, witness, emit });
  if (alert.incidentId !== incidentId || alert.sourceHead !== witness.head || alert.eventId !== `source-${denial.seq}`
    || hash(alert) !== hash(JSON.parse(readFileSync(join(directory, 'alert.json'), 'utf8')))) throw Error('SOURCE_ALERT_MISMATCH');
  const action = DUNGEONQ_RESPONSE_ACTION_CATALOG.actions.find(entry => entry.name === 'ROTATE_CREDENTIAL_WITH_OVERLAP');
  if (!action || action.fixedParameters.overlapSeconds !== 300) throw Error('SOURCE_POLICY_VERSION_UNSUPPORTED');
  const registry = { registryId: 'scoped-source-lab', registryVersion: '1', entries: [
    { targetId: 'source-credential', kind: 'CREDENTIAL', assetId: 'credential:scoped-source', boundIncidentId: null }
  ] };
  const verify = async () => {
    const old = await rpc({ action: 'probe', credential: 'old' });
    const current = await rpc({ action: 'probe', credential: 'current' });
    return { confirmed: old.every(row => row.status === 403) && current.every(row => row.status === 200), detail: 'ALL_SOURCE_PATHS_READBACK' };
  };
  let commitSentAt = null, commitReplyAt = null;
  const executor = {
    readState: async () => requireOk(await rpc({ action: 'status' })),
    apply: async ({ actionId }, expected) => {
      requireOk(await rpc({ action: 'prepare', actionId, expectedEpoch: expected.epoch }));
      const ready = await rpc({ action: 'probe', credential: 'next' });
      if (!ready.every(row => row.status === 200)) throw Error('SOURCE_CONSUMER_NOT_READY');
      emit('NEW_CREDENTIAL_READY', { actionId, paths: ready.map(row => row.channel) });
      commitSentAt = Date.now();
      const receipt = requireOk(await rpc({ action: 'commit', actionId }));
      commitReplyAt = Date.now();
      return receipt;
    },
    lookup: async ({ actionId }) => {
      const receipt = requireOk(await rpc({ action: 'lookup', actionId }));
      // PREPARED 不能當作已生效；若結果不明就保留 UNKNOWN，禁止重送。
      if (receipt && receipt.status !== 'EFFECTIVE') throw Error('SOURCE_ROTATION_NOT_PROVEN');
      return receipt;
    },
    verifyEffect: verify,
    rollback: null // 已撤銷能力不恢復；失敗保留封鎖並升級。
  };
  const connector = openDungeonqResponseConnector({ directory: join(directory, 'response-ledger'), registry: () => registry,
    executors: { [action.code]: executor }, health, observationMs, executorTimeoutMs: 15000,
    escalate: async escalation => emit('ESCALATION', escalation) });
  try {
    const evaluatedAt = new Date().toISOString();
    const input = { policyVersion: DUNGEONQ_RESPONSE_ACTION_POLICY_VERSION, traceId: `source-${denial.seq}`, evaluatedAt, incidentId,
      signal: { kind: 'REAL_ASSET_REQUESTED', eventId: alert.eventId }, actionCode: action.code, targetId: 'source-credential',
      parameters: { rateLimitDurationSeconds: null }, targetRegistry: registry, ...connector.policyInputState({ incidentId, evaluatedAt }),
      legitimateHealth: await health.measure({ sinceMs: Date.now() - 10000, signal: new AbortController().signal }) };
    const decision = evaluateDungeonqResponseAction(input); emit('POLICY_DECISION', { input, decision });
    // 真人接線可再核對 M3 決策與 Policy 授權；不能改寫政策或取代 M5 的再次驗證。
    if (beforeExecute) beforeExecute({ input, decision, request: { incidentId, actionCode: action.code, targetId: 'source-credential' } });
    const expectedState = await connector.readTargetState({ incidentId, actionCode: action.code, targetId: 'source-credential' });
    const result = await connector.execute({ decision, input, request: { incidentId, actionCode: action.code, targetId: 'source-credential' }, expectedState });
    const verifiedAt = Date.now();
    emit('RESPONSE_RESULT', result);
    const source = requireOk(await rpc({ action: 'witness' }));
    const effective = source.events.find(row => row.kind === 'ROTATE_EFFECTIVE');
    return { alert, result, source, audit: connector.listAudit({ incidentId }),
      timing: { alertToEffectiveMs: effective ? effective.effectiveAt - alert.receivedAt : null,
        firstDenialToEffectiveMs: effective ? effective.effectiveAt - denial.at : null,
        alertToEffectiveHostBoundsMs: effective && commitReplyAt !== null ? [commitSentAt - alert.receivedAt, commitReplyAt - alert.receivedAt] : null,
        alertToVerifiedMs: result.readback === 'CONFIRMED' ? verifiedAt - alert.receivedAt : null, humanResponseMs: null, extraTimeFromDungeonQ: null },
      humanResponse: 'UNKNOWN', aiEffect: 'NOT_RUN', paidCalls: 0 };
  } finally { connector.close(); }
}
