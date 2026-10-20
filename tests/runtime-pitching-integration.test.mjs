import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {openRuntimeReference} from '../runtime/reference.mjs';
import {request} from '../runtime/transport.mjs';
import {createRuntimeClient} from '../sdk/runtime-client.mjs';
const op=(requestId,operation='snapshot',args={})=>({requestId,operation,args});
const rejected=code=>error=>error.code===code;
const actor=(r,input,token=r.credentials.actor)=>request(r.origin,'/api/operate',token,input);
const owner=(r,path,input)=>request(r.origin,path,r.credentials.owner,input);
async function fixture(t,options={}) {
 const directory=mkdtempSync(join(tmpdir(),'dq-pitch-test-'));
 let r; const start=()=>openRuntimeReference({directory,network:false,hostBroker:false,presentation:'pitching-v1',...options});
 r=await start(); t.after(async()=>{await r.close();rmSync(directory,{recursive:true,force:true});});
 return {get r(){return r;},directory,async restart(){await r.close();r=await start();return r;}};
}
async function mcp(r) {
 const client=new Client({name:'pitching-test',version:'1'});
 await client.connect(new StreamableHTTPClientTransport(new URL(r.mcpEndpoint),{requestInit:{headers:{Authorization:'Bearer '+r.credentials.actor}}}));
 return client;
}
async function ticket(r,key,id) {
 const result=await actor(r,op(id+'-issue','issue-ticket',{scope:[key]}));
 return actor(r,op(id+'-use','use-ticket',{ticket:result.ticket,key}));
}

