import { createRuntimeClient, evidenceState } from '/runtime/client.mjs';

const el = id => document.getElementById(id);
const client = createRuntimeClient({ origin: location.origin });
let connected = false;
let busy = false;
let proposal = null;
let session = 0;
let proposalTimer;
let observedStatus = null;
let observedEvidence = null;
let pitchEnabled = false;
let pitchTimer;
let pitchGeneration = 0;
let pitchViewKey = null;
let incidentControls = [];
const DISPLAY_LIMIT = 80;
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
  for (const id of ['refresh', 'read-evidence']) el(id).disabled = !connected || busy;
  for (const id of ['context', 'action', 'reason', 'preview', 'inspect-context']) el(id).disabled = !connected || busy || !observedStatus;
  el('apply').disabled = !connected || busy || !proposal || !el('confirm').checked;
  for (const { element, available } of incidentControls) element.disabled = !connected || busy || !available;
}
function stopPitchPolling() { clearTimeout(pitchTimer); pitchTimer = undefined; pitchGeneration++; }
function clearPitch() {
  stopPitchPolling(); pitchEnabled = false; pitchViewKey = null; incidentControls = [];
  el('pitching').hidden = true; el('pitch-nav').hidden = true;
  el('pitch-incidents').replaceChildren(); el('pitch-summary').textContent = ''; el('pitch-read-time').textContent = '';
  el('grant-mutation-option').hidden = false; el('grant-mutation-option').disabled = false;
}
function renderPitch(value) {
  if (value?.schemaVersion !== 'dungeonq.pitch-control/v1' || !Array.isArray(value.incidents) || !Array.isArray(value.outbox)) {
    throw { code: 'PITCH_STATUS_INVALID' };
  }
  el('pitching').hidden = false; el('pitch-nav').hidden = false;
  el('pitch-read-time').textContent = `讀取時間 ${new Date().toLocaleTimeString('zh-TW')}`;
  const viewKey = JSON.stringify([value.incidents, value.outbox]);
  if (viewKey === pitchViewKey) return;
  pitchViewKey = viewKey;
  const focused = document.activeElement?.dataset?.pitchControl;
  const selections = new Map(incidentControls.filter(item => item.element.tagName.toLowerCase() === 'select')
    .map(item => [item.element.dataset.pitchControl, item.element.value]));
  const knownLabel = (labels, key, fallback) => Object.hasOwn(labels, key) ? labels[key] : fallback;
  const deliveries = new Map(value.outbox.map(row => [row.incidentId, row]));
  const pending = value.incidents.filter(row => !row.resolution).length;
  el('pitch-summary').textContent = `${value.incidents.length} 件告警，${pending} 件未結案。`;
  incidentControls = [];
  const control = (element, available, identity) => {
    element.dataset.pitchControl = identity; incidentControls.push({ element, available }); return element;
  };
  el('pitch-incidents').replaceChildren(...value.incidents.slice().reverse().map(incident => {
    const row = node('li', undefined, 'pitch-incident');
    row.append(node('h3', `Context ${text(incident.contextId)}`));
    row.append(node('p', `世界 ${text(incident.worldId)} · Epoch ${text(incident.epoch)} · ${text(incident.incidentId)}`, 'request-identity'));
    const phase = { ADMITTED: 'ADMITTED · 已保留入場紀錄', ENTERED: 'ENTERED · 已記錄進入' };
    row.append(badge(knownLabel(phase, incident.phase, '入場狀態未知')));
    const delivery = deliveries.get(incident.incidentId);
    const deliveryLabels = { PENDING: 'PENDING · 等待傳送', IN_FLIGHT: 'IN_FLIGHT · 傳送中',
      ACCEPTED: 'ACCEPTED · 傳送服務已接受（非收件匣送達或已讀）', UNKNOWN: 'UNKNOWN · 傳送結果未知，待對帳',
      EXHAUSTED: 'EXHAUSTED · 傳送嘗試已用完' };
    const facts = node('dl', undefined, 'facts');
    for (const [label, value] of [
      ['本機收件匣', incident.localInbox === 'AVAILABLE' ? 'AVAILABLE · 本機已保存，可供 Owner 讀取' : '狀態未確認'],
      ['外部傳送', knownLabel(deliveryLabels, delivery?.status, '外部傳送狀態未確認')],
      ['傳送次數', delivery?.attempts ?? '未提供'],
      ['已保留入場', eventTime(incident.admittedAt)],
      ['已記錄進入', incident.enteredAt == null ? '尚未確認' : eventTime(incident.enteredAt)],
      ['人員確認', incident.acknowledgement ? `${text(incident.acknowledgement.operatorId)} · ${eventTime(incident.acknowledgement.at)}` : '尚未確認'],
      ['結案', incident.resolution ? `${knownLabel({ REVIEWED: '已檢視', FALSE_POSITIVE: '已判定誤報', FENCED: '已封鎖' }, incident.resolution.resolution, '未知結果')} · ${eventTime(incident.resolution.at)}` : '尚未結案'],
    ]) facts.append(node('dt', label), node('dd', value));
    row.append(facts);
    const actions = node('div', undefined, 'pitch-actions');
    const ack = control(node('button', '確認收到'), !incident.acknowledgement && !incident.resolution, `ack:${incident.incidentId}`);
    ack.type = 'button'; ack.ariaLabel = `確認收到 ${text(incident.contextId)} 的告警`;
    ack.addEventListener('click', () => void actOnIncident(incident.incidentId));
    const select = control(node('select'), Boolean(incident.acknowledgement) && !incident.resolution, `resolution:${incident.incidentId}`);
    select.id = `resolution-${incident.incidentId}`;
    const placeholder = node('option', '選擇結案原因'); placeholder.value = ''; select.append(placeholder);
    for (const [key, label] of [['REVIEWED', '已檢視'], ['FALSE_POSITIVE', '誤報']]) { const option = node('option', label); option.value = key; select.append(option); }
    const selected = selections.get(select.dataset.pitchControl);
    if (!incident.resolution && ['REVIEWED', 'FALSE_POSITIVE'].includes(selected)) select.value = selected;
    const label = node('label', '結案原因'); label.htmlFor = select.id;
    const resolve = control(node('button', '記錄結案'), Boolean(incident.acknowledgement) && !incident.resolution, `resolve:${incident.incidentId}`);
    resolve.type = 'button'; resolve.ariaLabel = `記錄 ${text(incident.contextId)} 的告警結案`;
    resolve.addEventListener('click', () => {
      if (!['REVIEWED', 'FALSE_POSITIVE'].includes(select.value)) { message('請先選擇結案原因。', true); select.focus(); return; }
      void actOnIncident(incident.incidentId, select.value);
    });
    actions.append(ack, label, select, resolve); row.append(actions); return row;
  }));
  if (!value.incidents.length) el('pitch-incidents').append(node('li', '目前沒有入場告警。', 'empty'));
  controls();
  if (focused) {
    const replacement = incidentControls.find(item => item.element.dataset.pitchControl === focused && !item.element.disabled);
    (replacement?.element ?? el('pitch-heading')).focus();
  }
}
async function readPitch() {
  const current = session; const generation = pitchGeneration; const value = await client.pitchStatus();
  if (current === session && generation === pitchGeneration && connected && pitchEnabled) renderPitch(value);
}
function schedulePitchPolling() {
  clearTimeout(pitchTimer);
  if (!connected || !pitchEnabled) return;
  const current = session; const generation = pitchGeneration;
  pitchTimer = setTimeout(async () => {
    if (current !== session || generation !== pitchGeneration || !connected || !pitchEnabled) return;
    if (busy) { schedulePitchPolling(); return; }
    try { await readPitch(); } catch (error) { if (current === session && generation === pitchGeneration) failure(error); }
    finally { if (current === session && generation === pitchGeneration) schedulePitchPolling(); }
  }, 3000);
}
async function actOnIncident(incidentId, resolution) {
  if (!connected || !pitchEnabled || busy) return;
  const current = session;
  await run(async () => {
    if (resolution) await client.resolveIncident({ incidentId, resolution });
    else await client.acknowledgeIncident({ incidentId });
    if (current !== session) return;
    await readPitch();
    if (current === session) message(resolution ? '已讀回告警結案紀錄；這不表示 context 已封鎖。' : '已讀回人員確認紀錄；這不表示處置已完成。');
  });
}
function clearEvidence() {
  observedEvidence = null;
  el('checks').replaceChildren(); el('events').replaceChildren(); el('evidence-details').hidden = true;
  el('evidence-scope').textContent = ''; el('timeline-count').textContent = '';
  lines('evidence-limitations', []);
  el('evidence-state').textContent = 'Not verified'; el('evidence-state').dataset.state = 'INCONCLUSIVE';
  el('evidence-summary').textContent = 'Read evidence for the current observations. No previous verification is carried forward.';
}
function clearReadbacks() {
  clearPitch();
  observedStatus = null;
  resetProposal(); el('private-state').hidden = true; el('locked-state').hidden = false;
  el('contexts').replaceChildren(); el('worlds').replaceChildren(); el('context').replaceChildren(node('option', 'Connect to load contexts'));
  el('observations').replaceChildren(); el('observation-count').textContent = 'No observations read';
  const option = node('option', 'All contexts'); option.value = ''; el('inspect-context').replaceChildren(option); el('inspect-context').value = '';
  clearEvidence(); el('readback-section').hidden = true; el('policy-readback').textContent = '';
  el('proposal-facts').replaceChildren(); lines('proposal-changes', []); lines('proposal-warnings', []);
  lines('runtime-limitations', []); el('reason').value = '';
  el('read-time').textContent = 'No private state loaded'; controls();
}
function clearPrivate() {
  connected = false; session++; busy = false; client.disconnect(); el('operator-token').value = '';
  clearReadbacks();
  el('connection-state').textContent = 'Disconnected'; el('read-time').textContent = 'No private state loaded';
  el('evidence-state').textContent = 'Not verified'; el('evidence-state').dataset.state = 'INCONCLUSIVE';
  el('evidence-summary').textContent = 'No evidence has been read in this session.'; controls();
}
function failure(error) {
  const code = error?.code ?? 'REQUEST_UNAVAILABLE';
  if (error?.status === 401 || error?.status === 403) {
    clearPrivate(); message(`${code}. Management access was not confirmed. Reconnect with an operator token.`, true);
  } else {
    clearReadbacks();
    message(error?.uncertain ? `${code}. The result is uncertain. Previous private views were cleared. Refresh state and evidence; this page will not repeat the change.`
      : `${code}. No successful result was confirmed. Previous private views were cleared. Refresh state and evidence before continuing.`, true);
  }
}
async function run(action) {
  if (busy) return;
  const current = session; stopPitchPolling(); busy = true; controls();
  try { await action(); } catch (error) { if (current === session) failure(error); }
  finally { if (current === session) { busy = false; controls(); schedulePitchPolling(); } }
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
function inContext(item) { return !el('inspect-context').value || item.contextId === el('inspect-context').value; }
function sourceDetails(label, value) {
  const details = node('details'); details.append(node('summary', label), node('pre', redacted(value))); return details;
}
function renderWorlds() {
  const contexts = list(observedStatus?.contexts);
  const selected = contexts.find(context => context.contextId === el('inspect-context').value);
  const worlds = list(observedStatus?.worlds).filter(world => !el('inspect-context').value
    || (selected && world.worldId === selected.worldId && world.tenantId === selected.tenantId));
  el('worlds').replaceChildren(...worlds.map(world => {
    const section = node('section', undefined, 'world-records');
    const header = node('div', undefined, 'world-row');
    header.append(node('strong', world.worldId), node('span', `Tenant ${text(world.tenantId)} · Revision ${text(world.revision)}`));
    section.append(header);
    if (!Array.isArray(world.records)) section.append(node('p', 'Record contents were not supplied by this readback.', 'help'));
    else if (!world.records.length) section.append(node('p', 'This world has no records.', 'help'));
    else {
      const records = node('dl', undefined, 'record-list');
      for (const record of world.records) {
        const term = node('dt', record.key); term.append(node('small', `Record revision ${text(record.revision)}`));
        const value = /(?:token|password|secret|credential|authorization|cookie|^ticket$)/i.test(text(record.key))
          ? '[redacted]' : typeof record.value === 'string' ? record.value : redacted(record.value);
        records.append(term, node('dd', value));
      }
      section.append(records);
    }
    return section;
  }));
  if (!worlds.length) el('worlds').append(node('p', 'No world records are available for this context in the current readback.', 'empty'));
  const observations = list(observedStatus?.observations).filter(inContext);
  el('observation-count').textContent = `${observations.length} observations · latest ${Math.min(DISPLAY_LIMIT, observations.length)} shown`;
  el('observations').replaceChildren(...observations.slice(-DISPLAY_LIMIT).reverse().map(observation => {
    const row = node('li');
    row.append(node('strong', text(observation.operation).replaceAll('-', ' ')),
      node('p', `Context ${text(observation.contextId)} · Request ${text(observation.requestId)}`, 'request-identity'),
      node('p', `Epoch ${text(observation.epoch)} · World revision ${text(observation.worldRevision)}`, 'help'));
    if (observation.usedBy) row.append(node('p', `Used by bounded adaptation ${text(observation.usedBy)}.`, 'help'));
    row.append(sourceDetails('Observation source', observation)); return row;
  }));
  if (!observations.length) el('observations').append(node('li', 'No canonical participant observations were supplied for this view.', 'empty'));
}
function requestIdentity(event) {
  return ['contextId', 'requestId', 'family'].every(key => typeof event[key] === 'string' && event[key].length > 0)
    ? JSON.stringify([event.contextId, event.requestId, event.family]) : null;
}
function outcomeLabel(value) {
  const labels = { SERVED: 'Served', REFUSED: 'Refused without new effect (server reported)',
    FAILED: 'Historical failure — effect not established', UNKNOWN: 'Outcome unknown — do not repeat the change' };
  return Object.hasOwn(labels, value) ? labels[value] : 'Outcome not established';
}
function eventTime(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return 'Time not reported';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('en-GB') : 'Time not established';
}
function renderTimeline() {
  if (!observedEvidence) return;
  const groups = new Map();
  const add = (event, source, index) => {
    if (!inContext(event)) return;
    const identity = requestIdentity(event);
    const key = identity ?? `${source}-unmatched-${index}`;
    if (!groups.has(key)) groups.set(key, { identity, reference: event, canonical: [], collector: [], collectorIndex: -1, canonicalIndex: -1 });
    const group = groups.get(key); group[source].push(event); group[`${source}Index`] = index;
  };
  list(observedEvidence.canonical?.events).forEach((event, index) => add(event, 'canonical', index));
  list(observedEvidence.events).forEach((event, index) => add(event, 'collector', index));
  const ordered = [...groups.values()].sort((a, b) => b.collectorIndex - a.collectorIndex || b.canonicalIndex - a.canonicalIndex);
  el('timeline-count').textContent = `${ordered.length} request or governance groups · ${Math.min(DISPLAY_LIMIT, ordered.length)} shown. Observations and evidence are separate server reads.`;
  el('events').replaceChildren(...ordered.slice(0, DISPLAY_LIMIT).map(group => {
    const row = node('article', undefined, 'request-event');
    const operations = [...new Set(group.canonical.map(event => event.operation).filter(value => typeof value === 'string'))];
    const operation = operations.length === 1 ? operations[0].replaceAll('-', ' ') : operations.length > 1 ? 'Multiple operations — inspect source'
      : group.identity ? 'Operation not supplied' : 'Canonical governance record';
    const heading = node('div', undefined, 'event-heading');
    heading.append(node('h4', operation));
    if (observedEvidence.canonical?.verifier?.status === 'VERIFIED'
      && group.canonical.some(event => event.kind === 'EXECUTE' && event.operation === 'write')) {
      row.append(node('p', 'Canonical write committed. A lost reply does not undo this write. Inspect its request identity before any retry.', 'correlation'));
    }
    const outcomes = [...new Set(group.collector.map(event => event.outcome))];
    if (outcomes.length === 1) { const state = badge(outcomeLabel(outcomes[0])); state.dataset.state = text(outcomes[0]); heading.append(state); }
    else heading.append(badge(outcomes.length ? 'Mixed outcomes — inspect attempts' : 'No collector outcome'));
    row.append(heading, node('p', group.identity
      ? `${text(group.reference.contextId)} / ${text(group.reference.requestId)} / ${text(group.reference.family)}`
      : 'No complete context / request / transport identity. This record is not paired.', 'request-identity'));
    const matched = group.identity && group.canonical.length > 0 && group.collector.length > 0;
    const correlation = matched ? 'Shared request identity in both sources. Inspect the checks above for verification.'
      : !group.canonical.length ? 'Canonical record missing. No operation or effect is inferred from this route record.'
      : !group.collector.length ? 'No collector record paired. This may be a governance event or an evidence gap; no route is inferred.'
      : 'Incomplete identity. Sources remain unpaired.';
    row.append(node('p', correlation, matched ? 'correlation' : 'correlation missing'),
      node('p', `${group.collector.length} collector attempts · ${group.canonical.length} canonical events`, 'help'));
    const destinations = [...new Set(group.collector.map(event => event.destination).filter(value => typeof value === 'string'))];
    row.append(node('p', destinations.length ? `Collector destination: ${destinations.join(', ')}` : 'No collector destination supplied.', 'help'));
    if (group.canonical.length) {
      const steps = node('ol', undefined, 'canonical-steps');
      for (const event of group.canonical) steps.append(node('li', `#${text(event.sequence)} ${text(event.kind)} · ${eventTime(event.at)}${event.outcome ? ` · ${outcomeLabel(event.outcome)}` : ''}`));
      row.append(steps);
    }
    if (outcomes.length > 1) {
      const attempts = node('ul', undefined, 'canonical-steps');
      for (const event of group.collector) attempts.append(node('li', `${outcomeLabel(event.outcome)} · ${text(event.destination)}`));
      row.append(attempts);
    }
    row.append(sourceDetails('Canonical and collector source records', { canonical: group.canonical, collector: group.collector }));
    return row;
  }));
  if (!ordered.length) el('events').append(node('p', 'No request or governance records were supplied for this view.', 'empty'));
}
function status(value) {
  observedStatus = value; clearEvidence();
  pitchEnabled = value.pitching != null;
  if (pitchEnabled) {
    el('grant-mutation-option').hidden = true; el('grant-mutation-option').disabled = true;
    if (el('action').value === 'GRANT_MUTATION') { el('action').value = 'FENCE'; resetProposal(); }
    renderPitch(value.pitching);
  } else clearPitch();
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
  const inspected = el('inspect-context').value;
  const all = node('option', 'All contexts'); all.value = '';
  el('inspect-context').replaceChildren(all, ...contexts.map(context => { const option = node('option', context.contextId); option.value = text(context.contextId); return option; }));
  el('inspect-context').value = contexts.some(context => context.contextId === inspected) ? inspected : '';
  renderWorlds();
  lines('runtime-limitations', value.limitations);
  el('private-state').hidden = false; el('locked-state').hidden = true;
  el('read-time').textContent = `Read at ${new Date().toLocaleTimeString('en-GB')}`;
}
function evidence(value) {
  observedEvidence = value;
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
  renderTimeline();
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
  if (busy) return;
  const token = el('operator-token').value; el('operator-token').value = '';
  clearPrivate();
  void run(async () => {
    const current = session; client.setToken(token); await readState();
    if (current !== session) return;
    connected = true; el('connection-state').textContent = 'Operator connected';
    message('Operator access confirmed. State has been read; no policy was changed.');
  });
});
el('disconnect').addEventListener('click', () => { clearPrivate(); message('Disconnected. Private views and the in-memory credential have been cleared.'); el('operator-token').focus(); });
el('refresh').addEventListener('click', () => void run(async () => { resetProposal(); await readState(); await readEvidence(); message('State and evidence refreshed. Review a new preview before another policy change.'); }));
el('read-evidence').addEventListener('click', () => void run(readEvidence));
el('inspect-context').addEventListener('change', () => { renderWorlds(); renderTimeline(); });
for (const id of ['context', 'action', 'reason']) el(id).addEventListener('input', resetProposal);
el('confirm').addEventListener('change', controls);
el('preview-form').addEventListener('submit', event => {
  event.preventDefault(); void run(async () => {
    const current = session;
    resetProposal();
    const requested = { contextId: el('context').value, action: el('action').value };
    if (pitchEnabled && requested.action === 'GRANT_MUTATION') { message('配球模式使用預授權規則，不提供一般 mutation grant。', true); return; }
    if (!requested.contextId) { message('Choose a context before previewing a policy change.', true); el('context').focus(); return; }
    if (el('reason').value.trim()) requested.reason = el('reason').value.trim();
    const next = await client.preview(requested);
    if (current !== session) return;
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
    const current = session;
    if (!connected || !proposal || !el('confirm').checked) return;
    if (proposal.expiresAt <= Date.now()) { resetProposal(); message('The proposal expired. Preview the current state again.', true); return; }
    const reviewed = { proposalId: proposal.proposalId, digest: proposal.digest, confirmation: 'APPLY' };
    resetProposal();
    const result = await client.apply(reviewed);
    if (current !== session) return;
    el('policy-readback').textContent = redacted(result); el('readback-section').hidden = false;
    el('readback-title').textContent = result.state === 'APPLIED' ? 'Policy applied — server readback' : 'Policy result — not confirmed';
    await readState(); if (current !== session) return;
    await readEvidence(); if (current !== session) return; el('readback-title').focus();
    message(result.state === 'APPLIED' ? 'The server reports this proposal applied. Inspect its readback and the separate evidence result below.' : 'The server did not confirm an applied change. Inspect readback and evidence.', result.state !== 'APPLIED');
  });
});
window.addEventListener('pagehide', clearPrivate);
void client.capabilities().then(capabilities).catch(() => { el('capabilities').replaceChildren(node('li', 'Readiness unavailable. Start the reference runtime and refresh this page.')); });
