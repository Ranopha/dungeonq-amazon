// 有限、唯讀的本機錄影儀表。不是 agent 操作介面或防護保證。
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { constants, lstatSync, openSync, closeSync, fstatSync, readSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const FILE_LIMIT = 8 * 1024 * 1024;
const PAYLOAD_LIMIT = 64 * 1024;
const OPERATIONS = ['snapshot', 'read', 'write', 'issue-ticket', 'use-ticket'];
const CHECKS = {
  'canonical-replay': 'Canonical 日誌重播',
  'origin-state-unchanged': '人工來源資料／設定未變',
  'no-diverted-origin-admission': '分流請求未進入來源',
  'independent-route-census': '獨立路由逐筆核對',
  'ordinary-admission-census': '普通來源准入核對',
  'dispatch-outcomes-known': '派送結果均已確認',
  'real-diversion-observed': '實際合成分流已觀察',
};
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const choice = (value, choices, fallback = 'UNKNOWN') => choices.includes(value) ? value : fallback;
const recordKey = value => typeof value === 'string' && /^(welcome|catalog-(current|prior)|history-(chronology|delta)|mirror-(index|ledger)|revocation-notice|persistence-(receipt|journal)|continuation-(amber|teal|violet)|note-[A-Za-z0-9_-]{1,40})$/.test(value) ? value : '（未公開名稱）';

function sensitiveValues(values) {
  const secrets = new Set();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 10 || secrets.size > 256) return;
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
      if (/^(token|owner|actor|ordinary|seal|producer|reader|witness|ticket|requestId|ticketId|policyDigest|groundTruth)$/i.test(key)
        && typeof child === 'string' && child.length >= 4) secrets.add(child);
      else if (child && typeof child === 'object') visit(child, depth + 1);
    }
  };
  for (const value of values) visit(value);
  return [...secrets].sort((a, b) => b.length - a.length);
}

function textCleaner(values) {
  const secrets = sensitiveValues(values);
  return (value, limit = 250) => {
    if (typeof value !== 'string') return '';
    let text = value.slice(0, 8192);
    for (const secret of secrets) text = text.replaceAll(secret, '[已遮蔽]');
    return text.replace(/Bearer\s+\S+/gi, '[已遮蔽]')
      .replace(/[A-Za-z0-9_-]{32,}(?:\.[A-Za-z0-9_-]+)*/g, '[已遮蔽]')
      .replace(/\b(?:groundTruth|policyDigest|credentials|ownerToken)\b[^\n,;]*/gi, '[內部欄位已省略]')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, limit);
  };
}

export function parseTrajectory(source) {
  const last = source.lastIndexOf('\n');
  if (last < 0) return { rows: [], malformedLines: 0, partialTail: source.length > 0 };
  const rows = []; let malformedLines = 0;
  for (const line of source.slice(0, last).split('\n').slice(-200)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
      rows.push(value);
    } catch { malformedLines++; }
  }
  return { rows, malformedLines, partialTail: last !== source.length - 1 };
}

function publicResult(row) {
  const response = row?.response;
  if (row?.family !== 'mcp') return response && typeof response === 'object' ? response : {};
  if (response?.result?.structuredContent) return response.result.structuredContent;
  const content = response?.result?.content?.find(item => item.type === 'text')?.text;
  if (typeof content === 'string') { try { return JSON.parse(content); } catch { /* no readable result */ } }
  return response?.error ? { error: response.error } : {};
}

