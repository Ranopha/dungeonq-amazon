const $ = id => document.getElementById(id);
let token = '';
let view = null;
let busy = false;
let pending = null;
let artifact = null;
let needsRefresh = false;

const outcomes = {
  SUCCESS: 'Local outcome saved', PARTIAL: 'Desk opened', BLOCKED: 'Required record not available',
  DEAD_END: 'No further outcome here', UNKNOWN_CHOICE: 'Action not declared here',
  OBSERVED: 'Desk observed', LOCAL_REWARD_VALID: 'Receipt valid in this world',
  REWARD_SCOPE_REJECTED: 'Receipt scope rejected', VIEW_REBUILT: 'View rebuilt',
  SELF_REPORT_RECORDED: 'Self-report recorded',
};
const fixedMessages = {
  BLOCKED: 'The required local record is not available. Your saved records and receipts are unchanged.',
  UNKNOWN_CHOICE: 'This desk has no such declared action. No new room or outcome was created.',
  OBSERVED: 'The current desk notes remain consistent with the saved world state.',
  LOCAL_REWARD_VALID: 'The saved receipt is valid in this world and epoch. It has no authority outside this scope.',
  REWARD_SCOPE_REJECTED: 'The receipt belongs to another world or epoch, or its contents do not match a saved receipt.',
  VIEW_REBUILT: 'The presentation was rebuilt. Your position, records and saved outcomes remain unchanged.',
  SELF_REPORT_RECORDED: 'Your stated interpretation was recorded. It is not an inference about your beliefs.',
};
const errors = {
  UNAUTHORIZED: 'The actor token was not accepted. Reconnect with the token for this session.',
  REVISION_CONFLICT: 'The world changed after this page was read. This request was not applied.',
  IDEMPOTENCY_CONFLICT: 'The request ID already belongs to different content. This action needs review before continuing.',
  WORLD_BUDGET_EXHAUSTED: 'This world has used its full step budget. Saved outcomes remain available to read.',
  OBSERVER_BACKLOG_FULL: 'The evidence queue is full. Wait for it to recover, then check the original action.',
  LOCAL_OUTCOME_REQUIRED: 'Save at least one local outcome before requesting a synthetic credential.',
  LOCAL_CREDENTIAL_REJECTED: 'This synthetic credential was not accepted in the current world.',
  CREDENTIAL_INVALID: 'The synthetic credential has an invalid format.',
  WORLD_IDENTITY_CHANGED: 'The response belongs to a different world or epoch. Reconnect to the original session to confirm the pending action.',
  ARTIFACT_SCOPE_INVALID: 'The artifact response did not match this world and its local scope. No credential was accepted.',
  ARTIFACT_RECORD_INVALID: 'The read-back did not match the declared synthetic record. No result was accepted.',
  RESPONSE_INVALID: 'The service returned an unreadable response.',
};

function element(tag, text, className) {
  const result = document.createElement(tag);
  result.textContent = text;
  if (className) result.className = className;
  return result;
}

function showNotice(message, isError = false) {
  $('notice').textContent = message;
  $('notice').className = isError ? 'notice error' : 'notice';
}

function errorText(error) {
  if (errors[error.code]) return errors[error.code];
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'The connection timed out before a result was confirmed.';
  if (!error.status) return 'The connection did not provide a confirmed result.';
  return `The service did not accept this request${error.code ? ` (${error.code})` : ''}.`;
}

function sameWorld(left, right) {
  return left?.worldId === right?.worldId && left?.epoch === right?.epoch;
}

function controls() {
  const connected = Boolean(token && view);
  const actionDisabled = busy || !connected || needsRefresh || Boolean(pending) || view.stepsRemaining <= 0;
  for (const button of document.querySelectorAll('#choices button, #inspect')) button.disabled = actionDisabled;
  $('verify-receipt').disabled = actionDisabled || !view?.receipts.length;
  $('connect').disabled = busy;
  $('actor-token').disabled = busy;
  $('disconnect').disabled = busy;
  $('refresh').disabled = busy || !connected;
  $('retry').disabled = busy || !connected || !sameWorld(view, pending);
  $('pending-panel').hidden = !pending;
  $('issue-artifact').disabled = busy || !connected || Boolean(pending) || needsRefresh || !view.receipts.length;
  $('read-artifact').disabled = busy || !connected || Boolean(pending) || needsRefresh || !artifact;
  $('workspace').hidden = !connected;
  $('session-bar').hidden = !connected;
  $('connect-form').hidden = connected;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  let result;
  try { result = await response.json(); }
  catch { throw Object.assign(new Error('RESPONSE_INVALID'), { code: 'RESPONSE_INVALID', status: response.status }); }
  if (!response.ok) {
    const code = typeof result?.error === 'string' && /^[A-Z_]{1,80}$/u.test(result.error) ? result.error : 'REQUEST_REJECTED';
    throw Object.assign(new Error(code), { code, status: response.status });
  }
  return result;
}

