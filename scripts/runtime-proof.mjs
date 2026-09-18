import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runReferenceAcceptance } from '../runtime/rehearsal.mjs';
import { DEFAULT_RUNTIME_CHECKS, evaluateRuntimeGate } from './runtime-gate.mjs';
import { referenceSourceManifest, evaluateIsolation } from './runtime-isolation.mjs';
import { insist } from '../runtime/transport.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function candidateIdentity() {
  const git=(...args)=>execFileSync(process.env.DUNGEONQ_GIT??'git',args,{cwd:root,encoding:'utf8',maxBuffer:4000000}).trim();
  const files=git('ls-files','--cached','--others','--exclude-standard','-z').split('\0').filter(Boolean).sort();
  const hash=createHash('sha256');
  for(const file of files){const path=join(root,file);insist(!lstatSync(path).isSymbolicLink(),'SOURCE_SYMLINK_DENIED');hash.update(file+'\0').update(readFileSync(path)).update('\0');}
  return {commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),dirtyWorktree:git('status','--porcelain','--untracked-files=all')!=='',contentDigest:hash.digest('hex')};
}
export function admitIsolation(report,{sourceDigest,now=Date.now()}={}) {
  return report?.schemaVersion==='dungeonq.runtime-isolation/v1' && report.status==='PASS'
    && report.sourceDigest===sourceDigest && Number.isFinite(Date.parse(report.observedAt))
    && Date.parse(report.observedAt)<=now && now-Date.parse(report.observedAt)<3600000
    && Array.isArray(report.checks) && evaluateIsolation(report.checks).status==='PASS'
    && Array.isArray(report.images) && report.images.length>=1 && report.images.length<=4
    && report.images.every(image=>image.sourceDigest===sourceDigest && /^sha256:[a-f0-9]{64}$/.test(image.id))
    && Object.keys(report.facts?.containers??{}).length===4
    && ['gateway','facade','origin','collector'].every(role=>report.images.some(image=>image.id===report.facts.containers[role]?.image))
    && Object.keys(report.facts?.networks??{}).length===3;
}
export async function runProof({out,commit,tree,isolationReport}={}) {
  insist(out,'OUTPUT_REQUIRED');const target=resolve(out);
  insist(!target.startsWith(root+'/'),'OUTPUT_MUST_BE_OUTSIDE_CHECKOUT');
  const source=candidateIdentity();if(commit)insist(commit===source.commit,'CANDIDATE_MISMATCH');if(tree)insist(tree===source.tree,'CANDIDATE_MISMATCH');
  const result=await runReferenceAcceptance();
  const detailsPath=target+'.details.json';const checks=[];
  for(const id of DEFAULT_RUNTIME_CHECKS.filter(id=>id!=='isolation'))checks.push({id,status:result.details[id]?.status??'INCONCLUSIVE',evidence:[detailsPath+'#'+id]});
  let isolated=false;
  if(isolationReport){const parsed=JSON.parse(readFileSync(isolationReport,'utf8'));isolated=admitIsolation(parsed,{sourceDigest:referenceSourceManifest().sourceDigest});result.details.isolation=parsed;}
  checks.push({id:'isolation',status:isolated?'PASS':'INCONCLUSIVE',evidence:[isolated?detailsPath+'#isolation':'NOT_RUN: current complete infrastructure evidence required']});
  insist(JSON.stringify(source)===JSON.stringify(candidateIdentity()),'SOURCE_CHANGED_DURING_PROOF');
  writeFileSync(detailsPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  const report={schemaVersion:'dungeonq.runtime-acceptance/v1',source,checks,profile:'OWNED_REFERENCE_ACCEPTANCE',startedAt:result.startedAt,finishedAt:new Date().toISOString()};
  writeFileSync(target,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  return {report:target,checks:checks.map(({id,status})=>({id,status})),gate:evaluateRuntimeGate(report,{expectedCommit:source.commit,expectedTree:source.tree})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const options={};const mapping={'--out':'out','--commit':'commit','--tree':'tree','--isolation-report':'isolationReport'};
  try {for(let i=2;i<process.argv.length;i+=2){const key=mapping[process.argv[i]];insist(key&&process.argv[i+1]&&!options[key],'ARGUMENT_INVALID');options[key]=process.argv[i+1];}
    const result=await runProof(options);console.log(JSON.stringify(result));process.exitCode=result.gate.passed?0:1;
  }catch(e){console.error(JSON.stringify({error:e.code??'PROOF_FAILED',message:e.message}));process.exitCode=1;}
}
