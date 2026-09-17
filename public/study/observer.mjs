const $ = id => document.getElementById(id); const key = 'dungeonq-study-observer';
const supplied = new URLSearchParams(location.hash.slice(1)).get('token');
if (supplied) { sessionStorage.setItem(key, supplied); history.replaceState(null, '', location.pathname); }
const token = sessionStorage.getItem(key); let busy = false; let timer; let verified = false;
const node = (tag, text, cls) => { const item = document.createElement(tag); item.textContent = text; if (cls) item.className = cls; return item; };
const notice = (text, error = false) => { $('notice').textContent = text; $('notice').className = error ? 'notice error' : 'notice'; };
const value = data => data === null || data === undefined ? '未提供' : String(data);
const outcome = data => data === null ? '未知' : data ? '成功' : '失敗';
async function api(path) {
  if (!token) throw new Error('請使用主持人的獨立觀測連結。');
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'OBSERVER_UNAVAILABLE'); return data;
}
function row(values) { const result = document.createElement('tr'); values.forEach(item => result.append(node('td', item))); return result; }
function render(data) {
  const summary = data.summary;
  $('events').textContent = data.events.length; $('wrong-step').textContent = summary.firstWrongConfidentStep ?? '尚無';
  $('diagnostic-step').textContent = summary.firstDiagnosticStep ?? '尚無'; $('suspicion-step').textContent = summary.firstHighSuspicionStep ?? '尚無';
  $('source').textContent = `來源聲明：${summary.participantMode ?? '尚未參與'} · 階段：${summary.phase}`;
  $('assignment').textContent = `主持人答案：${summary.arm} · 因果規則 ${summary.rule}。參與者未結束前不會從 Actor 取得此欄位。`;
  verified = data.verification.valid === true;
  $('verification').textContent = verified ? `已收到的 ${data.verification.eventCount} 筆事件因果核驗通過` : '核驗未通過';
  $('lag').textContent = `相對最近進度通知，尚有 ${data.lag} 筆待追趕。`;
  $('prediction-summary').textContent = `練習成功 ${summary.trainingSuccesses} 次 · 錯誤預測 ${summary.wrongPredictionCount} 次 · 未提供預測 ${summary.missingPredictionCount} 次。`;
  $('predictions').replaceChildren(...summary.predictions.map(p => row([`${p.sequence}／${p.outcomeSequence ?? '未執行'}`, `${p.choiceId} · ${p.stage}`,
    `${outcome(p.predictedSuccess)}／${p.outcomeSequence === null ? '未執行' : outcome(p.actualSuccess)}`, p.hypothesis, `${value(p.confidence)}／${value(p.suspicion)}`])));
  $('reflections').replaceChildren(...summary.reflections.map(p => row([String(p.sequence), p.hypothesis, `${value(p.confidence)}／${value(p.suspicion)}`, p.nextIntent])));
  $('belief').textContent = `${summary.beliefStatus} · 只有明示解釋，不推知內心；沒有自評不等於沒有懷疑。${summary.efficacyClaim}`;
  $('timeline').replaceChildren(...data.events.map(event => {
    const item = document.createElement('li'); item.append(node('h3', `${event.sequence} / ${event.command.type} · ${event.observation.outcome}`));
    const details = document.createElement('details'); details.append(node('summary', '核對原始輸入、結果與摘要'), node('pre', JSON.stringify(event, null, 2))); item.append(details); return item;
  }));
  if (!data.events.length) $('timeline').append(node('li', '等待第一筆紀錄；空白不是驗收通過。'));
  $('download').disabled = !verified;
}
async function refresh() {
  if (busy) return; busy = true; $('refresh').disabled = true;
  try { render(await api('/api/observer')); notice('已由獨立觀測資料庫重播核驗。'); }
  catch (error) { verified = false; $('verification').textContent = '更新失敗，最新狀態未知'; $('download').disabled = true; notice(error.message, true); }
  finally { busy = false; $('refresh').disabled = false; }
}
$('refresh').addEventListener('click', refresh);
$('live').addEventListener('change', () => { clearInterval(timer); if ($('live').checked) timer = setInterval(refresh, 3000); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearInterval(timer); $('live').checked = false; } });
$('download').addEventListener('click', async () => {
  $('download').disabled = true;
  try {
    const bundle = await api('/api/evidence'); const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `dungeonq-study-${bundle.worldId}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    notice('已交給瀏覽器下載；可用 study:verify 重播。完整證據含主持人答案，不應提前交給同場盲測者。');
  } catch (error) { notice(error.message, true); } finally { $('download').disabled = !verified; }
});
await refresh();
