import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
if (!databaseUrl) {
  console.log(JSON.stringify({ event: 'companion_core_chat_stream_restart_skipped', reason: 'DATABASE_URL_not_configured' }));
  process.exit(0);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer(port) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      AUTH_MODE: 'off',
      STORAGE_PROVIDER: 'postgres',
      DATABASE_URL: databaseUrl,
      DATABASE_SSL: process.env.DATABASE_SSL || 'false',
      MODEL_PROVIDER: 'mock',
      SSE_RUN_RETENTION_MS: '300000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const listening = new Promise((resolve, reject) => {
    const onExit = code => reject(new Error(`server exited before listening (${code}): ${stderr.slice(-1000)}`));
    child.once('exit', onExit);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes(`Cochpia server listening on http://localhost:${port}`)) {
        child.off('exit', onExit);
        resolve();
      }
    });
    setTimeout(() => reject(new Error(`timed out waiting for server: ${stderr.slice(-1000)}`)), 20_000).unref();
  });
  await listening;
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise(resolve => setTimeout(resolve, 5_000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function request(base, pathName, options = {}) {
  const response = await fetch(`${base}${pathName}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, body };
}

function parseSse(text) {
  return text.split('\n\n').map(block => {
    const id = block.match(/^id:\s*(.+)$/m)?.[1] || '';
    const event = block.match(/^event:\s*(.+)$/m)?.[1] || '';
    const data = block.match(/^data:\s*(.+)$/ms)?.[1] || '';
    if (!id || !event || !data) return null;
    return { id, event, data: JSON.parse(data) };
  }).filter(Boolean);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let firstServer = null;
let secondServer = null;
try {
  firstServer = await startServer(port);
  const sessionResponse = await request(base, '/api/sessions', { method: 'POST', body: JSON.stringify({ title: `stream-restart-${randomUUID()}` }) });
  assert.equal(sessionResponse.response.status, 201);
  const sessionId = sessionResponse.body.id;
  const firstStream = await fetch(`${base}/api/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message: 'stream journal restart acceptance', provider: 'mock', model: 'mock' })
  });
  assert.equal(firstStream.status, 200);
  const firstEvents = parseSse(await firstStream.text());
  const runId = firstEvents.find(event => event.event === 'meta')?.data?.runId;
  assert.ok(runId);
  assert.equal(firstEvents.some(event => event.event === 'done'), true);
  const cursor = firstEvents[0].id;
  await stopServer(firstServer);
  firstServer = null;

  secondServer = await startServer(port);
  const replayResponse = await fetch(`${base}/api/chat/stream/${encodeURIComponent(runId)}`, { headers: { 'Last-Event-ID': cursor } });
  assert.equal(replayResponse.status, 200);
  const replayEvents = parseSse(await replayResponse.text());
  assert.equal(replayEvents.length > 0, true);
  assert.equal(replayEvents.every(event => Number(event.id.split(':').at(-1)) > Number(cursor.split(':').at(-1))), true);
  assert.equal(replayEvents.some(event => event.event === 'done'), true);
  console.log(JSON.stringify({ event: 'companion_core_chat_stream_restart_acceptance_passed', runId, firstEventCount: firstEvents.length, replayEventCount: replayEvents.length, durableTerminalReplay: true }));
} finally {
  await stopServer(firstServer);
  await stopServer(secondServer);
}
