import { resolve } from 'node:path';
import { openRuntimeReference } from '../runtime/reference.mjs';

const args=process.argv.slice(2);const options=new Map();
for(let i=0;i<args.length;i+=2){if(!['--data-dir','--port'].includes(args[i])||!args[i+1]||options.has(args[i]))throw new Error('Use --data-dir private-directory and optional --port number.');options.set(args[i],args[i+1]);}
const runtime=await openRuntimeReference({directory:options.has('--data-dir')?resolve(options.get('--data-dir')):undefined,port:Number(options.get('--port')??0)});
process.stdout.write(`DungeonQ Runtime — local integration reference\nControl room: ${runtime.origin}/runtime/\nMCP: ${runtime.mcpEndpoint}\nSSH: 127.0.0.1:${runtime.protocols.sshPort}\nPostgreSQL profile: 127.0.0.1:${runtime.protocols.postgresPort}\nWorkload broker: ${runtime.brokerPath}\nPrivate credentials: ${runtime.directory}/credentials.json\nKeep operator and participant credentials separate. No production or paid model connection.\n`);
let stopping=false;async function stop(){if(stopping)return;stopping=true;await runtime.close();}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
