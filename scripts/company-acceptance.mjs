import { runCompanyAcceptance } from '../server/company-acceptance.mjs';
try {
  const report = await runCompanyAcceptance(); process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.result !== 'PASS') process.exitCode = 1;
} catch { process.stderr.write('公司合成驗收未完成；請檢查 Node 24.15+、OpenSSL 與本機 loopback 權限。\n'); process.exitCode = 1; }
