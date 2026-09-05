import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryModuleState } from '../server/memory-module.js';
import { CoreV0Error, createCoreV0TurnService } from '../server/core-v0.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function unitState(sessionId = 'unit-session') {
  return {
    sessions: [{ id: sessionId, summary: '', persona: '', atmosphere: '', companionIntent: 'listen' }],
    messages: { [sessionId]: [] },
    personality: { version: 1, summary: 'acceptance', traits: [] },
    profile: { name: 'Cochpia', gender: 'none', age: null }
  };
}
function unitInput(key, message = '验收消息', sessionId = 'unit-session') {
  return { body: { sessionId, message, channel: '默认' }, headerIdempotencyKey: key };
}

function unitPort({ ensure, append, retrieve } = {}) {
  const calls = { ensure: 0, append: 0, retrieve: 0, lookupEvent: 0 };
  return {
    calls,
    async ensureSessionBinding(args) {
      calls.ensure += 1;
      return ensure ? ensure(args, calls) : { status: 'completed', memorySessionId: 'unit-memory' };
    },
    async appendRawEvent(args) {
      calls.append += 1;
      return append ? append(args, calls) : { status: 'completed', receipt: { status: 'completed', eventId: args.event.eventId } };
    },
    async retrieveContext(args) {
      calls.retrieve += 1;
      return retrieve ? retrieve(args, calls) : { status: 'available', answerability: 'not_found', recalled: [], bundle: null };
    }
  };
}

function serviceFor(state, memoryPort, options = {}) {
  return createCoreV0TurnService({
    state,
    context: { tenantId: 'acceptance-tenant', subjectUserId: 'acceptance-user', actorType: 'user', actorId: 'acceptance-user', callerAgentId: 'cochpia' },
    memoryPort,
    persist: options.persist || (async () => {}),
    modelGateway: options.modelGateway || { generate: async () => ({ content: 'acceptance response' }) },
    commitWriter: options.commitWriter
  });
}

async function listen(app) {
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body, text };
}

function result(id, passed, detail) {
  return { id, status: passed ? 'passed' : 'fail', detail };
}

async function runUnitAcceptance() {
  const results = [];

  {
    const state = unitState();
    const port = unitPort({ retrieve: async () => { throw Object.assign(new Error('retrieval unavailable'), { code: 'MEMORY_RETRIEVE_FAILED', status: 503 }); } });
    const service = serviceFor(state, port);
    const response = await service.handleTurn(unitInput('acceptance-degraded'));
    results.push(result('A-05', response.status === 'committed' && response.memoryStatus === 'degraded', 'retrieval degradation is explicit and the turn still commits'));
  }

  {
    const state = unitState();
    let admitted = false;
    const port = unitPort({ ensure: async () => admitted ? { status: 'completed', memorySessionId: 'pending-memory' } : { status: 'pending' } });
    let modelCalls = 0;
    const service = serviceFor(state, port, { modelGateway: { generate: async () => { modelCalls += 1; return { content: 'unexpected' }; } } });
    const pending = await service.handleTurn(unitInput('acceptance-pending'));
    const noModelBeforeAdmission = pending.status === 'pending' && modelCalls === 0 && state.messages['unit-session'].length === 0;
    admitted = true;
    const completed = await service.handleTurn(unitInput('acceptance-pending'));
    results.push(result('A-06', noModelBeforeAdmission && completed.status === 'committed' && modelCalls === 1, 'unknown admission remains pending until the same turn is retried'));
  }

  {
    const state = unitState();
    const port = unitPort();
    const service = serviceFor(state, port, {
      commitWriter: async () => { throw new CoreV0Error('COMMIT_REJECTED', 'commit rejected', { status: 503, retryable: true }); }
    });
    let failed = false;
    try { await service.handleTurn(unitInput('acceptance-commit-failure')); } catch (error) { failed = error.code === 'COMMIT_REJECTED'; }
    const noAssistant = state.messages['unit-session'].every(message => message.role !== 'assistant');
    results.push(result('A-07', failed && noAssistant && state.coreV0.turnAdmissions[0].status === 'failed', 'commit failure leaves no visible assistant success'));
  }

  {
    const state = unitState();
    const firstPort = unitPort({ append: async () => { throw new Error('response lost after Memory write'); } });
    const firstService = serviceFor(state, firstPort);
    const pending = await firstService.handleTurn(unitInput('acceptance-restart'));
    const turn = state.coreV0.turnAdmissions[0];
    const secondPort = unitPort();
    secondPort.getRawEventReceipt = async () => {
      secondPort.calls.lookupEvent += 1;
      return { status: 'completed', receipt: { status: 'completed', eventId: turn.eventId, rawEventId: 'reconciled-raw-event' } };
    };
    const secondService = serviceFor(state, secondPort);
    const completed = await secondService.reconcileTurn(turn.turnId);
    const safe = pending.status === 'pending'
      && completed.status === 'committed'
      && secondPort.calls.ensure === 0
      && secondPort.calls.append === 0
      && secondPort.calls.lookupEvent === 1;
    results.push(result('A-08', safe, 'restart reconciliation reuses the persisted turn and event identifiers'));
  }

  return results;
}

