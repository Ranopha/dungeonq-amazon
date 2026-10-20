import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { startAdversarialLab } from '../dungeonq-host/adversarial-lab.mjs';
import { startDefender } from './worker.mjs';
export async function startSession({root,directory,entry,installation}){
  const receiverToken=randomBytes(32).toString('hex'),rotationControlToken=randomBytes(32).toString('hex');
  const defender=await startDefender({directory:join(directory,'defender'),delayMs:entry.delayMs,receiverToken,rotationControlToken});
  let lab;
  try{
    lab=await startAdversarialLab({repoRoot:root,directory:join(directory,'host'),arm:entry.arm,installation,
      pursuitProfile:{variant:entry.variant,scenario:'full'},maxRequests:60,ttlMs:240000,
      responseProfile:{rotationControlToken,receiverOrigin:defender.origin,receiverToken}});
    await defender.call('configure',{source:{origin:lab.debug.origin.origin,oldToken:lab.debug.credentials.ordinary}});
    return {lab,defender,async close(){await defender.close();await lab.close();}};
  }catch(error){await defender.close();await lab?.close();throw error;}
}
