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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cochpia-account-delete-recovery-'));
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
    MEMORY_TENANT_ID: 'account-delete-recovery-acceptance',
    COCHPIA_TEST_FAIL_ACCOUNT_DELETE_FINAL_SAVE: 'once'
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

  const created = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ title: 'Account delete recovery' }) });
  assert.equal(created.response.status, 201);
  const sessionId = created.body.id;
  const memory = await request('/api/memories', {
    method: 'POST',
    body: JSON.stringify({ summary: 'account-delete-recovery-marker', type: 'preference' })
  });
  assert.equal(memory.response.status, 201);

  const idempotencyKey = 'account-delete-recovery-1';
  const failed = await request('/api/account', {
    method: 'DELETE',
    headers: { 'Idempotency-Key': idempotencyKey }
  });
  assert.equal(failed.response.status, 503);
  assert.equal(failed.body.error.code, 'ACCOUNT_DELETE_LOCAL_PERSIST_INJECTED_FAILURE');

  const afterRecovery = await request('/api/export');
  assert.equal(afterRecovery.response.status, 200);
  assert.equal(afterRecovery.body.data.sessions.some(item => item.id === sessionId), true);
  assert.equal(afterRecovery.body.data.memoryModule.sessions.some(item => item.id === sessionId), false);
  assert.equal(afterRecovery.body.data.memoryModule.assertions.some(item => item.content === 'account-delete-recovery-marker'), false);
  assert.equal(afterRecovery.body.data.memoryModule.deletionOperations.some(item => item.targetType === 'account' && item.status === 'completed'), true);

  const retried = await request('/api/account', {
    method: 'DELETE',
    headers: { 'Idempotency-Key': idempotencyKey }
  });
  assert.equal(retried.response.status, 200);
  assert.equal(retried.body.localStateCleared, true);
  assert.equal(retried.body.manifest.status, 'completed');

  const afterDelete = await request('/api/export');
  assert.equal(afterDelete.response.status, 200);
  assert.equal(afterDelete.body.data.sessions.length, 0);
  assert.equal(afterDelete.body.data.memoryModule.assertions.length, 0);
  assert.equal(afterDelete.body.data.deletionRecords.length, 1);

  console.log(JSON.stringify({
    event: 'companion_core_account_delete_recovery_acceptance_passed',
    memoryDeletionCommittedBeforeLocalFailure: true,
    localSnapshotRestored: true,
    deletionLedgerPreserved: true,
    sameIdempotencyKeyRetryCompleted: true
  }));
} finally {
  await stop(child);
  await rm(dataDir, { recursive: true, force: true });
}
