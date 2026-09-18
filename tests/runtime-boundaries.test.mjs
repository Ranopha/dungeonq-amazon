import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openRuntimeReference } from '../runtime/reference.mjs';
import { request } from '../runtime/transport.mjs';
const directory=t=>{const d=mkdtempSync(join(tmpdir(),'dq-boundary-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;};
async function start(t,d=directory(t)){const r=await openRuntimeReference({directory:d,network:false,hostBroker:false});t.after(()=>r.close());return r;}
const input=(requestId='boundary',args={})=>({requestId,operation:'snapshot',args});

test('facade failure cannot send a diverted request to the available origin',async t=>{
  const r=await start(t);await r.facadeService.close();
  await assert.rejects(request(r.origin,'/api/operate',r.credentials.actor,input()));
  const witness=await request(r.originService.origin,'/witness',r.credentials.witness);
  assert.equal(witness.highWater,0);assert.notEqual((await r.evidence()).status,'PASS');
  const normal=await request(r.origin,'/api/operate',r.credentials.ordinary,input('normal'));
  assert.equal(normal._route.destination,'ORIGIN');
});
test('an unfinished durable attempt blocks acceptance after restart',async t=>{
  const d=directory(t),r=await start(t,d);await request(r.origin,'/api/operate',r.credentials.actor,input());await r.close();
  const db=new DatabaseSync(join(d,'gateway.sqlite'));db.prepare('INSERT INTO gateway_pending VALUES(?,?)').run('unfinished','bounded-reference-digest');db.close();
  const resumed=await start(t,d);const evidence=await resumed.evidence();
  assert.equal(evidence.checks.find(c=>c.id==='dispatch-outcomes-known').status,'FAIL');
});
for(const file of ['gateway.sqlite','origin.sqlite','collector.sqlite'])test(`an incomplete existing ${file} fails closed`,async t=>{
  const d=directory(t);writeFileSync(join(d,file),'',{mode:0o600});await assert.rejects(openRuntimeReference({directory:d,network:false,hostBroker:false}));
});
test('unmatched origin admission prevents a clean evidence claim',async t=>{
  const r=await start(t);await request(r.origin,'/api/operate',r.credentials.actor,input());
  await request(r.originService.origin,'/business',r.credentials.ordinary,{contextId:'ordinary',...input('out-of-band')});
  const evidence=await r.evidence();assert.equal(evidence.checks.find(c=>c.id==='ordinary-admission-census').status,'FAIL');
});
test('non-finite wire values are denied before JSON normalization or effect',async t=>{
  const r=await start(t);const response=await fetch(r.origin+'/api/operate',{method:'POST',headers:{Authorization:'Bearer '+r.credentials.actor,'Content-Type':'application/json'},body:'{"requestId":"invalid-number","operation":"write","args":{"key":"welcome","value":1e999,"expectedRevision":0}}'});
  assert.equal(response.ok,false);assert.equal(r.store.snapshot().worlds.find(w=>w.worldId==='dungeon').revision,0);
});
test('owner approval recovers exact persisted grant and fence after receipt loss',async t=>{
  const d=directory(t);let r=await start(t,d);
  for(const action of ['GRANT_MUTATION','FENCE']) {
    const p=await request(r.origin,'/api/policy/preview',r.credentials.owner,{contextId:'diverted',action});
    const apply={proposalId:p.proposalId,digest:p.digest,confirmation:'APPLY'};
    await request(r.origin,'/api/policy/apply',r.credentials.owner,apply);await r.close();
    const db=new DatabaseSync(join(d,'gateway.sqlite'));db.prepare('UPDATE gateway_previews SET result=NULL WHERE id=?').run(p.proposalId);db.close();
    r=await start(t,d);const replay=await request(r.origin,'/api/policy/apply',r.credentials.owner,apply);assert.equal(replay.state,'APPLIED');
  }
  assert.equal(r.store.snapshot().policies.length,1);assert.equal(r.store.snapshot().contexts.find(c=>c.contextId==='diverted').epoch,2);
});
