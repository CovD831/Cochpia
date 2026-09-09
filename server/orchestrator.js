import { resolveRole } from './roles.js';
import { loadWorkflowSpec } from './workflows.js';

const clean = value => String(value ?? '').trim();
const asList = value => Array.isArray(value) ? value : value ? [value] : [];

export async function runCollaborationWorkflow({ workflowId, goal, ownerId, agents, agentTasks, taskScheduler }) {
  const spec = loadWorkflowSpec(workflowId);
  const stageTaskIds = new Map();
  const tasks = [];
  const owner = clean(ownerId) || 'local-user';
  const workflowGoal = clean(goal);
  if (!workflowGoal) throw Object.assign(new Error('Workflow goal is required'), { code: 'WORKFLOW_GOAL_REQUIRED' });

  for (const stage of spec.stages) {
    const role = resolveRole(stage.role);
    if (!role) throw Object.assign(new Error(`Unknown workflow role: ${stage.role}`), { code: 'WORKFLOW_ROLE_INVALID' });
    const dependsOn = asList(stage.dependsOn).map(stageId => stageTaskIds.get(clean(stageId))).filter(Boolean);
    const inputFrom = asList(stage.inputFrom).map(stageId => stageTaskIds.get(clean(stageId))).filter(Boolean);
    const task = await agentTasks.create({
      target: role.executor === 'builtin' ? 'codex' : role.executor,
      task: clean(stage.prompt).replaceAll('{goal}', workflowGoal),
      dependsOn,
      workflowId: spec.id,
      stageId: clean(stage.id),
      role: clean(stage.role),
      inputFrom
    }, owner);
    stageTaskIds.set(clean(stage.id), task.id);
    tasks.push(task);
  }

  for (const task of tasks) {
    if (resolveRole(task.role)?.builtin !== 'verify') taskScheduler.enqueue(task);
  }
  return { workflowId: spec.id, spec, tasks, agents: agents || null };
}