export async function runCoreV0Acceptance({ legacy, target }) {
  process.env.AUTH_MODE = 'off';
  process.env.STORAGE_PROVIDER = 'json';
  process.env.CORE_V0_ENABLED = 'true';
  process.env.MEMORY_SERVICE_TOKEN = 'acceptance-memory-service-token';
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cochpia-core-v0-runtime-'));
  process.env.COCHPIA_DATA_DIR = dataDir;
  const sessionId = target.request.sessionId;
  const seed = {
    sessions: [{ id: sessionId, title: 'Core v0 acceptance', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    messages: { [sessionId]: [] },
    memoryModule: createMemoryModuleState(),
    personality: { version: 1, traits: [{ key: 'warmth', label: '温度感', value: 0.68 }], summary: '验收人格', updatedAt: new Date().toISOString() },
    evidence: []
  };
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify(seed, null, 2), 'utf8');

  const { app } = await import(pathToFileURL(path.join(repoRoot, 'server/index.js')).href);
  const { server, base } = await listen(app);
  try {
    const targetBody = { sessionId: target.request.sessionId, message: target.request.message, channel: target.request.channel };
    const targetKey = target.request.headers['Idempotency-Key'];
    const first = await request(base, target.path, { method: 'POST', headers: { 'Idempotency-Key': targetKey }, body: JSON.stringify(targetBody) });
    const afterFirst = await request(base, '/api/export');
    const firstState = afterFirst.body?.state || {};
    const firstCore = firstState.coreV0 || {};
    const firstTurn = firstCore.turnAdmissions?.[0];
    const firstBinding = firstCore.memorySessionBindings?.[0];
    const firstPass = first.response.status === 200
      && first.body?.status === 'committed'
      && firstCore.turnAdmissions?.length === 1
      && firstCore.memorySessionBindings?.length === 1
      && firstCore.assistantCommits?.length === 1
      && firstState.messages?.[sessionId]?.filter(message => message.role === 'user').length === 1
      && firstState.memoryModule?.rawEvents?.length === 1;

    const replay = await request(base, target.path, { method: 'POST', headers: { 'Idempotency-Key': targetKey }, body: JSON.stringify(targetBody) });
    const afterReplay = await request(base, '/api/export');
    const replayState = afterReplay.body?.state || {};
    const replayPass = replay.response.status === 200
      && replay.body?.status === 'committed'
      && replay.body?.replay === true
      && replay.body?.turnId === first.body?.turnId
      && replayState.coreV0?.turnAdmissions?.length === 1
      && replayState.memoryModule?.rawEvents?.length === 1;

    const conflict = await request(base, target.path, { method: 'POST', headers: { 'Idempotency-Key': targetKey }, body: JSON.stringify({ ...targetBody, message: '冲突重放' }) });
    const conflictPass = conflict.response.status === 409 && conflict.body?.error?.code === 'IDEMPOTENCY_KEY_CONFLICT';

    const bindingKeys = (firstCore.memorySessionBindings || []).map(binding => `${binding.tenantId}:${binding.subjectUserId}:${binding.applicationSessionId}`);
    const memoryKeys = (firstCore.memorySessionBindings || []).map(binding => `${binding.tenantId}:${binding.subjectUserId}:${binding.memorySessionId}`);
    const bindingPass = firstBinding?.status === 'completed'
      && firstBinding.memorySessionId === firstTurn?.memorySessionId
      && new Set(bindingKeys).size === bindingKeys.length
      && new Set(memoryKeys).size === memoryKeys.length
      && firstState.memoryModule?.sessions?.some(session => session.id === firstBinding.memorySessionId);

    const unitResults = await runUnitAcceptance();

    const noServiceIdentity = await request(base, '/v1/events', { method: 'POST', body: JSON.stringify({ event_id: 'acceptance-direct-event', content: 'direct write' }) });
    const a09 = noServiceIdentity.response.status === 403 && noServiceIdentity.body?.error?.code === 'MEMORY_SERVICE_IDENTITY_REQUIRED';
    const missingWriteContext = await request(base, '/v1/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer acceptance-memory-service-token' },
      body: JSON.stringify({ event_id: 'acceptance-context-event', content: 'direct write' })
    });
    const a10 = missingWriteContext.response.status === 400 && missingWriteContext.body?.error?.code === 'MEMORY_WRITE_CONTEXT_REQUIRED';
    const bypass = await request(base, '/api/memories', { method: 'POST', body: JSON.stringify({ sessionId, message: 'chat bypass' }) });
    const a11 = bypass.response.status === 400 && bypass.body?.error?.code === 'MEMORY_CHAT_BYPASS_FORBIDDEN';

    const legacyResponse = await request(base, legacy.path, {
      method: 'POST',
      body: JSON.stringify({ sessionId: legacy.request.sessionId, message: target.request.message, channel: legacy.request.channel, provider: 'mock' })
    });
    const hasDoneEvent = typeof legacyResponse.text === 'string' && legacyResponse.text.includes('event: done');
    const afterLegacy = await request(base, '/api/export');
    const legacyMessages = afterLegacy.body?.state?.messages?.[sessionId] || [];
    const checkpointPass = ['turnId', 'applicationMessageId', 'eventId', 'sourceRevision'].every(key => firstTurn?.[key]);
    const a12 = legacyResponse.response.status === 200
      && hasDoneEvent
      && legacyMessages.some(message => message.role === 'assistant' && message.content)
      && checkpointPass;

    return [
      result('A-01', firstPass, 'target turn creates one durable binding, admission, raw event and assistant commit'),
      result('A-02', replayPass, 'exact replay returns the original receipt without new canonical facts'),
      result('A-03', conflictPass, 'conflicting idempotency replay is rejected before external calls'),
      result('A-04', Boolean(bindingPass), 'application and Memory session binding keys are unique and immutable'),
      ...unitResults.filter(item => ['A-05', 'A-06', 'A-07', 'A-08'].includes(item.id)),
      result('A-09', a09, 'direct Memory event write requires a verified service identity'),
      result('A-10', a10, 'direct Memory mutation requires producer, correlation and idempotency context'),
      result('A-11', a11, 'Memory governance route rejects Core chat-event bypass payloads'),
      result('A-12', a12, 'legacy and target paths both complete the scenario with target checkpoints; legacy gaps remain explicit')
    ];
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
