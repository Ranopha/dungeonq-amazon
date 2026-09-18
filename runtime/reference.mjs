import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRuntimeGateway } from './server.mjs';
import { insist, newToken, privateJson } from './transport.mjs';

async function startChild(role, options) {
  const child = fork(fileURLToPath(new URL('./service-process.mjs', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  let errorCode = ''; child.stderr.on('data', c => { errorCode = (errorCode + c.toString()).slice(-1500); });
  let stopped = false;
  const close = async () => {
    if (stopped || child.exitCode !== null) return; stopped = true;
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); const timer=setTimeout(()=>child.kill('SIGKILL'),2000); timer.unref(); child.once('exit',()=>clearTimeout(timer)); });
  };
  try {
    const ready = await new Promise((resolve,reject) => {
      const timer=setTimeout(()=>reject(new Error('Reference child startup timed out')),8000);
      child.once('message',msg=>{clearTimeout(timer);if(msg.ready)resolve(msg);else reject(new Error('Reference child was not ready'));});
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('Reference child startup failed: '+errorCode));});
      child.send({role,options});
    });
    return {...ready,pid:child.pid,close};
  } catch(e) {await close();throw e;}
}

export async function openRuntimeReference({ directory, port=0, mcpPort=0, sshPort=0, postgresPort=0, network=true, hostBroker=true }={}) {
  directory ??= mkdtempSync(join(tmpdir(),'dq-runtime-'));
  insist(isAbsolute(directory), 'ABSOLUTE_DIRECTORY_REQUIRED'); mkdirSync(directory,{recursive:true,mode:0o700});
  const mode=lstatSync(directory);insist(mode.isDirectory()&&!mode.isSymbolicLink()&&!(mode.mode&0o077),'PRIVATE_DIRECTORY_REQUIRED');
  const children=[];let gateway;let closed=false;
  const credentials=privateJson(join(directory,'credentials.json'),()=>Object.fromEntries(['owner','actor','other','ordinary','seal','producer','reader','witness'].map(k=>[k,newToken()])));
  const close=async()=>{if(closed)return;closed=true;await gateway?.close();for(const child of children.reverse())await child.close();};
  try {
    const origin=await startChild('origin',{path:join(directory,'origin.sqlite'),normalToken:credentials.ordinary,witnessToken:credentials.witness});children.push(origin);
    const collector=await startChild('collector',{path:join(directory,'collector.sqlite'),producerToken:credentials.producer,readerToken:credentials.reader});children.push(collector);
    gateway=await startRuntimeGateway({directory,credentials,originOrigin:origin.origin,collectorOrigin:collector.origin,port,mcpPort,sshPort,postgresPort,network,hostBroker,
      facadeFactory:async stateOrigin=>{const facade=await startChild('facade',{stateOrigin});children.push(facade);return facade;}});
    return {...gateway,directory,credentials,originService:origin,collectorService:collector,facadeService:children.find(c=>c!==origin&&c!==collector),close};
  }catch(e){await close();throw e;}
}