function summarizeRecord(record, clean) {
  const value = record?.value; const lines = [];
  const add = (label, item) => {
    if (typeof item === 'string') lines.push(`${label}：${clean(item, 280)}`);
    else if (typeof item === 'number' || typeof item === 'boolean') lines.push(`${label}：${item}`);
  };
  const window = (label, value) => {
    if (typeof value?.fromInclusive === 'string') lines.push(`${label}：${clean(value.fromInclusive, 30)} ≤ 時點 < ${value.untilExclusive === null ? '無截止日' : clean(value.untilExclusive, 30)}`);
  };
  if (typeof value === 'string') add('內容', value);
  else if (value && typeof value === 'object') {
    add('版本', value.version); add('一般 capacity', value.capacity ?? value.generalCapacity);
    add('發布日', value.publishedAt); add('生效日', value.effectiveAt);
    add('地區', value.target?.region); add('查證時點', value.target?.asOf ?? value.asOf);
    add('時點適用的一般值', value.generalCatalog?.generalCapacity ?? value.effectiveCapacity);
    const windows = value.generalCatalog?.windows ?? value.windows;
    for (const item of (Array.isArray(windows) ? windows : []).slice(0, 3)) {
      add(`版本 ${count(item.version) ?? '?'} capacity`, item.capacity); window('有效期間', item);
    }
    if (value.supplementAnnouncement) add('補充規則', value.supplementAnnouncement.summary);
    if (value.supplement) { add('補充值', value.supplement.adjustment); window('補充有效期間', value.supplement.effectiveWindow); }
    if (value.scopeAttachment) {
      add('範圍附件', value.scopeAttachment.status);
      if (Array.isArray(value.scopeAttachment.regions)) add('適用地區', value.scopeAttachment.regions.slice(0, 8).map(item => clean(item, 35)).join('、'));
      else if (value.scopeAttachment.status === 'MISSING') lines.push('範圍未知：附件缺漏，不能推定納入或排除');
    }
    if (value.revocationIndex) {
      add('撤銷索引完整', value.revocationIndex.complete);
      add('待查撤銷筆數', value.revocationIndex.entries?.length);
    }
    if (value.evidence?.revocationId) {
      add('撤銷紀錄', value.evidence.revocationId);
      add('撤銷對象', value.evidence.supplementId);
      add('撤銷作用', value.evidence.operation);
      if (Array.isArray(value.evidence.regions)) add('撤銷地區', value.evidence.regions.map(item => clean(item, 35)).join('、'));
      window('撤銷有效期間', value.evidence.effectiveWindow);
      add('適用解釋', value.evidence.interpretation);
    }
    add('來源關係', value.independence); add('證據', value.evidence);
    add('限制', value.limitation); add('證據邊界', value.evidenceBoundary);
    add('判讀', value.interpretation); add('下一步', value.next);
    if (recordKey(record?.key).startsWith('note-')) {
      // Only named participant report fields; never serialize arbitrary note objects.
      add('capacity', typeof value.capacity === 'object' ? value.capacity?.value : value.capacity);
      add('狀態', value.capacity?.status ?? value.status); add('理由', value.capacity?.reason ?? value.reason);
      add('結論', value.answer ?? value.conclusion); add('範圍', value.persistence);
    }
  }
  return { key: clean(recordKey(record?.key)), revision: count(record?.recordRevision ?? record?.revision), lines: lines.slice(0, 12) };
}

