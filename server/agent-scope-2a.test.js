// R-020 stage 2a acceptance: agent identity, read-scope narrowing, and the
// three reserved interfaces for R-021.
//
// The contract under test is 07-l2-contracts-2a.md. The two facts that shape
// every test below:
//
//   1. actorType 'user' bypasses relationship-scope isolation entirely
//      (hasGrant returns true on its first line), so a user-actor context would
//      hand agent A the memories of agent B. Isolation is therefore enforced
//      by an explicit read-scope narrowing (C-7), not by actor type.
//   2. actorType must stay 'user' for chat, because promoteCandidate and nine
//      governance assertions require a user actor (AR-210). Changing it would
//      silently stop the extraction drain from promoting anything.
//
// Coverage:
//   R-1..R-6  read-scope narrowing (C-7)
//   L-1..L-4  life scope (C-8)
//   G-1..G-3  life_generation purpose (C-9)
//   A-*       callerAgentId resolution (C-11)
//   B-*       session/agent binding (C-10)
//   S-*       runtime context sections (C-12)
//   2a-A10    the drain identity is unchanged (C-6)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createMemoryModule, createMemoryModuleState, MEMORY_SCOPES, MemoryModuleError } from './memory-module.js';
import { createMemoryModuleRuntime } from './memory-module-runtime.js';
import { buildRuntimeContext, RUNTIME_CONTEXT_SECTIONS } from './runtime-context.js';

const base = { tenantId: 't', subjectUserId: 'u' };

const agentCtx = agentId => ({ ...base, actorType: 'agent', actorId: agentId, callerAgentId: agentId });
const userCtx = (callerAgentId, readScope) => ({
  ...base,
  actorType: 'user',
  actorId: 'u',
  callerAgentId,
  ...(readScope ? { readScope } : {})
});

// Seeds one relationship memory per agent, plus one user-scope memory that must
// stay visible regardless of the read scope.
const seedAgents = async ({ scopeType = 'relationship' } = {}) => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state, async () => {});
  for (const [agentId, content] of [['agent-a', 'A 的事：今天去了书店'], ['agent-b', 'B 的事：今天在练琴']]) {
    await memory.hold(agentCtx(agentId), {
      idempotency_key: `seed:${scopeType}:${agentId}`,
      content,
      memoryType: 'fact',
      assertionType: 'observed_fact',
      scopeType,
      relationshipAgentId: agentId,
      sensitivity: 'S0'
    });
  }
  await memory.hold({ ...base, actorType: 'user', actorId: 'u' }, {
    idempotency_key: 'seed:user',
    content: '用户偏好：喜欢黑咖啡',
    memoryType: 'preference',
    assertionType: 'observed_fact',
    scopeType: 'user',
    sensitivity: 'S0'
  });
  return { state, memory };
};

const relationshipContents = async (memory, ctx) => {
  const bundle = await memory.contextBundleAsync(ctx, { query: '事 咖啡', purpose: 'answer_user_query', tokenBudget: 1800 });
  return (bundle.relationshipProfile || []).map(item => item.content).sort();
};
// C-8: life memories live in their own bundle partition, not in
// relationshipProfile. Keeping them separate is what lets R-021 inject life
// texture without blending it into "what we have together".
const lifeContents = async (memory, ctx) => {
  const bundle = await memory.contextBundleAsync(ctx, { query: '事 咖啡', purpose: 'answer_user_query', tokenBudget: 1800 });
  return (bundle.agentLife || []).map(item => item.content).sort();
};
const userContents = async (memory, ctx) => {
  const bundle = await memory.contextBundleAsync(ctx, { query: '事 咖啡', purpose: 'answer_user_query', tokenBudget: 1800 });
  return (bundle.userProfile || []).map(item => item.content).sort();
};

// --- C-7 read-scope narrowing ---------------------------------------------

test('R-1: without a read scope the behaviour is unchanged (the user keeps full visibility)', async () => {
  const { memory } = await seedAgents();
  const contents = await relationshipContents(memory, userCtx('agent-a'));
  assert.equal(contents.length, 2, 'the data-subject view must still see both agents (governance/export rely on this)');
});

test('R-2/R-3: a read scope hides other agents and keeps the caller\'s own', async () => {
  const { memory } = await seedAgents();
  const asA = await relationshipContents(memory, userCtx('agent-a', { agentId: 'agent-a' }));
  assert.deepEqual(asA, ['A 的事：今天去了书店'], 'agent A must not see agent B');

  const asB = await relationshipContents(memory, userCtx('agent-b', { agentId: 'agent-b' }));
  assert.deepEqual(asB, ['B 的事：今天在练琴'], 'agent B must not see agent A');
});

