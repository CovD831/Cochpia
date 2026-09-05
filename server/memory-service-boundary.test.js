import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createMemoryServiceBoundary } from './memory-service-boundary.js';

async function runBoundary({ headers = {}, body = {}, method = 'POST', path = '/events', token = 'service-token', production = false, jwtSecret = '', issuer = '', audience = '' } = {}) {
  const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const req = {
    method,
    path,
    body,
    get(name) { return normalizedHeaders[String(name).toLowerCase()]; }
  };
  const response = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
  let nextCalled = false;
  await createMemoryServiceBoundary({ token, production, jwtSecret, issuer, audience })(req, response, () => { nextCalled = true; });
  return { req, response, nextCalled };
}

test('Memory service boundary rejects direct mutations without a service bearer token', async () => {
  const result = await runBoundary({ body: { event_id: 'event-1', content: 'content' } });
  assert.equal(result.nextCalled, false);
  assert.equal(result.response.statusCode, 403);
  assert.equal(result.response.payload.error.code, 'MEMORY_SERVICE_IDENTITY_REQUIRED');
});

test('Memory service boundary requires producer, correlation and idempotency context', async () => {
  const result = await runBoundary({ headers: { Authorization: 'Bearer service-token' }, body: { event_id: 'event-1', content: 'content' } });
  assert.equal(result.nextCalled, false);
  assert.equal(result.response.statusCode, 400);
  assert.equal(result.response.payload.error.code, 'MEMORY_WRITE_CONTEXT_REQUIRED');
});

test('Memory service boundary attaches verified service context to a valid development mutation', async () => {
  const result = await runBoundary({
    headers: {
      Authorization: 'Bearer service-token',
      'X-Memory-Producer': 'companion-core',
      'X-Correlation-Id': 'correlation-1',
      'Idempotency-Key': 'mutation-1',
      'X-Memory-Subject-User-Id': 'user-1'
    },
    body: { event_id: 'event-1', content: 'content' }
  });
  assert.equal(result.nextCalled, true);
  assert.deepEqual(result.req.memoryServiceIdentity, {
    credentialType: 'development-token',
    serviceId: 'companion-core',
    producer: 'companion-core',
    correlationId: 'correlation-1',
    idempotencyKey: 'mutation-1',
    subjectUserId: 'user-1',
    tenantId: null
  });
});

test('Memory service boundary rejects development tokens in production mode', async () => {
  const result = await runBoundary({ headers: { Authorization: 'Bearer service-token' }, production: true });
  assert.equal(result.nextCalled, false);
  assert.equal(result.response.statusCode, 403);
  assert.equal(result.response.payload.error.code, 'MEMORY_SERVICE_IDENTITY_REQUIRED');
});

test('Memory service boundary verifies production service JWT claims', async () => {
  const serviceJwtSecret = 'fixture-service-signing-key';
  const serviceJwt = await new SignJWT({ subject_user_id: 'user-1', tenant_id: 'tenant-1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('companion-core')
    .setIssuer('https://internal.example.test')
    .setAudience('cochpia-memory')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(serviceJwtSecret));
  const result = await runBoundary({
    production: true,
    jwtSecret: serviceJwtSecret,
    issuer: 'https://internal.example.test',
    audience: 'cochpia-memory',
    headers: {
      Authorization: `Bearer ${serviceJwt}`,
      'X-Memory-Producer': 'companion-core',
      'X-Correlation-Id': 'correlation-jwt',
      'Idempotency-Key': 'mutation-jwt'
    }
  });
  assert.equal(result.nextCalled, true);
  assert.equal(result.req.memoryServiceIdentity.credentialType, 'jwt');
  assert.equal(result.req.memoryServiceIdentity.subjectUserId, 'user-1');
  assert.equal(result.req.memoryServiceIdentity.tenantId, 'tenant-1');
});

test('Memory service boundary leaves read requests available to the existing auth boundary', async () => {
  const result = await runBoundary({ method: 'GET' });
  assert.equal(result.nextCalled, true);
  assert.equal(result.response.payload, null);
});

test('Memory service boundary leaves Memory retrieval commands available to the existing auth boundary', async () => {
  const result = await runBoundary({ method: 'POST', path: '/retrieve' });
  assert.equal(result.nextCalled, true);
  assert.equal(result.response.payload, null);
});
