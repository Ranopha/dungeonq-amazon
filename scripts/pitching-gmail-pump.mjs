/** Session-bound connector pump. tools are supplied by the trusted app executor;
 * no model is consulted between an ENTERED job and the Gmail call.
 * Recipient and run label come from operator configuration, never actor records.
 */
export async function runGmailPump({ tools, directory, sourceDirectory, recipient, label, notify = () => {}, maxWaitMs = 180000, sendTimeoutMs = 30000 }) {
  if (!/^\/[^\n\r]+$/.test(sourceDirectory) || !/^\/[^\n\r]+$/.test(directory) || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(recipient)
    || !Number.isInteger(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > 30000
    || !/^DQ6-[HNBF]-1016$/.test(label) || !Number.isInteger(maxWaitMs) || maxWaitMs < 1000 || maxWaitMs > 300000)
    throw Error('TRUSTED_PUMP_CONFIGURATION_REQUIRED');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const script = 'scripts/pitching-auto-relay.mjs';
  const cwd = sourceDirectory;
  const execute = async cmd => {
    const result = await tools.exec_command({cmd, workdir: cwd, yield_time_ms:30000, max_output_tokens:2000});
    if (result.exit_code !== 0 || result.session_id) throw Error('RELAY_COMMAND_INCOMPLETE');
    return JSON.parse(result.output.trim());
  };
  const save = async (name, data) => {
    const body = JSON.stringify(data);
    const code = 'import os,pathlib,sys;os.umask(0o077);p=pathlib.Path(sys.argv[1]);f=p.open("x");f.write(sys.argv[2]+"\\n");f.close();os.chmod(p,0o600)';
    const result = await tools.exec_command({cmd:`python3 -c ${quote(code)} ${quote(directory+'/'+name)} ${quote(body)}`,max_output_tokens:300});
    if (result.exit_code !== 0) throw Error('EVIDENCE_SAVE_FAILED');
  };
  const startedAt = Date.now();
  notify({state:'AUTOMATIC_RELAY_ARMED',label});
  while (Date.now()-startedAt < maxWaitMs) {
    const job = await execute(`NODE_NO_WARNINGS=1 node ${script} ${quote(directory)} next 25000`);
    if (job.state === 'WAITING' || job.state === 'TIMEOUT') continue;
    if (job.state !== 'DISPATCH') { notify({state:job.state,label}); return job; }
    const calledAt=Date.now();
    let outcome='UNKNOWN', receiptId, provider, sendTimer;
    try {
      provider=await Promise.race([tools.mcp__codex_apps__gmail_send_email({to:recipient,subject:`[DungeonQ 測試告警] ${label} 已進入隔離場景`,payload:{mime_type:'text/html',body:{content:
        `<p>事件 <strong>${label}</strong> 已觸發。這是你授權的 DungeonQ 人工隔離測試；不是企業真實入侵。</p>`+
        '<p>入場後由預先啟動的事件接力自動寄出。公開入口與付費模型 API 未啟用；場景不能取得真實核心資源。</p>'+
        (label==='DQ6-H-1016'?`<p>本封用於真人處置測試。實際看到後，請回到 Codex 對話回覆「收到，確認並隔離 ${label}」。收到明確回覆後，受權代理會執行隔離並量測時間。未回覆時，五分鐘後只做安全收尾，不能算真人處置成功。</p>`:
        '<p>本封屬三組引導對照，僅作通知證據。參與者將自行停止，再執行收尾；不要求你回覆或介入。</p>')+
        '<p>郵件不含憑證或企業資料。寄件回執不等於收件或閱讀時間。</p>'}},response_fields:['id','thread_id']}), new Promise((_, reject) => { sendTimer=setTimeout(() => reject(Error('CONNECTOR_TIMEOUT_UNKNOWN')),sendTimeoutMs); })]);
      const structured=provider?.structuredContent;
      const id=structured?.id ?? structured?.message?.id ?? structured?.data?.id;
      if (provider?.isError !== true && typeof id==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) {outcome='ACCEPTED';receiptId=id;}
    } catch { provider={isError:true,reason:'CONNECTOR_OUTCOME_UNKNOWN'}; }
    finally { clearTimeout(sendTimer); } // Timeout does not cancel a possibly accepted send; never resend.
    const completedAt=Date.now();
    await save('auto-provider-evidence.json',{label,job,calledAt,completedAt,provider});
    const completion={jobId:job.jobId,outcome,referenceId:`${label}-provider`,...(receiptId?{receiptId}:{})};
    await save('auto-provider-completion.json',completion);
    const result=await execute(`NODE_NO_WARNINGS=1 node ${script} ${quote(directory)} complete ${quote(directory+'/auto-provider-completion.json')}`);
    notify({state:outcome,label,entryToConnectorCallMs:calledAt-job.enteredAt,connectorMs:completedAt-calledAt});
    return result;
  }
  notify({state:'NO_ENTRY_BEFORE_DEADLINE',label});
  return {state:'NO_ENTRY_BEFORE_DEADLINE'};
}
