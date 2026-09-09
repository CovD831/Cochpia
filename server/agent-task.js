import { randomUUID } from 'node:crypto';

export const TASK_STATUSES = ['submitted', 'running', 'waiting_approval', 'verifying', 'reviewing', 'completed', 'failed', 'cancelled'];
const transitions = {
  submitted: new Set(['running', 'cancelled', 'failed']),
  running: new Set(['waiting_approval', 'verifying', 'failed', 'cancelled']),
  waiting_approval: new Set(['running', 'failed', 'cancelled']),
  verifying: new Set(['reviewing', 'completed', 'failed', 'cancelled']),
  reviewing: new Set(['verifying', 'completed', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
};

const clean = value => String(value ?? '').trim().slice(0, 8000);
const cleanList = value => Array.isArray(value) ? value.map(clean).filter(Boolean).slice(0, 20) : [];

const normalizeSpec = (input, taskText) => {
  const source = input.spec && typeof input.spec === 'object' ? input.spec : input;
  return {
    goal: clean(source.goal || taskText).slice(0, 2000),
    acceptance: cleanList(source.acceptance || source.acceptanceCriteria || [taskText]).map(item => item.slice(0, 1000)),
    scope: cleanList(source.scope).map(item => item.slice(0, 500)),
    excludes: cleanList(source.excludes).map(item => item.slice(0, 500)),
    context: clean(source.context).slice(0, 4000),
    timeoutMs: Math.min(30 * 60 * 1000, Math.max(10 * 1000, Number(source.timeoutMs) || 10 * 60 * 1000)),
    retry: Math.min(3, Math.max(0, Number(source.retry) || 0)),
    rollback: clean(source.rollback).slice(0, 2000)
  };
};

export function createAgentTaskService({ state, persist }) {
  state.agentTasks ||= [];

  const appendEvent = async (task, type, data = {}) => {
    task.events ||= [];
    task.events.push({ id: randomUUID(), type, at: new Date().toISOString(), ...data });
    if (task.events.length > 200) task.events.splice(0, task.events.length - 200);
    task.updatedAt = new Date().toISOString();
    await persist(state);
    return task.events.at(-1);
  };

  const transition = async (task, status, reason = null) => {
    if (!TASK_STATUSES.includes(status)) throw new Error(`Unknown task status: ${status}`);
    if (task.status !== status && !transitions[task.status]?.has(status)) throw new Error(`Illegal task transition: ${task.status} -> ${status}`);
    task.status = status;
    if (reason) task.message = clean(reason).slice(0, 500);
    await appendEvent(task, 'state_changed', { status, reason: task.message || null });
    return task;
  };

  return {
    async create(input, ownerId) {
      const target = clean(input.target).toLowerCase();
      if (!['pi', 'codex', 'claude'].includes(target)) throw Object.assign(new Error('Unsupported Agent target'), { code: 'AGENT_TARGET_UNSUPPORTED' });
      const taskText = clean(input.task);
      if (!taskText) throw Object.assign(new Error('Task text is required'), { code: 'TASK_REQUIRED' });
      const owner = clean(ownerId) || 'local-user';
      const idempotencyKey = clean(input.idempotencyKey).slice(0, 200);
      if (idempotencyKey) {
        const existing = state.agentTasks.find(item => item.ownerId === owner && item.idempotencyKey === idempotencyKey);
        if (existing) return existing;
      }
      const dependsOn = [...new Set((Array.isArray(input.dependsOn) ? input.dependsOn : []).map(item => clean(item).slice(0, 100)).filter(Boolean))].slice(0, 20);
      if (dependsOn.some(id => !state.agentTasks.some(item => item.id === id && item.ownerId === owner))) {
        throw Object.assign(new Error('Dependency task not found for current owner'), { code: 'TASK_DEPENDENCY_NOT_FOUND' });
      }
      const inputFrom = [...new Set((Array.isArray(input.inputFrom) ? input.inputFrom : input.inputFrom ? [input.inputFrom] : []).map(item => clean(item).slice(0, 100)).filter(Boolean))].slice(0, 20);
      const task = {
        id: randomUUID(), ownerId: owner, target, task: taskText,
        spec: normalizeSpec(input, taskText), idempotencyKey: idempotencyKey || null,
        workdir: clean(input.workdir).slice(0, 500) || null,
        dependsOn,
        workflowId: clean(input.workflowId).slice(0, 200) || null,
        stageId: clean(input.stageId).slice(0, 200) || null,
        role: clean(input.role).slice(0, 100) || null,
        inputFrom,
        repository: clean(input.repository).slice(0, 500), branch: clean(input.branch).slice(0, 200),
        status: 'submitted', message: '任务已提交，等待执行器启动。', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: []
      };
      state.agentTasks.push(task);
      await appendEvent(task, 'task_created', { target, repository: task.repository || null, branch: task.branch || null, spec: task.spec });
      return task;
    },
    buildInput(task) {
      const sourceIds = Array.isArray(task.inputFrom) && task.inputFrom.length ? task.inputFrom : (task.dependsOn || []);
      const dependencyOutputs = sourceIds.map(dependencyId => {
        const dependency = state.agentTasks.find(item => item.id === dependencyId && item.ownerId === task.ownerId);
        if (!dependency?.result?.summary) return '';
        const label = dependency.stageId || dependency.role || dependency.target;
        return `[${label} 的输出]\n${dependency.result.summary}`;
      }).filter(Boolean).join('\n\n');
      return [
        task.task,
        dependencyOutputs,
        task.repository ? `Repository: ${task.repository}` : '',
        task.branch ? `Branch: ${task.branch}` : ''
      ].filter(Boolean).join('\n\n');
    },
    get(id, ownerId) { return state.agentTasks.find(task => task.id === id && task.ownerId === ownerId) || null; },
    list(ownerId) { return state.agentTasks.filter(task => task.ownerId === ownerId).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).map(task => ({ ...task, events: undefined })); },
    transition,
    appendEvent,
    async addApproval(task, approval) { return appendEvent(task, 'approval_required', { approval: { ...approval, command: clean(approval.command).slice(0, 1000), diff: clean(approval.diff).slice(0, 4000) } }); },
    async recordResult(task, result) {
      task.result = { summary: clean(result.summary).slice(0, 4000), evidence: Array.isArray(result.evidence) ? result.evidence.slice(0, 20).map(clean) : [] };
      await appendEvent(task, 'agent_result', { summary: task.result.summary, evidence: task.result.evidence });
      return task;
    },
    async finish(task, result) { await this.recordResult(task, result); return transition(task, 'completed', '验证与审查已通过，任务完成。'); },
    async fail(task, error) { return transition(task, 'failed', error?.code || 'AGENT_TASK_FAILED'); }
  };
}
