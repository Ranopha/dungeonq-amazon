// DungeonQ ACK 頁：只用 textContent 呈現資料；倒數只在瀏覽器本地更新文字。
// 唯一會重複呼叫伺服器的是「決策結果」：送出後若仍在處理，間隔逐次拉長、最多 10 次（計畫「摘要頁即時更新」上限）；頁面不在前景、工作階段失效或伺服器拒絕即停止。
const parts = location.pathname.split('/');
const incidentId = parts[2] ?? ''; const handle = parts[3] ?? '';
const $ = id => document.getElementById(id);
const time = value => Number.isSafeInteger(value) ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)) + '（台北）' : '未記錄';
const messages = {
  ACK_LINK_DENIED: '連結無效。', ACK_INCIDENT_MISMATCH_DENIED: '連結與事件不符。', ACK_LINK_USED_DENIED: '這個連結已使用過，或事件已經確認。',
  ACK_LINK_EXPIRED_DENIED: '連結已過期。', ACK_LINK_LOCKED_DENIED: '失敗次數過多，這個連結已鎖定。', ACK_CREDENTIALS_DENIED: '密碼或驗證碼不正確。',
  ACK_RATE_LIMIT: '嘗試太頻繁，請稍後再試。', ACK_ACCOUNT_UNAVAILABLE: '本機尚未設定 ACK 帳號，無法確認。逾時後系統會執行預設安全動作。',
  ACK_SESSION_DENIED: '摘要工作階段已過期，請重新開啟新的 ACK 連結。',
  DECISION_ORIGIN_DENIED: '請求不是從本機摘要頁送出，已拒絕。', DECISION_SESSION_DENIED: '工作階段無效，請重新開啟新的 ACK 連結。',
  DECISION_SESSION_EXPIRED_DENIED: '工作階段已過期，請重新開啟新的 ACK 連結。', DECISION_INCIDENT_MISMATCH_DENIED: '工作階段屬於其他事件，已拒絕。',
  DECISION_TOKEN_DENIED: '一次性確認碼無效，請重新送出。', DECISION_TOKEN_USED_DENIED: '一次性確認碼已使用過，同一個請求不能重送。',
  DECISION_TOKEN_EXPIRED_DENIED: '一次性確認碼已過期，請重新送出。', DECISION_IN_PROGRESS: '這個事件已有決策在處理，請等它完成。',
  DECISION_LIMIT: '這個事件的決策數已達上限（20 個）。', DECISION_INCIDENT_CLOSING: '已開始結束流程，不能再送出 A 級或 B 級決策。',
  DECISION_REQUEST_INVALID: '決策內容不完整或格式不符。', ADMIN_DECISION_NOT_CONFIGURED: '管理員決策尚未接上，只能檢視摘要。',
  DECISION_NOT_FOUND: '找不到這個決策。', LOOPBACK_REQUIRED: '只能在執行 DungeonQ 的這台 Mac 上送出決策。',
  DECISION_CONFIRM_REQUIRED: '請先勾選確認，再送出。', DECISION_CLOSE_INCOMPLETE: '開始結束流程前，五個根因欄位的發現與改善、以及後續負責人都要填寫。'
};
const outcomeText = { EXECUTED: '已執行，讀回確認生效', NOT_EFFECTIVE: '已送出，但讀回沒有確認生效（可能已自動回復並升級）',
  WORK_ORDER_CREATED: '已建立工單（系統不執行，交給人處理）', WORK_ORDER_EXISTS: '同一動作與對象已有未結束的工單，沒有另開新單',
  CLOSED: '結束流程已完成', CLOSE_HALTED: '結束流程停在其中一步，處理原因後可以再送一次「開始結束流程」從該步續跑',
  REJECTED: '被拒絕，沒有執行任何動作', FAILED: '處理失敗，沒有確認任何結果', UNKNOWN: '結果不明（不會自動重送，請先查看摘要與處置紀錄）' };