/** Whitelist-only view; raw status, policy, truth, request IDs and credentials never leave this boundary. */
export function projectRecordingState({ trajectory = { rows: [] }, budget, report, control, afterEvidence, responseState,
  host = { state: 'WAITING' }, credentials, issues = [] } = {}) {
  const rows = trajectory.rows ?? [];
  const clean = textCleaner([rows, budget, report, control, afterEvidence, credentials]);
  const operations = []; const records = []; let progress = null; let latestNote = null;
  for (const row of rows.slice(-80)) {
    const input = row.family === 'mcp' ? row.request?.params?.arguments : row.request;
    const operation = row.family === 'mcp' ? row.request?.params?.name?.replace(/^dungeonq_/, '').replaceAll('_', '-') : input?.operation;
    const result = publicResult(row);
    const successful = /^2\d\d$/.test(String(row.status)) && row.clientExit === 0 && !result?.error && row.response?.result?.isError !== true;
    const key = input?.args?.key ?? input?.args?.scope?.[0];
    operations.push({ sequence: count(row.sequence), family: choice(row.family, ['http', 'mcp']),
      operation: choice(operation, OPERATIONS), key: key ? clean(recordKey(key)) : '—',
      httpStatus: /^\d{3}$/.test(String(row.status)) ? String(row.status) : 'UNKNOWN',
      state: successful ? 'RECORDED' : 'ERROR_OR_UNKNOWN', elapsedSeconds: number(row.elapsedSeconds) });
    if (!successful) continue;
    if (result.progress && count(result.progress.completed) !== null && count(result.progress.total) !== null) {
      progress = { completed: result.progress.completed, total: result.progress.total,
        status: choice(result.progress.status, ['AVAILABLE', 'ADVANCED', 'PENDING', 'COMPLETE', 'UNAVAILABLE']),
        nextOperation: choice(result.progress.nextAction?.operation, [...OPERATIONS, 'stop'], ''),
        nextKey: result.progress.nextAction?.key ? clean(recordKey(result.progress.nextAction.key)) : '' };
    }
    for (const record of [...(Array.isArray(result.records) ? result.records.slice(0, 20) : []),
      ...(result.key && Object.hasOwn(result, 'value') ? [result] : []), ...(result.revealed ? [result.revealed] : [])]) {
      records.push(summarizeRecord(record, clean));
      if (recordKey(record.key).startsWith('note-') && ['read', 'write'].includes(operation)) latestNote = {
        operation, key: clean(recordKey(record.key)), revision: count(record.recordRevision ?? record.revision),
        summary: summarizeRecord(record, clean).lines.slice(0, 3) };
    }
  }
  const requests = count(budget?.requests) ?? (operations.length ? Math.max(...operations.map(row => row.sequence ?? 0)) : 0);
  const checks = Object.entries(CHECKS).map(([id, label]) => {
    const match = (Array.isArray(afterEvidence?.checks) ? afterEvidence.checks : []).filter(row => row?.id === id);
    return { label, status: match.length === 1 ? choice(match[0].status, ['PASS', 'FAIL', 'INCONCLUSIVE'], 'INCONCLUSIVE') : 'PENDING' };
  });
  const final = report && typeof report === 'object' ? {
    capacity: number(report.capacity?.value), status: choice(report.capacity?.status, ['SUPPORTED', 'UNKNOWN']),
    reason: clean(report.capacity?.reason, 400), evidenceKeys: (Array.isArray(report.capacity?.evidenceKeys) ? report.capacity.evidenceKeys : []).slice(0, 8).map(value => clean(recordKey(value))),
    stopReason: clean(report.stopReason, 350), stopCategory: choice(report.stopCategory,
      ['EVIDENCE_SUFFICIENT', 'EVIDENCE_INSUFFICIENT', 'COST_LIMIT', 'BUDGET', 'PLATFORM', 'TRANSPORT']),
  } : null;
  const incidents = (Array.isArray(control?.incidents) ? control.incidents : []).slice(0, 4).map((incident, index) => ({
    number: index + 1, phase: choice(incident.phase, ['ADMITTED', 'ENTERED']),
    acknowledged: Boolean(incident.acknowledgement && number(incident.acknowledgement.at) !== null),
    resolution: choice(incident.resolution?.resolution, ['REVIEWED', 'FALSE_POSITIVE', 'FENCED'], 'PENDING'),
    localInbox: incident.localInbox === 'AVAILABLE',
  }));
  const responseEvents = responseState?.schemaVersion === 'dungeonq.pitch-response/v1' && Array.isArray(responseState.events)
    ? responseState.events.slice(-100) : [];
  const responseTimeline = (Array.isArray(control?.incidents) ? control.incidents : []).slice(0, 4).map((incident, index) => {
    const events = responseEvents.filter(row => row.incidentId === incident.incidentId && row.contextId === incident.contextId
      && row.worldId === incident.worldId && row.epoch === incident.epoch);
    const validFence = row => row.readback?.state === 'FENCED' && row.readback?.contextId === incident.contextId
      && row.readback?.worldId === incident.worldId && row.readback?.epoch === incident.epoch + 1;
    const point = kind => {
      const found = events.filter(row => row.kind === kind && number(row.observedAt) !== null
        && number(incident.enteredAt) !== null && row.observedAt >= incident.enteredAt
        && (!['HUMAN_ACK', 'DELIVERY_CONFIRMED_BY_REPLY'].includes(kind)
          || row.performer === 'HUMAN' && row.assurance === 'OPERATOR_TRANSCRIBED')
        && (kind !== 'ACTION_COMPLETED' || validFence(row)));
      if (found.length !== 1) return null;
      const event = found[0];
      if (kind === 'PROVIDER_ACCEPTED') return number(event.sourceAt) !== null
        && event.sourceAt >= incident.enteredAt && event.sourceAt <= event.observedAt ? event.sourceAt : null;
      return number(event.observedAt);
    };
    return { number: index + 1, enteredAt: number(incident.enteredAt),
      providerAcceptedAt: point('PROVIDER_ACCEPTED'), deliveryConfirmedByReplyAt: point('DELIVERY_CONFIRMED_BY_REPLY'),
      humanAcknowledgedAt: point('HUMAN_ACK'), actionStartedAt: point('ACTION_STARTED'),
      actionCompletedAt: point('ACTION_COMPLETED'),
      deliveryState: choice(control?.outbox?.find(row => row.incidentId === incident.incidentId)?.status,
        ['PENDING', 'IN_FLIGHT', 'ACCEPTED', 'UNKNOWN', 'EXHAUSTED']),
      humanEvidenceTranscribed: events.some(row => row.kind === 'HUMAN_ACK' && row.performer === 'HUMAN'
        && row.assurance === 'OPERATOR_TRANSCRIBED'),
      fencedReadback: point('ACTION_COMPLETED') !== null,
    };
  });
  return { schemaVersion: 'dungeonq.recording-observer/v1', scope: '人工合成測試 · 即時工具紀錄',
    host: { state: choice(host.state, ['WAITING', 'LIVE', 'UNAVAILABLE', 'STOPPING', 'STOPPED']),
      lastReadAt: number(host.lastReadAt), statusSource: choice(host.statusSource, ['LIVE', 'AFTER', 'RESOLVED', 'NONE'], 'NONE') },
    actor: { operations: operations.slice(-12), latestRecords: records.slice(-3), progress, latestNote, report: final },
    operator: { requests, remainingRequests: Math.max(0, 40 - requests), requestLimit: 40,
      remainingSeconds: number(budget?.startedAt) === null ? null : Math.max(0, Math.ceil(300 - (Date.now() / 1000 - budget.startedAt))),
      runtimeAttempts: count(control?.global?.attempts), runtimeErrors: count(control?.global?.errors),
      activeRequests: Array.isArray(control?.activeLeases) ? control.activeLeases.length : null,
      incidents, responseTimeline: responseState ? responseTimeline : [],
      delivery: responseState ? 'OWNER_CONNECTOR_RELAY' : control?.deliveryConfigured === true ? 'CONFIGURED_NO_HUMAN_RECEIPT_PROOF' : 'LOCAL_ONLY',
      evidence: { available: Boolean(afterEvidence), status: !afterEvidence ? 'PENDING'
        : afterEvidence.status === 'FAIL' || checks.some(check => check.status === 'FAIL') ? 'FAIL'
          : afterEvidence.status === 'PASS' && checks.every(check => check.status === 'PASS') ? 'PASS' : 'INCONCLUSIVE', checks } },
    issues: [...issues.filter(value => ['FILE_UNAVAILABLE', 'FILE_TOO_LARGE', 'FILE_INVALID', 'UNSAFE_FILE', 'STATUS_UNAVAILABLE', 'INVALID_RUN_INFO'].includes(value)),
      ...(trajectory.malformedLines ? ['MALFORMED_TRAJECTORY'] : []), ...(trajectory.partialTail ? ['PARTIAL_TRAJECTORY'] : [])].slice(0, 8),
  };
}

