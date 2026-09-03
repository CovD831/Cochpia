import { Router } from 'express';

export function createRouter(deps) {
  const { state, saveState, fail, getSession, getMessage, touchSession, currentUserId, agentTaskOwner, agents, music, observability, model, storageProvider, getStorageStatus, listModelProviders, dynamicAlphaObservations, queryCollection, randomUUID, defaultModelSelection, resolveModelSelection, createModelProvider, compatibilityMemoryForRequest, chatMemoryForRequest, memoryRuntime, collectSyncChanges, mergeState, sanitizeWorkspacePreferences, growthEvidence, collaborationRuns, loadWorkflowSpec, listWorkflows, runCollaborationWorkflow, proposals, agentTasks, taskScheduler, taskEvent, recordTaskEvidence, activeAgentRuns, activeVerifications, path, fs, readTaskPatch, removeTaskSandbox, pendingAgentApprovals, activeRuns, streamRuns, runtimeKey, attachStreamResponse, send, finishRun, approvalRegistry, chatRuntime } = deps;
  const router = Router();
const collaborationRunById = (id, ownerId) => {
  const cached = collaborationRuns.get(id);
  if (cached) return cached;
  // 重启后 Map 为空，从持久化 state 反重建关联（run 与 task 都按 owner 隔离）。
  const persisted = (state.collaborationRuns || []).find(run => run.id === id && run.ownerId === ownerId);
  if (persisted) { collaborationRuns.set(id, persisted); return persisted; }
  return null;
};
const collaborationRunView = run => {
  const tasks = run.taskIds.map(id => state.agentTasks.find(task => task.id === id && task.ownerId === run.ownerId)).filter(Boolean);
  const taskByStage = new Map(tasks.map(task => [task.stageId, task]));
  const stages = run.spec.stages.map(stage => ({ ...stage, taskId: taskByStage.get(stage.id)?.id || null, status: taskByStage.get(stage.id)?.status || 'submitted', message: taskByStage.get(stage.id)?.message || null }));
  const statuses = tasks.map(task => task.status);
  const status = statuses.some(item => item === 'failed') ? 'failed'
    : statuses.length && statuses.every(item => item === 'completed') ? 'completed'
      : statuses.some(item => ['running', 'waiting_approval', 'verifying', 'reviewing'].includes(item)) ? 'running' : 'submitted';
  return {
    id: run.id, workflowId: run.workflowId, ownerId: run.ownerId, goal: run.goal,
    status, createdAt: run.createdAt, spec: run.spec, stages,
    tasks, evidence: (state.evidence || []).filter(item => run.taskIds.includes(item.taskId))
  };
};
  router.get('/api/mode', (req, res) => {
    const session = req.query.sessionId ? getSession(String(req.query.sessionId)) : null;
    res.json({ mode: session?.mode || state.mode, companionIntent: session?.companionIntent || 'listen', sessionId: session?.id || null });
  });
  
  router.post('/api/workflows', (_, res) => {
    try { return res.json({ workflows: listWorkflows() }); }
    catch (error) { return fail(res, 500, error.code || 'WORKFLOW_LIST_FAILED', error.message); }
  });
  router.post('/api/workflows/:id/run', async (req, res) => {
    const ownerId = agentTaskOwner();
    const goal = String(req.body?.goal || '').trim().slice(0, 8000);
    if (!goal) return fail(res, 400, 'WORKFLOW_GOAL_REQUIRED', 'Workflow goal is required');
    try {
      const spec = loadWorkflowSpec(req.params.id);
      const run = { id: randomUUID(), workflowId: spec.id, ownerId, goal, spec, taskIds: [], createdAt: new Date().toISOString() };
      const expanded = await runCollaborationWorkflow({ workflowId: spec.id, goal, ownerId, agents, agentTasks, taskScheduler });
      run.taskIds = expanded.tasks.map(task => task.id);
      collaborationRuns.set(run.id, run);
      state.collaborationRuns ||= [];
      state.collaborationRuns.push(run);
      await saveState(state);
      return res.status(202).json({ runId: run.id, ...collaborationRunView(run) });
    } catch (error) { return fail(res, 400, error.code || 'WORKFLOW_RUN_FAILED', error.message); }
  });
  router.get('/api/workflows/runs/:id', (req, res) => {
    const run = collaborationRunById(req.params.id, agentTaskOwner());
    if (!run || run.ownerId !== agentTaskOwner()) return fail(res, 404, 'WORKFLOW_RUN_NOT_FOUND', 'Workflow run not found');
    return res.json(collaborationRunView(run));
  });
  router.post('/api/proposals', async (req, res) => {
    try { const proposal = await proposals.create(req.body || {}, agentTaskOwner()); await saveState(state); return res.status(201).json({ proposal }); }
    catch (error) { return fail(res, 400, error.code || 'PROPOSAL_INVALID', error.message); }
  });
  router.get('/api/proposals', (req, res) => res.json({ proposals: proposals.list(agentTaskOwner()) }));
  router.post('/api/proposals/:id/approve', async (req, res) => {
    try {
      const proposal = await proposals.approve(req.params.id, agentTaskOwner());
      if (!proposal) return fail(res, 404, 'PROPOSAL_NOT_FOUND', 'Proposal not found');
      await saveState(state);
      return res.json({ proposal });
    } catch (error) { return fail(res, 400, error.code || 'PROPOSAL_APPROVE_FAILED', error.message); }
  });
  router.post('/api/proposals/:id/reject', async (req, res) => {
    const proposal = proposals.reject(req.params.id, agentTaskOwner());
    if (!proposal) return fail(res, 404, 'PROPOSAL_NOT_FOUND', 'Proposal not found');
    await saveState(state);
    return res.json({ proposal });
  });
  return router;
}
