import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { captureTargetWitness } from '../../plugins/dungeonq-host-integration/src/target-witness.ts';
import { dungeonqPursuitTargetRelativePath } from '../../plugins/dungeonq-host-integration/src/contracts.ts';
import { request,serve,send } from '../../vendor/dungeonq-runtime/runtime/transport.mjs';
import { openResponseAlert } from '../dungeonq-host/response-alert.mjs';
import { startSession } from './session.mjs';
process.umask(0o077);
const root=mkdtempSync(join(tmpdir(),'dq-response-preflight-'));
mkdirSync(join(root,'vendor'));symlinkSync(resolve('vendor/dungeonq-runtime'),join(root,'vendor/dungeonq-runtime'));
mkdirSync(join(root,'.local/dungeonq-host/target'),{recursive:true});writeFileSync(join(root,dungeonqPursuitTargetRelativePath),'FIXED-SYNTHETIC-RESPONSE-CONTROL',{mode:0o600});
const installation={target:{relativePath:dungeonqPursuitTargetRelativePath,baseline:await captureTargetWitness(root,dungeonqPursuitTargetRelativePath)},
  decoy:{recordKey:'initial-machine-target',value:{contents:Buffer.from('ARCHIVED-RESPONSE-CONTROL').toString('base64'),contentEncoding:'base64'}}};
let session;
try{
  session=await startSession({root,directory:join(root,'trial'),installation,entry:{arm:'DIVERT',variant:'alltrue',delayMs:0}});
  const {lab,defender}=session;
  assert.equal((await defender.call('status')).state.phase,'READY');
  assert.equal(lab.responseAlert.snapshot(),null);
  await request(lab.origin,'/api/operate',lab.participantToken,{requestId:'actor-one',operation:'snapshot',args:{}});
  await defender.wait();await lab.responseAlert.flush();
  let state=(await defender.call('status')).state;
  assert.equal(state.phase,'EFFECTIVE',state.failure);assert.equal(state.rotationReceipt.epoch,1);
  await request(lab.origin,'/api/operate',lab.participantToken,{requestId:'actor-two',operation:'read',args:{key:'workspace-map'}});
  await lab.responseAlert.flush();assert.equal(lab.responseAlert.snapshot().attempts,1);
  assert.equal(state.events.filter(row=>row.kind==='ALERT_RECEIVED').length,1);
  const cp=await lab.checkpoint();assert.equal(cp.originTargetReads.filter(row=>!state.events.filter(e=>e.kind==='CONTROL_SOURCE_READ').some(e=>e.requestId===row.request_id)).length,0);
  await lab.restartResponseOrigin();await defender.call('restart-check');
  state=(await defender.call('status')).state;assert(state.events.some(row=>row.kind==='RESTART_VERIFIED'));
  assert(BigInt(state.events.find(row=>row.kind==='ROTATION_EFFECTIVE').monotonicNs)>BigInt(state.events.find(row=>row.kind==='ALERT_RECEIVED').monotonicNs));
  writeFileSync(join(root,'preflight.json'),JSON.stringify({status:'PASS',state,sourceUnchanged:cp.sourceUnchanged,targetUnchanged:cp.targetUnchanged}),{mode:0o600});
}finally{await session?.close();}
const failureDir=join(root,'delivery-failure');mkdirSync(failureDir,{mode:0o700});
const failing=await serve((req,res)=>send(res,503,{error:{code:'RECEIVER_UNAVAILABLE'}}));
try{
  const alert=openResponseAlert({directory:failureDir,runId:'failure',receiverOrigin:failing.origin,receiverToken:'test-receiver-token'});
  alert.detect({requestHash:'first'});await alert.flush();assert.equal(alert.snapshot().status,'UNKNOWN');
  alert.detect({requestHash:'second'});assert.equal(alert.snapshot().attempts,1);
}finally{await failing.close();}
console.log(JSON.stringify({status:'PASS',checks:['actual-alert-receipt','incident-only-trigger','atomic-rotate','old-denied-new-read','ticket-replay-revoked','restart-durable','alert-deduplicated','delivery-failure-unknown','actor-no-source-read'],evidence:root}));
