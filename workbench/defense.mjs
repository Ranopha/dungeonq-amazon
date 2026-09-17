const byId = id => document.getElementById(id);
let context = null;
let snapshot = null;
let selectedId = null;
let busy = false;
let needsReadback = false;
let uncertainExecutionId = null;
let emailSnapshot = null;
let emailNeedsReadback = true;
let emailReadbackError = null;
let identityProviders = null;
let identityReadError = false;
const PROVIDER_IDS = ['google', 'github', 'apple'];
const PROVIDER_LABELS = { google: 'Google', github: 'GitHub', apple: 'Apple' };
const CHECKS = [['oldKeyDenied', 'Old key denied'], ['newKeyBusiness', 'New key completes business request'],
  ['oldConsumerDenied', 'Old consumer denied'], ['decoyKeyDenied', 'World-issued decoy key denied by A']];
const ERRORS = {
  AUTH_REQUIRED: 'Your session expired. Sign in again before reviewing or approving a rotation.',
  AUTH_FAILED: 'The password or authenticator code was not accepted. A used code cannot be reused.',
  PERMISSION_DENIED: 'Your role cannot perform this action. The server rejected the request.',
  TENANT_DENIED: 'This reference lab is available only to tenant-lab.',
  CSRF_INVALID: 'The page verification expired. Read current status before trying again.',
  INTENT_INVALID: 'This confirmation is no longer valid. Read current status and confirm your password again.',
  AUTH_RATE_LIMIT: 'Too many authentication attempts. Wait before trying again.',
  AUTH_CAPACITY: 'Authentication is busy. Wait before trying again.',
  SERVICE_UNAVAILABLE: 'The service could not confirm the result. Read current status before any further action.',
  EMAIL_INVALID: 'Enter one valid email address, using standard ASCII characters.',
  EMAIL_NOT_CONFIGURED: 'Email transport is not configured. The installation operator must configure it before verification can begin.',
  EMAIL_CHALLENGE_INVALID: 'This verification request expired or is no longer active. Read current status before requesting another code.',
  EMAIL_CODE_INVALID: 'The email verification code was not accepted. Read current status, then check the code for the current email request.',
  EMAIL_VERIFICATION_LOCKED: 'No verification attempts remain for this request. Read current status before starting a new request.',
  EMAIL_RATE_LIMIT: 'Too many email requests. Wait before starting another verification.',
  IDENTITY_NOT_CONFIGURED: 'This identity provider is not configured for this installation.',
  IDENTITY_NOT_LINKED: 'This provider identity is not linked to an administrator. Sign in with your local account to link it first.',
  IDENTITY_EMAIL_UNVERIFIED: 'The provider did not confirm a verified email. No email binding was created.',
  IDENTITY_STATE_INVALID: 'The provider sign-in could not be verified. Return to this page and begin a new sign-in.',
  OAUTH_NOT_CONFIGURED: 'This identity provider is not configured for this installation.',
  OAUTH_STATE_INVALID: 'This provider sign-in request expired or could not be verified. Begin a new sign-in from this page.',
  OAUTH_CODE_INVALID: 'The provider sign-in response was not accepted. Begin a new sign-in from this page.',
  OAUTH_PROVIDER_UNAVAILABLE: 'The provider did not confirm the sign-in. Use local administrator access or try a new sign-in later.',
  OAUTH_IDENTITY_REJECTED: 'The provider identity could not be verified. No account or email binding was created.',
  OAUTH_VERIFIED_EMAIL_REQUIRED: 'The provider must supply a verified email before it can be linked.'
};
const selected = () => snapshot?.governance?.requests?.find(request => request.requestId === selectedId);
const canManage = () => context?.state?.capabilities?.includes('PUBLISH_GRANT') === true;
const canManageEmail = () => context?.state?.capabilities?.includes('MANAGE_EMAIL') === true;
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
  for (const formId of ['login-form', 'approve-form', 'email-bind-form', 'email-remove-form', 'email-confirm-form', 'identity-link-form']) {
    for (const name of ['password', 'otp', 'code']) {
      const input = byId(formId)?.elements?.[name];
      if (input) input.value = '';
    }
  }
}
function resetEmail() {
  emailSnapshot = null; emailNeedsReadback = true; emailReadbackError = null;
  for (const id of ['email-capture-list', 'email-delivery-list']) byId(id).replaceChildren();
  for (const id of ['email-summary', 'email-mode', 'email-recipient', 'email-alias', 'email-challenge', 'identity-current']) byId(id).textContent = '';
  byId('email-settings').hidden = true;
  byId('email-address').value = '';
  byId('email-footer').textContent = 'Local notification sink only until an email transport is configured. Check the Owner\'s email settings for delivery evidence.';
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
  updateEmailControls();
  updateIdentityControls();
}
async function action(operation, uncertainMessage = 'Result not confirmed. Read current status before repeating an uncertain operation.') {
  if (busy) return;
  busy = true; updateControls();
  try { await operation(); }
  catch (error) {
    message(ERRORS[error.code] ?? `${uncertainMessage}${error.code ? ` (${error.code})` : ''}`, true);
    if (error.code === 'AUTH_REQUIRED') { context = null; snapshot = null; selectedId = null; resetEmail(); setViews(); }
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
function emailDeliveryLabel(delivery) {
  if (delivery?.state === 'ACCEPTED') return delivery.mode === 'LOCAL_EMAIL_CAPTURE'
    ? 'Captured locally — no external email sent' : 'Accepted by SMTP server — inbox delivery unconfirmed';
  return { PENDING: 'Queued; not accepted', SENDING: 'Sending; acceptance not confirmed', RETRY: 'Waiting for scheduled retry; not accepted',
    UNKNOWN: 'Unknown outcome — do not resend; the operator must reconcile it', FAILED: 'Failed; not accepted',
    FENCED: 'Stopped because the email binding changed' }[delivery?.state] ?? 'Acceptance not confirmed';
}
function providerReason(provider) {
  if (!provider) return identityReadError ? 'Availability could not be read. Use local administrator access or read current status.' : 'Not configured for this installation.';
  if (provider.enabled === true) return 'Sign in with an identity already linked to this administrator.';
  return { NOT_CONFIGURED: 'Not configured for this installation.',
    UNSUPPORTED_LOCAL_PROFILE: 'Unavailable in this local profile; Apple requires a configured deployment and developer account.' }[provider.reason]
    ?? 'Unavailable for this installation. Ask the installation operator to review the provider configuration.';
}
function availableProviders() {
  return (identityProviders ?? []).filter(provider => PROVIDER_IDS.includes(provider.id) && provider.enabled === true);
}
function updateIdentityControls() {
  for (const id of PROVIDER_IDS) byId(`identity-login-${id}`).disabled = busy || !!context?.authenticated || !availableProviders().some(provider => provider.id === id);
  const allowed = !busy && canManageEmail() && !emailNeedsReadback && availableProviders().length > 0;
  byId('identity-link').disabled = !allowed;
  byId('identity-link-provider').disabled = !allowed;
  for (const name of ['password', 'otp']) {
    const input = byId('identity-link-form')?.elements?.[name];
    if (input) input.disabled = !allowed;
  }
}
function renderIdentityProviders() {
  for (const id of PROVIDER_IDS) {
    const provider = identityProviders?.find(item => item.id === id);
    byId(`identity-reason-${id}`).textContent = providerReason(provider);
  }
  const available = availableProviders();
  byId('identity-provider-status').textContent = identityReadError
    ? 'Provider availability could not be read. Local administrator access is available below.'
    : available.length ? 'First visit? Use local administrator access once, then link your identity in account settings.'
      : 'Provider sign-in is not configured. Use local administrator access to continue.';
  byId('identity-link-status').textContent = available.length
    ? 'Confirm your current credentials, then finish the provider sign-in in the same browser.'
    : 'No identity provider is available. An installation operator must configure one before linking. Email-code verification remains available when its transport is configured.';
  const select = byId('identity-link-provider');
  const previous = select.value;
  select.replaceChildren();
  for (const provider of available) {
    const option = node('option', PROVIDER_LABELS[provider.id]);
    option.value = provider.id; select.append(option);
  }
  if (!available.length) { const option = node('option', 'No provider available'); option.value = ''; select.append(option); }
  select.value = available.some(provider => provider.id === previous) ? previous : available[0]?.id ?? '';
  updateIdentityControls();
}
async function readIdentityProviders() {
  try {
    const result = await request('/api/identity/providers');
    if (!Array.isArray(result.providers)) throw new Error('IDENTITY_STATUS_INVALID');
    identityProviders = result.providers.filter(provider => PROVIDER_IDS.includes(provider.id)); identityReadError = false;
  } catch {
    identityProviders = null; identityReadError = true;
  }
  renderIdentityProviders();
}
function navigateToIdentity(authorizationUrl) {
  if (typeof authorizationUrl !== 'string') throw new Error('IDENTITY_REDIRECT_INVALID');
  const destination = new URL(authorizationUrl, location.origin);
  if (destination.protocol !== 'https:' || destination.username || destination.password) throw new Error('IDENTITY_REDIRECT_INVALID');
  clearSecrets();
  location.assign(destination.href);
}
const newestEmailRecords = rows => [...(Array.isArray(rows) ? rows : [])].sort((a, b) => (b.createdAt ?? b.acceptedAt ?? 0) - (a.createdAt ?? a.acceptedAt ?? 0));
function latestVerificationDelivery() {
  return newestEmailRecords(emailSnapshot?.deliveries).find(item => item.kind === 'VERIFY_EMAIL');
}
function updateEmailControls() {
  const editable = !busy && !emailNeedsReadback && canManageEmail() && !!emailSnapshot;
  const verificationState = latestVerificationDelivery()?.state;
  const beginAllowed = editable && emailSnapshot.configured === true && !['UNKNOWN', 'SENDING'].includes(verificationState);
  const pending = emailSnapshot?.pendingChallenge;
  const confirmAllowed = editable && emailSnapshot.configured === true && !!pending && pending.attemptsRemaining > 0
    && pending.expiresAt > (context?.state?.serverNow ?? Date.now());
  const removeAllowed = editable && (!!pending || (emailSnapshot.recipient?.state && emailSnapshot.recipient.state !== 'UNBOUND'));
  for (const [formId, buttonId, enabled, fields] of [
    ['email-bind-form', 'email-begin', beginAllowed, ['email', 'password', 'otp']],
    ['email-confirm-form', 'email-confirm', confirmAllowed, ['code']],
    ['email-remove-form', 'email-remove', removeAllowed, ['password', 'otp']]
  ]) {
    byId(buttonId).disabled = !enabled;
    for (const name of fields) {
      const input = byId(formId)?.elements?.[name];
      if (input) input.disabled = !enabled;
    }
  }
}
function renderEmail() {
  byId('email-settings').hidden = !canManageEmail();
  if (!canManageEmail()) return;
  byId('email-readback-error').hidden = !emailReadbackError;
  byId('email-readback-error').textContent = emailReadbackError ?? '';
  if (!emailSnapshot) {
    byId('email-summary').textContent = 'Status unavailable';
    byId('email-mode').textContent = 'Email controls are unavailable until the server status can be read.';
    return;
  }
  const { mode, configured, recipient, pendingChallenge: pending } = emailSnapshot;
  const simulation = mode === 'LOCAL_EMAIL_CAPTURE';
  const linked = Array.isArray(emailSnapshot.linkedIdentities) ? emailSnapshot.linkedIdentities : [];
  const simulatedIdentity = linked.some(identity => identity.mode === 'SIMULATED');
  byId('identity-current').textContent = linked.length
    ? `Linked: ${linked.map(identity => `${PROVIDER_LABELS[identity.provider] ?? 'Provider'}${identity.mode === 'SIMULATED' ? ' (simulated identity)' : ''} · ${formatTime(identity.linkedAt)}`).join('; ')}.`
    : 'No identity provider is linked to this email binding.';
  const stateLabel = { UNBOUND: 'No email bound', PENDING: 'Verification pending', VERIFIED: 'Email verified',
    SIMULATED_VERIFIED: 'Simulated verification complete', REVERIFICATION_REQUIRED: 'Verify again for this transport' }[recipient?.state] ?? 'Not verified';
  byId('email-summary').textContent = `${stateLabel}${recipient?.maskedEmail ? ` · ${recipient.maskedEmail}` : ''}`;
  byId('email-mode').textContent = configured !== true || mode === 'NOT_CONFIGURED'
    ? 'Email is not configured. Ask the installation operator to configure local simulation or SMTP before requesting a code.'
    : simulation ? 'LOCAL_EMAIL_CAPTURE · Simulated mailbox. All messages stay inside this installation; no external email is sent.'
      : 'SMTP · Verification codes and synthetic incident alerts use the configured mail server. Acceptance by that server does not confirm inbox delivery.';
  byId('email-footer').textContent = configured !== true || mode === 'NOT_CONFIGURED'
    ? 'Email is not configured. Local notification sink receipts do not establish email delivery.'
    : simulation ? 'Email simulation only — messages stay in the local capture mailbox. No external email is sent.'
      : 'SMTP acceptance is recorded separately from local sink receipts. Inbox delivery remains unconfirmed.';
  byId('email-recipient').textContent = `${stateLabel}. ${recipient?.email ? `Recipient: ${recipient.email}` : 'No active recipient.'}${recipient?.verifiedAt ? ` Verified ${formatTime(recipient.verifiedAt)}.` : ''}`;
  byId('email-alias').textContent = recipient?.loginAliasEnabled === true
    ? `${recipient.verificationMethod === 'LOCAL_EMAIL_CAPTURE' || simulatedIdentity ? 'The simulated email sign-in alias' : 'The verified email sign-in alias'} is enabled for this account. Your username remains available.`
    : 'Email sign-in is unavailable until verification completes for the current transport. Use your username.';
  const verificationDelivery = latestVerificationDelivery();
  byId('email-challenge').textContent = pending
    ? `Code requested for ${pending.email}. Expires ${formatTime(pending.expiresAt)}; ${pending.attemptsRemaining} attempt(s) remain.${pending.simulation ? ' Read it in the simulated mailbox below.' : ' Check this email inbox.'}${verificationDelivery ? ` ${emailDeliveryLabel(verificationDelivery)}.` : ''}`
    : recipient?.loginAliasEnabled ? 'Verification is complete. Review the bound recipient and alert records below.' : 'Request a code to begin verification.';
  byId('email-confirm-form').hidden = !pending;
  byId('email-remove-section').hidden = !pending && (!recipient?.state || recipient.state === 'UNBOUND');
  byId('email-capture').hidden = !simulation;
  byId('email-capture-list').replaceChildren();
  if (simulation) {
    for (const mail of newestEmailRecords(emailSnapshot.captureMessages).slice(0, 5)) {
      const item = node('li');
      item.append(node('strong', mail.subject), node('p', `To ${mail.to} · Captured ${formatTime(mail.acceptedAt)}`, 'fine'), node('pre', mail.text));
      byId('email-capture-list').append(item);
    }
    if (!byId('email-capture-list').children.length) byId('email-capture-list').append(node('li', 'No messages captured yet.'));
    if (pending) byId('email-capture').open = true;
  }
  if (pending) byId('email-manual').open = true;
  byId('email-delivery-list').replaceChildren();
  for (const delivery of newestEmailRecords(emailSnapshot.deliveries).filter(item => item.kind === 'DECOY_CONTACT').slice(0, 10)) {
    const item = node('li');
    item.append(node('strong', emailDeliveryLabel(delivery)), node('p', `Alert ${textValue(delivery.eventId)} · ${formatTime(delivery.createdAt)}`, 'fine'),
      node('p', `Recipient ${textValue(delivery.maskedRecipient)} · ${delivery.attempts} attempt(s)`, 'fine'));
    if (delivery.providerMessageId) item.append(node('p', `Provider reference: ${delivery.providerMessageId}`, 'fine'));
    byId('email-delivery-list').append(item);
  }
  if (!byId('email-delivery-list').children.length) byId('email-delivery-list').append(node('li', 'No email alert records yet. A verified binding applies to future synthetic contacts.'));
  updateEmailControls();
}
async function readEmailStatus() {
  try {
    const next = await request('/api/email/status');
    if (next.schemaVersion !== 'dungeonq.email-status/v1') throw new Error('EMAIL_STATUS_INVALID');
    const firstRead = emailSnapshot === null;
    emailSnapshot = next; emailNeedsReadback = false; emailReadbackError = null;
    if ((firstRead && next.recipient?.loginAliasEnabled !== true) || next.pendingChallenge) byId('email-settings').open = true;
  } catch (error) {
    emailNeedsReadback = true;
    emailReadbackError = 'Email status could not be read. These controls are paused. Use Read current status before taking another email action.';
    if (error.code === 'AUTH_REQUIRED') throw error;
  }
  renderEmail();
}
async function emailIntent(form, manifest) {
  const { canonicalJson, sha256Hex } = await import('/canonical.mjs');
  const body = { password: form.elements.password.value, purpose: 'MANAGE_EMAIL', manifestDigest: await sha256Hex(canonicalJson(manifest)) };
  if (form.elements.otp.value) body.otp = form.elements.otp.value;
  return request('/api/intents', body);
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
  byId('lab-limitation').textContent = `${snapshot.lab.limitation ?? 'Synthetic loopback TLS resource; no enterprise connection.'} Email transport and acceptance are shown separately in the Owner settings. Runtime isolation: ${snapshot.lab.runtimeIsolation ?? 'NOT_PRODUCTION_ISOLATION'}.`;
  renderIncidents(); renderCampaigns(); renderEmail();
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
  if (!context.authenticated) { snapshot = null; selectedId = null; needsReadback = false; resetEmail(); return; }
  [snapshot] = await Promise.all([request('/api/defense/status'), canManageEmail() ? readEmailStatus() : Promise.resolve(resetEmail())]);
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
  byId('approve-form').elements.acknowledge.checked = false; resetEmail(); setViews(); message('Signed out. Existing approval state remains on the server.');
}));
byId('refresh').addEventListener('click', () => action(async () => { await Promise.all([refresh(), readIdentityProviders()]); message('Current server status read back. No approval or rotation was submitted.'); }));
byId('dismiss-message').addEventListener('click', () => { byId('message').hidden = true; });
for (const provider of PROVIDER_IDS) byId(`identity-login-${provider}`).addEventListener('click', () => {
  if (byId(`identity-login-${provider}`).disabled) return;
  return action(async () => {
    const result = await request('/api/identity/start', { provider });
    navigateToIdentity(result.authorizationUrl);
  }, 'Provider sign-in could not be started. No new administrator account has been created.');
});
byId('identity-link-form').addEventListener('submit', event => {
  event.preventDefault();
  if (byId('identity-link').disabled) return;
  return action(async () => {
    const form = byId('identity-link-form');
    const provider = byId('identity-link-provider').value;
    if (!availableProviders().some(item => item.id === provider)) return;
    const intent = await emailIntent(form, { action: 'LINK_IDENTITY', provider });
    const result = await request('/api/identity/link', { provider, intentToken: intent.intentToken });
    navigateToIdentity(result.authorizationUrl);
  }, 'Provider linking could not be started. Read current status before starting another link request.');
});
byId('email-bind-form').addEventListener('submit', event => {
  event.preventDefault();
  if (byId('email-begin').disabled) return;
  return action(async () => {
    const form = byId('email-bind-form');
    const email = form.elements.email.value.trim().toLowerCase();
    const intent = await emailIntent(form, { action: 'BIND_EMAIL', email });
    emailNeedsReadback = true;
    await request('/api/email/begin', { email, intentToken: intent.intentToken });
    await readEmailStatus();
    if (!emailNeedsReadback) message(emailSnapshot.mode === 'LOCAL_EMAIL_CAPTURE'
      ? 'Verification requested in the simulated mailbox. No external email was sent. Enter its code to complete the local workflow.'
      : 'Verification requested. Check the email delivery state and enter the code from your inbox. SMTP acceptance alone does not confirm delivery.');
  }, 'Email verification request is not confirmed. Read current status before requesting another code.');
});
byId('email-confirm-form').addEventListener('submit', event => {
  event.preventDefault();
  if (byId('email-confirm').disabled) return;
  return action(async () => {
    const code = byId('email-confirm-form').elements.code.value;
    const challengeId = emailSnapshot.pendingChallenge.challengeId;
    emailNeedsReadback = true;
    await request('/api/email/confirm', { challengeId, code });
    await readEmailStatus();
    if (!emailNeedsReadback) message(emailSnapshot.recipient?.state === 'SIMULATED_VERIFIED'
      ? 'Simulated verification saved and read back. The local email alias and future synthetic alerts use this binding; no real mailbox ownership was established.'
      : 'Verified email binding saved and read back. It is now your sign-in alias and recipient for future synthetic incident alerts.');
  }, 'Email confirmation is not established. Read current status before entering another code.');
});
byId('email-remove-form').addEventListener('submit', event => {
  event.preventDefault();
  if (byId('email-remove').disabled) return;
  return action(async () => {
    const intent = await emailIntent(byId('email-remove-form'), { action: 'REMOVE_EMAIL' });
    emailNeedsReadback = true;
    await request('/api/email/remove', { intentToken: intent.intentToken });
    await readEmailStatus();
    if (!emailNeedsReadback) message('Email binding and linked provider sign-ins removed and read back. Use your username and password to sign in. Future alerts will not use the removed binding.');
  }, 'Email removal is not confirmed. Read current status before repeating this action.');
});
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
await action(async () => { await Promise.all([refresh(), readIdentityProviders()]); });
if (location.hash === '#identity-signin-failed') {
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  message('Provider sign-in or linking was not confirmed. First link an identity from your existing Owner account. If an authenticator is enabled, use your local password and authenticator code to sign in. No new Owner was created.', true);
}