const kindText = { EXECUTE_A_CLASS: '執行 A 級動作', CREATE_WORK_ORDER: '建立 B 級工單', START_CLOSE: '開始結束流程' };
const ROOT_CAUSE = ['detection', 'wrongTicket', 'notification', 'response', 'documentation'];
const POLL_DELAYS = [2000, 3000, 5000, 8000, 13000, 20000, 20000, 30000, 30000, 30000];
let session = null; let summary = null; let countdown;
function status(text, error = false) { const node = $('status'); node.hidden = false; node.textContent = text; node.dataset.error = String(error); }
async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store' });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error('request'), { code: value?.error?.code ?? 'SERVICE_UNAVAILABLE' });
  return value;
}
function facts(target, rows) {
  const list = $(target); list.replaceChildren();
  for (const [label, value, urgent] of rows) {
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value; if (urgent) dd.className = 'urgent';
    list.append(dt, dd);
  }
}
function items(target, values, empty) {
  const list = $(target); list.replaceChildren();
  for (const text of values.length ? values : [empty]) { const li = document.createElement('li'); li.textContent = text; list.append(li); }
}
const stageText = { HUMAN_ACKNOWLEDGED: '已由真人確認（升級已停止）', ESCALATION_DISABLED: '升級已停用', ESCALATION_FINISHED: '升級時間表已走完',
  CLOSED_AUTO_SAFE_DEFAULT: '已逾時，系統執行預設安全動作（AUTO_SAFE_DEFAULT，不是真人處置）' };
