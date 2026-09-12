// readScope end-to-end injection acceptance (L2 contract 2c, 2026-09-12).
//
// Baseline: codex/core-v0-foundation @ 4c67144
// Contract: docs/rearchitecture/core-v0-cleanup-slice/09-l2-contracts-2c-readscope-e2e.md
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS (contract section 1)
// ---------------------------------------------------------------------------
//
// The 2a/2b suites all pass `readScope` in *by hand*:
//
//   server/agent-provenance.test.js:36-38   userCtx(callerAgentId, readScope)
//   scripts/probe-agent-scope-leak.mjs:41-42
//   server/chat-memory-loop.test.js:133     (self-built mock)
//
// That proves `canSee` filters correctly *given* a correct readScope. It does
// NOT prove that the three production lines which DERIVE readScope from the
// server-resolved callerAgentId actually yield a non-empty, correctly-wired
// agentId on the real context-construction path. "Unit tests green != it runs"
// (AR-212/AR-213).
//
// The three injection points (contract section 2.1 -- the third was missing
// from the earlier docs, and a "two vs three" count drift already shipped once,
// so the count is asserted below, not assumed):
//
//   #  location                          code
//   1  server/chat-memory.js:100         const readScope = context?.callerAgentId ? { agentId: ... } : undefined
//   2  server/core-v0.js:363             const readScope = baseContext.callerAgentId ? { agentId: ... } : undefined
//   3  server/core-v0-postgres.js:646    const scopedContext = context.callerAgentId ? { ...readContext, readScope: {...} } : readContext
//
// So every case here drives the real derivation chain
//
//   request -> runtime.contextFromRequest -> context.callerAgentId -> readScope
//
// and asserts on a readScope that was *captured off the wire* (wrapping the
// module's contextBundleAsync, or the repository's loadContextBundleState --
// both are the exact arguments the production line builds). No case passes a
// readScope literal in; that is the whole point.
//
// ---------------------------------------------------------------------------
// SCOPE
// ---------------------------------------------------------------------------
//
//   V-1  chat-memory.js:100   captured readScope.agentId, two agents      [here]
//   V-2  core-v0-postgres.js:646   captured scopedContext.readScope       [here]
//   V-3  end-to-end leak check on all three points                        [here]
//   V-4  missing callerAgentId => fail-open, pinned explicitly            [here]
//   V-6  core-v0.js:363        captured readScope + e2e                   [here]
//   V-5  counterfactual mutation      -- evidence-auditor's task, not run here
//   V-7  /v1/* and /mcp bypasses      -- explicitly excluded by contract section 3
//
// ---------------------------------------------------------------------------
// WHERE "END-TO-END" STOPS (audited 2026-09-12)
// ---------------------------------------------------------------------------
//
// Every case here drives the real chain from `contextFromRequest` downward:
//
//   request -> runtime.contextFromRequest -> context.callerAgentId -> readScope
//
// One link above that is a STAND-IN, not production code:
//
//   resolveAgentId: req => req.sessionAgentId        (makeRuntime, below)
//
// stands in for server/index.js:95-105 `resolveAgentIdForRequest`, which reads
// requestContext / sessions to match `session.agentId`. That function is named
// in contract section 2.2 as a link in the construction chain and is NOT covered
// by any test in this repository. If it regressed, this file would still be
// green. Claims from this file therefore hold for the derivation
// `callerAgentId -> readScope`, NOT for `session -> callerAgentId`.
//
// Actor type also bounds the claim. Production chat resolves to
// actorType 'user' (memory-module-runtime.js:80 -- a service identity is what
// makes it 'agent'), which is the actor this file exercises. Under a 'user'
// actor, `hasGrant` returns true on its first line, so readScope is the ONLY
// narrowing instrument -- exactly the case under test. Under an 'agent' actor
// the relationship/life guards and scopeGrants do the work instead (covered by
// the 2a suite). The combination "agent actor + readScope" is not exercised
// here; it is a known low-risk gap, recorded rather than papered over.
//
// ---------------------------------------------------------------------------
// SANDBOX NOTE
// ---------------------------------------------------------------------------
//
// `import('pg')` is SIGTERM-killed in this sandbox, so this file must not reach
// server/store.js or server/core-v0-production.js. It does not. core-v0-postgres.js
// itself never imports pg -- it takes its repository by dependency injection,
// and V-2 / V-3c wire a plain in-memory fake into it. That is why the postgres
// path is *actually exercised* here rather than skipped: the injection seam is
// real production code, only the storage backend behind it is a stand-in.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { createMemoryModuleRuntime } from './memory-module-runtime.js';
import { createChatMemoryAdapter } from './chat-memory.js';
import { createInProcessMemoryPort } from './core-v0.js';
import { createPostgresMemoryPort } from './core-v0-postgres.js';

