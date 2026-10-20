import { resolve } from 'node:path';
import { openRuntimeReference } from '../runtime/reference.mjs';
import { PITCHING_VARIANTS } from '../runtime/contracts.mjs';

const args=process.argv.slice(2);const options=new Map();
for(let i=0;i<args.length;i+=2){if(!['--data-dir','--port','--presentation','--pitching-seed','--pitching-mode','--pitching-variant'].includes(args[i])||!args[i+1]||options.has(args[i]))throw new Error(`Use --data-dir private-directory and optional --port number, --presentation diagnostic-v1|participant-v1|pitching-v1, --pitching-seed 17|29|43, --pitching-mode adaptive|fixed, --pitching-variant ${PITCHING_VARIANTS.join('|')}.`);options.set(args[i],args[i+1]);}
const runtime=await openRuntimeReference({directory:options.has('--data-dir')?resolve(options.get('--data-dir')):undefined,port:Number(options.get('--port')??0),presentation:options.get('--presentation')??'diagnostic-v1',pitchingSeed:Number(options.get('--pitching-seed')??17),pitchingMode:options.get('--pitching-mode')??'adaptive',pitchingVariant:options.get('--pitching-variant')??'baseline'});
process.stdout.write(`DungeonQ Runtime — local integration reference\nControl room: ${runtime.origin}/runtime/\nParticipant workspace: ${runtime.origin}/runtime/participant.html\nMCP: ${runtime.mcpEndpoint}\nSSH: 127.0.0.1:${runtime.protocols.sshPort}\nPostgreSQL profile: 127.0.0.1:${runtime.protocols.postgresPort}\nWorkload broker: ${runtime.brokerPath}\nPrivate credentials: ${runtime.directory}/credentials.json\nKeep operator and participant credentials separate. No production or paid model connection.\n`);
let stopping=false;async function stop(){if(stopping)return;stopping=true;await runtime.close();}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
