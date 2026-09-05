import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreV0Error, createCoreV0ContextBuilder, createCoreV0TurnService } from './core-v0.js';

function createState() {
  return {
    sessions: [{ id: 'session-1', summary: '', persona: '', atmosphere: '', companionIntent: 'listen' }],
    messages: { 'session-1': [] },
    personality: { version: 1, summary: 'test', traits: [] },
    profile: { name: 'Cochpia', gender: 'none', age: null }
  };
}

function createPort({ bindingId = 'memory-1', ensure, append, retrieve } = {}) {
  const calls = { ensure: 0, append: 0, retrieve: 0, lookupBinding: 0, lookupEvent: 0 };
  const port = {
    calls,
    async ensureSessionBinding(args) {
      calls.ensure += 1;
      if (ensure) return ensure(args, calls);
      return { status: 'completed', memorySessionId: bindingId, receipt: { status: 'completed', memorySessionId: bindingId } };
    },
    async appendRawEvent(args) {
      calls.append += 1;
      if (append) return append(args, calls);
      return { status: 'completed', receipt: { status: 'completed', eventId: args.event.eventId, rawEventId: `raw:${args.event.eventId}` } };
    },
    async retrieveContext(args) {
      calls.retrieve += 1;
      if (retrieve) return retrieve(args, calls);
      return { status: 'available', answerability: 'not_found', recalled: [], bundle: null };
    }
  };
  return port;
}

function createService(state, memoryPort, options = {}) {
  return createCoreV0TurnService({
    state,
    context: { tenantId: 'tenant-1', subjectUserId: 'user-1', actorType: 'user', actorId: 'user-1', callerAgentId: 'cochpia' },
    persist: options.persist || (async () => {}),
    memoryPort,
    modelGateway: options.modelGateway || { generate: async () => ({ status: 'generation_succeeded', content: 'fixture response' }) },
    contextBuilder: options.contextBuilder,
    commitWriter: options.commitWriter,
    enabled: options.enabled
  });
}

function input(key, message = '我今天有点累', sessionId = 'session-1') {
  return { body: { sessionId, message, channel: '默认' }, headerIdempotencyKey: key };
}

test('Core v0 context builder bounds history, recalled text, and session prompt fields', () => {
  const builder = createCoreV0ContextBuilder({ maxMessages: 1, maxRecalled: 1 });
  const context = builder({
    state: { personality: { version: 1, summary: '', traits: [] }, profile: null },
    session: { summary: 's'.repeat(5000), persona: 'p'.repeat(3000), atmosphere: 'a'.repeat(500) },
    messages: [{ id: 'old', role: 'user', content: 'old' }, { id: 'new', role: 'user', content: 'm'.repeat(5000) }],
    recalled: [{ id: 'memory', summary: 'r'.repeat(3000) }]
  });
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].content.length, 4000);
  assert.equal(context.recalled[0].summary.length, 2000);
  assert.equal(context.summary.length, 4000);
  assert.equal(context.persona.length, 2000);
  assert.equal(context.atmosphere.length, 200);
});

test('Core v0 admits once, commits once, replays exactly, and increments source revisions', async () => {
  const state = createState();
  const port = createPort();
  const model = { calls: 0, async generate() { this.calls += 1; return { content: 'fixture response' }; } };
  const service = createService(state, port, { modelGateway: model });

  const first = await service.handleTurn(input('turn-key-1'));
  assert.equal(first.status, 'committed');
  assert.equal(state.coreV0.turnAdmissions.length, 1);
  assert.equal(state.coreV0.sequence, 1);
  assert.equal(state.coreV0.turnAdmissions[0].sourceRevision, '1');
  assert.equal(state.coreV0.turnAdmissions[0].commitId, `assistant:${first.assistantMessageId}`);
  assert.equal(state.messages['session-1'].filter(message => message.role === 'assistant').length, 1);
  assert.deepEqual(port.calls, { ensure: 1, append: 1, retrieve: 1, lookupBinding: 0, lookupEvent: 0 });
  assert.equal(model.calls, 1);

  const replay = await service.handleTurn(input('turn-key-1'));
  assert.equal(replay.status, 'committed');
  assert.equal(replay.replay, true);
  assert.equal(replay.turnId, first.turnId);
  assert.equal(state.coreV0.sequence, 1);
  assert.deepEqual(port.calls, { ensure: 1, append: 1, retrieve: 1, lookupBinding: 0, lookupEvent: 0 });
  assert.equal(model.calls, 1);

  await assert.rejects(() => service.handleTurn(input('turn-key-1', '不同内容')), error => error.code === 'IDEMPOTENCY_KEY_CONFLICT' && error.status === 409);
  assert.equal(state.coreV0.turnAdmissions.length, 1);

  const second = await service.handleTurn(input('turn-key-2', '第二轮消息'));
  assert.equal(second.status, 'committed');
  assert.equal(state.coreV0.turnAdmissions.length, 2);
  assert.equal(state.coreV0.turnAdmissions[1].sourceRevision, '2');
  assert.equal(port.calls.ensure, 1);
  assert.equal(port.calls.append, 2);
  assert.equal(model.calls, 2);
});