test('四種情境經 HTTP/MCP 真實路由、寫入恢復與重啟；告警持久且無來源碰觸',async t=>{
 const f=await fixture(t);let r=f.r;
 const before=await r.evidence();
 const initial=await actor(r,op('initial'));
 assert.deepEqual(initial.records.map(row=>row.key),['welcome','catalog-current','catalog-prior']);
 assert.doesNotMatch(JSON.stringify(initial),/groundTruth|policyDigest|revealKeys|pitching-policy/);
 await assert.rejects(actor(r,op('guess','read',{key:'history-delta'})),rejected('RECORD_UNKNOWN'));
 await assert.rejects(actor(r,op('edit','write',{key:'catalog-current',value:999,expectedRevision:0})),rejected('PITCHING_RECORD_IMMUTABLE'));
 await actor(r,op('current','read',{key:'catalog-current'}));
 await actor(r,op('prior','read',{key:'catalog-prior'}));
 const first=await ticket(r,'catalog-current','first');assert.equal(first.revealed.key,'history-delta');
 const client=await mcp(r);
 try {
  const result=await client.callTool({name:'dungeonq_read',arguments:{requestId:'other-interface',args:{key:'catalog-current'}}});
  assert.equal(result.isError,undefined);assert.equal(result.structuredContent.value.version,2);
  const conflict=await client.callTool({name:'dungeonq_read',arguments:{requestId:'current',args:{key:'catalog-current'}}});
  assert.equal(JSON.parse(conflict.content[0].text).error.code,'IDEMPOTENCY_CONFLICT');
 } finally {await client.close();}
 const second=await ticket(r,first.revealed.key,'second');assert.equal(second.revealed.key,'mirror-ledger');
 assert.match(second.revealed.value.independence,/Same canonical source/);
 const snap=await actor(r,op('before-note'));
 // Drop the successful write response at the client, after the real server has committed it.
 let lose=true;
 const sdk=createRuntimeClient({origin:r.origin,token:r.credentials.actor,fetch:async(url,options)=>{
  const response=await fetch(url,options);
  if(lose && url.endsWith('/api/operate')) {lose=false;await response.text();throw new Error('simulated response loss');}
  return response;
 }});
 const saved=await sdk.writeWithRecovery(op('note-save','write',{key:'note-proof',value:'Known synthetic note',expectedRevision:snap.revision}));
 assert.equal(saved.recovered,true);assert.equal(saved.result.revision,snap.revision+1);
 await actor(r,op('note-read','read',{key:'note-proof'}));
 const third=await ticket(r,'note-proof','third');assert.equal(third.revealed.key,'persistence-receipt');
 const controlBefore=await owner(r,'/api/pitching/status');
 assert.equal(controlBefore.incidents.length,1);assert.equal(controlBefore.incidents[0].phase,'ENTERED');
 assert.equal(controlBefore.outbox[0].status,'PENDING');assert.equal(controlBefore.deliveryConfigured,false);
 const id=controlBefore.incidents[0].incidentId;
 await assert.rejects(request(r.origin,'/api/pitching/ack',r.credentials.actor,{incidentId:id}),rejected('UNAUTHORIZED'));
 await assert.rejects(owner(r,'/api/pitching/resolve',{incidentId:id,resolution:'REVIEWED'}),rejected('PITCH_ACK_REQUIRED'));
 await owner(r,'/api/pitching/ack',{incidentId:id});
 await assert.rejects(owner(r,'/api/pitching/resolve',{incidentId:id,resolution:'FENCED'}),rejected('PITCH_FENCE_REQUIRED'));
 r=await f.restart();
 assert.equal((await actor(r,op('persisted-note','read',{key:'note-proof'}))).value,'Known synthetic note');
 await actor(r,op('read-receipt','read',{key:third.revealed.key}));
 const fourth=await ticket(r,third.revealed.key,'fourth');assert.equal(fourth.revealed.key,'continuation-amber');
 const repeat=await ticket(r,'catalog-current','repeat');assert.equal(repeat.revealed,undefined);
 const status=await owner(r,'/api/status');
 assert.equal(status.contexts.find(c=>c.contextId==='diverted').pitching.decisions.length,4);
 assert.equal(status.pitching.incidents.length,1);assert(status.pitching.incidents[0].acknowledgement);
 assert.equal(status.pitching.activeLeases.length,0);
 assert.equal(status.pitching.incidents[0].incidentId,id);
 assert(status.pitching.global.attempts>controlBefore.global.attempts);
 const evidence=await r.evidence();assert.equal(evidence.status,'PASS');
 assert.equal(evidence.scope.witness.stateDigest,before.scope.witness.stateDigest);assert.equal(evidence.scope.witness.accepted,0);
 assert(evidence.events.some(e=>e.family==='mcp'));assert(evidence.events.some(e=>e.family==='http'));
 const fence=await owner(r,'/api/policy/preview',{contextId:'diverted',action:'FENCE'});
 await owner(r,'/api/policy/apply',{proposalId:fence.proposalId,digest:fence.digest,confirmation:'APPLY'});
 await owner(r,'/api/pitching/resolve',{incidentId:id,resolution:'FENCED'});
 await assert.rejects(actor(r,op('after-fence')),rejected('CONTEXT_FENCED'));
});

test('錯誤handle、HTTP schema、MCP錯誤皆計額度；耗盡後普通服務及owner仍可用',async t=>{
 const f=await fixture(t,{pitchingLimits:{globalTotal:12,contextTotal:12,globalErrors:10,contextErrors:10}});const r=f.r;
 await assert.rejects(actor(r,op('handle','use-ticket',{ticket:'not-a-handle'})),rejected('TICKET_INVALID'));
 const admitted=await owner(r,'/api/pitching/status');assert.equal(admitted.incidents[0].phase,'ADMITTED');
 await assert.rejects(request(r.origin,'/api/operate',r.credentials.actor,{bogus:true}),rejected('INVALID_ENVELOPE'));
 await assert.rejects(actor(r,op('bad-token'), 'unregistered'),rejected('TOKEN_INVALID'));
 const malformed=await fetch(r.origin+'/api/operate',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+r.credentials.actor},body:'{'});
 assert.equal(malformed.status,400);
 const client=await mcp(r);
 try {const error=await client.callTool({name:'missing_tool',arguments:{}});assert.equal(error.isError,true);} finally {await client.close();}
 const mid=await owner(r,'/api/pitching/status');assert(mid.global.errors>=5);assert.equal(mid.contexts.length,1);
 for(let n=0;n<14;n++) {try{await actor(r,op('flood-'+n));}catch(error){assert.match(error.code,/PITCH_GLOBAL_(TOTAL|ERRORS)/);}}
 const status=await owner(r,'/api/pitching/status');assert(status.global.denials.TOTAL>0);assert.equal(status.activeLeases.length,0);
 assert.equal((await actor(r,op('ordinary'),r.credentials.ordinary))._route.destination,'ORIGIN');
 assert.equal((await owner(r,'/api/pitching/status')).global.attempts,status.global.attempts);
 await f.restart();await assert.rejects(actor(f.r,op('restart-budget')),rejected('PITCH_GLOBAL_TOTAL'));
});

