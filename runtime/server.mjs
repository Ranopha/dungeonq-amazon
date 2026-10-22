import { STUDY_FIXTURE, studyBlueprint } from './study-fixture.mjs';
import { executeOutcome, verifyRefusal } from './outcomes.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { participantControlResult, participantResult } from './participant-view.mjs';
import { openAuxiliary } from './auxiliary.mjs';
import { runtimeJson, runtimeHintLabel, runtimeTicketEntry } from './contracts.mjs';
import { openRuntimeStore, admissionAttemptDigest, admissionSourceClass, ADMISSION_OUTCOMES } from './store.mjs';
import { createPitchingBlueprint } from './pitching.mjs';
import { openPitchControl, ticketHandleDigest } from './pitch-control.mjs';
import { openPitchResponse } from './pitch-response.mjs';
import { openPitchOwnerLock } from './pitch-owner-lock.mjs';
import { openPitchHandoff } from './pitch-handoff.mjs';
import { startNetworkAdapters } from './network.mjs';
import { startRuntimeMcp } from './mcp.mjs';
import { startHostBroker } from './host.mjs';
import { bearer, body, digest, equalToken, exact, failure, headers, insist, privateJson, request, seal, send, serve, unseal } from './transport.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const operationNames = ['snapshot', 'read', 'write', 'issue-ticket', 'use-ticket'];
const CAP_DOMAIN = 'dungeonq.admitted-operation/v1';
const RESULT_DOMAIN = 'dungeonq.canonical-result/v1';

