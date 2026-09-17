import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStudyDesign } from '../study/experiment.mjs';
import { worldDigest } from '../world/kernel.mjs';
import { startStudyLab } from '../server/study-lab.mjs';

export async function startStudyInstallation(options = {}) {
  const port = name => { const value = options[name] ?? '0'; if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new Error('STUDY_PORT_INVALID'); return Number(value); };
  const ports = { actorPort: port('--actor-port'), observerPort: port('--observer-port'), mcpPort: port('--mcp-port') };
  const designPath = options['--design'] ? resolve(options['--design']) : fileURLToPath(new URL('../study/designs/archive.json', import.meta.url));
  const info = await lstat(designPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 131072) throw new Error('STUDY_DESIGN_FILE_INVALID');
  const design = validateStudyDesign(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(designPath))));
  const dataDir = options['--data-dir'] ? resolve(options['--data-dir']) : await mkdtemp(join(tmpdir(), 'dungeonq-study-live-'));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(dataDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)) throw new Error('STUDY_DIRECTORY_NOT_PRIVATE');
  const path = join(dataDir, 'study-installation.json'); let saved;
  try {
    const meta = await lstat(path);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.nlink !== 1 || (meta.mode & 0o077) || meta.size > 8192) throw new Error('STUDY_INSTALLATION_INVALID');
    saved = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const arm = options['--arm'] ?? saved?.arm ?? ['CORRELATED', 'DISCRIMINATING'][randomInt(2)];
  const rule = options['--rule'] ?? saved?.rule ?? ['signal', 'structure'][randomInt(2)];
  if (!['CORRELATED', 'DISCRIMINATING'].includes(arm) || !['signal', 'structure'].includes(rule)) throw new Error('STUDY_ASSIGNMENT_INVALID');
  const expected = { schemaVersion: 'dungeonq.study-installation/v1', designDigest: worldDigest(design), arm, rule };
  if (saved && worldDigest(saved) !== worldDigest(expected)) throw new Error('STUDY_INSTALLATION_MISMATCH');
  if (!saved) await writeFile(path, `${JSON.stringify(expected, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const lab = await startStudyLab({ dataDir, design, arm, rule, ...ports });
  return Object.assign(lab, { dataDir });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--design', '--data-dir', '--arm', '--rule', '--actor-port', '--observer-port', '--mcp-port'].includes(args[i]) || !args[i + 1] || Object.hasOwn(options, args[i])) throw new Error('STUDY_ARGUMENT_INVALID');
      options[args[i]] = args[i + 1];
    }
    const lab = await startStudyInstallation(options);
    process.stdout.write(`DungeonQ · 認知陷阱合成研究\n資料目錄：${lab.dataDir}\n參與者：${lab.actorUrl}/#token=${lab.actorToken}\n主持人：${lab.observerUrl}/#token=${lab.observerToken}\nMCP：${lab.mcpEndpoint}\nMCP Bearer（只供受限 client）：${lab.mcpToken}\n`);
    process.stdout.write('主持人可讀答案；盲測只分享參與者入口。連結僅本機有效，不公開 token。無付費模型呼叫。Ctrl+C 停止，保留 data-dir 可恢復。\n');
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await lab.close(); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { process.stderr.write(`${error.code ?? error.message}\n`); process.exitCode = 1; }
}
