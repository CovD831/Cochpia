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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cochpia-group-chat-'));
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
    MEMORY_TENANT_ID: 'group-chat-acceptance'
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

  const agent = await request('/api/agents', { method: 'POST', body: JSON.stringify({ name: 'Group acceptance agent' }) });
  assert.equal(agent.response.status, 201);
  const session = await request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: 'Group acceptance', kind: 'group', agentIds: [agent.body.id] })
  });
  assert.equal(session.response.status, 201);

  const success = await request('/api/chat/group', {
    method: 'POST',
    body: JSON.stringify({ sessionId: session.body.id, message: 'hello group', channel: 'acceptance' })
  });
  assert.equal(success.response.status, 200);
  assert.equal(success.body.messages.length, 1);
  assert.equal(success.body.messages[0].role, 'assistant');

  const messagesAfterSuccess = await request(`/api/sessions/${encodeURIComponent(session.body.id)}/messages`);
  assert.equal(messagesAfterSuccess.response.status, 200);
  assert.equal(messagesAfterSuccess.body.length, 2);
  const reconciliation = await request(`/api/sessions/${encodeURIComponent(session.body.id)}/reconciliation`);
  assert.equal(reconciliation.response.status, 200);
  assert.equal(reconciliation.body.missing.length, 0);
  assert.equal(reconciliation.body.conflicts.length, 0);

  const rejected = await request('/api/chat/group', {
    method: 'POST',
    body: JSON.stringify({ sessionId: session.body.id, message: 'AKIA1234567890ABCDEF', channel: 'acceptance' })
  });
  assert.equal(rejected.response.status, 422);
  assert.equal(rejected.body.error.code, 'S3_CONTENT_REJECTED');

  const messagesAfterRejected = await request(`/api/sessions/${encodeURIComponent(session.body.id)}/messages`);
  assert.equal(messagesAfterRejected.response.status, 200);
  assert.equal(messagesAfterRejected.body.length, 2);
  assert.equal(messagesAfterRejected.body.some(item => item.content.includes('AKIA')), false);

  console.log(JSON.stringify({
    event: 'companion_core_group_chat_acceptance_passed',
    successCommitted: true,
    reconciliationClean: true,
    rejectedSecretCode: rejected.body.error.code,
    rejectedMessageRolledBack: true
  }));
} finally {
  await stop(child);
  await rm(dataDir, { recursive: true, force: true });
}
