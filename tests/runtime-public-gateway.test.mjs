import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRuntimeReference } from '../runtime/reference.mjs';
import { startPublicGateway } from '../runtime/public-gateway.mjs';

const publicOrigin = 'https://dungeonq.talkidino.com';
const op = (requestId, operation = 'snapshot', args = {}) => ({ requestId, operation, args });
const credentials = () => Object.fromEntries(['owner','actor','other','ordinary','seal','producer','reader','witness'].map((key,index) => [key, String.fromCharCode(65 + index).repeat(43)]));
function writeConfig(directory, creds, runtimeOrigin, mcpOrigin, options = {}) {
  const credentialsPath = join(directory, 'credentials.json');
  writeFileSync(credentialsPath, JSON.stringify(creds), { mode: 0o600 });
  const path = join(directory, 'public-gateway.json');
  const config = { schemaVersion:'dungeonq.public-gateway/v1', publicOrigin, basePath:'', runtimeOrigin, mcpOrigin, credentialsPath, participantNames:['actor'], ...options };
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 }); return { path, config };
}
function send(gateway, path, { method = 'GET', token, value, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = raw ?? (value === undefined ? undefined : JSON.stringify(value));
    const url = new URL(gateway.origin);
    const request = http.request({ hostname:'127.0.0.1', port:url.port, path, method,
      headers:{ Host:new URL(publicOrigin).host, ...(token ? {Authorization:`Bearer ${token}`} : {}),
        ...(encoded === undefined ? {} : {'Content-Type':'application/json','Content-Length':Buffer.byteLength(encoded)}), ...headers } }, response => {
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{
        const text=Buffer.concat(chunks).toString();let value;try{value=JSON.parse(text);}catch{}
        resolve({status:response.statusCode,headers:response.headers,text,value});
      });
    });request.on('error',reject);request.end(encoded);
  });
}
async function runtimeFixture(t, prefix = '', options = {}) {
  const directory=mkdtempSync(join(tmpdir(),'dq-public-gateway-'));
  const reference=await openRuntimeReference({directory:join(directory,'lab'),presentation:'pitching-v1',network:false,hostBroker:false,...options});
  const config=writeConfig(directory,reference.credentials,reference.origin,new URL(reference.mcpEndpoint).origin,{basePath:prefix});
  const gateway=await startPublicGateway({configPath:config.path});
  t.after(async()=>{await gateway.close();await reference.close();rmSync(directory,{recursive:true,force:true});});
  return {gateway,reference,...config};
}
async function stubFixture(t, handler, limits = {}, configOptions = {}) {
  const directory=mkdtempSync(join(tmpdir(),'dq-public-stub-'));const creds=credentials();const calls=[];
  const server=http.createServer((req,res)=>{
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
      calls.push({path:req.url,headers:req.headers,body:Buffer.concat(chunks).toString()});
      if(req.url==='/api/capabilities'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({schemaVersion:'workspace.capabilities/v1'}));}
      else handler(req,res);
    });
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const runtimeOrigin=`http://127.0.0.1:${server.address().port}`;
  const cfg=writeConfig(directory,creds,runtimeOrigin,'http://127.0.0.1:1',configOptions);
  const gateway=await startPublicGateway({configPath:cfg.path,limits});
  t.after(async()=>{await gateway.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});rmSync(directory,{recursive:true,force:true});});
  return {gateway,creds,calls,...cfg};
}

test('real participant HTTP reads, writes, write-status and finite reveals work through the gateway',async t=>{
  const f=await runtimeFixture(t);const token=f.reference.credentials.actor;const before=await f.reference.evidence();
  const call=input=>send(f.gateway,'/api/operate',{method:'POST',token,value:input});
  const snapshot=await call(op('initial'));assert.equal(snapshot.status,200);assert.equal(snapshot.value.records.length,3);
  assert.equal((await send(f.gateway,'/api/capabilities',{token})).value.schemaVersion,'workspace.capabilities/v1');
  await call(op('current','read',{key:'catalog-current'}));await call(op('prior','read',{key:'catalog-prior'}));
  const ticket=await call(op('issue','issue-ticket',{scope:['catalog-current']}));
  const reveal=await call(op('use','use-ticket',{ticket:ticket.value.ticket,key:'catalog-current'}));assert.equal(reveal.value.revealed.key,'history-delta');
  const write=op('note','write',{key:'note-public',value:'Synthetic HTTPS test note',expectedRevision:1});
  assert.equal((await call(write)).value.revision,2);
  assert.equal((await call(op('readback','read',{key:'note-public'}))).value.value,write.args.value);
  const status=await send(f.gateway,'/api/write-status',{method:'POST',token,value:write});assert.equal(status.value.state,'COMMITTED');
  const after=await f.reference.evidence();assert.equal(after.scope.witness.stateDigest,before.scope.witness.stateDigest);assert.equal(after.scope.witness.accepted,0);
  assert.doesNotMatch(JSON.stringify(snapshot.value),/groundTruth|policyVersion|seed|_route/);
  assert.equal(snapshot.headers['x-frame-options'],'DENY');assert.match(snapshot.headers['content-security-policy'],/frame-ancestors 'none'/);
});

