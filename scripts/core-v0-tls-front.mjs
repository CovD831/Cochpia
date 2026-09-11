// Promotion TLS evidence: TLS terminator in front of the acceptance host.
//
// Topology for the R-020 promotion TLS run (boss decision: two machines on one
// phone hotspot):
//
//   machine B (client) --HTTPS--> machine A (this script) --HTTP loopback--> acceptance host
//
// This mirrors the production shape (TLS terminated at the edge, app traffic
// plain inside the box) without touching server/index.js. Streaming is piped
// byte-for-byte in both directions so SSE (the legacy A-12 leg) is not
// buffered. Certs are a self-signed CA under .certs/ (gitignored); clients
// must trust that CA via NODE_EXTRA_CA_CERTS -- validation is never disabled.
import { request as httpRequest } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const certDir = path.join(repoRoot, '.certs');
const listenPort = Number(process.env.TLS_FRONT_PORT || 8443);
const upstreamPort = Number(process.env.TLS_FRONT_UPSTREAM_PORT || 8788);

// Edge token gate (promotion auth posture): the front sees the REAL client
// address -- behind it every connection is loopback, so the app-level
// loopback rule cannot distinguish remote callers in this topology. With
// COCHPIA_API_TOKEN set, loopback stays open for the local UI and every
// off-box request must present the shared token.
const edgeToken = process.env.COCHPIA_API_TOKEN || '';
const serviceToken = process.env.MEMORY_SERVICE_TOKEN || '';
const sameSecret = (a, b) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
// Two credential domains live in this system: the user-facing API token and
// the internal Memory service token. The edge accepts either -- the service
// token is itself a high-privilege credential, and it is still fully verified
// by the /v1 boundary behind the gate.
const edgeAccepts = token =>
  (edgeToken && sameSecret(token, edgeToken)) || (serviceToken && sameSecret(token, serviceToken));

const server = createHttps({
  key: readFileSync(path.join(certDir, 'server.key')),
  cert: readFileSync(path.join(certDir, 'server.pem'))
}, (clientReq, clientRes) => {
  if (edgeToken) {
    const address = String(clientReq.socket?.remoteAddress || '');
    const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    const header = clientReq.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!loopback && (!token || !edgeAccepts(token))) {
      clientRes.writeHead(401, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'Authentication is required' } }));
      return;
    }
  }
  const upstream = httpRequest({
    hostname: '127.0.0.1',
    port: upstreamPort,
    path: clientReq.url,
    method: clientReq.method,
    headers: clientReq.headers
  }, upstreamRes => {
    clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(clientRes);
  });
  upstream.on('error', error => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { code: 'TLS_FRONT_UPSTREAM_ERROR', message: String(error.message) } }));
    } else {
      clientRes.destroy();
    }
  });
  clientReq.pipe(upstream);
});

// SSE: a response may stay open well past Node's default 300s requestTimeout.
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 65_000;

server.listen(listenPort, '0.0.0.0', () => {
  process.stdout.write(`TLS_FRONT_READY https://0.0.0.0:${listenPort} -> http://127.0.0.1:${upstreamPort}\n`);
});
