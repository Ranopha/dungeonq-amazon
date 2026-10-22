import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startOrigin } from '../runtime/services.mjs';
import { startA2Asset, A2_GUARDED_CONFIG_VERSION } from '../deploy/runtime-reference/a2-asset.mjs';
import { prepareParticipantLab } from '../scripts/runtime-isolation.mjs';
const token = () => randomBytes(32).toString('base64url');
async function fixture(t) {
 const dir = mkdtempSync(join(tmpdir(),'dq-source-')); const old=token(),next=token(),control=token();
 const options={path:join(dir,'origin.sqlite'),normalToken:old,witnessToken:token(),rotationControlToken:control,studyFixture:'wrong-ticket-v1',sourceProtection:'scoped-v1'};
 let origin=await startOrigin(options), closed=false;const logs=[];
 const proxy=await startA2Asset({schemaVersion:A2_GUARDED_CONFIG_VERSION,authorityOrigin:origin.origin,port:0},{log:row=>logs.push(row)});
 t.after(async()=>{await proxy.close();if(!closed)await origin.close();rmSync(dir,{recursive:true,force:true});});
 const call=async(path,bearer,input)=>{const r=await fetch(origin.origin+path,{method:input?'POST':'GET',headers:{authorization:`Bearer ${bearer}`,...(input?{'content-type':'application/json'}:{})},body:input?JSON.stringify(input):undefined});return {status:r.status,body:await r.json()};};
 const read=(bearer,channel='MAIN',extra={})=>call('/source/read',bearer,{tenant:'reference',key:'deployment-manifest',channel,requestId:token(),...extra});
 const rotate=input=>call('/source/rotate',control,input);
 return {dir,old,next,control,read,rotate,call,logs,proxy,options,async restart(){await origin.close();origin=await startOrigin(options);},origin:()=>origin,async stopOrigin(){await origin.close();closed=true;}};
}
test('all source paths deny missing/fake credentials, tenant/resource mismatch and tickets; overview has no contents',async t=>{
 const f=await fixture(t);
 for(const channel of ['MAIN','A2','CACHE','EXPORT']) {
  for(const credential of ['',token(),'owner','wrong.ticket']) assert.equal((await f.read(credential,channel)).status,403);
  assert.equal((await f.read(f.old,channel,{tenant:'other'})).status,403);
  assert.equal((await f.read(f.old,channel,{key:'other-resource'})).status,403);
  assert.equal((await f.read(f.old,channel)).status,200);
 }
 const snapshot=await f.call('/business',f.old,{contextId:'ordinary',requestId:'overview',operation:'snapshot',args:{}});
 assert.equal(snapshot.status,200);assert(!JSON.stringify(snapshot).includes('release-9e18-green'));
 assert(snapshot.body.records.every(row=>Object.keys(row).join()==='key'));
 assert.equal((await f.call('/source/rotate',f.old,{operation:'lookup',actionId:'a'})).status,401);
});
test('rotation is durable, idempotent, all-path ready and never restores revoked credentials',async t=>{
 const f=await fixture(t);const prepare={operation:'prepare',actionId:'rotate-1',expectedEpoch:1,nextToken:f.next};
 assert.equal((await f.rotate(prepare)).status,200);
 assert.equal((await f.rotate({...prepare,nextToken:token()})).status,409);
 assert.equal((await f.rotate({operation:'commit',actionId:'rotate-1'})).status,400);
 for(const channel of ['MAIN','A2','CACHE','EXPORT']) assert.equal((await f.read(f.next,channel)).status,200);
 const commit=await f.rotate({operation:'commit',actionId:'rotate-1'});assert.equal(commit.body.status,'EFFECTIVE');
 assert.deepEqual((await f.rotate({operation:'commit',actionId:'rotate-1'})).body,commit.body);
 for(const channel of ['MAIN','A2','CACHE','EXPORT']) {assert.equal((await f.read(f.old,channel)).status,403);assert.equal((await f.read(f.next,channel)).status,200);}
 assert.equal((await f.rotate({operation:'abort',actionId:'rotate-1'})).status,403);
 await f.restart();assert.equal((await f.read(f.old)).status,403);assert.equal((await f.read(f.next)).status,200);
 const witness=await f.call('/source/witness',f.control);assert.equal(witness.body.epoch,2);assert.equal(witness.body.events.filter(e=>e.kind==='ROTATE_EFFECTIVE').length,1);
});
test('aborted next grant cannot satisfy readiness of a different grant reusing the epoch',async t=>{
 const f=await fixture(t);
 await f.rotate({operation:'prepare',actionId:'first',expectedEpoch:1,nextToken:f.next});
 for(const channel of ['MAIN','A2','CACHE','EXPORT']) await f.read(f.next,channel);
 await f.rotate({operation:'abort',actionId:'first'});assert.equal((await f.read(f.next)).status,403);
 await f.rotate({operation:'prepare',actionId:'second',expectedEpoch:1,nextToken:token()});
 assert.equal((await f.rotate({operation:'commit',actionId:'second'})).body.error.code,'ROTATION_CONSUMER_NOT_READY');
});
test('guarded lab defaults contain no A2 payload or control credentials and add only authority network',t=>{
 const root=mkdtempSync(join(tmpdir(),'dq-guarded-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const lab=prepareParticipantLab({directory:join(root,'lab'),studyFixture:'wrong-ticket-v1'});
 const a2=JSON.parse(readFileSync(join(lab.directory,'config/a2.json'),'utf8'));
 assert.equal(a2.schemaVersion,A2_GUARDED_CONFIG_VERSION);assert(!('contents' in a2));
 assert.deepEqual(lab.plan.graph.a2,['a2','source']);assert.deepEqual(lab.plan.graph.participant,['participant','a2']);
});

test('A2 HTTP relay never grants a role or serves cached content after rotation, and fails closed on source loss',async t=>{
 const f=await fixture(t);const base=`http://127.0.0.1:${f.proxy.port}`;
 const get=async(path,token,headers={})=>{const r=await fetch(base+path,{headers:{...(token?{authorization:`Bearer ${token}`} : {}),...headers}});return {status:r.status,headers:r.headers,body:await r.json()};};
 for(const path of ['/record','/cache','/export']) {
  assert.equal((await get(path,null,{'x-role':'owner'})).status,403);
  assert.equal((await get(path,'fake-ticket')).status,403);
  assert.equal((await get(path,f.old,{'x-tenant-id':'other'})).status,403);
  const accepted=await get(path,f.old);assert.equal(accepted.status,200);assert.equal(accepted.headers.get('cache-control'),'no-store');
 }
 await f.rotate({operation:'prepare',actionId:'proxy',expectedEpoch:1,nextToken:f.next});
 await f.read(f.next,'MAIN');
 for(const path of ['/record','/cache','/export']) assert.equal((await get(path,f.next)).status,200);
 assert.equal((await f.rotate({operation:'commit',actionId:'proxy'})).body.status,'EFFECTIVE');
 for(const path of ['/record','/cache','/export']) {const r=await get(path,f.old);assert.equal(r.status,403);assert(!('contents' in r.body));}
 assert.equal((await get('/source/rotate',f.old)).status,403);
 await f.stopOrigin();
 const unavailable=await get('/cache',f.next);assert.equal(unavailable.status,503);assert.equal(unavailable.body.error.code,'SOURCE_UNKNOWN');
});

test('prepared credentials expire and cannot commit after the bounded overlap',async()=>{
 const { DatabaseSync }=await import('node:sqlite');const { openSourceAuthority, SOURCE_SCHEMA }=await import('../runtime/source-authority.mjs');
 const db=new DatabaseSync(':memory:');db.exec(SOURCE_SCHEMA);let now=1000;const old=token(),next=token();
 try {
  const source=openSourceAuthority(db,{normalToken:old,clock:()=>now,initialize:true});
  source.rotate({operation:'prepare',actionId:'expire',expectedEpoch:1,nextToken:next});
  now+=300001;
  assert.equal(source.authorize({token:next,tenant:'reference',key:'deployment-manifest',channel:'A2',requestId:'expired'}).allowed,false);
  assert.throws(()=>source.rotate({operation:'commit',actionId:'expire'}),{code:'ROTATION_STALE'});
  assert.equal(source.status().epoch,1);
 } finally {db.close();}
});


test('missing authority state cannot resurrect the initial capability on reopen',async()=>{
 const { DatabaseSync }=await import('node:sqlite');const { openSourceAuthority, SOURCE_SCHEMA }=await import('../runtime/source-authority.mjs');
 const db=new DatabaseSync(':memory:');db.exec(SOURCE_SCHEMA);const normalToken=token();
 try {openSourceAuthority(db,{normalToken,initialize:true});db.exec('DELETE FROM source_authority');
  assert.throws(()=>openSourceAuthority(db,{normalToken}),{code:'SOURCE_AUTHORITY_STATE_MISSING'});
 } finally {db.close();}
});
