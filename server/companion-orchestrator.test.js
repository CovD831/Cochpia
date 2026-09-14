import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionOrchestrator } from './runtime/companion-orchestrator.js';
import { createInteractionFinalizer, createCommitCoordinator, createProjectionDispatcher } from './runtime/interaction-finalizer.js';
import { buildIdentityRelationshipContext } from './runtime/identity-relationship-context.js';

function fakeReq({ body = {}, headerIdempotencyKey = null } = {}) {
  return {
    body,
    requestId: 'req-1',
    traceId: 'trace-1',
    get: name => (name === 'Idempotency-Key' ? headerIdempotencyKey : null)
  };
}

const baseDeps = (overrides = {}) => {
  const localAdapter = { service: { handleTurn: async () => ({ status: 'committed' }) }, drainExtraction: 'DRAIN' };
  return {
    getRequestState: () => ({ sessions: [{ id: 's1', agentId: 'ag-1', modelProvider: 'mock', modelName: '' }] }),
    memoryRuntime: {
      contextFromRequest: () => ({ tenantId: 't1', subjectUserId: 'u1', actorType: 'user', actorId: 'u1', callerAgentId: 'ag-1', sessionId: null }),
      moduleForRequest: () => ({ state: {} })
    },
    identityContext: buildIdentityRelationshipContext,
    finalizer: createInteractionFinalizer({ commitCoordinator: createCommitCoordinator(), projectionDispatcher: createProjectionDispatcher() }),
    observability: {},
    resolveCorrelationId: ({ correlationHeader, traceId, requestId, generate }) => correlationHeader || traceId || requestId || (generate ? generate() : 'c'),
    createProductionAdapter: () => localAdapter,
    createLocalAdapter: () => localAdapter,
    ...overrides
  };
};

test('runTurn builds identity, constructs the request adapter, delegates finalize, returns result', async () => {
  const calls = [];
  const finalizer = {
    finalizeTurn: async ({ input, service, drain, onDegrade }) => {
      calls.push({ input, service, drain });
      return { status: 'committed', assistantMessageId: 'a1' };
    },
    dispatch: () => {}
  };
  const createdAdapter = { service: { handleTurn: async () => ({}) }, drainExtraction: 'DRAIN' };
  const orchestrator = createCompanionOrchestrator({
    ...baseDeps({ finalizer, createLocalAdapter: () => createdAdapter, createProductionAdapter: () => createdAdapter })
  });
  const req = fakeReq({ body: { sessionId: 's1', message: 'hi', channel: '默认' }, headerIdempotencyKey: 'idk-1' });
  const result = await orchestrator.runTurn({ req });
  assert.equal(result.status, 'committed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.body, req.body);
  assert.equal(calls[0].input.headerIdempotencyKey, 'idk-1');
  assert.equal(calls[0].service, createdAdapter.service);
  assert.equal(calls[0].drain, createdAdapter.drainExtraction);
});

test('forRequest returns the { service, drainExtraction } shape the stream expects', async () => {
  const createdAdapter = { service: { handleTurn: async () => ({}) }, drainExtraction: 'DRAIN' };
  const orchestrator = createCompanionOrchestrator(baseDeps({ createLocalAdapter: () => createdAdapter, createProductionAdapter: () => createdAdapter }));
  const out = await orchestrator.forRequest(fakeReq({ body: { sessionId: 's1' } }));
  assert.equal(out.service, createdAdapter.service);
  assert.equal(out.drainExtraction, 'DRAIN');
});

test('dispatch delegates to the finalizer dispatcher', () => {
  const dispatched = [];
  const orchestrator = createCompanionOrchestrator(baseDeps({ finalizer: { finalizeTurn: async () => ({}), dispatch: ({ drain }) => dispatched.push(drain) } }));
  orchestrator.dispatch({ drain: 'D' });
  assert.deepEqual(dispatched, ['D']);
});

test('requires the wiring dependencies', async () => {
  await assert.rejects(async () => { createCompanionOrchestrator({}); });
});