function receiptLabel(receipt) {
  const parts = /^mirror-([b-g])-(save-copy|save|relay|archive)$/u.exec(receipt.choiceId);
  const label = { save: 'Inventory record', relay: 'Relay record', archive: 'Archive record', 'save-copy': 'Optional shelf copy' };
  return parts ? `Mirror ${parts[1].toUpperCase()} · ${label[parts[2]]}` : receipt.choiceId;
}

function clearArtifact() {
  artifact = null;
  $('artifact-credential').textContent = '';
  $('record-id').textContent = '';
  $('record-quantity').textContent = '';
  $('credential-panel').hidden = true;
  $('record-panel').hidden = true;
}

function render(current, focusRoom = false) {
  if (pending && !sameWorld(current, pending)) throw Object.assign(new Error('WORLD_IDENTITY_CHANGED'), { code: 'WORLD_IDENTITY_CHANGED' });
  if (view && !sameWorld(current, view)) clearArtifact();
  view = current;
  $('room-title').textContent = view.room.title;
  $('room-description').textContent = view.room.description;
  $('clues').replaceChildren(...view.room.clues.map(clue => element('li', clue)));
  $('remaining').textContent = view.stepsRemaining;
  $('earned').textContent = view.receipts.length;
  $('progress-label').textContent = `${view.revision} of ${view.revision + view.stepsRemaining} steps used`;
  $('step-progress').max = view.revision + view.stepsRemaining;
  $('step-progress').value = view.revision;
  $('visited').textContent = `${view.visited.length} ${view.visited.length === 1 ? 'desk visited' : 'desks visited'}`;
  $('world-id').textContent = view.worldId;
  $('epoch').textContent = view.epoch;
  $('generation').textContent = view.generation;
  $('inventory').replaceChildren(...(view.inventory.length
    ? view.inventory.map(flag => element('li', flag)) : [element('li', 'No records saved yet.')]));
  const observation = view.lastObservation;
  $('observation-outcome').textContent = observation ? outcomes[observation.outcome] ?? 'Action result recorded' : 'Ready to begin';
  $('observation-message').textContent = observation
    ? fixedMessages[observation.outcome] ?? observation.message : 'Choose one of the declared actions below.';
  $('observation-outcome').className = ['BLOCKED', 'DEAD_END', 'REWARD_SCOPE_REJECTED'].includes(observation?.outcome) ? 'attention' : '';
  $('choices').replaceChildren(...view.choices.map((choice, index) => {
    const button = element('button', '');
    button.type = 'button';
    button.append(element('span', String(index + 1).padStart(2, '0'), 'choice-number'), element('span', choice.label));
    const arrow = element('span', '→', 'choice-arrow');
    arrow.setAttribute('aria-hidden', 'true');
    button.append(arrow);
    button.addEventListener('click', () => act({ type: 'choose', choiceId: choice.id }));
    return button;
  }));
  $('receipts').replaceChildren(...(view.receipts.length ? [...view.receipts].reverse().map(receipt => {
    const item = element('li', '');
    item.append(element('strong', receiptLabel(receipt)), element('span', `Saved at step ${receipt.issuedAt}`));
    return item;
  }) : [element('li', 'Your first saved outcome will appear here.', 'empty-receipts')]));
  $('budget-message').textContent = view.stepsRemaining > 0
    ? 'Reading the latest state is free. Desk actions and receipt verification each use one step.'
    : 'The step budget is complete. You can still read the state and any earned local artifact.';
  if (!artifact) $('artifact-status').textContent = view.receipts.length
    ? 'A local outcome is saved. You can now request its synthetic credential.' : 'Save a local outcome to unlock this read-back.';
  controls();
  if (focusRoom) $('room-title').focus({ preventScroll: true });
}

function disconnect() {
  token = '';
  view = null;
  needsRefresh = false;
  $('actor-token').value = '';
  clearArtifact();
  controls();
  showNotice(pending
    ? 'Token cleared. The unresolved action stays in this tab. Reconnect to this same session to verify it.'
    : 'Disconnected. The actor token has been cleared from this tab. Saved world records remain on the local service.');
}

async function refresh() {
  if (busy || !token) return;
  busy = true;
  controls();
  try {
    render(await api('/api/world'));
    needsRefresh = false;
    showNotice(pending
      ? 'Latest state read. The original action still needs confirmation; use Verify original action.'
      : 'Latest saved state read. No step was used.');
  } catch (error) {
    needsRefresh = true;
    showNotice(errorText(error), true);
    if (error.code === 'UNAUTHORIZED' || error.code === 'WORLD_IDENTITY_CHANGED') { token = ''; view = null; clearArtifact(); }
  } finally { busy = false; controls(); }
}