test('trusted sender只收事件摘要、重啟不重送已接受通知；投遞與人類ack分開',async t=>{
 const calls=[];
 const f=await fixture(t,{alertSender:async input=>{calls.push(input);return {accepted:true,receiptId:'test-receipt'};}});
 await actor(f.r,op('entry'));
 const until=Date.now()+1500;let status;
 do {status=await owner(f.r,'/api/pitching/status');if(status.outbox[0].status==='ACCEPTED')break;await new Promise(r=>setTimeout(r,10));}while(Date.now()<until);
 assert.equal(status.outbox[0].status,'ACCEPTED');assert.equal(status.incidents[0].acknowledgement,null);
 assert.equal(calls.length,1);assert.doesNotMatch(JSON.stringify(calls[0]),/note-|Bearer|credentials|groundTruth/);
 await f.restart();await actor(f.r,op('entry-again'));assert.equal(calls.length,1);
});

test('新profile明確啟用，重啟不可靜默換seed或mode',async t=>{
 const f=await fixture(t);await f.r.close();
 await assert.rejects(openRuntimeReference({directory:f.directory,network:false,hostBroker:false,presentation:'pitching-v1',pitchingSeed:29}),rejected('BLUEPRINT_MISMATCH'));
 await assert.rejects(openRuntimeReference({directory:f.directory,network:false,hostBroker:false,presentation:'participant-v1'}),rejected('BLUEPRINT_MISMATCH'));
});

test('MCP batch拒絕整包，不乘算同一lease或執行任何操作',async t=>{
 const {r}=await fixture(t);
 const count=r.store.snapshot().observations.length;
 const response=await fetch(r.mcpEndpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+r.credentials.actor},body:JSON.stringify([1,2].map(id=>({jsonrpc:'2.0',id,method:'tools/call',params:{name:'dungeonq_snapshot',arguments:{requestId:'batch-'+id,args:{}}}})))});
 assert.equal(response.status,403);assert.equal((await response.json()).error.code,'MCP_BATCH_DENIED');
 const status=await owner(r,'/api/pitching/status');
 assert.equal(status.global.attempts,1);assert.equal(status.global.errors,1);assert.equal(status.activeLeases.length,0);
 assert.equal(r.store.snapshot().observations.length,count);
});

test('owner的transport配額獨立於參與者rate耗盡',async t=>{
 const {serve,send}=await import('../runtime/transport.mjs');
 const server=await serve(async(req,res)=>send(res,200,{ok:true}),{requestLimit:2,protectedRequest:req=>req.headers.authorization==='Bearer local-owner-test'});
 t.after(()=>server.close());
 for(let n=0;n<2;n++)assert.equal((await fetch(server.origin)).status,200);
 assert.equal((await fetch(server.origin)).status,429);
 assert.equal((await fetch(server.origin,{headers:{Authorization:'Bearer local-owner-test'}})).status,200);
});

