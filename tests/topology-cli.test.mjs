import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createTopology, advanceTopology, makeTopologyBundle } from '../world/topology.mjs';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = args => exec(process.execPath, args, { cwd: root, timeout: 5000 });

test('offline CLI replays actual events and rejects altered evidence, symlinks and malformed UTF-8', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dungeonq-topology-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = advanceTopology(createTopology(), { type: 'withdraw' });
  const bundle = makeTopologyBundle(result.state, [result.event]);
  const path = join(directory, 'evidence.json'); await writeFile(path, JSON.stringify(bundle));
  const valid = await cli(['cli/topology-verify.mjs', path]); assert.equal(JSON.parse(valid.stdout).valid, true);
  const altered = structuredClone(bundle); altered.events[0].observation.message += ' edited';
  const alteredPath = join(directory, 'altered.json'); await writeFile(alteredPath, JSON.stringify(altered));
  await assert.rejects(cli(['cli/topology-verify.mjs', alteredPath]), error => error.code === 1 && /TOPOLOGY_REPLAY_MISMATCH/.test(error.stderr));
  const link = join(directory, 'link.json'); await symlink(path, link);
  await assert.rejects(cli(['cli/topology-verify.mjs', link]), { code: 1 });
  const malformed = join(directory, 'malformed.json'); await writeFile(malformed, Buffer.from([0xff]));
  await assert.rejects(cli(['cli/topology-verify.mjs', malformed]), { code: 1 });
});

test('launcher rejects unknown, duplicate or incomplete options; verifier accepts exactly one path', async () => {
  for (const args of [['--arm', 'UNKNOWN'], ['--execute', 'anything'], ['--seed'], ['--seed', '2', '--seed', '3'], ['--actor-port', '65536']]) {
    await assert.rejects(cli(['scripts/topology.mjs', ...args]), { code: 1 });
  }
  await assert.rejects(cli(['cli/topology-verify.mjs']), { code: 1 });
  await assert.rejects(cli(['cli/topology-verify.mjs', 'a', 'b']), { code: 1 });
});
