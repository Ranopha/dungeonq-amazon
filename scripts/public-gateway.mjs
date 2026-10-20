import { startPublicGateway } from '../runtime/public-gateway.mjs';

const args = process.argv.slice(2); const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  if (!['--config', '--port'].includes(args[index]) || !args[index + 1] || options.has(args[index])) {
    throw new Error('Use --config /absolute/private/public-gateway.json and optional --port 8788.');
  }
  options.set(args[index], args[index + 1]);
}
try {
  const gateway = await startPublicGateway({ configPath: options.get('--config'), port: Number(options.get('--port') ?? 8788) });
  process.stdout.write(`Participant gateway ready on 127.0.0.1:${gateway.port}\nPublic participant path: ${gateway.publicURL}\nNo tunnel or public route was created. Tokens remain in private files.\n`);
  const stop = async () => { await gateway.close(); process.exitCode = 0; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (failure) {
  process.stderr.write(`Public gateway refused: ${/^[A-Z][A-Z0-9_]{1,79}$/.test(failure.code ?? '') ? failure.code : 'CONFIG_OR_START_FAILED'}\n`);
  process.exitCode = 1;
}
