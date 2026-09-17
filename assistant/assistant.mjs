const $ = id => document.getElementById(id);
let context; let activeRequest; let running = false; let uploaded;
const labels = { analyze: 'Investigate this incident.', request: 'Request a bounded containment.', apply: 'Apply the requested change.',
  verify: 'Verify the receipt.', tamper: 'Alter a receipt copy and test it.', replay: 'Replay the same request.', export: 'Export the evidence.', custom: 'Analyze my synthetic scenario.' };
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
function message(speaker, text, error = false) {
  const entry = document.createElement('div'); entry.className = `message ${speaker === 'YOU' ? 'user' : ''} ${error ? 'error' : ''}`;
  const label = document.createElement('span'); label.className = 'speaker'; label.textContent = speaker;
  entry.append(label, document.createTextNode(text)); $('conversation').append(entry);
  while ($('conversation').children.length > 18) $('conversation').firstChild.remove();
  $('conversation').scrollTop = $('conversation').scrollHeight;
}
async function get(path) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  const value = await res.json(); if (!res.ok) throw new Error(value.error ?? 'REQUEST_FAILED'); return value;
}
async function post(path, body) {
  context = await get('/api/context');
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-DQ-CSRF': context.csrfToken }, body: JSON.stringify(body) });
  const value = await res.json(); if (!res.ok) throw new Error(value.error ?? 'REQUEST_FAILED'); return value;
}
function renderRequest(row) {
  activeRequest = row;
  $('manifest').hidden = !row;
  $('request-state').textContent = row?.state.replaceAll('_', ' ') ?? 'NO REQUEST YET';
  $('request-state').className = `state ${row?.state === 'AWAITING_HUMAN' ? 'pending' : ''}`;
  if (!row) return;
  $('target').textContent = row.assetId;
  $('expiry').textContent = new Date(row.draft.expiresAt).toLocaleTimeString();
  $('manifest-digest').textContent = row.manifestDigest;
  $('manifest-json').textContent = JSON.stringify(row.draft, null, 2);
  $('approve-form').hidden = row.state !== 'AWAITING_HUMAN' || !context.state.capabilities.includes('PUBLISH_GRANT');
  $('review-description').textContent = ({ AWAITING_HUMAN: 'Nothing has changed. Review the target, one-effect budget and expiry; then reauthenticate to approve.', APPROVED: 'Approved by a separately authenticated human. The agent can now apply only this bounded change.', COMPLETED: 'The synthetic effect is complete. Its signed receipt records the before state and actual database read-back.', EXPIRED: 'This request expired. Ask for a new request; old authority is not extended.', AUTHORIZATION_INACTIVE: 'Authorization is no longer active. No new effect can use it.' })[row.state] ?? 'Review the current state before retrying.';
}
async function refresh() {
  context = await get('/api/context');
  $('login-panel').hidden = context.authenticated; $('workspace').hidden = !context.authenticated;
  if (!context.authenticated) { activeRequest = undefined; $('conversation').replaceChildren(); return; }
  $('identity').textContent = `${context.state.role.replaceAll('_', ' ')} · ${context.state.tenantId}`;
  const state = await get('/api/assistant/context');
  $('protocol').textContent = `MCP ${state.info.protocolVersion} · ${state.info.transport}`;
  $('scenario-title').textContent = state.info.scenario.title;
  renderRequest(state.responses.find(row => row.requestId === activeRequest?.requestId) ?? state.responses.at(-1));
  $('asset-list').replaceChildren();
  for (const asset of context.state.assets) {
    const row = document.createElement('div'); row.className = 'asset';
    for (const text of [asset.id, `${asset.state} · v${asset.version}`]) { const span = document.createElement('span'); span.textContent = text; row.append(span); }
    $('asset-list').append(row);
  }
  if (!$('conversation').children.length) message('DUNGEONQ', 'I can investigate the artificial incident immediately. If a change is needed, I will request your approval. I have no approval tool.');
}
function renderTrace(trace) {
  $('trace').replaceChildren();
  for (const call of trace) {
    const row = document.createElement('tr');
    for (const text of [String(call.sequence).padStart(2, '0'), call.tool, call.code ?? call.status, call.outputDigest.slice(0, 16)]) {
      const cell = document.createElement('td'); cell.textContent = text;
      if (text === call.code || (text === call.status && text === 'REJECTED')) cell.className = 'rejected'; row.append(cell);
    }
    $('trace').append(row);
  }
}
async function guarded(action) {
  if (running) return;
  running = true; notice(); document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await action(); }
  catch (error) { notice(error.message === 'AUTH_REQUIRED' ? 'Your session ended. Sign in again; approved records remain in the database.' : error.message); }
  finally { running = false; document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
async function command(name) {
  if (['apply', 'replay', 'verify', 'tamper', 'export'].includes(name) && !activeRequest) throw new Error('Request containment first.');
  message('YOU', labels[name] ?? name);
  const body = { command: name, ...(['apply', 'replay', 'verify', 'tamper', 'export'].includes(name) ? { requestId: activeRequest.requestId } : {}), ...(name === 'custom' ? { scenarioPack: uploaded } : {}) };
  const output = await post('/api/assistant/command', body);
  renderTrace(output.trace); $('result-json').textContent = JSON.stringify(output.result, null, 2);
  const result = output.result;
  $('proof-result').className = 'proof-result';
  if (output.failed) {
    message('DUNGEONQ', `${result.error}. No new effect was authorized.`, true);
    $('proof-result').textContent = `BLOCKED · ${result.error}`; $('proof-result').className = 'proof-result rejected';
  } else if (['analyze', 'custom'].includes(name)) {
    message('DUNGEONQ', `Analysis complete. Route overlay: ${result.decision.route}; risk score: ${result.decision.riskScore}/100. Expected assertions: ${result.assertionsPassed ? 'PASS' : 'FAIL'}.\n${result.proposal.executableAfterApproval ? 'The modeled proposal requires approval. No asset has changed.' : 'The modeled effect is blocked. Approval must not override these failed controls.'}`);
    $('proof-result').textContent = `ANALYZED · ${result.decision.route} · Input ${result.inputDigest.slice(0, 16)} · No effect`;
  } else if (name === 'request') { activeRequest = result; message('DUNGEONQ', `Request saved for ${result.assetId}. One synthetic containment; five-minute observation window. Please use the human review desk. Your password is never sent to me.`); }
  else if (['apply', 'replay'].includes(name)) {
    if (result.body?.state === 'COMPLETED') {
      message('DUNGEONQ', `${name === 'replay' ? 'The same signed receipt was recovered; no second effect.' : 'The authorized synthetic containment completed.'}\nRead-back: ${result.body.before.state} → ${result.body.after.state}, version ${result.body.after.version}.`);
      $('proof-result').textContent = `${name === 'replay' ? 'REPLAY RECOVERED' : 'READ-BACK VERIFIED'} · ${result.body.jobId}`;
    } else message('DUNGEONQ', `Execution stopped: ${result.state ?? 'UNKNOWN'} · ${result.reason ?? 'Inspect evidence before retrying.'}`, true);
  } else if (['verify', 'tamper'].includes(name)) {
    const text = name === 'tamper' ? (result.valid ? 'UNEXPECTED: tampered copy accepted.' : 'TAMPER DETECTED · the altered copy failed signature verification. The original receipt is unchanged.') : (result.valid ? 'VERIFIED · signature and read-back semantics match the pinned key.' : 'VERIFICATION FAILED');
    message('DUNGEONQ', text, !result.valid); $('proof-result').textContent = text;
  } else if (name === 'export') {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'dungeonq-assistant-evidence.json'; link.click(); URL.revokeObjectURL(url);
    message('DUNGEONQ', 'Exported the exact request, receipt and public verification key. Local signer evidence only; no secrets.');
  }
  await refresh();
}
document.querySelectorAll('[data-astra-task]').forEach(button => button.addEventListener('click', () => guarded(async () => {
  message('YOU', `Ask Astra to ${button.dataset.astraTask}. Only the minimized synthetic state is sent to OpenAI.`);
  const output = await post('/api/assistant/command', { command: 'astra', task: button.dataset.astraTask });
  renderTrace(output.trace);
  $('result-json').textContent = JSON.stringify(output, null, 2);
  message(output.astra.mode === 'LIVE_OPENAI' ? 'GPT-6 ASTRA · LIVE' : 'MOCK MODEL · TEST ONLY', output.astra.candidate.explanation, output.failed);
  message('RUNTIME', output.failed ? `BLOCKED: ${output.result.error}` : `Candidate: ${output.astra.candidate.action}. Outcome: ${output.result.state ?? output.result.body?.state ?? (output.result.valid === true ? 'VERIFIED' : 'Inspect evidence')}.`);
  $('proof-result').textContent = `${output.astra.mode} · ${output.astra.model} · ${output.astra.responseId ?? 'No live response ID'} · estimated usage $${(output.astra.estimatedUsageUsd ?? 0).toFixed(4)}`;
  if (output.result.requestId) activeRequest = output.result;
  await refresh();
})));
$('login-form').addEventListener('submit', event => { event.preventDefault(); guarded(async () => {
  const password = $('login-password').value; const otp = $('login-otp').value;
  $('login-password').value = ''; $('login-otp').value = '';
  await post('/api/login', { tenantId: 'tenant-lab', username: $('username').value, password, ...(otp ? { otp } : {}) }); await refresh();
}); });
$('approve-form').addEventListener('submit', event => { event.preventDefault(); guarded(async () => {
  const requestId = activeRequest.requestId; const manifestDigest = activeRequest.manifestDigest;
  const password = $('approve-password').value; const otp = $('approve-otp').value;
  $('approve-password').value = ''; $('approve-otp').value = '';
  const current = (await get('/api/assistant/context')).responses.find(row => row.requestId === requestId);
  if (current?.manifestDigest !== manifestDigest || current.state !== 'AWAITING_HUMAN') throw new Error('The request changed. Refresh and review again.');
  const intent = await post('/api/intents', { password, ...(otp ? { otp } : {}), purpose: 'PUBLISH_GRANT', manifestDigest });
  await post('/api/assistant/approve', { requestId, manifestDigest, intentToken: intent.intentToken });
  message('HUMAN REVIEW', 'You approved this exact manifest through the authenticated human endpoint. The assistant still cannot approve itself.'); await refresh();
}); });
document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => guarded(() => command(button.dataset.command))));
$('refresh').addEventListener('click', () => guarded(refresh));
$('logout').addEventListener('click', () => guarded(async () => { await post('/api/logout', {}); $('approve-password').value = ''; $('approve-otp').value = ''; await refresh(); }));
$('scenario-file').addEventListener('change', () => guarded(async () => {
  uploaded = undefined; const file = $('scenario-file').files[0];
  if (!file || file.size > 131_072) throw new Error('Select a synthetic JSON file no larger than 128 KiB.');
  uploaded = JSON.parse(await file.text()); notice('Scenario loaded for analysis. Server admission will validate every field.');
}));
$('custom-analyze').addEventListener('click', () => guarded(async () => { if (!uploaded) throw new Error('Choose a scenario first.'); await command('custom'); }));
window.addEventListener('pagehide', () => { document.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; }); });
refresh().catch(error => notice(error.message));
