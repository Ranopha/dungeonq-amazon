// Shared browser / Node transport. Authority and validation belong to the server.
export class RuntimeError extends Error {
  constructor(code, { status = 0, requestId, uncertain = false } = {}) {
    super(code);
    this.name = 'RuntimeError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.uncertain = uncertain;
  }
}

function originOf(value) {
  let url;
  try { url = new URL(value); } catch { throw new RuntimeError('INVALID_RUNTIME_ORIGIN'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new RuntimeError('INVALID_RUNTIME_ORIGIN');
  }
  return url.origin;
}

const operations = new Set(['snapshot', 'read', 'write', 'issue-ticket', 'use-ticket']);
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : null;
async function boundedText(response, uncertain) {
  if (!response.body) return '';
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let size = 0; let content = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 2_097_152) throw new RuntimeError('RESPONSE_TOO_LARGE', { status: response.status, uncertain });
      content += decoder.decode(next.value, { stream: true });
    }
    return content + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}

export function createRuntimeClient({ origin, token = '', timeoutMs = 10000, fetch: fetcher = globalThis.fetch } = {}) {
  const base = originOf(origin);
  if (typeof fetcher !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new RuntimeError('INVALID_CLIENT_OPTIONS');
  }
  let credential = '';
  let generation = 0;
  const pending = new Set();
  function setToken(value) {
    if (typeof value !== 'string' || value.length > 4096 || /[\s\x00-\x1f\x7f]/.test(value)) throw new RuntimeError('INVALID_TOKEN');
    generation++;
    for (const controller of pending) controller.abort();
    credential = value;
  }
  setToken(token);
  async function request(path, body, authenticated = true) {
    if (authenticated && !credential) throw new RuntimeError('AUTH_REQUIRED');
    const atGeneration = generation;
    const controller = new AbortController();
    pending.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const mutating = body !== undefined;
    try {
      const response = await fetcher(base + path, {
        method: mutating ? 'POST' : 'GET',
        headers: { Accept: 'application/json', ...(authenticated ? { Authorization: `Bearer ${credential}` } : {}),
          ...(mutating ? { 'Content-Type': 'application/json' } : {}) },
        ...(mutating ? { body: JSON.stringify(body) } : {}),
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
      });
      if (generation !== atGeneration) throw new RuntimeError('SESSION_CHANGED', { uncertain: mutating });
      const content = await boundedText(response, mutating);
      if (generation !== atGeneration) throw new RuntimeError('SESSION_CHANGED', { uncertain: mutating });
      let value;
      try { value = JSON.parse(content); } catch {
        throw new RuntimeError('INVALID_RESPONSE', { status: response.status, uncertain: mutating });
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeError('INVALID_RESPONSE', { uncertain: mutating });
      if (!response.ok) {
        const code = safeCode(value.error?.code) ?? (response.status === 401 ? 'AUTH_REQUIRED'
          : response.status === 403 ? 'PERMISSION_DENIED' : 'REQUEST_REJECTED');
        throw new RuntimeError(code, { status: response.status, uncertain: mutating && response.status >= 500,
          requestId: typeof value.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.requestId) ? value.requestId : undefined });
      }
      return value;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(generation !== atGeneration ? 'SESSION_CHANGED'
        : controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'CONNECTION_UNAVAILABLE', { uncertain: mutating });
    } finally { clearTimeout(timer); pending.delete(controller); }
  }
  return Object.freeze({
    setToken,
    disconnect() { setToken(''); },
    capabilities: () => request('/api/capabilities', undefined, false),
    status: () => request('/api/status'),
    evidence: () => request('/api/evidence'),
    preview(input) { return request('/api/policy/preview', input); },
    apply({ proposalId, digest, confirmation } = {}) {
      if (confirmation !== 'APPLY') throw new RuntimeError('EXPLICIT_CONFIRMATION_REQUIRED');
      return request('/api/policy/apply', { proposalId, digest, confirmation });
    },
    operate({ requestId, operation, args = {} } = {}) {
      if (!operations.has(operation)) throw new RuntimeError('UNSUPPORTED_OPERATION');
      return request('/api/operate', { requestId, operation, args });
    },
  });
}

// Missing or unfamiliar result states are never promoted to a successful check.
export function evidenceState(value) {
  const state = ['PASS', 'FAIL', 'INCONCLUSIVE'].includes(value?.status) ? value.status : 'INCONCLUSIVE';
  const checks = Array.isArray(value?.checks) ? value.checks : null;
  if (state === 'FAIL' || checks?.some(check => check?.status === 'FAIL')) return 'FAIL';
  if (state === 'PASS' && Object.hasOwn(value, 'checks')
    && (!checks || !checks.length || checks.some(check => check?.status !== 'PASS'))) return 'INCONCLUSIVE';
  return state;
}
