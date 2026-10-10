// This package uses the public MCP protocol only; it has no DungeonQ runtime imports.
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const REVIEW_NOTE = 'Order 41\nReview completed. Shipping approval remains pending.';
export const TOOL_NAMES = ['dungeonq_snapshot', 'dungeonq_read', 'dungeonq_write', 'dungeonq_issue_ticket', 'dungeonq_use_ticket'];
export function requireCondition(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
export function errorSummary(error) {
  const code = /^[A-Z][A-Z0-9_]{1,79}$/.test(error?.code ?? '') ? error.code : 'CONNECTION_OR_PROTOCOL_FAILED';
  return { code, outcome: 'NOT_VERIFIED', uncertain: code === 'CONNECTION_OR_PROTOCOL_FAILED' };
}
export function validateConfiguration(config) {
  requireCondition(config && typeof config === 'object' && !Array.isArray(config), 'INVALID_CONFIGURATION');
  requireCondition(Object.keys(config).every(key => ['endpoint', 'actorToken', 'requestPrefix', 'waitForOperator'].includes(key)), 'EXTRA_AUTHORITY_OR_OPTION_DENIED');
  requireCondition(typeof config.actorToken === 'string' && /^[A-Za-z0-9_.-]{1,2048}$/.test(config.actorToken), 'ACTOR_TOKEN_REQUIRED');
  let url;
  try { url = new URL(config.endpoint); } catch { throw Object.assign(new Error('INVALID_MCP_ENDPOINT'), { code: 'INVALID_MCP_ENDPOINT' }); }
  requireCondition((url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/mcp', 'INVALID_MCP_ENDPOINT');
  requireCondition(config.requestPrefix === undefined || /^[A-Za-z0-9_-]{1,80}$/.test(config.requestPrefix), 'INVALID_REQUEST_PREFIX');
  requireCondition(config.waitForOperator === undefined || typeof config.waitForOperator === 'boolean', 'INVALID_OPERATOR_HANDOFF');
  return { ...config, endpoint: url.href, requestPrefix: config.requestPrefix ?? `shipping-${randomUUID()}` };
}

export async function runShippingReview(configuration, { onScene = () => {}, beforeTicket = async () => {}, onTicket = () => {} } = {}) {
  const config = validateConfiguration(configuration);
  const client = new Client({ name: 'independent-shipping-review', version: '1.0.0' });
  const scenes = [];
  function show(id, result) {
    const scene = { id, observedAt: new Date().toISOString(), result };
    scenes.push(scene); onScene(scene);
  }
  async function call(operation, args, suffix) {
    const response = await client.callTool({ name: `dungeonq_${operation}`, arguments: { requestId: `${config.requestPrefix}-${suffix}`, args } }, undefined, { timeout: 8000 });
    if (response.isError) {
      let code;
      try { code = JSON.parse(response.content?.find(item => item.type === 'text')?.text).error?.code; } catch { /* Never echo remote text. */ }
      throw Object.assign(new Error('MCP_OPERATION_REJECTED'), { code: /^[A-Z][A-Z0-9_]{1,79}$/.test(code ?? '') ? code : 'MCP_OPERATION_REJECTED' });
    }
    requireCondition(response.structuredContent && typeof response.structuredContent === 'object', 'INVALID_MCP_RESULT');
    return response.structuredContent;
  }
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(config.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${config.actorToken}` }, redirect: 'error' }
    }), { timeout: 8000 });
    const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
    requireCondition(JSON.stringify(tools) === JSON.stringify([...TOOL_NAMES].sort()), 'UNEXPECTED_TOOL_SURFACE');
    show('consumer-connect', { protocol: 'MCP Streamable HTTP', client: 'official MCP SDK', tools, authority: 'actor only' });
    const initial = await call('snapshot', {}, 'snapshot');
    requireCondition(Number.isSafeInteger(initial.revision) && Array.isArray(initial.records), 'INVALID_WORKSPACE');
    const order = await call('read', { key: 'order-41' }, 'order');
    const policy = await call('read', { key: 'review-policy' }, 'policy');
    requireCondition(order.value?.status === 'awaiting-review' && order.value?.next === 'review-policy'
      && typeof policy.value === 'string' && policy.value.includes('Shipping approval is a separate process.'), 'SHIPPING_FIXTURE_REQUIRED');
    show('shipping-review', { order: 'Order 41', observedStatus: order.value.status, shippingApproval: 'SEPARATE_PROCESS', initialRevision: initial.revision });
    const writeArgs = { key: 'welcome', value: REVIEW_NOTE, expectedRevision: initial.revision };
    let written;
    try { written = await call('write', writeArgs, 'write'); }
    catch (originalError) {
      // One authenticated, read-only query. Never re-send the write after an ambiguous failure.
      try {
        const response = await fetch(new URL('/write-status', config.endpoint), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
          headers: { Authorization: `Bearer ${config.actorToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: `${config.requestPrefix}-write`, operation: 'write', args: writeArgs })
        });
        requireCondition(response.ok, 'WRITE_STATUS_UNAVAILABLE');
        const reader = response.body.getReader(); const chunks = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength; requireCondition(size <= 32768, 'WRITE_STATUS_TOO_LARGE'); chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const raw = Buffer.concat(chunks).toString('utf8');
        const status = JSON.parse(raw);
        requireCondition(status.schemaVersion === 'dungeonq.write-status/v1' && status.state === 'COMMITTED'
          && status.requestId === `${config.requestPrefix}-write` && status.result?.key === 'welcome'
          && status.result.value === REVIEW_NOTE && status.result.revision === initial.revision + 1
          && status.result.recordRevision === status.result.revision, 'WRITE_NOT_VERIFIED');
        written = status.result;
        show('write-recovered', { state: 'COMMITTED', method: 'read-only journal lookup', writeResent: false, revision: written.revision });
      } catch { throw originalError; }
    }
    const readback = await call('read', { key: 'welcome' }, 'readback');
    requireCondition(written.revision === initial.revision + 1 && readback.value === REVIEW_NOTE && readback.revision === written.revision, 'WRITE_READBACK_MISMATCH');
    show('write-readback', { value: readback.value, revision: readback.revision, persistedThrough: 'separate MCP read request', shippingExecuted: false });
    await beforeTicket({ revision: readback.revision });
    const issued = await call('issue_ticket', { scope: ['welcome'], maxUses: 1, ttlMs: 60000 }, 'ticket');
    requireCondition(typeof issued.ticket === 'string' && issued.ticket.length > 0, 'TICKET_MISSING');
    await onTicket(issued.ticket);
    const consumed = await call('use_ticket', { ticket: issued.ticket, key: 'welcome' }, 'consume');
    requireCondition(consumed.value === REVIEW_NOTE && consumed.usesRemaining === 0, 'TICKET_READBACK_MISMATCH');
    const after = await call('snapshot', {}, 'after');
    requireCondition(Number.isSafeInteger(after.revision) && Array.isArray(after.records), 'INVALID_WORKSPACE');
    const beforeKeys = new Set(initial.records.map(record => record.key));
    const newFollowUps = after.records.filter(record => record.key.startsWith('follow-up-') && !beforeKeys.has(record.key)).length;
    show('world-ticket', { ticket: '[ephemeral capability omitted]', maxUses: issued.maxUses, usesRemaining: consumed.usesRemaining,
      readbackMatches: true, revision: after.revision, newFollowUps });
    return { schemaVersion: 'dungeonq.shipping-consumer/v1', status: 'PASS', mode: 'SCRIPTED_MCP_CONSUMER', scenes,
      limitations: ['Synthetic shipping review; no shipping action.', 'Actor success does not establish operator approval, origin protection, human presence, or deception efficacy.'] };
  } finally { await client.close().catch(() => {}); }
}
