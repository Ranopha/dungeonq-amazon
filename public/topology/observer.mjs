const $ = id => document.getElementById(id);
const TOKEN_KEY = 'dungeonq-topology-observer';
let token; let startupError = ''; let busy = false; let readable = false; let timer;
try {
  const supplied = new URLSearchParams(location.hash.slice(1)).get('token');
  if (supplied) {
    history.replaceState(null, '', `${location.pathname}${location.search ?? ''}`);
    sessionStorage.setItem(TOKEN_KEY, supplied);
  }
  token = sessionStorage.getItem(TOKEN_KEY);
} catch { startupError = 'Browser session storage is unavailable. Reopen the local Observer link after enabling session storage.'; }
const node = (tag, text, className) => {
  const item = document.createElement(tag); item.textContent = text;
  if (className) item.className = className;
  return item;
};
const textValue = value => value === null || value === undefined ? 'Unknown' : String(value);
const numberValue = value => Number.isInteger(value) && value >= 0 ? String(value) : 'Unknown';
const objective = value => value === true ? 'Met' : value === false ? 'Not met' : 'Unknown';
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'notice error' : 'notice'; }
function controls() { $('refresh').disabled = busy; $('download').disabled = busy || !readable; }
async function api(path) {
  if (!token) throw new Error('Open the separate Observer link printed by the local launcher. A participant credential cannot read this page.');
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  let data;
  try { data = await response.json(); } catch { throw new Error('The Observer returned an unreadable response. Current verification is unknown.'); }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The Observer is unavailable.');
  return data;
}
function render(data) {
  if (!data || data.profile !== 'SYNTHETIC_TOPOLOGY_WORKFLOW' || !Array.isArray(data.events) || !data.summary) {
    throw new Error('The observation response is incomplete. Do not treat it as a verified result.');
  }
  const summary = data.summary;
  $('event-count').textContent = String(data.events.length);
  $('local-successes').textContent = numberValue(summary.localSuccesses);
  $('actual-goal').textContent = objective(summary.goalCompleted);
  $('completion-claims').textContent = Array.isArray(summary.completionClaims) ? String(summary.completionClaims.length) : 'Unknown';
  $('world-id').textContent = `World: ${textValue(data.worldId)}`;
  const verified = data.verification?.valid === true && data.verification.eventCount === data.events.length;
  $('verification-title').textContent = verified ? 'Received sequence replayed' : data.verification?.valid === false ? 'Replay did not pass' : 'Replay result unavailable or incomplete';
  $('verification-title').className = verified ? 'verified' : 'unverified';
  $('verification-detail').textContent = verified
    ? `${data.verification.eventCount} retained events matched the fixed causal workflow. This is not external attestation.`
    : 'No complete successful replay result is available. The retained evidence can still be downloaded for inspection.';
  $('lag').textContent = Number.isInteger(data.lag) && data.lag >= 0
    ? `${data.lag} events pending relative to the latest received progress notification. Observer status: ${textValue(data.status)}.`
    : `Delivery lag is unknown. Observer status: ${textValue(data.status)}.`;
  const claims = Array.isArray(summary.completionClaims) ? summary.completionClaims : [];
  $('claim-comparison').replaceChildren(...(claims.length ? claims.map(claim => {
    const row = node('div', '', 'claim-row');
    row.append(node('strong', `Event ${claim.sequence} · ${claim.claimedComplete === true ? 'Completion explicitly claimed' : 'Claim value unknown'}`),
      node('p', `Actual objective at that event: ${objective(claim.actualComplete)}. ${claim.actualComplete === false ? 'The server refused completion and left the workflow open.' : claim.actualComplete === true ? 'The completion claim matched the catalogue state.' : 'No success or failure is inferred.'}`));
    return row;
  }) : [node('p', Array.isArray(summary.completionClaims) ? 'No completion claim has been recorded. Exploring a local branch is not a completion claim.' : 'Completion-claim records are unavailable.', 'fine')]));
  const successes = data.events.filter(event => event.command?.type === 'act' && event.observation?.outcome === 'SUCCESS' && event.command.actionId !== 'index-accession');
  $('success-chain').replaceChildren(...(successes.length ? successes.map(event => node('li', `Event ${event.sequence}: ${event.command.actionId} — ${event.observation.message ?? 'Local effect recorded.'}`))
    : [node('li', 'No local-success action is present in the received sequence.')]));
  const context = [
    ['Source declaration', textValue(summary.participantMode)], ['Condition', textValue(summary.arm)], ['Phase', textValue(summary.phase)],
    ['Unconfirmed completion claims', numberValue(summary.wrongCompletionClaims)],
    ['Longest local-branch action run', numberValue(summary.consecutiveLocalBranchActions)],
    ['Distinct local-branch successes', Array.isArray(summary.uniqueLocalBranchSuccesses) ? String(summary.uniqueLocalBranchSuccesses.length) : 'Unknown'],
    ['Complete local chain', summary.completedLocalChain === true ? 'Completed' : summary.completedLocalChain === false ? 'Not complete' : 'Unknown'],
    ['First refused-claim event', summary.firstCounterevidence === null ? 'Not recorded' : numberValue(summary.firstCounterevidence)],
    ['Consumer lineage records', numberValue(summary.consumerLineageCount)], ['Belief status', textValue(summary.beliefStatus)],
  ];
  $('study-context').replaceChildren(...context.map(([label, value]) => {
    const row = document.createElement('div'); row.append(node('dt', label), node('dd', value)); return row;
  }));
  $('efficacy').textContent = `${summary.efficacyClaim ?? 'EFFICACY_UNKNOWN'} — explicit claims and actions do not reveal private beliefs. Source declarations do not independently attest model identity.`;
  $('summary').textContent = JSON.stringify(summary, null, 2);
  $('timeline').replaceChildren(...(data.events.length ? data.events.map(event => {
    const item = document.createElement('li'); const body = node('div', '', 'event-body');
    const command = event.command ?? {}; const observation = event.observation ?? {};
    body.append(node('h3', `${command.type ?? 'Unknown command'}${command.actionId ? ` · ${command.actionId}` : command.sceneId ? ` · ${command.sceneId}` : ''}`),
      node('p', `${observation.outcome ?? 'Unknown outcome'} — ${observation.message ?? 'No result text provided.'}`));
    if (command.expectedOutcome !== undefined) body.append(node('p', `Optional stated expectation: ${command.expectedOutcome}`));
    if (command.type === 'finish') body.append(node('p', `Completion claim read-back: ${objective(observation.actualComplete)}.`));
    if (event.lineage) body.append(node('p', 'Consumer lineage retained: delivery → read → decision → local write.'));
    const details = document.createElement('details');
    details.append(node('summary', 'Inspect original event and lineage'), node('pre', JSON.stringify(event, null, 2)));
    body.append(details); item.append(node('span', String(event.sequence), 'event-number'), body); return item;
  }) : [node('li', 'No recorded events have reached this Observer. An empty record is not evidence of efficacy.')]));
  readable = true;
}
async function refresh() {
  if (busy) return;
  busy = true; controls();
  try { render(await api('/api/observer')); notice('Independent observation store read back. Replay status applies only to the received sequence.'); }
  catch (error) {
    readable = false; $('verification-title').textContent = 'Latest verification unknown'; $('verification-title').className = 'unverified';
    $('verification-detail').textContent = 'The last visible record may be stale. Refresh failed; no new successful verification is claimed.';
    notice(error.message, true);
  } finally { busy = false; controls(); }
}
$('refresh').addEventListener('click', refresh);
$('live').addEventListener('change', () => { clearInterval(timer); if ($('live').checked) timer = setInterval(refresh, 3000); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearInterval(timer); $('live').checked = false; }
});
$('download').addEventListener('click', async () => {
  if (busy || !readable) return;
  busy = true; controls();
  try {
    const bundle = await api('/api/evidence');
    if (bundle?.schemaVersion !== 'dungeonq.topology-evidence/v2' || !Array.isArray(bundle.events)) throw new Error('The evidence response is incomplete; no download was created.');
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `dungeonq-topology-${String(bundle.worldId ?? 'evidence').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    notice('Evidence handed to the browser for download. It includes researcher-only information; keep it away from an ongoing blind participant session.');
  } catch (error) { notice(error.message, true); }
  finally { busy = false; controls(); }
});
if (startupError) { notice(startupError, true); controls(); }
else await refresh();
