// Trusted fixed client for the isolated lab; never supplied as a model-selectable tool.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
const options = JSON.parse(process.argv[1]);
const participant = options.role === 'participant';
const config = JSON.parse(readFileSync(participant ? '/run/participant/participant.json' : '/run/dungeonq/origin.json','utf8'));
const paths = { MAIN: '/business', A2: '/record', CACHE: '/cache', EXPORT: '/export' };
const request = async (url, token, payload, headers = {}) => {
 const start = Date.now();
 try {
  const response = await fetch(url,{method:payload?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(4500),headers:{...(token?{authorization:`Bearer ${token}`} : {}),'x-request-id':'consumer-'+randomUUID(),...(payload?{'content-type':'application/json'}:{}),...headers},body:payload?JSON.stringify(payload):undefined});
  return {status:response.status,body:await response.json(),at:Date.now(),latencyMs:Date.now()-start};
 } catch { return {status:503,body:{error:{code:'SOURCE_UNKNOWN'}},at:Date.now(),latencyMs:Date.now()-start}; }
};
let result;
if(participant) {
 const token = options.credential === 'missing' ? undefined : options.credential === 'fake' ? 'owner' : options.credential === 'ticket' ? options.ticket : config.token;
 if(options.action === 'workspace') result=await request(config.httpOrigin+'/api/operate',token,{requestId:'participant-'+randomUUID(),operation:options.operation,args:options.args??{}});
 else result=await request(config.a2Origin+paths[options.channel],token,undefined,{'x-role':'owner','x-request-id':'participant-'+randomUUID(),...(options.tenant?{'x-tenant-id':options.tenant}:{}),...(options.resource?{'x-resource-id':options.resource}:{})});
} else {
 const c=config.options, origin='http://127.0.0.1:'+c.port;
 const privatePath='/state/origin/rotation-client.json';
 let state=existsSync(privatePath)?JSON.parse(readFileSync(privatePath,'utf8')):{};
 const save=()=>{writeFileSync(privatePath+'.tmp',JSON.stringify(state),{mode:0o600});renameSync(privatePath+'.tmp',privatePath);};
 const control=payload=>request(origin+'/source/rotate',c.rotationControlToken,payload);
 if(options.action==='prepare') {
  if(state.actionId && state.actionId!==options.actionId) throw Error('CLIENT_ROTATION_CONFLICT');
  if(!state.next){state={actionId:options.actionId,next:randomBytes(32).toString('base64url'),effective:false};save();}
  result=await control({operation:'prepare',actionId:options.actionId,expectedEpoch:options.expectedEpoch,nextToken:state.next});
 } else if(['commit','lookup','abort'].includes(options.action)) {
  result=await control({operation:options.action,actionId:options.actionId});
  if(result.status===200 && result.body?.status==='EFFECTIVE'){state.effective=true;save();}
 } else if(['status','witness'].includes(options.action)) result=await request(origin+'/source/'+options.action,c.rotationControlToken);
 else if(options.action==='probe') {
  const token=options.credential==='old'?c.normalToken:options.credential==='next'?state.next:state.effective?state.next:c.normalToken;
  result=[];
  for(const [channel,path] of Object.entries(paths)) {
   const payload=channel==='MAIN'?{contextId:'ordinary',requestId:'consumer-'+randomUUID(),operation:'read',args:{key:'deployment-manifest'}}:undefined;
   result.push({channel,...await request(channel==='MAIN'?origin+path:'http://a2:4210'+path,token,payload)});
  }
 }
}
if(result===undefined) throw Error('CLIENT_OPERATION_INVALID');
process.stdout.write(JSON.stringify(result));
