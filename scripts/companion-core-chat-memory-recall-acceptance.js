import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

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
    if (child.exitCode != null) throw new Error('Cochpia server exited before readiness: ' + output.slice(-4000));
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/api/health');
      if (response.status === 200 || response.status === 503) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for Cochpia server: ' + output.slice(-4000));
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
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
  const response = await fetch(base + pathName, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  return { response, body: response.status === 204 ? null : await response.json().catch(() => null) };
}

function parseSse(text) {
  return text.split('\n\n').map(block => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1] || '';
    const data = block.match(/^data:\s*(.+)$/ms)?.[1] || '';
    return event && data ? { event, data: JSON.parse(data) } : null;
  }).filter(Boolean);
}

async function chat(base, payload) {
  const response = await fetch(base + '/api/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, provider: 'mock', model: 'mock' })
  });
  const events = parseSse(await response.text());
  return {
    status: response.status,
    events,
    meta: events.find(event => event.event === 'meta')?.data || null,
    done: events.some(event => event.event === 'done')
  };
}

const port = await availablePort();
const base = 'http://127.0.0.1:' + port;
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cochpia-chat-memory-recall-'));
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
    MEMORY_TENANT_ID: 'chat-memory-recall-acceptance'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  await waitForReady(child, port);
  const created = await request(base, '/api/sessions', { method: 'POST', body: JSON.stringify({ title: 'chat memory recall acceptance' }) });
  assert.equal(created.response.status, 201);

  const first = await chat(base, {
    sessionId: created.body.id,
    message: '请记住：我正在准备一个创业项目，并且每周固定学习产品设计，希望以后提醒我。'
  });
  assert.equal(first.status, 200);
  assert.equal(first.done, true);

  const overview = await request(base, '/api/memory/overview');
  assert.equal(overview.response.status, 200);
  assert.ok(Number(overview.body.count) >= 1);

  const second = await chat(base, {
    sessionId: created.body.id,
    message: '创业项目 产品设计'
  });
  assert.equal(second.status, 200);
  assert.equal(second.done, true);
  assert.ok(Number(second.meta?.recalled || 0) >= 1);

  console.log(JSON.stringify({
    event: 'companion_core_chat_memory_recall_acceptance_passed',
    firstStatus: first.status,
    secondStatus: second.status,
    memoryCount: overview.body.count,
    sameSessionRecalled: second.meta.recalled
  }));
} finally {
  await stop(child);
  await rm(dataDir, { recursive: true, force: true });
}