function remaining() {
  const next = summary?.nextEscalation; if (!next) return '沒有待執行的升級';
  const ms = Math.max(0, next.dueAt - Date.now()); const minutes = Math.floor(ms / 60000); const seconds = Math.floor(ms % 60000 / 1000);
  return `${next.label}：剩 ${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
}
function render(view) {
  summary = view; const host = view.host ?? {}; const ticket = view.ticket ?? {};
  facts('summary-facts', [
    ['事件', `${view.shortId}（${view.incidentId}）`], ['目前階段', stageText[view.stage.current] ?? view.stage.current],
    ['距下一次升級', remaining(), Boolean(view.nextEscalation)],
    ['確認', view.acknowledgement ? `${view.acknowledgement.account}，${time(view.acknowledgement.at)}，方式 ${view.acknowledgement.method}` : '尚未確認'],
    ['真實資產讀取數', host.realAssetReads?.count === undefined || host.realAssetReads?.count === null ? `不明（${host.realAssetReads?.status ?? '未提供'}）` : String(host.realAssetReads.count), Number(host.realAssetReads?.count) > 0]
  ]);
  facts('ticket-facts', ticket.tracking === false ? [['追蹤', '本次未啟用錯誤 ticket 追蹤']] : [
    ['使用次數', String(ticket.uses ?? 0)], ['被接受次數', String(ticket.accepted ?? 0)],
    ['不同 context 數', String(ticket.distinctContexts ?? 0)], ['不同來源數（未驗證線索）', String(ticket.distinctSources ?? 0)],
    ['是否擴散', ticket.spread ? `是（${ticket.spreadUses} 次，嚴重度 ${ticket.severity}）` : '否', Boolean(ticket.spread)],
    ['已寄出更新', `${ticket.updatesAccepted ?? 0} 封（入列 ${ticket.updatesQueued ?? 0}；達上限後只記錄 ${ticket.suppressedUses ?? 0} 次）`]
  ]);
  const actions = (host.automaticActions?.items ?? []).map(a => `${a.actionCode ?? '-'} ${a.actionName ?? ''}：${a.status ?? '不明'}，讀回 ${a.readback ?? '不明'}${a.targetId ? `（對象 ${a.targetId}）` : ''}`);
  if (view.closure) actions.unshift(`結案原因 ${view.closure.reason}（${time(view.closure.at)}），由系統自動執行，不是真人處置`);
  items('actions', actions, host.automaticActions?.source === 'LEDGER' ? '尚未執行任何 A 級動作' : '處置紀錄尚未接上或讀取失敗，狀態不明');
  const health = host.legitimateHealth ?? {};
  facts('health-facts', [['狀態', health.status ?? '未接上', health.status === 'UNHEALTHY'], ['說明', health.reason ?? '—'], ['量測時間', health.measuredAt ?? '—']]);
  const orders = host.workOrders?.items ?? [];
  items('work-orders', orders.map(o => `${o.actionCode ?? ''} ${o.title ?? ''}：${o.status}，讀回 ${o.verification ?? '—'}（${o.ref ?? o.workOrderId}）`),
    host.workOrders?.status === 'NOT_CONFIGURED' ? '工單儲存尚未接上' : '沒有待處理的工單');
  items('recommendations', (host.recommendations ?? []).map(r => `${r.actionCode ?? ''} ${r.actionName ?? ''}：${r.impact ?? ''}`), '沒有額外建議');
  const m = view.measurements ?? {};
  facts('measurements', [['入場（T0）', time(m.t0)], ['寄件佇列建立', time(m.queueCreatedAt)], ['供應商回執', `${time(m.providerAcceptedAt)}${m.providerChannel ? `（${m.providerChannel}）` : ''}`],
    ['收件匣到達', m.inboxArrival?.status === 'FOUND' ? time(m.inboxArrival.at) : `不明（${m.inboxArrival?.status ?? '—'}）`], ['已驗證真人 ACK', time(m.verifiedHumanAckAt)]]);
  items('evidence', (host.evidence ?? []).map(e => `${e.label}：${e.ref}`), '沒有可列出的證據連結');
  $('boundary').textContent = view.boundary ?? '';
  renderDecisions(view);
  clearInterval(countdown);
  if (view.nextEscalation) countdown = setInterval(() => { if (!document.hidden) facts('summary-facts', [...document.querySelectorAll('#summary-facts dt')].map((dt, i) => [dt.textContent, i === 2 ? remaining() : dt.nextElementSibling.textContent])); }, 1000);
}
async function loadSummary() {
  if (!session) return;
  $('refresh').disabled = true;
  try { render(await post('/ack/summary', { incidentId, summaryToken: session })); $('summary').hidden = false; }
  catch (error) { status(messages[error.code] ?? `摘要讀取失敗（${error.code}）`, true); if (error.code === 'ACK_SESSION_DENIED') session = null; }
  finally { setTimeout(() => { $('refresh').disabled = !session; }, 5000); }
}
/* ---------------- 送出決策 ---------------- */
let polling = null;
function decisionLine(item) {
  const request = item.request ?? {}; const result = item.result ?? {};
  const what = request.kind === 'START_CLOSE' ? kindText.START_CLOSE : `${kindText[request.kind] ?? request.kind} ${request.actionCode ?? ''}（對象 ${request.targetId ?? '-'}）`;
  const state = item.state === 'RUNNING' ? '處理中' : item.state === 'UNKNOWN' ? '中斷，結果不明' : outcomeText[result.outcome] ?? result.outcome ?? '不明';
  return `${time(item.submittedAt)}　${what}：${state}${result.readback ? `；讀回 ${result.readback}` : ''}`;
}
function resultLines(item) {
  const result = item.result ?? {}; const lines = [];
  lines.push(item.state === 'RUNNING' ? '處理中：系統正在依政策執行並讀回，完成後會顯示結果。' : `結果：${outcomeText[result.outcome] ?? result.outcome ?? '不明'}`);
  if (result.policy) lines.push(`政策判定：${result.policy.effect ?? '-'}（${result.policy.reason ?? '-'}）；合法使用者健康 ${result.policy.healthStatus ?? '-'}`);
  if (result.reason) lines.push(`原因代碼：${result.reason}${result.permit ? `；授權檢查 ${result.permit}` : ''}${result.field ? `；欄位 ${result.field}` : ''}`);
  if (result.action) lines.push(`動作 ${result.action.actionCode ?? ''} ${result.action.actionName ?? ''}：${result.action.status ?? '-'}，讀回 ${result.action.readback ?? '-'}（對象 ${result.action.targetId ?? '-'}）`);
  if (result.workOrder) lines.push(`工單 ${result.workOrder.workOrderId ?? '-'}：${result.workOrder.status ?? '-'}，讀回 ${result.readback ?? '-'}${result.workOrder.ref ? `（${result.workOrder.ref}）` : ''}`);
  if (result.close) lines.push(`結束流程：${result.close.status ?? '-'}${result.close.step ? `，停在 ${result.close.step}（${result.close.code ?? '-'}）` : ''}`);
  return lines;
}
function showResult(item, error = false) {
  const node = $('decision-result'); node.hidden = false; node.replaceChildren();
  node.dataset.error = String(error); node.dataset.state = item?.state === 'RUNNING' ? 'running' : 'done';
  for (const text of item ? resultLines(item) : []) { const p = document.createElement('p'); p.textContent = text; node.append(p); }
}
function showDecisionError(code) {
  const node = $('decision-result'); node.hidden = false; node.dataset.error = 'true'; node.dataset.state = 'done';
  node.textContent = messages[code] ?? `送出失敗（${code}）`;
}
function selectedKind() { return document.querySelector('input[name=kind]:checked')?.value ?? 'EXECUTE_A_CLASS'; }
function fillActions() {
  const options = summary?.host?.decisionOptions ?? {}; const kind = selectedKind();
  $('action-fields').hidden = kind === 'START_CLOSE'; $('close-fields').hidden = kind !== 'START_CLOSE';
  const list = kind === 'EXECUTE_A_CLASS' ? options.aClass ?? [] : kind === 'CREATE_WORK_ORDER' ? options.bClass ?? [] : [];
  const select = $('action'); const previous = select.value; select.replaceChildren();
  for (const item of list) { const option = document.createElement('option'); option.value = item.actionCode; option.textContent = `${item.actionCode} ${item.actionName}`; select.append(option); }
  if (list.some(item => item.actionCode === previous)) select.value = previous;
  fillTargets();
}
function fillTargets() {
  const options = summary?.host?.decisionOptions ?? {}; const kind = selectedKind();
  const list = kind === 'EXECUTE_A_CLASS' ? options.aClass ?? [] : options.bClass ?? [];
  const action = list.find(item => item.actionCode === $('action').value);
  $('action-impact').textContent = action ? `影響：${action.impact}` : kind === 'START_CLOSE' ? '' : '目前沒有可選的動作。';
  const select = $('target'); select.replaceChildren();
  for (const target of action?.targets ?? []) { const option = document.createElement('option'); option.value = target.targetId; option.textContent = `${target.targetId}（${target.kind}）`; select.append(option); }
  const missing = kind !== 'START_CLOSE' && (!action || (action.targets ?? []).length === 0);
  if (missing && action) $('action-impact').textContent += ' 登錄表中沒有這個動作可用的對象。';
  const closeMissing = kind === 'START_CLOSE' && options.close?.available !== true;
  if (closeMissing) $('action-impact').textContent = '結束流程尚未接上，無法從摘要頁開始。';
  $('decide-button').disabled = Boolean(polling) || missing || closeMissing;
}
function renderDecisions(view) {
  const decisions = view.decisions ?? {};
  $('decide').hidden = false;
  const unavailable = $('decide-unavailable');
  if (decisions.configured !== true) {
    unavailable.hidden = false; unavailable.textContent = messages.ADMIN_DECISION_NOT_CONFIGURED; $('decide-form').hidden = true;
  } else { unavailable.hidden = true; $('decide-form').hidden = false; fillActions(); }
  items('decisions', (decisions.items ?? []).map(decisionLine), '還沒有送出任何決策');
}
function buildRequest() {
  const kind = selectedKind();
  if (kind !== 'START_CLOSE') return { kind, actionCode: $('action').value, targetId: $('target').value };
  const rootCause = Object.fromEntries(ROOT_CAUSE.map(key => [key, { finding: $(`rc-${key}-finding`).value, improvement: $(`rc-${key}-improvement`).value }]));
  return { kind, close: { verdict: $('verdict').value, severity: $('severity').value, identityConfirmed: $('identity').checked, rootCause, owner: $('owner').value } };
}
function stopPolling(note) {
  clearTimeout(polling?.timer); polling = null; fillTargets();
  if (note) { const node = $('decision-result'); const p = document.createElement('p'); p.textContent = note; node.append(p); }
}
function poll(decisionId, attempt = 0) {
  if (attempt >= POLL_DELAYS.length) return stopPolling('已停止自動更新；請稍後按「重新整理摘要」查看結果。');
  polling = { decisionId, timer: setTimeout(async () => {
    if (document.hidden) return stopPolling('頁面不在前景，已停止自動更新；回到頁面後按「重新整理摘要」查看結果。');
    if (!session) return stopPolling('工作階段已失效，已停止自動更新。');
    try {
      const item = await post('/ack/decision/status', { incidentId, summaryToken: session, decisionId });
      showResult(item);
      if (item.state === 'RUNNING') return poll(decisionId, attempt + 1);
      stopPolling(); await loadSummary();
    } catch (error) {
      if (/SESSION/.test(error.code)) session = null;
      stopPolling(messages[error.code] ?? `讀取結果失敗（${error.code}），已停止自動更新。`);
    }
  }, POLL_DELAYS[attempt]) };
}
$('decide-form').addEventListener('change', event => {
  if (event.target.name === 'kind') fillActions(); else if (event.target.id === 'action') fillTargets();
});
$('decide-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!session || polling) return;
  if (!$('confirm').checked) { showDecisionError('DECISION_CONFIRM_REQUIRED'); return; }
  const request = buildRequest();
  if (request.kind === 'START_CLOSE' && ![...ROOT_CAUSE.flatMap(key => [`rc-${key}-finding`, `rc-${key}-improvement`]), 'owner'].every(id => $(id).value.trim())) {
    showDecisionError('DECISION_CLOSE_INCOMPLETE'); return;
  }
  const button = $('decide-button'); button.disabled = true;
  try {
    // 每次送出前取得新的一次性確認碼（綁定這個工作階段與事件，只能用一次）。
    const { decisionToken } = await post('/ack/decision/token', { incidentId, summaryToken: session });
    const item = await post('/ack/decision', { incidentId, summaryToken: session, decisionToken, request });
    $('confirm').checked = false; showResult(item);
    if (item.state === 'RUNNING') { poll(item.decisionId); fillTargets(); }
    else await loadSummary();
  } catch (error) {
    if (/SESSION/.test(error.code)) session = null;
    showDecisionError(error.code);
  } finally { if (!polling) fillTargets(); }
});

$('incident-label').textContent = /^incident-[a-f0-9]{64}$/.test(incidentId) ? `事件 ${incidentId.slice(9, 21).toUpperCase()}` : '連結格式不正確';
$('verify-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('verify-button'); button.disabled = true;
  try {
    const totp = $('totp').value.trim();
    const result = await post('/ack/verify', { incidentId, handle, password: $('password').value, ...(totp ? { totp } : {}) });
    $('password').value = ''; $('totp').value = '';
    session = result.summaryToken; $('verify-section').hidden = true;
    status(`已確認：${result.account}，${time(result.at)}。升級通知已停止。`);
    await loadSummary(); $('summary-title').focus();
  } catch (error) { status(messages[error.code] ?? `確認失敗（${error.code}）`, true); button.disabled = false; }
});
$('refresh').addEventListener('click', () => { void loadSummary(); });