const BASE = { tenantId: 't', subjectUserId: 'u' };
const CONFIDED = '用户在准备离职';
const NEEDLE = '离职';

// An ordinary chat request. Note *which* identity channel this uses: the
// contract's V-3 mirrors the drain (raw event under agent A -> candidate ->
// user-actor promotion), and that shape only holds for the plain chat path,
// where contextFromRequest resolves the agent through the *last* priority rung
// (contract section 2.2) and leaves actorType as 'user'.
//
// Using the highest rung instead (a memoryServiceIdentity) would set
// actorType:'agent', which routes the same assertion through the scope-grant
// rules rather than the readScope rule -- a different code path than the one
// under test. So `resolveAgentId` stands in for index.js's
// resolveAgentIdForRequest (synchronous, reads the session's agent, never
// throws), and nothing here injects a readScope.
const agentReq = (agentId, { sessionId = 'session-1' } = {}) => ({
  memoryServiceIdentity: null,
  sessionAgentId: agentId,
  body: { session_id: sessionId },
  query: {},
  get: () => null
});

// A bare chat request: no agent identity anywhere and no session hint, so the
// context builder does not throw its 400 (requiresAgent is false). Used by V-4.
const anonymousReq = () => ({
  memoryServiceIdentity: null,
  sessionAgentId: null,
  body: {},
  query: {},
  get: () => null
});

const makeRuntime = appState => createMemoryModuleRuntime({
  getState: () => appState,
  getUser: () => ({ id: 'u' }),
  tenantId: 't',
  // Mirrors server/index.js resolveAgentIdForRequest: the session's agent.
  resolveAgentId: req => req.sessionAgentId || null
});

// Mirror the drain exactly as server/agent-provenance.test.js seeds it: a raw
// event under agent A -> candidate -> user-actor promotion. The promoted
// assertion is tagged source_agent_id = 'agent-a', which is what the narrowed
// read must hide from B.
const seedAgentAPrivate = async memoryState => {
  const memory = createMemoryModule(memoryState, async () => {});
  const recorded = await memory.recordEvent(
    { ...BASE, actorType: 'user', actorId: 'u', callerAgentId: 'agent-a' },
    {
      eventId: 'readscope-event-a',
      sourceRevision: '1',
      content: '我只跟你一个人说：我下个月准备离职',
      eventRole: 'user',
      contentType: 'plain_text',
      isStreamFinal: true
    }
  );
  const created = await memory.createCandidate(
    { ...BASE, actorType: 'agent', actorId: 'agent-a', callerAgentId: 'agent-a' },
    {
      sourceEventId: recorded.rawEventId,
      content: CONFIDED,
      memoryType: 'fact',
      assertionType: 'observed_fact',
      scopeType: 'user'
    }
  );
  await memory.promoteCandidate(
    { ...BASE, actorType: 'user', actorId: 'u' },
    created.memory.memoryId,
    { resourceRevision: created.memory.memoryResourceRevision ?? created.memory.resourceRevision }
  );
  return { memory, rawEventId: recorded.rawEventId, memoryId: created.memory.memoryId };
};

// Capture the argument the production line handed to contextBundleAsync, then
// delegate to the real module so behaviour is unchanged.
const captureContextBundle = inner => {
  const calls = [];
  const wrapped = Object.create(inner);
  wrapped.contextBundleAsync = async (context, options) => {
    calls.push(context);
    return inner.contextBundleAsync(context, options);
  };
  return { wrapped, calls };
};

// A repository stand-in behind the postgres port. It is not a pg mock: the port
// only ever calls load / save / loadContextBundleState, and the state it hands
// back is the *same* canonical memory state the seeding wrote to, so the real
// filtering code runs on real state.
const memoryRepository = memoryState => {
  const captured = [];
  return {
    captured,
    repository: {
      async load() { return memoryState; },
      async save() {},
      async loadContextBundleState(context) {
        captured.push(context);
        return memoryState;
      }
    }
  };
};

// Collect everything a retrieval result could surface the needle through --
// both the structured bundle and the flattened recalled list.
const retrievedText = result => {
  const bundle = result?.bundle || {};
  const fromBundle = [
    ...(bundle.coreMemory || []),
    ...(bundle.userProfile || []),
    ...(bundle.relationshipProfile || []),
    ...(bundle.agentLife || []),
    ...(bundle.currentState || []),
    ...(bundle.relevantEpisodes || [])
  ].map(item => String(item?.content ?? item?.value ?? item?.summary ?? item?.title ?? ''));
  const fromRecalled = (result?.recalled || [])
    .map(item => String(item?.summary ?? item?.content ?? ''));
  return [...fromBundle, ...fromRecalled].join('\n');
};