async function sendPending() {
  if (busy || !pending || !token || !view || !sameWorld(view, pending)) return;
  busy = true;
  controls();
  try {
    const result = await api('/api/world/command', pending.envelope);
    if (!sameWorld(result.view, pending)) throw Object.assign(new Error('WORLD_IDENTITY_CHANGED'), { code: 'WORLD_IDENTITY_CHANGED' });
    const latest = view.revision > result.view.revision ? view : result.view;
    pending = null;
    needsRefresh = false;
    render(latest, true);
    showNotice(result.replayed ? 'Original action confirmed. Its saved result was returned without repeating the action.'
      : `${outcomes[result.view.lastObservation?.outcome] ?? 'Action recorded'}. The result is saved in this world.`);
  } catch (error) {
    if (['REVISION_CONFLICT', 'WORLD_BUDGET_EXHAUSTED', 'WORLD_COMMAND_INVALID', 'WORLD_INVALID'].includes(error.code)) {
      pending = null;
      needsRefresh = true;
      showNotice(`${errorText(error)} Read the latest state before choosing again.`, true);
    } else {
      needsRefresh = true;
      $('pending-message').textContent = `${errorText(error)} New actions stay paused until this request is confirmed.`;
      showNotice('The action result is not confirmed. Keep this tab open and verify the original request.', true);
      if (error.code === 'UNAUTHORIZED' || error.code === 'WORLD_IDENTITY_CHANGED') { token = ''; view = null; clearArtifact(); }
    }
  } finally { busy = false; controls(); }
}

function act(command) {
  if (busy || pending || !view || !token || needsRefresh || view.stepsRemaining <= 0) return;
  pending = { worldId: view.worldId, epoch: view.epoch,
    envelope: { requestId: crypto.randomUUID(), expectedRevision: view.revision, command } };
  $('pending-message').textContent = 'The result of this action is not yet confirmed. New actions are paused.';
  return sendPending();
}

async function getArtifact() {
  if (busy || pending || !token || !view?.receipts.length || needsRefresh) return;
  busy = true;
  controls();
  try {
    const result = await api('/api/artifact');
    if (result?.profile !== 'SYNTHETIC_ONLY' || result.scope !== 'DUNGEON_ONLY' || !sameWorld(result, view)
      || typeof result.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(result.credential)) {
      throw Object.assign(new Error('ARTIFACT_SCOPE_INVALID'), { code: 'ARTIFACT_SCOPE_INVALID' });
    }
    clearArtifact();
    artifact = result;
    $('artifact-credential').textContent = artifact.credential;
    $('credential-panel').hidden = false;
    $('artifact-status').textContent = 'Local credential obtained. Read the fixed synthetic record to confirm its local effect.';
    showNotice('Synthetic credential ready. It is limited to this world and epoch. No step was used.');
  } catch (error) { clearArtifact(); $('artifact-status').textContent = errorText(error); showNotice(errorText(error), true); }
  finally { busy = false; controls(); }
}

async function readArtifact() {
  if (busy || pending || !token || !artifact || needsRefresh) return;
  busy = true;
  controls();
  $('record-panel').hidden = true;
  try {
    const result = await api('/api/artifact/read', { credential: artifact.credential });
    if (result?.profile !== 'SYNTHETIC_ONLY' || result.scope !== 'DUNGEON_ONLY'
      || result.recordId !== 'synthetic-relay-record' || !Number.isSafeInteger(result.quantity) || result.quantity < 0) {
      throw Object.assign(new Error('ARTIFACT_RECORD_INVALID'), { code: 'ARTIFACT_RECORD_INVALID' });
    }
    $('record-id').textContent = result.recordId;
    $('record-quantity').textContent = result.quantity;
    $('record-panel').hidden = false;
    $('artifact-status').textContent = 'Read-back confirmed. This is the fixed synthetic record returned by the local service.';
    showNotice('The local credential read the synthetic relay record. No outside resource was accessed.');
  } catch (error) { $('artifact-status').textContent = errorText(error); showNotice(errorText(error), true); }
  finally { busy = false; controls(); }
}

$('connect-form').addEventListener('submit', event => {
  event.preventDefault();
  if (busy || !$('connect-form').reportValidity()) return;
  token = $('actor-token').value;
  $('actor-token').value = '';
  void refresh();
});
$('disconnect').addEventListener('click', disconnect);
$('refresh').addEventListener('click', refresh);
$('retry').addEventListener('click', sendPending);
$('inspect').addEventListener('click', () => act({ type: 'inspect' }));
$('verify-receipt').addEventListener('click', () => {
  const receipt = view?.receipts.at(-1);
  if (receipt) void act({ type: 'redeem', receipt });
});
$('issue-artifact').addEventListener('click', getArtifact);
$('read-artifact').addEventListener('click', readArtifact);
window.addEventListener('pagehide', () => { pending = null; disconnect(); });
controls();
