import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { resolveDbSsl } from '../server/db-ssl.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log(JSON.stringify({ event: 'companion_core_auth_acceptance_skipped', reason: 'DATABASE_URL_not_configured' }));
  process.exit(0);
}

const { Pool } = pg;
const { hostname } = new URL(databaseUrl);
const ssl = resolveDbSsl();
const requireTls = process.env.COMPANION_CORE_AUTH_REQUIRE_TLS === 'true';
if (requireTls) assert.equal(ssl?.rejectUnauthorized, true, 'DATABASE_SSL=true/verify-full is required for this gate');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

async function tokenFor(userId, secret, issuer) {
  return new SignJWT({ email: `${userId}@acceptance.invalid` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(`${issuer}/auth/v1`)
    .setAudience('authenticated')
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(secret));
}

async function request(baseUrl, url, { token, method = 'GET', body, idempotencyKey } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(`${baseUrl}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

function assertStatus(response, expected, label) {
  const detail = response.payload?.event?.errorCode || response.payload?.error?.code || response.payload?.error || '';
  assert.equal(response.status, expected, `${label}: expected ${expected}, got ${response.status}${detail ? ` (${detail})` : ''}`);
  return response.payload;
}

const port = await freePort();
const issuer = `https://companion-core-${randomUUID()}.invalid`;
const jwtSecret = `companion-core-acceptance-${randomUUID()}`;
const serviceToken = `internal-${randomUUID()}`;
const userA = randomUUID();
const userB = randomUUID();
const tokenA = await tokenFor(userA, jwtSecret, issuer);
const tokenB = await tokenFor(userB, jwtSecret, issuer);
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    AUTH_MODE: 'required',
    STORAGE_PROVIDER: 'postgres',
    SUPABASE_URL: issuer,
    SUPABASE_JWT_SECRET: jwtSecret,
    MEMORY_INTERNAL_SERVICE_TOKEN: serviceToken,
    MODEL_PROVIDER: 'mock',
    DATABASE_SSL: process.env.DATABASE_SSL || ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
server.stdout.on('data', chunk => { stdout += String(chunk); });
server.stderr.on('data', chunk => { stderr += String(chunk); });
const started = new Promise((resolve, reject) => {
  const onExit = code => reject(new Error(`server exited before listening (${code})`));
  server.once('exit', onExit);
  server.stdout.on('data', chunk => {
    if (String(chunk).includes(`Cochpia server listening on http://localhost:${port}`)) {
      server.off('exit', onExit);
      resolve();
    }
  });
  setTimeout(() => reject(new Error('timed out waiting for server')), 20_000).unref();
});

const pool = new Pool({
  connectionString: databaseUrl,
  ssl,
  max: 4,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
  query_timeout: 15_000
});
let stage = 'startup';
let expectedSessionBId = null;
let observedSessionBIds = [];
let observedMemoryBMarker = false;

try {
  await started;
  const baseUrl = `http://127.0.0.1:${port}`;
  stage = 'auth-and-ready';
  assertStatus(await request(baseUrl, '/api/sessions'), 401, 'missing auth');
  assert.equal((await request(baseUrl, '/api/ready')).status, 200, 'ready endpoint');

  stage = 'user-a-create-and-write';
  const sessionA = assertStatus(await request(baseUrl, '/api/sessions', {
    token: tokenA,
    method: 'POST',
    body: { title: 'user A session' }
  }), 201, 'create user A session');
  const lifeKey = `acceptance-life-${randomUUID()}`;
  const lifeA = assertStatus(await request(baseUrl, '/api/life/actions', {
    token: tokenA,
    method: 'POST',
    body: { actionId: 'walk', expectedRevision: 1, idempotencyKey: lifeKey },
    idempotencyKey: lifeKey
  }), 200, 'user A life action');
  assert.equal(lifeA.state.day, 2, 'user A life day');

  const concurrentLifeRevision = lifeA.state.resourceRevision;
  const concurrentResults = await Promise.all([
    request(baseUrl, '/api/life/actions', {
      token: tokenA,
      method: 'POST',
      body: { actionId: 'home', expectedRevision: concurrentLifeRevision, idempotencyKey: `acceptance-concurrent-home-${randomUUID()}` }
    }),
    request(baseUrl, '/api/life/actions', {
      token: tokenA,
      method: 'POST',
      body: { actionId: 'cafe', expectedRevision: concurrentLifeRevision, idempotencyKey: `acceptance-concurrent-cafe-${randomUUID()}` }
    })
  ]);
  const concurrentStatuses = concurrentResults.map(item => item.status).sort((left, right) => left - right);
  assert.deepEqual(concurrentStatuses, [200, 409], 'same-user CAS conflict is explicit');

  const memoryA = assertStatus(await request(baseUrl, '/api/memories', {
    token: tokenA,
    method: 'POST',
    body: { summary: `user-a-only-${userA}`, type: 'preference' }
  }), 201, 'user A memory');
  assert.ok(memoryA.id || memoryA.metadata?.memoryId, 'user A memory id');
  const lifeContextA = assertStatus(await request(baseUrl, `/api/life/context?sessionId=${encodeURIComponent(sessionA.id)}`, { token: tokenA }), 200, 'user A life context');
  assert.equal(lifeContextA.context.identity.userId, userA, 'life context derives the authenticated subject');
  assert.equal(lifeContextA.context.boundaries.memoryPurpose, 'profile_view', 'life context declares the memory policy purpose');
  assert.equal(lifeContextA.context.memoryBundle.policyResult, 'allowed', 'life context returns a policy-filtered memory bundle');
  assert.equal(JSON.stringify(lifeContextA.context.memoryBundle).includes('sourceRefs'), false, 'life context does not expose raw memory provenance to the client');

  stage = 'cross-user-read-isolation';
  const sessionsB = assertStatus(await request(baseUrl, '/api/sessions', { token: tokenB }), 200, 'user B sessions');
  assert.equal(sessionsB.some(item => item.id === sessionA.id), false, 'session isolation');
  const lifeB = assertStatus(await request(baseUrl, '/api/life/state', { token: tokenB }), 200, 'user B life state');
  assert.equal(lifeB.state.day, 1, 'life state isolation');
  const memoriesB = assertStatus(await request(baseUrl, '/api/memories', { token: tokenB }), 200, 'user B memories');
  assert.equal(memoriesB.some(item => String(item.summary || '').includes(`user-a-only-${userA}`)), false, 'memory isolation');

  const exportA = assertStatus(await request(baseUrl, '/api/export', { token: tokenA }), 200, 'user A export');
  assert.equal(exportA.kind, 'cochpia.product.export', 'product export kind');
  assert.equal(exportA.consistency.complete, true, 'product export is complete');
  assert.equal(exportA.data.sessions.some(item => item.id === sessionA.id), true, 'export includes user A session');
  assert.equal(exportA.data.lifeState.day, 3, 'export includes LifeState');
  assert.equal(typeof exportA.data.relationshipStates, 'object', 'relationship export shape');
  assert.equal(exportA.data.evidence.some(item => item.type === 'life_event' && item.sourceEventId), true, 'life event creates sourced growth evidence');
  assert.equal(exportA.data.relationshipStates.cochpia?.sourceEventIds?.length > 0, true, 'life event relationship provenance');

  stage = 'product-export-operation';
  const productExportKey = `acceptance-product-export-${randomUUID()}`;
  const productExport = assertStatus(await request(baseUrl, '/api/export-operations', {
    token: tokenA,
    method: 'POST',
    idempotencyKey: productExportKey,
    body: {}
  }), 201, 'create product export operation');
  assert.equal(productExport.operation.status, 'ready', 'product export operation ready');
  const productExportStatus = assertStatus(await request(baseUrl, `/api/export-operations/${productExport.operation.id}`, { token: tokenA }), 200, 'product export operation status');
  assert.equal(productExportStatus.status, 'ready', 'product export status ready');
  const productExportData = assertStatus(await request(baseUrl, `/api/export-operations/${productExport.operation.id}/data`, { token: tokenA }), 200, 'download product export operation');
  assert.equal(productExportData.kind, 'cochpia.product.export', 'downloaded product export kind');
  assert.equal(productExportData.consistency.complete, true, 'downloaded product export is complete');

  stage = 'game-event-governance';
  assert.ok(lifeA.event?.rawEventId, 'life action has a raw event provenance id');
  const forgottenLifeEvent = assertStatus(await request(baseUrl, `/api/life/events/${lifeA.event.rawEventId}/forget`, {
    token: tokenA,
    method: 'POST',
    idempotencyKey: `acceptance-life-forget-${userA}`
  }), 200, 'forget game event');
  assert.equal(forgottenLifeEvent.forgotten, true, 'game event forgotten');
  assert.equal(forgottenLifeEvent.operation?.status, 'completed', 'forget governance operation completed');
  assert.equal(forgottenLifeEvent.reconciliation?.complete, true, 'forget governance reconciliation completed');
  assert.equal(Array.isArray(forgottenLifeEvent.projections.projection.removedEvidenceIds), true, 'game projection redaction report');
  const exportAfterLifeForget = assertStatus(await request(baseUrl, '/api/export', { token: tokenA }), 200, 'export after game event forget');
  assert.equal(exportAfterLifeForget.data.evidence.some(item => item.sourceEventId === lifeA.event.rawEventId), false, 'forgotten game evidence is not exported as a live projection');

  const deletedLifeEvent = assertStatus(await request(baseUrl, `/api/life/events/${lifeA.event.rawEventId}`, {
    token: tokenA,
    method: 'DELETE',
    idempotencyKey: `acceptance-life-delete-${userA}`
  }), 200, 'delete game event');
  assert.equal(deletedLifeEvent.deleted, true, 'game event deleted');
  assert.equal(deletedLifeEvent.operation?.status, 'completed', 'delete governance operation completed');
  assert.equal(deletedLifeEvent.reconciliation?.complete, true, 'delete governance reconciliation completed');
  const repeatedLifeDelete = assertStatus(await request(baseUrl, `/api/life/events/${lifeA.event.rawEventId}`, {
    token: tokenA,
    method: 'DELETE',
    idempotencyKey: `acceptance-life-delete-retry-${userA}`
  }), 200, 'repeat deleted game event');
  assert.equal(repeatedLifeDelete.operation?.status, 'completed', 'repeat delete uses the governance ledger');
  const lifeGovernanceStatus = assertStatus(await request(baseUrl, `/api/life/events/${lifeA.event.rawEventId}/governance`, { token: tokenA }), 200, 'game governance status');
  assert.equal(lifeGovernanceStatus.reconciliation?.complete, true, 'game governance status reconciles after physical delete');

  stage = 'session-delete-propagation';
  const messageDeleteProbe = assertStatus(await request(baseUrl, `/api/sessions/${sessionA.id}/messages/missing`, { token: tokenA, method: 'DELETE' }), 404, 'missing message deletion');
  assert.equal(messageDeleteProbe.error.code, 'MESSAGE_NOT_FOUND', 'missing message error');

  const sessionDeletion = assertStatus(await request(baseUrl, `/api/sessions/${sessionA.id}`, {
    token: tokenA,
    method: 'DELETE',
    idempotencyKey: `acceptance-session-delete-${randomUUID()}`
  }), 200, 'session deletion');
  assert.equal(sessionDeletion.deleted, true, 'session deletion flag');
  assert.equal(sessionDeletion.memoryDeletion?.status, 'completed', 'session memory deletion');
  assertStatus(await request(baseUrl, `/api/sessions/${sessionA.id}`, { token: tokenA }), 404, 'deleted app session');

  stage = 'user-b-seed';
  const sessionB = assertStatus(await request(baseUrl, '/api/sessions', {
    token: tokenB,
    method: 'POST',
    body: { title: 'user B session' }
  }), 201, 'create user B session');
  expectedSessionBId = sessionB.id;
  assert.ok(sessionB.id, 'user B session id');
  const lifeContextB = assertStatus(await request(baseUrl, `/api/life/context?sessionId=${encodeURIComponent(sessionB.id)}`, { token: tokenB }), 200, 'user B life context');
  assert.equal(lifeContextB.context.identity.userId, userB, 'user B life context subject isolation');
  assert.equal(JSON.stringify(lifeContextB.context).includes(`user-a-only-${userA}`), false, 'user B life context does not expose user A memory');
  const memoryB = assertStatus(await request(baseUrl, '/api/memories', {
    token: tokenB,
    method: 'POST',
    body: { summary: `user-b-only-${userB}`, type: 'preference' }
  }), 201, 'user B memory');
  assert.ok(memoryB.id || memoryB.metadata?.memoryId, 'user B memory id');
  const exportBBeforeDelete = assertStatus(await request(baseUrl, '/api/export', { token: tokenB }), 200, 'user B export before A deletion');
  assert.equal((exportBBeforeDelete.data.memoryModule?.assertions || []).length > 0, true, 'user B memory persisted before A deletion');

  stage = 'account-delete-propagation';
  const accountDeletion = assertStatus(await request(baseUrl, '/api/account', {
    token: tokenA,
    method: 'DELETE',
    idempotencyKey: `acceptance-account-delete-${userA}`
  }), 200, 'user A account deletion');
  stage = 'account-delete-response';
  assert.equal(accountDeletion.localStateCleared, true, 'account local state cleared');
  assert.equal(accountDeletion.manifest?.status, 'completed', 'product deletion manifest completed');
  stage = 'account-delete-sessions';
  assert.deepEqual(assertStatus(await request(baseUrl, '/api/sessions', { token: tokenA }), 200, 'user A sessions after account deletion'), []);
  stage = 'account-delete-memories';
  assert.deepEqual(assertStatus(await request(baseUrl, '/api/memories', { token: tokenA }), 200, 'user A memories after account deletion'), []);
  stage = 'account-delete-export';
  const exportAfterDelete = assertStatus(await request(baseUrl, '/api/export', { token: tokenA }), 200, 'user A export after deletion');
  assert.equal(exportAfterDelete.data.sessions.length, 0, 'empty export after account deletion');
  assert.equal(exportAfterDelete.data.memoryModule.assertions.length, 0, 'empty memory export after account deletion');
  stage = 'account-delete-user-b';
  stage = 'account-delete-user-b-session';
  const sessionsBAfterDelete = assertStatus(await request(baseUrl, '/api/sessions', { token: tokenB }), 200, 'user B data after A deletion');
  observedSessionBIds = sessionsBAfterDelete.map(item => item.id);
  assert.equal(sessionsBAfterDelete.some(item => item.id === sessionB.id), true, 'user B session survives A deletion');
  stage = 'account-delete-user-b-memory';
  const memoriesBAfterDelete = assertStatus(await request(baseUrl, '/api/memories', { token: tokenB }), 200, 'user B memory after A deletion');
  observedMemoryBMarker = memoriesBAfterDelete.some(item => String(item.summary || '').includes(`user-b-only-${userB}`));
  assert.equal(observedMemoryBMarker, true, 'user B memory survives A deletion');

  console.log(JSON.stringify({
    event: 'companion_core_auth_acceptance_passed',
    authMode: 'required',
    storageProvider: 'postgres',
    subjectIsolation: true,
    lifeStateIsolation: true,
    sameUserCasConflict: true,
    memoryIsolation: true,
    exportIncludesDerivedState: true,
    gameEventProvenance: true,
    productExportOperation: true,
    gameEventGovernance: true,
    sessionDeletePropagation: true,
    accountDeletePropagation: true,
    productDeletionManifest: true,
    tlsVerified: ssl?.rejectUnauthorized === true,
    databaseHost: hostname
  }));
} catch (error) {
  console.error(JSON.stringify({ event: 'companion_core_auth_acceptance_failed', stage, code: error.code || 'COMPANION_CORE_AUTH_ACCEPTANCE_FAILED', message: error.message }));
  const diagnostic = await pool.query("SELECT user_id, jsonb_array_length(COALESCE(state->'sessions', '[]'::jsonb)) AS sessions, jsonb_path_query_array(COALESCE(state, '{}'::jsonb), '$.sessions[*].id') AS session_ids, jsonb_array_length(COALESCE(state->'evidence', '[]'::jsonb)) AS evidence, jsonb_array_length(COALESCE(state->'memoryModule'->'assertions', '[]'::jsonb)) AS assertions, jsonb_path_query_array(COALESCE(state, '{}'::jsonb), '$.memoryModule.assertions[*].id') AS assertion_ids FROM cochpia_user_states WHERE user_id = ANY($1::text[])", [[userA, userB]]).catch(() => ({ rows: [] }));
  console.error(JSON.stringify({ event: 'companion_core_state_diagnostic', expectedSessionB: expectedSessionBId, observedSessionBIds, observedMemoryBMarker, rows: diagnostic.rows }));
  if (stderr) console.error(JSON.stringify({ event: 'companion_core_server_stderr', lines: stderr.split('\n').filter(Boolean).slice(-8).map(line => line.replace(/(token|secret|authorization)[^\n]*/gi, '$1=<redacted>')) }));
  process.exitCode = 1;
} finally {
  if (server.exitCode === null && !server.killed) {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
  }
  await pool.query('DELETE FROM cochpia_user_states WHERE user_id = ANY($1::text[])', [[userA, userB]]).catch(() => {});
  await pool.end();
}