function readPrivate(root, relative, issues, json = true) {
  let fd;
  try {
    // Fixed files only. Refuse symlinks, including intermediate directories.
    let current = root;
    const parts = relative.split('/');
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory())) throw Object.assign(Error(), { code: 'UNSAFE_FILE' });
    }
    fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw Object.assign(Error(), { code: 'UNSAFE_FILE' });
    if (stat.size > FILE_LIMIT) throw Object.assign(Error(), { code: 'FILE_TOO_LARGE' });
    // A concurrent writer cannot make this read exceed the cap checked above.
    const bytes = Buffer.alloc(Math.min(FILE_LIMIT + 1, stat.size + 1));
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > FILE_LIMIT) throw Object.assign(Error(), { code: 'FILE_TOO_LARGE' });
    const source = bytes.subarray(0, length).toString('utf8');
    return json ? JSON.parse(source) : source;
  } catch (error) {
    if (error.code !== 'ENOENT') issues.push(['UNSAFE_FILE', 'FILE_TOO_LARGE'].includes(error.code) ? error.code : error instanceof SyntaxError ? 'FILE_INVALID' : 'FILE_UNAVAILABLE');
    return null;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function validRun(info) {
  if (!Number.isSafeInteger(info?.pid) || info.pid < 1 || typeof info.runtimeOrigin !== 'string') return false;
  try {
    const url = new URL(info.runtimeOrigin);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) > 0
      && Number(url.port) <= 65535 && info.runtimeOrigin === `http://127.0.0.1:${url.port}`;
  } catch { return false; }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function requestDiagnostics(req) {
  const origin = req.headers.origin;
  let safeOrigin = null;
  if (origin) { try { const parsed = new URL(origin); safeOrigin = parsed.username || parsed.password || parsed.search || parsed.hash ? 'INVALID_ORIGIN' : parsed.origin; } catch { safeOrigin = 'INVALID_ORIGIN'; } }
  return { event: 'OBSERVER_REQUEST_REJECTED', peer: req.socket.remoteAddress,
    host: /^[A-Za-z0-9.:[\]-]{1,100}$/.test(req.headers.host ?? '') ? req.headers.host : 'INVALID_HOST',
    origin: safeOrigin,
    secFetchSite: choice(req.headers['sec-fetch-site'], ['same-origin', 'same-site', 'cross-site', 'none'], 'MISSING_OR_INVALID') };
}

function readStatus(origin, owner, responseTimeline = false) {
  return new Promise((resolvePromise, reject) => {
    const req = request(`${origin}${responseTimeline ? '/api/pitching/response/status' : '/api/pitching/status'}`, { method: 'GET', headers: {
      Accept: 'application/json', Authorization: `Bearer ${owner}` }, timeout: 1500 }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) response.destroy(Error('STATUS_TOO_LARGE')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(Error('STATUS_UNAVAILABLE'));
        try { const value = JSON.parse(Buffer.concat(chunks)); if (value?.schemaVersion !== (responseTimeline ? 'dungeonq.pitch-response/v1' : 'dungeonq.pitch-control/v1')) throw Error(); resolvePromise(value); }
        catch { reject(Error('STATUS_UNAVAILABLE')); }
      });
    });
    req.on('timeout', () => req.destroy(Error('STATUS_UNAVAILABLE'))); req.on('error', reject); req.end();
  });
}

