import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import ssh2 from 'ssh2';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openRuntimeReference } from './reference.mjs';
import { request, digest } from './transport.mjs';
import { createRuntimeClient } from '../sdk/runtime-client.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export function childJson(executable, args, input, options={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{stdio:['pipe','pipe','pipe'],...options});
    let out='',err='';const timer=setTimeout(()=>{child.kill();reject(Error('Child timeout'));},15000);
    child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err=(err+c).slice(-1500));
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);try{if(code!==0)throw Error('Child failed: '+err);resolve(JSON.parse(out));}catch(e){reject(e);}});
    child.stdin.end(JSON.stringify(input));
  });
}
export async function brokerCall(path,input) {
  return new Promise((resolve,reject)=>{
    const socket=net.connect(path);let data='';socket.setTimeout(5000,()=>socket.destroy(Error('Broker timeout')));
    socket.on('connect',()=>socket.write(JSON.stringify(input)+'\n'));socket.on('data',c=>data+=c);socket.on('error',reject);
    socket.on('end',()=>{try{const v=JSON.parse(data);if(v.error)throw Object.assign(Error(v.error.code),v.error);resolve(v.result);}catch(e){reject(e);}});
  });
}
export async function runReferenceAcceptance() {
  const startedAt=new Date().toISOString();const directory=mkdtempSync(join(tmpdir(),'dq-accept-'));
  const details={};let runtime;let ssh;let sql;let mcp;let n=0;
  const op=(operation,args={},requestId='rehearsal-'+(++n))=>({requestId,operation,args});
  const mark=(id,value)=>details[id]={status:'PASS',...value};
  try {
    runtime=await openRuntimeReference({directory});
    const api=(v,token=runtime.credentials.actor)=>request(runtime.origin,'/api/operate',token,v);
    const owner=(path,value)=>request(runtime.origin,path,runtime.credentials.owner,value);
    const js=createRuntimeClient({origin:runtime.origin,token:runtime.credentials.actor});
    const first=await js.operate(op('snapshot'));assert.equal(first._route.destination,'SYNTHETIC');
    assert.equal((await api(op('write',{key:'welcome',value:'Persisted synthetic record',expectedRevision:0},'write-once'))).revision,1);
    mark('http',{client:'JavaScript SDK',destination:'SYNTHETIC'});
    mcp=new Client({name:'dungeonq-acceptance',version:'1.0.0'});
    await mcp.connect(new StreamableHTTPClientTransport(new URL(runtime.mcpEndpoint),{requestInit:{headers:{Authorization:'Bearer '+runtime.credentials.actor}}}));
    const listed=await mcp.listTools();assert.equal(listed.tools.length,5);assert(!listed.tools.some(t=>/apply|approve|fence/.test(t.name)));
    const m=await mcp.callTool({name:'dungeonq_read',arguments:{requestId:'mcp-read',args:{key:'welcome'}}});
    assert.equal(m.structuredContent.value,'Persisted synthetic record');assert.equal(m.structuredContent._route.family,'mcp');
    mark('mcp',{client:'MCP SDK Streamable HTTP',toolCount:listed.tools.length});
    const key=JSON.parse(readFileSync(join(directory,'ssh-host.json'),'utf8')).key;
    ssh=new ssh2.Client();ssh.on('error',()=>{});const ready=once(ssh,'ready');
    ssh.connect({host:'127.0.0.1',port:runtime.protocols.sshPort,username:'dungeonq',password:runtime.credentials.actor,
      hostVerifier:k=>k.equals(ssh2.utils.parseKey(key).getPublicSSH()),readyTimeout:3000});await ready;
    const executeSSH=v=>new Promise((resolve,reject)=>ssh.exec('dq '+JSON.stringify(v),(e,stream)=>{
      if(e)return reject(e);let value='';stream.on('data',c=>value+=c);stream.on('error',reject);stream.on('close',code=>{try{assert.equal(code,0);resolve(JSON.parse(value));}catch(e){reject(e);}});
    }));
    const ticket=await executeSSH(op('issue-ticket'));
    assert.equal(ticket._route.family,'ssh');mark('ssh',{client:'ssh2',hostKeyPinned:true});
    sql=new pg.Client({host:'127.0.0.1',port:runtime.protocols.postgresPort,user:'dungeonq',database:'dungeonq',password:runtime.credentials.actor,connectionTimeoutMillis:3000,query_timeout:5000});
    sql.on('error',()=>{});await sql.connect();
    const query=v=>sql.query(`SELECT dungeonq('${JSON.stringify(v).replaceAll("'","''")}')`);
    const used=(await query(op('use-ticket',{ticket:ticket.ticket},'ticket-once'))).rows[0].result;
    assert.equal(used.value,'Persisted synthetic record');assert.equal(used._route.family,'postgres');
    mark('postgres',{client:'pg',profile:'bounded simple-query operation'});
    const local=await brokerCall(runtime.brokerPath,{token:runtime.credentials.actor,...op('read',{key:'welcome'})});assert.equal(local.value,'Persisted synthetic record');
    const protectedPath=join(directory,'protected-fixture.txt');writeFileSync(protectedPath,'Artificial protected value',{mode:0o600});
    const child=await childJson(process.execPath,['--permission','--input-type=module','-e',`
      import fs from 'node:fs'; import net from 'node:net';let input='';for await(const c of process.stdin)input+=c;const p=JSON.parse(input);
      let denied=false;try{fs.readFileSync(p.protectedPath);}catch(e){denied=e.code==='ERR_ACCESS_DENIED';}
      const s=net.connect(p.socket);let data='';s.on('connect',()=>s.write(JSON.stringify(p.message)+'\\n'));s.on('data',c=>data+=c);
      s.on('end',()=>{console.log(JSON.stringify({denied,response:JSON.parse(data)}));});s.on('error',()=>process.exit(1));
    `],{protectedPath,socket:runtime.brokerPath,message:{token:runtime.credentials.actor,...op('snapshot')}});
    assert(child.denied);assert.equal(child.response.result._route.family,'host');
    mark('host',{client:'Node managed subprocess',directFileRead:'DENIED',mediatedRequest:'SERVED',boundary:'Node permission restriction; not hostile-code OS isolation'});
    const python=process.env.DUNGEONQ_TEST_PYTHON??'python3';
    const py=await childJson(python,['-c',`import importlib.util,json,sys
p=json.load(sys.stdin)
s=importlib.util.spec_from_file_location('dq',p['module']);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.RuntimeClient(p['origin'],p['token']).operate('python-read','read',{'key':'welcome'})))`],{module:join(root,'sdk/runtime-client.py'),origin:runtime.origin,token:runtime.credentials.actor});
    assert.equal(py.value,'Persisted synthetic record');details.http.clients=['JavaScript SDK','Python SDK'];
    const preview=await owner('/api/policy/preview',{contextId:'diverted',action:'GRANT_MUTATION'});
    const approval={proposalId:preview.proposalId,digest:preview.digest,confirmation:'APPLY'};
    await owner('/api/policy/apply',approval);const repeated=await owner('/api/policy/apply',approval);assert.equal(repeated.state,'APPLIED');
    const issued=await api(op('issue-ticket'));
    const adaptive=await api(op('use-ticket',{ticket:issued.ticket},'adaptive-once'));assert.equal(adaptive._adaptation.template,'follow-up');assert.equal(adaptive._adaptation.revision,2);
    mark('mutation',{policy:'owner preview/apply',observation:'ticket use',budget:8,mutations:1});
    const ordinary=await api(op('read',{key:'welcome'}),runtime.credentials.ordinary);assert.equal(ordinary._route.destination,'ORIGIN');
    const beforeRestart=await runtime.evidence();assert.equal(beforeRestart.status,'PASS');details.evidence=beforeRestart;
    await mcp.close();mcp=null;ssh.destroy();ssh=null;await sql.end();sql=null;
    await runtime.close();runtime=await openRuntimeReference({directory});
    const saved=await api(op('snapshot'));assert.equal(saved.revision,2);assert(saved.records.some(r=>r.value==='Persisted synthetic record'));
    const retry=await api(op('use-ticket',{ticket:issued.ticket},'adaptive-once'));assert.equal(retry.replayed,true);assert.equal((await api(op('snapshot'))).revision,2);
    const after=await runtime.evidence();assert.equal(after.status,'PASS');
    mark('persistence',{restart:true,revision:2,replayedWithoutSecondEffect:true});mark('wrong-ticket',{crossProtocol:'SSH to PostgreSQL',durableConsumption:true,restartReplay:true});
    mark('origin-untouched',{scope:'artificial-origin',checks:after.checks,acceptedOrdinary:after.scope.witness.accepted,divertedAdmissions:0});
    details.evidence=after;
    // Bounded invalid-input rehearsal only. Negative fixtures never authorize a real operation.
    const rejects=[];
    async function denied(name,call) {await assert.rejects(call);rejects.push(name);}
    await denied('forged-identity',()=>api(op('snapshot'),'unregistered-reference-token'));
    await denied('participant-self-approval',()=>request(runtime.origin,'/api/policy/preview',runtime.credentials.actor,{contextId:'diverted',action:'FENCE'}));
    await denied('conflicting-route-hint',()=>api({...op('snapshot'),destination:'ORIGIN'}));
    await denied('forged-canonical-evidence',()=>request(runtime.facadeService.origin,'/effect',undefined,{body:{contextId:'diverted'},mac:'invalid-proof'}));
    await denied('ticket-cross-tenant',()=>api(op('use-ticket',{ticket:issued.ticket}),runtime.credentials.other));
    await denied('ticket-new-request-replay',()=>api(op('use-ticket',{ticket:issued.ticket})));
    await denied('synthetic-to-origin',()=>request(runtime.originService.origin,'/business',issued.ticket,{contextId:'diverted',...op('read',{key:'welcome'})}));
    const stale=await owner('/api/policy/preview',{contextId:'diverted',action:'FENCE'});
    await api(op('write',{key:'note',value:'Untrusted reference note requesting operator authority',expectedRevision:2}));
    await denied('stale-approval',()=>owner('/api/policy/apply',{proposalId:stale.proposalId,digest:stale.digest,confirmation:'APPLY'}));
    assert.equal((await owner('/api/status')).contexts.find(c=>c.contextId==='diverted').state,'ACTIVE');
    rejects.push('untrusted-instructions-remain-passive-data');
    const fence=await owner('/api/policy/preview',{contextId:'diverted',action:'FENCE'});
    await owner('/api/policy/apply',{proposalId:fence.proposalId,digest:fence.digest,confirmation:'APPLY'});
    await denied('fenced-context',()=>api(op('snapshot')));
    await runtime.close();runtime=await openRuntimeReference({directory});
    await denied('fence-survives-restart',()=>api(op('snapshot')));
    await runtime.collectorService.close();assert.notEqual((await runtime.evidence()).status,'PASS');rejects.push('missing-evidence-fails-closed');
    mark('adversarial',{cases:rejects,scope:'owned reference invalid inputs; no exploit payloads or live model'});
    return {startedAt,finishedAt:new Date().toISOString(),details};
  } finally {
    await mcp?.close().catch(()=>{});ssh?.destroy();await sql?.end().catch(()=>{});await runtime?.close();rmSync(directory,{recursive:true,force:true});
  }
}
