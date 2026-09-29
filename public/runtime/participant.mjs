import { createRuntimeClient, RuntimeError } from '/runtime/client.mjs';

const el = id => document.getElementById(id);
const client = createRuntimeClient({ origin: location.origin });
let active = false, connected = false, busy = false, session = 0;
let revision = null, needsRefresh = true, pending = null, heldTicket = null, ticketTimer;
let expectedReadback = null;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : 'REQUEST_UNAVAILABLE';
const format = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function node(tag, value, className) {
  const result = document.createElement(tag);
  if (value !== undefined) result.textContent = String(value);
  if (className) result.className = className;
  return result;
}
function message(value, error = false) {
  el('message').textContent = value; el('message').dataset.error = String(error); el('message').hidden = false;
  if (error) el('message').focus();
}
function controls() {
  const locked = !connected || busy || Boolean(pending);
  el('actor-token').disabled = active || busy;
  el('connect').disabled = active || busy;
  el('disconnect').disabled = !active;
  for (const id of ['refresh', 'record-key', 'read-record']) el(id).disabled = locked;
  for (const id of ['write-key', 'write-value', 'save', 'ticket-key', 'issue-ticket']) el(id).disabled = locked || needsRefresh;
  el('issue-ticket').disabled ||= Boolean(heldTicket);
  el('use-ticket').disabled = locked || needsRefresh || !heldTicket || heldTicket.expiresAt <= Date.now();
  el('retry').disabled = !active || busy || !pending;
  el('uncertain').hidden = !pending;
  el('write-revision').dataset.stale = String(needsRefresh);
  el('write-revision').textContent = needsRefresh ? 'Refresh the snapshot before writing.' : `Write against server revision ${revision}.`;
}
function clearPrivate() {
  session++; client.disconnect(); active = false; connected = false; busy = false;
  revision = null; needsRefresh = true; pending = null; heldTicket = null; expectedReadback = null;
  clearTimeout(ticketTimer);
  el('actor-token').value = ''; el('write-key').value = 'review-findings'; el('write-value').value = '';
  for (const id of ['record-rows', 'record-key', 'ticket-key']) el(id).replaceChildren();
  for (const id of ['snapshot-state', 'record-title', 'record-meta', 'record-value', 'save-summary', 'save-readback',
    'ticket-meta', 'ticket-value', 'request-state', 'request-result', 'retry-description', 'message']) el(id).textContent = '';
  for (const id of ['private-state', 'record-detail', 'save-result', 'ticket-result', 'message']) el(id).hidden = true;
  el('locked-state').hidden = false; el('ticket-state').textContent = 'No ticket held.';
  el('save-state').textContent = 'No save confirmed'; el('save-state').dataset.state = '';
  el('connection-state').textContent = 'Disconnected'; el('revision-state').textContent = 'No server revision loaded';
  controls();
}
function projection(operation, value) {
  const fields = {
    snapshot: ['revision', 'records', 'replayed'],
    read: ['key', 'value', 'recordRevision', 'revision', 'replayed'],
    write: ['key', 'value', 'recordRevision', 'revision', 'replayed'],
    'issue-ticket': ['scope', 'issuedAt', 'expiresAt', 'maxUses', 'revision', 'replayed', 'ticket'],
    'use-ticket': ['key', 'value', 'recordRevision', 'revision', 'usesRemaining', 'replayed'],
  };
  if (!value || !integer(value.revision) || Object.keys(value).some(key => !fields[operation].includes(key))) {
    throw new RuntimeError('PARTICIPANT_VIEW_REQUIRED');
  }
  if (operation === 'snapshot' && (!Array.isArray(value.records) || value.records.some(record => !record
    || !identifier(record.key) || !integer(record.revision) || !Object.hasOwn(record, 'value')
    || Object.keys(record).some(key => !['key', 'value', 'revision'].includes(key))))) throw new RuntimeError('INVALID_PARTICIPANT_RESULT');
  if (['read', 'write', 'use-ticket'].includes(operation) && (!identifier(value.key) || !integer(value.recordRevision)
    || !Object.hasOwn(value, 'value'))) throw new RuntimeError('INVALID_PARTICIPANT_RESULT');
  if (operation === 'issue-ticket' && (typeof value.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.ticket)
    || !Array.isArray(value.scope) || value.scope.length !== 1 || !identifier(value.scope[0])
    || !integer(value.issuedAt) || !integer(value.expiresAt) || value.expiresAt <= value.issuedAt || value.maxUses !== 1)) {
    throw new RuntimeError('INVALID_PARTICIPANT_RESULT');
  }
  if (operation === 'use-ticket' && !integer(value.usesRemaining)) throw new RuntimeError('INVALID_PARTICIPANT_RESULT');
  return value;
}
function renderSnapshot(value) {
  const selected = el('record-key').value, ticketKey = el('ticket-key').value;
  el('record-rows').replaceChildren(...value.records.map(record => {
    const row = node('tr'), preview = format(record.value);
    row.append(node('td', record.key), node('td', preview.length > 180 ? `${preview.slice(0, 180)}…` : preview, 'record-preview'), node('td', record.revision));
    return row;
  }));
  if (!value.records.length) { const row = node('tr'), cell = node('td', 'No records were returned.'); cell.colSpan = 3; row.append(cell); el('record-rows').append(row); }
  for (const [id, previous] of [['record-key', selected], ['ticket-key', ticketKey]]) {
    el(id).replaceChildren(...value.records.map(record => { const option = node('option', record.key); option.value = record.key; return option; }));
    el(id).value = value.records.some(record => record.key === previous) ? previous
      : value.records.some(record => record.key === 'order-41') ? 'order-41' : value.records[0]?.key ?? '';
  }
  needsRefresh = false; connected = true;
  el('connection-state').textContent = 'Participant connected'; el('private-state').hidden = false; el('locked-state').hidden = true;
  el('snapshot-state').textContent = `Snapshot revision ${value.revision} · ${value.records.length} records · read at ${new Date().toLocaleTimeString('en-GB')}. Refresh to see later changes.`;
}
function renderRecord(value) {
  el('record-title').textContent = value.key; el('record-value').textContent = format(value.value);
  el('record-meta').textContent = `Record revision ${value.recordRevision} · world revision ${value.revision}`;
  el('record-detail').hidden = false;
  if (expectedReadback && value.key === expectedReadback.key) {
    const matches = value.value === expectedReadback.value && value.recordRevision === expectedReadback.recordRevision;
    el('save-state').textContent = matches ? 'Saved value read back' : 'Saved record has changed';
    el('save-state').dataset.state = matches ? 'verified' : 'changed';
    el('save-summary').textContent = matches
      ? `A separate server read returned the saved value at record revision ${value.recordRevision}. Shipping is not approved by this note.`
      : 'The write was acknowledged, but a later server read differs. Inspect the current value before writing again.';
    el('save-readback').textContent = format(value.value); expectedReadback = null;
  }
}
function showTicket(value) {
  clearTimeout(ticketTimer);
  heldTicket = { wire: value.ticket, key: value.scope[0], expiresAt: value.expiresAt };
  el('ticket-state').textContent = `Ticket held for ${heldTicket.key} · one use · expires ${new Date(value.expiresAt).toLocaleTimeString('en-GB')}. Its value is not displayed.`;
  ticketTimer = setTimeout(() => {
    heldTicket = null; el('ticket-state').textContent = 'The held ticket expired. Request a new ticket to continue.'; controls();
  }, Math.min(Math.max(value.expiresAt - Date.now(), 0), 2_147_483_647));
}
function describeRequest(input, value) {
  // Only server fields safe for display; the opaque ticket is never rendered.
  const visible = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'ticket'));
  el('request-state').textContent = `${input.operation} · ${input.requestId} · ${value.replayed === true ? 'saved result replayed' : 'server response received'}`;
  el('request-result').textContent = JSON.stringify(visible, null, 2);
}
function inputFor(operation, args = {}) {
  return JSON.parse(JSON.stringify({ requestId: `ui-${crypto.randomUUID()}`, operation, args }));
}
async function execute(input, atSession) {
  let value;
  try { value = await client.operate(input); }
  catch (error) {
    if (session !== atSession) return;
    if (error?.uncertain) {
      pending = input;
      el('retry-description').textContent = `${input.operation} · ${input.requestId}. No successful outcome has been confirmed.`;
    }
    throw error;
  }
  if (session !== atSession) return;
  try {
    projection(input.operation, value);
    if (['read', 'write', 'use-ticket'].includes(input.operation) && value.key !== input.args.key) throw new RuntimeError('INVALID_PARTICIPANT_RESULT');
    if (input.operation === 'issue-ticket' && value.scope[0] !== input.args.scope[0]) throw new RuntimeError('INVALID_PARTICIPANT_RESULT');
  }
  catch (error) { clearPrivate(); throw error; }
  pending = null; revision = value.revision;
  el('revision-state').textContent = `Last server revision ${revision}`;
  describeRequest(input, value);
  if (input.operation === 'snapshot') {
    renderSnapshot(value); message('Server snapshot loaded. Review the order and policy before saving your findings.');
  } else if (input.operation === 'read') {
    renderRecord(value); message(`Read ${value.key} from the server at revision ${value.revision}.`);
  } else if (input.operation === 'write') {
    expectedReadback = { key: value.key, value: input.args.value, recordRevision: value.recordRevision };
    el('save-result').hidden = false; el('save-state').textContent = 'Write acknowledged; readback pending';
    el('save-state').dataset.state = ''; el('save-summary').textContent = `The server acknowledged ${value.key} at revision ${value.revision}. A separate read must confirm its value.`;
    el('save-readback').textContent = '';
    await execute(inputFor('read', { key: value.key }), atSession);
  } else if (input.operation === 'issue-ticket') {
    showTicket(value); message('The server issued a one-use ticket. Use it to read its scoped record.');
  } else {
    heldTicket = null; clearTimeout(ticketTimer);
    el('ticket-state').textContent = `Ticket consumed · ${value.usesRemaining} uses remaining reported by the server.`;
    el('ticket-value').textContent = format(value.value);
    el('ticket-meta').textContent = `${value.key} · record revision ${value.recordRevision} · world revision ${value.revision}`;
    el('ticket-result').hidden = false;
    message('Ticket read returned. Refresh the snapshot to see any later server changes.');
  }
}
function failure(error) {
  const code = safeCode(error?.code);
  if (error?.status === 401 || error?.status === 403 || ['UNAUTHORIZED', 'AUTH_REQUIRED', 'PERMISSION_DENIED', 'CONTEXT_FENCED', 'CONTEXT_UNKNOWN'].includes(code)) {
    clearPrivate(); message(`${code}. Access is no longer available. Private records and the held ticket were cleared.`, true);
  } else if (error?.uncertain) {
    message(`${code}. The outcome is uncertain. Use the explicit exact retry or disconnect; no request was sent again automatically.`, true);
  } else {
    pending = null;
    if (code === 'REVISION_CONFLICT') needsRefresh = true;
    if (code.startsWith('TICKET_')) { heldTicket = null; clearTimeout(ticketTimer); el('ticket-state').textContent = 'Ticket rejected. Refresh records before requesting another ticket.'; needsRefresh = true; }
    message(code === 'REVISION_CONFLICT' ? 'REVISION_CONFLICT. Another server change made this revision stale. Refresh the snapshot and review your note before saving again.'
      : code === 'PARTICIPANT_VIEW_REQUIRED' ? 'PARTICIPANT_VIEW_REQUIRED. Use a runtime started with the participant-v1 view. No private response was displayed.'
        : `${code}. No successful result was confirmed. Review the input or refresh the server snapshot.`, true);
  }
}
async function run(action) {
  if (busy) return;
  const current = session; busy = true; controls();
  try { await action(current); } catch (error) { if (current === session || !active) failure(error); }
  finally { if (current === session) { busy = false; controls(); } }
}
function operate(operation, args) {
  if (!connected || pending || busy || (needsRefresh && ['write', 'issue-ticket', 'use-ticket'].includes(operation))) return;
  return run(current => execute(inputFor(operation, args), current));
}
el('connect-form').addEventListener('submit', event => {
  event.preventDefault(); if (active || busy) return;
  const token = el('actor-token').value; clearPrivate();
  try { client.setToken(token); } catch (error) { failure(error); return; }
  active = true; el('connection-state').textContent = 'Connecting';
  return run(current => execute(inputFor('snapshot'), current));
});
el('disconnect').addEventListener('click', () => { clearPrivate(); message('Disconnected. Private records, findings, ticket and retained retry were cleared.'); el('actor-token').focus(); });
el('refresh').addEventListener('click', () => operate('snapshot'));
el('read-form').addEventListener('submit', event => { event.preventDefault(); if (identifier(el('record-key').value)) return operate('read', { key: el('record-key').value }); });
el('write-form').addEventListener('submit', event => {
  event.preventDefault(); const key = el('write-key').value, value = el('write-value').value;
  if (!identifier(key) || !value.trim()) { message('Enter a valid record key and a plain-text review note.', true); return; }
  return operate('write', { key, value, expectedRevision: revision });
});
el('issue-form').addEventListener('submit', event => {
  event.preventDefault(); const key = el('ticket-key').value;
  if (!heldTicket && identifier(key)) return operate('issue-ticket', { scope: [key], ttlMs: 300000, maxUses: 1 });
});
el('use-ticket').addEventListener('click', () => {
  if (heldTicket && heldTicket.expiresAt > Date.now()) return operate('use-ticket', { ticket: heldTicket.wire, key: heldTicket.key });
});
el('retry').addEventListener('click', () => {
  if (!active || !pending || busy) return;
  const original = pending; return run(current => execute(original, current));
});
window.addEventListener('pagehide', clearPrivate);
controls();
