import { resolve } from 'node:path';
import { openDefenseLab } from '../server/defense-lab.mjs';
import { loadSmtpConfigFile } from '../server/email-transport.mjs';
import { loadOAuthConfigFile } from '../server/social-oauth.mjs';

const options = new Map(); const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  if (!['--data-dir', '--seed', '--depth', '--web-port', '--actor-port', '--mcp-port', '--presentation', '--email-smtp-config', '--identity-config'].includes(args[index])
    || !args[index + 1] || options.has(args[index])) throw new Error('Use npm run defense -- [--data-dir private-directory] [--seed 42] [--depth 4] [--web-port 4196] [--actor-port 4197] [--mcp-port 4198] [--presentation disclosed/v1|orders-workspace/v1] [--email-smtp-config absolute-private-file] [--identity-config absolute-private-file]');
  options.set(args[index], args[index + 1]);
}
let lab; let stopping = false;
async function stop() { if (stopping) return; stopping = true; await lab?.close(); }
try {
  lab = await openDefenseLab({ directory: options.has('--data-dir') ? resolve(options.get('--data-dir')) : undefined,
    emailConfig: options.has('--email-smtp-config') ? await loadSmtpConfigFile(resolve(options.get('--email-smtp-config'))) : undefined,
    identityConfig: options.has('--identity-config') ? await loadOAuthConfigFile(resolve(options.get('--identity-config'))) : undefined,
    presentation: options.get('--presentation') ?? 'disclosed/v1',
    seed: Number(options.get('--seed') ?? 42), depth: Number(options.get('--depth') ?? 4),
    webPort: Number(options.get('--web-port') ?? 4196), actorPort: Number(options.get('--actor-port') ?? 4197),
    mcpPort: Number(options.get('--mcp-port') ?? 4198) });
  process.stdout.write(`DungeonQ defense reference — synthetic resources only\nOwner: ${lab.web.origin}/defense\nActor: ${lab.world.actorUrl}\nMCP 2025-11-25 / Streamable HTTP: ${lab.world.mcpEndpoint}\nActor-only Bearer: ${lab.world.actorToken}\nUsername: owner-lab\n`);
  process.stdout.write(lab.password ? `NEW Owner password (save locally, never give to the Actor): ${lab.password}\n` : 'Existing installation reopened. Use your saved Owner password; no credentials were reset.\n');
  process.stdout.write(options.has('--email-smtp-config') ? 'Email: explicit SMTP configuration. Bind and verify your login email in the Owner control room. Server acceptance is not inbox delivery.\n' : 'Email: local simulated mailbox only. Bind a synthetic email in the Owner control room; no external email is sent.\n');
  process.stdout.write(`Private state: ${lab.directory}\nPresentation: ${options.get('--presentation') ?? 'disclosed/v1'}\nRestart with the same directory, seed, depth and presentation. Never upload the installation directory or console credentials.\nSelf-signed loopback TLS only; no system trust change. One synthetic origin rotation per installation. No enterprise connector or real AI-detection claim.\n`);
} catch (error) { await stop(); process.stderr.write(`Defense startup failed: ${error.code ?? 'LOCAL_SETUP_FAILED'}\n`); process.exitCode = 1; }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
