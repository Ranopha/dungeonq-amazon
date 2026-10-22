import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { studyRecords, studyBlueprint } from '../runtime/study-fixture.mjs';
import { startOrigin } from '../runtime/services.mjs';
import { request } from '../runtime/transport.mjs';
import { prepareParticipantLab } from '../scripts/runtime-isolation.mjs';

test('fixture has one discrepant target field and no truth label in participant data',()=>{
 const a=studyRecords(false)[1].value,b=studyRecords(true)[1].value;
 assert.equal(Object.keys(a).length,10);assert.deepEqual(Object.keys(a).filter(k=>a[k]!==b[k]),['deliveryCode']);
 assert(!/synthetic|artificial|decoy|divert|wrong-ticket/i.test(JSON.stringify(studyRecords(true))));
 assert.throws(()=>studyBlueprint('untrusted'),{ code: 'STUDY_FIXTURE_INVALID' });
});
test('fixture origin retains credential scope, witness',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'dq-fixture-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const opts={path:join(dir,'origin.sqlite'),normalToken:'ordinary-credential',witnessToken:'witness-credential',host:'127.0.0.1',port:0,studyFixture:'wrong-ticket-v1'};
 const origin=await startOrigin(opts);t.after(()=>origin.close());
 const op=(id,operation,args={})=>({contextId:'ordinary',requestId:id,operation,args});
 const snap=await request(origin.origin,'/business',opts.normalToken,op('list','snapshot'));
 assert.equal(snap.records.length,3);
 const target=await request(origin.origin,'/business',opts.normalToken,op('read','read',{key:'deployment-manifest'}));
 assert.equal(target.value.deliveryCode,'release-9e18-green');
 await assert.rejects(request(origin.origin,'/business','wrong',op('bad','read',{key:'deployment-manifest'})),{ code: 'ORIGIN_AUTHORITY_DENIED' });
 await assert.rejects(request(origin.origin,'/business',opts.normalToken,op('path','read',{key:'elsewhere'})),{ code: 'ORIGIN_AUTHORITY_DENIED' });
 assert.equal(origin.report().accepted,2);assert.equal(origin.report().rejected,2);
});
test('opt-in fixture leaves default lab intact and never enters participant config',t=>{
 const dir=mkdtempSync(join(tmpdir(),'dq-fixture-plan-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const lab=prepareParticipantLab({directory:join(dir,'lab'),studyFixture:'wrong-ticket-v1',sourceProtection:'legacy-open-v1'});
 const read=role=>JSON.parse(readFileSync(join(lab.directory,'config',role+'.json'),'utf8'));
 assert.equal(read('origin').options.studyFixture,'wrong-ticket-v1');assert.equal(read('gateway').studyFixture,'wrong-ticket-v1');
 assert.equal(read('participant').studyFixture,undefined);assert.equal(read('a2').asset,'deployment-manifest');
 assert(!/synthetic|artificial/.test(read('a2').contents));
});


test('private runner umask does not make source directories unreadable to the container UID',t=>{
 const dir=mkdtempSync(join(tmpdir(),'dq-private-stage-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const previous=process.umask(0o077);let lab;
 try {lab=prepareParticipantLab({directory:join(dir,'lab'),studyFixture:'wrong-ticket-v1',sourceProtection:'legacy-open-v1'});}finally{process.umask(previous);}
 for(const part of ['runtime','runtime/blueprints','public','public/runtime','server'])
   assert.equal(statSync(join(lab.images.runtime.buildDirectory,part)).mode & 0o777,0o755,part);
 assert.equal(statSync(join(lab.directory,'config')).mode & 0o777,0o700);
 assert.equal(statSync(join(lab.directory,'config','gateway.json')).mode & 0o777,0o600);
});
