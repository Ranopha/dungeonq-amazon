import { readFileSync, lstatSync } from 'node:fs';
import { once } from 'node:events';
import { startCollector, startFacade, startOrigin } from './services.mjs';
import { insist } from './transport.mjs';

let config;
if (process.send && !process.argv[2]) [config] = await once(process, 'message');
else { const path = process.argv[2]; const mode = lstatSync(path); insist(mode.isFile() && !mode.isSymbolicLink() && !(mode.mode & 0o077), 'PRIVATE_CONFIG_REQUIRED'); config = JSON.parse(readFileSync(path, 'utf8')); }
const factory = { origin: startOrigin, collector: startCollector, facade: startFacade }[config.role];
insist(factory, 'ROLE_INVALID');
const service = await factory(config.options);
if (process.send) process.send({ ready: true, origin: service.origin, port: service.port });
else process.stdout.write(JSON.stringify({ ready: true, role: config.role, port: service.port }) + '\n');
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await service.close(); process.disconnect?.(); }
process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('disconnect', stop);
