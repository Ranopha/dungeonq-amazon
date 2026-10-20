import test from 'node:test';
import assert from 'node:assert/strict';
import { runGmailPump } from '../scripts/pitching-gmail-pump.mjs';

const config={directory:'/private/lab/data',sourceDirectory:'/source',recipient:'operator@example.test',label:'DQ6-H-1016'};
function harness({provider={structuredContent:{id:'receipt-1'},isError:false},state='DISPATCH',throwSend=false}={}) {
 const calls=[];
 const tools={exec_command:async args=>{calls.push(args);return {exit_code:0,output:args.cmd.includes(' next ')?JSON.stringify({state,jobId:'job-1',enteredAt:Date.now()}):args.cmd.includes(' complete ')?JSON.stringify({state:'COMPLETE'}):''};},
  mcp__codex_apps__gmail_send_email:async args=>{calls.push({mail:args});if(throwSend)throw Error('network');return provider;}};
 return {calls,tools};
}
test('預先啟動的relay取得job後自動寄送一次，保存回執後complete',async()=>{
 const h=harness();await runGmailPump({...config,tools:h.tools});
 assert.equal(h.calls.filter(x=>x.mail).length,1);
 assert.match(h.calls.find(x=>x.mail).mail.payload.body.content,/確認並隔離 DQ6-H-1016/);
 assert.ok(h.calls.findIndex(x=>x.cmd?.includes('auto-provider-evidence.json'))<h.calls.findIndex(x=>x.cmd?.includes(' complete ')));
 assert.ok(h.calls.some(x=>x.cmd?.includes('ACCEPTED')));
});
test('既有DISPATCHED或完成狀態不再次呼叫郵件',async()=>{
 for(const state of ['DISPATCHED','ACCEPTED','UNKNOWN','BUSY']){const h=harness({state});await runGmailPump({...config,tools:h.tools});assert.equal(h.calls.filter(x=>x.mail).length,0);}
});
test('connector錯誤和缺少回執保留UNKNOWN，沒有自動重寄',async()=>{
 for(const setup of [{throwSend:true},{provider:{isError:true}},{provider:{structuredContent:{}}}]){
 const h=harness(setup);await runGmailPump({...config,tools:h.tools});assert.equal(h.calls.filter(x=>x.mail).length,1);assert.ok(h.calls.some(x=>x.cmd?.includes('UNKNOWN')));}
});
test('錯收件格式、標籤、無界等待在任何副作用前拒絕',async()=>{
 for(const bad of [{recipient:'a@example.test\nBcc:wrong@example.test'},{label:'actor-defined'},{maxWaitMs:999999}]){
 const h=harness();await assert.rejects(runGmailPump({...config,...bad,tools:h.tools}),/CONFIGURATION/);assert.equal(h.calls.length,0);}
});
test('引導對照的Email不要求人員介入',async()=>{
 const h=harness();await runGmailPump({...config,label:'DQ6-N-1016',tools:h.tools});assert.match(h.calls.find(x=>x.mail).mail.payload.body.content,/不要求你回覆或介入/);
});

test('connector永不完成時有界落盤UNKNOWN且不重寄，不聲稱取消',async()=>{
 const h=harness();let sends=0;h.tools.mcp__codex_apps__gmail_send_email=async()=>{sends++;return new Promise(()=>{});};
 const start=Date.now();await runGmailPump({...config,tools:h.tools,sendTimeoutMs:15});
 assert.equal(sends,1);assert.ok(Date.now()-start<1000);assert.ok(h.calls.some(x=>x.cmd?.includes('UNKNOWN')));
 assert.ok(h.calls.some(x=>x.cmd?.includes(' complete ')));
});
