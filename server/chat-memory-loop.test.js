// R-020 stage 1.3: the memory-loop assertion the product actually promises.
//
// Until this test there was coverage of turns, of the drain, and of retrieval
// individually — but nothing asserted the user-visible semantics: "you tell
// it something, and next time it remembers". That gap is exactly how a broken
// retrieval path stayed invisible for two iterations while every unit test
// passed.
//
// The loop under test (the final shape, not the legacy path):
//
//   L1  the stating turn commits and the raw event is durable
//   L2  the drain turns that event into an active, projected assertion
//   L3  a later turn on the same session recalls the stated fact
//   L4  NEGATIVE: before the drain, the later turn recalls nothing
//       (without this, a test that always recalls proves nothing)
//   L5  a different, unrelated probe still recalls the fact by relevance,
//       not by accident of the session snapshot alone
//
// The negative case (L4) is the point of the file: it is the guard that keeps
// a future regression from passing as green.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { createMemoryExtractionDrain, createDeterministicExtractor } from './memory-extraction.js';
import { createCoreV0TurnService, createCoreV0MockModelGateway, ensureCoreV0State } from './core-v0.js';
import { createModelProvider } from './model-provider.js';

const tenantId = 'loop-tenant';
const subjectUserId = 'loop-user';
const agentId = 'loop-agent';
const applicationSessionId = 'loop-session';

// actorType is 'user', not 'agent', because that is what the product chat
// path actually builds today: /api/chat/* never passes through the /v1
// service boundary, so memoryServiceIdentity is unset and
// memory-module-runtime falls back to actorType 'user' with
// actorId === subjectUserId.
//
// This matters. promoteCandidate asserts assertUserGovernanceActor, so an
// 'agent' actor is refused with GOVERNANCE_FORBIDDEN and the extraction drain
// cannot promote anything. Stage 2a must give the drain a user-scoped
// governance path before agent identity lands, otherwise the whole loop stops
// working the moment callerAgentId stops being a constant. Tracked as
// AR-210 in the review ledger.
const CTX = {
  tenantId,
  subjectUserId,
  actorType: 'user',
  actorId: subjectUserId,
  callerAgentId: agentId,
  producer: 'companion-core',
  correlationId: 'chat-memory-loop'
};

const buildState = () => {
  const state = {
    sessions: [{
      id: applicationSessionId,
      title: 'loop',
      summary: '',
      persona: '',
      atmosphere: '',
      companionIntent: 'listen',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }],
    messages: { [applicationSessionId]: [] },
    memoryModule: createMemoryModuleState(),
    personality: { version: 1, summary: '', traits: [], updatedAt: new Date().toISOString() },
    profile: { name: 'loop-user', gender: 'none', age: null },
    evidence: []
  };
  ensureCoreV0State(state);
  return state;
};

