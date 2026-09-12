import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { GovernanceError, requireThat, exact, tokenHash, id } from './contracts.mjs';

// 測試用固定協議，不接受任意 URL、Cookie 身分或 Production Profile。
export async function startReferenceTransport({ issuer, tls, brokerToken, tenantId, assetId }) {
  tokenHash(brokerToken); id(tenantId); id(assetId); requireThat(tls?.key && tls?.cert, 'TLS_REQUIRED');
  let origin; let active = 0; let requests = 0; let windowEnd = Date.now() + 60000;
  const server = https.createServer({ ...tls, minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, async (request, response) => {
    let admitted = false;
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" }); response.end(JSON.stringify(value)); };
    try {
      requireThat(request.socket.remoteAddress === '127.0.0.1' && request.headers.host === new URL(origin).host, 'HOST_DENIED');
      requireThat(!request.headers.origin && !request.headers.cookie, 'BROWSER_DENIED');
      if (Date.now() >= windowEnd) { requests = 0; windowEnd = Date.now() + 60000; }
      requireThat(++requests <= 120 && active < 4, 'CAPACITY'); active++; admitted = true;
      requireThat(request.method === 'POST' && ['/rotate', '/receipt', '/acquire', '/business'].includes(request.url), 'NOT_FOUND');
      const credential = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u)?.[1];
      requireThat(credential, 'AUTH_REQUIRED');
      if (['/rotate', '/receipt'].includes(request.url)) requireThat(timingSafeEqual(Buffer.from(credential), Buffer.from(brokerToken)), 'BROKER_DENIED');
      requireThat(request.headers['content-type'] === 'application/json' && !request.headers['content-encoding'], 'CONTENT_TYPE');
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; requireThat(size <= 8192, 'BODY_TOO_LARGE'); chunks.push(chunk); }
      let body; try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new GovernanceError('JSON_INVALID'); }
      if (request.url === '/rotate') {
        requireThat(body?.body?.tenantId === tenantId && body.body.assetId === assetId, 'SCOPE_INVALID');
        send(200, issuer.rotate(body));
      } else if (request.url === '/receipt') { exact(body, ['manifestDigest']); send(200, issuer.receipt(body.manifestDigest)); }
      else if (request.url === '/acquire') { exact(body, []); send(200, { apiKey: issuer.acquire(credential, assetId) }); }
      else { exact(body, []); send(200, issuer.business({ tenantId, assetId, apiKey: credential })); }
    } catch (error) {
      if (!response.headersSent && !response.destroyed) send(error.code === 'CAPACITY' ? 429 : error instanceof GovernanceError ? 400 : 503,
        { error: error instanceof GovernanceError ? error.code : 'SERVICE_UNAVAILABLE' });
    } finally { if (admitted) active--; }
  });
  server.requestTimeout = 5000; server.headersTimeout = 3000; server.timeout = 5000; server.maxConnections = 16; server.maxRequestsPerSocket = 50;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `https://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

export function referenceClient({ origin, ca }) {
  const url = new URL(origin);
  requireThat(url.protocol === 'https:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password && ca, 'ENDPOINT_DENIED');
  return async (path, credential, body = {}) => {
    requireThat(['/rotate', '/receipt', '/acquire', '/business'].includes(path), 'NOT_FOUND'); tokenHash(credential);
    const encoded = JSON.stringify(body); requireThat(Buffer.byteLength(encoded) <= 8192, 'BODY_TOO_LARGE');
    return new Promise((resolve, reject) => {
      const request = https.request(origin + path, { method: 'POST', ca, rejectUnauthorized: true,
        headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } }, response => {
        let text = ''; response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 16384) request.destroy(new GovernanceError('RESPONSE_LIMIT')); });
        response.on('error', () => reject(new GovernanceError('TRANSPORT_UNKNOWN')));
        response.on('end', () => {
          if (response.statusCode !== 200) { reject(new GovernanceError('REMOTE_REJECTED')); return; }
          try { resolve(JSON.parse(text)); } catch { reject(new GovernanceError('RESPONSE_INVALID')); }
        });
      });
      const timer = setTimeout(() => request.destroy(new GovernanceError('TRANSPORT_UNKNOWN')), 3000);
      request.on('close', () => clearTimeout(timer)); request.on('error', () => reject(new GovernanceError('TRANSPORT_UNKNOWN'))); request.end(encoded);
    });
  };
}
