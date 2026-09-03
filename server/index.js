import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getStorageStatus, loadState, loadUserState, saveState, storageProvider } from './store.js';
import { createMemoryModuleRuntime } from './memory-module-runtime.js';
import { createGrowthEvidenceService } from './growth-evidence.js';
import { createModelProvider, listModelProviders, resolveModelConfig, resolveModelSelection } from './model-provider.js';
import { authenticateRequest, authMode, validateAuthStorage } from './auth.js';
import { buildRuntimeContext, findRegenerationTarget } from './runtime-context.js';
import { createSseEvent, formatSseEvent } from './sse.js';
import { queryCollection } from './collection-query.js';
import { agentAvatar, createAgentService, resolveMessageAvatar } from './agent-service.js';
import { collectSyncChanges } from './sync-service.js';
import { createObservability } from './observability.js';
import { createMusicService } from './music-service.js';
import { createNeteaseMusicAdapter } from './netease-music-adapter.js';
import { executeTool, findTool, getToolRisk, toOpenAITools } from './tools.js';
import { createPiClient } from './pi-client.js';
import { maybeCompactConversation } from './compaction.js';
import { mergeState } from './state-merge.js';
import { shouldRemember } from './auto-memory.js';
import { sanitizeWorkspacePreferences } from './workspace-preferences.js';
import { routeMessage } from './dynamic-alpha-router.js';
import { assertProductionDbSsl } from './db-ssl.js';
import { createAgentTaskService } from './agent-task.js';
import { createCodexClient } from './codex-client.js';
import { createClaudeClient } from './claude-client.js';
import { verifyAgentTask, resolveVerificationWorkdir } from './verifier.js';
import { createTaskSandbox, readTaskDiff, readTaskPatch, removeTaskSandbox, cleanupOrphanTaskSandboxes } from './task-sandbox.js';
import { createAgentScheduler } from './agent-scheduler.js';
import { loadWorkflowSpec, listWorkflows } from './workflows.js';
import { runCollaborationWorkflow } from './orchestrator.js';
import { createEvidenceLedger } from './evidence.js';
import { createProposalService } from './proposals.js';
import { applyProposalPatch } from './code-modifier.js';
import { createRunRegistry } from './runtime/runs.js';
import { createApprovalRegistry } from './runtime/approval.js';
import { createChatRuntime } from './runtime/chat-runtime.js';

