import net from 'node:net';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { exact, insist } from './transport.mjs';

export async function startHostBroker({ socketPath, dispatch }) {
  insist(isAbsolute(socketPath) && !existsSync(socketPath), 'BROKER_PATH_UNAVAILABLE');
  const directory = lstatSync(dirname(socketPath));
  insist(directory.isDirectory() && !directory.isSymbolicLink() && !(directory.mode & 0o077), 'PRIVATE_DIRECTORY_REQUIRED');
  const sockets = new Set(); let requests = 0; let until = Date.now() + 60000;
  const server = net.createServer(socket => {
    if (sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket); socket.setTimeout(5000, () => socket.destroy());
    let pending = Buffer.alloc(0); let used = false;
    socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    socket.on('data', async chunk => {
      if (used) { socket.destroy(); return; }
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 32768) { socket.destroy(); return; }
      const end = pending.indexOf(10); if (end < 0) return; used = true;
      try {
        insist(end === pending.length - 1, 'BROKER_MESSAGE_INVALID');
        if (Date.now() > until) { requests = 0; until = Date.now() + 60000; }
        insist(++requests <= 2000, 'BROKER_CAPACITY_LIMIT');
        const input = JSON.parse(pending.subarray(0, end).toString('utf8')); exact(input, ['token', 'requestId', 'operation', 'args']);
        const result = await dispatch({ ...input, family: 'host' });
        socket.end(JSON.stringify({ result }) + '\n');
      } catch (e) { socket.end(JSON.stringify({ error: { code: /^[A-Z_]{1,80}$/.test(e.code ?? '') ? e.code : 'BROKER_REJECTED' } }) + '\n'); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); }); chmodSync(socketPath, 0o600);
  return { socketPath, close: async () => {
    for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve));
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } };
}
