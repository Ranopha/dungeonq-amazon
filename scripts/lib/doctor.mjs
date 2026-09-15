import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';

export function supportedNode(version) {
  const parts = version.replace(/^v/u, '').split('.').map(Number);
  return parts.length === 3 && parts.every(Number.isInteger)
    && (parts[0] > 24 || (parts[0] === 24 && parts[1] >= 15));
}

async function availablePort(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function inspectSetup({ checkPorts = true } = {}) {
  const checks = [];
  const add = (name, passed, remedy, required = true) => checks.push({ name, passed, required, remedy: passed ? null : remedy });
  add('NODE_VERSION', supportedNode(process.versions.node), 'Install Node.js 24.15.0 or newer, then reopen your terminal.');
  const crypto = await import('node:crypto');
  add('ARGON2', typeof crypto.argon2 === 'function', 'Use the supported Node.js runtime; do not replace password hashing.');
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:'); db.exec('SELECT 1'); db.close();
    add('SQLITE', true);
  } catch { add('SQLITE', false, 'Use a Node.js build with node:sqlite support.'); }
  // OpenSSL variants write help to stdout or stderr, sometimes with exit code 1.
  const help = spawnSync('openssl', ['req', '-help'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  add('OPENSSL', !help.error && (String(help.stdout ?? '') + String(help.stderr ?? '')).includes('-addext'),
    'Install OpenSSL with req -addext support and make it available on PATH.');
  try {
    createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/client/index.js');
    add('MCP_SDK', true);
  } catch { add('MCP_SDK', false, 'Run npm ci --ignore-scripts from the repository root.'); }
  if (checkPorts) {
    for (const port of [4186, 4187]) {
      add('PORT_' + port, await availablePort(port),
        'A listener already uses this port. Do not stop unknown services; use --web-port 4286 --mcp-port 4287 when starting a new lab.', false);
    }
  }
  return { schemaVersion: 'dungeonq.setup-check/v1', profile: 'SYNTHETIC_ONLY',
    ready: checks.every(check => !check.required || check.passed), node: process.versions.node,
    platform: process.platform, platformAcceptance: process.platform === 'darwin' ? 'MACOS_REFERENCE' : 'NOT_ACCEPTED',
    checks, note: 'Readiness snapshot only. No lab, credentials, downloads or system trust changes.' };
}
