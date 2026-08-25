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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cochpia-chat-concurrency-'));
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
    MEMORY_TENANT_ID: 'chat-concurrency-acceptance'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  await waitForReady(child, port);
  const request = (url, options = {}) => fetch(`http://127.0.0.1:${port}${url}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });

  const created = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ title: 'concurrency acceptance' }) });
  if (!created.ok) throw new Error(`Session creation failed with ${created.status}`);
  const session = await created.json();

  const responses = await Promise.all([1, 2].map(() => request('/api/chat/stream', {
    method: 'POST',
    body: JSON.stringify({ sessionId: session.id, message: 'concurrent chat acceptance' })
  })));
  const statuses = responses.map(response => response.status).sort((left, right) => left - right);
  if (statuses.join(',') !== '200,409') throw new Error(`Expected one accepted and one rejected stream, got ${statuses.join(',')}`);
  await Promise.all(responses.map(response => response.text()));

  const messagesResponse = await request(`/api/sessions/${session.id}/messages`);
  if (!messagesResponse.ok) throw new Error(`Message read failed with ${messagesResponse.status}`);
  const messages = await messagesResponse.json();
  const roles = messages.map(message => message.role);
  if (roles.join(',') !== 'user,assistant') throw new Error(`Concurrent rejection left duplicate or partial messages: ${roles.join(',')}`);

  console.log(JSON.stringify({
    event: 'companion_core_chat_concurrency_acceptance_passed',
    port,
    statuses,
    messageCount: messages.length,
    duplicateUserWrites: false,
    existingServiceUntouched: true
  }));
} finally {
  await stop(child);
  await rm(dataDir, { recursive: true, force: true });
}
