import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScheduler } from './agent-scheduler.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('scheduler waits for dependencies and starts dependents after completion', async () => {
  const tasks = new Map();
  const started = [];
  let release;
  const first = { id: 'a', status: 'submitted', dependsOn: [] };
  const second = { id: 'b', status: 'submitted', dependsOn: ['a'] };
  tasks.set('a', first); tasks.set('b', second);
  const scheduler = createAgentScheduler({ getTask: id => tasks.get(id), maxConcurrent: 2, failTask: async () => {}, runTask: async task => { started.push(task.id); await new Promise(resolve => { release = resolve; }); task.status = 'completed'; } });
  scheduler.enqueue(second); scheduler.enqueue(first);
  await tick();
  assert.deepEqual(started, ['a']);
  release();
  await tick(); await tick();
  assert.deepEqual(started, ['a', 'b']);
});

test('scheduler cascades dependency failures and respects concurrency', async () => {
  const tasks = new Map();
  const failed = [];
  const a = { id: 'a', status: 'submitted', dependsOn: [] };
  const b = { id: 'b', status: 'submitted', dependsOn: [] };
  const child = { id: 'child', status: 'submitted', dependsOn: ['a'] };
  tasks.set('a', a); tasks.set('b', b); tasks.set('child', child);
  let active = 0; let peak = 0;
  const scheduler = createAgentScheduler({ getTask: id => tasks.get(id), maxConcurrent: 1, failTask: async (task, reason) => { task.status = 'failed'; failed.push([task.id, reason]); scheduler.notify(task); }, runTask: async task => { active += 1; peak = Math.max(peak, active); await tick(); active -= 1; task.status = task.id === 'a' ? 'failed' : 'completed'; scheduler.notify(task); } });
  scheduler.enqueue(a); scheduler.enqueue(b); scheduler.enqueue(child);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(peak, 1);
  assert.deepEqual(failed, [['child', 'dependency_failed']]);
});

test('scheduler reacts to external completion and cancellation notifications', async () => {
  const tasks = new Map();
  const failed = [];
  const started = [];
  const completedDependency = { id: 'merge-dep', status: 'reviewing', dependsOn: [] };
  const completedChild = { id: 'merge-child', status: 'submitted', dependsOn: ['merge-dep'] };
  const cancelledDependency = { id: 'cancel-dep', status: 'reviewing', dependsOn: [] };
  const cancelledChild = { id: 'cancel-child', status: 'submitted', dependsOn: ['cancel-dep'] };
  for (const task of [completedDependency, completedChild, cancelledDependency, cancelledChild]) tasks.set(task.id, task);
  const scheduler = createAgentScheduler({
    getTask: id => tasks.get(id),
    maxConcurrent: 1,
    failTask: async (task, reason) => { task.status = 'failed'; failed.push([task.id, reason]); scheduler.notify(task); },
    runTask: async task => { started.push(task.id); task.status = 'completed'; }
  });

  scheduler.enqueue(completedChild);
  completedDependency.status = 'completed';
  scheduler.notify(completedDependency);
  await tick();
  assert.deepEqual(started, ['merge-child']);

  scheduler.enqueue(cancelledChild);
  cancelledDependency.status = 'cancelled';
  scheduler.notify(cancelledDependency);
  await tick();
  assert.deepEqual(failed, [['cancel-child', 'dependency_failed']]);
});
