const $ = id => document.getElementById(id);
const TOKEN_KEY = 'dungeonq-topology-actor';
const PENDING_KEY = 'dungeonq-topology-pending';
const ACK_KEY = 'dungeonq-topology-notice';
const FOREIGN_KEY = 'dungeonq-topology-foreign-pending';
let token; let pending = null; let view = null; let busy = false; let withdrawing = false;
let fresh = false; let acknowledged = false; let storageReady = true; let initialError = '';
let actionButtons = []; let sceneButtons = [];

function node(tag, text, className) {
  const item = document.createElement(tag); item.textContent = text;
  if (className) item.className = className;
  return item;
}
function notice(message, error = false) {
  $('notice').textContent = message; $('notice').className = error ? 'notice error' : 'notice';
}
function store(key, value) {
  try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); }
  catch { storageReady = false; throw new Error('Browser session storage is unavailable. No new operation was sent; enable session storage and reopen this local link.'); }
}
try {
  const supplied = new URLSearchParams(location.hash.slice(1)).get('token');
  if (supplied) {
    // Remove the credential even when session storage is unavailable.
    history.replaceState(null, '', `${location.pathname}${location.search ?? ''}`);
    store(TOKEN_KEY, supplied);
  }
  token = sessionStorage.getItem(TOKEN_KEY);
  const saved = sessionStorage.getItem(PENDING_KEY);
  if (saved) {
    pending = JSON.parse(saved);
    if (!pending || typeof pending.worldId !== 'string' || typeof pending.epoch !== 'string'
      || typeof pending.envelope?.requestId !== 'string' || !Number.isInteger(pending.envelope.expectedRevision)
      || !pending.envelope.command || typeof pending.envelope.command.type !== 'string') {
      throw new Error('The saved request is unreadable. Keep this tab unchanged and inspect the original local session before continuing.');
    }
  }
} catch (error) { storageReady = false; initialError = error.message; }