test('v2 pending and reveals traverse the real public prefix gateway over HTTP and MCP without owner fields', async t => {
  const f = await runtimeFixture(t, '/dungeonq', { pitchingVariant: 'clues-v2', pitchingSeed: 29 });
  const token = f.reference.credentials.actor; let serial = 0;
  const call = async (operation, args = {}, id = `v2-http-${++serial}`) => {
    const response = await send(f.gateway, '/dungeonq/api/operate', { method: 'POST', token, value: op(id, operation, args) });
    assert.equal(response.status, 200, response.text); return response.value;
  };
  const rpc = async (method, params) => {
    const response = await send(f.gateway, '/dungeonq/mcp', { method: 'POST', token,
      value: { jsonrpc: '2.0', id: ++serial, method, params }, headers: { Origin: publicOrigin } });
    assert.equal(response.status, 200, response.text); return response.value.result;
  };
  const use = async (key, id) => {
    const ticket = await call('issue-ticket', { scope: [key] }); return call('use-ticket', { key, ticket: ticket.ticket }, id);
  };
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'v2-fixture', version: '1' } });
  const pending = await use('catalog-current', 'v2-pending'); assert.equal(pending.progress.status, 'PENDING');
  const exposed = await rpc('tools/call', { name: 'dungeonq_read', arguments: { requestId: 'v2-mcp-current', args: { key: 'catalog-current' } } });
  assert.equal(exposed.structuredContent.progress.status, 'PENDING');
  const history = await call('read', { key: 'catalog-prior' }); assert.equal(history.revealed.value.evidenceKind, 'EFFECTIVE_WINDOW_SCHEDULE');
  const nextPending = await use(history.revealed.key); assert.equal(nextPending.progress.status, 'PENDING');
  const second = await call('snapshot'); assert.equal(second.revealed.value.evidenceKind, 'SOURCE_LINEAGE');
  assert.equal(second.progress.completed, 2); assert.ok(second.records.some(row => row.key === second.revealed.key));
  const args = { key: 'note-public', value: 'UNKNOWN pending further evidence', expectedRevision: second.revision };
  const written = await call('write', args, 'v2-write'); assert.equal(written.revision, second.revision + 1);
  await use(args.key);
  const receipt = await rpc('tools/call', { name: 'dungeonq_read', arguments: { requestId: 'v2-mcp-note', args: { key: args.key } } });
  assert.equal(receipt.structuredContent.progress.completed, 3); assert.equal(receipt.structuredContent.revealed.key, 'persistence-journal');
  const complete = await use(receipt.structuredContent.revealed.key); assert.equal(complete.progress.status, 'COMPLETE');
  assert.equal(complete.revealed.value.checkKind, 'PREDECESSOR_LINK');
  const status = await send(f.gateway, '/dungeonq/api/write-status', { method: 'POST', token, value: op('v2-write', 'write', args) });
  assert.equal(status.value.state, 'COMMITTED'); assert.deepEqual(status.value.result, written);
  for (const result of [pending, exposed, history, nextPending, second, written, receipt, complete, status.value])
    assert.doesNotMatch(JSON.stringify(result), /groundTruth|policyDigest|blueprintDigest|authorizationRequestId|authorizationObservationId|transitionKey|"decisions"|"seed"/);
  const denied = await send(f.gateway, '/dungeonq/api/status', { token }); assert.equal(denied.status, 404);
  const evidence = await f.reference.evidence(); assert.equal(evidence.status, 'PASS');
});

