import { Router } from 'express';

export function createRouter(deps) {
  const { state, saveState, fail, getSession, getMessage, touchSession, currentUserId, agentTaskOwner, agents, music, observability, model, storageProvider, getStorageStatus, listModelProviders, dynamicAlphaObservations, queryCollection, randomUUID, defaultModelSelection, resolveModelSelection, createModelProvider, compatibilityMemoryForRequest, chatMemoryForRequest, memoryRuntime, collectSyncChanges, mergeState, sanitizeWorkspacePreferences, growthEvidence, collaborationRuns, loadWorkflowSpec, listWorkflows, runCollaborationWorkflow, agentTasks, taskScheduler, taskEvent, recordTaskEvidence, activeAgentRuns, activeVerifications, verifyAgentTask, resolveVerificationWorkdir, path, fs, readTaskPatch, removeTaskSandbox, pendingAgentApprovals, activeRuns, streamRuns, runtimeKey, attachStreamResponse, send, finishRun, approvalRegistry, chatRuntime } = deps;
  const router = Router();
  router.get('/api/agents', (_, res) => res.json(agents.list()));
  router.post('/api/agents', async (req, res) => { try { res.status(201).json(await agents.create(req.body || {})); } catch (error) { fail(res, 400, 'INVALID_AGENT', error.message); } });
  router.patch('/api/agents/:id', async (req, res) => { try { const agent = await agents.update(req.params.id, req.body || {}); agent ? res.json(agent) : fail(res, 404, 'AGENT_NOT_FOUND', 'Agent not found'); } catch (error) { fail(res, 400, 'INVALID_AGENT', error.message); } });
  router.delete('/api/agents/:id', async (req, res) => { const removed = await agents.remove(req.params.id); removed ? res.status(204).end() : fail(res, 404, 'AGENT_NOT_FOUND', 'Agent not found'); });
  return router;
}