test('Core v0 serializes distinct turns in one session before allocating source revisions', async () => {
  const state = createState();
  const port = createPort({
    append: async ({ event }) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { status: 'completed', receipt: { status: 'completed', eventId: event.eventId } };
    }
  });
  const service = createService(state, port);

  const results = await Promise.all([
    service.handleTurn(input('concurrent-key-1', '第一条')),
    service.handleTurn(input('concurrent-key-2', '第二条'))
  ]);

  assert.equal(results.every(result => result.status === 'committed'), true);
  assert.deepEqual(state.coreV0.turnAdmissions.map(turn => turn.sourceRevision).sort(), ['1', '2']);
  assert.equal(new Set(state.coreV0.turnAdmissions.map(turn => turn.eventId)).size, 2);
  assert.equal(port.calls.ensure, 1);
  assert.equal(port.calls.append, 2);
});

test('Core v0 scopes failure rollback to the affected session', async () => {
  const state = createState();
  state.sessions.push({ id: 'session-2', summary: '', persona: '', atmosphere: '', companionIntent: 'listen' });
  state.messages['session-2'] = [];
  let releaseFailedAppend;
  let appendStarted;
  const appendReady = new Promise(resolve => { appendStarted = resolve; });
  const failureRelease = new Promise(resolve => { releaseFailedAppend = resolve; });
  const port = createPort({
    ensure: async ({ applicationSessionId }) => ({ status: 'completed', memorySessionId: `memory-${applicationSessionId}` }),
    append: async ({ event }) => {
      if (event.applicationSessionId === 'session-1') {
        appendStarted();
        await failureRelease;
        throw new Error('session-1 Memory response lost');
      }
      return { status: 'completed', receipt: { status: 'completed', eventId: event.eventId } };
    }
  });
  const service = createService(state, port);
  const failingTurn = service.handleTurn(input('scoped-failure-1', '第一会话失败'));
  await appendReady;
  const successfulTurn = await service.handleTurn(input('scoped-failure-2', '第二会话成功', 'session-2'));
  releaseFailedAppend();
  const pendingTurn = await failingTurn;

  assert.equal(successfulTurn.status, 'committed');
  assert.equal(pendingTurn.status, 'pending');
  assert.equal(state.coreV0.turnAdmissions.filter(turn => turn.applicationSessionId === 'session-2').length, 1);
  assert.equal(state.coreV0.turnAdmissions.find(turn => turn.applicationSessionId === 'session-2').status, 'committed');
  assert.equal(state.messages['session-2'].filter(message => message.role === 'assistant').length, 1);
});

test('Core v0 makes retrieval degradation explicit while continuing the turn', async () => {
  const state = createState();
  const port = createPort({ retrieve: async () => { throw Object.assign(new Error('memory down'), { code: 'MEMORY_RETRIEVE_FAILED', status: 503 }); } });
  const service = createService(state, port, { modelGateway: { generate: async ({ recalled }) => ({ content: recalled.length ? 'bad' : 'degraded response' }) } });

  const result = await service.handleTurn(input('degraded-key'));
  assert.equal(result.status, 'committed');
  assert.equal(result.memoryStatus, 'degraded');
  assert.equal(state.coreV0.turnAdmissions[0].memoryStatus, 'degraded');
  assert.equal(state.messages['session-1'].filter(message => message.role === 'assistant').length, 1);
});

test('Core v0 keeps unknown admission outcomes pending and does not call the model', async () => {
  const state = createState();
  let ready = false;
  const port = createPort({ ensure: async () => ready
    ? { status: 'completed', memorySessionId: 'memory-1' }
    : { status: 'pending' } });
  const model = { calls: 0, async generate() { this.calls += 1; return { content: 'should not run first' }; } };
  const service = createService(state, port, { modelGateway: model });

  const pending = await service.handleTurn(input('pending-key'));
  assert.equal(pending.status, 'pending');
  assert.equal(pending.receiptId, `admission:${pending.turnId}`);
  assert.equal(state.coreV0.turnAdmissions[0].status, 'pending');
  assert.equal(state.messages['session-1'].length, 0);
  assert.equal(model.calls, 0);

  ready = true;
  const completed = await service.handleTurn(input('pending-key'));
  assert.equal(completed.status, 'committed');
  assert.equal(completed.turnId, pending.turnId);
  assert.equal(model.calls, 1);
});

test('Core v0 can reconcile a pending turn while new admissions are disabled', async () => {
  const state = createState();
  let admitted = false;
  const port = createPort({ ensure: async () => admitted
    ? { status: 'completed', memorySessionId: 'memory-1' }
    : { status: 'pending' } });
  const enabledService = createService(state, port);
  const pending = await enabledService.handleTurn(input('disabled-reconcile'));
  assert.equal(pending.status, 'pending');

  admitted = true;
  const disabledService = createService(state, port, { enabled: false });
  const completed = await disabledService.reconcileTurn(pending.turnId);
  assert.equal(completed.status, 'committed');
  assert.equal(completed.turnId, pending.turnId);
});

