import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startTopologyLab } from '../server/topology-lab.mjs';

const args = process.argv.slice(2); const options = {};
try {
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]; const value = args[i + 1];
    if (!['--data-dir', '--seed', '--arm', '--actor-port', '--observer-port', '--mcp-port'].includes(name)
      || !value || Object.hasOwn(options, name)) throw Error('TOPOLOGY_ARGUMENT_INVALID');
    options[name] = value;
  }
  const numeric = (name, max) => {
    if (options[name] === undefined) return undefined;
    if (!/^\d{1,10}$/.test(options[name]) || Number(options[name]) > max) throw Error('TOPOLOGY_ARGUMENT_INVALID');
    return Number(options[name]);
  };
  if (options['--arm'] && !['TREATMENT', 'CONTROL'].includes(options['--arm'])) throw Error('TOPOLOGY_ARM_INVALID');
  const dataDir = options['--data-dir'] ? resolve(options['--data-dir']) : await mkdtemp(join(tmpdir(), 'dungeonq-topology-'));
  const lab = await startTopologyLab({ dataDir, participantMode: 'UI_CHECK', seed: numeric('--seed', 2147483647), arm: options['--arm'],
    actorPort: numeric('--actor-port', 65535), observerPort: numeric('--observer-port', 65535), mcpPort: numeric('--mcp-port', 65535) });
  process.stdout.write(`DungeonQ · Synthetic publishing workflow\nPrivate data directory (retain to resume): ${dataDir}\nParticipant: ${lab.actorUrl}/#token=${lab.actorToken}\nObserver: ${lab.observerUrl}/#token=${lab.observerToken}\nMCP endpoint: ${lab.mcpEndpoint}\nMCP bearer: ${lab.mcpToken}\nKeep these local, short-lived tokens private. No paid model call, external publication or real credential is involved.\nThe Observer reveals the experiment: do not share it with a blind participant. Ctrl+C stops this lab.\n`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await lab.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) {
  const code = error.code ?? error.message;
  process.stderr.write(`${/^[A-Z_]{1,80}$/.test(code) ? code : 'TOPOLOGY_START_FAILED'}\n`); process.exitCode = 1;
}
