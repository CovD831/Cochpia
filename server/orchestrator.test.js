import test from 'node:test';
import assert from 'node:assert/strict';
import { runCollaborationWorkflow } from './orchestrator.js';

test('orchestrator expands collab workflow and maps stage dependencies and inputs', async () => {
  const created = [];
  const enqueued = [];
  const agentTasks = {
    async create(input, ownerId) {
      const task = { id: `task-${created.length + 1}`, ownerId, ...input };
      created.push(task);
      return task;
    }
  };
  const result = await runCollaborationWorkflow({
    workflowId: 'collab-dev', goal: 'add a health check', ownerId: 'user-a',
    agents: [], agentTasks, taskScheduler: { enqueue: task => enqueued.push(task) }
  });

  assert.deepEqual(created.map(task => task.stageId), ['plan', 'implement', 'verify', 'review']);
  assert.equal(created[0].task, '分析需求并写出实现计划：\nadd a health check');
  assert.deepEqual(created[1].dependsOn, ['task-1']);
  assert.deepEqual(created[1].inputFrom, ['task-1']);
  assert.deepEqual(created[2].dependsOn, ['task-2']);
  assert.deepEqual(created[3].dependsOn, ['task-3']);
  assert.deepEqual(created[3].inputFrom, ['task-2']);
  assert.deepEqual(enqueued.map(task => task.stageId), ['plan', 'implement', 'review']);
  assert.equal(result.tasks.length, 4);
});
