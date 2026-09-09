import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTaskService } from './agent-task.js';

test('agent task service enforces owner scope and legal lifecycle', async () => {
  const state = { agentTasks: [] };
  const service = createAgentTaskService({ state, persist: async () => {} });
  const task = await service.create({ target: 'pi', task: 'read repository', repository: 'repo', branch: 'main' }, 'user-a');
  assert.equal(service.get(task.id, 'user-b'), null);
  await service.transition(task, 'running', 'started');
  await service.transition(task, 'waiting_approval', 'needs review');
  await service.transition(task, 'running', 'approved');
  await service.transition(task, 'verifying', 'executor returned; verification started');
  await service.transition(task, 'reviewing', 'verification passed; review required');
  await service.finish(task, { summary: 'done', evidence: ['test'] });
  assert.equal(task.status, 'completed');
  await assert.rejects(() => service.transition(task, 'running'), /Illegal task transition/);
});

test('agent task service normalizes structured specs and deduplicates requests', async () => {
  const state = { agentTasks: [] };
  const service = createAgentTaskService({ state, persist: async () => {} });
  const input = {
    target: 'codex', task: 'fix mobile settings', idempotencyKey: 'mobile-settings-1',
    spec: { goal: 'Fix mobile settings overflow', acceptance: ['single row nav', 'content scrolls'], scope: ['client/src'], excludes: ['Claude unlock'], retry: 2 }
  };
  const first = await service.create(input, 'user-a');
  const duplicate = await service.create(input, 'user-a');
  assert.equal(duplicate.id, first.id);
  assert.deepEqual(first.spec.acceptance, ['single row nav', 'content scrolls']);
  assert.deepEqual(first.spec.excludes, ['Claude unlock']);
  assert.equal(first.spec.retry, 2);
  assert.equal(service.list('user-b').length, 0);
});

test('agent task service injects completed dependency summaries into executor input', async () => {
  const state = { agentTasks: [] };
  const service = createAgentTaskService({ state, persist: async () => {} });
  const upstream = await service.create({ target: 'pi', task: 'make a plan', stageId: 'plan', role: 'planner' }, 'user-a');
  await service.recordResult(upstream, { summary: 'Use a bounded queue.' });
  const downstream = await service.create({ target: 'codex', task: 'implement the plan', dependsOn: [upstream.id], stageId: 'implement', role: 'implementer', workflowId: 'collab-dev', inputFrom: upstream.id }, 'user-a');

  assert.match(service.buildInput(downstream), /implement the plan/);
  assert.match(service.buildInput(downstream), /\[plan 的输出\]/);
  assert.match(service.buildInput(downstream), /Use a bounded queue\./);
  assert.equal(downstream.workflowId, 'collab-dev');
  assert.deepEqual(downstream.inputFrom, [upstream.id]);
});

test('dependency output injection remains owner-scoped', async () => {
  const state = { agentTasks: [] };
  const service = createAgentTaskService({ state, persist: async () => {} });
  const upstream = await service.create({ target: 'pi', task: 'private plan' }, 'user-a');
  await service.recordResult(upstream, { summary: 'private output' });
  const downstream = await service.create({ target: 'codex', task: 'implement', dependsOn: [upstream.id] }, 'user-a');
  upstream.ownerId = 'user-b';
  assert.doesNotMatch(service.buildInput(downstream), /private output/);
});

test('buildInput prefers inputFrom and falls back to dependsOn', async () => {
  const state = { agentTasks: [] };
  const service = createAgentTaskService({ state, persist: async () => {} });
  const verify = await service.create({ target: 'pi', task: 'verify', stageId: 'verify' }, 'user-a');
  const implement = await service.create({ target: 'pi', task: 'implement', stageId: 'implement' }, 'user-a');
  await service.recordResult(verify, { summary: 'verification output' });
  await service.recordResult(implement, { summary: 'implementation output' });
  const review = await service.create({ target: 'claude', task: 'review', dependsOn: [verify.id], inputFrom: [implement.id] }, 'user-a');
  assert.match(service.buildInput(review), /implementation output/);
  assert.doesNotMatch(service.buildInput(review), /verification output/);
  const fallback = await service.create({ target: 'claude', task: 'fallback', dependsOn: [verify.id] }, 'user-a');
  assert.match(service.buildInput(fallback), /verification output/);
});

test('agent task service rejects unsupported targets and empty tasks', async () => {
  const service = createAgentTaskService({ state: { agentTasks: [] }, persist: async () => {} });
  await assert.rejects(() => service.create({ target: 'mcp', task: 'x' }, 'user-a'), /Unsupported Agent target/);
  await assert.rejects(() => service.create({ target: 'pi', task: ' ' }, 'user-a'), /Task text is required/);
});

test('agent task service supports review decisions without auto-completing', async () => {
  const service = createAgentTaskService({ state: { agentTasks: [] }, persist: async () => {} });
  const toReview = async title => {
    const task = await service.create({ target: 'pi', task: title }, 'user-a');
    await service.transition(task, 'running', 'started');
    await service.transition(task, 'verifying', 'verification started');
    await service.transition(task, 'reviewing', 'verification passed');
    return task;
  };

  const approved = await toReview('approve case');
  await service.transition(approved, 'completed', '审查通过');
  assert.equal(approved.status, 'completed');

  const returned = await toReview('request changes case');
  await service.transition(returned, 'verifying', '请补充测试');
  assert.equal(returned.status, 'verifying');
  assert.equal(returned.message, '请补充测试');

  const rejected = await toReview('reject case');
  await service.transition(rejected, 'failed', 'review_rejected');
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.message, 'review_rejected');
});

test('gate interrupt returns a waiting task to running without failing it', async () => {
  const state = { agentTasks: [] };
  const service = createAgentTaskService({ state, persist: async () => {} });
  const task = await service.create({ target: 'codex', task: 'apply change' }, 'user-a');
  await service.transition(task, 'running', 'started');
  await service.transition(task, 'waiting_approval', 'approval required');
  await service.appendEvent(task, 'gate_decided', { decision: 'interrupt', feedback: 'Add a regression test first.' });
  await service.transition(task, 'running', 'Add a regression test first.');
  assert.equal(task.status, 'running');
  assert.notEqual(task.status, 'failed');
  assert.equal(task.events.at(-2).type, 'gate_decided');
  assert.equal(task.events.at(-2).feedback, 'Add a regression test first.');
});
