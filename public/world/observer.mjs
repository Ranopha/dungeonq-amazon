const $ = id => document.getElementById(id);
const key = 'dungeonq-world-observer';
const supplied = new URLSearchParams(location.hash.slice(1)).get('token');
if (supplied) { sessionStorage.setItem(key, supplied); history.replaceState(null, '', location.pathname); }
const token = sessionStorage.getItem(key); let busy = false; let timer;
function node(tag, text, className) { const item = document.createElement(tag); item.textContent = text; if (className) item.className = className; return item; }
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'notice error' : 'notice'; }
async function api(path) {
  if (!token) throw new Error('沒有觀測端憑證。請使用啟動時提供的獨立觀測連結。');
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error ?? '觀測端未回應'); return result;
}
function render(data) {
  const summary = data.summary ?? {};
  $('event-count').textContent = summary.eventCount ?? '未知'; $('successes').textContent = summary.successes ?? '未知';
  $('blocked').textContent = summary.blocked ?? '未知'; $('suspicion-step').textContent = summary.firstHighSuspicionStep ?? '尚無';
  $('verification').textContent = data.verification?.valid === true ? `已收到的 ${data.verification.eventCount} 筆事件因果核驗通過` : '尚未通過核驗';
  $('lag').textContent = Number.isInteger(data.lag) ? `相對最近進度通知，尚有 ${data.lag} 筆待追趕` : '尚不知道待追趕進度';
  const reports = summary.selfReports ?? [];
  $('belief-status').textContent = reports.length ? '參與者自評 · 非系統推論' : 'UNKNOWN';
  $('belief-detail').textContent = reports.length ? `已收到 ${reports.length} 次明示自評；假說切換 ${summary.hypothesisChanges ?? '未知'} 次。這不是欺敵有效性成績。` : '未收到自評；不從成功或文字流暢程度推知信念。';
  $('reports').replaceChildren(...reports.map(report => {
    const row = document.createElement('tr');
    for (const value of [report.sequence, report.hypothesisId, report.confidence, report.suspicion, report.nextChoiceId ?? '未決定']) row.append(node('td', String(value)));
    return row;
  }));
  const names = { inspect: '觀察', choose: '選擇', report: '明示自評', redeem: '核對世界內成果', rebuild: '合成呈現重建' };
  $('timeline').replaceChildren(...(data.events ?? []).map(event => {
    const item = document.createElement('li');
    item.append(node('h3', `${String(event.sequence).padStart(2, '0')} / ${names[event.command.type] ?? event.command.type} · ${event.observation.outcome}`));
    item.append(node('p', event.observation.message));
    if (event.command.choiceId) item.append(node('p', `選擇：${event.command.choiceId}`, 'mono'));
    const detail = document.createElement('details'); detail.append(node('summary', '核對這一步的輸入與摘要'), node('pre', JSON.stringify(event, null, 2))); item.append(detail);
    return item;
  }));
  if (!data.events?.length) $('timeline').append(node('li', '等待第一個世界動作；沒有事件不等於測試通過。'));
  $('download').disabled = data.verification?.valid !== true;
}
async function refresh() {
  if (busy) return; busy = true; $('refresh').disabled = true;
  try { render(await api('/api/observer')); notice('已讀取獨立觀測資料庫，並重播收到的事件。'); }
  catch (error) { notice(`${error.message} · 保留上次畫面，但不能視為最新狀態。`, true); $('verification').textContent = '觀測更新失敗 · 最新狀態未知'; $('download').disabled = true; }
  finally { busy = false; $('refresh').disabled = false; }
}
$('refresh').addEventListener('click', refresh);
$('live').addEventListener('change', () => { clearInterval(timer); if ($('live').checked) timer = setInterval(refresh, 3000); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearInterval(timer); $('live').checked = false; } });
$('download').addEventListener('click', async () => {
  $('download').disabled = true;
  try {
    const bundle = await api('/api/evidence');
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `dungeonq-world-${bundle.worldId}.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    notice('已交給瀏覽器下載。可用 world:verify 獨立重跑；檔案完整性不等於外部來源認證。');
  } catch (error) { notice(error.message, true); }
  finally { $('download').disabled = false; }
});
await refresh();
