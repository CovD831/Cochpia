import { Router } from 'express';

export function createRouter(deps) {
  const { state, saveState, fail, getSession, getMessage, touchSession, currentUserId, agentTaskOwner, agents, music, observability, model, storageProvider, getStorageStatus, listModelProviders, dynamicAlphaObservations, queryCollection, randomUUID, defaultModelSelection, resolveModelSelection, createModelProvider, compatibilityMemoryForRequest, chatMemoryForRequest, memoryRuntime, collectSyncChanges, mergeState, sanitizeWorkspacePreferences, growthEvidence, collaborationRuns, loadWorkflowSpec, listWorkflows, runCollaborationWorkflow, agentTasks, taskScheduler, taskEvent, recordTaskEvidence, activeAgentRuns, activeVerifications, verifyAgentTask, resolveVerificationWorkdir, path, fs, readTaskPatch, removeTaskSandbox, pendingAgentApprovals, activeRuns, streamRuns, runtimeKey, attachStreamResponse, send, finishRun, approvalRegistry, chatRuntime } = deps;
  const router = Router();
  router.get('/api/sync', (req, res) => {
    try { return res.json({ version: 1, syncedAt: new Date().toISOString(), ...collectSyncChanges(state, { cursor: req.query.cursor, limit: req.query.limit }) }); }
    catch (error) { return fail(res, 400, 'INVALID_SYNC_CURSOR', error.message); }
  });
  router.get('/api/memories', async (req, res) => {
    const memories = await compatibilityMemoryForRequest(req).list(req.query.paginated === 'true' ? { ...req.query, limit: 100 } : req.query);
    if (req.query.paginated !== 'true') return res.json(memories);
    const result = queryCollection(memories, { search: req.query.search, limit: req.query.limit, offset: req.query.offset, text: item => `${item.summary} ${item.type} ${item.source}` });
    return res.json(result);
  });
  router.post('/api/memories', async (req, res) => { try { res.status(201).json(await compatibilityMemoryForRequest(req).hold(req.body || {})); } catch (error) { fail(res, 400, 'INVALID_MEMORY', error.message); } });
  router.get('/api/memories/export', async (req, res) => {
    const memories = await compatibilityMemoryForRequest(req).exportMemories();
    res.set('Content-Disposition', 'attachment; filename="cochpia-memories.json"');
    res.json({ exportedAt: new Date().toISOString(), version: 1, memories });
  });
  router.get('/api/export', async (req, res) => {
    await memoryRuntime.prepareForRequest(req);
    res.set('Content-Disposition', 'attachment; filename="cochpia-export.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      version: 1,
      state: {
        sessions: state.sessions,
        messages: state.messages,
        memoryModule: state.memoryModule || null,
        evidence: state.evidence,
        agents: state.agents,
        profile: state.profile,
        workspacePreferences: state.workspacePreferences || null
      }
    });
  });
  router.post('/api/import', async (req, res) => {
    try {
      const incoming = req.body?.state;
      if (!incoming || typeof incoming !== 'object') return fail(res, 400, 'INVALID_IMPORT', 'Import state is required');
      const merged = mergeState(state, incoming);
      Object.assign(state, merged);
      await saveState(state);
      res.json({ ok: true, importedAt: new Date().toISOString() });
    } catch (error) {
      fail(res, 400, 'IMPORT_FAILED', error.message);
    }
  });
  router.get('/api/preferences', (_, res) => res.json({ preferences: state.workspacePreferences || null, updatedAt: state.workspacePreferencesUpdatedAt || null }));
  router.patch('/api/preferences', async (req, res) => {
    try {
      const preferences = sanitizeWorkspacePreferences(req.body?.preferences);
      state.workspacePreferences = preferences;
      state.workspacePreferencesUpdatedAt = new Date().toISOString();
      await saveState(state);
      return res.json({ preferences, updatedAt: state.workspacePreferencesUpdatedAt });
    } catch (error) {
      return fail(res, 400, 'INVALID_PREFERENCES', error.message);
    }
  });
  router.post('/api/memories/batch', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String).filter(Boolean))] : [];
    if (!ids.length) return fail(res, 400, 'INVALID_MEMORY_BATCH', 'At least one memory id is required');
    if (req.body?.action !== 'revoke') return fail(res, 400, 'INVALID_MEMORY_BATCH_ACTION', 'Only revoke is supported');
    const compatibility = compatibilityMemoryForRequest(req);
    const results = await Promise.all(ids.map(id => compatibility.revoke(id)));
    res.json({ requested: ids.length, revoked: results.filter(Boolean).length, memories: results.filter(Boolean) });
  });
  router.post('/api/memories/:id/revoke', async (req, res) => { const item = await compatibilityMemoryForRequest(req).revoke(req.params.id); item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found'); });
  router.get('/api/memories/:id', async (req, res) => { const item = await compatibilityMemoryForRequest(req).get(req.params.id); item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found'); });
  router.patch('/api/memories/:id', async (req, res) => { try { const item = await compatibilityMemoryForRequest(req).update(req.params.id, req.body || {}); item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found'); } catch (error) { fail(res, 400, 'INVALID_MEMORY', error.message); } });
  router.delete('/api/memories/:id', async (req, res) => { const removed = await compatibilityMemoryForRequest(req).remove(req.params.id); removed ? res.status(204).end() : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found'); });
  router.get('/api/memory/overview', async (req, res) => {
    try {
      const { memories } = await chatMemoryForRequest(req).overview();
      res.json({ count: memories.length, memories: memories.slice(0, 8), memorySystem: 'memory-module' });
    } catch (error) {
      fail(res, error.status || 503, error.code || 'MEMORY_MODULE_UNAVAILABLE', error.message || 'Memory Module unavailable');
    }
  });
  return router;
}

