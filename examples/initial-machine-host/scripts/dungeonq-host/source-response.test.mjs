import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { respondToSourceAlert } from './source-response.mjs';
const measurement=()=>({measuredAt:new Date().toISOString(),sampleCount:8,baseline:{successRate:1,p95LatencyMs:20},current:{successRate:1,p95LatencyMs:20}});
const witness={head:'abc',tenantId:'reference',resource:'deployment-manifest',events:[{kind:'TARGET_DENIED',requestId:'participant-example',seq:1,at:Date.now()}]};
function directory(t){const d=mkdtempSync(join(tmpdir(),'dq-source-response-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;}
test('preflight denial alone cannot trigger participant response',async t=>{
 await assert.rejects(()=>respondToSourceAlert({directory:directory(t),witness:{...witness,events:[{...witness.events[0],requestId:'isolation-probe'}]}}),/SOURCE_ALERT_MISSING/);
});
test('ambiguous rotate and lookup stay UNKNOWN without repeating a mutation or inventing human receipt',async t=>{
 const dir=directory(t),calls=[],events=[];
 const rpc=async input=>{calls.push(input.action);if(input.action==='prepare'||input.action==='lookup')throw Error('TRANSPORT_UNKNOWN');
  return {status:200,body:input.action==='status'?{epoch:1}:witness};};
 const result=await respondToSourceAlert({directory:dir,witness,rpc,health:{measure:async()=>measurement()},emit:(kind,detail)=>events.push({kind,detail})});
 assert.equal(result.result.status,'UNKNOWN');assert.equal(calls.filter(action=>action==='prepare').length,1);assert.equal(calls.filter(action=>action==='lookup').length,1);
 assert.equal(result.timing.alertToEffectiveMs,null);assert.equal(result.humanResponse,'UNKNOWN');assert.equal(result.paidCalls,0);
 const alert=JSON.parse(readFileSync(join(dir,'alert.json'),'utf8'));assert.equal(alert.delivery,'LOCAL_INBOX');assert.equal(alert.externalDelivery,'UNKNOWN');
 assert(events.some(row=>row.kind==='ESCALATION'));
});
test('unhealthy registered consumer prevents rotation through existing policy',async t=>{
 const calls=[];const result=await respondToSourceAlert({directory:directory(t),witness,
  rpc:async input=>{calls.push(input.action);return {status:200,body:input.action==='status'?{epoch:1}:witness};},
  health:{measure:async()=>({...measurement(),sampleCount:4})},emit:()=>{}});
 assert.equal(result.result.status,'REJECTED');assert(!calls.includes('prepare'));assert.equal(result.timing.alertToEffectiveMs,null);
});
