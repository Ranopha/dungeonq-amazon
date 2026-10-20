import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableJson,durableEvent } from './response-storage.mjs';
import { request } from '../../vendor/dungeonq-runtime/runtime/transport.mjs';

const clock=()=>({at:new Date().toISOString(),monotonicNs:process.hrtime.bigint().toString()});
/** Opt-in study detector: authenticated trial entry, not a claim of general attack classification. */
export function openResponseAlert({directory,runId,receiverOrigin,receiverToken}) {
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(receiverOrigin),'LOOPBACK_RECEIVER_REQUIRED');
  const path=join(directory,'response-alert.json'),events=join(directory,'response-alert-events.jsonl');
  let state=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null,work=null;
  const save=()=>durableJson(path,state);
  const event=(kind,extra={})=>{const value={kind,...clock(),incidentId:state?.incidentId,...extra};durableEvent(events,value);return value;};
  const deliver=()=>{
    if(work||!state||state.status==='ACCEPTED')return work;
    work=(async()=>{
      state.status='IN_FLIGHT';state.attempts++;save();event('ALERT_SEND');
      try{
        const receipt=await request(receiverOrigin,'/alerts',receiverToken,{incidentId:state.incidentId,runId,
          detected:state.detected,requestHash:state.requestHash,detector:'AUTHENTICATED_TRIAL_ENTRY'});
        assert(receipt.incidentId===state.incidentId&&receipt.accepted===true,'ALERT_RECEIPT_INVALID');
        state.status='ACCEPTED';state.receipt=receipt;save();event('ALERT_RECEIPT',receipt);
      }catch(error){state.status='UNKNOWN';state.error=/^[A-Z_]{1,80}$/.test(error.code??'')?error.code:'DELIVERY_INCOMPLETE';save();event('ALERT_FAILURE',{code:state.error});}
    })().finally(()=>{work=null;});return work;
  };
  return {
    detect({requestHash}){
      if(state)return;
      state={incidentId:'response-'+runId,runId,requestHash,detected:clock(),status:'PENDING',attempts:0};
      save();event('DETECTED_AND_QUEUED');void deliver();
    },
    async flush(){await work;return structuredClone(state);},
    snapshot(){return structuredClone(state);}
  };
}
