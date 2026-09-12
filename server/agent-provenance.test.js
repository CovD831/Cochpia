// R-020 provenance tagging acceptance (2026-09-12).
//
// Companion to scripts/probe-agent-scope-leak.mjs, which is the standalone
// reproducible evidence. This file is the regression gate that runs inside
// `npm test`.
//
// The contract. Two axes govern visibility:
//
//   scope    (scopeType)  -- WHERE a memory may be used
//   origin   (provenance) -- WHO produced the material
//
// Stage 2a's read-scope narrowing (C-7) only covers the first axis, and only on
// the relationship / life partitions. An assertion that merely landed on scope
// 'user' can still be something the user told a different agent in private, so
// stage 2a alone left a real cross-agent leak (measured 2026-09-12:
// agent B retrieved agent A's confided material verbatim).
//
// Resolution (same shape as upstream ksys404/Cochpia 92225a6):
//
//   P-1  an assertion derived from another agent's event is hidden in a
//        narrowed read
//   P-2  the producing agent still sees its own material (no over-narrowing)
//   P-3  the un-narrowed view is untouched (governance / export keep full sight)
//   P-4  untagged material keeps its old behaviour (compatibility: the entire
//        pre-2026-09-12 history is untagged, and hiding it would erase the
//        user's own memories)
//   P-5  the tag is server-derived and cannot be forged through a request body

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryModule, createMemoryModuleState } from './memory-module.js';

const base = { tenantId: 't', subjectUserId: 'u' };
const agentCtx = id => ({ ...base, actorType: 'agent', actorId: id, callerAgentId: id });
const userCtx = (callerAgentId, readScope) => ({
  ...base, actorType: 'user', actorId: 'u', callerAgentId, ...(readScope ? { readScope } : {})
});

const CONFIDED = '用户在准备离职';

// Mirror the drain: raw event under agent A -> candidate -> user-actor promotion.
const seedFromAgentA = async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state, async () => {});
  const recorded = await memory.recordEvent(
    { ...base, actorType: 'user', actorId: 'u', callerAgentId: 'agent-a' },
    {
      eventId: 'prov-event-a',
      sourceRevision: '1',
      content: '我只跟你一个人说：我下个月准备离职',
      eventRole: 'user',
      contentType: 'plain_text',
      isStreamFinal: true
    }
  );
  const created = await memory.createCandidate(agentCtx('agent-a'), {
    sourceEventId: recorded.rawEventId,
    content: CONFIDED,
    memoryType: 'fact',
    assertionType: 'observed_fact',
    scopeType: 'user'
  });
  await memory.promoteCandidate(
    { ...base, actorType: 'user', actorId: 'u' },
    created.memory.memoryId,
    { resourceRevision: created.memory.resourceRevision }
  );
  return { state, memory, rawEventId: recorded.rawEventId };
};

const sees = async (memory, ctx, needle) => {
  const bundle = await memory.contextBundleAsync(ctx, {
    query: '离职 工作',
    purpose: 'answer_user_query',
    tokenBudget: 1800
  });
  return [...(bundle.userProfile || []), ...(bundle.relationshipProfile || [])]
    .some(item => String(item.content).includes(needle));
};

test('P-0: the raw event is tagged with the producing agent, server-side', async () => {
  const { state, rawEventId } = await seedFromAgentA();
  const rawEvent = state.rawEvents.find(event => event.id === rawEventId);
  assert.equal(rawEvent?.metadata?.source_agent_id, 'agent-a', 'the producing agent must be recorded');
});

test('P-1/P-2: a narrowed read hides another agent\'s origin and keeps your own', async () => {
  const { memory } = await seedFromAgentA();
  assert.equal(
    await sees(memory, userCtx('agent-b', { agentId: 'agent-b' }), '离职'),
    false,
    'agent B must not retrieve material confided to agent A'
  );
  assert.equal(
    await sees(memory, userCtx('agent-a', { agentId: 'agent-a' }), '离职'),
    true,
    'agent A must still see what the user told it'
  );
});

test('P-3: the un-narrowed view keeps full sight (governance and export depend on it)', async () => {
  const { memory } = await seedFromAgentA();
  assert.equal(
    await sees(memory, userCtx('agent-a'), '离职'),
    true,
    'without a read scope nothing changes'
  );
});

test('P-4: untagged material keeps its old behaviour (pre-tagging history)', async () => {
  // hold() creates an assertion with no raw-event origin, which is exactly the
  // shape of everything written before provenance tagging existed.
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state, async () => {});
  await memory.hold({ ...base, actorType: 'user', actorId: 'u' }, {
    idempotency_key: 'legacy-user-memory',
    content: '用户偏好：喜欢黑咖啡',
    memoryType: 'preference',
    assertionType: 'observed_fact',
    scopeType: 'user',
    sensitivity: 'S0'
  });

  assert.equal(
    await sees(memory, userCtx('agent-b', { agentId: 'agent-b' }), '黑咖啡'),
    true,
    'untagged history stays visible; hiding it would silently erase the user\'s own memories'
  );
});

test('P-5: provenance cannot be forged through the request body', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state, async () => {});

  // An unknown metadata field is still rejected outright...
  await assert.rejects(
    () => memory.recordEvent(
      { ...base, actorType: 'user', actorId: 'u', callerAgentId: 'agent-b' },
      {
        eventId: 'forge-event',
        content: 'try to look like agent A',
        metadata: { source_agent_id: 'agent-a' }
      }
    ),
    error => error.code === 'INVALID_METADATA',
    'source_agent_id must not be an accepted request field'
  );

  // ...and when it is left out, the server writes the resolved agent instead.
  const recorded = await memory.recordEvent(
    { ...base, actorType: 'user', actorId: 'u', callerAgentId: 'agent-b' },
    { eventId: 'forge-event-2', content: 'ordinary event' }
  );
  const rawEvent = state.rawEvents.find(event => event.id === recorded.rawEventId);
  assert.equal(rawEvent.metadata.source_agent_id, 'agent-b', 'the tag comes from the resolved caller, not the body');
});
