const $ = id => document.getElementById(id);
let token = ''; let view; let pending; let busy = false;
const notice = text => { $('notice').textContent = text; };
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', cache: 'no-store',
    redirect: 'error', signal: AbortSignal.timeout(8000) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(Error(result.error ?? 'REQUEST_FAILED'), { code: result.error, status: response.status });
  return result;
}
function controls() {
  const locked = busy || Boolean(pending);
  for (const button of document.querySelectorAll('#actions button, #report button')) button.disabled = locked || !view?.remaining;
  $('read').disabled = locked || !view?.readerAvailable;
  $('refresh').disabled = busy; $('disconnect').disabled = busy;
  $('retry').hidden = !pending; $('retry').disabled = busy;
  $('connect-form').hidden = Boolean(token && view); $('workspace').hidden = !token || !view;
}
function render(next) {
  if (view && view.workspaceId !== next.workspaceId) throw Error('WORKSPACE_CHANGED');
  view = next;
  $('position').textContent = `Desk ${view.desk.number} · ${view.remaining} steps available`;
  $('desk').textContent = view.desk.title; $('note').textContent = view.desk.note;
  $('actions').replaceChildren(...view.actions.map(action => {
    const button = document.createElement('button'); button.textContent = action.label;
    button.addEventListener('click', () => run({ type: 'choose', actionId: action.id })); return button;
  }));
  $('records').replaceChildren(...view.records.map(record => {
    const item = document.createElement('div'); item.className = 'record';
    const title = document.createElement('strong'); title.textContent = `${record.reader} · ${record.orderId} · quantity ${record.quantity}`;
    const detail = document.createElement('small'); detail.textContent = `Desk ${record.desk} / ${record.id} / saved at revision ${record.savedAtRevision}`;
    item.append(title, detail); return item;
  }));
  controls();
}
async function guard(action) {
  if (busy) return; busy = true; controls();
  try { await action(); } catch (error) { notice(error.code ?? error.message ?? 'The outcome could not be confirmed.'); }
  finally { busy = false; controls(); }
}
async function submitPending() {
  const result = await api('/api/world/command', pending);
  render(result.view); pending = null; notice(result.replayed ? 'Original operation confirmed.' : view.lastResult?.message ?? 'Saved.');
}
function run(command) { return guard(async () => {
  if (pending) return;
  pending = { requestId: crypto.randomUUID(), expectedRevision: view.revision, command };
  await submitPending(); // Unknown result stays pending; never silently issues a new effect.
}); }
$('connect-form').addEventListener('submit', event => {
  event.preventDefault(); guard(async () => {
    const candidate = $('token').value.trim(); if (!/^[A-Za-z0-9_-]{43}$/u.test(candidate)) throw Error('SESSION_ACCESS_INVALID');
    token = candidate; render(await api('/api/world')); $('token').value = ''; notice('Workspace opened.');
  });
});
$('refresh').addEventListener('click', () => guard(async () => { render(await api('/api/world')); notice(pending ? 'An operation is still pending. Verify it before continuing.' : 'Latest state loaded.'); }));
$('retry').addEventListener('click', () => guard(submitPending));
$('disconnect').addEventListener('click', () => {
  // Retain unresolved request and identity in this page, but never persist a token.
  token = ''; $('token').value = ''; $('readback').textContent = 'No read-back yet.'; controls(); notice('Disconnected.');
});
$('read').addEventListener('click', () => guard(async () => {
  const issued = await api('/api/artifact');
  if (issued.workspaceId !== view.workspaceId) throw Error('WORKSPACE_CHANGED');
  const record = await api('/api/artifact/read', { credential: issued.credential });
  if (record.workspaceId !== view.workspaceId) throw Error('WORKSPACE_CHANGED');
  $('readback').textContent = JSON.stringify(record, null, 2); notice('Record read-back received.');
}));
$('report').addEventListener('submit', event => {
  event.preventDefault(); run({ type: 'report', completed: $('completed').value === 'true',
    confidence: Number($('confidence').value), suspicion: Number($('suspicion').value) });
});
controls();
