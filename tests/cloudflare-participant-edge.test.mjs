import test from 'node:test';
import assert from 'node:assert/strict';
import edge from '../deploy/cloudflare/participant-edge.mjs';
const good={LAB_ENABLED:'true',ENABLED_UNTIL:new Date(Date.now()+60000).toISOString(),TUNNEL_ORIGIN:'https://synthetic-test.trycloudflare.com'};
const request=(path='/',options={})=>new Request('https://dungeonq.talkidino.com'+path,options);
test('edge fail-closed route, expiry, origin and bounded upload prevent any outbound call',async()=>{
 const original=globalThis.fetch;let called=0;globalThis.fetch=async()=>{called++;throw Error('unexpected outbound')};
 try{
  assert.equal((await edge.fetch(request(),{})).status,503);
  assert.equal((await edge.fetch(request(),{...good,ENABLED_UNTIL:'2000-01-01'})).status,503);
  assert.equal((await edge.fetch(request(),{...good,TUNNEL_ORIGIN:'https://evil.example'})).status,503);
  assert.equal((await edge.fetch(request('/api/pitching/status'),good)).status,404);
  assert.equal((await edge.fetch(request('/api/operate',{method:'POST',body:'{}'}),good)).status,401);
  assert.equal((await edge.fetch(request('/',{headers:{Origin:'https://evil.example'}}),good)).status,403);
  assert.equal((await edge.fetch(request('/api/operate',{method:'POST',body:'x'.repeat(32769),headers:{Authorization:'Bearer '+'A'.repeat(43)}}),good)).status,502);
  assert.equal(called,0);
 }finally{globalThis.fetch=original;}
});
test('slow upload is cancelled at expiry and never creates an upstream request',async()=>{
 const original=globalThis.fetch;let called=0,cancelled=false;
 globalThis.fetch=async()=>{called++;return Response.json({ok:true});};
 try{
  const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}});
  const input=request('/api/operate',{method:'POST',body,duplex:'half',headers:{Authorization:'Bearer '+'A'.repeat(43)}});
  const r=await edge.fetch(input,{...good,ENABLED_UNTIL:new Date(Date.now()+40).toISOString()});
  assert.equal(r.status,503);assert.equal((await r.json()).error.code,'LAB_EXPIRED');assert.equal(called,0);assert.equal(cancelled,true);
 }finally{globalThis.fetch=original;}
});
test('edge uses fixed HTTPS upstream, strips authority headers and never follows redirects',async()=>{
 const original=globalThis.fetch;let seen;
 globalThis.fetch=async(url,options)=>{seen={url:String(url),options};return Response.json({ok:true},{headers:{'Set-Cookie':'secret=bad','X-Origin-Secret':'never-forward'}})};
 try{
  const r=await edge.fetch(request('/api/operate',{method:'POST',body:'{}',headers:{Authorization:'Bearer '+'A'.repeat(43),'Content-Type':'application/json',Cookie:'owner=bad','X-Forwarded-Host':'evil.example'}}),good);
  assert.equal(r.status,200);assert.equal(seen.url,'https://synthetic-test.trycloudflare.com/api/operate');assert.equal(seen.options.redirect,'manual');assert.equal(seen.options.headers.get('Cookie'),null);assert.equal(seen.options.headers.get('X-Forwarded-Host'),null);assert.equal(r.headers.get('Set-Cookie'),null);assert.equal(r.headers.get('X-Origin-Secret'),null);
  globalThis.fetch=async()=>new Response(null,{status:302,headers:{Location:'https://evil.example'}});
  assert.equal((await edge.fetch(request(),good)).status,502);
 }finally{globalThis.fetch=original;}
});
