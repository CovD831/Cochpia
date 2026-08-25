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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cochpia-life-outbox-'));
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
    MEMORY_TENANT_ID: 'life-outbox-acceptance'
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

  const idempotencyKey = 'life-outbox-acceptance-1';
  const first = await request('/api/life/actions', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ actionId: 'walk', expectedRevision: 1, idempotencyKey })
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.state.day, 2);
  assert.equal(first.body.event.status, 'accepted_stored');
  assert.ok(first.body.event.rawEventId);

  const concurrentRevision = first.body.state.resourceRevision;
  const devices = [
    { actionId: 'home', key: 'life-outbox-device-a' },
    { actionId: 'cafe', key: 'life-outbox-device-b' }
  ];
  const concurrent = await Promise.all(devices.map(device => request('/api/life/actions', {
    method: 'POST',
    headers: { 'Idempotency-Key': device.key },
    body: JSON.stringify({ actionId: device.actionId, expectedRevision: concurrentRevision, idempotencyKey: device.key })
  })));
  assert.deepEqual(concurrent.map(item => item.response.status).sort((left, right) => left - right), [200, 409]);
  const loser = devices[concurrent.findIndex(item => item.response.status === 409)];
  const winner = concurrent.find(item => item.response.status === 200);
  assert.equal(concurrent.find(item => item.response.status === 409).body.error.code, 'LIFE_STATE_REVISION_CONFLICT');
  assert.equal(winner.body.event.status, 'accepted_stored');
  const afterConflict = await request('/api/life/state');
  assert.equal(afterConflict.response.status, 200);
  assert.equal(afterConflict.body.state.resourceRevision, concurrentRevision + 1);
  const retried = await request('/api/life/actions', {
    method: 'POST',
    headers: { 'Idempotency-Key': loser.key },
    body: JSON.stringify({ actionId: loser.actionId, expectedRevision: afterConflict.body.state.resourceRevision, idempotencyKey: loser.key })
  });
  assert.equal(retried.response.status, 200);
  assert.equal(retried.body.event.status, 'accepted_stored');
  assert.equal(retried.body.duplicate, false);

  const state = await request('/api/life/state');
  assert.equal(state.response.status, 200);
  const command = state.body.state.commandLog.find(item => item.idempotencyKey === idempotencyKey);
  assert.equal(command.eventStatus, 'accepted_stored');
  assert.equal(command.rawEventId, first.body.event.rawEventId);

  const replay = await request('/api/life/actions', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ actionId: 'walk', expectedRevision: 1, idempotencyKey })
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.event.rawEventId, first.body.event.rawEventId);
  assert.equal(replay.body.state.day, first.body.state.day + 2);
  assert.equal(replay.body.state.resourceRevision, first.body.state.resourceRevision + 2);

  const task = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'outbox task acceptance' }) });
  assert.equal(task.response.status, 201);
  const calendar = await request('/api/events', {
    method: 'POST',
    body: JSON.stringify({ title: 'outbox calendar acceptance', type: 'plan', date: '2026-08-30T10:00:00.000Z' })
  });
  assert.equal(calendar.response.status, 201);
  const musicFirst = await request('/api/music/play', { method: 'POST', body: JSON.stringify({ track: { id: 'acceptance-track-1', title: 'Acceptance Track' } }) });
  const musicSecond = await request('/api/music/play', { method: 'POST', body: JSON.stringify({ track: { id: 'acceptance-track-2', title: 'Acceptance Track 2' } }) });
  assert.equal(musicFirst.response.status, 200);
  assert.equal(musicSecond.response.status, 200);
  assert.equal(musicFirst.body.interactionEvent.status, 'completed');
  assert.equal(musicSecond.body.interactionEvent.status, 'completed');
  await request(`/api/tasks/${encodeURIComponent(task.body.id)}`, { method: 'PATCH', body: JSON.stringify({ title: 'outbox task acceptance 1' }) });
  await request(`/api/tasks/${encodeURIComponent(task.body.id)}`, { method: 'PATCH', body: JSON.stringify({ title: 'outbox task acceptance 2' }) });
  const exported = await request('/api/export');
  assert.equal(exported.response.status, 200);
  const outbox = exported.body.data.companion.interactionOutbox;
  const taskEntry = outbox.find(item => item.eventInput?.event_type === 'task.created' && item.eventInput?.structured_data?.task_id === task.body.id);
  const calendarEntry = outbox.find(item => item.eventInput?.event_type === 'calendar.event.created' && item.eventInput?.structured_data?.calendar_event_id === calendar.body.id);
  assert.equal(taskEntry?.status, 'completed');
  assert.ok(taskEntry?.rawEventId);
  assert.equal(calendarEntry?.status, 'completed');
  assert.ok(calendarEntry?.rawEventId);
  const taskUpdates = outbox.filter(item => item.eventInput?.event_type === 'task.updated' && item.eventInput?.structured_data?.task_id === task.body.id);
  assert.equal(taskUpdates.length, 2);
  assert.equal(new Set(taskUpdates.map(item => item.eventInput.event_id)).size, 2);
  const musicEvents = outbox.filter(item => item.eventInput?.event_type === 'music.playback.changed');
  assert.equal(musicEvents.length, 2);
  assert.equal(new Set(musicEvents.map(item => item.eventInput.event_id)).size, 2);

  console.log(JSON.stringify({
    event: 'companion_core_life_outbox_acceptance_passed',
    status: first.body.event.status,
    rawEventIdPresent: true,
    idempotentReplay: true,
    crossDeviceCasConflictAndRetry: true,
    commandStatus: command.eventStatus,
    taskOutboxCompleted: true,
    calendarOutboxCompleted: true,
    rapidTaskUpdatesDistinct: true,
    rapidMusicCommandsDistinct: true
  }));
} finally {
  await stop(child);
  await rm(dataDir, { recursive: true, force: true });
}
