// Probe: is there a cross-agent retrieval leak that read-scope narrowing misses?
//
// VERDICT as of 2026-09-12: the gap was real and is now CLOSED. This script
// asserts the closed behaviour, so it fails loudly if the leak returns.
//
// Background. R-020 stage 2a enforces agent isolation by narrowing the READ
// scope (`readScope = { agentId }`, injected server-side from the session) while
// deliberately keeping actorType 'user'. That narrows by OWNER on the
// `relationship` and `life` partitions and, by design, never hides `user`-scope
// memories (agent-scope-2a.test.js R-4 -- governance and export need that).
//
// The gap was that scope and origin are different axes: an assertion that merely
// LANDED on scope 'user' can still be something the user told agent A in private.
// Measured on 2026-09-12, before the fix:
//
//     { "rawEventMetadata": {}, "provenanceFieldPresent": false,
//       "agentA_sees": true, "agentB_sees": true, "leak": true }
//
// The fix (same shape as upstream ksys404/Cochpia 92225a6 "scope retrieval by
// agent to stop cross-agent persona leak"):
//
//   1. memory-module.js recordEvent tags the raw event with
//      metadata.source_agent_id, taken server-side from the resolved
//      callerAgentId. It is deliberately NOT in the metadata allow-list, so a
//      request body cannot forge it.
//   2. memory-module.js canSee hides, in a narrowed read, any assertion whose
//      tagged origin points at a different agent.
//   3. Untagged origins never block. The pre-existing history carries no tag and
//      hiding it would silently erase the user's own memories.
//
// Residual window: memories written before 2026-09-12 carry no tag and stay
// visible to every agent, exactly as before. Closing that fully would need a
// one-off backfill, which has not been done.
//
// Run: node scripts/probe-agent-scope-leak.mjs   (exits 1 if the leak returns)

import { createMemoryModule, createMemoryModuleState } from '../server/memory-module.js';

const base = { tenantId: 't', subjectUserId: 'u' };
const agentCtx = id => ({ ...base, actorType: 'agent', actorId: id, callerAgentId: id });
const userCtx = (callerAgentId, readScope) => ({
  ...base, actorType: 'user', actorId: 'u', callerAgentId, ...(readScope ? { readScope } : {})
});

const SECRET = '我只跟你一个人说：我下个月准备离职';
const DERIVED = '用户在准备离职';

const state = createMemoryModuleState();
const memory = createMemoryModule(state, async () => {});

// 1. The user confides in agent A only.
const recorded = await memory.recordEvent(
  { ...base, actorType: 'user', actorId: 'u', callerAgentId: 'agent-a' },
  {
    eventId: 'probe-event-a',
    sourceRevision: '1',
    content: SECRET,
    eventRole: 'user',
    contentType: 'plain_text',
    isStreamFinal: true
  }
);

// 2. The extraction drain turns it into an assertion. scopeType 'user' is what
//    the drain actually produces for user-stated facts, and promotion requires a
//    user actor (AR-210), so this is the real path, not a contrived one.
const created = await memory.createCandidate(agentCtx('agent-a'), {
  sourceEventId: recorded.rawEventId,
  content: DERIVED,
  memoryType: 'fact',
  assertionType: 'observed_fact',
  scopeType: 'user'
});
await memory.promoteCandidate(
  { ...base, actorType: 'user', actorId: 'u' },
  created.memory.memoryId,
  { resourceRevision: created.memory.resourceRevision }
);

const bundleFor = async ctx => {
  const bundle = await memory.contextBundleAsync(ctx, {
    query: '离职 工作',
    purpose: 'answer_user_query',
    tokenBudget: 1800
  });
  const pick = list => (list || []).map(item => item.content);
  return { userProfile: pick(bundle.userProfile), relationshipProfile: pick(bundle.relationshipProfile) };
};

const asA = await bundleFor(userCtx('agent-a', { agentId: 'agent-a' }));
const asB = await bundleFor(userCtx('agent-b', { agentId: 'agent-b' }));
const governance = await bundleFor(userCtx('agent-a'));
const visible = bundle => [...bundle.userProfile, ...bundle.relationshipProfile].some(c => c.includes('离职'));

const rawEvent = (state.rawEvents || []).find(event => event.id === recorded.rawEventId);
const report = {
  rawEventMetadata: rawEvent?.metadata ?? null,
  provenanceFieldPresent: Object.hasOwn(rawEvent?.metadata ?? {}, 'source_agent_id'),
  agentA_sees: visible(asA),
  agentB_sees: visible(asB),
  governanceViewSees: visible(governance),
  leak: visible(asB)
};

console.log(JSON.stringify(report, null, 2));

const problems = [];
if (report.provenanceFieldPresent !== true) problems.push('the raw event carries no provenance tag');
if (report.agentA_sees !== true) problems.push('agent A can no longer see its own material (over-narrowing)');
if (report.leak !== false) problems.push("agent B still retrieves agent A's private material (LEAK)");
if (report.governanceViewSees !== true) problems.push('the un-narrowed governance view lost visibility (over-narrowing)');

if (problems.length) {
  console.error(`REGRESSION:\n- ${problems.join('\n- ')}`);
  process.exitCode = 1;
}