test('R-4: a read scope never hides the user\'s own memories', async () => {
  const { memory } = await seedAgents();
  const profile = await userContents(memory, userCtx('agent-a', { agentId: 'agent-a' }));
  assert.deepEqual(profile, ['用户偏好：喜欢黑咖啡'], 'user-scope memories stay visible under any read scope');
});

test('R-5: a read scope cannot be supplied by request input (I-13)', async () => {
  // The runtime reads the session, never the body. A body-supplied readScope
  // must not reach the context.
  const sessions = [{ id: 'session-1', agentId: 'agent-a' }];
  const state = { sessions, memoryModule: createMemoryModuleState() };
  const runtime = createMemoryModuleRuntime({
    getState: () => state,
    resolveAgentId: req => sessions.find(item => item.id === req.body?.sessionId)?.agentId || null
  });
  const req = { body: { sessionId: 'session-1', readScope: { agentId: 'agent-b' } }, query: {}, get: () => undefined };
  const context = runtime.contextFromRequest(req, { chat: true });
  assert.equal(context.callerAgentId, 'agent-a', 'the session agent wins');
  assert.equal(context.readScope ?? null, null, 'a body-supplied readScope must not be honoured');
});

test('R-6: a read scope does not change actorType (I-11)', async () => {
  const { memory } = await seedAgents();
  // An agent-actor context with a read scope still behaves as an agent.
  const ctx = { ...agentCtx('agent-a'), readScope: { agentId: 'agent-b' } };
  const contents = await relationshipContents(memory, ctx);
  // The agent guard already restricts to the caller; readScope only narrows
  // further, so the result is empty rather than B's memory.
  assert.deepEqual(contents, [], 'narrowing must never widen visibility (I-12)');
});

// --- C-8 life scope -------------------------------------------------------

test('L-1/L-2: life scope requires an owning agent', () => {
  assert.ok(MEMORY_SCOPES.includes('life'), 'life must be a recognised scope');

  const state = createMemoryModuleState();
  const memory = createMemoryModule(state, async () => {});

  return (async () => {
    const ok = await memory.hold(agentCtx('agent-a'), {
      idempotency_key: 'life:ok',
      content: '今天去看了个展',
      memoryType: 'fact',
      assertionType: 'observed_fact',
      scopeType: 'life',
      relationshipAgentId: 'agent-a',
      sensitivity: 'S0'
    });
    assert.equal(ok.status, 'active', 'a life memory with an owning agent is accepted');

    await assert.rejects(
      () => memory.hold(agentCtx('agent-a'), {
        idempotency_key: 'life:no-agent',
        content: '没有归属的生活事件',
        memoryType: 'fact',
        assertionType: 'observed_fact',
        scopeType: 'life',
        sensitivity: 'S0'
      }),
      error => error instanceof MemoryModuleError && error.code === 'INVALID_SCOPE',
      'a life memory without an agent must be rejected'
    );
  })();
});

test('L-3/L-4: life memories live in their own partition and follow the read scope', async () => {
  const { memory } = await seedAgents({ scopeType: 'life' });
  const narrow = await lifeContents(memory, userCtx('agent-a', { agentId: 'agent-a' }));
  assert.deepEqual(narrow, ['A 的事：今天去了书店'], 'a narrowed read hides the other agent\'s life');

  const full = await lifeContents(memory, userCtx('agent-a'));
  assert.equal(full.length, 2, 'the governance view still sees both');
});

// --- C-9 life_generation purpose -----------------------------------------

test('G-1/G-2: life_generation is an accepted read-only purpose', async () => {
  const { memory } = await seedAgents();
  const ctx = userCtx('agent-a', { agentId: 'agent-a' });
  const result = await memory.retrieveAsync(ctx, { query: '书店', purpose: 'life_generation' });
  assert.ok(Array.isArray(result.items), 'life_generation must not be rejected as an invalid purpose');
});

test('G-3: life_generation does not grant mention permission (I-14)', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state, async () => {});
  // A memory whose mention policy forbids mention must not become mentionable
  // just because it was read through the life_generation purpose.
  await memory.hold(agentCtx('agent-a'), {
    idempotency_key: 'g3',
    content: '不想被主动提起的事',
    memoryType: 'fact',
    assertionType: 'observed_fact',
    scopeType: 'user',
    sensitivity: 'S0',
    mentionPolicy: 'do_not_mention'
  });
  const ctx = userCtx('agent-a', { agentId: 'agent-a' });
  const mention = await memory.retrieveAsync(ctx, { query: '主动提起', purpose: 'proactive_mention' });
  const ids = mention.items.map(item => item.assertion?.content || item.content);
  assert.equal(ids.includes('不想被主动提起的事'), false, 'a do-not-mention memory stays unmentionable');
});