test('MCP accepts JSON-only initialization and tools, rejects batches, unknown tools and authority fields',async t=>{
  const f=await runtimeFixture(t);const token=f.reference.credentials.actor;
  const rpc=value=>send(f.gateway,'/mcp',{method:'POST',token,value,headers:{Origin:publicOrigin}});
  const initialized=await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'public-gateway-test',version:'1'}}});
  assert.equal(initialized.status,200);assert.equal(initialized.value.result.serverInfo.name,'dungeonq-runtime');
  const tools=await rpc({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});assert.equal(tools.value.result.tools.length,5);
  const read=await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'dungeonq_read',arguments:{requestId:'mcp-read',args:{key:'welcome'}}}});
  assert.equal(read.status,200);assert.equal(read.value.result.structuredContent.key,'welcome');
  for(const value of [[{jsonrpc:'2.0',id:4,method:'tools/list'}],{jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'owner_status',arguments:{requestId:'bad',args:{}}}},
    {jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'dungeonq_read',arguments:{requestId:'bad',args:{key:'welcome'},token:f.reference.credentials.owner}}}])
    assert.equal((await rpc(value)).status,400);
  assert.equal((await send(f.gateway,'/mcp',{token})).status,405);
});

test('route and token allowlists reject owner, ordinary, other, unknown, method and body overrides',async t=>{
  const f=await runtimeFixture(t);const actor=f.reference.credentials.actor;
  for(const path of ['/api/status','/api/evidence','/api/operator/write-status','/api/policy/apply','/api/pitching/status','/runtime/','/runtime/index.html','/runtime/app.mjs','/execute','/write-status'])
    assert.equal((await send(f.gateway,path,{token:actor})).status,404,path);
  for(const token of [undefined,f.reference.credentials.owner,f.reference.credentials.ordinary,f.reference.credentials.other,'Z'.repeat(43)])
    assert.equal((await send(f.gateway,'/api/operate',{method:'POST',token,value:op('denied')})).status,401);
  assert.equal((await send(f.gateway,'/api/capabilities')).status,401);
  assert.equal((await send(f.gateway,'/api/operate',{token:actor})).status,405);
  assert.equal((await send(f.gateway,'/api/operate',{method:'POST',token:actor,value:{...op('override'),token:f.reference.credentials.owner}})).status,400);
  assert.equal((await send(f.gateway,'/api/operate',{method:'POST',token:actor,value:{...op('context'),contextId:'ordinary'}})).status,400);
  assert.equal((await send(f.gateway,'/runtime/participant.html',{token:f.reference.credentials.ordinary})).status,401);
});

test('Host and Origin are exact, ambiguous paths and content encodings are denied, forwarding headers never select upstream',async t=>{
  const f=await stubFixture(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':'owner=bad','Location':'http://127.0.0.1:99'});res.end('{"revision":0}');});
  const valid={method:'POST',token:f.creds.actor,value:op('test')};
  for(const headers of [{Host:'evil.example'},{Host:'dungeonq.talkidino.com:443'},{Origin:'https://evil.example'},{Origin:'null'},{Origin:publicOrigin+'/'}, {'Content-Encoding':'identity'}])
    assert.ok((await send(f.gateway,'/api/operate',{...valid,headers})).status>=400);
  for(const path of ['/api/operate?x=1','/api/%6fperate','//api/operate','/api/../api/operate','http://evil.example/api/operate','/dungeonq/api/operate'])
    assert.equal((await send(f.gateway,path,valid)).status,404,path);
  const served=await send(f.gateway,'/api/operate',{...valid,headers:{Origin:publicOrigin,'X-Forwarded-Host':'evil.example','X-Forwarded-Proto':'http',Forwarded:'host=evil.example','Cookie':'owner=bad'}});
  assert.equal(served.status,200);const received=f.calls.at(-1);
  assert.equal(received.headers.host,new URL(f.config.runtimeOrigin).host);assert.equal(received.headers.origin,f.config.runtimeOrigin);
  for(const name of ['x-forwarded-host','x-forwarded-proto','forwarded','cookie'])assert.equal(received.headers[name],undefined);
  assert.equal(served.headers['set-cookie'],undefined);assert.equal(served.headers.location,undefined);
});

test('upstream redirects, compression, SSE, large responses, raw errors and timeout fail closed',async t=>{
  let mode='redirect';let effects=0;
  const f=await stubFixture(t,(_req,res)=>{
    effects++;
    if(mode==='redirect'){res.writeHead(302,{Location:'http://127.0.0.1:99/admin'});res.end();}
    if(mode==='compressed'){res.writeHead(200,{'Content-Type':'application/json','Content-Encoding':'gzip'});res.end('secret');}
    if(mode==='sse'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: secret\n\n');}
    if(mode==='large'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({value:'x'.repeat(1000)}));}
    if(mode==='error'){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'FAILED',message:'secret http://127.0.0.1:99',token:f.creds.owner}}));}
    if(mode==='disconnect'){res.destroy();return;}
    if(mode==='timeout')return;
  },{maxResponseBytes:512,timeoutMs:100});
  for(const candidate of ['redirect','compressed','sse','large','error','disconnect','timeout']){
    mode=candidate;const response=await send(f.gateway,'/api/operate',{method:'POST',token:f.creds.actor,value:op(candidate)});
    assert.ok(response.status>=500,candidate);assert.doesNotMatch(response.text,/127\.0\.0\.1|secret/);assert.equal(response.text.includes(f.creds.owner),false);
  }
  assert.equal(effects,7,'there are no redirects, retries or alternate origins');
});

