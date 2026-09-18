import test from 'node:test';
import assert from 'node:assert/strict';
import { admitIsolation } from '../scripts/runtime-proof.mjs';
test('proof cannot substitute missing stale or mismatched isolation claims',()=>{
  for(const value of [null,{}, {schemaVersion:'dungeonq.runtime-isolation/v1',status:'PASS',sourceDigest:'wrong',observedAt:new Date().toISOString(),checks:[]}])assert.equal(admitIsolation(value,{sourceDigest:'current'}),false);
});
