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
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode != null) throw new Error('Cochpia server exited before readiness: ' + output.slice(-4000));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
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

function parseSse(text) {
  return text.split('\n\n').map(block => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1] || '';
    const data = block.match(/^data:\s*(.+)$/ms)?.[1] || '';
    if (!event || !data) return null;
    return { event, data: JSON.parse(data) };
  }).filter(Boolean);
}

async function chat(base, sessionId, message) {
  const response = await fetch(`${base}/api/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message, provider: 'mock', model: 'mock' })
  });
  const events = parseSse(await response.text());
  return {
    status: response.status,
    meta: events.find(event => event.event === 'meta')?.data || null,
    text: events.filter(event => event.event === 'text').map(event => event.data.delta || '').join(''),
    done: events.find(event => event.event === 'done')?.data || null
  };
}

const port = await availablePort();
const base = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cochpia-context-assembly-'));
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
    MEMORY_TENANT_ID: 'context-assembly-acceptance'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  await waitForReady(child, port);
  const created = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'context assembly acceptance' })
  });
  assert.equal(created.status, 201);
  const session = await created.json();

  const emotional = await chat(base, session.id, '今天真的很累，创业项目一直没有进展，我有点焦虑。');
  assert.equal(emotional.status, 200);
  assert.match(emotional.text, /焦虑|消耗/);
  assert.doesNotMatch(emotional.text, /这是我们共同经历的一个新片段/);

  const advice = await chat(base, session.id, '那你觉得我现在该怎么办？');
  assert.equal(advice.status, 200);
  assert.match(advice.text, /创业项目|小步骤/);

  const sessionsAfterState = await (await fetch(`${base}/api/sessions`)).json();
  const currentSession = sessionsAfterState.find(item => item.id === session.id);
  assert.equal(currentSession.currentState.currentTopic, '创业项目');

  const explicitMemory = await chat(base, session.id, '请记住：我每周固定学习产品设计，想坚持下去。');
  assert.ok(explicitMemory.done?.memoryId);

  const recall = await chat(base, session.id, '你还记得我在学习什么吗？');
  assert.ok(Number(recall.meta?.recalled || 0) >= 1);
  assert.match(recall.text, /产品设计/);

  console.log(JSON.stringify({
    event: 'companion_core_context_assembly_acceptance_passed',
    emotionalMode: emotional.text.includes('焦虑') ? 'empathize' : 'unknown',
    adviceContinuedTopic: advice.text.includes('创业项目'),
    currentTopic: currentSession.currentState.currentTopic,
    recalled: recall.meta.recalled
  }));
} finally {
  await stop(child);
  await rm(dataDir, { recursive: true, force: true });
}
