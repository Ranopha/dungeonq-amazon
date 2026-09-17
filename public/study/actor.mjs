const $ = id => document.getElementById(id);
const tokenKey = 'dungeonq-study-actor'; const pendingKey = 'dungeonq-study-pending';
const supplied = new URLSearchParams(location.hash.slice(1)).get('token');
if (supplied) { sessionStorage.setItem(tokenKey, supplied); history.replaceState(null, '', location.pathname); }
const token = sessionStorage.getItem(tokenKey); let view; let pending; let busy = false;
try { pending = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null'); } catch { pending = null; }
const names = { CONSENT: '參與告知', PREDICT: '先保存你的預測', ACT: '再取得真實結果', REFLECT: '最後記錄你的反思', COMPLETE: '研究完成', WITHDRAWN: '已退出研究' };
const hypotheses = { signal: '第一種特徵決定', structure: '第二種特徵決定', both: '兩種特徵都需要', unknown: '資訊不足' };
const terminal = () => ['COMPLETE', 'WITHDRAWN'].includes(view?.phase);
const node = (tag, text, cls) => { const item = document.createElement(tag); item.textContent = text; if (cls) item.className = cls; return item; };
const notice = (text, error = false) => { $('notice').textContent = text; $('notice').className = error ? 'notice error' : 'notice'; };
function controls() {
  for (const button of document.querySelectorAll('button[type=submit],#act-submit')) button.disabled = busy || Boolean(pending) || !view || terminal();
  $('refresh').disabled = busy; $('withdraw').disabled = busy || !view || terminal();
  $('retry').hidden = !pending; $('retry').disabled = busy || !view;
}
function discardForeignPending() {
  if (!pending || !view || pending.worldId === view.worldId) return false;
  pending = null; sessionStorage.removeItem(pendingKey);
  notice('上一筆屬於不同的本機世界，已停止重送；其結果需回原場核對。', true);
  return true;
}
function syncRating(prefix) {
  const unknown = $(`${prefix}-hypothesis`).value === 'unknown';
  $(`${prefix}-confidence`).disabled = unknown; if (unknown) $(`${prefix}-confidence`).value = '';
}
function render(current) {
  const newStep = view?.revision !== current.revision || view?.worldId !== current.worldId;
  view = current;
  discardForeignPending();
  for (const [name, phases] of Object.entries({ consent: ['CONSENT'], predict: ['PREDICT'], act: ['ACT'], reflect: ['REFLECT'], complete: ['COMPLETE', 'WITHDRAWN'] })) $(name + '-stage').hidden = !phases.includes(view.phase);
  $('phase-title').textContent = names[view.phase]; $('phase-number').textContent = view.profile;
  $('revision').textContent = `已保存 ${view.revision} 筆紀錄`;
  $('consent-notice').textContent = view.consentNotice; $('room-id').textContent = view.room.id;
  $('room-title').textContent = view.room.title; $('room-description').textContent = view.room.description;
  $('commitment').textContent = view.assignmentCommit;
  $('inventory-count').textContent = view.inventory.length; $('receipt-count').textContent = view.receipts.length;
  const legend = node('legend', '選擇物件'); $('cards').replaceChildren(legend);
  for (const [index, choice] of view.choices.entries()) {
    const label = node('label', '', 'study-card'); const input = document.createElement('input'); input.type = 'radio'; input.name = 'choice'; input.value = choice.id; input.required = true; input.id = `choice-${index}`;
    label.htmlFor = input.id; label.append(input, node('span', `物件 ${index + 1}`), node('strong', choice.label),
      node('p', `第一特徵：${choice.features.signal ? '成立' : '不成立'} · 第二特徵：${choice.features.structure ? '成立' : '不成立'}`)); $('cards').append(label);
  }
  if (newStep && view.phase === 'PREDICT') { $('predict-form').reset(); syncRating('predict'); }
  if (newStep && view.phase === 'REFLECT') { $('reflect-form').reset(); syncRating('reflect'); }
  if (view.pendingPrediction) {
    const p = view.pendingPrediction;
    $('committed').textContent = `物件：${p.choiceId}\n預測：${p.predictedSuccess === null ? '未知' : p.predictedSuccess ? '成功' : '失敗'}\n解釋：${hypotheses[p.hypothesis]}\n信心：${p.confidence ?? '未提供'} · 懷疑：${p.suspicion ?? '未提供'}`;
  }
  if (view.lastResult) {
    $('result-title').textContent = view.lastResult.success ? '這次，物件被接受。' : '這次，物件沒有被接受。';
    $('result-message').textContent = view.lastResult.message; $('result-card').textContent = `物件 ${view.lastResult.choiceId} · 第一次看見這個結果後，才填下方反思。`;
  }
  if (view.debrief) {
    $('terminal-title').textContent = names[view.phase]; $('debrief-explanation').textContent = view.debrief.explanation;
    $('debrief-limitations').textContent = view.debrief.limitations; $('debrief-commit').textContent = JSON.stringify(view.debrief.assignment, null, 2);
  }
  controls();
}
async function api(body) {
  if (!token) throw new Error('請使用本機啟動時提供的參與者連結。');
  const response = await fetch(body ? '/api/study/command' : '/api/study', { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error ?? 'REQUEST_FAILED'), { status: response.status, code: result.error }); return result;
}
async function refresh() {
  if (busy) return; busy = true; controls();
  try { render(await api()); notice('已讀回本場研究；重新讀取不會建立事件。'); }
  catch (error) { notice(error.message, true); } finally { busy = false; controls(); }
}
async function sendPending() {
  if (busy || !pending || !view) return;
  if (discardForeignPending()) { controls(); return; }
  busy = true; controls();
  try {
    const result = await api(pending.envelope); pending = null; sessionStorage.removeItem(pendingKey); render(result.view);
    notice(result.replayed ? '已確認原請求，沒有重複執行。' : '這一步已保存；觀測端獨立接收並核驗。');
  } catch (error) {
    if ((error.status >= 400 && error.status < 500) || error.code === 'OBSERVER_BACKLOG_FULL') {
      pending = null; sessionStorage.removeItem(pendingKey);
      try { render(await api()); } catch { /* 保留畫面並明示錯誤，不把舊畫面當作新結果。 */ }
    }
    notice(`${error.message}。${pending ? '結果不明，請確認原請求；不要另送不同動作。' : '未接受新動作；可重新讀取或退出。'}`, true);
  } finally { busy = false; controls(); }
}
function act(command) {
  if (busy || pending || !view || terminal()) return;
  pending = { worldId: view.worldId, envelope: { requestId: crypto.randomUUID(), expectedRevision: view.revision, command } };
  sessionStorage.setItem(pendingKey, JSON.stringify(pending)); return sendPending();
}
function rating(id) { return $(id).value.trim() === '' ? null : Number($(id).value); }
function report(prefix) { return { hypothesis: $(`${prefix}-hypothesis`).value, confidence: $(`${prefix}-hypothesis`).value === 'unknown' ? null : rating(`${prefix}-confidence`), suspicion: rating(`${prefix}-suspicion`) }; }
$('refresh').addEventListener('click', refresh); $('retry').addEventListener('click', sendPending);
$('withdraw').addEventListener('click', async () => {
  if (pending) { await sendPending(); if (pending) { notice('原請求仍待確認；你可以停止參與並關閉頁面，不必繼續作答。服務恢復後再確認退出。', true); return; } }
  await act({ type: 'withdraw' });
});
for (const prefix of ['predict', 'reflect']) $(`${prefix}-hypothesis`).addEventListener('change', () => syncRating(prefix));
$('consent-form').addEventListener('submit', event => { event.preventDefault(); if (!$('consent-form').reportValidity()) return; act({ type: 'consent', accepted: true, participantMode: $('participant-mode').value }); });
$('predict-form').addEventListener('submit', event => { event.preventDefault(); if (!$('predict-form').reportValidity()) return;
  const choice = document.querySelector('input[name=choice]:checked'); if (!choice) return;
  act({ type: 'predict', choiceId: choice.value, predictedSuccess: $('predicted-success').value === 'unknown' ? null : $('predicted-success').value === 'true', ...report('predict') }); });
$('act-submit').addEventListener('click', () => act({ type: 'act' }));
$('reflect-form').addEventListener('submit', event => { event.preventDefault(); if (!$('reflect-form').reportValidity()) return; act({ type: 'reflect', ...report('reflect'), nextIntent: $('next-intent').value }); });
await refresh();
