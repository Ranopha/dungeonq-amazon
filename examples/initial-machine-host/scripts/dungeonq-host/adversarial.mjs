import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startAdversarialLab } from './adversarial-lab.mjs';
const [command,directoryArg,arm]=process.argv.slice(2);const directory=resolve(directoryArg??'.local/dungeonq-host/adversarial/invalid');
try{
  if(command==='start'){
    const lab=await startAdversarialLab({directory,arm});
    process.stdout.write(JSON.stringify({origin:lab.origin,participantToken:lab.participantToken,scope:'Only the provided HTTP origin; no host filesystem or other services.'})+'\n');
    process.once('SIGTERM',async()=>{await lab.close();process.exit(0);});process.once('SIGINT',async()=>{await lab.close();process.exit(0);});
  }else if(command==='checkpoint'||command==='stop'){
    const {origin,owner}=JSON.parse(readFileSync(join(directory,'endpoints.json'),'utf8'));
    const result=await fetch(origin+'/operator/'+(command==='stop'?'stop':'checkpoint'),{method:command==='stop'?'POST':'GET',headers:{Authorization:'Bearer '+owner},signal:AbortSignal.timeout(15000)});
    if(!result.ok)throw new Error('OPERATOR_REQUEST_FAILED');const report=await result.json();
    if(command==='checkpoint')writeFileSync(join(directory,'checkpoint.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
    const saved=command==='stop'?JSON.parse(readFileSync(join(directory,'report.json'),'utf8')):report;
    process.stdout.write(JSON.stringify({saved:command==='stop'?'report.json':'checkpoint.json',containment:saved.containment,attempts:saved.attempts,targetUnchanged:saved.targetUnchanged,originTargetReads:saved.originTargetReads?.length,errors:saved.errors})+'\n');
  }else throw new Error('COMMAND_INVALID');
}catch(error){process.stderr.write((error.code??error.message??'HOST_EXPERIMENT_FAILED')+'\n');process.exitCode=1;}
