import test from 'node:test';
import assert from 'node:assert/strict';
import { runReferenceAcceptance } from '../runtime/rehearsal.mjs';
test('real five-protocol diversion, two SDKs, managed workload, persistence, owner policy and negative rehearsal', {timeout:60000}, async()=>{
  const result=await runReferenceAcceptance();
  for(const id of ['http','mcp','ssh','postgres','host','wrong-ticket','persistence','mutation','origin-untouched','adversarial'])assert.equal(result.details[id].status,'PASS',id);
  assert(result.details.adversarial.cases.length>=12);
});