const closed = () => view?.phase === 'FINISHED' || view?.phase === 'WITHDRAWN';
const sessionId = current => JSON.stringify([current.worldId, current.epoch]);
const sameSession = current => pending?.worldId === current.worldId && pending?.epoch === current.epoch;
const observed = (value, yes, no) => value === true ? yes : value === false ? no : 'Not observed here';
function controls() {
  const locked = busy || withdrawing || !fresh || !storageReady || !view || closed() || Boolean(pending);
  const ordinaryLocked = locked || !acknowledged || view?.remaining <= 0;
  for (const button of [...actionButtons, ...sceneButtons]) button.disabled = ordinaryLocked;
  $('finish').disabled = ordinaryLocked;
  $('withdraw').disabled = busy || withdrawing || !fresh || !storageReady || !view || closed();
  $('refresh').disabled = busy || withdrawing;
  $('consent-submit').disabled = busy || withdrawing || !fresh || !storageReady || Boolean(pending);
  $('recovery').hidden = !pending;
  $('retry').disabled = busy || withdrawing || !fresh || !view || !pending || !sameSession(view) || !storageReady;
  $('pending-detail').textContent = pending
    ? `The saved ${pending.envelope?.command?.type ?? 'operation'} request needs confirmation. New operations are paused; recovery reuses its original request ID and revision.`
    : 'No request is awaiting confirmation.';
}
function acceptView(current) {
  if (!current || current.profile !== 'SYNTHETIC_TOPOLOGY_WORKFLOW'
    || typeof current.worldId !== 'string' || typeof current.epoch !== 'string'
    || !Number.isInteger(current.revision) || !['ACTIVE', 'FINISHED', 'WITHDRAWN'].includes(current.phase)
    || !current.scene || !current.goal || !current.readbacks
    || !Array.isArray(current.scenes) || !Array.isArray(current.objects) || !Array.isArray(current.actions)) {
    throw new Error('The workspace response is incomplete. Its current state is unknown; no new operation is enabled.');
  }
  return current;
}
function quarantineForeign(current) {
  if (!pending || sameSession(current)) return false;
  store(FOREIGN_KEY, JSON.stringify(pending));
  store(PENDING_KEY, null); pending = null;
  return true;
}
function render(current) {
  acceptView(current);
  const foreign = quarantineForeign(current);
  view = current; fresh = true;
  try { acknowledged = sessionStorage.getItem(ACK_KEY) === sessionId(view); }
  catch { storageReady = false; acknowledged = false; }
  $('consent').hidden = acknowledged || closed();
  $('workspace').hidden = !acknowledged && !closed();
  $('research-notice').textContent = view.notice;
  $('title').textContent = view.title;
  $('phase').textContent = { ACTIVE: 'Assignment open', FINISHED: 'Assignment finished', WITHDRAWN: 'Session withdrawn' }[view.phase];
  $('revision').textContent = `${view.revision} recorded events`;
  $('goal-text').textContent = view.goal.text;
  $('goal-state').textContent = observed(view.goal.achieved, 'Present in catalogue', 'Absent from catalogue');
  $('goal-state').className = view.goal.achieved === true ? 'achieved' : view.goal.achieved === false ? 'unmet' : '';
  $('remaining').textContent = Number.isInteger(view.remaining) ? String(view.remaining) : 'Unknown';
  $('identity').textContent = `World: ${view.worldId}\nEpoch: ${view.epoch}`;
  $('scene-id').textContent = view.scene.id;
  $('scene-title').textContent = view.scene.title;
  $('scene-description').textContent = view.scene.description;
  $('scene-memo').textContent = view.scene.memo ?? ''; $('scene-memo').hidden = !view.scene.memo;
  sceneButtons = view.scenes.map(scene => {
    const button = node('button', scene.title); button.type = 'button';
    if (scene.id === view.scene.id) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => queueCommand({ type: 'visit', sceneId: scene.id }));
    return button;
  });
  $('scenes').replaceChildren(...sceneButtons);
  $('objects').replaceChildren(...(view.objects.length ? view.objects.map(object => {
    const row = node('div', '', 'object-row');
    row.append(node('h4', object.label), node('span', object.status, 'object-status'), node('p', `Scope: ${object.scope}`, 'object-scope'));
    return row;
  }) : [node('p', 'No object records are visible at this desk.', 'fine')]));
  actionButtons = view.actions.map(action => {
    const button = node('button', ''); button.type = 'button';
    button.append(node('strong', action.label), node('span', action.description));
    button.addEventListener('click', () => queueCommand({ type: 'act', actionId: action.id }));
    return button;
  });
  $('actions').replaceChildren(...(actionButtons.length ? actionButtons : [node('p', closed() ? 'This session is closed to new operations.' : 'No operations are declared at this desk.', 'fine')]));
  $('roles').replaceChildren(...(view.roles ?? []).map(role => node('p', `${role.label} — ${role.description}`)));
  $('records').replaceChildren(...((view.records ?? []).length ? view.records.map(record => {
    const details = document.createElement('details');
    details.append(node('summary', `${record.kind ?? 'Record'} · ${record.id ?? ''}`), node('pre', JSON.stringify(record, null, 2)));
    return details;
  }) : [node('p', 'No saved record details are visible here.', 'fine')]));
  const readings = [
    ['Visitor catalogue', observed(view.readbacks.visitorCatalogue?.containsTarget, 'Target present', 'Target absent')],
    ['Preview', observed(view.readbacks.preview?.ready, 'Ready', 'Not ready')],
    ['Circulation queue', observed(view.readbacks.circulation?.queued, 'Queued', 'Not queued')],
    ['Circulation archive', observed(view.readbacks.circulation?.archived, 'Filed', 'Not filed')],
    ['Deposit', observed(view.readbacks.deposit?.registered, 'Registered', 'Not registered')],
  ];
  $('readbacks').replaceChildren(...readings.map(([label, value]) => {
    const row = document.createElement('div'); row.append(node('dt', label), node('dd', value)); return row;
  }));
  const entries = view.readbacks.visitorCatalogue?.entries;
  $('catalogue').replaceChildren(...(Array.isArray(entries)
    ? entries.length ? entries.map(entry => node('li', entry)) : [node('li', 'No entries in this read-back.')]
    : [node('li', 'Not observed here.')]));
  $('result-heading').textContent = view.lastResult?.outcome ?? 'No action yet';
  $('result-message').textContent = view.lastResult?.message ?? 'Choose an available operation to begin.';
  $('receipt-details').hidden = !view.receipt;
  $('receipt').textContent = view.receipt ? JSON.stringify(view.receipt, null, 2) : '';
  $('closing').hidden = closed(); $('terminal').hidden = !closed();
  if (closed()) {
    $('terminal-title').textContent = view.phase === 'FINISHED' ? 'Assignment finished' : 'Session withdrawn';
    $('terminal-message').textContent = view.debrief?.message ?? 'The session is closed. Previous records are retained.';
    $('terminal-goal').textContent = `Final objective: ${observed(view.debrief?.actualComplete, 'met', 'not met')}.`;
  }
  controls();
  return foreign;
}
async function api(body) {
  if (!token) throw new Error('Open the participant link printed by the local launcher. No participant credential is available in this tab.');
  const response = await fetch(body ? '/api/topology/command' : '/api/topology', {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000),
  });
  let result;
  try { result = await response.json(); }
  catch { throw Object.assign(new Error('The server returned an unreadable response.'), { status: response.status }); }
  if (!response.ok) throw Object.assign(new Error(typeof result.error === 'string' ? result.error : 'The request was not accepted.'), { status: response.status, code: result.error });
  return result;
}
async function refresh() {
  if (busy || withdrawing) return;
  busy = true; controls();
  try {
    const foreign = render(await api());
    notice(foreign ? 'A saved request belongs to a different world or epoch. It was set aside without sending; check its result in the original session.'
      : pending ? 'State read back. The original request still needs confirmation; refresh alone does not resolve it.'
        : 'Current desk state read back. Refresh does not add a recorded event.', foreign);
  } catch (error) { fresh = false; notice(error.message, true); }
  finally { busy = false; controls(); }
}
async function sendPending() {
  if (busy || !pending || !fresh || !view || !sameSession(view) || !storageReady) return 'unresolved';
  busy = true; controls();
  const original = pending;
  try {
    const result = await api(original.envelope);
    acceptView(result.view);
    if (result.view.worldId !== original.worldId || result.view.epoch !== original.epoch) throw new Error('The command response belongs to another session. The original result remains unknown.');
    store(PENDING_KEY, null); pending = null; render(result.view);
    const outcome = result.view.lastResult?.outcome;
    notice(outcome === 'GOAL_NOT_MET'
      ? 'Completion claim not confirmed. The objective is not met; the assignment remains open for correction or withdrawal.'
      : outcome === 'BLOCKED' ? 'Operation blocked. No workflow record changed. Review the returned desk state before continuing.'
        : result.replayed ? 'Original request confirmed. No duplicate operation was performed.' : 'Operation recorded. The desk now shows the returned state.',
    outcome === 'GOAL_NOT_MET' || outcome === 'BLOCKED');
    return 'accepted';
  } catch (error) {
    if (error.status >= 400 && error.status < 500) {
      store(PENDING_KEY, null); pending = null; fresh = false;
      try { render(await api()); notice(`${error.message} The rejected request was cleared and the current state was read back.`, true); }
      catch { notice(`${error.message} The request was rejected, but fresh state could not be read. Refresh before taking another action.`, true); }
      return fresh ? 'rejected' : 'unresolved';
    }
    notice(`${error.message} The result remains unknown. Recover the original request; do not send a different operation.`, true);
    return 'unresolved';
  } finally { busy = false; controls(); }
}
async function queueCommand(command) {
  if (busy || pending || !fresh || !storageReady || !view || closed()) return;
  if (command.type !== 'withdraw' && (withdrawing || !acknowledged || view.remaining <= 0)) return;
  const saved = { worldId: view.worldId, epoch: view.epoch,
    envelope: { requestId: crypto.randomUUID(), expectedRevision: view.revision, command } };
  try { store(PENDING_KEY, JSON.stringify(saved)); pending = saved; await sendPending(); }
  catch (error) { notice(error.message, true); controls(); }
}
$('refresh').addEventListener('click', refresh);
$('retry').addEventListener('click', () => withdrawing ? undefined : sendPending());
$('consent-form').addEventListener('submit', event => {
  event.preventDefault();
  if (busy || withdrawing || pending || !fresh || !view || !storageReady || !$('consent-check').checked || !$('consent-form').reportValidity()) return;
  try { store(ACK_KEY, sessionId(view)); render(view); notice('Desk opened. The notice acknowledgement is stored only in this browser session.'); }
  catch (error) { notice(error.message, true); }
});
$('finish').addEventListener('click', () => queueCommand({ type: 'finish' }));
$('withdraw').addEventListener('click', async () => {
  if (busy || withdrawing || !fresh || !view || closed() || !storageReady) return;
  withdrawing = true; controls();
  const identity = sessionId(view);
  try {
    if (pending && await sendPending() === 'unresolved') {
      notice('The previous result is still unknown. You may stop and close this page now; confirm the original request and withdrawal once the local service is available.', true);
      return;
    }
    if (fresh && !pending && !closed() && sessionId(view) === identity) await queueCommand({ type: 'withdraw' });
  } finally { withdrawing = false; controls(); }
});
if (initialError) { notice(initialError, true); controls(); }
else await refresh();