const seesConfided = result => retrievedText(result).includes(NEEDLE);

const retrieveQuery = { query: '离职 工作', tokenBudget: 1800 };

// ---------------------------------------------------------------------------
// V-1 -- chat-memory.js:100
// ---------------------------------------------------------------------------

test('V-1: chat-memory.js:100 derives readScope from the request-resolved callerAgentId (two agents, no cross-wiring)', async () => {
  const appState = { memoryModule: createMemoryModuleState() };
  const runtime = makeRuntime(appState);
  const { wrapped, calls } = captureContextBundle(createMemoryModule(appState.memoryModule, async () => {}));

  // The real context, built by the same builder chatForRequest() calls.
  const adapterFor = agentId => createChatMemoryAdapter({
    memoryModule: wrapped,
    state: appState,
    context: runtime.contextFromRequest(agentReq(agentId), { chat: true })
  });

  await adapterFor('agent-a').retrieve('离职');
  await adapterFor('agent-b').retrieve('离职');

  assert.equal(calls.length, 2, 'both retrievals must reach contextBundleAsync');

  // The claim under test: agentId is non-empty AND equals the request's agent.
  assert.equal(calls[0].readScope?.agentId, 'agent-a', 'A\'s read must be scoped to A');
  assert.equal(calls[1].readScope?.agentId, 'agent-b', 'B\'s read must be scoped to B');

  // Guard against the degenerate "both undefined" and "both the same" outcomes
  // that a captured-but-ignored value would still let through.
  assert.notEqual(calls[0].readScope?.agentId, calls[1].readScope?.agentId, 'the two agents must not share a scope');
  assert.ok(calls[0].readScope && calls[1].readScope, 'readScope must be present, not undefined');
});

// ---------------------------------------------------------------------------
// V-2 -- core-v0-postgres.js:646
// ---------------------------------------------------------------------------

test('V-2: core-v0-postgres.js:646 puts the callerAgentId into scopedContext.readScope', async () => {
  const memoryState = createMemoryModuleState();
  const { captured, repository } = memoryRepository(memoryState);
  const runtime = makeRuntime({ memoryModule: memoryState });

  const port = createPostgresMemoryPort({
    repository,
    context: runtime.contextFromRequest(agentReq('agent-b'), { chat: true })
  });

  const result = await port.retrieveContext({ ...retrieveQuery, memorySessionId: 'memory-session-1' });

  assert.equal(result.status, 'available', 'the port read must complete');
  assert.equal(captured.length, 1, 'the port must load the context-bundle state exactly once');

  // :646 builds scopedContext, and :648 hands that exact object to the repository.
  assert.equal(captured[0].readScope?.agentId, 'agent-b', 'scopedContext.readScope must carry the caller agent');
  // contextWithSession() applied, i.e. we really captured the line under test.
  assert.equal(captured[0].sessionId, 'memory-session-1', 'scopedContext must keep the memory session');
});

// ---------------------------------------------------------------------------
// V-3 -- end-to-end leak check, one case per injection point
// ---------------------------------------------------------------------------

test('V-3a: chat path -- agent B cannot retrieve agent A\'s private assertion, agent A still can', async () => {
  const appState = { memoryModule: createMemoryModuleState() };
  await seedAgentAPrivate(appState.memoryModule);
  const runtime = makeRuntime(appState);

  // No readScope is passed anywhere: it is derived inside chat-memory.js:100.
  const asA = await runtime.chatForRequest(agentReq('agent-a')).retrieve('离职');
  const asB = await runtime.chatForRequest(agentReq('agent-b')).retrieve('离职');

  assert.equal(seesConfided(asB), false, 'agent B must not retrieve material confided to agent A (chat path)');
  assert.equal(seesConfided(asA), true, 'agent A must still see its own material -- no over-narrowing');
});

test('V-3b: in-process port path (core-v0.js:363) -- agent B cannot retrieve agent A\'s private assertion', async () => {
  const memoryState = createMemoryModuleState();
  await seedAgentAPrivate(memoryState);
  const runtime = makeRuntime({ memoryModule: memoryState });

  // The module is the real one; the port derives readScope from its own context.
  const portFor = agentId => createInProcessMemoryPort({
    memoryModule: createMemoryModule(memoryState, async () => {}),
    context: runtime.contextFromRequest(agentReq(agentId), { chat: true })
  });

  const asA = await portFor('agent-a').retrieveContext({ ...retrieveQuery, memorySessionId: 'memory-session-1' });
  const asB = await portFor('agent-b').retrieveContext({ ...retrieveQuery, memorySessionId: 'memory-session-1' });

  assert.equal(seesConfided(asB), false, 'agent B must not retrieve agent A\'s material (in-process port path)');
  assert.equal(seesConfided(asA), true, 'agent A must still see its own material (in-process port path)');
});