export async function startRuntimeGateway({ directory, credentials, facadeOrigin, facadeFactory, originOrigin, collectorOrigin,
  host = '127.0.0.1', port = 0, stateHost = '127.0.0.1', statePort = 0, mcpPort = 0,
  sshPort = 0, postgresPort = 0, network = true, hostBroker = true, presentation = 'diagnostic-v1',
  pitchingSeed = 17, pitchingMode = 'adaptive', pitchingVariant = 'baseline', pitchingLimits, alertSender, pitchOwnerLock, wrongTicketTracking,
  alertHandoff, studyFixture }) {
  insist(['diagnostic-v1', 'participant-v1', 'pitching-v1'].includes(presentation), 'PRESENTATION_INVALID');
  insist(alertSender === undefined || typeof alertSender === 'function', 'PITCH_DELIVERY_INVALID');
  insist(studyFixture === undefined || studyFixture === STUDY_FIXTURE && presentation === 'participant-v1', 'STUDY_FIXTURE_INVALID');
  const pitching = presentation === 'pitching-v1';
  // Opt-in wrong-ticket ledger (DQ-HANDOFF-015 M2). It needs the pitching control ledger and a fresh directory.
  insist(wrongTicketTracking === undefined || pitching, 'PITCH_TICKET_TRACKING_REQUIRES_PITCHING');
  // Opt-in alert handoff (DQ-HANDOFF-015 M3): own sender, durable escalation, verified ACK. Exclusive with a bare alertSender.
  insist(alertHandoff === undefined || pitching && alertSender === undefined && alertHandoff && typeof alertHandoff === 'object', 'PITCH_HANDOFF_INVALID');
  const participant = presentation !== 'diagnostic-v1';
  const blueprint = studyFixture ? studyBlueprint(studyFixture) : pitching ? createPitchingBlueprint({seed: pitchingSeed, mode: pitchingMode, pitchingVariant})
    : participant ? JSON.parse(readFileSync(new URL('./blueprints/participant.json', import.meta.url), 'utf8')) : undefined;
  const ownerLock = pitching ? pitchOwnerLock ?? openPitchOwnerLock({path:join(directory,'pitch-owner.sqlite')}) : undefined;
  let store;
  try { store = openRuntimeStore({ path: join(directory, 'runtime.sqlite'), ...(blueprint ? { blueprint } : {}) }); }
  catch(e) {ownerLock?.close();throw e;}
  let journal;
  try { journal = openAuxiliary(join(directory, 'gateway.sqlite'), 'CREATE TABLE IF NOT EXISTS gateway_meta(id INTEGER PRIMARY KEY,config TEXT NOT NULL,baseline TEXT); CREATE TABLE IF NOT EXISTS gateway_attempts(event_id TEXT PRIMARY KEY,payload TEXT NOT NULL,acknowledged INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS gateway_pending(event_id TEXT PRIMARY KEY,input_digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS gateway_previews(id TEXT PRIMARY KEY,body TEXT NOT NULL,digest TEXT NOT NULL,result TEXT);', 'gateway_meta'); } catch(e) { store.close(); ownerLock?.close(); throw e; }
  let control; let response; let handoff;
  try { if (pitching) {
    control = openPitchControl({path: join(directory, 'pitch-control.sqlite'), limits: pitchingLimits, ticketTracking: wrongTicketTracking});
    response = openPitchResponse({path: join(directory, 'pitch-response.sqlite')});
    control.recoverRelayClaims();
    if (control.ticketTracking) control.recoverTicketUpdateClaims();
    if (alertHandoff) handoff = openHandoff();
  } }
  catch(e) { await handoff?.close(); response?.close(); control?.close(); journal.close(); store.close(); ownerLock?.close(); throw e; }
  function openHandoff() {
    const { notifier, safeDefault, summary, inboxProbe, ackAccount, prefix, selfCheck, localConsole, limits, decision, ...rest } = alertHandoff;
    insist(Object.keys(rest).length === 0, 'PITCH_HANDOFF_INVALID');
    const opened = openPitchHandoff({ path: join(directory, 'pitch-handoff.sqlite'), notifier, safeDefault, summary, inboxProbe, ackAccount,
      prefix, selfCheck, localConsole, limits, decision,
      isClosed: incidentId => control.snapshot().incidents.find(row => row.incidentId === incidentId)?.resolution != null,
      ticketSummary: incidentId => ticketSummaryFor(incidentId),
      onAcknowledged: ack => {
        control.acknowledge({ incidentId: ack.incidentId, operatorId: ack.account });
        const incident = control.snapshot().incidents.find(row => row.incidentId === ack.incidentId);
        try { response.recordVerifiedAck(incident, { referenceId: ack.reference }); }
        catch (error) { if (error?.code !== 'PITCH_RESPONSE_EVENT_EXISTS') throw error; }
      } });
    // The entry alert races control's delivery timeout: both channels must fit before the claim is abandoned as UNKNOWN.
    const limit = opened.publicStatus().limits.channelTimeoutMs;
    try { insist(control.snapshot().limits.deliveryTimeoutMs >= 2 * limit + 1000, 'PITCH_HANDOFF_LIMITS_INVALID'); }
    catch (error) { void opened.close(); throw error; }
    return opened;
  }
  function ticketSummaryFor(incidentId) {
    if (!control.ticketTracking) return { tracking: false };
    const ledger = control.snapshot().ticketLedger;
    const row = ledger.incidents.find(item => item.incidentId === incidentId);
    const tickets = ledger.tickets.filter(item => item.incidentId === incidentId);
    if (!row) return { tracking: true, uses: 0, ticketsIssued: tickets.length };
    return { tracking: true, ticketsIssued: tickets.length, uses: row.uses, accepted: tickets.reduce((sum, item) => sum + item.accepted, 0),
      spreadUses: row.spreadUses, spread: row.spreadUses > 0, severity: row.severity, firstUseAt: row.firstUseAt, lastUseAt: row.lastUseAt,
      distinctContexts: new Set(tickets.flatMap(item => item.contexts)).size, distinctSources: new Set(tickets.flatMap(item => item.sources)).size,
      updatesQueued: row.updates, suppressedUses: row.suppressedUses,
      updatesAccepted: ledger.updates.filter(item => item.incidentId === incidentId && item.status === 'ACCEPTED').length };
  }
  const effectiveSender = alertSender ?? (handoff?.configured ? handoff.entrySend : undefined);
  const recoverableLeases = new Set(control?.snapshot().activeLeases.map(row=>row.leaseId) ?? []);
  const running = []; const activeDispatches = new Set(); let closed = false; let deliveryTimer; let deliveryWork;
  try {
  const configDigest = digest(credentials);
  const saved = journal.prepare('SELECT * FROM gateway_meta WHERE id=1').get();
  if (!saved) journal.prepare('INSERT INTO gateway_meta(id,config) VALUES(1,?)').run(configDigest);
  else insist(saved.config === configDigest, 'GATEWAY_CONFIG_CHANGED');
  for (const entry of [
    { contextId: 'diverted', tenantId: 'reference', worldId: 'dungeon', token: credentials.actor, disposition: 'DIVERT' },
    { contextId: 'other', tenantId: 'other-tenant', worldId: 'other-world', token: credentials.other, disposition: 'DIVERT' },
    { contextId: 'ordinary', tenantId: 'reference', worldId: 'ordinary-world', token: credentials.ordinary, disposition: 'NORMAL_AUTHORIZED' }
  ]) {
    const existing = store.snapshot().contexts.find(c => c.contextId === entry.contextId);
    if (existing?.state === 'FENCED') insist(existing.tenantId === entry.tenantId && existing.worldId === entry.worldId && existing.disposition === entry.disposition, 'REGISTRATION_CONFLICT');
    else store.registerContext(entry);
  }
  } catch(e) { response?.close(); control?.close(); journal.close(); store.close(); ownerLock?.close(); throw e; }
  const authenticate = (token, family) => store.decide({ token, family });
  const tracking = Boolean(control?.ticketTracking);
  // A tracked handle is recorded before any effect. Recording failure refuses the presentation (fail closed).
  const presentTicket = (presented, contextId, entry, position) => {
    if (!tracking || typeof presented !== 'string' || presented.length < 1 || presented.length > 4096) return null;
    try {
      const use = control.recordTicketUse({ handleDigest: ticketHandleDigest(presented), contextId, entry: entry.type, position,
        client: entry.client, source: entry.source });
      return use.tracked ? use : null;
    } catch { throw failure('SERVICE_UNAVAILABLE'); }
  };
  // Outcome bookkeeping is best effort; an unsettled row stays PRESENTED, so the use count never changes.
  const settleTicket = (use, outcome, code, replayed) => {
    if (!use) return;
    try { control.settleTicketUse({ useId: use.useId, outcome, code: /^[A-Z][A-Z0-9_]{0,127}$/.test(code ?? '') ? code : 'UNKNOWN_CODE',
      ...(typeof replayed === 'boolean' ? { replayed } : {}) }); } catch { /* Durable PRESENTED row remains authoritative. */ }
  };
  const owner = req => {
    if (equalToken(bearer(req), credentials.owner)) return;
    // A wrong ticket offered to the control plane is a use record, never control authority.
    try { settleTicket(presentTicket(bearer(req), null, { type: 'control', client: runtimeHintLabel(req.headers['user-agent']),
      source: runtimeHintLabel(req.socket.remoteAddress) }, 'CREDENTIAL'), 'REFUSED', 'UNAUTHORIZED'); } catch { /* Still unauthorized. */ }
    throw failure('UNAUTHORIZED');
  };
  const scopes = new WeakSet(); const requestScopes = new WeakMap();
  function beforeOperation({token, family}) {
    insist(!closed, 'SERVICE_UNAVAILABLE');
    if (!control) return undefined;
    let decision;
    try { decision = authenticate(token, family); } catch { /* Count failed authentication without retaining the supplied token. */ }
    const lease = decision?.disposition === 'NORMAL_AUTHORIZED' ? null : control.begin({family});
    let finished = false; let failed; let inFlight = 0; let completion;
    const complete = () => {
      if (finished || !completion || inFlight > 0) return;
      const fault = failed ?? completion.error;
      if (lease) control.finish(lease, {outcome: fault || completion.status >= 400 ? 'UNKNOWN' : 'SERVED',
        code: fault?.code ?? (completion.status >= 400 ? 'INPUT_REJECTED' : 'OK')});
      finished = true;
    };
    const scope = {
      fail(error) { failed ??= error; },
      retain() {
        insist(!finished && !completion, 'PITCH_SCOPE_CLOSED'); inFlight++;
        let released = false;
        return () => { if (!released) { released = true; inFlight--; complete(); } };
      },
      finish({status = 200, error} = {}) {
        if (finished) return;
        completion ??= {status, error}; complete();
      }
    };
    scopes.add(scope);
    try { if (lease && decision?.disposition === 'DIVERT') control.bind(lease, {contextId: decision.contextId}); }
    catch(error) { scope.finish({error}); throw error; }
    return scope;
  }
  const beforeHttp = family => req => {
    if (!control || family === 'http' && (!req.url.startsWith('/api/') || req.url === '/api/capabilities')) return;
    // The control plane remains usable when the diverted workload has exhausted its budget.
    if (family === 'http' && equalToken(bearer(req), credentials.owner)
      && !['/api/operate','/api/write-status'].includes(req.url)) return;
    const scope = beforeOperation({token: bearer(req), family}); requestScopes.set(req, scope);
    // Unverified network/client hints for the wrong-ticket ledger; never used for routing or identity.
    if (scope) scope.observed = { client: req.headers['user-agent'], source: req.socket.remoteAddress };
    return info => scope.finish(info);
  };
  function deliverAlerts() {
    if (!control || !effectiveSender || deliveryWork || closed) return deliveryWork;
    // Kill switch: nothing is claimed, so the entry outbox stays PENDING for the optional Codex relay.
    if (handoff && !handoff.sendingEnabled()) return deliveryWork;
    deliveryWork = (async () => {
      await control.deliver({send: effectiveSender}).catch(() => { /* Durable outbox remains authoritative. */ });
      if (handoff && tracking) await handoff.deliverTicketUpdates({ claim: () => control.claimTicketUpdate(),
        complete: input => control.completeTicketUpdate(input) }).catch(() => { /* Ledger rows remain authoritative. */ });
    })().finally(() => { deliveryWork = undefined; });
    return deliveryWork;
  }
  async function dispatch(input) {
    // `entry` is accepted only from trusted in-process callers; every participant adapter checks exact envelope keys.
    const entry = input.entry !== undefined ? runtimeTicketEntry(input.entry) : null;
    const owned = !scopes.has(input.pitchScope);
    const scope = owned ? beforeOperation(input) : input.pitchScope;
    const release = scope?.retain();
    const observation = entry ?? { type: input.family, client: runtimeHintLabel(scope?.observed?.client),
      source: runtimeHintLabel(scope?.observed?.source), ticket: null, position: null };
    const work = performDispatch(input, observation); activeDispatches.add(work);
    try { return await work; }
    catch(error) { scope?.fail(error); throw error; }
    finally { activeDispatches.delete(work); release?.(); if (owned) scope?.finish(); }
  }
  const originWitness = () => request(originOrigin, '/witness', credentials.witness, undefined, {maxResponse:16777216});
  async function ensureBaseline() {
    const row = journal.prepare('SELECT baseline FROM gateway_meta WHERE id=1').get();
    if (row.baseline) return JSON.parse(row.baseline);
    const baseline = await originWitness();
    journal.prepare('UPDATE gateway_meta SET baseline=? WHERE id=1 AND baseline IS NULL').run(JSON.stringify(baseline));
    return JSON.parse(journal.prepare('SELECT baseline FROM gateway_meta WHERE id=1').get().baseline);
  }
  async function flush() {
    for (const row of journal.prepare('SELECT event_id,payload FROM gateway_attempts WHERE acknowledged=0').all()) {
      const ack = await request(collectorOrigin, '/event', credentials.producer, JSON.parse(row.payload));
      insist(ack.accepted === true && ack.eventId === row.event_id, 'COLLECTOR_ACK_INVALID');
      journal.prepare('UPDATE gateway_attempts SET acknowledged=1 WHERE event_id=?').run(row.event_id);
    }
  }
  function append(event) {
    journal.exec('BEGIN IMMEDIATE');
    try {
      journal.prepare('INSERT INTO gateway_attempts VALUES(?,?,0)').run(event.eventId, JSON.stringify(event));
      journal.prepare('DELETE FROM gateway_pending WHERE event_id=?').run(event.eventId);
      journal.exec('COMMIT');
    } catch (e) { journal.exec('ROLLBACK'); throw e; }
  }
  async function performDispatch({ token, family, requestId, operation, args }, observation) {
    runtimeJson({token,family,requestId,operation,args},32768);
    insist(typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(requestId), 'REQUEST_ID_INVALID');
    insist(operationNames.includes(operation), 'OPERATION_DENIED');
    let decision;
    try { decision = authenticate(token, family); }
    catch (error) {
      // A handle offered as a bearer or argument without a valid context is still a recorded use.
      for (const [presented, position] of [[token, 'CREDENTIAL'], [operation === 'use-ticket' ? args?.ticket : null, 'ARGUMENT']])
        settleTicket(presentTicket(presented, null, observation, position), 'REFUSED', error.code ?? 'AUTHENTICATION_FAILED');
      throw error;
    }
    const uses = [];
    try {
      for (const [presented, position] of [[observation.position === 'CREDENTIAL' ? observation.ticket : null, 'CREDENTIAL'],
        [operation === 'use-ticket' ? args?.ticket : null, 'ARGUMENT']]) {
        const use = presentTicket(presented, decision.contextId, observation, position); if (use) uses.push(use);
      }
    } catch (error) { for (const use of uses) settleTicket(use, 'REFUSED', error.code); throw error; }
    const stage = { dispatched: false, refused: false, destination: undefined };
    try {
      const result = await routeOperation({ token, family, requestId, operation, args }, decision, observation, stage);
      for (const use of uses) settleTicket(use, 'ACCEPTED', 'OK', result?.replayed === true);
      return result;
    } catch (error) {
      const code = error?.code ?? 'DISPATCH_UNKNOWN';
      const definitive = !stage.dispatched || stage.refused || stage.destination === 'ORIGIN' && /_DENIED$|^TICKET_/.test(code);
      for (const use of uses) settleTicket(use, definitive ? 'REFUSED' : 'UNKNOWN', code);
      throw error;
    }
  }
  async function routeOperation({ token, family, requestId, operation, args }, decision, observation, stage) {
    const eventId = randomUUID(); const destination = decision.disposition === 'DIVERT' ? 'SYNTHETIC' : 'ORIGIN';
    stage.destination = destination; const started = performance.now();
    // Diverted routes stay one journal event each; ordinary origin traffic is summarised per window (ADR-DQ-021).
    // Either way the gateway attempt row is appended first, so the census can compare both.
    const recordOutcome = outcome => destination === 'ORIGIN'
      ? store.recordAdmission({ contextId: decision.contextId, requestId, family, outcome, attemptId: eventId,
        latencyMs: Math.min(Math.round((performance.now() - started) * 1000) / 1000, 3600000), source: admissionSourceClass(observation?.source) })
      : store.recordRoute({ contextId: decision.contextId, requestId, family, destination, outcome, attemptId: eventId });
    const entry = {contextId: decision.contextId, worldId: decision.worldId, epoch: decision.epoch, eventId};
    if (control && destination === 'SYNTHETIC') control.reserveEntry(entry);
    if (participant && operation === 'use-ticket' && decision.disposition === 'DIVERT') {
      exact(args, ['ticket'], ['key']);
      args = { ...args, ticket: store.resolveParticipantTicket(args.ticket, decision.contextId) };
    }
    await ensureBaseline(); await flush();
    insist(journal.prepare('SELECT (SELECT count(*) FROM gateway_attempts)+(SELECT count(*) FROM gateway_pending) AS n').get().n < 20000, 'JOURNAL_CAPACITY_LIMIT');
    // Reserve a durable attempt before any external effect. Crash gaps can never produce a green report.
    journal.prepare('INSERT INTO gateway_pending VALUES(?,?)').run(eventId,digest({contextId:decision.contextId,family,requestId,operation,args}));
    let result; let refusal; let outcome = 'UNKNOWN';
    stage.dispatched = true;
    try {
      if (destination === 'SYNTHETIC') {
        const admitted = { contextId: decision.contextId, epoch: decision.epoch, family, requestId, operation, args, expiresAt: Date.now() + 5000 };
        const response = await request(facadeOrigin, '/effect', undefined, seal(admitted, credentials.seal, CAP_DOMAIN));
        if (response?.body?.outcome === 'REFUSED') {
          const rejected = verifyRefusal(response, credentials.seal, { ...admitted, inputDigest: digest(admitted) });
          refusal = response; outcome = 'REFUSED'; stage.refused = true; throw failure(rejected.code);
        }
        const verified = unseal(response, credentials.seal, RESULT_DOMAIN);
        insist(verified.inputDigest === digest(admitted), 'PROJECTION_MISMATCH'); result = verified.result;
      } else {
        result = await request(originOrigin, '/business', token, { contextId: decision.contextId, requestId, operation, args });
      }
      outcome = 'SERVED';
    } catch (error) {
      // A transport failure can occur after a durable effect. Retain UNKNOWN and use the same operation identity.
      append({ eventId, contextId: decision.contextId, requestId, family, destination, outcome, resultDigest: refusal ? digest(refusal.body) : digest({ code: error.code ?? 'TRANSPORT_UNKNOWN' }), ...(refusal ? { refusal } : {}) });
      recordOutcome(outcome);
      try { await flush(); } catch { /* Durable pending event remains visible; no origin fallback. */ }
      throw error.code ? error : failure('DISPATCH_UNKNOWN');
    }
    const event = { eventId, contextId: decision.contextId, requestId, family, destination, outcome, resultDigest: digest(result) };
    append(event); recordOutcome(outcome);
    if (control && destination === 'SYNTHETIC') {
      const entered = control.recordEntry(entry);
      // Arming failure never blocks the participant; start() and the entry alert re-arm from the control ledger.
      if (handoff) { try { handoff.arm(entered.incident); } catch { /* reconciled */ } }
      void deliverAlerts();
    }
    try { await flush(); } catch { throw failure('EVIDENCE_INCOMPLETE'); }
    if (!pitching && destination === 'SYNTHETIC' && operation === 'use-ticket' && !result.replayed && result.observationId) {
      const snapshot = store.snapshot();
      const policy = snapshot.policies.find(p => p.contextId === decision.contextId && p.expiresAt > Date.now() && p.uses < p.maxMutations);
      if (policy) {
        const revision = snapshot.worlds.find(w => w.worldId === decision.worldId && w.tenantId === decision.tenantId).revision;
        try { result = { ...result, _adaptation: store.mutate({ policyId: policy.policyId, contextId: decision.contextId, observationId: result.observationId,
          requestId: 'mutation-' + digest({ contextId: decision.contextId, requestId }).slice(0,48), expectedRevision: revision, template: policy.allowedTemplates[0] }) }; }
        catch (e) { if (!['OBSERVATION_CONSUMED', 'OBSERVATION_STALE', 'IDEMPOTENCY_CONFLICT', 'REVISION_CONFLICT', 'MUTATION_BUDGET_EXHAUSTED', 'MUTATION_POLICY_EXPIRED'].includes(e.code)) throw e; }
      }
    }
    if (tracking && destination === 'SYNTHETIC' && operation === 'issue-ticket' && typeof result.ticket === 'string') {
      // Never release a handle that the ledger cannot recognise later. A retry with the same requestId re-tracks idempotently.
      try { control.trackTicket({ ticketId: result.ticketId, handleDigest: ticketHandleDigest(store.participantTicket(result.ticket)),
        contextId: decision.contextId, worldId: decision.worldId, epoch: decision.epoch, entry: observation.type,
        issuedAt: result.issuedAt, expiresAt: result.expiresAt, source: observation.source }); }
      catch { throw failure('SERVICE_UNAVAILABLE'); }
    }
    if (participant && destination === 'SYNTHETIC') return participantResult(operation, result, ticket => store.participantTicket(ticket));
    // participant-v1 open-control arm (DQ-HANDOFF-015 M8): an authorized ORIGIN read reaches the genuine record,
    // but the participant surface stays free of internal routing. pitching-v1 and diagnostic-v1 are unchanged.
    if (presentation === 'participant-v1' && destination === 'ORIGIN') return participantControlResult(result);
    return { ...result, _route: { contextId: decision.contextId, family, destination, requestId, proofVerified: destination === 'SYNTHETIC' } };
  }
  function inspectWrite({ contextId, family, requestId, operation, args }, participantView = false) {
    runtimeJson({ contextId, family, requestId, operation, args }, 32768);
    const input = { contextId, family, requestId, operation, args };
    const current = store.writeStatus(input);
    const attempts = journal.prepare('SELECT payload FROM gateway_attempts').all().map(row => JSON.parse(row.payload))
      .filter(event => event.contextId === contextId && event.requestId === requestId);
    const pending = journal.prepare('SELECT count(*) AS n FROM gateway_pending WHERE input_digest=?').get(digest(input)).n;
    let state = current.state === 'NOT_OBSERVED' ? 'UNKNOWN' : current.state;
    // Absence is not proof of non-execution: another admitted operation may still be in flight.
    // Only exact authenticated refusals, with no uncertain sibling attempt, establish NOT_COMMITTED.
    if (state === 'UNKNOWN' && pending === 0 && attempts.length > 0 && attempts.every(event => {
      try { return event.outcome === 'REFUSED' && event.destination === 'SYNTHETIC'
        && verifyRefusal(event.refusal, credentials.seal, event).commandDigest === current.commandDigest; }
      catch { return false; }
    })) state = 'NOT_COMMITTED';
    const response = { schemaVersion: 'dungeonq.write-status/v1', requestId, state,
      commandDigest: current.commandDigest, checkpoint: current.checkpoint,
      automaticRetryAllowed: false, method: 'AUTHENTICATED_JOURNAL_REPLAY' };
    if (state === 'COMMITTED') Object.assign(response, { sequence: current.sequence, eventDigest: current.eventDigest,
      result: participantView ? participantResult('write', current.result) : current.result });
    return response;
  }
  function participantWriteStatus({ token, family, ...input }) {
    exact(input, ['requestId', 'operation', 'args']);
    const decision = authenticate(token, family);
    insist(decision.disposition === 'DIVERT', 'SYNTHETIC_CONTEXT_REQUIRED');
    return inspectWrite({ ...input, contextId: decision.contextId, family }, participant);
  }
  const capabilities = () => [
    { id: 'http', family: 'web-api', state: 'AVAILABLE', reason: 'Authenticated real request routing and canonical readback.' },
    { id: 'mcp', family: 'ai-tools', state: 'AVAILABLE', reason: 'MCP 2025-11-25 Streamable HTTP; client compatibility is explicitly tested.' },
    { id: 'ssh', family: 'network-service', state: network ? 'AVAILABLE' : 'DISABLED', reason: 'Loopback, typed operations only; no shell or forwarding.' },
    { id: 'postgres', family: 'network-service', state: network ? 'AVAILABLE' : 'DISABLED', reason: 'Loopback bounded PostgreSQL query profile; no arbitrary SQL.' },
    { id: 'host', family: 'managed-workload', state: hostBroker ? 'AVAILABLE' : 'DISABLED', reason: 'Private authenticated local workload broker; not general OS interception.' }
  ];
  const limitations = ['Artificial registered origin and disposable credentials only.', 'Local process separation is not production or infrastructure isolation.',
    'Owner bearer is a reference machine capability, not attestation of human presence.', 'This evidence endpoint measures runtime behavior only; model identity and deception efficacy require a separate experiment record.'];
  const responseStatus = () => {
    const snapshot = control.snapshot();
    for (const row of snapshot.outbox.filter(item => item.status === 'ACCEPTED'))
      response.recordProviderAcceptance(snapshot.incidents.find(incident => incident.incidentId === row.incidentId), row);
    return response.snapshot();
  };
  const pitchStatus = () => ({...control.snapshot(), deliveryConfigured: Boolean(effectiveSender),
    ownership:{bootId:ownerLock.bootId,scope:'COOPERATIVE_SINGLE_GATEWAY'},recoverableLeases:[...recoverableLeases],
    ...(handoff ? {alertHandoff:{channels:handoff.channels,sendingEnabled:handoff.sendingEnabled(),ackAccount:handoff.accountStatus()}} : {})});
  const status = () => ({ ...store.snapshot(), schemaVersion: 'dungeonq.runtime-status/v1', profile: 'LOCAL_INTEGRATION_REFERENCE', presentation, capabilities: capabilities(), limitations,
    ...(control ? {pitching: pitchStatus()} : {}) });
  async function evidence() {
    const checks = []; let witness; let observed; let canonical;
    const add = (id, pass, detail) => checks.push({ id, status: pass === null ? 'INCONCLUSIVE' : pass ? 'PASS' : 'FAIL', detail });
    try { canonical = store.evidence(); add('canonical-replay', canonical.verifier?.status === 'VERIFIED', 'Canonical journal replay and persisted state verification.'); }
    catch { add('canonical-replay', false, 'Canonical state could not be verified.'); }
    try {
      const baseline = await ensureBaseline(); witness = await originWitness();
      add('origin-state-unchanged', witness.stateDigest === baseline.stateDigest && witness.configDigest === baseline.configDigest, 'Artificial protected data/configuration digest compared with the pre-dispatch baseline.');
      add('no-diverted-origin-admission', witness.acceptedContexts.every(id => id === 'ordinary') && witness.highWater >= baseline.highWater && digest(witness.admissions.slice(0,baseline.highWater)) === digest(baseline.admissions), 'Origin admission interval is contiguous and preserves the baseline checkpoint.');
    } catch { add('origin-witness', null, 'Origin witness unavailable; no untouched conclusion.'); }
    try {
      await flush(); observed = await request(collectorOrigin, '/evidence', credentials.reader, undefined, {maxResponse:16777216});
      const expected = journal.prepare('SELECT payload FROM gateway_attempts').all().map(r => JSON.parse(r.payload));
      // Read in the same synchronous step as the attempt table, so no dispatch can land between the two (ADR-DQ-021).
      let admissions = null; try { admissions = store.admissionCensus().total; } catch { /* canonical-replay already fails */ }
      add('independent-route-census', observed.complete === true && expected.length === observed.events.length
        && expected.every(e => observed.events.some(o => o.eventId === e.eventId && digest(o) === digest(e))), 'Every gateway attempt has a matching separate-process collector event.');
      const pending = journal.prepare('SELECT count(*) AS n FROM gateway_pending').get().n;
      if(witness) {
        const baseline=await ensureBaseline();
        const actual=witness.admissions.slice(baseline.highWater).filter(e=>e.accepted===1).map(e=>e.request_id).sort();
        const routed=expected.filter(e=>e.destination==='ORIGIN' && e.outcome==='SERVED').map(e=>e.requestId).sort();
        // The authenticated journal windows (plus the open window) must account for exactly the ordinary gateway attempts.
        const ordinary=expected.filter(e=>e.destination==='ORIGIN');
        const journalled=Boolean(admissions) && admissions.count===ordinary.length
          && admissions.attemptDigest===admissionAttemptDigest(ordinary.map(e=>e.eventId))
          && ADMISSION_OUTCOMES.every(outcome=>admissions.outcomes[outcome]===ordinary.filter(e=>e.outcome===outcome).length);
        add('ordinary-admission-census',digest(actual)===digest(routed) && journalled,'Every ordinary origin admission matches a served gateway attempt, and the journal admission windows account for exactly the ordinary gateway attempts.');
      }
      add('dispatch-outcomes-known', pending === 0 && expected.every(e => e.outcome === 'SERVED' || e.outcome === 'REFUSED' && e.destination === 'SYNTHETIC' && (() => { try { return digest(verifyRefusal(e.refusal, credentials.seal, e)) === e.resultDigest; } catch { return false; } })()), 'Only served results or authenticated no-new-effect refusals qualify. Unknown, legacy FAILED and unfinished dispatches prevent acceptance; no automatic reconciliation.');
      add('real-diversion-observed', expected.some(e => e.destination === 'SYNTHETIC' && e.outcome === 'SERVED'), 'At least one actual canonical result passed through the synthetic facade.');
    } catch { add('independent-route-census', null, 'Collector unavailable or incomplete.'); }
    return { schemaVersion: 'dungeonq.runtime-evidence/v1', status: checks.some(c => c.status === 'FAIL') ? 'FAIL' : checks.every(c => c.status === 'PASS') ? 'PASS' : 'INCONCLUSIVE',
      checks, events: observed?.events ?? [], scope: { profile: 'LOCAL_INTEGRATION_REFERENCE', resource: 'artificial-origin', witness, independentInfrastructure: false },
      canonical, limitations };
  }
  async function close() {
    if (closed) return; closed = true;
    clearInterval(deliveryTimer);
    for (const item of running.reverse()) await item.close().catch(() => {});
    await Promise.allSettled([...activeDispatches]);
    await handoff?.close();
    await deliveryWork;
    response?.close(); control?.close(); journal.close(); store.close(); ownerLock?.close();
  }
  try {
    const state = await serve(async (req,res) => {
      insist(req.method === 'POST' && req.url === '/execute', 'NOT_FOUND');
      const input = unseal(await body(req), credentials.seal, CAP_DOMAIN);
      exact(input, ['contextId','epoch','family','requestId','operation','args','expiresAt']);
      insist(Number.isSafeInteger(input.expiresAt) && input.expiresAt >= Date.now() && input.expiresAt <= Date.now()+6000, 'ADMISSION_EXPIRED');
      const current = store.snapshot().contexts.find(c => c.contextId === input.contextId);
      insist(current?.state === 'ACTIVE' && current.epoch === input.epoch && current.disposition === 'DIVERT', 'CONTEXT_FENCED');
      const { contextId, family, requestId, operation, args } = input;
      const outcome = executeOutcome(store, { contextId,family,requestId,operation,args }, input, credentials.seal);
      send(res,200,outcome.refusal ?? seal({ inputDigest: digest(input), result: outcome.result },credentials.seal,RESULT_DOMAIN));
    }, {host:stateHost,port:statePort}); running.push(state);
    if (!facadeOrigin) { insist(typeof facadeFactory === 'function', 'FACADE_REQUIRED'); const facade = await facadeFactory(state.origin); facadeOrigin = facade.origin; running.push(facade); }
    const ackFiles = new Map([['/ack/app.mjs',['public/runtime/ack.mjs','text/javascript']],['/ack/ack.css',['public/runtime/ack.css','text/css']]]);
    const staticFiles = new Map([
      ['/runtime/', ['public/runtime/index.html','text/html']], ['/runtime/app.mjs',['public/runtime/app.mjs','text/javascript']],
      ['/runtime/styles.css',['public/runtime/styles.css','text/css']],
      ['/runtime/participant.html',['public/runtime/participant.html','text/html']],
      ['/runtime/participant.mjs',['public/runtime/participant.mjs','text/javascript']],
      ['/runtime/participant.css',['public/runtime/participant.css','text/css']], ['/runtime/client.mjs',['sdk/runtime-client.mjs','text/javascript']]
    ]);
    const http = await serve(async (req,res) => {
      if (req.method==='GET' && req.url==='/') { headers(res); res.writeHead(302,{Location:'/runtime/'}); return res.end(); }
      if (req.method==='GET' && staticFiles.has(req.url)) {
        const [path,type]=staticFiles.get(req.url); headers(res);res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});return res.end(readFileSync(join(root,path)));
      }
      if(req.method==='GET' && req.url==='/api/capabilities') {
        if (participant) return send(res,200,{schemaVersion:'workspace.capabilities/v1',capabilities:capabilities().map(({id,state})=>({id,state}))});
        return send(res,200,{schemaVersion:'dungeonq.capability-catalogue/v1',capabilities:capabilities(),limitations});
      }
      if(req.method==='POST' && req.url==='/api/operate') {
        const input=await body(req);exact(input,['requestId','operation','args']);return send(res,200,await dispatch({...input,token:bearer(req),family:'http',pitchScope:requestScopes.get(req)}));
      }
      if(req.method==='POST' && req.url==='/api/write-status') {
        const input=await body(req); return send(res,200,participantWriteStatus({...input,token:bearer(req),family:'http'}));
      }
      if(req.url.startsWith('/ack/')) {
        // Verified ACK (M3): the link is only a single-use pointer; authority comes from the local operator password/TOTP.
        insist(handoff,'NOT_FOUND');
        if(req.method==='GET' && ackFiles.has(req.url)) {
          const [path,type]=ackFiles.get(req.url); headers(res);res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});return res.end(readFileSync(join(root,path)));
        }
        if(req.method==='GET' && /^\/ack\/incident-[a-f0-9]{64}\/[A-Za-z0-9_-]{43}$/.test(req.url)) {
          headers(res);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(readFileSync(join(root,'public/runtime/ack.html')));
        }
        if(req.method==='POST' && req.url==='/ack/verify') return send(res,200,await handoff.verifyAck(await body(req,4096)));
        if(req.method==='POST' && req.url==='/ack/summary') return send(res,200,await handoff.summary(await body(req,1024)));
        if(req.method==='POST' && ['/ack/decision/token','/ack/decision','/ack/decision/status'].includes(req.url)) {
          // Admin decisions (t6): loopback only whatever the listen host; authority is the verified ACK session plus a single-use
          // decision token and the page's own Origin. The host-injected handler decides and executes; the runtime only records.
          insist(host==='127.0.0.1' && req.socket.remoteAddress==='127.0.0.1','LOOPBACK_REQUIRED');
          const from={origin:req.headers.origin};
          if(req.url==='/ack/decision/token') return send(res,200,await handoff.issueDecisionToken(await body(req,1024),from));
          if(req.url==='/ack/decision') return send(res,200,await handoff.submitDecision(await body(req,16384),from));
          return send(res,200,await handoff.decisionStatus(await body(req,1024),from));
        }
        throw failure('NOT_FOUND');
      }
      owner(req);
      if(req.url.startsWith('/api/pitching/')) {
        insist(control, 'PITCHING_DISABLED');
        if(req.method==='GET' && req.url==='/api/pitching/status') return send(res,200,pitchStatus());
        if(req.method==='GET' && req.url==='/api/pitching/response/status') return send(res,200,responseStatus());
        if(req.url.startsWith('/api/pitching/handoff/')) {
          insist(handoff,'PITCH_HANDOFF_DISABLED');
          if(req.method==='GET' && req.url==='/api/pitching/handoff/status') return send(res,200,handoff.publicStatus());
          if(req.method==='POST' && req.url==='/api/pitching/handoff/disable') {
            const input=await body(req);exact(input,['reason']);return send(res,200,handoff.disable(input));
          }
          if(req.method==='POST' && req.url==='/api/pitching/handoff/ack-link') {
            const input=await body(req);exact(input,['incidentId']);
            const link=handoff.mintLink(input.incidentId);insist(link,'PITCH_HANDOFF_LINK_UNAVAILABLE');return send(res,200,link);
          }
          throw failure('NOT_FOUND');
        }
        if(req.method==='POST' && req.url==='/api/pitching/ticket-uses') {
          insist(tracking,'PITCH_TICKET_TRACKING_DISABLED');
          const input=await body(req);exact(input,[],['afterSeq','limit']);return send(res,200,control.ticketUses(input));
        }
        if(req.method==='POST' && req.url==='/api/pitching/relay/claim') {
          const input=await body(req); return send(res,200,control.claimRelay(input));
        }
        if(req.method==='POST' && req.url==='/api/pitching/relay/complete') {
          const input=await body(req); const result=control.completeRelay(input); responseStatus();
          return send(res,200,result);
        }
        if(req.method==='POST' && req.url==='/api/pitching/response/event') {
          const input=await body(req); responseStatus();
          const incident=control.snapshot().incidents.find(row=>row.incidentId===input.incidentId);
          const canonical=incident && store.snapshot().contexts.find(row=>row.contextId===incident.contextId);
          return send(res,200,response.record(input,{incident,canonical}));
        }
        if(req.method==='POST' && req.url==='/api/pitching/reconcile-lease') {
          const input=await body(req);exact(input,['leaseId']);
          insist(recoverableLeases.has(input.leaseId),'PITCH_RECOVERY_DENIED');
          const result=control.reconcile({leaseId:input.leaseId,evidence:{kind:'STOPPED_EXECUTION',
            referenceId:ownerLock.bootId,operatorId:'reference-owner'}});
          recoverableLeases.delete(input.leaseId);return send(res,200,result);
        }
        if(req.method==='POST' && req.url==='/api/pitching/reconcile-delivery') {
          const input=await body(req);exact(input,['incidentId','evidence']);
          const result=control.reconcileDelivery(input); responseStatus(); return send(res,200,result);
        }
        if(req.method==='POST' && req.url==='/api/pitching/ack') {
          const input=await body(req);exact(input,['incidentId']);
          return send(res,200,control.acknowledge({...input,operatorId:'reference-owner'}));
        }
        if(req.method==='POST' && req.url==='/api/pitching/resolve') {
          const input=await body(req);exact(input,['incidentId','resolution']);
          if(input.resolution==='FENCED') {
            const incident=control.snapshot().incidents.find(i=>i.incidentId===input.incidentId);
            insist(incident && store.snapshot().contexts.some(c=>c.contextId===incident.contextId && c.state==='FENCED' && c.epoch>incident.epoch),'PITCH_FENCE_REQUIRED');
          }
          return send(res,200,control.resolve({...input,operatorId:'reference-owner'}));
        }
      }
      if(req.method==='POST' && req.url==='/api/operator/write-status') {
        const input=await body(req);exact(input,['contextId','family','requestId','operation','args']);
        return send(res,200,inspectWrite(input));
      }
      if(req.method==='GET' && req.url==='/api/status')return send(res,200,status());
      if(req.method==='GET' && req.url==='/api/evidence')return send(res,200,await evidence());
      if(req.method==='POST' && req.url==='/api/policy/preview') {
        const input=await body(req);exact(input,['contextId','action'],['reason']);
        insist(['FENCE','GRANT_MUTATION'].includes(input.action),'ACTION_DENIED');
        insist(!pitching || input.action==='FENCE','PITCHING_LEGACY_MUTATION_DENIED');
        insist(input.reason===undefined || typeof input.reason==='string' && input.reason.trim().length>0 && input.reason.length<=180,'REASON_INVALID');
        const snap=store.snapshot();const context=snap.contexts.find(c=>c.contextId===input.contextId);
        insist(context?.disposition==='DIVERT' && context.state==='ACTIVE','CONTEXT_DENIED');
        insist(journal.prepare('SELECT count(*) AS n FROM gateway_previews').get().n<2000,'PREVIEW_CAPACITY_LIMIT');
        const world=snap.worlds.find(w=>w.worldId===context.worldId && w.tenantId===context.tenantId);
        const preview={proposalId:randomUUID(),expiresAt:Date.now()+120000,action:input.action,contextId:input.contextId,
          epoch:context.epoch,expectedRevision:world.revision,reason:input.reason??'Owner reviewed',policyExpiresAt:Date.now()+3600000,
          changes:[input.action==='FENCE'?'Fence this synthetic context and its outstanding tickets.':'Authorize up to eight future synthetic follow-up mutations for one hour.'],warnings:['No production effect. Approval is independent of participant tools.']};
        const hash=digest(preview);journal.prepare('INSERT INTO gateway_previews VALUES(?,?,?,NULL)').run(preview.proposalId,JSON.stringify(preview),hash);
        return send(res,200,{...preview,digest:hash});
      }
      if(req.method==='POST' && req.url==='/api/policy/apply') {
        const input=await body(req);exact(input,['proposalId','digest','confirmation']);insist(input.confirmation==='APPLY','CONFIRMATION_REQUIRED');
        const row=journal.prepare('SELECT * FROM gateway_previews WHERE id=?').get(input.proposalId);
        insist(row && equalToken(row.digest,input.digest),'PROPOSAL_DENIED');
        if(row.result)return send(res,200,JSON.parse(row.result));
        const p=JSON.parse(row.body);
        const snap=store.snapshot(),context=snap.contexts.find(c=>c.contextId===p.contextId);
        // Recover only an exact previously authorized canonical command after a two-database crash gap.
        const fenceReason=`${p.proposalId}: ${p.reason}`;
        const recovered=p.action==='FENCE'
          ? context?.state==='FENCED' && context.epoch===p.epoch+1 && context.fenceReason===fenceReason
          : snap.policies.some(policy=>policy.policyId===p.proposalId && policy.contextId===p.contextId && policy.epoch===p.epoch && policy.expiresAt===p.policyExpiresAt);
        if(!recovered) {
        insist(p.expiresAt>=Date.now(),'APPROVAL_EXPIRED');
        insist(context?.state==='ACTIVE' && context.epoch===p.epoch,'APPROVAL_STALE');
        const world=snap.worlds.find(w=>w.worldId===context.worldId && w.tenantId===context.tenantId);
        // Pitching response fences revoke this context/epoch independently of data writes.
        // Legacy profiles and mutation grants retain the reviewed world revision contract.
        if(!pitching || p.action!=='FENCE')insist(world.revision===p.expectedRevision,'APPROVAL_STALE');
        if(p.action==='FENCE')store.fence({contextId:p.contextId,reason:fenceReason});
        else store.grantMutation({policyId:p.proposalId,contextId:p.contextId,expectedRevision:p.expectedRevision,
          allowedTemplates:['follow-up'],maxMutations:8,expiresAt:p.policyExpiresAt,authority:{principalId:'reference-owner',kind:'OWNER'}});
        }
        const result={proposalId:p.proposalId,state:'APPLIED',readback:status()};
        journal.prepare('UPDATE gateway_previews SET result=? WHERE id=?').run(JSON.stringify(result),p.proposalId);return send(res,200,result);
      }
      throw failure('NOT_FOUND');
    },{host,port,browser:true,ackNavigation:Boolean(handoff) && host==='127.0.0.1',before:beforeHttp('http'),protectedRequest:req=>Boolean(control)
      && req.url?.startsWith('/api/') && !['/api/operate','/api/write-status','/api/capabilities'].includes(req.url)
      && equalToken(bearer(req),credentials.owner)});running.push(http);
    const mcp=await startRuntimeMcp({dispatch,authenticate,writeStatus:participantWriteStatus,host,port:mcpPort,
      before:beforeHttp('mcp'),requestScope:req=>requestScopes.get(req)});running.push(mcp);
    let protocols;
    if(network) {
      const keys=privateJson(join(directory,'ssh-host.json'),()=>({key:generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey}));
      protocols=await startNetworkAdapters({dispatch,before:beforeOperation,sshHostKey:keys.key,sshPort,postgresPort});running.push(protocols);
    }
    let broker;
    if(hostBroker) {broker=await startHostBroker({socketPath:join(directory,'workload.sock'),dispatch,before:beforeOperation});running.push(broker);}
    if(handoff) { handoff.bindOrigin(http.origin); await handoff.start({entered:control.snapshot().incidents.filter(row=>row.phase==='ENTERED')}); }
    if(control && effectiveSender) { void deliverAlerts(); deliveryTimer=setInterval(deliverAlerts,1000); deliveryTimer.unref(); }
    return {origin:http.origin,port:http.port,stateOrigin:state.origin,statePort:state.port,mcpEndpoint:mcp.origin+'/mcp',protocols,
      brokerPath:broker?.socketPath,store,dispatch,status,evidence,close};
  } catch(e) {await close();throw e;}
}
