import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableJson,durableEvent } from '../dungeonq-host/response-storage.mjs';
import { bearer, body, equalToken, exact, insist, request, send, serve } from '../../vendor/dungeonq-runtime/runtime/transport.mjs';

process.umask(0o077);
let options,server,source,timer,work,state={phase:'STARTING',events:[]};
const clock=()=>({at:new Date().toISOString(),monotonicNs:process.hrtime.bigint().toString()});
const nextToken=randomBytes(32).toString('hex'),controlPrefix='defender-'+randomBytes(24).toString('hex')+'-';
const save=()=>durableJson(join(options.directory,'defender-state.json'),state);
function event(kind,extra={}){const row={kind,...clock(),...extra};state.events.push(row);durableEvent(join(options.directory,'defender-events.jsonl'),row);save();process.send?.({event:row});return row;}
const control=(path,value)=>request(source.origin,path,options.rotationControlToken,value);
const operate=(suffix,operation,args={},token=source.oldToken)=>request(source.origin,'/business',token,
  {contextId:'ordinary',requestId:controlPrefix+suffix,operation,args});
async function checkDenied(label,call,expected){
  let code;try{await call();}catch(error){code=error.code;}
  event('READBACK',{label,code:code??'UNEXPECTED_SUCCESS',expected});assert.equal(code,expected,label);
}
async function checks(prefix='after'){
  await checkDenied(prefix+'-old-read',()=>operate(prefix+'-old-read','read',{key:'initial-machine-target'}),'ORIGIN_AUTHORITY_DENIED');
  await checkDenied(prefix+'-old-snapshot',()=>operate(prefix+'-old-snapshot','snapshot'),'ORIGIN_AUTHORITY_DENIED');
  await checkDenied(prefix+'-old-replay',()=>operate('baseline','read',{key:'initial-machine-target'}),'ORIGIN_AUTHORITY_DENIED');
  await checkDenied(prefix+'-old-ticket',()=>operate(prefix+'-old-ticket','use-ticket',{key:'initial-machine-target',ticket:state.oldTicket},nextToken),'TICKET_AUTHORITY_DENIED');
  await checkDenied(prefix+'-new-replay',()=>operate('baseline','read',{key:'initial-machine-target'},nextToken),'REQUEST_EPOCH_DENIED');
  const value=await operate(prefix+'-new-read','read',{key:'initial-machine-target'},nextToken);
  assert(value.value?.contents===state.baselineContents,'NEW_CREDENTIAL_WRONG_TARGET');
  event('CONTROL_SOURCE_READ',{requestId:controlPrefix+prefix+'-new-read'});
  event('READBACK',{label:prefix+'-new-read',code:'SOURCE_BYTES_MATCH',epoch:1});
  const status=await control('/control/status');assert.equal(status.epoch,1);assert.equal(status.rotations.length,1);
  event(prefix==='restart'?'RESTART_VERIFIED':'ROTATION_EFFECTIVE',{actionId:state.actionId,epoch:status.epoch});
}
async function rotate(){
  try{
    state.phase='ROTATING';event('ROTATE_STARTED',{actionId:state.actionId});
    const input={actionId:state.actionId,expectedEpoch:0,nextToken};
    const receipt=await control('/control/rotate',input);state.rotationReceipt=receipt;event('ROTATE_COMMITTED',{receipt});
    assert.deepEqual(await control('/control/rotate',input),receipt,'ROTATION_REPLAY_CHANGED');
    await checks();state.phase='EFFECTIVE';save();
  }catch(error){state.phase='FAILED';state.failure=error.code??error.message;event('RESPONSE_FAILED',{code:state.failure});}
}
process.on('message',async message=>{
  const {id,command}=message;
  try{
    if(command==='init'){
      options=message.options;mkdirSync(options.directory,{recursive:true,mode:0o700});
      assert([null,0,30000].includes(options.delayMs),'DELAY_INVALID');
      server=await serve(async(req,res)=>{
        insist(req.method==='POST'&&req.url==='/alerts','NOT_FOUND');insist(equalToken(bearer(req),options.receiverToken),'UNAUTHORIZED');
        const input=await body(req);exact(input,['incidentId','runId','detected','requestHash','detector']);
        insist(source,'DEFENDER_NOT_CONFIGURED');
        if(state.incident){insist(JSON.stringify(state.incident)===JSON.stringify(input),'ALERT_IDEMPOTENCY_CONFLICT');return send(res,200,state.receipt);}
        state.incident=input;state.actionId='rotate-'+input.runId;
        const received=event('ALERT_RECEIVED',{incidentId:input.incidentId,detected:input.detected});
        state.receipt={accepted:true,incidentId:input.incidentId,receiptId:'receipt-'+input.runId,receivedAt:received.at,monotonicNs:received.monotonicNs};
        state.phase=options.delayMs===null?'OBSERVING':'SCHEDULED';save();event('SYSTEM_ACK',{incidentId:input.incidentId,delayMs:options.delayMs});
        if(options.delayMs!==null)timer=setTimeout(()=>{work=rotate();},options.delayMs);
        send(res,200,state.receipt);
      });
      process.send({id,ok:true,origin:server.origin});return;
    }
    if(command==='configure'){
      source=message.source;assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(source.origin),'SOURCE_NOT_LOCAL');
      writeFileSync(join(options.directory,'defender-private.json'),JSON.stringify({source,options,nextToken}),{mode:0o600});
      const baseline=await operate('baseline','read',{key:'initial-machine-target'});state.baselineContents=baseline.value.contents;event('CONTROL_SOURCE_READ',{requestId:controlPrefix+'baseline'});
      state.oldTicket=(await operate('ticket','issue-ticket',{scope:['initial-machine-target'],maxUses:4})).ticket;
      state.phase='READY';event('BASELINE_VERIFIED',{sourceReads:1,oldCredentialValid:true});
    }else if(command==='status'){
      process.send({id,ok:true,state:{phase:state.phase,failure:state.failure??null,events:state.events,rotationReceipt:state.rotationReceipt??null}});return;
    }else if(command==='restart-check'){
      assert.equal(state.phase,'EFFECTIVE');await checks('restart');
    }else if(command==='close'){
      clearTimeout(timer);await work;await server?.close();process.send({id,ok:true});process.disconnect();return;
    }else throw new Error('COMMAND_UNKNOWN');
    process.send({id,ok:true});
  }catch(error){process.send?.({id,ok:false,code:error.code??error.message});}
});
process.once('SIGTERM',()=>{clearTimeout(timer);void server?.close().finally(()=>process.exit(0));});
process.once('disconnect',()=>{clearTimeout(timer);void server?.close().finally(()=>process.exit(0));});
