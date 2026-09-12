import { open } from 'node:fs/promises';
import { verifyAcceptanceReport } from '../server/company-acceptance.mjs';
let file;
try {
  if (process.argv.length !== 3) throw new Error('ARGUMENT');
  file = await open(process.argv[2], 'r');
  const buffer = Buffer.alloc(65537); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  if (bytesRead > 65536) throw new Error('LIMIT');
  const report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  const valid = verifyAcceptanceReport(report);
  process.stdout.write(JSON.stringify({ valid, ...(valid ? { result: report.result, commercialReady: false, digest: report.digest } : {}) }) + '\n');
  if (!valid || report.result !== 'PASS') process.exitCode = 1;
} catch { process.stderr.write('報告無效或無法讀取；未輸出原始內容。\n'); process.exitCode = 1; }
finally { await file?.close(); }