const app = express();
const observability = createObservability({ rateLimitMax: Number(process.env.API_RATE_LIMIT_MAX || 120) });
const port = Number(process.env.PORT || 8787);
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const allowedOrigins = clientOrigin.split(',').map(origin => origin.trim()).filter(Boolean);
const isPrivateDevelopmentOrigin = origin => {
  if (process.env.NODE_ENV === 'production') return false;
  try {
    const url = new URL(origin);
    // Vite may use another port when 5173 is occupied; keep the host as the
    // development boundary while production remains config-only below.
    if (url.protocol !== 'http:') return false;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    const octets = hostname.split('.').map(Number);
    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
    return octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  } catch {
    return false;
  }
};
const requestContext = new AsyncLocalStorage();
let baseState;
try {
  baseState = await loadState();
} catch (error) {
  console.error(JSON.stringify({ event: 'cochpia_startup_failed', code: error.code || 'STORAGE_STARTUP_FAILED', message: error.message }));
  throw error;
}
if (process.env.NODE_ENV === 'production' && (process.env.MODEL_PROVIDER || 'mock') === 'mock') throw new Error('MODEL_PROVIDER=mock is not allowed in production');
if (authMode() === 'required' && !process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is required when AUTH_MODE=required');
validateAuthStorage(storageProvider);
assertProductionDbSsl();
const state = new Proxy(baseState, {
  get(target, property) {
    const current = requestContext.getStore()?.state || target;
    if (property === '__userId') return requestContext.getStore()?.user?.id || null;
    return current[property];
  },
  set(target, property, value) {
    const current = requestContext.getStore()?.state || target;
    current[property] = value;
    return true;
  },
  ownKeys(target) { return Reflect.ownKeys(requestContext.getStore()?.state || target); },
  getOwnPropertyDescriptor(target, property) { return { configurable: true, enumerable: true, value: (requestContext.getStore()?.state || target)[property], writable: true }; }
});
const memoryRuntime = createMemoryModuleRuntime({
  getState: () => requestContext.getStore()?.state || baseState,
  persistState: currentState => saveState(currentState),
  getUser: () => requestContext.getStore()?.user || { id: 'local-user' }
});
const agents = createAgentService(state, () => saveState(state));
const growthEvidence = createGrowthEvidenceService(state, () => saveState(state));
const activeRuns = new Map();
const streamRuns = new Map();
const dynamicAlphaObservations = [];
const recordDynamicAlphaObservation = ({ sessionId, mode, routing, modelProvider, modelName }) => {
  if (process.env.NODE_ENV === 'production') return;
  const sessionKey = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 12);
  dynamicAlphaObservations.push({
    recordedAt: new Date().toISOString(),
    sessionKey,
    mode,
    modelProvider,
    modelName,
    scores: routing.scores,
    confAbs: routing.confAbs,
    confMargin: routing.confMargin,
    alphaRaw: routing.alphaRaw,
    alphaDecayed: routing.alphaDecayed,
    alphaWork: routing.alphaWork,
    alphaLove: routing.alphaLove,
    decision: routing.decision,
    placement: routing.placements?.[mode === 'work' ? 'work' : 'love'] || null,
    isAnchor: routing.isAnchor
  });
  if (dynamicAlphaObservations.length > 100) dynamicAlphaObservations.shift();
};
// 待确认的写操作：key = `${runId}:${toolCallId}` → resolve({ approved })
const pendingApprovals = new Map();
const approvalRecords = new Map();
const pendingAgentApprovals = new Map();
const sessionApprovalGrants = new Map();
const approvalTimeoutMs = Math.max(30_000, Number(process.env.APPROVAL_TIMEOUT_MS || 5 * 60 * 1000));
const sessionApprovalGrantTtlMs = Math.max(60_000, Number(process.env.APPROVAL_SESSION_TTL_MS || 30 * 60 * 1000));
const activeAgentRuns = new Map();
const activeVerifications = new Set();
const collaborationRuns = new Map();
const streamRetentionMs = Math.max(30_000, Number(process.env.SSE_RUN_RETENTION_MS || 300_000));
const chatRunTimeoutMs = Math.max(30_000, Number(process.env.CHAT_RUN_TIMEOUT_MS || 120_000));
const model = createModelProvider();
const music = createMusicService({ adapter: process.env.MUSIC_MODE === 'netease' ? createNeteaseMusicAdapter() : undefined });
const defaultModelSelection = () => {
  const provider = process.env.MODEL_PROVIDER || 'mock';
  const config = resolveModelConfig(provider);
  return { modelProvider: provider, modelName: config.model || config.suggestedModels?.[0] || 'mock' };
};
for (const session of state.sessions) {
  if (!session.modelProvider || !session.modelName) Object.assign(session, defaultModelSelection());
}
state.agents ||= [];
state.profile ||= { name: 'Cochpia', gender: 'none', age: null, avatar: '✦' };
state.mode ||= 'companion';
state.agentTasks ||= [];
state.evidence ||= [];
state.proposals ||= [];
state.collaborationRuns ||= [];
for (const session of state.sessions) {
  session.mode ||= state.mode;
  session.companionIntent ||= 'listen';
}