test('SSH中斷不釋放仍執行的dispatch槽位',async t=>{
 const {default:ssh2}=await import('ssh2');const {once}=await import('node:events');const {readFileSync}=await import('node:fs');
 const f=await fixture(t,{network:true,pitchingLimits:{globalConcurrent:1,contextConcurrent:1}});const r=f.r;
 const ssh=new ssh2.Client();t.after(()=>ssh.destroy());ssh.on('error',()=>{});
 const key=JSON.parse(readFileSync(join(r.directory,'ssh-host.json'))).key;
 const ready=once(ssh,'ready');ssh.connect({host:'127.0.0.1',port:r.protocols.sshPort,username:'dungeonq',password:r.credentials.actor,readyTimeout:3000,hostVerifier:wire=>wire.equals(ssh2.utils.parseKey(key).getPublicSSH())});await ready;
 process.kill(r.facadeService.pid,'SIGSTOP');let paused=true;t.after(()=>{if(paused)process.kill(r.facadeService.pid,'SIGCONT');});
 await new Promise((resolve,reject)=>ssh.exec('snapshot',(error,stream)=>{if(error)return reject(error);stream.on('error',()=>{});resolve();}));
 const until=Date.now()+1500;let leases;
 do {leases=(await owner(r,'/api/pitching/status')).activeLeases;if(leases.length)break;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<until);
 assert.equal(leases.length,1);ssh.destroy();
 await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal((await owner(r,'/api/pitching/status')).activeLeases.length,1);
 await assert.rejects(actor(r,op('while-running')),rejected('PITCH_GLOBAL_CONCURRENT'));
 process.kill(r.facadeService.pid,'SIGCONT');paused=false;
 const settled=Date.now()+5000;
 do {leases=(await owner(r,'/api/pitching/status')).activeLeases;if(!leases.length)break;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<settled);
 assert.equal(leases.length,0);
});

test('單一gateway持鎖；只有新boot的遺留lease可由owner恢復且保留UNKNOWN',async t=>{
 const {openPitchControl}=await import('../runtime/pitch-control.mjs');const f=await fixture(t);let r=f.r;
 await assert.rejects(openRuntimeReference({directory:f.directory,presentation:'pitching-v1'}),rejected('PITCH_GATEWAY_ALREADY_RUNNING'));
 const control=openPitchControl({path:join(f.directory,'pitch-control.sqlite')});
 const abandoned=control.begin({family:'http'});control.bind(abandoned,{contextId:'diverted'});control.close();
 const firstBoot=(await owner(r,'/api/pitching/status')).ownership.bootId;
 await assert.rejects(owner(r,'/api/pitching/reconcile-lease',abandoned),rejected('PITCH_RECOVERY_DENIED'));
 r=await f.restart();const after=await owner(r,'/api/pitching/status');
 assert.notEqual(after.ownership.bootId,firstBoot);assert.deepEqual(after.recoverableLeases,[abandoned.leaseId]);
 await assert.rejects(request(r.origin,'/api/pitching/reconcile-lease',r.credentials.actor,abandoned),rejected('UNAUTHORIZED'));
 await owner(r,'/api/pitching/reconcile-lease',abandoned);
 const reconciled=await owner(r,'/api/pitching/status');assert.equal(reconciled.activeLeases.length,0);
 assert.equal(reconciled.global.outcomes.UNKNOWN,2); // participant management refusal plus orphan recovery
 assert.equal(reconciled.samples.at(-1).category,'RECONCILIATION');
 assert.equal(reconciled.recoverableLeases.length,0);
 await actor(r,op('after-recovery'));
});

test('外部未知回執只由owner對帳，不靠重啟猜成已送達',async t=>{
 let calls=0;const f=await fixture(t,{alertSender:async()=>{calls++;throw new Error('uncertain');}});
 await actor(f.r,op('enter-notify'));let status;const until=Date.now()+1500;
 do {status=await owner(f.r,'/api/pitching/status');if(status.outbox[0].status==='UNKNOWN')break;await new Promise(r=>setTimeout(r,10));}while(Date.now()<until);
 assert.equal(status.outbox[0].status,'UNKNOWN');assert.equal(calls,1);
 await f.restart();const row=(await owner(f.r,'/api/pitching/status')).outbox[0];assert.equal(row.status,'UNKNOWN');assert.equal(calls,1);
 const evidence={kind:'DELIVERY_RECEIPT',idempotencyKey:row.idempotencyKey,referenceId:'operator-test-evidence',receiptId:'test-receipt'};
 await assert.rejects(request(f.r.origin,'/api/pitching/reconcile-delivery',f.r.credentials.actor,{incidentId:row.incidentId,evidence}),rejected('UNAUTHORIZED'));
 await owner(f.r,'/api/pitching/reconcile-delivery',{incidentId:row.incidentId,evidence});
 const accepted=(await owner(f.r,'/api/pitching/status')).outbox[0];assert.equal(accepted.status,'ACCEPTED');assert(accepted.reconciliationDigest);assert.equal(calls,1);
});