test('Core v0 rejects secret-like message content before creating a durable turn', async () => {
  const state = createState();
  const port = createPort();
  const service = createService(state, port);

  await assert.rejects(
    () => service.handleTurn(input('secret-message', '请处理 sk-test_12345678901234567890')),
    error => error.code === 'MESSAGE_CONTENT_BLOCKED' && error.status === 422
  );
  assert.equal(state.coreV0?.turnAdmissions?.length || 0, 0);
  assert.equal(state.messages['session-1'].length, 0);
  assert.deepEqual(port.calls, { ensure: 0, append: 0, retrieve: 0, lookupBinding: 0, lookupEvent: 0 });
});

test('Core v0 rejects an immutable binding conflict', async () => {
  const state = createState();
  state.coreV0 = {
    memorySessionBindings: [{
      bindingId: 'binding-1', bindingKey: 'tenant-1:user-1:session-1', tenantId: 'tenant-1', subjectUserId: 'user-1',
      applicationSessionId: 'session-1', memorySessionId: 'memory-a', memoryContractVersion: 'v1', status: 'pending'
    }]
  };
  const port = createPort({ bindingId: 'memory-b' });
  const service = createService(state, port);

  await assert.rejects(() => service.handleTurn(input('binding-conflict')), error => error.code === 'SESSION_BINDING_CONFLICT' && error.status === 409);
  assert.equal(state.coreV0.memorySessionBindings[0].memorySessionId, 'memory-a');
  assert.equal(state.coreV0.turnAdmissions[0].status, 'failed');
  assert.equal(state.messages['session-1'].length, 0);
});

test('Core v0 does not expose an assistant message when commit fails', async () => {
  const state = createState();
  const port = createPort();
  const service = createService(state, port, {
    commitWriter: async () => { throw new CoreV0Error('COMMIT_REJECTED', 'commit rejected', { status: 503, retryable: true }); }
  });

  await assert.rejects(() => service.handleTurn(input('commit-failure')), error => error.code === 'COMMIT_REJECTED' && error.status === 503);
  assert.equal(state.messages['session-1'].some(message => message.role === 'assistant'), false);
  assert.equal(state.coreV0.turnAdmissions[0].status, 'failed');
  assert.equal(state.coreV0.assistantCommits[0].status, 'pending');
});

test('Core v0 rolls back the visible user message when application persistence fails after Memory admission', async () => {
  const state = createState();
  const port = createPort();
  let persistCalls = 0;
  const service = createService(state, port, {
    persist: async () => {
      persistCalls += 1;
      if (persistCalls === 4) throw Object.assign(new Error('application store unavailable'), { code: 'STORAGE_WRITE_FAILED' });
    }
  });

  const result = await service.handleTurn(input('admission-persist-failure'));
  assert.equal(result.status, 'pending');
  assert.equal(state.messages['session-1'].length, 0);
  assert.equal(state.coreV0.turnAdmissions[0].status, 'pending');
  assert.equal(state.coreV0.turnAdmissions[0].rawEventReceipt, null);
});

test('Core v0 reconciles a lost Memory response after a fresh service instance', async () => {
  const state = createState();
  const firstPort = createPort({ append: async () => { throw new Error('connection closed after write'); } });
  const firstService = createService(state, firstPort);
  const pending = await firstService.handleTurn(input('restart-key'));
  assert.equal(pending.status, 'pending');
  const originalTurn = state.coreV0.turnAdmissions[0];
  assert.equal(originalTurn.rawEventReceipt, null);
  assert.equal(state.messages['session-1'].length, 0);

  const secondPort = createPort();
  secondPort.getSessionBinding = async () => {
    secondPort.calls.lookupBinding += 1;
    return { status: 'completed', memorySessionId: 'memory-1', receipt: { status: 'completed', memorySessionId: 'memory-1' } };
  };
  secondPort.getRawEventReceipt = async () => {
    secondPort.calls.lookupEvent += 1;
    return { status: 'completed', receipt: { status: 'completed', eventId: originalTurn.eventId, rawEventId: 'raw-after-restart' } };
  };
  const secondService = createService(state, secondPort);
  const completed = await secondService.reconcileTurn(originalTurn.turnId);

  assert.equal(completed.status, 'committed');
  assert.equal(completed.turnId, originalTurn.turnId);
  assert.equal(state.coreV0.turnAdmissions[0].eventId, originalTurn.eventId);
  assert.equal(state.coreV0.turnAdmissions[0].applicationMessageId, originalTurn.applicationMessageId);
  assert.equal(secondPort.calls.ensure, 0);
  assert.equal(secondPort.calls.append, 0);
  assert.equal(secondPort.calls.lookupBinding, 0);
  assert.equal(secondPort.calls.lookupEvent, 1);
});