app.use((req, res, next) => {
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || isPrivateDevelopmentOrigin(origin)) return callback(null, true);
      if (origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`) return callback(null, true);
      return callback(Object.assign(new Error('CORS origin is not allowed'), { code: 'CORS_ORIGIN_NOT_ALLOWED' }));
    }
  })(req, res, next);
});
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()'
  });
  res.set('Content-Security-Policy', process.env.CSP || "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; connect-src 'self' https:; font-src 'self' data: https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(observability.middleware);
app.use(async (req, res, next) => {
  const isApi = req.path.startsWith('/api/') || req.path.startsWith('/v1/') || req.path === '/mcp';
  const isPublic = req.path === '/api/health' || req.path === '/api/ready' || req.path === '/api/version' || req.path === '/api/metrics' || req.path === '/api/models';
  if (!isApi || isPublic || authMode() === 'off') {
    if (authMode() === 'off' && isApi) return requestContext.run({ user: { id: 'local-user', local: true }, state: baseState }, next);
    return next();
  }
  try {
    const user = await authenticateRequest(req);
    const userState = await loadUserState(user.id, baseState);
    req.cochpiaUserId = user.id;
    return requestContext.run({ user, state: userState }, next);
  } catch (error) { return next(error); }
});
app.use('/v1', memoryRuntime.router());

const send = (res, event, data, run) => {
  if (!run) return false;
  const entry = createSseEvent(run, event, data);
  const target = run.response || res;
  if (!target || target.writableEnded || target.destroyed) return false;
  target.write(formatSseEvent(entry));
  return true;
};
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const sessionBelongsToCurrentUser = (session, ownerId = currentUserId()) => session && (session.ownerId ? session.ownerId === ownerId : authMode() === 'off');
const getSession = (id, ownerId = currentUserId()) => state.sessions.find(session => session.id === id && sessionBelongsToCurrentUser(session, ownerId));
const getMessage = (sessionId, messageId) => state.messages[sessionId]?.find(message => message.id === messageId);
const touchSession = session => { if (session) session.updatedAt = new Date().toISOString(); };
const runtimeKey = sessionId => `${requestContext.getStore()?.user?.id || 'local-user'}:${sessionId}`;
const currentUserId = () => requestContext.getStore()?.user?.id || 'local-user';
const chatMemoryForRequest = req => memoryRuntime.chatForRequest(req);
const compatibilityMemoryForRequest = req => memoryRuntime.compatibilityForRequest(req);
const approvalRegistry = createApprovalRegistry({ pendingApprovals, approvalRecords, sessionApprovalGrants, currentUserId, approvalTimeoutMs, sessionApprovalGrantTtlMs });
const agentTasks = createAgentTaskService({ state, persist: currentState => saveState(currentState) });
const evidenceLedger = createEvidenceLedger(state);
const proposals = createProposalService(state, { apply: async (patch, proposal) => { applyProposalPatch(patch, proposal); } });
const agentTaskOwner = () => currentUserId();
const taskEvent = async (task, type, data = {}) => agentTasks.appendEvent(task, type, data);
const recordTaskEvidence = async (task, source, content, score = null) => {
  if (!content) return null;
  const item = evidenceLedger.record({ taskId: task.id, stageId: task.stageId, source, content, score });
  await saveState(state);
  return item;
};
void Promise.all(state.agentTasks.filter(task => ['running', 'verifying'].includes(task.status)).map(async task => {
  const previousStatus = task.status;
  task.status = 'failed';
  task.message = previousStatus === 'running' ? 'agent_execution_interrupted' : 'verification_interrupted';
  await taskEvent(task, 'task_interrupted', { reason: 'server_restart', previousStatus });
}));
const runAgentTask = async task => {
  const text = agentTasks.buildInput(task);
  let output = '';
  let sandbox = null;
  try {
    sandbox = await createTaskSandbox({ root: process.cwd() });
    task.sandboxPath = sandbox.path;
    await taskEvent(task, 'sandbox_created', { workdir: sandbox.path });
    await agentTasks.transition(task, 'running', `${task.target} 执行器已启动`);
    if (task.target === 'pi') {
      const client = createPiClient({ cwd: sandbox.path, timeoutMs: task.spec?.timeoutMs });
      activeAgentRuns.set(task.id, client);
      await client.prompt(text, async event => {
        if (event.type === 'message_update') output += String(event.assistantMessageEvent?.delta || '');
        await taskEvent(task, event.type || 'agent_event', { summary: String(event.assistantMessageEvent?.delta || event.type || '').slice(0, 1000) });
      });
      client.close();
    } else if (task.target === 'codex') {
      const client = createCodexClient({ cwd: sandbox.path, timeoutMs: task.spec?.timeoutMs, onRequest: async request => {
        await agentTasks.transition(task, 'waiting_approval', 'Agent 请求用户审批');
        await agentTasks.addApproval(task, { method: request.method, requestId: request.id, command: request.params?.command, diff: request.params?.diff });
        const approvalKey = `${task.id}:${request.id}`;
        const decision = await new Promise(resolve => {
          const timeout = setTimeout(() => { pendingAgentApprovals.delete(approvalKey); resolve({ decision: 'decline' }); }, 5 * 60 * 1000);
          pendingAgentApprovals.set(approvalKey, value => { clearTimeout(timeout); pendingAgentApprovals.delete(approvalKey); resolve(value); });
        });
        await agentTasks.transition(task, 'running', '用户审批已处理');
        return decision;
      }});
      activeAgentRuns.set(task.id, client);
      await client.run(text, async event => {
        const delta = event.method === 'item/agentMessage/delta' ? event.params?.delta : '';
        output += String(delta || '');
        await taskEvent(task, event.method || 'agent_event', { summary: String(delta || event.method || '').slice(0, 1000) });
      });
      client.close();
    } else {
      const client = createClaudeClient({ cwd: sandbox.path, timeoutMs: task.spec?.timeoutMs });
      activeAgentRuns.set(task.id, client);
      await client.run(text, async event => {
        const summary = event.type === 'assistant'
          ? event.message?.content?.filter(item => item.type === 'text').map(item => item.text).join('')
          : event.type === 'result' ? event.result : event.type;
        if (event.type === 'result') output += String(event.result || '');
        await taskEvent(task, event.type || 'agent_event', { summary: String(summary || '').slice(0, 1000) });
      });
      client.close();
    }
    if (task.status !== 'cancelled') {
      const diff = await readTaskDiff(sandbox);
      if (diff) await taskEvent(task, 'sandbox_diff', { diff });
      await recordTaskEvidence(task, 'agent_output', output || '执行端已完成任务。');
      if (diff) await recordTaskEvidence(task, 'sandbox_diff', diff);
      await agentTasks.recordResult(task, { summary: output || '执行端已完成任务。', evidence: [...(output ? ['agent_output'] : []), ...(diff ? ['sandbox_diff'] : [])] });
      await agentTasks.transition(task, 'verifying', '执行器已返回，等待独立验证。');
      triggerWorkflowVerification(task);
    }
  } catch (error) {
    if (task.status === 'cancelled') await taskEvent(task, 'runner_closed', { code: 'TASK_CANCELLED' });
    else await agentTasks.fail(task, error);
    await taskEvent(task, 'error', { code: error.code || 'AGENT_TASK_FAILED' });
  } finally {
    activeAgentRuns.delete(task.id);
    if (sandbox && ['failed', 'cancelled'].includes(task.status)) await removeTaskSandbox(sandbox);
  }
};
const taskScheduler = createAgentScheduler({
  maxConcurrent: Number(process.env.AGENT_CONCURRENCY_MAX) || 3,
  getTask: id => state.agentTasks.find(item => item.id === id),
  runTask: runAgentTask,
  failTask: (task, reason) => agentTasks.transition(task, 'failed', reason)
});
for (const task of state.agentTasks.filter(item => item.status === 'submitted')) taskScheduler.enqueue(task);
const runRegistry = createRunRegistry({ activeRuns, streamRuns, send, streamRetentionMs });
const { finishRun, attachStreamResponse } = runRegistry;
const chatRuntime = createChatRuntime({
  state, saveState, getSession, touchSession, currentUserId, runtimeKey,
  agents, agentAvatar, createModelProvider, resolveModelSelection,
  buildRuntimeContext, findRegenerationTarget, routeMessage,
  recordDynamicAlphaObservation, chatMemoryForRequest, shouldRemember,
  maybeCompactConversation, executeTool, findTool, getToolRisk, toOpenAITools,
  createPiClient, agentTasks, taskScheduler, send, fail, activeRuns, streamRuns,
  attachStreamResponse, finishRun, chatRunTimeoutMs,
  waitForApproval: approvalRegistry.waitForApproval, randomUUID
});

app.get('/api/health', (_, res) => {
  const storage = getStorageStatus();
  const ok = storage.ready && model.ready;
  res.status(ok ? 200 : 503).json({ ok, status: ok ? 'ready' : 'degraded', service: 'cochpia', storageProvider, storageReady: storage.ready, databaseLatencyMs: storage.lastLatencyMs, lastStorageError: storage.lastError, modelProvider: model.provider, modelName: model.model, modelReady: model.ready, modelProtocol: model.protocol });
});
app.get('/api/ready', (_, res) => {
  const storage = getStorageStatus();
  const ready = storage.ready && model.ready;
  res.status(ready ? 200 : 503).json({ ready, storageReady: storage.ready, modelReady: model.ready });
});
app.get('/api/version', (_, res) => res.json({ service: 'cochpia', version: process.env.APP_VERSION || '0.1.0', node: process.version, environment: process.env.NODE_ENV || 'development' }));
app.get('/api/metrics', (_, res) => res.json(observability.getMetrics()));
app.get('/api/models', (_, res) => res.json({ defaultProvider: process.env.MODEL_PROVIDER || 'mock', providers: listModelProviders() }));
app.get('/api/dev/dynamic-alpha/observations', (req, res) => {
  if (process.env.NODE_ENV === 'production') return fail(res, 404, 'DEV_ROUTE_NOT_FOUND', 'Development route not available');
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  res.json({ observations: dynamicAlphaObservations.slice(-limit) });
});
app.get('/api/music/environment', async (_, res) => res.json(await music.environment()));
app.get('/api/music/status', async (_, res) => res.json(await music.status()));
app.get('/api/music/context', async (_, res) => res.json(await music.listeningContext()));
app.get('/api/music/search', async (req, res) => { try { res.json({ items: await music.search(req.query.q) }); } catch (error) { fail(res, error.code === 'INVALID_MUSIC_QUERY' ? 400 : 503, error.code || 'MUSIC_SEARCH_FAILED', error.message); } });
app.post('/api/music/play', async (req, res) => { try { res.json(await music.play(req.body?.track)); } catch (error) { fail(res, 503, error.code || 'MUSIC_PLAY_FAILED', error.message); } });
app.post('/api/music/pause', async (_, res) => { try { res.json(await music.pause()); } catch (error) { fail(res, 503, error.code || 'MUSIC_PAUSE_FAILED', error.message); } });
app.post('/api/music/resume', async (_, res) => { try { res.json(await music.resume()); } catch (error) { fail(res, 503, error.code || 'MUSIC_RESUME_FAILED', error.message); } });
app.post('/api/music/next', async (_, res) => { try { res.json(await music.next()); } catch (error) { fail(res, 503, error.code || 'MUSIC_NEXT_FAILED', error.message); } });
app.post('/api/music/stop', async (_, res) => { try { res.json(await music.stop()); } catch (error) { fail(res, 503, error.code || 'MUSIC_STOP_FAILED', error.message); } });
app.get('/api/sessions', (req, res) => {
  const ownedSessions = state.sessions.filter(session => sessionBelongsToCurrentUser(session, req.cochpiaUserId));
  if (req.query.paginated !== 'true' && !req.query.search && req.query.archived === undefined) return res.json(ownedSessions);
  const result = queryCollection(ownedSessions, { search: req.query.search, limit: req.query.limit, offset: req.query.offset, filter: session => req.query.archived === 'true' ? session.archived === true : req.query.archived === 'false' ? session.archived !== true : true });
  const items = result.items.sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(req.query.paginated === 'true' ? { ...result, items } : items);
});
app.post('/api/sessions', async (req, res) => {
  const kind = req.body?.kind === 'group' ? 'group' : 'private';
  const agentId = kind === 'private' && req.body?.agentId ? String(req.body.agentId).slice(0, 100) : null;
  if (agentId && !agents.get(agentId)) return fail(res, 404, 'AGENT_NOT_FOUND', 'The selected agent no longer exists');
  const session = { id: randomUUID(), ownerId: req.cochpiaUserId || currentUserId(), title: String(req.body?.title || '新的相遇').slice(0, 80), description: String(req.body?.description || '').trim().slice(0, 300), kind, agentId, groupMode: kind === 'group' ? (req.body?.groupMode === 'turn' ? 'turn' : 'parallel') : null, agentIds: Array.isArray(req.body?.agentIds) ? req.body.agentIds.map(String).slice(0, 20) : [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mode: 'companion', companionIntent: 'listen', ...defaultModelSelection() };
  state.sessions.unshift(session); state.messages[session.id] = []; await saveState(state); res.status(201).json(session);
});
app.patch('/api/sessions/:id', async (req, res) => {
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
app.get('/api/sessions/:id/model', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const selection = { modelProvider: session.modelProvider, modelName: session.modelName };
  const status = resolveModelSelection(selection.modelProvider, selection.modelName);
  res.json({ ...selection, ready: status.ok, error: status.ok ? null : status.error });
});
app.patch('/api/sessions/:id/model', async (req, res) => {
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
app.get('/api/sessions/:id/persona', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  res.json({ persona: session.persona || '' });
});
app.patch('/api/sessions/:id/persona', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  session.persona = String(req.body?.persona ?? '').trim().slice(0, 2000);
  touchSession(session); await saveState(state);
  res.json({ persona: session.persona });
});
app.get('/api/sessions/:id/messages', (req, res) => {
  if (!getSession(req.params.id, req.cochpiaUserId)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const channel = req.query.channel ? String(req.query.channel) : '';
  const allMessages = state.messages[req.params.id] || [];
  const scoped = (channel ? allMessages.filter(message => (message.channel || '默认') === channel) : allMessages)
    .map(message => resolveMessageAvatar(message, message.senderId ? agents.get(message.senderId) : null));
  if (req.query.paginated !== 'true' && !req.query.search) return res.json(scoped);
  const result = queryCollection(scoped, { search: req.query.search, limit: req.query.limit, offset: req.query.offset, text: message => message.content });
  res.json(req.query.paginated === 'true' ? result : result.items);
});
app.get('/api/sessions/:id/channels', (req, res) => {
  if (!getSession(req.params.id)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const counts = new Map();
  for (const message of state.messages[req.params.id] || []) {
    const name = message.channel || '默认';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  res.json([...counts.entries()].map(([name, count]) => ({ name, count })));
});
app.patch('/api/sessions/:id/messages/:messageId', async (req, res) => {
  if (!getSession(req.params.id)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const message = getMessage(req.params.id, req.params.messageId);
  if (!message) return fail(res, 404, 'MESSAGE_NOT_FOUND', 'Message not found');
  const content = String(req.body?.content || '').trim();
  if (!content) return fail(res, 400, 'INVALID_MESSAGE', 'Message content is required');
  message.content = content.slice(0, 8000); message.updatedAt = new Date().toISOString(); touchSession(getSession(req.params.id)); await saveState(state); res.json(message);
});
app.delete('/api/sessions/:id/messages/:messageId', async (req, res) => {
  if (!getSession(req.params.id)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const messages = state.messages[req.params.id] || [];
  const index = messages.findIndex(message => message.id === req.params.messageId);
  if (index === -1) return fail(res, 404, 'MESSAGE_NOT_FOUND', 'Message not found');
  messages.splice(index, 1); touchSession(getSession(req.params.id)); await saveState(state); res.status(204).end();
});
app.patch('/api/sessions/:id', async (req, res) => {
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
app.delete('/api/sessions/:id', async (req, res) => {
  const index = state.sessions.findIndex(session => session.id === req.params.id && sessionBelongsToCurrentUser(session, req.cochpiaUserId));
  if (index === -1) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  state.sessions.splice(index, 1); delete state.messages[req.params.id]; await saveState(state); res.status(204).end();
});
app.get('/api/agents', (_, res) => res.json(agents.list()));
app.post('/api/agents', async (req, res) => { try { res.status(201).json(await agents.create(req.body || {})); } catch (error) { fail(res, 400, 'INVALID_AGENT', error.message); } });
app.patch('/api/agents/:id', async (req, res) => { try { const agent = await agents.update(req.params.id, req.body || {}); agent ? res.json(agent) : fail(res, 404, 'AGENT_NOT_FOUND', 'Agent not found'); } catch (error) { fail(res, 400, 'INVALID_AGENT', error.message); } });
app.delete('/api/agents/:id', async (req, res) => { const removed = await agents.remove(req.params.id); removed ? res.status(204).end() : fail(res, 404, 'AGENT_NOT_FOUND', 'Agent not found'); });
app.get('/api/sync', (req, res) => {
  try { return res.json({ version: 1, syncedAt: new Date().toISOString(), ...collectSyncChanges(state, { cursor: req.query.cursor, limit: req.query.limit }) }); }
  catch (error) { return fail(res, 400, 'INVALID_SYNC_CURSOR', error.message); }
});
app.get('/api/memories', async (req, res) => {
  const memories = await compatibilityMemoryForRequest(req).list(req.query.paginated === 'true' ? { ...req.query, limit: 100 } : req.query);
  if (req.query.paginated !== 'true') return res.json(memories);
  const result = queryCollection(memories, { search: req.query.search, limit: req.query.limit, offset: req.query.offset, text: item => `${item.summary} ${item.type} ${item.source}` });
  return res.json(result);
});
app.post('/api/memories', async (req, res) => { try { res.status(201).json(await compatibilityMemoryForRequest(req).hold(req.body || {})); } catch (error) { fail(res, 400, 'INVALID_MEMORY', error.message); } });
app.get('/api/memories/export', async (req, res) => {
  const memories = await compatibilityMemoryForRequest(req).exportMemories();
  res.set('Content-Disposition', 'attachment; filename="cochpia-memories.json"');
  res.json({ exportedAt: new Date().toISOString(), version: 1, memories });
});
app.get('/api/export', async (req, res) => {
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
app.post('/api/import', async (req, res) => {
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
app.get('/api/preferences', (_, res) => res.json({ preferences: state.workspacePreferences || null, updatedAt: state.workspacePreferencesUpdatedAt || null }));
app.patch('/api/preferences', async (req, res) => {
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
app.post('/api/memories/batch', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String).filter(Boolean))] : [];
  if (!ids.length) return fail(res, 400, 'INVALID_MEMORY_BATCH', 'At least one memory id is required');
  if (req.body?.action !== 'revoke') return fail(res, 400, 'INVALID_MEMORY_BATCH_ACTION', 'Only revoke is supported');
  const compatibility = compatibilityMemoryForRequest(req);
  const results = await Promise.all(ids.map(id => compatibility.revoke(id)));
  res.json({ requested: ids.length, revoked: results.filter(Boolean).length, memories: results.filter(Boolean) });
});
app.post('/api/memories/:id/revoke', async (req, res) => { const item = await compatibilityMemoryForRequest(req).revoke(req.params.id); item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found'); });
app.get('/api/memories/:id', async (req, res) => { const item = await compatibilityMemoryForRequest(req).get(req.params.id); item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found'); });
app.patch('/api/memories/:id', async (req, res) => { try { const item = await compatibilityMemoryForRequest(req).update(req.params.id, req.body || {}); item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found'); } catch (error) { fail(res, 400, 'INVALID_MEMORY', error.message); } });
app.delete('/api/memories/:id', async (req, res) => { const removed = await compatibilityMemoryForRequest(req).remove(req.params.id); removed ? res.status(204).end() : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found'); });
app.get('/api/memory/overview', async (req, res) => {
  try {
    const { memories } = await chatMemoryForRequest(req).overview();
    res.json({ count: memories.length, memories: memories.slice(0, 8), memorySystem: 'memory-module' });
  } catch (error) {
    fail(res, error.status || 503, error.code || 'MEMORY_MODULE_UNAVAILABLE', error.message || 'Memory Module unavailable');
  }
});
app.post('/api/models/:provider/test', async (req, res) => {
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
app.post('/api/chat/cancel', (req, res) => {
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
app.get('/api/chat/stream/:runId', (req, res) => {
  const run = streamRuns.get(req.params.runId);
  if (!run || run.userId !== currentUserId()) return fail(res, 404, 'STREAM_RUN_NOT_FOUND', 'Stream run not found');
  if (run.response && !run.response.writableEnded && !run.response.destroyed) run.response.end();
  attachStreamResponse(run, res, req.get('last-event-id') || req.query.afterEventId || '');
  if (run.finished) res.end();
});
app.get('/api/memory/dream', async (req, res) => res.json({ memories: await compatibilityMemoryForRequest(req).dream(req.query.limit), generatedAt: new Date().toISOString() }));
app.get('/api/profile', (_, res) => res.json(state.profile));
app.patch('/api/profile', async (req, res) => {
  try {
    const input = req.body || {};
    if (input.name !== undefined) {
      const name = String(input.name).trim().slice(0, 20);
      if (!name) return fail(res, 400, 'INVALID_NAME', 'Name is required');
      state.profile.name = name;
    }
    if (input.gender !== undefined) {
      const gender = String(input.gender);
      if (!['none', 'male', 'female', 'other'].includes(gender)) return fail(res, 400, 'INVALID_GENDER', 'Invalid gender');
      state.profile.gender = gender;
    }
    if (input.age !== undefined) {
      if (input.age === null) state.profile.age = null;
      else {
        const age = Number(input.age);
        if (!Number.isFinite(age) || age < 0 || age > 90) return fail(res, 400, 'INVALID_AGE', 'Age must be between 0 and 90');
        state.profile.age = age;
      }
    }
    if (input.avatar !== undefined) state.profile.avatar = String(input.avatar).slice(0, 8) || '✦';
    if (input.avatarImage !== undefined) {
      const avatarImage = String(input.avatarImage || '');
      if (avatarImage && !avatarImage.startsWith('data:image/')) return fail(res, 400, 'INVALID_AVATAR_IMAGE', 'Avatar image must be a data URL');
      if (avatarImage.length > 400000) return fail(res, 400, 'AVATAR_IMAGE_TOO_LARGE', 'Avatar image is too large');
      state.profile.avatarImage = avatarImage || null;
    }
    if (input.characterSheet !== undefined) {
      const characterSheet = String(input.characterSheet || '');
      if (characterSheet && !characterSheet.startsWith('data:image/')) return fail(res, 400, 'INVALID_CHARACTER_SHEET', 'Character sheet must be a data URL');
      if (characterSheet.length > 2000000) return fail(res, 400, 'CHARACTER_SHEET_TOO_LARGE', 'Character sheet is too large');
      state.profile.characterSheet = characterSheet || null;
    }
    if (input.characterAnimation !== undefined) {
      if (input.characterAnimation === null) state.profile.characterAnimation = null;
      else {
        const animation = input.characterAnimation;
        if (typeof animation !== 'object' || !Number.isFinite(Number(animation.frameWidth)) || !Number.isFinite(Number(animation.frameHeight))) {
          return fail(res, 400, 'INVALID_CHARACTER_ANIMATION', 'Character animation is invalid');
        }
        state.profile.characterAnimation = animation;
      }
    }
    state.profile.updatedAt = new Date().toISOString();
    await saveState(state);
    return res.json(state.profile);
  } catch (error) { return fail(res, 400, 'INVALID_PROFILE', error.message); }
});
app.get('/api/mode', (req, res) => {
  const session = req.query.sessionId ? getSession(String(req.query.sessionId)) : null;
  res.json({ mode: session?.mode || state.mode, companionIntent: session?.companionIntent || 'listen', sessionId: session?.id || null });
});

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
app.post('/api/workflows', (_, res) => {
  try { return res.json({ workflows: listWorkflows() }); }
  catch (error) { return fail(res, 500, error.code || 'WORKFLOW_LIST_FAILED', error.message); }
});
app.post('/api/workflows/:id/run', async (req, res) => {
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
app.get('/api/workflows/runs/:id', (req, res) => {
  const run = collaborationRunById(req.params.id, agentTaskOwner());
  if (!run || run.ownerId !== agentTaskOwner()) return fail(res, 404, 'WORKFLOW_RUN_NOT_FOUND', 'Workflow run not found');
  return res.json(collaborationRunView(run));
});
app.post('/api/proposals', async (req, res) => {
  try { const proposal = await proposals.create(req.body || {}, agentTaskOwner()); await saveState(state); return res.status(201).json({ proposal }); }
  catch (error) { return fail(res, 400, error.code || 'PROPOSAL_INVALID', error.message); }
});
app.get('/api/proposals', (req, res) => res.json({ proposals: proposals.list(agentTaskOwner()) }));
app.post('/api/proposals/:id/approve', async (req, res) => {
  try {
    const proposal = await proposals.approve(req.params.id, agentTaskOwner());
    if (!proposal) return fail(res, 404, 'PROPOSAL_NOT_FOUND', 'Proposal not found');
    await saveState(state);
    return res.json({ proposal });
  } catch (error) { return fail(res, 400, error.code || 'PROPOSAL_APPROVE_FAILED', error.message); }
});
app.post('/api/proposals/:id/reject', async (req, res) => {
  const proposal = proposals.reject(req.params.id, agentTaskOwner());
  if (!proposal) return fail(res, 404, 'PROPOSAL_NOT_FOUND', 'Proposal not found');
  await saveState(state);
  return res.json({ proposal });
});
app.get('/api/workbench/agents', (_, res) => res.json({ agents: [
  { id: 'codex', label: 'Codex', protocol: 'codex-app-server', available: Boolean(process.env.CODEX_BIN || process.env.CODEX_ENABLED !== 'false') },
  { id: 'pi', label: 'Pi Agent', protocol: 'pi-rpc', available: process.env.PI_ENABLED !== 'false' },
  { id: 'claude', label: 'Claude Code', protocol: 'claude-cli-stream-json', available: Boolean(process.env.CLAUDE_BIN || process.env.CLAUDE_ENABLED === 'true') }
] }));
app.get('/api/workbench/tasks', (_, res) => res.json({ tasks: agentTasks.list(agentTaskOwner()) }));
app.get('/api/workbench/tasks/:id', (req, res) => {
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
app.post('/api/workbench/tasks/:id/verify', async (req, res) => {
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
app.post('/api/workbench/tasks/:id/review', async (req, res) => {
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
app.post('/api/workbench/tasks/:id/merge', async (req, res) => {
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
app.post('/api/workbench/tasks/:id/discard', async (req, res) => {
  const task = agentTasks.get(req.params.id, agentTaskOwner());
  if (!task) return fail(res, 404, 'TASK_NOT_FOUND', 'Task not found');
  if (!['reviewing', 'completed', 'failed'].includes(task.status)) return fail(res, 409, 'TASK_NOT_READY_FOR_DISCARD', 'Task is not ready to discard');
  if (task.sandboxPath) await removeTaskSandbox({ path: task.sandboxPath, root: process.cwd(), parent: path.dirname(task.sandboxPath), mode: 'git-worktree' });
  await taskEvent(task, 'sandbox_discarded', { discarded: true });
  if (task.status === 'reviewing') await agentTasks.transition(task, 'completed', '已丢弃隔离目录变更。');
  taskScheduler.notify(task);
  return res.json({ task });
});
app.post('/api/workbench/tasks', async (req, res) => {
  try {
    const task = await agentTasks.create(req.body || {}, agentTaskOwner());
    taskScheduler.enqueue(task);
    return res.status(202).json({ task });
  } catch (error) { return fail(res, 400, error.code || 'TASK_INVALID', error.message); }
});
app.post('/api/workbench/tasks/:id/cancel', async (req, res) => {
  const task = agentTasks.get(req.params.id, agentTaskOwner());
  if (!task) return fail(res, 404, 'TASK_NOT_FOUND', 'Task not found');
  const runner = activeAgentRuns.get(task.id);
  if (runner?.close) runner.close();
  try { await agentTasks.transition(task, 'cancelled', '用户取消任务'); taskScheduler.notify(task); return res.json(task); }
  catch (error) { return fail(res, 409, 'TASK_CANCEL_FAILED', error.message); }
});
app.post('/api/workbench/tasks/:id/approve', async (req, res) => {
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
app.post('/api/workbench/tasks/:id/gate', async (req, res) => {
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
app.patch('/api/mode', async (req, res) => {
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
app.post('/api/chat/approve', (req, res) => {
  return approvalRegistry.respondApproval(req, res, fail);
});
// 文件上传：手机/网页上传文件到服务端，供工作模式 read 工具处理
app.post('/api/upload', async (req, res) => {
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

app.post('/api/chat/stream', (req, res) => chatRuntime.handleChatStream(req, res));
app.post('/api/chat/regenerate', (req, res) => chatRuntime.handleChatStream(req, res, { regenerateMessageId: String(req.body?.messageId || '').trim() || null }));
app.post('/api/chat/retry', (req, res) => chatRuntime.handleChatStream(req, res, { regenerateMessageId: String(req.body?.messageId || '').trim() || null, retry: true }));

app.post('/api/chat/group', (req, res) => chatRuntime.handleGroupChat(req, res));

app.post('/mcp', async (req, res) => {
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

app.use('/api', (_, res) => fail(res, 404, 'API_ROUTE_NOT_FOUND', 'API route not found'));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const code = error.code || 'INTERNAL_ERROR';
  const status = error.status || (code === 'CORS_ORIGIN_NOT_ALLOWED' ? 403 : (code.startsWith('STORAGE_') || code.startsWith('DATABASE_') ? 503 : 500));
  console.error(JSON.stringify({ event: 'request_error', code, requestId: req.requestId, traceId: req.traceId, method: req.method, path: req.path }));
  return fail(res, status, code, error.message || 'Internal server error');
});

const clientDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
app.use(express.static(clientDist));
app.use((_, res) => res.sendFile(path.join(clientDist, 'index.html')));
app.listen(port, () => {
  console.log(`Cochpia server listening on http://localhost:${port}`);
  void cleanupOrphanTaskSandboxes({ maxAgeMs: Number(process.env.TASK_SANDBOX_MAX_AGE_MS) || 24 * 60 * 60 * 1000 });
});