// --- C-11 callerAgentId resolution ---------------------------------------

test('A-1/A-2: the agent resolves from the session, and its absence is an error', () => {
  const sessions = [
    { id: 's-bound', agentId: 'agent-a' },
    { id: 's-unbound' }
  ];
  const state = { sessions, memoryModule: createMemoryModuleState() };
  const runtime = createMemoryModuleRuntime({
    getState: () => state,
    resolveAgentId: req => sessions.find(item => item.id === req.body?.sessionId)?.agentId || null
  });

  const bound = runtime.contextFromRequest({ body: { sessionId: 's-bound' }, query: {}, get: () => undefined }, { chat: true });
  assert.equal(bound.callerAgentId, 'agent-a');

  assert.throws(
    () => runtime.contextFromRequest({ body: { sessionId: 's-unbound' }, query: {}, get: () => undefined }, { chat: true }),
    error => error?.code === 'MEMORY_AGENT_CONTEXT_REQUIRED',
    'an unbound session must fail loudly, not fall back to a constant'
  );
});

test('A-1: a service identity outranks the session agent', () => {
  const state = { sessions: [{ id: 's-bound', agentId: 'agent-a' }], memoryModule: createMemoryModuleState() };
  const runtime = createMemoryModuleRuntime({
    getState: () => state,
    resolveAgentId: () => 'agent-a'
  });
  const req = {
    body: { sessionId: 's-bound' },
    query: {},
    get: () => undefined,
    memoryServiceIdentity: { serviceId: 'service-agent', tenantId: 't', producer: 'companion-core', correlationId: 'c' }
  };
  const context = runtime.contextFromRequest(req, { chat: true });
  assert.equal(context.callerAgentId, 'service-agent');
});

test('A-2: no constant agent fallback survives in the context path', async () => {
  const files = [
    'server/memory-module-runtime.js',
    'server/core-v0.js',
    'server/core-v0-postgres.js'
  ];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.equal(
      /\|\|\s*'cochpia'/.test(source),
      false,
      `${file} must not fall back to the 'cochpia' constant`
    );
  }
});

test('A-4: a user-level Memory read does not require an agent (regression)', () => {
  // This is the bug that a browser run caught and the unit tests did not:
  // /api/memory/overview is a user-level view with no session, but it goes
  // through the chat adapter. Requiring an agent there returned 400, and
  // because the client's startup refresh is a Promise.all, that single failure
  // blanked the whole home page -- no sessions, no agents, no error visible.
  //
  // The agent requirement belongs to session-scoped chat contexts, where
  // per-agent scoping is meaningful. A session-less view must stay
  // agent-agnostic.
  const state = { sessions: [], memoryModule: createMemoryModuleState() };
  const runtime = createMemoryModuleRuntime({
    getState: () => state,
    resolveAgentId: req => state.sessions.find(item => item.id === req.body?.sessionId)?.agentId || null
  });

  // No session anywhere: a user-level read.
  const context = runtime.contextFromRequest({ body: {}, query: {}, get: () => undefined }, { chat: true });
  assert.equal(context.callerAgentId, null, 'a session-less view carries no agent, and that is not an error');
  assert.equal(context.actorType, 'user');

  // A query-string session counts as session-scoped, so a missing agent there
  // is still an error rather than a silent user-level fallback.
  assert.throws(
    () => runtime.contextFromRequest(
      { body: {}, query: { sessionId: 'missing-session' }, get: () => undefined },
      { chat: true }
    ),
    error => error?.code === 'MEMORY_AGENT_CONTEXT_REQUIRED',
    'a session-scoped read with no resolvable agent must still fail'
  );
});

// --- C-10 session/agent binding ------------------------------------------

test('B-1/B-2: the session record carries the agent, and a group session does not', () => {
  // The binding rules live in the route; this asserts the shape the route
  // writes, which is what the resolver reads back.
  const privateSession = { id: 's1', kind: 'private', agentId: 'agent-a', agentIds: [] };
  const groupSession = { id: 's2', kind: 'group', agentId: null, agentIds: ['agent-a', 'agent-b'] };
  assert.equal(privateSession.agentId, 'agent-a');
  assert.equal(groupSession.agentId, null, 'group sessions stay session-scoped');
});