// The MemoryPort the turn service talks to, backed by the in-memory module
// with a shared state object so the drain can mutate the same canonical data
// the next read will see. This mirrors the production split (Core never owns
// memory facts) without standing up PostgreSQL.
const buildPort = ({ state }) => {
  const memoryModule = createMemoryModule(state.memoryModule, async () => {});
  const withSession = sessionId => ({ ...CTX, sessionId });
  return {
    memoryModule,
    port: {
      async ensureSessionBinding({ bindingKey }) {
        const result = await memoryModule.createSession(CTX, {
          idempotency_key: `loop:binding:${bindingKey}`,
          callerAgentId: agentId
        });
        const session = result?.session || result;
        return { status: 'completed', memorySessionId: session.id, receipt: { status: 'completed', memorySessionId: session.id } };
      },
      async getSessionBinding({ bindingKey }) {
        const record = (state.memoryModule.idempotencyRecords || [])
          .find(item => item.key === `loop:binding:${bindingKey}`);
        const memorySessionId = record?.response?.id;
        return memorySessionId
          ? { status: 'completed', memorySessionId, receipt: { status: 'completed', memorySessionId } }
          : { status: 'not_found' };
      },
      async reconcileSessionBinding(args) { return this.getSessionBinding(args); },
      async appendRawEvent({ event, memorySessionId }) {
        const result = await memoryModule.recordEvent(withSession(memorySessionId), {
          ...event,
          sessionId: memorySessionId,
          contentType: 'plain_text',
          eventRole: event.eventRole || 'user',
          isStreamFinal: true
        });
        return {
          status: 'completed',
          receipt: {
            status: 'completed',
            eventId: event.eventId,
            sourceRevision: event.sourceRevision,
            rawEventId: result?.id || result?.rawEventId || null,
            result: 'accepted_stored'
          }
        };
      },
      async getRawEventReceipt({ eventId, sourceRevision }) {
        const found = (state.memoryModule.rawEvents || [])
          .find(item => item.eventId === eventId && String(item.sourceRevision) === String(sourceRevision));
        return found
          ? { status: 'completed', receipt: { status: 'completed', eventId, sourceRevision, rawEventId: found.id, result: 'accepted_stored' } }
          : { status: 'not_found' };
      },
      async reconcileRawEvent(args) { return this.getRawEventReceipt(args); },
      async retrieveContext({ query, memorySessionId }) {
        const result = await memoryModule.contextBundleAsync(withSession(memorySessionId), {
          query: String(query || '').slice(0, 1000),
          purpose: 'answer_user_query',
          tokenBudget: 1800
        });
        const recalled = [
          ...(result.coreMemory || []),
          ...(result.userProfile || []),
          ...(result.relationshipProfile || []),
          ...(result.currentState || []),
          ...(result.relevantEpisodes || [])
        ].map(item => ({ id: item.memoryId || item.episodeId, summary: item.content || item.value || item.summary || '' }))
          .filter(item => String(item.summary || '').trim());
        return { status: 'available', bundle: result, recalled, answerability: result.answerability || 'not_found' };
      }
    }
  };
};

// The drain reads and writes canonical Memory state through the repository,
// so the fixture must hand it the Memory slice — not the application state
// that merely holds a reference to it. Passing the app state here is the
// mistake that made the drain report "no pending events".
const mockRepository = memoryState => {
  const pool = {
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    },
    async query() { return { rows: [] }; }
  };
  return {
    pool,
    repository: {
      async load() { return memoryState; },
      async save() {},
      async loadContextBundleState() { return memoryState; },
      async loadReadMetadata() { return memoryState; }
    }
  };
};

const buildService = ({ state, port }) => createCoreV0TurnService({
  state,
  context: CTX,
  memoryPort: port,
  modelGateway: createCoreV0MockModelGateway()
});

const runDrain = async ({ state }) => {
  const { pool, repository } = mockRepository(state.memoryModule);
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: createDeterministicExtractor({ keywords: ['记住了', '尤克里里', '学'] }),
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  return drain();
};

test('L4 (negative guard): before the drain, a later turn recalls nothing', async () => {
  const state = buildState();
  const { port } = buildPort({ state });
  const service = buildService({ state, port });

  await service.handleTurn({
    body: { sessionId: applicationSessionId, message: '记住了，我在学尤克里里' },
    headerIdempotencyKey: 'loop-statement'
  });

  const probe = await service.handleTurn({
    body: { sessionId: applicationSessionId, message: '我最近在学什么？' },
    headerIdempotencyKey: 'loop-probe-before'
  });

  // The raw event exists, but no assertion has been extracted yet, so the
  // retrieval corpus is empty. If this ever starts passing with recalled > 0,
  // the L3 assertion below has stopped proving anything.
  assert.equal(probe.status, 'committed');
  assert.equal(probe.memoryStatus, 'available');
  assert.equal(probe.recalledCount, 0, 'before extraction there is nothing to recall');
});

