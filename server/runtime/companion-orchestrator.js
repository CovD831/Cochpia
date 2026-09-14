// CompanionOrchestrator — Phase 2 runtime boundary.
//
// The composition root for a single chat turn. It wires the two other runtime
// boundaries together and runs the per-turn sequence:
//
//   identity (IdentityRelationshipContext)   -> shared per-request context
//   collect -> context -> model -> finalize  -> via the turn service + finalizer
//
// The actual collect (admission + memory binding/event), context (retrieval),
// and model (generation) steps are realized inside the turn service's handleTurn.
// The orchestrator's explicit job is to build the identity context, construct the
// request-scoped adapter, and hand the turn + its projection drain to the
// InteractionFinalizer — the route only ever calls `runTurn` (or `forRequest`
// for the streaming transport).
//
// No business logic is duplicated here: adapter construction is moved verbatim
// from server/index.js coreV0ServiceForRequest, and finalize is delegated to the
// finalizer.

import { randomUUID } from 'node:crypto';
import { storageProvider } from '../store.js';
import { createCoreV0ProductionAdapter, createCoreV0LocalAdapter } from '../core-v0-production.js';
import { CoreV0Error } from '../core-v0.js';

export function createCompanionOrchestrator({
  getRequestState,
  memoryRuntime,
  identityContext,
  finalizer,
  observability,
  resolveCorrelationId,
  generateId = randomUUID,
  // Adapter factories are injectable so tests can supply fakes without a
  // PostgreSQL connection. Defaults are the real production/local adapters.
  createProductionAdapter = createCoreV0ProductionAdapter,
  createLocalAdapter = createCoreV0LocalAdapter
} = {}) {
  if (typeof getRequestState !== 'function') throw new TypeError('CompanionOrchestrator requires getRequestState');
  if (!memoryRuntime || typeof memoryRuntime.contextFromRequest !== 'function') throw new TypeError('CompanionOrchestrator requires a Memory runtime');
  if (typeof identityContext !== 'function') throw new TypeError('CompanionOrchestrator requires identityContext');
  if (!finalizer || typeof finalizer.finalizeTurn !== 'function') throw new TypeError('CompanionOrchestrator requires a finalizer');

  const recordDegrade = reason => {
    try { observability?.recordMemoryDegrade?.(reason); } catch { /* metric is best-effort */ }
  };

  const buildServiceForRequest = async req => {
    const requestState = getRequestState();
    const sessionId = req.body?.sessionId ?? req.body?.session_id ?? req.query?.sessionId ?? null;
    const session = (requestState.sessions || []).find(item => item.id === sessionId) || null;
    const context = identityContext({
      rawContext: memoryRuntime.contextFromRequest(req, { chat: true }),
      session,
      requestId: req.requestId || null,
      traceId: req.traceId || null,
      correlationId: resolveCorrelationId({
        correlationHeader: req.get('x-correlation-id'),
        traceId: req.traceId,
        requestId: req.requestId,
        generate: generateId
      })
    });

    if (storageProvider === 'postgres') {
      const adapter = await createProductionAdapter({
        context,
        baseState: requestState,
        modelProvider: session?.modelProvider || process.env.MODEL_PROVIDER || 'mock',
        modelName: session?.modelName || ''
      });
      return { turnService: adapter.service, drainExtraction: adapter.drainExtraction };
    }
    if (process.env.NODE_ENV === 'production') {
      throw new CoreV0Error('CORE_V0_PRODUCTION_STORAGE_REQUIRED', 'PostgreSQL storage is required for Core v0 in production', { status: 503, retryable: false });
    }
    const jsonModelProvider = process.env.CORE_V0_JSON_MODEL_PROVIDER || 'mock';
    const adapter = createLocalAdapter({
      state: requestState,
      context,
      memoryModule: memoryRuntime.moduleForRequest(req),
      modelProvider: jsonModelProvider
    });
    return { turnService: adapter.service, drainExtraction: adapter.drainExtraction };
  };

  return {
    // Build a request-scoped turn service + projection drain (used by the
    // streaming transport, which owns SSE framing itself). Returns the
    // { service, drainExtraction } shape the turn stream expects.
    forRequest(req) {
      return buildServiceForRequest(req).then(({ turnService, drainExtraction }) => ({
        service: turnService,
        drainExtraction
      }));
    },

    // The single entry the non-streaming /api/chat/turns route faces.
    async runTurn({ req } = {}) {
      const { turnService, drainExtraction } = await buildServiceForRequest(req);
      return finalizer.finalizeTurn({
        input: { body: req.body || {}, headerIdempotencyKey: req.get('Idempotency-Key') },
        service: turnService,
        drain: drainExtraction,
        onDegrade: recordDegrade
      });
    },

    // Projection dispatch for the streaming transport (which already recorded the
    // degrade metric itself, so it only needs the drain to fire).
    dispatch({ drain } = {}) {
      return finalizer.dispatch({ drain });
    }
  };
}
