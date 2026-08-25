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

async function request(base, pathName, options = {}) {
  const response = await fetch(`${base}${pathName}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  return { response, body: await response.json().catch(() => null) };
}

const port = await availablePort();
const base = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cochpia-chat-edit-'));
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
    MEMORY_TENANT_ID: 'chat-edit-acceptance'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  await waitForReady(child, port);
  const created = await request(base, '/api/sessions', { method: 'POST', body: JSON.stringify({ title: 'chat edit acceptance' }) });
  assert.equal(created.response.status, 201);
  const sessionId = created.body.id;

  const stream = await fetch(`${base}/api/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message: '原始聊天消息', provider: 'mock', model: 'mock' })
  });
  assert.equal(stream.status, 200);
  await stream.text();

  let messages = (await request(base, `/api/sessions/${sessionId}/messages`)).body;
  const userMessage = messages.find(item => item.role === 'user');
  const assistantMessage = messages.find(item => item.role === 'assistant');
  assert.ok(userMessage);
  assert.ok(assistantMessage);

  const firstEdit = await request(base, `/api/sessions/${sessionId}/messages/${userMessage.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ content: '第一次编辑后的消息' })
  });
  assert.equal(firstEdit.response.status, 200);
  assert.equal(firstEdit.body.sourceRevision, '2');

  const secondEdit = await request(base, `/api/sessions/${sessionId}/messages/${userMessage.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ content: '第二次编辑后的消息' })
  });
  assert.equal(secondEdit.response.status, 200);
  assert.equal(secondEdit.body.sourceRevision, '3');

  const assistantEdit = await request(base, `/api/sessions/${sessionId}/messages/${assistantMessage.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ content: '编辑后的助手消息' })
  });
  assert.equal(assistantEdit.response.status, 200);
  assert.equal(assistantEdit.body.sourceRevision, '2');

  const cleanBeforeDelete = await request(base, `/api/sessions/${sessionId}/reconciliation`);
  assert.equal(cleanBeforeDelete.response.status, 200);
  assert.equal(cleanBeforeDelete.body.missing.length, 0);
  assert.equal(cleanBeforeDelete.body.conflicts.length, 0);
  assert.equal(cleanBeforeDelete.body.extra.length, 0);

  const deleted = await request(base, `/api/sessions/${sessionId}/messages/${userMessage.id}`, {
    method: 'DELETE',
    headers: { 'Idempotency-Key': 'chat-edit-delete-user-1' }
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.deleted, true);
  assert.equal(deleted.body.memoryDeletions.length, 3);

  messages = (await request(base, `/api/sessions/${sessionId}/messages`)).body;
  assert.equal(messages.some(item => item.id === userMessage.id), false);
  const cleanAfterDelete = await request(base, `/api/sessions/${sessionId}/reconciliation`);
  assert.equal(cleanAfterDelete.response.status, 200);
  assert.equal(cleanAfterDelete.body.missing.length, 0);
  assert.equal(cleanAfterDelete.body.conflicts.length, 0);
  assert.equal(cleanAfterDelete.body.extra.length, 0);

  console.log(JSON.stringify({
    event: 'companion_core_chat_edit_acceptance_passed',
    userEditRevisions: 3,
    assistantEditRevision: 2,
    reconciliationClean: true,
    allMessageRevisionsDeleted: true
  }));
} finally {
  await stop(child);
  await rm(dataDir, { recursive: true, force: true });
}