test('V-3c: postgres port path (core-v0-postgres.js:646) -- agent B cannot retrieve agent A\'s private assertion', async () => {
  const memoryState = createMemoryModuleState();
  await seedAgentAPrivate(memoryState);
  const runtime = makeRuntime({ memoryModule: memoryState });

  const portFor = agentId => createPostgresMemoryPort({
    repository: memoryRepository(memoryState).repository,
    context: runtime.contextFromRequest(agentReq(agentId), { chat: true })
  });

  const asA = await portFor('agent-a').retrieveContext({ ...retrieveQuery, memorySessionId: 'memory-session-1' });
  const asB = await portFor('agent-b').retrieveContext({ ...retrieveQuery, memorySessionId: 'memory-session-1' });

  assert.equal(seesConfided(asB), false, 'agent B must not retrieve agent A\'s material (postgres port path)');
  assert.equal(seesConfided(asA), true, 'agent A must still see its own material (postgres port path)');
});

// ---------------------------------------------------------------------------
// V-4 -- a missing callerAgentId is fail-open. This is a CHARACTERIZATION PIN,
// not a statement that the behaviour is correct.
//
// Why pin it at all: the fail-open is a real property of the code
// (memory-module.js:406 -- when readScope is absent the whole provenance filter
// is skipped), and it is load-bearing. Pinning it means a future change to
// fail-closed turns this test red, so the change has to be made knowingly
// rather than by accident.
//
// Risk carried by this behaviour (audited 2026-09-12, not resolved here):
//   - "No readScope" means "filter nothing". Any path that reaches the module
//     without a resolved callerAgentId sees every agent's material.
//   - Reachability is narrower than it looks: the chat guard throws 400 when a
//     chat request carries a session hint but resolves no agent, so this
//     scenario is only reachable when there is no session hint either. Whether
//     the primary route can ever reach it was NOT verified in this round.
//   - The bypass routes named in the contract (/v1/*, /mcp breath) carry a
//     callerAgentId but no readScope, so they are fail-open by construction.
// ---------------------------------------------------------------------------

test('V-4: a missing callerAgentId is fail-open -- readScope is absent and nothing is filtered', async () => {
  const appState = { memoryModule: createMemoryModuleState() };
  await seedAgentAPrivate(appState.memoryModule);
  const runtime = makeRuntime(appState);

  // No session hint, so the chat guard's 400 does NOT fire -- this is precisely
  // the silent no-agent path the contract wants written down.
  const context = runtime.contextFromRequest(anonymousReq(), { chat: true });
  assert.equal(context.callerAgentId, null, 'no agent resolved and no 400 thrown -- the silent path');

  const { wrapped, calls } = captureContextBundle(createMemoryModule(appState.memoryModule, async () => {}));
  const adapter = createChatMemoryAdapter({ memoryModule: wrapped, state: appState, context });
  const result = await adapter.retrieve('离职');

  // memory-module.js:406 -- when readScope is absent the whole provenance filter
  // is skipped. We pin that: the private assertion becomes visible.
  assert.equal(calls[0].readScope, undefined, 'with no caller there is no readScope to inject');
  assert.equal(
    seesConfided(result),
    true,
    'DOCUMENTED FAIL-OPEN: without a readScope nothing is filtered (memory-module.js:406)'
  );
});

// ---------------------------------------------------------------------------
// V-6 -- core-v0.js:363, the third injection point
// ---------------------------------------------------------------------------

test('V-6: core-v0.js:363 derives readScope from baseContext.callerAgentId (the third injection point)', async () => {
  const memoryState = createMemoryModuleState();
  const runtime = makeRuntime({ memoryModule: memoryState });
  const { wrapped, calls } = captureContextBundle(createMemoryModule(memoryState, async () => {}));

  const portFor = agentId => createInProcessMemoryPort({
    memoryModule: wrapped,
    context: runtime.contextFromRequest(agentReq(agentId), { chat: true })
  });

  await portFor('agent-a').retrieveContext({ ...retrieveQuery, memorySessionId: 'memory-session-1' });
  await portFor('agent-b').retrieveContext({ ...retrieveQuery, memorySessionId: 'memory-session-1' });

  assert.equal(calls.length, 2, 'both port reads must reach contextBundleAsync');
  assert.equal(calls[0].readScope?.agentId, 'agent-a', 'the in-process port must scope the read to the caller');
  assert.equal(calls[1].readScope?.agentId, 'agent-b', 'the in-process port must scope the read to the caller');
  assert.notEqual(calls[0].readScope?.agentId, calls[1].readScope?.agentId, 'the two agents must not share a scope');
});
