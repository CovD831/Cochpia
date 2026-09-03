import { Router } from 'express';

export function createRouter(deps) {
  const { state, saveState, fail, getSession, getMessage, touchSession, currentUserId, agentTaskOwner, agents, music, observability, model, storageProvider, getStorageStatus, listModelProviders, dynamicAlphaObservations, queryCollection, randomUUID, defaultModelSelection, resolveModelSelection, createModelProvider, compatibilityMemoryForRequest, chatMemoryForRequest, memoryRuntime, collectSyncChanges, mergeState, sanitizeWorkspacePreferences, growthEvidence, collaborationRuns, loadWorkflowSpec, listWorkflows, runCollaborationWorkflow, agentTasks, taskScheduler, taskEvent, recordTaskEvidence, activeAgentRuns, activeVerifications, verifyAgentTask, resolveVerificationWorkdir, path, fs, readTaskPatch, removeTaskSandbox, pendingAgentApprovals, activeRuns, streamRuns, runtimeKey, attachStreamResponse, send, finishRun, approvalRegistry, chatRuntime } = deps;
  const router = Router();
  router.get('/api/health', (_, res) => {
    const storage = getStorageStatus();
    const ok = storage.ready && model.ready;
    res.status(ok ? 200 : 503).json({ ok, status: ok ? 'ready' : 'degraded', service: 'cochpia', storageProvider, storageReady: storage.ready, databaseLatencyMs: storage.lastLatencyMs, lastStorageError: storage.lastError, modelProvider: model.provider, modelName: model.model, modelReady: model.ready, modelProtocol: model.protocol });
  });
  router.get('/api/ready', (_, res) => {
    const storage = getStorageStatus();
    const ready = storage.ready && model.ready;
    res.status(ready ? 200 : 503).json({ ready, storageReady: storage.ready, modelReady: model.ready });
  });
  router.get('/api/version', (_, res) => res.json({ service: 'cochpia', version: process.env.APP_VERSION || '0.1.0', node: process.version, environment: process.env.NODE_ENV || 'development' }));
  router.get('/api/metrics', (_, res) => res.json(observability.getMetrics()));
  router.get('/api/models', (_, res) => res.json({ defaultProvider: process.env.MODEL_PROVIDER || 'mock', providers: listModelProviders() }));
  router.get('/api/dev/dynamic-alpha/observations', (req, res) => {
    if (process.env.NODE_ENV === 'production') return fail(res, 404, 'DEV_ROUTE_NOT_FOUND', 'Development route not available');
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    res.json({ observations: dynamicAlphaObservations.slice(-limit) });
  });
  router.post('/api/models/:provider/test', async (req, res) => {
    const provider = String(req.params.provider || '').trim();
    const requestedModel = String(req.body?.model || '').trim();
    const selection = resolveModelSelection(provider, requestedModel);
    if (!selection.ok) return fail(res, selection.code === 'MODEL_NOT_CONFIGURED' ? 503 : 400, selection.code, selection.error);
    const selected = createModelProvider(provider, { model: selection.config.model });
    const startedAt = Date.now();
    try {
      await selected.generate({ message: 'Connection test. Reply with OK.', recalled: [] });
      res.json({ ok: true, provider: selected.provider, model: selected.model, protocol: selected.protocol, latencyMs: Date.now() - startedAt });
    } catch (error) {
      fail(res, error.code === 'MODEL_AUTH_FAILED' ? 401 : error.code === 'MODEL_INSUFFICIENT_BALANCE' ? 402 : error.code === 'MODEL_NOT_FOUND' ? 404 : error.code === 'MODEL_TIMEOUT' ? 504 : 502, error.code || 'MODEL_CONNECTION_FAILED', error.message);
    }
  });
  router.post('/api/chat/cancel', (req, res) => {
    const sessionId = String(req.body?.sessionId || '').trim();
    const run = activeRuns.get(runtimeKey(sessionId));
    if (!run) return fail(res, 404, 'CHAT_RUN_NOT_FOUND', 'No active chat run was found');
    run.cancelled = true;
    run.controller.abort();
    if (!run.cancelNotified) {
      run.cancelNotified = true;
      send(run.response, 'error', { code: 'CHAT_CANCELLED', message: 'Chat generation was cancelled' }, run);
      send(run.response, 'done', { ok: false, cancelled: true, runId: run.id }, run);
      finishRun(run);
    }
    res.status(202).json({ ok: true, sessionId });
  });
  router.get('/api/chat/stream/:runId', (req, res) => {
    const run = streamRuns.get(req.params.runId);
    if (!run || run.userId !== currentUserId()) return fail(res, 404, 'STREAM_RUN_NOT_FOUND', 'Stream run not found');
    if (run.response && !run.response.writableEnded && !run.response.destroyed) run.response.end();
    attachStreamResponse(run, res, req.get('last-event-id') || req.query.afterEventId || '');
    if (run.finished) res.end();
  });
  router.get('/api/memory/dream', async (req, res) => res.json({ memories: await compatibilityMemoryForRequest(req).dream(req.query.limit), generatedAt: new Date().toISOString() }));
  router.patch('/api/mode', async (req, res) => {
    const mode = String(req.body?.mode || '');
    if (!['companion', 'work'].includes(mode)) return fail(res, 400, 'INVALID_MODE', 'Mode must be companion or work');
    const session = req.body?.sessionId ? getSession(String(req.body.sessionId)) : null;
    if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    session.mode = mode;
    if (req.body?.companionIntent && ['listen', 'comfort', 'advice', 'accompany', 'quiet'].includes(req.body.companionIntent)) session.companionIntent = req.body.companionIntent;
    touchSession(session);
    await saveState(state);
    res.json({ mode: session.mode, companionIntent: session.companionIntent || 'listen', sessionId: session.id });
  });
  router.post('/api/chat/approve', (req, res) => {
    return approvalRegistry.respondApproval(req, res, fail);
  });
  router.post('/api/chat/stream', (req, res) => chatRuntime.handleChatStream(req, res));
  router.post('/api/chat/regenerate', (req, res) => chatRuntime.handleChatStream(req, res, { regenerateMessageId: String(req.body?.messageId || '').trim() || null }));
  router.post('/api/chat/retry', (req, res) => chatRuntime.handleChatStream(req, res, { regenerateMessageId: String(req.body?.messageId || '').trim() || null, retry: true }));
  router.post('/api/chat/group', (req, res) => chatRuntime.handleGroupChat(req, res));
  router.post('/mcp', async (req, res) => {
    const { id, method, params = {} } = req.body || {};
    try {
      const compatibility = compatibilityMemoryForRequest(req);
      let result;
      if (method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'cochpia-memory', version: '0.1.0' }, capabilities: { tools: {} } };
      else if (method === 'notifications/initialized') return res.status(202).end();
      else if (method === 'tools/list') result = { tools: compatibility.listTools().concat(['grow', 'trace']).map(name => ({ name, description: `Cochpia memory tool: ${name}` })) };
      else if (method === 'tools/call') {
        const { name, arguments: args = {} } = params;
        if (name === 'breath') result = { content: [{ type: 'text', text: JSON.stringify(await compatibility.breath(args.query, args.limit)) }] };
        else if (name === 'hold') result = { content: [{ type: 'text', text: JSON.stringify(await compatibility.hold(args)) }] };
        else if (name === 'dream') result = { content: [{ type: 'text', text: JSON.stringify(await compatibility.dream(args.limit)) }] };
        else if (name === 'grow') result = { content: [{ type: 'text', text: JSON.stringify(await growthEvidence.grow(args)) }] };
        else if (name === 'trace') result = { content: [{ type: 'text', text: JSON.stringify(growthEvidence.trace(args.id)) }] };
        else result = { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown tool' }) }], isError: true };
      } else throw new Error(`Unsupported method: ${method}`);
      res.json({ jsonrpc: '2.0', id, result });
    } catch (error) { res.status(500).json({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } }); }
  });
  // 文件上传：手机/网页上传文件到服务端，供工作模式 read 工具处理
  router.post('/api/upload', async (req, res) => {
    try {
      const { name, dataUrl } = req.body || {};
      const fileName = String(name || 'file').replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(0, 100) || 'file';
      if (!dataUrl || typeof dataUrl !== 'string') return fail(res, 400, 'INVALID_UPLOAD', 'dataUrl is required');
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return fail(res, 400, 'INVALID_UPLOAD', 'Invalid data URL');
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length > 5 * 1024 * 1024) return fail(res, 400, 'FILE_TOO_LARGE', '文件过大（最大 5MB）');
      const uploadDir = path.join(process.cwd(), 'uploads');
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(path.join(uploadDir, fileName), buffer);
      return res.json({ name: fileName, path: `uploads/${fileName}`, size: buffer.length });
    } catch (error) { return fail(res, 400, 'UPLOAD_FAILED', error.message); }
  });
  
  return router;
}