test('proxy request, concurrency and body budgets remain finite',async t=>{
  let release;const held=new Promise(resolve=>{release=resolve;});let entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const f=await stubFixture(t,async(_req,res)=>{entered();await held;res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');},{maxConcurrent:1,maxRequests:4,maxBodyBytes:128});
  const first=send(f.gateway,'/api/operate',{method:'POST',token:f.creds.actor,value:op('first')});await started;
  assert.equal((await send(f.gateway,'/api/capabilities',{token:f.creds.actor})).status,429);release();assert.equal((await first).status,200);
  assert.equal((await send(f.gateway,'/api/operate',{method:'POST',token:f.creds.actor,raw:'x'.repeat(129)})).status,413);
  assert.equal((await send(f.gateway,'/api/capabilities',{token:f.creds.actor})).status,200);
  assert.equal((await send(f.gateway,'/api/capabilities',{token:f.creds.actor})).status,429);
});

test('optional fixed path prefix rewrites only participant assets and does not open root APIs',async t=>{
  const f=await runtimeFixture(t,'/dungeonq');
  const page=await send(f.gateway,'/dungeonq/runtime/participant.html');assert.equal(page.status,200);assert.match(page.text,/src="\/dungeonq\/runtime\/participant.mjs"/);
  const module=await send(f.gateway,'/dungeonq/runtime/participant.mjs');assert.match(module.text,/from '\/dungeonq\/runtime\/client.mjs'/);
  const client=await send(f.gateway,'/dungeonq/runtime/client.mjs');assert.match(client.text,/const base = originOf\(origin\) \+ "\/dungeonq"/);
  assert.equal((await send(f.gateway,'/api/operate',{method:'POST',token:f.reference.credentials.actor,value:op('root')})).status,404);
  assert.equal((await send(f.gateway,'/dungeonq/api/operate',{method:'POST',token:f.reference.credentials.actor,value:op('prefix')})).status,200);
  for(const path of ['/dungeonq/runtime/styles.css','/dungeonq/runtime/participant.css'])assert.equal((await send(f.gateway,path)).status,200);
});

test('configuration cannot allow owner/ordinary credentials, token collisions, non-loopback upstreams or public files',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'dq-public-config-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const creds=credentials();
  for(const overrides of [{participantNames:['owner']},{participantNames:['ordinary']},{runtimeOrigin:'https://example.com'},
    {runtimeOrigin:'http://localhost:1234'},{publicOrigin:publicOrigin+'/path'},{basePath:'/arbitrary'}]){
    const config=writeConfig(directory,creds,'http://127.0.0.1:1234','http://127.0.0.1:2345',overrides);
    await assert.rejects(startPublicGateway({configPath:config.path}));
  }
  const collision=writeConfig(directory,{...creds,actor:creds.ordinary},'http://127.0.0.1:1234','http://127.0.0.1:2345');
  await assert.rejects(startPublicGateway({configPath:collision.path}),{code:'CONFIG_CREDENTIAL_COLLISION'});
  const cfg=writeConfig(directory,creds,'http://127.0.0.1:1234','http://127.0.0.1:2345');chmodSync(cfg.path,0o644);
  await assert.rejects(startPublicGateway({configPath:cfg.path}),{code:'CONFIG_NOT_PRIVATE'});
});
