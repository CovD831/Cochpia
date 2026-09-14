// IdentityRelationshipContext — Phase 2 runtime boundary.
//
// Unifies the per-request shared identity/relationship context:
//   tenant / user / agent / relationship / session / actor / grant
//
// This is a PURE module. It takes the identity primitives that were previously
// scattered across server/index.js (resolveAgentIdForRequest,
// coreV0ContextForRequest) and server/memory-module-runtime.js (contextFromRequest)
// and produces one explicit, structured context DTO.
//
// It does NOT copy Memory Module permission facts (scope/grant ownership). Those
// remain the Memory Module's; this module only surfaces a grant/relationship if
// the caller has already derived it, and otherwise leaves them null. Memory
// scope facts are resolved downstream by the Memory Module via the
// server-resolved callerAgentId.

import { randomUUID } from 'node:crypto';

const str = value => (value === undefined || value === null ? '' : String(value));
const trimOrNull = value => {
  const trimmed = str(value).trim();
  return trimmed ? trimmed : null;
};

// Build the unified per-request identity & relationship context.
//
// Inputs (all explicit — no implicit globals, no req/memoryRuntime access):
//   rawContext  — output of memoryRuntime.contextFromRequest(req, { chat: true }):
//                 { tenantId, subjectUserId, actorType, actorId, callerAgentId,
//                   producer, correlationId, sessionId }
//   session    — the application session object (for agentId / relationshipId)
//   requestId  — req.requestId
//   traceId    — req.traceId
//   correlationId — already-resolved correlation id
//
// Output: a flat context DTO consumed by the Memory port, Core v0 store,
// adapter and turn service. Extra keys (agentId/relationshipId/grant) are
// additive and never change existing consumers.
export function buildIdentityRelationshipContext({
  rawContext = {},
  session = null,
  requestId = null,
  traceId = null,
  correlationId = null
} = {}) {
  const tenantId = trimOrNull(rawContext.tenantId);
  const subjectUserId = trimOrNull(rawContext.subjectUserId);
  const actorType = trimOrNull(rawContext.actorType) || 'user';
  const actorId = trimOrNull(rawContext.actorId);
  // The agent identity is authoritative from the Memory-derived callerAgentId;
  // the session's agentId is only a fallback (it is the same value the Memory
  // runtime already resolved, so this never produces a divergent identity).
  const callerAgentId = trimOrNull(rawContext.callerAgentId) || trimOrNull(session?.agentId);
  // Legacy chat context has sessionId === null (chat=true); preserve that so
  // downstream spreads are byte-identical. The application session id is
  // surfaced separately for completeness.
  const sessionId = trimOrNull(rawContext.sessionId);
  const applicationSessionId = session?.id ? String(session.id) : (trimOrNull(rawContext.applicationSessionId) || null);
  // We do NOT re-derive Memory Module permission facts. relationshipId/grant are
  // passed through if already present, otherwise null.
  const relationshipId = rawContext.relationshipId ?? session?.relationshipId ?? null;
  const grant = rawContext.grant ?? null;

  return {
    tenantId,
    subjectUserId,
    actorType,
    actorId,
    callerAgentId,
    agentId: callerAgentId,
    sessionId,
    applicationSessionId,
    relationshipId,
    grant,
    requestId: requestId ?? null,
    traceId: traceId ?? null,
    correlationId: correlationId ?? null,
    producer: 'companion-core'
  };
}

// Resolve the canonical correlation id from request headers / trace / request id,
// generating one only when none is supplied. Preserves the legacy fallback order
// used by coreV0ContextForRequest:
//   x-correlation-id || req.traceId || req.requestId || randomUUID()
export function resolveCorrelationId({
  correlationHeader = null,
  traceId = null,
  requestId = null,
  generate = randomUUID
} = {}) {
  const value = correlationHeader || traceId || requestId || (typeof generate === 'function' ? generate() : null);
  return value ? String(value) : null;
}

// Resolve the calling agent id for a session from request-scoped application
// state (moved verbatim from server/index.js resolveAgentIdForRequest).
// Synchronous and non-throwing: a session with no bound agent yields null, which
// the Memory runtime turns into MEMORY_AGENT_CONTEXT_REQUIRED. The previous
// constant 'cochpia' fallback let every agent share one memory identity.
export function resolveSessionAgentId(state, sessionId) {
  try {
    if (!state || !sessionId) return null;
    const session = (state.sessions || []).find(item => item.id === sessionId);
    return session?.agentId ? String(session.agentId).trim() : null;
  } catch {
    return null;
  }
}

// Build the request-derived agent resolver expected by createMemoryModuleRuntime.
// Keeps the wiring in index.js thin while the logic lives in this module.
export function createRequestAgentResolver(getRequestState) {
  return req => resolveSessionAgentId(
    getRequestState?.() || null,
    req?.body?.sessionId ?? req?.body?.session_id ?? req?.query?.sessionId ?? null
  );
}
