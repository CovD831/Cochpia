import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cochpia-session-delete-'));
const stateFile = path.join(dataDir, 'state.json');
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    AUTH_MODE: 'off',
    STORAGE_PROVIDER: 'json',
    MODEL_PROVIDER: 'mock',
    COCHPIA_DATA_DIR: dataDir,
    MEMORY_TENANT_ID: 'session-delete-acceptance'
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

  const created = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ title: 'Delete acceptance' }) });
  assert.equal(created.response.status, 201);
  const sessionId = created.body.id;

  await chmod(stateFile, 0o400);
  const failed = await request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  assert.equal(failed.response.status, 503);
  await chmod(stateFile, 0o600);

  const afterFailed = await request('/api/export');
  assert.equal(afterFailed.response.status, 200);
  assert.equal(afterFailed.body.data.sessions.some(item => item.id === sessionId), true);
  assert.equal(afterFailed.body.data.memoryModule.sessions.some(item => item.id === sessionId), true);

  const deleted = await request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.deleted, true);

  const afterDelete = await request('/api/export');
  assert.equal(afterDelete.response.status, 200);
  assert.equal(afterDelete.body.data.sessions.some(item => item.id === sessionId), false);
  assert.equal(afterDelete.body.data.memoryModule.sessions.some(item => item.id === sessionId), false);

  console.log(JSON.stringify({
    event: 'companion_core_session_delete_acceptance_passed',
    persistenceFailurePreservedBothOwners: true,
    deleteCompletedAcrossApplicationAndMemory: true
  }));
} finally {
  await chmod(stateFile, 0o600).catch(() => {});
  await stop(child);
  await rm(dataDir, { recursive: true, force: true });
}
