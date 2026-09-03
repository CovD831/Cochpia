import { Router } from 'express';

export function createRouter(deps) {
  const { state, saveState, fail, getSession, getMessage, touchSession, currentUserId, agentTaskOwner, agents, music, observability, model, storageProvider, getStorageStatus, listModelProviders, dynamicAlphaObservations, queryCollection, randomUUID, defaultModelSelection, resolveModelSelection, createModelProvider, compatibilityMemoryForRequest, chatMemoryForRequest, memoryRuntime, collectSyncChanges, mergeState, sanitizeWorkspacePreferences, growthEvidence, collaborationRuns, loadWorkflowSpec, listWorkflows, runCollaborationWorkflow, agentTasks, taskScheduler, taskEvent, recordTaskEvidence, activeAgentRuns, activeVerifications, verifyAgentTask, resolveVerificationWorkdir, path, fs, readTaskPatch, removeTaskSandbox, pendingAgentApprovals, activeRuns, streamRuns, runtimeKey, attachStreamResponse, send, finishRun, approvalRegistry, chatRuntime, workflowHooks } = deps;
  const router = Router();
router.get('/api/workbench/tasks/:id', (req, res) => {
  const task = agentTasks.get(req.params.id, agentTaskOwner());
  return task ? res.json({ task }) : fail(res, 404, 'TASK_NOT_FOUND', 'Task not found');
});
const runTaskVerification = async (task, workdir) => {
  const root = path.resolve(process.cwd());
  try {
    await taskEvent(task, 'verification_started', { workdir });
    const result = await verifyAgentTask({ task, cwd: workdir });
    await taskEvent(task, 'verification_finished', { ok: result.ok, checks: result.checks.map(check => ({ name: check.name, args: check.args, ok: check.ok, code: check.code, output: check.output })) });
    await recordTaskEvidence(task, 'verification', JSON.stringify({ ok: result.ok, checks: result.checks }));
    if (!result.ok) {
      await agentTasks.transition(task, 'failed', 'verification_failed');
      taskScheduler.notify(task);
      return;
    }
    await agentTasks.transition(task, 'reviewing', '验证通过，等待独立审查。');
    if (task.workflowId && task.role === 'implementer') await completeWorkflowVerifier(task);
  } catch (error) {
    await taskEvent(task, 'verification_error', { code: error.code || 'VERIFICATION_FAILED' });
    await agentTasks.transition(task, 'failed', 'verification_failed');
    taskScheduler.notify(task);
  } finally { activeVerifications.delete(task.id); }
};
const triggerWorkflowVerification = task => {
  if (!task.workflowId || task.role !== 'implementer' || task.status !== 'verifying' || activeVerifications.has(task.id)) return;
  activeVerifications.add(task.id);
  const workdir = task.sandboxPath
    ? path.resolve(task.sandboxPath)
    : resolveVerificationWorkdir(path.resolve(process.cwd()), task.workdir || '.');
  void runTaskVerification(task, workdir);
};
  workflowHooks.trigger = triggerWorkflowVerification;
const completeWorkflowVerifier = async implementationTask => {
  // 实际 test/build 在 implementer 上运行；此 builtin task 只透传验证结论，负责释放 review 依赖。
  const verifierTask = state.agentTasks.find(task => task.ownerId === implementationTask.ownerId
    && task.workflowId === implementationTask.workflowId
    && task.role === 'verifier'
    && (task.dependsOn || []).includes(implementationTask.id));
  if (!verifierTask || verifierTask.status !== 'submitted') return;
  await agentTasks.transition(verifierTask, 'running', '协作实现阶段验证已自动启动。');
  await agentTasks.transition(verifierTask, 'verifying', '协作实现阶段验证已通过。');
  await recordTaskEvidence(verifierTask, 'verification', '实现阶段自动验证通过。');
  await agentTasks.finish(verifierTask, { summary: '实现阶段自动验证通过。', evidence: ['verification'] });
  taskScheduler.notify(verifierTask);
};
  router.get('/api/workbench/agents', (_, res) => res.json({ agents: [
    { id: 'codex', label: 'Codex', protocol: 'codex-app-server', available: Boolean(process.env.CODEX_BIN || process.env.CODEX_ENABLED !== 'false') },
    { id: 'pi', label: 'Pi Agent', protocol: 'pi-rpc', available: process.env.PI_ENABLED !== 'false' },
    { id: 'claude', label: 'Claude Code', protocol: 'claude-cli-stream-json', available: Boolean(process.env.CLAUDE_BIN || process.env.CLAUDE_ENABLED === 'true') }
  ] }));
  router.get('/api/workbench/tasks', (_, res) => res.json({ tasks: agentTasks.list(agentTaskOwner()) }));
  router.post('/api/workbench/tasks/:id/verify', async (req, res) => {
    const task = agentTasks.get(req.params.id, agentTaskOwner());
    if (!task) return fail(res, 404, 'TASK_NOT_FOUND', 'Task not found');
    if (task.status !== 'verifying') return fail(res, 409, 'TASK_NOT_READY_FOR_VERIFY', 'Task is not waiting for verification');
    if (activeVerifications.has(task.id)) return fail(res, 409, 'VERIFICATION_IN_PROGRESS', 'Task verification is already running');
    const root = path.resolve(process.cwd());
    let workdir;
    try {
      if (task.sandboxPath) {
        workdir = path.resolve(task.sandboxPath);
        if (!fs.existsSync(workdir)) throw Object.assign(new Error('Task sandbox no longer exists'), { code: 'TASK_SANDBOX_MISSING' });
      } else workdir = resolveVerificationWorkdir(root, task.workdir || '.');
    } catch (error) { return fail(res, 400, error.code || 'TASK_WORKDIR_INVALID', error.message); }
    activeVerifications.add(task.id);
    void runTaskVerification(task, workdir);
    return res.status(202).json({ verificationId: task.id, task });
  });
  router.post('/api/workbench/tasks/:id/review', async (req, res) => {
    const task = agentTasks.get(req.params.id, agentTaskOwner());
    if (!task) return fail(res, 404, 'TASK_NOT_FOUND', 'Task not found');
    if (task.status !== 'reviewing') return fail(res, 409, 'TASK_NOT_READY_FOR_REVIEW', 'Task is not waiting for review');
    const decision = String(req.body?.decision || '');
    if (!['approve', 'request_changes', 'reject'].includes(decision)) return fail(res, 400, 'REVIEW_DECISION_INVALID', 'Invalid review decision');
    const feedback = String(req.body?.feedback || '').trim().slice(0, 4000);
    await taskEvent(task, 'review_decided', { decision, feedback: feedback || null });
    await recordTaskEvidence(task, 'review', JSON.stringify({ decision, feedback: feedback || null }));
    if (decision === 'approve') {
      await agentTasks.finish(task, { summary: task.result?.summary || '任务已通过人工审查。', evidence: [...(task.result?.evidence || []), 'human_review_approved'] });
    } else if (decision === 'request_changes') {
      await agentTasks.transition(task, 'verifying', feedback || '审查要求修改后重新验证。');
    } else {
      await agentTasks.transition(task, 'failed', 'review_rejected');
    }
    taskScheduler.notify(task);
    return res.json({ task });
  });
  router.post('/api/workbench/tasks/:id/merge', async (req, res) => {
    const task = agentTasks.get(req.params.id, agentTaskOwner());
    if (!task) return fail(res, 404, 'TASK_NOT_FOUND', 'Task not found');
    if (!['reviewing', 'completed'].includes(task.status)) return fail(res, 409, 'TASK_NOT_READY_FOR_MERGE', 'Task is not waiting for review');
    if (!task.sandboxPath) return fail(res, 409, 'TASK_SANDBOX_MISSING', 'Task sandbox is unavailable');
    const sandbox = { path: task.sandboxPath, root: process.cwd(), parent: path.dirname(task.sandboxPath), mode: 'git-worktree' };
    const patch = await readTaskPatch(sandbox);
    await taskEvent(task, 'merge_prepared', { patch: patch.slice(0, 120000), applied: false });
    await agentTasks.recordResult(task, { summary: task.result?.summary || '已生成待合并补丁。', evidence: [...(task.result?.evidence || []), 'merge_patch_prepared'] });
    if (task.status === 'reviewing') await agentTasks.transition(task, 'completed', '已生成补丁，未自动合并主分支。');
    taskScheduler.notify(task);
    return res.json({ task, patch });
  });
  router.post('/api/workbench/tasks/:id/discard', async (req, res) => {
    const task = agentTasks.get(req.params.id, agentTaskOwner());
    if (!task) return fail(res, 404, 'TASK_NOT_FOUND', 'Task not found');
    if (!['reviewing', 'completed', 'failed'].includes(task.status)) return fail(res, 409, 'TASK_NOT_READY_FOR_DISCARD', 'Task is not ready to discard');
    if (task.sandboxPath) await removeTaskSandbox({ path: task.sandboxPath, root: process.cwd(), parent: path.dirname(task.sandboxPath), mode: 'git-worktree' });
    await taskEvent(task, 'sandbox_discarded', { discarded: true });
    if (task.status === 'reviewing') await agentTasks.transition(task, 'completed', '已丢弃隔离目录变更。');
    taskScheduler.notify(task);
    return res.json({ task });
  });
  router.post('/api/workbench/tasks', async (req, res) => {
    try {
      const task = await agentTasks.create(req.body || {}, agentTaskOwner());
      taskScheduler.enqueue(task);
      return res.status(202).json({ task });
    } catch (error) { return fail(res, 400, error.code || 'TASK_INVALID', error.message); }
  });
  router.post('/api/workbench/tasks/:id/cancel', async (req, res) => {
    const task = agentTasks.get(req.params.id, agentTaskOwner());
    if (!task) return fail(res, 404, 'TASK_NOT_FOUND', 'Task not found');
    const runner = activeAgentRuns.get(task.id);
    if (runner?.close) runner.close();
    try { await agentTasks.transition(task, 'cancelled', '用户取消任务'); taskScheduler.notify(task); return res.json(task); }
    catch (error) { return fail(res, 409, 'TASK_CANCEL_FAILED', error.message); }
  });
  router.post('/api/workbench/tasks/:id/approve', async (req, res) => {
    const task = agentTasks.get(req.params.id, agentTaskOwner());
    if (!task) return fail(res, 404, 'TASK_NOT_FOUND', 'Task not found');
    const requestId = String(req.body?.requestId || '');
    const resolveApproval = pendingAgentApprovals.get(`${task.id}:${requestId}`);
    if (!resolveApproval) return fail(res, 404, 'APPROVAL_NOT_FOUND', 'Approval request not found or expired');
    const decision = ['accept', 'acceptForSession', 'decline', 'cancel'].includes(req.body?.decision) ? req.body.decision : 'decline';
    resolveApproval({ decision });
    await taskEvent(task, 'approval_decided', { requestId, decision });
    return res.json({ ok: true, decision });
  });
  router.post('/api/workbench/tasks/:id/gate', async (req, res) => {
    const task = agentTasks.get(req.params.id, agentTaskOwner());
    if (!task) return fail(res, 404, 'TASK_NOT_FOUND', 'Task not found');
    const decision = String(req.body?.decision || '');
    if (!['allow', 'interrupt', 'deny'].includes(decision)) return fail(res, 400, 'GATE_DECISION_INVALID', 'Invalid gate decision');
    const feedback = String(req.body?.feedback || '').trim().slice(0, 4000);
    const approval = [...(task.events || [])].reverse().find(event => event.type === 'approval_required')?.approval;
    const resolveApproval = approval ? pendingAgentApprovals.get(`${task.id}:${approval.requestId}`) : null;
    if (!resolveApproval) return fail(res, 404, 'APPROVAL_NOT_FOUND', 'Approval request not found or expired');
    await taskEvent(task, 'gate_decided', { decision, feedback: feedback || null });
    resolveApproval({ decision: decision === 'allow' ? 'accept' : decision === 'deny' ? 'decline' : 'interrupt', approved: decision === 'allow', feedback: feedback || null });
    if (decision === 'deny') { await agentTasks.transition(task, 'failed', feedback || 'gate_denied'); taskScheduler.notify(task); }
    return res.json({ ok: true, decision, feedback: feedback || null, task });
  });
  return router;
}
