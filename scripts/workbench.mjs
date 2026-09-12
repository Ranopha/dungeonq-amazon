import { createLocalFixture } from '../server/local-fixture.mjs';
import { startWorkbench } from '../server/workbench.mjs';

const fixture = await createLocalFixture();
let web;
try {
  web = await startWorkbench({ application: fixture.core.application, tls: fixture.tls, port: 4185 });
} catch (error) { await fixture.close(); throw error; }
process.stdout.write(`地下城本機合成工作台：${web.origin}\n租戶：tenant-lab\n帳號：owner-lab\n本次隨機測試密碼：${fixture.password}\n僅接受本機連線；自簽測試憑證不加入系統信任。停止後清除本次合成資料。\n`);
for (const member of fixture.members) process.stdout.write(`合成 ${member.role}：${member.username} ／ 本次隨機密碼：${member.password}\n`);
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await web.close(); await fixture.close(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
