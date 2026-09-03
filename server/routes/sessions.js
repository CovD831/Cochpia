import { Router } from 'express';

export function createRouter(deps) {
  const { state, saveState, fail, getSession, getMessage, touchSession, currentUserId, sessionBelongsToCurrentUser, agentTaskOwner, agents, resolveMessageAvatar, music, observability, model, storageProvider, getStorageStatus, listModelProviders, dynamicAlphaObservations, queryCollection, randomUUID, defaultModelSelection, resolveModelSelection, createModelProvider, compatibilityMemoryForRequest, chatMemoryForRequest, memoryRuntime, collectSyncChanges, mergeState, sanitizeWorkspacePreferences, growthEvidence, collaborationRuns, loadWorkflowSpec, listWorkflows, runCollaborationWorkflow, agentTasks, taskScheduler, taskEvent, recordTaskEvidence, activeAgentRuns, activeVerifications, verifyAgentTask, resolveVerificationWorkdir, path, fs, readTaskPatch, removeTaskSandbox, pendingAgentApprovals, activeRuns, streamRuns, runtimeKey, attachStreamResponse, send, finishRun, approvalRegistry, chatRuntime } = deps;
  const router = Router();
  router.get('/api/sessions', (req, res) => {
    const ownedSessions = state.sessions.filter(session => sessionBelongsToCurrentUser(session, req.cochpiaUserId));
    if (req.query.paginated !== 'true' && !req.query.search && req.query.archived === undefined) return res.json(ownedSessions);
    const result = queryCollection(ownedSessions, { search: req.query.search, limit: req.query.limit, offset: req.query.offset, filter: session => req.query.archived === 'true' ? session.archived === true : req.query.archived === 'false' ? session.archived !== true : true });
    const items = result.items.sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json(req.query.paginated === 'true' ? { ...result, items } : items);
  });
  router.post('/api/sessions', async (req, res) => {
    const kind = req.body?.kind === 'group' ? 'group' : 'private';
    const agentId = kind === 'private' && req.body?.agentId ? String(req.body.agentId).slice(0, 100) : null;
    if (agentId && !agents.get(agentId)) return fail(res, 404, 'AGENT_NOT_FOUND', 'The selected agent no longer exists');
    const session = { id: randomUUID(), ownerId: req.cochpiaUserId || currentUserId(), title: String(req.body?.title || '新的相遇').slice(0, 80), description: String(req.body?.description || '').trim().slice(0, 300), kind, agentId, groupMode: kind === 'group' ? (req.body?.groupMode === 'turn' ? 'turn' : 'parallel') : null, agentIds: Array.isArray(req.body?.agentIds) ? req.body.agentIds.map(String).slice(0, 20) : [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mode: 'companion', companionIntent: 'listen', ...defaultModelSelection() };
    state.sessions.unshift(session); state.messages[session.id] = []; await saveState(state); res.status(201).json(session);
  });
  router.patch('/api/sessions/:id', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    if (req.body?.title !== undefined) session.title = String(req.body.title).trim().slice(0, 80) || session.title;
    if (req.body?.description !== undefined) session.description = String(req.body.description).trim().slice(0, 300);
    if (req.body?.agentId !== undefined && session.kind === 'private') {
      const nextAgentId = req.body.agentId ? String(req.body.agentId).slice(0, 100) : null;
      if (nextAgentId && !agents.get(nextAgentId)) return fail(res, 404, 'AGENT_NOT_FOUND', 'The selected agent no longer exists');
      session.agentId = nextAgentId;
    }
    if (req.body?.groupMode !== undefined && session.kind === 'group') session.groupMode = req.body.groupMode === 'turn' ? 'turn' : 'parallel';
    if (Array.isArray(req.body?.agentIds) && session.kind === 'group') session.agentIds = [...new Set(req.body.agentIds.map(String))].slice(0, 20);
    touchSession(session); await saveState(state); res.json(session);
  });
  router.get('/api/sessions/:id/model', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    const selection = { modelProvider: session.modelProvider, modelName: session.modelName };
    const status = resolveModelSelection(selection.modelProvider, selection.modelName);
    res.json({ ...selection, ready: status.ok, error: status.ok ? null : status.error });
  });
  router.patch('/api/sessions/:id/model', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    const provider = String(req.body?.provider || '').trim();
    const requestedModel = String(req.body?.model || '').trim();
    const selection = resolveModelSelection(provider, requestedModel);
    if (!selection.ok) return fail(res, selection.code === 'MODEL_NOT_CONFIGURED' ? 503 : 400, selection.code, selection.error);
    session.modelProvider = selection.config.provider;
    session.modelName = selection.config.model;
    touchSession(session); await saveState(state);
    res.json({ modelProvider: session.modelProvider, modelName: session.modelName, ready: true });
  });
  router.get('/api/sessions/:id/persona', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    res.json({ persona: session.persona || '' });
  });
  router.patch('/api/sessions/:id/persona', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    session.persona = String(req.body?.persona ?? '').trim().slice(0, 2000);
    touchSession(session); await saveState(state);
    res.json({ persona: session.persona });
  });
  router.get('/api/sessions/:id/messages', (req, res) => {
    if (!getSession(req.params.id, req.cochpiaUserId)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    const channel = req.query.channel ? String(req.query.channel) : '';
    const allMessages = state.messages[req.params.id] || [];
    const scoped = (channel ? allMessages.filter(message => (message.channel || '默认') === channel) : allMessages)
      .map(message => resolveMessageAvatar(message, message.senderId ? agents.get(message.senderId) : null));
    if (req.query.paginated !== 'true' && !req.query.search) return res.json(scoped);
    const result = queryCollection(scoped, { search: req.query.search, limit: req.query.limit, offset: req.query.offset, text: message => message.content });
    res.json(req.query.paginated === 'true' ? result : result.items);
  });
  router.get('/api/sessions/:id/channels', (req, res) => {
    if (!getSession(req.params.id)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    const counts = new Map();
    for (const message of state.messages[req.params.id] || []) {
      const name = message.channel || '默认';
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    res.json([...counts.entries()].map(([name, count]) => ({ name, count })));
  });
  router.patch('/api/sessions/:id/messages/:messageId', async (req, res) => {
    if (!getSession(req.params.id)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    const message = getMessage(req.params.id, req.params.messageId);
    if (!message) return fail(res, 404, 'MESSAGE_NOT_FOUND', 'Message not found');
    const content = String(req.body?.content || '').trim();
    if (!content) return fail(res, 400, 'INVALID_MESSAGE', 'Message content is required');
    message.content = content.slice(0, 8000); message.updatedAt = new Date().toISOString(); touchSession(getSession(req.params.id)); await saveState(state); res.json(message);
  });
  router.delete('/api/sessions/:id/messages/:messageId', async (req, res) => {
    if (!getSession(req.params.id)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    const messages = state.messages[req.params.id] || [];
    const index = messages.findIndex(message => message.id === req.params.messageId);
    if (index === -1) return fail(res, 404, 'MESSAGE_NOT_FOUND', 'Message not found');
    messages.splice(index, 1); touchSession(getSession(req.params.id)); await saveState(state); res.status(204).end();
  });
  router.patch('/api/sessions/:id', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    const hasTitle = req.body?.title !== undefined;
    const title = String(req.body?.title || '').trim();
    if (!hasTitle && req.body?.archived === undefined && req.body?.pinned === undefined) return fail(res, 400, 'INVALID_SESSION_UPDATE', 'Session update is required');
    if (hasTitle && !title) return fail(res, 400, 'INVALID_TITLE', 'Title is required');
    if (hasTitle) session.title = title.slice(0, 80);
    if (req.body?.archived !== undefined) session.archived = Boolean(req.body.archived);
    if (req.body?.pinned !== undefined) session.pinned = Boolean(req.body.pinned);
    touchSession(session); await saveState(state); res.json(session);
  });
  router.delete('/api/sessions/:id', async (req, res) => {
    const index = state.sessions.findIndex(session => session.id === req.params.id && sessionBelongsToCurrentUser(session, req.cochpiaUserId));
    if (index === -1) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    state.sessions.splice(index, 1); delete state.messages[req.params.id]; await saveState(state); res.status(204).end();
  });
  return router;
}
