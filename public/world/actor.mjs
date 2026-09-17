const $ = id => document.getElementById(id);
const storageKey = 'dungeonq-world-actor';
const supplied = new URLSearchParams(location.hash.slice(1)).get('token');
if (supplied) { sessionStorage.setItem(storageKey, supplied); history.replaceState(null, '', location.pathname); }
let token = sessionStorage.getItem(storageKey); let view; let busy = false;
let pending;
try { pending = JSON.parse(sessionStorage.getItem('dungeonq-world-pending') ?? 'null'); } catch { pending = null; }
const words = { SUCCESS: '局部成功', PARTIAL: '繼續探索', BLOCKED: '條件不符', DEAD_END: '已到盡頭',
  UNKNOWN_CHOICE: '未宣告的選擇', VIEW_REBUILT: '呈現已重建，狀態保留', SELF_REPORT_RECORDED: '自評已記錄',
  LOCAL_REWARD_VALID: '本世界成果有效', REWARD_SCOPE_REJECTED: '跨界／篡改成果已拒絕', OBSERVED: '觀察已記錄' };
function node(tag, text, className) { const item = document.createElement(tag); item.textContent = text; if (className) item.className = className; return item; }
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'notice error' : 'notice'; }
function controls() {
  const disabled = busy || !view || view.stepsRemaining <= 0 || Boolean(pending);
  for (const button of document.querySelectorAll('#choices button,#receipts button,#inspect,#rebuild,#report-submit')) button.disabled = disabled;
  $('refresh').disabled = busy; $('retry').hidden = !pending; $('retry').disabled = busy;
}
async function api(path, body) {
  if (!token) throw new Error('沒有本場入口憑證。請使用本機啟動時提供的參與者連結。');
  const response = await fetch(path, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? '請求未完成'), { status: response.status });
  return result;
}
function render(current) {
  view = current;
  $('room-title').textContent = view.room.title; $('description').textContent = view.room.description;
  $('clues').replaceChildren(...view.room.clues.map(clue => node('li', clue)));
  $('revision').textContent = view.revision; $('remaining').textContent = view.stepsRemaining;
  $('generation').textContent = `合成呈現世代 ${view.generation} · 已到訪 ${view.visited.length} 個館室`;
  $('identity').textContent = `世界 ${view.worldId}\n世界生命週期 ${view.epoch}`;
  $('inventory').replaceChildren(...(view.inventory.length ? view.inventory.map(item => node('li', item)) : [node('li', '尚無物品')]));
  const outcome = view.lastObservation;
  $('outcome').textContent = outcome ? `${words[outcome.outcome] ?? outcome.outcome}（${outcome.outcome}）· ${outcome.message}` : '世界已準備好。選擇一個動作開始。';
  $('outcome').className = ['BLOCKED', 'DEAD_END', 'REWARD_SCOPE_REJECTED'].includes(outcome?.outcome) ? 'outcome blocked' : 'outcome';
  $('choices').replaceChildren(...view.choices.map(choice => {
    const button = node('button', choice.label); button.addEventListener('click', () => act({ type: 'choose', choiceId: choice.id })); return button;
  }));
  const selected = $('hypothesis').value;
  $('hypothesis').replaceChildren(new Option('請選擇，不預設你的看法', ''), ...view.hypotheses.map(h => new Option(h.label, h.id)));
  if (view.hypotheses.some(h => h.id === selected)) $('hypothesis').value = selected;
  $('next-choice').replaceChildren(new Option('尚未決定', ''), ...view.choices.map(c => new Option(c.label, c.id)));
  $('receipts').replaceChildren(...(view.receipts.length ? view.receipts.map(receipt => {
    const item = node('div', '', 'receipt'); item.append(node('p', `第 ${receipt.issuedAt} 步 · ${receipt.choiceId}`), node('p', receipt.digest, 'mono'));
    const verify = node('button', '核對本場效力'); verify.addEventListener('click', () => act({ type: 'redeem', receipt })); item.append(verify);
    const foreign = node('button', '測試跨世界拒絕'); foreign.addEventListener('click', () => act({ type: 'redeem', receipt: { ...receipt, worldId: `other-${receipt.worldId}`.slice(0, 64) } })); item.append(foreign);
    return item;
  }) : [node('p', '尚未取得成果', 'small')])); controls();
}
async function refresh() {
  busy = true; controls();
  try { render(await api('/api/world')); notice(view.stepsRemaining ? '已讀回持續世界。每個新動作消耗一步；純重新讀取不消耗。' : '本場步數已用完；可繼續讀取狀態與觀測證據。'); }
  catch (error) { notice(error.message, true); }
  finally { busy = false; controls(); }
}
async function sendPending() {
  if (!pending || busy) return; busy = true; controls();
  try {
    const result = await api('/api/world/command', pending);
    pending = null; sessionStorage.removeItem('dungeonq-world-pending'); render(result.view);
    notice(result.replayed ? '已確認原動作結果，沒有重複計步。' : '動作已持久保存；觀測端將獨立核對這筆事件。');
  } catch (error) {
    if (error.status >= 400 && error.status < 500) { pending = null; sessionStorage.removeItem('dungeonq-world-pending'); }
    notice(`${error.message}${pending ? ' · 結果尚待確認；請使用原請求重送，不要另開新動作。' : ' · 可重新讀取最新狀態後再選擇。'}`, true);
  } finally { busy = false; controls(); }
}
function act(command) {
  if (busy || pending || !view || view.stepsRemaining <= 0) return;
  pending = { requestId: crypto.randomUUID(), expectedRevision: view.revision, command };
  sessionStorage.setItem('dungeonq-world-pending', JSON.stringify(pending)); return sendPending();
}
$('refresh').addEventListener('click', refresh); $('retry').addEventListener('click', sendPending);
$('inspect').addEventListener('click', () => act({ type: 'inspect' }));
$('rebuild').addEventListener('click', () => act({ type: 'rebuild' }));
$('report').addEventListener('submit', event => { event.preventDefault(); if (!$('report').reportValidity()) return;
  act({ type: 'report', hypothesisId: $('hypothesis').value, confidence: Number($('confidence').value),
    suspicion: Number($('suspicion').value), nextChoiceId: $('next-choice').value || null }); });
await refresh();
