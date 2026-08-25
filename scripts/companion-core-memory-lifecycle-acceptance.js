import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const root = process.cwd();

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForReady(child, port) {
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (child.exitCode != null) throw new Error(`Cochpia server exited before readiness: ${output.slice(-4000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200 || response.status === 503) return;
    } catch {
      // The listener is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Cochpia server: ${output.slice(-4000)}`);
}

async function stop(child) {
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const port = await availablePort();
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cochpia-memory-lifecycle-'));
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    AUTH_MODE: 'off',
    STORAGE_PROVIDER: 'json',
    MODEL_PROVIDER: 'mock',
    COCHPIA_DATA_DIR: dataDir,
    MEMORY_TENANT_ID: 'memory-lifecycle-acceptance'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  await waitForReady(child, port);
  const request = async (pathName, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
      ...options,
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    return { response, body: await response.json().catch(() => null) };
  };

  const created = await request('/api/memories', {
    method: 'POST',
    body: JSON.stringify({ content: '喜欢红茶', sensitivity: 'S0', idempotency_key: 'lifecycle-create-1' })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.status, 'active');

  const mismatch = await request(`/api/memories/${created.body.id}/pin`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'header-key' },
    body: JSON.stringify({ idempotency_key: 'body-key', resource_revision: created.body.resourceRevision })
  });
  assert.equal(mismatch.response.status, 400);
  assert.equal(mismatch.body.error.code, 'IDEMPOTENCY_KEY_CONFLICT');

  const pinned = await request(`/api/memories/${created.body.id}/pin`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'lifecycle-pin-1' },
    body: JSON.stringify({ resource_revision: created.body.resourceRevision })
  });
  const pinReplay = await request(`/api/memories/${created.body.id}/pin`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'lifecycle-pin-1' },
    body: JSON.stringify({ resource_revision: created.body.resourceRevision })
  });
  assert.equal(pinned.response.status, 200);
  assert.equal(pinReplay.response.status, 200);
  assert.equal(pinned.body.pinned, true);
  assert.equal(pinReplay.body.resourceRevision, pinned.body.resourceRevision);

  const stale = await request(`/api/memories/${created.body.id}/correct`, {
    method: 'POST',
    body: JSON.stringify({ resource_revision: created.body.resourceRevision, content: '过期修正' })
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'RESOURCE_REVISION_CONFLICT');

  const corrected = await request(`/api/memories/${created.body.id}/correct`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'lifecycle-correct-1' },
    body: JSON.stringify({ resource_revision: pinned.body.resourceRevision, content: '现在更喜欢乌龙茶' })
  });
  assert.equal(corrected.response.status, 200);
  assert.equal(corrected.body.summary, '现在更喜欢乌龙茶');

  const unpinned = await request(`/api/memories/${created.body.id}/unpin`, {
    method: 'POST',
    body: JSON.stringify({ resource_revision: corrected.body.resourceRevision, idempotency_key: 'lifecycle-unpin-1' })
  });
  assert.equal(unpinned.response.status, 200);
  assert.equal(unpinned.body.pinned, false);

  const revoked = await request(`/api/memories/${created.body.id}/revoke`, {
    method: 'POST',
    body: JSON.stringify({ resource_revision: unpinned.body.resourceRevision, idempotency_key: 'lifecycle-revoke-1' })
  });
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.body.status, 'revoked');
  assert.equal(typeof revoked.body.revokedAt, 'string');
  const hidden = await request('/api/memories');
  assert.equal(hidden.body.some(item => item.id === created.body.id), false);

  const sensitive = await request('/api/memories', {
    method: 'POST',
    body: JSON.stringify({ content: '家庭冲突记录', sensitivity: 'S2', idempotency_key: 'lifecycle-s2-1' })
  });
  assert.equal(sensitive.response.status, 201);
  assert.equal(sensitive.body.status, 'pending_confirmation');
  assert.equal(sensitive.body.summary, '家庭冲突记录');
  assert.equal(typeof sensitive.body.confirmation.id, 'string');

  const confirmations = await request('/api/confirmations');
  assert.equal(confirmations.response.status, 200);
  assert.equal(confirmations.body.items.some(item => item.id === sensitive.body.confirmation.id), true);

  const confirmed = await request(`/api/confirmations/${sensitive.body.confirmation.id}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ resource_revision: sensitive.body.confirmation.resourceRevision, idempotency_key: 'lifecycle-confirm-1' })
  });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.status, 'active');
  assert.equal(confirmed.body.summary, '家庭冲突记录');
  assert.equal((await request('/api/confirmations')).body.items.length, 0);

  const forgotten = await request(`/api/memories/${sensitive.body.id}/forget`, {
    method: 'POST',
    body: JSON.stringify({ resource_revision: confirmed.body.resourceRevision, idempotency_key: 'lifecycle-forget-1' })
  });
  assert.equal(forgotten.response.status, 200);
  assert.equal(forgotten.body.status, 'forgotten');
  assert.equal((await request('/api/memories')).body.some(item => item.id === sensitive.body.id), false);

  const deleted = await request('/api/memories', {
    method: 'POST',
    body: JSON.stringify({ content: '待删除的记忆', sensitivity: 'S0', idempotency_key: 'lifecycle-delete-create-1' })
  });
  assert.equal(deleted.response.status, 201);
  const removed = await request(`/api/memories/${deleted.body.id}`, {
    method: 'DELETE',
    body: JSON.stringify({ resource_revision: deleted.body.resourceRevision, idempotency_key: 'lifecycle-delete-1' })
  });
  assert.equal(removed.response.status, 204);
  const missing = await request(`/api/memories/${deleted.body.id}`);
  assert.equal(missing.response.status, 404);

  const legacyExport = await request('/api/memories/export');
  assert.equal(legacyExport.response.status, 200);
  assert.equal(legacyExport.body.version, 1);
  assert.equal(Array.isArray(legacyExport.body.memories), true);

  console.log(JSON.stringify({
    event: 'companion_core_memory_lifecycle_acceptance_passed',
    pinUnpin: true,
    correctionCas: true,
    revokeForgetDelete: true,
    confirmationFlow: true,
    idempotencyReplayAndConflict: true,
    legacyExport: true
  }));
} finally {
  await stop(child);
  await rm(dataDir, { recursive: true, force: true });
}
