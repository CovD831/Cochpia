// R-020 stage 1.2: a memory degrade must be visible, never silent.
//
// The conversation still must not be blocked when memory fails (that product
// decision stands). What must not stand is a bare catch: it hid a broken
// retrieval path for two iterations and made a real bug look like an unused
// capability. These tests pin the visible-degrade contract:
//
//   D1  a failing retrieveContext marks the turn degraded instead of throwing
//   D2  the degrade reason is carried on the response
//   D3  the turn still commits and the assistant message is still written
//   D4  a healthy retrieve reports "available" with a null reason
//   D5  observability counts the degrade and attributes the reason

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { createCoreV0LocalAdapter } from './core-v0-production.js';
import { createCoreV0TurnService, ensureCoreV0State } from './core-v0.js';
import { createObservability } from './observability.js';

const tenantId = 'degrade-tenant';
const subjectUserId = 'degrade-user';
const applicationSessionId = 'degrade-session';

const buildState = () => {
  const state = {
    sessions: [{ id: applicationSessionId, title: 'degrade', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    messages: { [applicationSessionId]: [] },
    memoryModule: createMemoryModuleState(),
    personality: { version: 1, traits: [], summary: '', updatedAt: new Date().toISOString() },
    profile: null,
    evidence: []
  };
  ensureCoreV0State(state);
  return state;
};

const context = {
  tenantId,
  subjectUserId,
  actorType: 'agent',
  actorId: 'degrade-agent',
  callerAgentId: 'degrade-agent',
  producer: 'companion-core',
  correlationId: 'degrade-test'
};

// A memory port whose reads fail and whose writes succeed: exactly the shape
// of the original defect (retrieval broken, conversation unaffected).
const buildFailingPort = ({ failing = true } = {}) => {
  const memoryModule = createMemoryModule(createMemoryModuleState(), async () => {});
  const port = {
    async ensureSessionBinding({ bindingKey }) {
      const session = await memoryModule.createSession(context, { idempotency_key: `binding:${bindingKey}`, callerAgentId: 'degrade-agent' });
      return { status: 'completed', memorySessionId: session.id, receipt: { status: 'completed', memorySessionId: session.id } };
    },
    async getSessionBinding({ bindingKey }) {
      const record = (memoryModule.state.idempotencyRecords || []).find(item => item.key === `binding:${bindingKey}`);
      const memorySessionId = record?.response?.id;
      return memorySessionId
        ? { status: 'completed', memorySessionId, receipt: { status: 'completed', memorySessionId } }
        : { status: 'not_found' };
    },
    async reconcileSessionBinding(args) { return this.getSessionBinding(args); },
    async appendRawEvent({ event, memorySessionId }) {
      const result = await memoryModule.recordEvent({ ...context, sessionId: memorySessionId }, {
        ...event,
        sessionId: memorySessionId,
        contentType: 'plain_text',
        eventRole: event.eventRole || 'user',
        isStreamFinal: true
      });
      return { status: 'completed', receipt: { status: 'completed', eventId: event.eventId, sourceRevision: event.sourceRevision, rawEventId: result.id } };
    },
    async getRawEventReceipt() { return { status: 'not_found' }; },
    async reconcileRawEvent(args) { return this.getRawEventReceipt(args); },
    async retrieveContext() {
      if (failing) {
        const error = new Error('memory retrieval is unavailable');
        error.code = 'MEMORY_RETRIEVE_FAILED';
        throw error;
      }
      return { status: 'available', bundle: null, recalled: [], answerability: 'not_found' };
    }
  };
  return { memoryModule, port };
};

const buildService = (port, state) => createCoreV0TurnService({
  state,
  context,
  memoryPort: port,
  enabled: true
});

test('D1/D2/D3 a failing memory read degrades visibly instead of throwing, and the turn still commits', async () => {
  const state = buildState();
  const { port } = buildFailingPort({ failing: true });
  const service = buildService(port, state);

  const result = await service.handleTurn({
    body: { sessionId: applicationSessionId, message: '我在学尤克里里' },
    headerIdempotencyKey: 'degrade-turn-1'
  });

  assert.equal(result.status, 'committed', 'the turn must still commit when memory is degraded');
  assert.equal(result.memoryStatus, 'degraded', 'the degrade must be visible on the response');
  assert.equal(result.memoryDegradedReason, 'MEMORY_RETRIEVE_FAILED', 'the reason must be attributed');
  assert.equal(result.recalledCount, 0);

  const messages = state.messages[applicationSessionId] || [];
  const assistant = messages.find(item => item.id === result.assistantMessageId);
  assert.ok(assistant, 'D3: the assistant message must still be written');
  assert.ok(String(assistant.content || '').trim(), 'D3: the assistant reply must not be empty');
});

test('D4 a healthy memory read reports available with a null degrade reason', async () => {
  const state = buildState();
  const { port } = buildFailingPort({ failing: false });
  const service = buildService(port, state);

  const result = await service.handleTurn({
    body: { sessionId: applicationSessionId, message: '你好' },
    headerIdempotencyKey: 'healthy-turn-1'
  });

  assert.equal(result.status, 'committed');
  assert.equal(result.memoryStatus, 'available');
  assert.equal(result.memoryDegradedReason, null, 'the healthy path must not carry a stale reason');
});

test('D5 a replay of a degraded turn still reports the degrade', async () => {
  const state = buildState();
  const { port } = buildFailingPort({ failing: true });
  const service = buildService(port, state);

  await service.handleTurn({
    body: { sessionId: applicationSessionId, message: '同一句话' },
    headerIdempotencyKey: 'degrade-replay'
  });
  const replay = await service.handleTurn({
    body: { sessionId: applicationSessionId, message: '同一句话' },
    headerIdempotencyKey: 'degrade-replay'
  });

  assert.equal(replay.replay, true);
  assert.equal(replay.memoryStatus, 'degraded');
  assert.equal(replay.memoryDegradedReason, 'MEMORY_RETRIEVE_FAILED');
});

test('D6 observability counts a degrade and attributes its reason', () => {
  const observability = createObservability({ logger: { info() {} } });
  assert.equal(observability.getMetrics().memoryDegraded, 0);

  observability.recordMemoryDegrade('MEMORY_RETRIEVE_FAILED');
  observability.recordMemoryDegrade('MEMORY_RETRIEVE_FAILED');
  observability.recordMemoryDegrade('MEMORY_TIMEOUT');

  const metrics = observability.getMetrics();
  assert.equal(metrics.memoryDegraded, 3);
  assert.equal(metrics.memoryDegradeReasons.MEMORY_RETRIEVE_FAILED, 2);
  assert.equal(metrics.memoryDegradeReasons.MEMORY_TIMEOUT, 1);
});

test('D7 an unknown degrade reason is still counted under a stable default', () => {
  const observability = createObservability({ logger: { info() {} } });
  observability.recordMemoryDegrade(null);
  assert.equal(observability.getMetrics().memoryDegradeReasons.MEMORY_DEGRADED, 1);
});

test('D8 the local adapter smoke path reports available (no false degrade)', async () => {
  const state = buildState();
  const memoryModule = createMemoryModule(state.memoryModule, async () => {});
  const adapter = createCoreV0LocalAdapter({ state, context, memoryModule, modelProvider: 'mock' });
  const result = await adapter.service.handleTurn({
    body: { sessionId: applicationSessionId, message: '一句话' },
    headerIdempotencyKey: 'adapter-turn-1'
  });
  assert.equal(result.status, 'committed');
  assert.equal(result.memoryStatus, 'available');
  assert.equal(result.memoryDegradedReason, null);
});
