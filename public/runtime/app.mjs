import { createRuntimeClient, evidenceState } from '/runtime/client.mjs';

const el = id => document.getElementById(id);
const client = createRuntimeClient({ origin: location.origin });
let connected = false;
let busy = false;
let proposal = null;
let session = 0;
let proposalTimer;
const list = value => Array.isArray(value) ? value : [];
const text = value => value === null || value === undefined ? 'Not reported' : String(value);
function node(tag, content, className) {
  const element = document.createElement(tag);
  if (content !== undefined) element.textContent = text(content);
  if (className) element.className = className;
  return element;
}
function redacted(value) {
  return JSON.stringify(value, (key, item) => /(?:token|password|secret|credential|authorization|cookie|^ticket$)/i.test(key) ? '[redacted]' : item, 2);
}
function badge(value) { const result = node('span', value, 'badge'); result.dataset.state = text(value); return result; }
function lines(id, values) { el(id).replaceChildren(...list(values).map(value => node('li', value))); }
function message(content, error = false) {
  el('message').textContent = content; el('message').dataset.error = String(error); el('message').hidden = false;
  if (error) el('message').focus();
}
function resetProposal() {
  proposal = null; clearTimeout(proposalTimer);
  el('proposal').hidden = true; el('confirm').checked = false; controls();
}
function controls() {
  el('connect').disabled = busy;
  el('disconnect').disabled = !connected && !busy;
  for (const id of ['refresh', 'read-evidence', 'context', 'action', 'reason', 'preview']) el(id).disabled = !connected || busy;
  el('apply').disabled = !connected || busy || !proposal || !el('confirm').checked;
}
function clearPrivate() {
  connected = false; session++; client.disconnect(); el('operator-token').value = '';
  resetProposal(); el('private-state').hidden = true; el('locked-state').hidden = false;
  el('contexts').replaceChildren(); el('worlds').replaceChildren(); el('context').replaceChildren(node('option', 'Connect to load contexts'));
  el('checks').replaceChildren(); el('events').replaceChildren(); el('evidence-details').hidden = true;
  el('evidence-scope').textContent = ''; el('readback-section').hidden = true; el('policy-readback').textContent = '';
  el('proposal-facts').replaceChildren(); lines('proposal-changes', []); lines('proposal-warnings', []);
  lines('runtime-limitations', []); lines('evidence-limitations', []); el('reason').value = '';
  el('connection-state').textContent = 'Disconnected'; el('read-time').textContent = 'No private state loaded';
  el('evidence-state').textContent = 'Not verified'; el('evidence-state').dataset.state = 'INCONCLUSIVE';
  el('evidence-summary').textContent = 'No evidence has been read in this session.'; controls();
}
function failure(error) {
  const code = error?.code ?? 'REQUEST_UNAVAILABLE';
  if (error?.status === 401 || error?.status === 403) {
    clearPrivate(); message(`${code}. Management access was not confirmed. Reconnect with an operator token.`, true);
  } else if (error?.uncertain) {
    resetProposal(); message(`${code}. The result is uncertain. Refresh state and evidence; this page will not repeat the change.`, true);
  } else message(`${code}. No successful result was confirmed. Check the runtime and try reading its state again.`, true);
}
async function run(action) {
  if (busy) return;
  busy = true; controls();
  try { await action(); } catch (error) { failure(error); }
  finally { busy = false; controls(); }
}
function capabilities(value) {
  const items = list(value?.capabilities);
  el('capabilities').replaceChildren(...items.map(item => {
    const row = node('li'); const description = node('div');
    description.append(node('strong', item.id ?? item.family ?? 'Unnamed capability'));
    if (item.reason) description.append(node('small', item.reason));
    row.append(description, badge(item.state ?? 'NOT_REPORTED')); return row;
  }));
  if (!items.length) el('capabilities').append(node('li', 'No capability readiness was reported.'));
}
function status(value) {
  capabilities(value);
  const contexts = list(value.contexts); const previous = el('context').value;
  el('contexts').replaceChildren(...contexts.map(context => {
    const row = node('tr'); const identity = node('td', context.tenantId); identity.append(node('small', context.worldId));
    const disposition = node('td'); disposition.append(badge(context.disposition ?? 'NOT_REPORTED'));
    row.append(node('td', context.contextId), identity, node('td', context.epoch), disposition, node('td', context.state)); return row;
  }));
  if (!contexts.length) { const row = node('tr'); const cell = node('td', 'No contexts were reported.'); cell.colSpan = 5; row.append(cell); el('contexts').append(row); }
  const placeholder = node('option', 'Choose a context'); placeholder.value = '';
  el('context').replaceChildren(placeholder, ...contexts.map(context => { const option = node('option', context.contextId); option.value = text(context.contextId); return option; }));
  if (contexts.some(context => context.contextId === previous)) el('context').value = previous;
  el('worlds').replaceChildren(...list(value.worlds).map(world => {
    const row = node('div', undefined, 'world-row');
    const count = Array.isArray(world.records) ? world.records.length : Number.isInteger(world.records) ? world.records : 'not reported';
    row.append(node('strong', world.worldId), node('span', `Revision ${text(world.revision)} · Records ${count}`)); return row;
  }));
  if (!list(value.worlds).length) el('worlds').append(node('p', 'No worlds were reported.', 'empty'));
  lines('runtime-limitations', value.limitations);
  el('private-state').hidden = false; el('locked-state').hidden = true;
  el('read-time').textContent = `Read at ${new Date().toLocaleTimeString('en-GB')}`;
}
function evidence(value) {
  const state = evidenceState(value);
  el('evidence-state').textContent = { PASS: 'Verified within scope', FAIL: 'Failed checks', INCONCLUSIVE: 'Inconclusive' }[state];
  el('evidence-state').dataset.state = state;
  el('evidence-summary').textContent = {
    PASS: 'The server reports passing checks for the observed scope below. This is not a production or independent-attestation claim.',
    FAIL: 'One or more reported checks failed. Inspect the affected checks and events before changing policy.',
    INCONCLUSIVE: 'Available evidence does not establish a pass. Missing or unfamiliar result states remain inconclusive.',
  }[state];
  el('checks').replaceChildren(...list(value.checks).map(check => {
    const row = node('li'); const description = node('div'); description.append(node('strong', check.id ?? 'Unnamed check'), node('p', check.detail));
    row.append(description, badge(evidenceState(check))); return row;
  }));
  if (!list(value.checks).length) el('checks').append(node('li', 'No individual checks were supplied.'));
  el('evidence-scope').textContent = redacted(value.scope ?? { state: 'NOT_REPORTED' });
  el('events').replaceChildren(...list(value.events).map((event, index) => {
    const details = node('details'); details.append(node('summary', `${index + 1}. ${text(event.kind ?? event.type ?? event.operation ?? 'Observed event')}`), node('pre', redacted(event))); return details;
  }));
  if (!list(value.events).length) el('events').append(node('p', 'No route or execution events were reported.', 'empty'));
  lines('evidence-limitations', value.limitations); el('evidence-details').hidden = false;
}
async function readState() {
  const current = session; const value = await client.status();
  if (current === session) status(value);
}
async function readEvidence() {
  const current = session; const value = await client.evidence();
  if (current === session) evidence(value);
}
el('connect-form').addEventListener('submit', event => {
  event.preventDefault();
  const token = el('operator-token').value; el('operator-token').value = '';
  void run(async () => {
    clearPrivate(); client.setToken(token); await readState();
    connected = true; el('connection-state').textContent = 'Operator connected';
    message('Operator access confirmed. State has been read; no policy was changed.');
  });
});
el('disconnect').addEventListener('click', () => { clearPrivate(); message('Disconnected. Private views and the in-memory credential have been cleared.'); el('operator-token').focus(); });
el('refresh').addEventListener('click', () => void run(async () => { resetProposal(); await readState(); await readEvidence(); message('State and evidence refreshed. Review a new preview before another policy change.'); }));
el('read-evidence').addEventListener('click', () => void run(readEvidence));
for (const id of ['context', 'action', 'reason']) el(id).addEventListener('input', resetProposal);
el('confirm').addEventListener('change', controls);
el('preview-form').addEventListener('submit', event => {
  event.preventDefault(); void run(async () => {
    resetProposal();
    const requested = { contextId: el('context').value, action: el('action').value };
    if (!requested.contextId) { message('Choose a context before previewing a policy change.', true); el('context').focus(); return; }
    if (el('reason').value.trim()) requested.reason = el('reason').value.trim();
    const next = await client.preview(requested);
    const expires = typeof next.expiresAt === 'number' ? next.expiresAt : Date.parse(next.expiresAt);
    if (!next.proposalId || !/^[a-f0-9]{64}$/i.test(next.digest ?? '') || next.contextId !== requested.contextId
      || next.action !== requested.action || !Number.isFinite(expires) || expires <= Date.now()) {
      message('The preview is incomplete, expired, or does not match the requested scope. Apply remains unavailable.', true); return;
    }
    proposal = { proposalId: next.proposalId, digest: next.digest, expiresAt: expires };
    el('proposal-facts').replaceChildren();
    for (const [label, value] of [['Context', next.contextId], ['Action', next.action], ['Proposal', next.proposalId], ['Digest', next.digest], ['Expires', new Date(expires).toLocaleString('en-GB')]]) el('proposal-facts').append(node('dt', label), node('dd', value));
    lines('proposal-changes', next.changes); lines('proposal-warnings', next.warnings);
    el('proposal').hidden = false; el('proposal-title').focus();
    proposalTimer = setTimeout(() => { resetProposal(); message('This proposal has expired. Create a new preview and review it before applying.'); }, Math.min(expires - Date.now(), 2_147_483_647));
    message('Preview ready. No policy change has been applied.');
  });
});
el('apply-form').addEventListener('submit', event => {
  event.preventDefault(); void run(async () => {
    if (!connected || !proposal || !el('confirm').checked) return;
    if (proposal.expiresAt <= Date.now()) { resetProposal(); message('The proposal expired. Preview the current state again.', true); return; }
    const reviewed = { proposalId: proposal.proposalId, digest: proposal.digest, confirmation: 'APPLY' };
    resetProposal();
    const result = await client.apply(reviewed);
    el('policy-readback').textContent = redacted(result); el('readback-section').hidden = false;
    el('readback-title').textContent = result.state === 'APPLIED' ? 'Policy applied — server readback' : 'Policy result — not confirmed';
    await readState(); await readEvidence(); el('readback-title').focus();
    message(result.state === 'APPLIED' ? 'The server reports this proposal applied. Inspect its readback and the separate evidence result below.' : 'The server did not confirm an applied change. Inspect readback and evidence.', result.state !== 'APPLIED');
  });
});
window.addEventListener('pagehide', clearPrivate);
void client.capabilities().then(capabilities).catch(() => { el('capabilities').replaceChildren(node('li', 'Readiness unavailable. Start the reference runtime and refresh this page.')); });
