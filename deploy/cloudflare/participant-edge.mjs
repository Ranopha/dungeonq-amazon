// 無任何 AI、KV、R2、D1 或服務 binding；上游只能由部署者設定。
const HOST = 'dungeonq.talkidino.com';
const PATHS = new Map([
  ['/', 'GET'], ['/runtime/participant.html','GET'], ['/runtime/participant.mjs','GET'],
  ['/runtime/client.mjs','GET'], ['/runtime/participant.css','GET'], ['/runtime/styles.css','GET'],
  ['/api/capabilities','GET'], ['/api/operate','POST'], ['/api/write-status','POST'], ['/mcp','POST'],
]);
function reject(code, status) { return Response.json({error:{code}}, {status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Strict-Transport-Security':'max-age=86400'}}); }
async function bounded(stream, max, signal) {
  if(!stream) return new Uint8Array();
  const reader=stream.getReader(); const parts=[]; let size=0;
  let abort;
  const deadline=new Promise((_,reject)=>{abort=()=>reject(Error('DEADLINE'));signal.addEventListener('abort',abort,{once:true});});
  try {
    if(signal.aborted) throw Error('DEADLINE');
    for(;;) { const {done,value}=await Promise.race([reader.read(),deadline]); if(done)break; size+=value.byteLength; if(size>max) throw Error('SIZE_LIMIT'); parts.push(value); }
  } finally { signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{}); }
  const out=new Uint8Array(size);let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;
}
export default {
  async fetch(request, env) {
    const url=new URL(request.url);
    if(url.protocol!=='https:' || url.hostname!==HOST || url.port || url.search) return reject('PUBLIC_ROUTE_DENIED',404);
    const method=PATHS.get(url.pathname);
    if(!method) return reject('PUBLIC_ROUTE_DENIED',404);
    if(request.method!==method) return reject('METHOD_DENIED',405);
    const origin=request.headers.get('Origin');
    if(origin && origin!==`https://${HOST}`) return reject('ORIGIN_DENIED',403);
    if(request.headers.has('Content-Encoding')) return reject('CONTENT_ENCODING_DENIED',415);
    const end=Date.parse(env.ENABLED_UNTIL || '');
    if(env.LAB_ENABLED!=='true') return reject('LAB_PAUSED',503);
    if(!Number.isFinite(end) || end<=Date.now()) return reject('LAB_EXPIRED',503);
    let upstream;
    try { upstream=new URL(env.TUNNEL_ORIGIN); } catch { return reject('UPSTREAM_CONFIG_INVALID',503); }
    if(upstream.protocol!=='https:' || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(upstream.hostname)
      || upstream.port || upstream.username || upstream.password || upstream.pathname!=='/' || upstream.search || upstream.hash) return reject('UPSTREAM_CONFIG_INVALID',503);
    const authorization=request.headers.get('Authorization');
    const api=url.pathname.startsWith('/api/') || url.pathname==='/mcp';
    if((api || authorization) && !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization || '')) return reject('PARTICIPANT_AUTH_REQUIRED',401);
    const headers=new Headers({'Accept':'application/json, text/event-stream','Accept-Encoding':'identity'});
    if(authorization) headers.set('Authorization',authorization);
    if(origin) headers.set('Origin',origin);
    for(const name of ['Content-Type','MCP-Protocol-Version','Sec-Fetch-Site'])if(request.headers.has(name))headers.set(name,request.headers.get(name));
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(9000,end-Date.now())));
    try {
      const data=method==='POST'?await bounded(request.body,32768,controller.signal):undefined;
      if(method==='GET' && request.body) return reject('BODY_DENIED',400);
      if(Date.now()>=end || controller.signal.aborted) return reject('LAB_EXPIRED',503);
      upstream.pathname=url.pathname;
      const response=await fetch(upstream,{method,headers,body:data,redirect:'manual',signal:controller.signal});
      if(response.status>=300&&response.status<400) return reject('UPSTREAM_REDIRECT_DENIED',502);
      const output=await bounded(response.body,524288,controller.signal);
      const outgoing=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Strict-Transport-Security':'max-age=86400'});
      for(const name of ['Content-Type','Content-Security-Policy','X-Frame-Options','Referrer-Policy','Permissions-Policy','Cross-Origin-Resource-Policy'])if(response.headers.has(name))outgoing.set(name,response.headers.get(name));
      return new Response(output,{status:response.status,headers:outgoing});
    } catch { return reject(Date.now()>=end?'LAB_EXPIRED':'PUBLIC_GATEWAY_UNAVAILABLE',Date.now()>=end?503:502); }
    finally { clearTimeout(timer); }
  }
};
