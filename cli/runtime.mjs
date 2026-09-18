#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createRuntimeClient, RuntimeError } from '../sdk/runtime-client.mjs';

const usage = 'Usage: node cli/runtime.mjs capabilities|status|evidence|operate [--input REQUEST_JSON_FILE]\nEnvironment: DUNGEONQ_RUNTIME_URL; DUNGEONQ_OPERATOR_TOKEN for status/evidence; DUNGEONQ_CONTEXT_TOKEN for operate.\n';
const [command, flag, file, ...extra] = process.argv.slice(2);
try {
  if (!['capabilities', 'status', 'evidence', 'operate'].includes(command) || extra.length
    || (command === 'operate' ? flag !== '--input' || !file : flag !== undefined)) {
    process.stderr.write(usage); process.exitCode = 2;
  } else {
    const origin = process.env.DUNGEONQ_RUNTIME_URL;
    if (!origin) throw new RuntimeError('RUNTIME_URL_REQUIRED');
    const token = command === 'operate' ? process.env.DUNGEONQ_CONTEXT_TOKEN : command === 'capabilities' ? '' : process.env.DUNGEONQ_OPERATOR_TOKEN;
    const client = createRuntimeClient({ origin, token: token ?? '' });
    let result;
    try {
      if (command === 'operate') {
        const bytes = await readFile(file);
        if (bytes.length > 65536) throw new RuntimeError('REQUEST_TOO_LARGE');
        let input;
        try { input = JSON.parse(bytes.toString('utf8')); } catch { throw new RuntimeError('INVALID_REQUEST_JSON'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).sort().join(',') !== 'args,operation,requestId') throw new RuntimeError('INVALID_OPERATION_REQUEST');
        result = await client.operate(input);
      } else result = await client[command]();
      process.stdout.write(JSON.stringify(result) + '\n');
    } finally { client.disconnect(); }
  }
} catch (error) {
  const safe = error instanceof RuntimeError ? error : new RuntimeError('CLIENT_INPUT_UNAVAILABLE');
  process.stderr.write(JSON.stringify({ error: { code: safe.code }, uncertain: safe.uncertain,
    ...(safe.uncertain ? { next: 'Read server state and evidence. Do not create a new request after an uncertain effect.' } : {}) }) + '\n');
  process.exitCode = 1;
}
