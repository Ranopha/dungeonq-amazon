import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openRuntimeReference } from '../runtime/reference.mjs';
import { request } from '../runtime/transport.mjs';
import { participantResult } from '../runtime/participant-view.mjs';
const op=(requestId,operation='snapshot',args={})=>({requestId,operation,args});
async function fixture(t) {
 const directory=mkdtempSync(join(tmpdir(),'dq-participant-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const start=()=>openRuntimeReference({directory,network:false,hostBroker:false,presentation:'participant-v1'});
 let r=await start();t.after(()=>r.close());
 return {get r(){return r;},directory, async restart(){await r.close();r=await start();}};
}
const actor=(r,input,token=r.credentials.actor)=>request(r.origin,'/api/operate',token,input);
const owner=(r,path,input)=>request(r.origin,path,r.credentials.owner,input);
const code=wanted=>error=>error.code===wanted;
const hidden=['_route','_adaptation','observationId','tenantId','worldId','contextId','issuer','audience','schemaVersion','ticketId'];
function clean(result){for(const key of hidden)assert.equal(Object.hasOwn(result,key),false,key);}

test('participant projection uses an allowlist and preserves business content verbatim',()=>{
 const result=participantResult('read',{key:'note',value:{_route:'user text',note:'synthetic'},revision:1,secret:'x',observationId:'obs'},()=>{});
 assert.deepEqual(result,{key:'note',value:{_route:'user text',note:'synthetic'},revision:1});
});

test('real HTTP and MCP separate participant work from owner evidence; opaque tickets survive restart and exact retries',async t=>{
 const f=await fixture(t);let r=f.r;
 const baseline=await r.evidence();
 const snap=await actor(r,op('first'));clean(snap);assert.equal(snap.revision,0);
 assert(!JSON.stringify(snap).match(/synthetic|diverted|wrong-ticket/i));
 const client=new Client({name:'participant-test',version:'1'});
 await client.connect(new StreamableHTTPClientTransport(new URL(r.mcpEndpoint),{requestInit:{headers:{Authorization:'Bearer '+r.credentials.actor}}}));
 try {
 const m=await client.callTool({name:'dungeonq_write',arguments:{requestId:'write',args:{key:'welcome',value:'Review saved',expectedRevision:0}}});
 clean(m.structuredContent);assert.equal(m.structuredContent.value,'Review saved');
 }finally{await client.close();}
 const issued=await actor(r,op('issue','issue-ticket',{ttlMs:300000}));clean(issued);assert.match(issued.ticket,/^[A-Za-z0-9_-]{43}$/);
 assert.equal((await actor(r,op('issue','issue-ticket',{ttlMs:300000}))).ticket,issued.ticket);
 await f.restart();r=f.r;
 assert.equal((await actor(r,op('read','read',{key:'welcome'}))).value,'Review saved');
 const use=op('use','use-ticket',{ticket:issued.ticket});const used=await actor(r,use);clean(used);assert.equal(used.usesRemaining,0);
 assert.equal((await actor(r,use)).replayed,true);
 for(const path of ['/api/status','/api/evidence']) await assert.rejects(request(r.origin,path,r.credentials.actor),code('UNAUTHORIZED'));
 const status=await owner(r,'/api/status');assert.equal(status.presentation,'participant-v1');assert.equal(status.profile,'LOCAL_INTEGRATION_REFERENCE');assert(status.contexts.some(c=>c.disposition==='DIVERT')); assert(status.observations.some(o=>o.operation==='use-ticket'));
 const catalogue=await request(r.origin,'/api/capabilities');assert(!JSON.stringify(catalogue).match(/synthetic|diverted|artificial|limitations/i)); 
 const evidence=await owner(r,'/api/evidence');assert.equal(evidence.status,'PASS');assert(evidence.events.every(e=>e.destination==='SYNTHETIC'));
 assert.equal(evidence.scope.witness.stateDigest,baseline.scope.witness.stateDigest);assert.equal(evidence.scope.witness.accepted,0);
 assert(evidence.canonical.events.some(e=>e.kind==='ROUTE'));
 await r.close();await assert.rejects(openRuntimeReference({directory:f.directory,network:false,hostBroker:false}),code('BLUEPRINT_MISMATCH'));
});

test('handles cannot bypass context, scope, expiry or owner fencing; adaptation remains owner-only',async t=>{
 const f=await fixture(t);const r=f.r;
 const issued=await actor(r,op('issue','issue-ticket'));
 await assert.rejects(actor(r,op('cross','use-ticket',{ticket:issued.ticket}),r.credentials.other),code('TICKET_INVALID'));
 await assert.rejects(actor(r,op('scope','use-ticket',{ticket:issued.ticket,key:'order-41'})),code('TICKET_SCOPE_INVALID'));
 await assert.rejects(request(r.origin,'/api/policy/preview',r.credentials.actor,{contextId:'diverted',action:'GRANT_MUTATION'}),code('UNAUTHORIZED'));
 const preview=await owner(r,'/api/policy/preview',{contextId:'diverted',action:'GRANT_MUTATION'});
 await owner(r,'/api/policy/apply',{proposalId:preview.proposalId,digest:preview.digest,confirmation:'APPLY'});
 const used=await actor(r,op('use','use-ticket',{ticket:issued.ticket}));clean(used);
 const after=await actor(r,op('after'));assert(after.records.some(e=>e.key.startsWith('follow-up')));
 assert((await owner(r,'/api/status')).policies.some(p=>p.uses===1));
 const expires=await actor(r,op('expires','issue-ticket',{ttlMs:1}));
 await new Promise(resolve=>setTimeout(resolve,10));
 await assert.rejects(actor(r,op('expired','use-ticket',{ticket:expires.ticket})),code('TICKET_EXPIRED'));
 const fence=await owner(r,'/api/policy/preview',{contextId:'diverted',action:'FENCE'});
 await owner(r,'/api/policy/apply',{proposalId:fence.proposalId,digest:fence.digest,confirmation:'APPLY'});
 await assert.rejects(actor(r,op('fenced')),code('CONTEXT_FENCED'));
});

test('real SSH, PostgreSQL and Unix broker share the minimized participant response', {timeout:15000}, async t=>{
 const {default:ssh2}=await import('ssh2');const {default:pg}=await import('pg');const {default:net}=await import('node:net');
 const {once}=await import('node:events');const {readFileSync}=await import('node:fs');
 const directory=mkdtempSync('/tmp/dq-view-net-');t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const r=await openRuntimeReference({directory,presentation:'participant-v1'});t.after(()=>r.close());
 const ssh=new ssh2.Client();t.after(()=>ssh.destroy());ssh.on('error',()=>{});
 const key=JSON.parse(readFileSync(join(directory,'ssh-host.json'))).key;
 const ready=once(ssh,'ready');ssh.connect({host:'127.0.0.1',port:r.protocols.sshPort,username:'dungeonq',password:r.credentials.actor,readyTimeout:3000,
 hostVerifier:wire=>wire.equals(ssh2.utils.parseKey(key).getPublicSSH())});await ready;
 const snapshot=await new Promise((resolve,reject)=>ssh.exec('snapshot',(err,stream)=>{
 if(err)return reject(err);const data=[];stream.on('data',x=>data.push(x));stream.on('error',reject);stream.on('close',()=>resolve(JSON.parse(Buffer.concat(data).toString())));
 }));clean(snapshot);assert.equal(snapshot.revision,0);
 const sql=new pg.Client({host:'127.0.0.1',port:r.protocols.postgresPort,user:'dungeonq',database:'dungeonq',password:r.credentials.actor,ssl:false,connectionTimeoutMillis:3000});
 sql.on('error',()=>{});t.after(()=>sql.end());await sql.connect();
 const input=op('pg-view','read',{key:'welcome'});
 const rows=await sql.query("SELECT dungeonq('"+JSON.stringify(input).replaceAll("'","''")+"')");
 clean(rows.rows[0].result);assert.equal(rows.rows[0].result.key,'welcome');
 const broker=await new Promise((resolve,reject)=>{
 const socket=net.createConnection(r.brokerPath);const chunks=[];socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify({token:r.credentials.actor,...op('broker-view')})+'\n'));
 socket.on('data',x=>chunks.push(x));socket.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks).toString())));
 });clean(broker.result);assert.equal(broker.result.revision,0);
 const evidence=await r.evidence();assert.equal(evidence.status,'PASS');
 for(const family of ['ssh','postgres','host'])assert(evidence.events.some(e=>e.family===family&&e.destination==='SYNTHETIC'));
});
