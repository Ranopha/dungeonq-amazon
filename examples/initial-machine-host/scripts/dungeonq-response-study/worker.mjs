import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export async function startDefender(options){
  const worker=fork(fileURLToPath(new URL('./defender.mjs',import.meta.url)),[],{
    execArgv:[],env:{PATH:process.env.PATH},stdio:['ignore','ignore','pipe','ipc']});
  let sequence=0;const pending=new Map(),events=[];let terminalResolve;
  const terminal=new Promise(resolve=>{terminalResolve=resolve;});
  worker.on('message',message=>{
    if(message.event){events.push(message.event);if(['ROTATION_EFFECTIVE','RESPONSE_FAILED'].includes(message.event.kind))terminalResolve(message.event);return;}
    const row=pending.get(message.id);if(!row)return;clearTimeout(row.timer);pending.delete(message.id);
    if(message.ok)row.resolve(message);else row.reject(new Error(message.code));
  });
  worker.on('exit',()=>{for(const row of pending.values()){clearTimeout(row.timer);row.reject(new Error('DEFENDER_EXITED'));}pending.clear();});
  let diagnostic='';worker.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-1000);});
  const call=(command,extra={})=>new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('DEFENDER_TIMEOUT'));},15000);
    pending.set(id,{resolve,reject,timer});worker.send({id,command,...extra});
  });
  try{const ready=await call('init',{options});return {origin:ready.origin,call,events,
    async wait(){if(options.delayMs===null)return;let timer;try{await Promise.race([terminal,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('RESPONSE_TIMEOUT')),45000);})]);}finally{clearTimeout(timer);}},
    async close(){try{if(worker.connected)await call('close');}finally{if(worker.exitCode===null)worker.kill('SIGTERM');}}
  };}catch(error){worker.kill('SIGTERM');if(process.env.DQ_TEST_DIAGNOSTIC)process.stderr.write(diagnostic);throw error;}
}
