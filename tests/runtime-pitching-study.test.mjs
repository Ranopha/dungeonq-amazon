import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const pythonEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
const json = path => JSON.parse(readFileSync(path, 'utf8'));

test('study client only admits the fixed HTTPS site or exact explicit loopback origins', async () => {
  const code = `import importlib.util
spec = importlib.util.spec_from_file_location('study_client', 'scripts/pitching-study-client.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
assert m.endpoint({'origin': 'https://dungeonq.talkidino.com'}, 'http')[0] == 'https://dungeonq.talkidino.com'
valid = {'transport': 'loopback', 'origin': 'http://127.0.0.1:12345', 'mcpOrigin': 'http://127.0.0.1:12346'}
assert m.endpoint(valid, 'http') == ('http://127.0.0.1:12345', ['--noproxy', '*'])
assert m.endpoint(valid, 'mcp')[0] == 'http://127.0.0.1:12346'
for origin in ['http://localhost:12345', 'http://example.com:12345', 'http://127.0.0.1:0', 'http://127.0.0.1:12345/', 'http://127.0.0.1:12345?x', 'http://user@127.0.0.1:12345', 'https://127.0.0.1:12345']:
    try: m.endpoint({**valid, 'origin': origin}, 'http')
    except (AssertionError, ValueError): pass
    else: raise AssertionError('unexpected origin admitted')
try: m.endpoint({'origin': valid['origin']}, 'http')
except AssertionError: pass
else: raise AssertionError('loopback requires explicit selection')
`;
  await exec('python3', ['-c', code], { cwd: root, env: pythonEnv });
});

test('loopback study host honors seed, HTTP/MCP, finite client budget and restore without a public gateway', { timeout: 45000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dq-inquiry-host-'));
  const data = join(directory, 'data'), participant = join(directory, 'participant');
  const args = [join(root, 'scripts/pitching-study-host.mjs'), root, data, participant, 'entry-v2', 'serve', '17', 'loopback'];
  const host = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(host, 'exit');
  let stdout = '', stderr = '';
  host.stderr.on('data', bytes => { stderr += bytes; });
  t.after(async () => {
    if (host.exitCode === null && host.signalCode === null) { host.kill('SIGTERM'); await exited; }
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(Error('study host readiness timeout')), 20000);
    host.stdout.on('data', bytes => {
      stdout += bytes;
      if (stdout.includes('"state":"READY"')) { clearTimeout(timer); res(); }
    });
    host.once('exit', () => { clearTimeout(timer); rej(Error('study host exited before ready: ' + stderr)); });
  });
  const config = json(join(participant, 'participant.json'));
  assert.equal(config.transport, 'loopback');
  assert.equal(existsSync(join(data, 'public-gateway.json')), false);
  assert.equal(statSync(join(participant, 'participant.json')).mode & 0o777, 0o600);
  const run = async (family, operation, value = {}) => JSON.parse((await exec('python3', [join(root, 'scripts/pitching-study-client.py'), participant,
    family, operation, JSON.stringify(value)], { env: pythonEnv })).stdout);
  const initial = (await run('http', 'snapshot')).response;
  assert.equal(initial.records.find(record => record.key === 'catalog-prior').value.capacity, 12);
  const issued = (await run('http', 'issue-ticket', { scope: ['catalog-current'] })).response;
  const used = (await run('http', 'use-ticket', { key: 'catalog-current', ticket: issued.ticket })).response;
  assert.equal(used.progress.completed, 1);
  const mcp = (await run('mcp', 'read', { key: 'catalog-current' })).response;
  assert.equal(mcp.result.structuredContent.value.capacity, 16);
  const budgetPath = join(participant, 'budget.json');
  writeFileSync(budgetPath, JSON.stringify({ startedAt: Date.now() / 1000, requests: 40 }));
  assert.equal((await run('http', 'snapshot')).error, 'STUDY_BUDGET_ENDED');
  assert.equal(readFileSync(join(participant, 'trajectory.jsonl'), 'utf8').trim().split('\n').length, 4);
  host.kill('SIGTERM');
  const [exitCode] = await exited;
  assert.equal(exitCode, 0, stderr);
  assert.equal(stdout.includes(config.token), false);
  assert.equal(stderr.includes(config.token), false);
  const after = json(join(data, 'after-evidence.json'));
  const restoreArgs = [...args]; restoreArgs[5] = 'restore';
  await exec(process.execPath, restoreArgs, { cwd: root });
  assert.deepEqual(json(join(data, 'restored-evidence.json')), after);
  assert.equal(existsSync(join(data, 'gateway-status.json')), false);
});
