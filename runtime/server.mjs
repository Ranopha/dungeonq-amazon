import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { openAuxiliary } from './auxiliary.mjs';
import { runtimeJson } from './contracts.mjs';
import { openRuntimeStore } from './store.mjs';
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
  sshPort = 0, postgresPort = 0, network = true, hostBroker = true }) {
  const store = openRuntimeStore({ path: join(directory, 'runtime.sqlite') });
  let journal;
  try { journal = openAuxiliary(join(directory, 'gateway.sqlite'), 'CREATE TABLE IF NOT EXISTS gateway_meta(id INTEGER PRIMARY KEY,config TEXT NOT NULL,baseline TEXT); CREATE TABLE IF NOT EXISTS gateway_attempts(event_id TEXT PRIMARY KEY,payload TEXT NOT NULL,acknowledged INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS gateway_pending(event_id TEXT PRIMARY KEY,input_digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS gateway_previews(id TEXT PRIMARY KEY,body TEXT NOT NULL,digest TEXT NOT NULL,result TEXT);', 'gateway_meta'); } catch(e) { store.close(); throw e; }
  const running = []; let closed = false;
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
  } catch(e) { journal.close(); store.close(); throw e; }
  const authenticate = (token, family) => store.decide({ token, family });
  const owner = req => insist(equalToken(bearer(req), credentials.owner), 'UNAUTHORIZED');
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
  async function dispatch({ token, family, requestId, operation, args }) {
    runtimeJson({token,family,requestId,operation,args},32768);
    insist(typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(requestId), 'REQUEST_ID_INVALID');
    insist(operationNames.includes(operation), 'OPERATION_DENIED');
    const decision = authenticate(token, family);
    await ensureBaseline(); await flush();
    const eventId = randomUUID(); const destination = decision.disposition === 'DIVERT' ? 'SYNTHETIC' : 'ORIGIN';
    insist(journal.prepare('SELECT (SELECT count(*) FROM gateway_attempts)+(SELECT count(*) FROM gateway_pending) AS n').get().n < 20000, 'JOURNAL_CAPACITY_LIMIT');
    // Reserve a durable attempt before any external effect. Crash gaps can never produce a green report.
    journal.prepare('INSERT INTO gateway_pending VALUES(?,?)').run(eventId,digest({contextId:decision.contextId,family,requestId,operation,args}));
    let result; let outcome = 'UNKNOWN';
    try {
      if (destination === 'SYNTHETIC') {
        const admitted = { contextId: decision.contextId, epoch: decision.epoch, family, requestId, operation, args, expiresAt: Date.now() + 5000 };
        const response = await request(facadeOrigin, '/effect', undefined, seal(admitted, credentials.seal, CAP_DOMAIN));
        const verified = unseal(response, credentials.seal, RESULT_DOMAIN);
        insist(verified.inputDigest === digest(admitted), 'PROJECTION_MISMATCH'); result = verified.result;
      } else {
        result = await request(originOrigin, '/business', token, { contextId: decision.contextId, requestId, operation, args });
      }
      outcome = 'SERVED';
    } catch (error) {
      // A transport failure can occur after a durable effect. Retain UNKNOWN and use the same operation identity.
      append({ eventId, contextId: decision.contextId, requestId, family, destination, outcome, resultDigest: digest({ code: error.code ?? 'TRANSPORT_UNKNOWN' }) });
      store.recordRoute({ contextId: decision.contextId, requestId, family, destination, outcome });
      try { await flush(); } catch { /* Durable pending event remains visible; no origin fallback. */ }
      throw error.code ? error : failure('DISPATCH_UNKNOWN');
    }
    const event = { eventId, contextId: decision.contextId, requestId, family, destination, outcome, resultDigest: digest(result) };
    append(event); store.recordRoute({ contextId: decision.contextId, requestId, family, destination, outcome });
    try { await flush(); } catch { throw failure('EVIDENCE_INCOMPLETE'); }
    if (destination === 'SYNTHETIC' && operation === 'use-ticket' && !result.replayed && result.observationId) {
      const snapshot = store.snapshot();
      const policy = snapshot.policies.find(p => p.contextId === decision.contextId && p.expiresAt > Date.now() && p.uses < p.maxMutations);
      if (policy) {
        const revision = snapshot.worlds.find(w => w.worldId === decision.worldId && w.tenantId === decision.tenantId).revision;
        try { result = { ...result, _adaptation: store.mutate({ policyId: policy.policyId, contextId: decision.contextId, observationId: result.observationId,
          requestId: 'mutation-' + digest({ contextId: decision.contextId, requestId }).slice(0,48), expectedRevision: revision, template: policy.allowedTemplates[0] }) }; }
        catch (e) { if (!['OBSERVATION_CONSUMED', 'OBSERVATION_STALE', 'IDEMPOTENCY_CONFLICT', 'REVISION_CONFLICT', 'MUTATION_BUDGET_EXHAUSTED', 'MUTATION_POLICY_EXPIRED'].includes(e.code)) throw e; }
      }
    }
    return { ...result, _route: { contextId: decision.contextId, family, destination, requestId, proofVerified: destination === 'SYNTHETIC' } };
  }
  const capabilities = () => [
    { id: 'http', family: 'web-api', state: 'AVAILABLE', reason: 'Authenticated real request routing and canonical readback.' },
    { id: 'mcp', family: 'ai-tools', state: 'AVAILABLE', reason: 'MCP 2025-11-25 Streamable HTTP; client compatibility is explicitly tested.' },
    { id: 'ssh', family: 'network-service', state: network ? 'AVAILABLE' : 'DISABLED', reason: 'Loopback, typed operations only; no shell or forwarding.' },
    { id: 'postgres', family: 'network-service', state: network ? 'AVAILABLE' : 'DISABLED', reason: 'Loopback bounded PostgreSQL query profile; no arbitrary SQL.' },
    { id: 'host', family: 'managed-workload', state: hostBroker ? 'AVAILABLE' : 'DISABLED', reason: 'Private authenticated local workload broker; not general OS interception.' }
  ];
  const limitations = ['Artificial registered origin and disposable credentials only.', 'Local process separation is not production or infrastructure isolation.',
    'Owner bearer is a reference machine capability, not attestation of human presence.', 'No live model run, production connector or competition update.'];
  const status = () => ({ ...store.snapshot(), schemaVersion: 'dungeonq.runtime-status/v1', profile: 'LOCAL_INTEGRATION_REFERENCE', capabilities: capabilities(), limitations });
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
      add('independent-route-census', observed.complete === true && expected.length === observed.events.length
        && expected.every(e => observed.events.some(o => o.eventId === e.eventId && digest(o) === digest(e))), 'Every gateway attempt has a matching separate-process collector event.');
      const pending = journal.prepare('SELECT count(*) AS n FROM gateway_pending').get().n;
      if(witness) {
        const baseline=await ensureBaseline();
        const actual=witness.admissions.slice(baseline.highWater).filter(e=>e.accepted===1).map(e=>e.request_id).sort();
        const routed=expected.filter(e=>e.destination==='ORIGIN' && e.outcome==='SERVED').map(e=>e.requestId).sort();
        add('ordinary-admission-census',digest(actual)===digest(routed),'Every ordinary origin admission matches a served gateway attempt.');
      }
      add('dispatch-outcomes-known', pending === 0 && expected.every(e => e.outcome === 'SERVED'), 'Unfinished or unknown dispatches prevent acceptance; automatic reconciliation is not implemented.');
      add('real-diversion-observed', expected.some(e => e.destination === 'SYNTHETIC' && e.outcome === 'SERVED'), 'At least one actual canonical result passed through the synthetic facade.');
    } catch { add('independent-route-census', null, 'Collector unavailable or incomplete.'); }
    return { schemaVersion: 'dungeonq.runtime-evidence/v1', status: checks.some(c => c.status === 'FAIL') ? 'FAIL' : checks.every(c => c.status === 'PASS') ? 'PASS' : 'INCONCLUSIVE',
      checks, events: observed?.events ?? [], scope: { profile: 'LOCAL_INTEGRATION_REFERENCE', resource: 'artificial-origin', witness, independentInfrastructure: false },
      canonical, limitations };
  }
  async function close() {
    if (closed) return; closed = true;
    for (const item of running.reverse()) await item.close().catch(() => {});
    journal.close(); store.close();
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
      const result = store.execute({ contextId,family,requestId,operation,args });
      send(res,200,seal({ inputDigest: digest(input), result },credentials.seal,RESULT_DOMAIN));
    }, {host:stateHost,port:statePort}); running.push(state);
    if (!facadeOrigin) { insist(typeof facadeFactory === 'function', 'FACADE_REQUIRED'); const facade = await facadeFactory(state.origin); facadeOrigin = facade.origin; running.push(facade); }
    const staticFiles = new Map([
      ['/runtime/', ['public/runtime/index.html','text/html']], ['/runtime/app.mjs',['public/runtime/app.mjs','text/javascript']],
      ['/runtime/styles.css',['public/runtime/styles.css','text/css']], ['/runtime/client.mjs',['sdk/runtime-client.mjs','text/javascript']]
    ]);
    const http = await serve(async (req,res) => {
      if (req.method==='GET' && req.url==='/') { headers(res); res.writeHead(302,{Location:'/runtime/'}); return res.end(); }
      if (req.method==='GET' && staticFiles.has(req.url)) {
        const [path,type]=staticFiles.get(req.url); headers(res);res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});return res.end(readFileSync(join(root,path)));
      }
      if(req.method==='GET' && req.url==='/api/capabilities') return send(res,200,{schemaVersion:'dungeonq.capability-catalogue/v1',capabilities:capabilities(),limitations});
      if(req.method==='POST' && req.url==='/api/operate') {
        const input=await body(req);exact(input,['requestId','operation','args']);return send(res,200,await dispatch({...input,token:bearer(req),family:'http'}));
      }
      owner(req);
      if(req.method==='GET' && req.url==='/api/status')return send(res,200,status());
      if(req.method==='GET' && req.url==='/api/evidence')return send(res,200,await evidence());
      if(req.method==='POST' && req.url==='/api/policy/preview') {
        const input=await body(req);exact(input,['contextId','action'],['reason']);
        insist(['FENCE','GRANT_MUTATION'].includes(input.action),'ACTION_DENIED');
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
        insist(world.revision===p.expectedRevision,'APPROVAL_STALE');
        if(p.action==='FENCE')store.fence({contextId:p.contextId,reason:fenceReason});
        else store.grantMutation({policyId:p.proposalId,contextId:p.contextId,expectedRevision:p.expectedRevision,
          allowedTemplates:['follow-up'],maxMutations:8,expiresAt:p.policyExpiresAt,authority:{principalId:'reference-owner',kind:'OWNER'}});
        }
        const result={proposalId:p.proposalId,state:'APPLIED',readback:status()};
        journal.prepare('UPDATE gateway_previews SET result=? WHERE id=?').run(JSON.stringify(result),p.proposalId);return send(res,200,result);
      }
      throw failure('NOT_FOUND');
    },{host,port,browser:true});running.push(http);
    const mcp=await startRuntimeMcp({dispatch,authenticate,host,port:mcpPort});running.push(mcp);
    let protocols;
    if(network) {
      const keys=privateJson(join(directory,'ssh-host.json'),()=>({key:generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey}));
      protocols=await startNetworkAdapters({dispatch,sshHostKey:keys.key,sshPort,postgresPort});running.push(protocols);
    }
    let broker;
    if(hostBroker) {broker=await startHostBroker({socketPath:join(directory,'workload.sock'),dispatch});running.push(broker);}
    return {origin:http.origin,port:http.port,stateOrigin:state.origin,statePort:state.port,mcpEndpoint:mcp.origin+'/mcp',protocols,
      brokerPath:broker?.socketPath,store,dispatch,status,evidence,close};
  } catch(e) {await close();throw e;}
}