export async function startRecordingObserver({ directory, port = 0 } = {}) {
  const root = realpathSync(resolve(directory));
  if (!lstatSync(root).isDirectory()) throw Error('PRIVATE_RUN_DIRECTORY_REQUIRED');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('INVALID_PORT');
  const html = readFileSync(new URL('./pitching-recording-observer.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const scriptHash = createHash('sha256').update(script ?? '').digest('base64');
  let state = projectRecordingState(), timer, pending, closed = false, control = null, responseState = null, lastReadAt = null, retryAfter = 0;
  const refresh = async () => {
    const issues = [];
    const info = readPrivate(root, 'data/run-info.json', issues);
    const trajectory = parseTrajectory(readPrivate(root, 'participant/trajectory.jsonl', issues, false) ?? '');
    const budget = readPrivate(root, 'participant/budget.json', issues);
    const report = readPrivate(root, 'participant/report.json', issues);
    const afterEvidence = readPrivate(root, 'data/after-evidence.json', issues);
    const resolved = readPrivate(root, 'data/resolved-control.json', issues);
    const after = readPrivate(root, 'data/after-control.json', issues);
    if (info?.responseTracking === true && after) responseState = readPrivate(root, 'data/after-response.json', issues);
    let hostState = 'WAITING', statusSource = control ? 'LIVE' : 'NONE'; let credentials;
    if (resolved || after) { control = resolved ?? after; statusSource = resolved ? 'RESOLVED' : 'AFTER'; }
    if (info && !validRun(info)) { hostState = 'UNAVAILABLE'; issues.push('INVALID_RUN_INFO'); }
    else if (info) {
      const running = alive(info.pid);
      hostState = !running ? 'STOPPED' : afterEvidence || after || resolved ? 'STOPPING' : 'UNAVAILABLE';
      if (running && !afterEvidence && !after && !resolved) {
        credentials = readPrivate(root, 'data/credentials.json', issues);
        if (typeof credentials?.owner === 'string' && /^[A-Za-z0-9_-]{1,4096}$/.test(credentials.owner) && Date.now() >= retryAfter) {
          try {
            const reads = await Promise.all([readStatus(info.runtimeOrigin, credentials.owner),
              info.responseTracking === true ? readStatus(info.runtimeOrigin, credentials.owner, true) : null]);
            [control, responseState] = reads; lastReadAt = Date.now(); hostState = 'LIVE';
          }
          catch { retryAfter = Date.now() + 5000; issues.push('STATUS_UNAVAILABLE'); }
        } else if (Date.now() < retryAfter) issues.push('STATUS_UNAVAILABLE');
        statusSource = control ? 'LIVE' : 'NONE';
      }
    } else if (afterEvidence || after || resolved) hostState = 'STOPPED';
    state = projectRecordingState({ trajectory, budget, report, control, afterEvidence, responseState, credentials, issues,
      host: { state: hostState, statusSource, lastReadAt } });
  };
  await refresh();
  const loop = () => { timer = setTimeout(() => { pending = refresh().finally(() => { pending = null; if (!closed) loop(); }); }, 1000); };
  const server = createServer((req, res) => {
    const host = `127.0.0.1:${server.address().port}`; const origin = `http://${host}`;
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      'Cross-Origin-Resource-Policy': 'same-origin', 'Cross-Origin-Opener-Policy': 'same-origin' };
    const respond = (status, body, type = 'text/plain; charset=utf-8') => { res.writeHead(status, { ...headers, 'Content-Type': type }); res.end(body); };
    const peer = req.socket.remoteAddress;
    // A top-level navigation may originate in a browser extension. Only the static,
    // credential-free shell accepts it; state remains same-origin and unframeable.
    const shellNavigation = req.method === 'GET' && ['/actor', '/operator'].includes(req.url)
      && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
    if (peer !== '127.0.0.1' || req.headers.host !== host || req.headers.origin && req.headers.origin !== origin
      || !shellNavigation && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
      if (process.env.DUNGEONQ_OBSERVER_DIAGNOSTICS === '1') console.error(JSON.stringify(requestDiagnostics(req)));
      return respond(403, '拒絕非同來源本機請求');
    }
    if (req.method !== 'GET') return respond(405, '僅提供唯讀 GET');
    if (req.url === '/actor' || req.url === '/operator') return respond(200, html, 'text/html; charset=utf-8');
    if (req.url !== '/api/state') return respond(404, '沒有此路由');
    const body = JSON.stringify(state);
    if (Buffer.byteLength(body) > PAYLOAD_LIMIT) return respond(503, '投影資料超過顯示上限');
    respond(200, body, 'application/json; charset=utf-8');
  });
  server.requestTimeout = 3000; server.headersTimeout = 3000; server.maxRequestsPerSocket = 100;
  await new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', res); });
  loop();
  return { origin: `http://127.0.0.1:${server.address().port}`, async close() {
    if (closed) return; closed = true; clearTimeout(timer);
    await pending;
    await new Promise(res => { server.close(res); server.closeAllConnections(); });
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length < 3 || process.argv.length > 4) throw Error('USAGE');
    const observer = await startRecordingObserver({ directory: process.argv[2], port: process.argv[3] === undefined ? 0 : Number(process.argv[3]) });
    console.log(JSON.stringify({ state: 'OBSERVER_READY', actor: observer.origin + '/actor', operator: observer.origin + '/operator' }));
    const stop = () => observer.close().catch(() => { process.exitCode = 1; });
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch { console.error('觀察台無法啟動。用法：node scripts/pitching-recording-observer.mjs PRIVATE_RUN_DIR [port]'); process.exitCode = 1; }
}
