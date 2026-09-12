// Probe: is there a cross-agent retrieval leak that read-scope narrowing misses?
//
// VERDICT as of 2026-09-12: YES, the leak is real. Run it and read the output.
//
// Why it exists. R-020 stage 2a enforces agent isolation by narrowing the READ
// scope (`readScope = { agentId }`, injected server-side from the session) while
// deliberately keeping actorType 'user'. That narrows the `relationship` and
// `life` partitions (see agent-scope-2a.test.js R-2/R-3/L-3) and, by design,
// never hides `user`-scope memories (R-4 -- governance and export need that).
//
// The gap is that scope and provenance are different axes. An assertion that
// merely LANDED on scope 'user' can still be something the user told agent A in
// private. Nothing in the write path records where an assertion came from:
// sanitizeMetadata's allow-list has no source_agent_id, so even the raw event
// carries no provenance. Agent B therefore retrieves A's private material
// verbatim, and readScope cannot tell the difference.
//
// Upstream (ksys404/Cochpia, commit 92225a6 "scope retrieval by agent to stop
// cross-agent persona leak", 2026-09-04) fixed the same bug independently by
// tagging raw events with metadata.source_agent_id at WRITE time and filtering
// retrieval by provenance, with an explicit back-compat rule (untagged legacy
// memories stay visible to every agent).
//
// This script is the reproducible evidence for that finding. It is not wired
// into `npm test` on purpose: it asserts the CURRENT behaviour, and pinning a
// leak as expected would be worse than not testing it. When the leak is fixed,
// this script becomes the regression test -- flip the assertion at the bottom.
//
// Run: node scripts/probe-agent-scope-leak.mjs

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
const visible = bundle => [...bundle.userProfile, ...bundle.relationshipProfile].some(c => c.includes('离职'));

const rawEvent = (state.rawEvents || []).find(event => event.id === recorded.rawEventId);
const report = {
  promoted: created.memory.memoryId,
  rawEventMetadata: rawEvent?.metadata ?? null,
  provenanceFieldPresent: Object.hasOwn(rawEvent?.metadata ?? {}, 'source_agent_id'),
  agentA_sees: visible(asA),
  agentB_sees: visible(asB),
  leak: visible(asB)
};

console.log(JSON.stringify(report, null, 2));

// Current, deliberately unfixed behaviour: B does see it. Once provenance
// tagging lands, this assertion flips and the script graduates into a test.
if (!report.leak) {
  console.error('UNEXPECTED: the leak appears to be closed. Move this probe into npm test as a regression.');
  process.exitCode = 2;
}