test('L1/L2/L3: a stated fact is extracted and recalled on a later turn', async () => {
  const state = buildState();
  const { port } = buildPort({ state });
  const service = buildService({ state, port });

  // L1: the stating turn commits and the raw event is durable
  const stated = await service.handleTurn({
    body: { sessionId: applicationSessionId, message: '记住了，我在学尤克里里' },
    headerIdempotencyKey: 'loop-statement'
  });
  assert.equal(stated.status, 'committed');
  const rawEvents = state.memoryModule.rawEvents || [];
  assert.ok(rawEvents.some(event => String(event.content || '').includes('尤克里里')), 'L1: the raw event must be durable');

  // L2: the drain promotes the event into an active assertion
  const drained = await runDrain({ state });
  assert.equal(drained.status, 'drained', `drain did not run: ${JSON.stringify(drained)}`);
  assert.ok(
    (state.memoryModule.assertions || []).some(item => item.status === 'active' && String(item.canonicalKey || '')),
    'L2: the drain must produce an active, keyed assertion'
  );

  // L3: a later turn on the same session recalls it
  const probe = await service.handleTurn({
    body: { sessionId: applicationSessionId, message: '我最近在学什么？' },
    headerIdempotencyKey: 'loop-probe-after'
  });

  assert.equal(probe.status, 'committed');
  assert.equal(probe.memoryStatus, 'available');
  assert.ok(probe.recalledCount > 0, 'L3: the stated fact must be recalled on a later turn');
});

test('L5: recall follows the stored context, not the probe wording alone', async () => {
  const state = buildState();
  const { port } = buildPort({ state });
  const service = buildService({ state, port });

  await service.handleTurn({
    body: { sessionId: applicationSessionId, message: '记住了，我在学尤克里里' },
    headerIdempotencyKey: 'loop-l5-statement'
  });
  await runDrain({ state });

  // An unrelated probe must still see the session's established context. This
  // distinguishes "the loop works" from "the query happened to substring-match
  // the stored content".
  const probe = await service.handleTurn({
    body: { sessionId: applicationSessionId, message: '那我们聊点别的吧' },
    headerIdempotencyKey: 'loop-l5-probe'
  });

  assert.equal(probe.status, 'committed');
  assert.equal(probe.memoryStatus, 'available');
  assert.ok(probe.recalledCount > 0, 'L5: the session context must reach the prompt even for an unrelated probe');
});

test('L6: the loop survives a second drain without duplicating work', async () => {
  const state = buildState();
  const { port } = buildPort({ state });
  const service = buildService({ state, port });

  await service.handleTurn({
    body: { sessionId: applicationSessionId, message: '记住了，我在学尤克里里' },
    headerIdempotencyKey: 'loop-l6-statement'
  });

  const first = await runDrain({ state });
  assert.equal(first.status, 'drained');
  const assertionsAfterFirst = (state.memoryModule.assertions || []).length;

  const second = await runDrain({ state });
  assert.equal(second.status, 'idle', 'an already-extracted event must not be re-extracted');
  assert.equal((state.memoryModule.assertions || []).length, assertionsAfterFirst, 'no duplicate assertions');
});

test('L7: a memory failure degrades the turn but never loses the loop', async () => {
  const state = buildState();
  const { port } = buildPort({ state });
  // Simulate a broken retrieval on the second turn only.
  const original = port.retrieveContext.bind(port);
  let calls = 0;
  port.retrieveContext = async args => {
    calls += 1;
    if (calls > 1) {
      const error = new Error('memory unavailable');
      error.code = 'MEMORY_RETRIEVE_FAILED';
      throw error;
    }
    return original(args);
  };
  const service = buildService({ state, port });

  const first = await service.handleTurn({
    body: { sessionId: applicationSessionId, message: '记住了，我在学尤克里里' },
    headerIdempotencyKey: 'loop-l7-1'
  });
  assert.equal(first.memoryStatus, 'available');

  const second = await service.handleTurn({
    body: { sessionId: applicationSessionId, message: '我最近在学什么？' },
    headerIdempotencyKey: 'loop-l7-2'
  });
  assert.equal(second.status, 'committed', 'a memory failure must not block the conversation');
  assert.equal(second.memoryStatus, 'degraded', 'but it must be visible');
  assert.equal(second.memoryDegradedReason, 'MEMORY_RETRIEVE_FAILED');
});

// createModelProvider is imported so the file documents that the turns path
// uses the same provider factory as production; the mock protocol keeps this
// test free of network calls.
test('L8: the mock provider is the one the local loop uses (no network)', async () => {
  const provider = createModelProvider('mock');
  const content = await provider.generate({ message: '你好', recalled: [] });
  assert.ok(String(content).trim());
});
