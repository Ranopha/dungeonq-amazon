const byId = id => document.getElementById(id);
let context = null;
let snapshot = null;
let selectedId = null;
let busy = false;
let needsReadback = false;
let uncertainExecutionId = null;
const CHECKS = [['oldKeyDenied', 'Old key denied'], ['newKeyBusiness', 'New key completes business request'],
  ['oldConsumerDenied', 'Old consumer denied'], ['decoyKeyDenied', 'World-issued decoy key denied by A']];
const ERRORS = {
  AUTH_REQUIRED: 'Your session expired. Sign in again before reviewing or approving a rotation.',
  AUTH_FAILED: 'The password or authenticator code was not accepted. A used code cannot be reused.',
  PERMISSION_DENIED: 'Your role cannot perform this action. The server rejected the request.',
  TENANT_DENIED: 'This reference lab is available only to tenant-lab.',
  CSRF_INVALID: 'The page verification expired. Read current status before trying again.',
  INTENT_INVALID: 'This approval intent is no longer valid. Read the manifest again and confirm your password.',
  AUTH_RATE_LIMIT: 'Too many authentication attempts. Wait before trying again.',
  AUTH_CAPACITY: 'Authentication is busy. Wait before trying again.',
  SERVICE_UNAVAILABLE: 'The service could not confirm the result. Read current status before any further action.'
};
const selected = () => snapshot?.governance?.requests?.find(request => request.requestId === selectedId);
const canManage = () => context?.state?.capabilities?.includes('PUBLISH_GRANT') === true;
const formatTime = value => Number.isFinite(value) ? new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' }) : 'Not supplied';
const textValue = value => value === undefined || value === null ? 'Not supplied' : typeof value === 'object' ? JSON.stringify(value) : String(value);
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function message(text, error = false) {
  byId('message-text').textContent = text;
  byId('message').className = error ? 'message error' : 'message';
  byId('message').setAttribute('role', error ? 'alert' : 'status');
  byId('message').hidden = false;
}
async function request(path, body) {
  const options = { credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    const fresh = await request('/api/context');
    options.method = 'POST';
    options.headers = { 'Content-Type': 'application/json', 'X-DQ-CSRF': fresh.csrfToken };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error ?? 'SERVICE_UNAVAILABLE'); error.code = result.error; throw error; }
  return result;
}
function clearSecrets() {
  for (const formId of ['login-form', 'approve-form']) {
    byId(formId).elements.password.value = '';
    byId(formId).elements.otp.value = '';
  }
}
function setViews() {
  byId('login-view').hidden = !!context?.authenticated;
  byId('workspace').hidden = !context?.authenticated;
}
function updateControls() {
  document.querySelectorAll('button').forEach(button => { button.disabled = busy; });
  const current = selected();
  const pending = current?.state === 'AWAITING_HUMAN';
  const expiresAt = current?.manifest?.expiresAt;
  const unexpired = Number.isFinite(expiresAt) && expiresAt > (context?.state?.serverNow ?? Date.now());
  const approvalAllowed = !busy && !needsReadback && canManage() && pending && unexpired;
  byId('approve').disabled = !approvalAllowed;
  for (const name of ['password', 'otp', 'acknowledge']) byId('approve-form').elements[name].disabled = !approvalAllowed;
  byId('execute').disabled = busy || needsReadback || !canManage() || current?.state !== 'APPROVED' || current?.authorizationActive !== true || uncertainExecutionId === current?.requestId;
  const reconcileAvailable = !!current && (['UNKNOWN', 'CLAIMED'].includes(current.state) || (current.state === 'EXPIRED' && !!current.claimedAt) || uncertainExecutionId === current.requestId);
  byId('reconcile-section').hidden = !canManage() || !reconcileAvailable;
  byId('reconcile').disabled = busy || !canManage() || !reconcileAvailable;
  const refreshAvailable = current?.state === 'EXPIRED' && !current.claimedAt;
  byId('expired-proposal').hidden = !canManage() || !refreshAvailable;
  byId('refresh-proposal').disabled = busy || needsReadback || !canManage() || !refreshAvailable;
}
async function action(operation) {
  if (busy) return;
  busy = true; updateControls();
  try { await operation(); }
  catch (error) {
    message(ERRORS[error.code] ?? `Result not confirmed${error.code ? ` (${error.code})` : ''}. Read current status; do not repeat an uncertain rotation.`, true);
    if (error.code === 'AUTH_REQUIRED') { context = null; snapshot = null; selectedId = null; setViews(); }
  } finally { busy = false; clearSecrets(); updateControls(); }
}
function renderIncidents() {
  const target = byId('incident-list'); target.replaceChildren();
  for (const incident of snapshot.governance.incidents ?? []) {
    const article = node('article', undefined, 'incident');
    article.append(node('h3', incident.incidentId), node('p', `Resource ${incident.assetId} · World ${incident.worldId}`),
      node('p', `Observed ${formatTime(incident.observedAt)}`), node('p', 'Actor classification: undetermined.'),
      node('p', `Notification event: ${textValue(incident.notification?.eventId)}`),
      node('p', `Delivery: ${deliveryLabel(incident.notification?.state)}`));
    target.append(article);
  }
  if (!target.children.length) target.append(node('p', 'No observed incident yet. Nothing has been queued for approval.', 'empty'));
  const notices = snapshot.notifications;
  byId('notification-access').textContent = notices === null
    ? 'Detailed delivery receipts are visible to the Owner only. Your role can still review the lab and rotation state.'
    : 'Durable local sink receipts only. Queued is not delivered; delivered does not mean an email was sent.';
  byId('notification-list').replaceChildren();
  if (Array.isArray(notices)) {
    for (const notice of notices) {
      const item = node('li', `${notice.id} — ${deliveryLabel(notice.status)} · ${notice.attempts} delivery attempt(s)`);
      if (notice.receipt) item.append(node('code', textValue(notice.receipt)));
      byId('notification-list').append(item);
    }
    if (!notices.length) byId('notification-list').append(node('li', 'No notification receipts yet.'));
  }
}
function deliveryLabel(state) {
  return { DELIVERED: 'Received by local sink (not email)', PENDING: 'Queued; not delivered', SENDING: 'Delivery in progress',
    RETRY: 'Waiting for retry; not delivered', FAILED: 'Delivery failed', UNKNOWN: 'Unknown; reconcile before retrying' }[state] ?? 'Not confirmed';
}
function renderCampaigns() {
  byId('campaign-list').replaceChildren();
  for (const campaign of snapshot.lab.campaigns ?? []) {
    const article = node('article', undefined, 'campaign');
    article.append(node('strong', campaign.worldId), node('p', `Incident ${campaign.incidentId}`),
      node('p', `Seed ${textValue(campaign.seed)} · ${campaign.steps ?? 0} step(s) · ${campaign.localSuccesses ?? 0} local success(es)`),
      node('p', `Phase ${textValue(campaign.phase)} · Current map ${textValue(campaign.currentMap)}`));
    byId('campaign-list').append(article);
  }
  if (!byId('campaign-list').children.length) byId('campaign-list').append(node('p', 'No campaign has started.', 'empty'));
}
function renderSelection() {
  const current = selected();
  byId('no-request').hidden = !!current;
  byId('request-detail').hidden = !current;
  byId('approve-form').elements.acknowledge.checked = false;
  clearSecrets();
  if (!current) { updateControls(); return; }
  byId('selected-title').textContent = `Resource ${current.assetId}`;
  byId('rotation-state').textContent = current.state;
  byId('rotation-state').className = `badge${current.state === 'UNKNOWN' ? ' warning' : ''}`;
  byId('rotation-context').textContent = `Request ${current.requestId} · Incident ${current.incidentId}`;
  const manifest = current.manifest ?? {};
  const facts = [ ['Protected resource', current.assetId], ['Allowed effect', manifest.schemaVersion === 'dungeonq.reference-rotation/v1' ? 'Synthetic credential rotation' : 'Unknown manifest type'],
    ['Scope / domain', current.domain ?? manifest.domain], ['Expires', formatTime(manifest.expiresAt)],
    ['Expected generation', Number.isSafeInteger(manifest.expectedGeneration) ? `${manifest.expectedGeneration} → ${manifest.expectedGeneration + 1}` : 'Not supplied'], ['Authorized worker', current.workerId] ];
  byId('manifest-facts').replaceChildren();
  for (const [label, value] of facts) { const row = node('div'); row.append(node('dt', label), node('dd', textValue(value))); byId('manifest-facts').append(row); }
  byId('manifest-digest').textContent = current.manifestDigest;
  byId('manifest-json').textContent = JSON.stringify(manifest, null, 2);
  byId('permission-note').textContent = canManage() ? 'Owner approval is required. The actor and its tools cannot approve this request.' : 'Read-only role: you can review this request, but only the Owner can approve and execute it.';
  byId('approve-form').hidden = !canManage() || current.state !== 'AWAITING_HUMAN';
  byId('approval-note').textContent = current.approvedAt
    ? `Approved ${formatTime(current.approvedAt)} by ${textValue(current.approvedBy)}. Authorization ${current.authorizationActive ? 'active' : 'not active'}.`
    : 'Not approved. A password confirmation is required for this exact digest.';
  byId('execution-note').textContent = current.state === 'UNKNOWN'
    ? 'UNKNOWN: the outcome is not established. Do not execute again. Read current status and reconcile the existing operation.'
    : current.state === 'COMPLETED' ? 'Execution is complete. Each readback below must independently pass.'
      : current.state === 'APPROVED' ? 'Approval is saved. Execution requires the separate button above.'
        : 'Execution is unavailable until the server confirms an active, approved rotation grant.';
  const verified = current.state === 'COMPLETED' && CHECKS.every(([key]) => current.checks?.[key] === true);
  byId('verification').className = verified ? 'verification good' : 'verification';
  byId('verification-title').textContent = verified ? 'Verified — all four checks passed' : current.state === 'UNKNOWN' ? 'Unknown — not verified' : 'Not verified';
  byId('check-list').replaceChildren();
  for (const [key, label] of CHECKS) {
    const value = current.checks?.[key]; const row = node('li');
    row.append(node('span', label), node('span', value === true ? 'PASS' : value === false ? 'FAILED' : 'NOT VERIFIED',
      `check-status${value === true ? ' good' : value === false ? ' failed' : ''}`));
    byId('check-list').append(row);
  }
  byId('receipt-detail').hidden = !current.receipt;
  byId('receipt-json').textContent = current.receipt ? JSON.stringify(current.receipt, null, 2) : '';
  updateControls();
}
function render() {
  byId('identity').textContent = `${context.state.tenantId} / ${context.state.role === 'TENANT_SUPER_ADMIN' ? 'Owner' : context.state.role}`;
  byId('resource-summary').textContent = `Protected resource A: ${textValue(snapshot.lab.resource?.assetId)} · generation ${textValue(snapshot.lab.resource?.generation)}`;
  byId('lab-limitation').textContent = `${snapshot.lab.limitation ?? 'Synthetic loopback TLS resource; no enterprise connection.'} Local sink only. Runtime isolation: ${snapshot.lab.runtimeIsolation ?? 'NOT_PRODUCTION_ISOLATION'}.`;
  renderIncidents(); renderCampaigns();
  const requests = snapshot.governance.requests ?? [];
  if (!requests.some(item => item.requestId === selectedId)) selectedId = requests[0]?.requestId ?? null;
  byId('request-count').textContent = `${requests.length} request${requests.length === 1 ? '' : 's'}`;
  byId('request-list').replaceChildren();
  for (const item of requests) {
    const button = node('button', `${item.assetId} · ${item.state}`, 'request-choice'); button.type = 'button';
    button.setAttribute('aria-pressed', String(item.requestId === selectedId)); button.setAttribute('aria-label', `Review request ${item.requestId}`);
    button.addEventListener('click', () => { selectedId = item.requestId; render(); byId('selected-title').focus(); });
    byId('request-list').append(button);
  }
  renderSelection();
}
async function refresh() {
  needsReadback = true;
  const nextContext = await request('/api/context');
  context = nextContext; setViews();
  if (!context.authenticated) { snapshot = null; selectedId = null; needsReadback = false; return; }
  snapshot = await request('/api/defense/status');
  if (snapshot.governance.requests?.some(item => item.requestId === uncertainExecutionId && ['COMPLETED', 'FAILED', 'FENCED'].includes(item.state))) uncertainExecutionId = null;
  needsReadback = false; render();
}
byId('login-form').addEventListener('submit', event => {
  event.preventDefault();
  return action(async () => {
    const form = byId('login-form');
    const body = { tenantId: form.elements.tenantId.value, username: form.elements.username.value, password: form.elements.password.value };
    if (form.elements.otp.value) body.otp = form.elements.otp.value;
    await request('/api/login', body); await refresh(); message('Signed in. Review the incident and the exact rotation scope.');
  });
});
byId('logout').addEventListener('click', () => action(async () => {
  await request('/api/logout', {}); context = null; snapshot = null; selectedId = null; needsReadback = false; uncertainExecutionId = null;
  byId('approve-form').elements.acknowledge.checked = false; setViews(); message('Signed out. Existing approval state remains on the server.');
}));
byId('refresh').addEventListener('click', () => action(async () => { await refresh(); message('Current server status read back. No approval or rotation was submitted.'); }));
byId('dismiss-message').addEventListener('click', () => { byId('message').hidden = true; });
byId('approve-form').addEventListener('submit', event => {
  event.preventDefault();
  if (byId('approve').disabled || !byId('approve-form').elements.acknowledge.checked) return;
  return action(async () => {
    const current = selected(); const form = byId('approve-form');
    const body = { password: form.elements.password.value, purpose: 'APPROVE_ROTATION', manifestDigest: current.manifestDigest };
    if (form.elements.otp.value) body.otp = form.elements.otp.value;
    const intent = await request('/api/intents', body);
    needsReadback = true;
    await request('/api/defense/approve', { requestId: current.requestId, manifestDigest: current.manifestDigest, intentToken: intent.intentToken });
    await refresh(); message('Approval saved and read back. Rotation has not run; use Execute approved rotation when ready.');
  });
});
byId('execute').addEventListener('click', () => {
  if (byId('execute').disabled) return;
  return action(async () => {
    const requestId = selected().requestId;
    needsReadback = true; uncertainExecutionId = requestId;
    await request('/api/defense/apply', { requestId });
    await refresh();
    const current = selected();
    const verified = current?.state === 'COMPLETED' && CHECKS.every(([key]) => current.checks?.[key] === true);
    message(verified ? 'Rotation completed and all four readback checks passed.' : 'The current outcome has been read back. Verification is incomplete; inspect the state and checks before taking further action.', !verified);
  });
});
byId('reconcile').addEventListener('click', () => {
  if (byId('reconcile').disabled) return;
  return action(async () => {
    needsReadback = true;
    await request('/api/defense/reconcile', { requestId: selected().requestId });
    await refresh();
    message('Existing operation reconciled and read back. No new rotation was submitted. Inspect all four checks.');
  });
});
byId('refresh-proposal').addEventListener('click', () => {
  if (byId('refresh-proposal').disabled) return;
  return action(async () => {
    needsReadback = true;
    const renewed = await request('/api/defense/refresh', { requestId: selected().requestId });
    selectedId = renewed.requestId;
    await refresh();
    message('Proposal refreshed and read back. Review the new expiry and digest, then confirm a new approval.');
    byId('selected-title').focus();
  });
});
await action(refresh);
