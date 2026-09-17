import { lstat, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorldLab } from '../server/world-lab.mjs';

const args = process.argv.slice(2); const options = {};
try {
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]; const value = args[i + 1];
    if (!['--pack', '--data-dir', '--actor-port', '--observer-port', '--mcp-port'].includes(name) || !value || options[name]) throw new Error('WORLD_ARGUMENT_INVALID');
    options[name] = value;
  }
  const packPath = options['--pack'] ? resolve(options['--pack']) : fileURLToPath(new URL('../world/packs/clockwork-archive.json', import.meta.url));
  const info = await lstat(packPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 131072) throw new Error('WORLD_PACK_FILE_INVALID');
  const pack = JSON.parse(await readFile(packPath, 'utf8'));
  const dataDir = options['--data-dir'] ? resolve(options['--data-dir']) : await mkdtemp(join(tmpdir(), 'dungeonq-world-live-'));
  const port = name => { const value = options[name] ?? '0'; if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new Error('WORLD_PORT_INVALID'); return Number(value); };
  const lab = await startWorldLab({ dataDir, pack, actorPort: port('--actor-port'), observerPort: port('--observer-port'), mcpPort: port('--mcp-port') });
  process.stdout.write(`DungeonQ · 封閉合成世界\n資料目錄（保留此路徑才能續玩）：${dataDir}\n參與者：${lab.actorUrl}/#token=${lab.actorToken}\n獨立觀測：${lab.observerUrl}/#token=${lab.observerToken}\nMCP：${lab.mcpEndpoint}\nMCP Bearer 使用參與者 token。以上是本機短期入口，不要公開。\n無付費模型／無真實漏洞／無世界外效果；Ctrl+C 可停止。\n`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await lab.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) {
  process.stderr.write(`${error.code ?? error.message}\n`); process.exitCode = 1;
}