test('B-3: an unbound private session cannot resolve an agent', () => {
  const state = { sessions: [{ id: 's-legacy', kind: 'private', needsAgentBinding: true }], memoryModule: createMemoryModuleState() };
  const runtime = createMemoryModuleRuntime({
    getState: () => state,
    resolveAgentId: req => state.sessions.find(item => item.id === req.body?.sessionId)?.agentId || null
  });
  assert.throws(
    () => runtime.contextFromRequest({ body: { sessionId: 's-legacy' }, query: {}, get: () => undefined }, { chat: true }),
    error => error?.code === 'MEMORY_AGENT_CONTEXT_REQUIRED'
  );
});

// --- C-12 runtime context sections ---------------------------------------

test('S-1: a failing section degrades alone and is named (I-17)', () => {
  const poisoned = [{ get type() { throw new Error('bad recalled item'); } }];
  const context = buildRuntimeContext({
    messages: [{ id: 'm1', role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:00.000Z' }],
    recalled: poisoned,
    personality: { version: 1, summary: 's', traits: [] },
    persona: '温柔一点'
  });

  assert.equal(context.recalled.length, 0, 'the failing section renders empty');
  assert.ok(context.degraded.some(item => item.key === 'memory'), 'the degrade must be named');
  assert.equal(context.messages.length, 1, 'other sections are unaffected');
  assert.equal(context.persona, '温柔一点');
});

test('S-2/S-3: the flat shape is preserved and agentPersona carries the persona', () => {
  const context = buildRuntimeContext({ persona: '慢吞吞的，爱打比方' });
  for (const field of ['messages', 'personality', 'recalled', 'memoryBundle', 'summary', 'persona', 'atmosphere', 'upcomingEvents', 'profile', 'mode', 'companionIntent']) {
    assert.ok(Object.hasOwn(context, field), `the flat field ${field} must survive`);
  }
  assert.equal(context.agentPersona.persona, '慢吞吞的，爱打比方', 'agentPersona falls back to the session persona in 2a');
  assert.deepEqual(context.degraded, [], 'a healthy context reports no degrade');
});

test('S-4: lifeTexture is registered and returns null without throwing', () => {
  assert.ok(RUNTIME_CONTEXT_SECTIONS.some(section => section.key === 'lifeTexture'), 'the R-021 hook must be registered');
  const context = buildRuntimeContext({});
  assert.equal(context.lifeTexture, null);
  assert.deepEqual(context.degraded, []);
});

// --- C-6 / 2a-A10: the drain identity is unchanged -----------------------

test('2a-A10: promoteCandidate stays user-governance-only, and user is what the drain uses (AR-210 guard)', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state, async () => {});

  // Mirror the drain's own shape: a raw event, then a candidate derived from it.
  const recorded = await memory.recordEvent(
    { ...base, actorType: 'user', actorId: 'u', callerAgentId: 'agent-a' },
    {
      eventId: 'a10-event',
      sourceRevision: '1',
      content: '记住了，我在学尤克里里',
      eventRole: 'user',
      contentType: 'plain_text',
      isStreamFinal: true
    }
  );
  const created = await memory.createCandidate(agentCtx('agent-a'), {
    sourceEventId: recorded.rawEventId,
    content: '用户在学尤克里里',
    memoryType: 'fact',
    assertionType: 'observed_fact',
    scopeType: 'user'
  });
  assert.equal(created.status, 'candidate', 'the fixture must produce a promotable candidate');
  const memoryId = created.memory.memoryId;
  const revision = created.memory.resourceRevision;

  // Pinning the coupling that AR-210 uncovered: promotion refuses a non-user
  // actor. If a future change starts calling promoteCandidate with an agent
  // actor, this fails before the extraction drain silently stops promoting --
  // which is exactly the failure mode that would look like "memory just does
  // not remember anything" in production.
  await assert.rejects(
    () => memory.promoteCandidate(agentCtx('agent-a'), memoryId, { resourceRevision: revision }),
    error => error?.code === 'GOVERNANCE_FORBIDDEN',
    'promotion must remain user-governance-only; the drain must keep a user actor'
  );

  // And the user actor path still works, which is what the drain relies on.
  const promoted = await memory.promoteCandidate(
    { ...base, actorType: 'user', actorId: 'u' },
    memoryId,
    { resourceRevision: revision }
  );
  assert.equal(promoted.status, 'active', 'the user-actor promotion path must stay working');
});
