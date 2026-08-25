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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cochpia-music-outbox-'));
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
    MEMORY_TENANT_ID: 'music-outbox-acceptance'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let locked = false;
try {
  await waitForReady(child, port);
  const request = async (pathName, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
      ...options,
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    return { response, body: await response.json().catch(() => null) };
  };

  const idempotencyKey = 'music-outbox-persist-retry-1';
  await chmod(stateFile, 0o400);
  locked = true;
  const failed = await request('/api/music/play', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ track: { id: 'music-persist-track', title: 'Persistence Retry Track' } })
  });
  assert.equal(failed.response.status, 503);
  assert.equal(failed.body.error.code, 'MUSIC_INTERACTION_OUTBOX_PERSIST_FAILED');

  await chmod(stateFile, 0o600);
  locked = false;
  const retry = await request('/api/music/play', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ track: { id: 'music-persist-track', title: 'Persistence Retry Track' } })
  });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.interactionEvent.status, 'completed');
  assert.ok(retry.body.interactionEvent.rawEventId);

  const exported = await request('/api/export');
  assert.equal(exported.response.status, 200);
  const expectedOutboxKey = `music:local-user:play:${idempotencyKey}`;
  const matching = exported.body.data.companion.interactionOutbox.filter(item => item.idempotencyKey === expectedOutboxKey);
  assert.equal(matching.length, 1);
  assert.equal(matching[0].status, 'completed');

  console.log(JSON.stringify({
    event: 'companion_core_music_outbox_acceptance_passed',
    persistenceFailureFailsClosed: true,
    retryCompleted: true,
    deduplicatedEntry: true
  }));
} finally {
  if (locked) await chmod(stateFile, 0o600).catch(() => {});
  await stop(child);
  await rm(dataDir, { recursive: true, force: true });
}
