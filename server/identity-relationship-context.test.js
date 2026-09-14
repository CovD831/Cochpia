import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIdentityRelationshipContext,
  resolveCorrelationId,
  resolveSessionAgentId,
  createRequestAgentResolver
} from './runtime/identity-relationship-context.js';

// rawContext mimics the output of memoryRuntime.contextFromRequest(req, { chat: true })
const rawChatContext = {
  tenantId: 't-1',
  subjectUserId: 'u-1',
  actorType: 'user',
  actorId: 'u-1',
  callerAgentId: 'ag-1',
  producer: null,
  correlationId: null,
  sessionId: null
};

test('buildIdentityRelationshipContext carries identity fields and fixes producer', () => {
  const ctx = buildIdentityRelationshipContext({
    rawContext: rawChatContext,
    requestId: 'r-1',
    traceId: 'tr-1',
    correlationId: 'c-1'
  });
  assert.equal(ctx.tenantId, 't-1');
  assert.equal(ctx.subjectUserId, 'u-1');
  assert.equal(ctx.actorType, 'user');
  assert.equal(ctx.actorId, 'u-1');
  assert.equal(ctx.callerAgentId, 'ag-1');
  assert.equal(ctx.agentId, 'ag-1');
  assert.equal(ctx.producer, 'companion-core');
  assert.equal(ctx.requestId, 'r-1');
  assert.equal(ctx.traceId, 'tr-1');
  assert.equal(ctx.correlationId, 'c-1');
});

test('agentId falls back to session.agentId when callerAgentId is absent', () => {
  const ctx = buildIdentityRelationshipContext({
    rawContext: { ...rawChatContext, callerAgentId: '' },
    session: { id: 's-1', agentId: 'ag-session' }
  });
  assert.equal(ctx.agentId, 'ag-session');
  assert.equal(ctx.applicationSessionId, 's-1');
});

test('chat context preserves sessionId null and never re-derives Memory permission facts', () => {
  const ctx = buildIdentityRelationshipContext({ rawContext: rawChatContext });
  assert.equal(ctx.sessionId, null);
  // relationship / grant are surfaced verbatim, never computed.
  assert.equal(ctx.relationshipId, null);
  assert.equal(ctx.grant, null);
  const withGrant = buildIdentityRelationshipContext({
    rawContext: { ...rawChatContext, relationshipId: 'rel-9', grant: { scope: 'read' } }
  });
  assert.equal(withGrant.relationshipId, 'rel-9');
  assert.deepEqual(withGrant.grant, { scope: 'read' });
});

test('resolveCorrelationId follows x-correlation-id > traceId > requestId > generated', () => {
  assert.equal(resolveCorrelationId({ correlationHeader: 'h', traceId: 't', requestId: 'r' }), 'h');
  assert.equal(resolveCorrelationId({ traceId: 't', requestId: 'r' }), 't');
  assert.equal(resolveCorrelationId({ requestId: 'r' }), 'r');
  let made = null;
  const id = resolveCorrelationId({ generate: () => 'gen' });
  made = id;
  assert.equal(made, 'gen');
});

test('resolveSessionAgentId reads the bound agent from request state', () => {
  const state = { sessions: [{ id: 's1', agentId: 'ag-7' }, { id: 's2', agentId: '' }] };
  assert.equal(resolveSessionAgentId(state, 's1'), 'ag-7');
  assert.equal(resolveSessionAgentId(state, 's2'), null);
  assert.equal(resolveSessionAgentId(state, 'missing'), null);
  assert.equal(resolveSessionAgentId(null, 's1'), null);
});

test('createRequestAgentResolver adapts a getState accessor to (req) => agentId', () => {
  const getState = () => ({ sessions: [{ id: 's1', agentId: 'ag-x' }] });
  const resolve = createRequestAgentResolver(getState);
  assert.equal(resolve({ body: { sessionId: 's1' } }), 'ag-x');
  assert.equal(resolve({ body: { sessionId: 'nope' } }), null);
  assert.equal(resolve({ query: { sessionId: 's1' } }), 'ag-x');
});
