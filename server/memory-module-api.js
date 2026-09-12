import express from 'express';
import { randomUUID } from 'node:crypto';
import { MemoryModuleError } from './memory-module.js';

function sendError(res, error, requestId) {
  const isMemoryError = error instanceof MemoryModuleError;
  const code = isMemoryError ? error.code : error.code || 'MEMORY_MODULE_ERROR';
  const status = isMemoryError ? error.status : error.status || 500;
  const message = isMemoryError || code === 'MEMORY_STORAGE_CONFLICT' ? error.message : 'Memory Module request failed';
  res.status(status).json({
    error: {
      code,
      message,
      request_id: requestId,
      retryable: Boolean(error.retryable),
      retry_after_ms: null,
      current_resource_revision: isMemoryError ? error.currentResourceRevision : null
    }
  });
}

function bodyOrQuery(req) {
  return req.method === 'GET' ? req.query : (req.body || {});
}

function mutationInput(req) {
  const body = bodyOrQuery(req) || {};
  const headerKey = req.get('Idempotency-Key');
  const bodyKey = body.idempotencyKey ?? body.idempotency_key;
  if (headerKey && bodyKey && String(headerKey) !== String(bodyKey)) {
    throw new MemoryModuleError('IDEMPOTENCY_KEY_CONFLICT', 'Header and body idempotency keys do not match', { status: 400 });
  }
  const key = headerKey || bodyKey;
  return key ? { ...body, idempotency_key: key } : body;
}

export function createMemoryModuleRouter({ memoryModuleForRequest, contextFromRequest, narrowRead = false }) {
  if (typeof memoryModuleForRequest !== 'function' || typeof contextFromRequest !== 'function') throw new TypeError('Memory Module router requires memoryModuleForRequest and contextFromRequest');
  const router = express.Router();
  // L2 contract 2c section 4.3 + 4.4.A (2026-09-12, owner ruling B). The three
  // generic read routes below used to carry a callerAgentId without ever
  // deriving a readScope. In the in-process deployment (server/index.js:187)
  // the actor resolves to 'user' (memory-module-runtime.js:80 -- only a service
  // identity makes it 'agent'), and a user actor passes hasGrant on its first
  // line (memory-module.js:352). So readScope is the ONLY narrowing instrument
  // there, and its absence skips the entire provenance filter
  // (memory-module.js:406): agent B could retrieve what the user confided to
  // agent A. Reproduced through this router before the fix.
  //
  // Section 4.4.A added `GET /memories` to the ruling: the same document cited
  // this file as `:55-57` in one place and `:56-57` in another, and `:55` (the
  // list/`memory.list` route) is structurally identical to its two neighbours.
  //
  // `narrowRead` is opt-in, and only the in-process runtime sets it
  // (memory-module-runtime.js `router()`). Two deliberate non-choices:
  //
  //   - It is NOT inferred inside `run()`. `run()` is shared by every route, so
  //     narrowing there would also reach the write routes (/events, POST
  //     /memories, /sessions, /access-grants), governance (/governance/*) and
  //     every mutation route -- a semantic change the ruling does not cover.
  //   - It is NOT enabled for the standalone service
  //     (services/memory-module/index.js:180), whose default actor is 'agent'
  //     and which the ruling left as-is (contract section 4.3 row 1).
  //
  // The injected scope only ever subtracts visibility (I-12) and never touches
  // actorType (I-11): a missing callerAgentId, or an already-present readScope,
  // returns the context untouched.
  const readContext = context => (narrowRead && context?.callerAgentId && !context.readScope)
    ? { ...context, readScope: { agentId: context.callerAgentId } }
    : context;
  const run = (handler, { status = 200 } = {}) => async (req, res) => {
    const requestId = req.requestId || randomUUID();
    try {
      const requestContext = contextFromRequest(req) || {};
      const result = await handler(await memoryModuleForRequest(req), { ...requestContext, requestId }, req);
      return res.status(status).json(result);
    } catch (error) {
      return sendError(res, error, requestId);
    }
  };

  router.post('/events', run((memory, context, req) => memory.recordEvent(context, req.body || {}), { status: 202 }));
  router.post('/sessions', run((memory, context, req) => memory.createSession(context, mutationInput(req)), { status: 201 }));
  router.post('/access-grants', run((memory, context, req) => memory.grantUserScope(context, mutationInput(req)), { status: 201 }));
  router.post('/memories', run((memory, context, req) => memory.hold(context, mutationInput(req)), { status: 201 }));
  // The three read routes that go through `readContext` (contract 2c 4.3 + 4.4.A).
  router.get('/memories', run((memory, context, req) => memory.list(readContext(context), { ...bodyOrQuery(req), returnPage: true })));
  router.post('/retrieve', run((memory, context, req) => (memory.retrieveAsync || memory.retrieve).call(memory, readContext(context), req.body || {})));
  router.post('/context-bundles', run((memory, context, req) => (memory.contextBundleAsync || memory.contextBundle).call(memory, readContext(context), req.body || {})));
  router.get('/confirmations', run((memory, context, req) => memory.listConfirmations(context, { ...(req.query || {}), returnPage: true })));
  router.get('/deletion-operations/:id', run((memory, context, req) => {
    const operation = memory.getDeletionOperation(context, req.params.id);
    if (!operation) throw new MemoryModuleError('DELETION_OPERATION_NOT_FOUND', 'Deletion operation not found', { status: 404 });
    return operation;
  }));

  router.get('/memories/:id', run((memory, context, req) => {
    const item = memory.get(context, req.params.id, { purpose: req.query.purpose });
    if (!item) throw new MemoryModuleError('MEMORY_NOT_FOUND', 'Memory not found', { status: 404 });
    return item;
  }));
  router.post('/memories/:id/correct', run((memory, context, req) => memory.correct(context, req.params.id, mutationInput(req))));
  router.post('/memories/:id/promote', run((memory, context, req) => memory.promoteCandidate(context, req.params.id, mutationInput(req))));
  router.post('/memories/:id/pin', run((memory, context, req) => memory.pin(context, req.params.id, mutationInput(req))));
  router.post('/memories/:id/unpin', run((memory, context, req) => memory.unpin(context, req.params.id, mutationInput(req))));
  router.post('/memories/:id/revoke', run((memory, context, req) => memory.revoke(context, req.params.id, mutationInput(req))));
  router.post('/memories/:id/forget', run((memory, context, req) => memory.forget(context, req.params.id, mutationInput(req))));
  router.post('/governance/forget', run((memory, context, req) => {
    const body = mutationInput(req);
    if (body.target_type === 'source_event') return memory.forgetSourceEvent(context, body.target_id, body);
    if (body.target_type === 'session') return memory.forgetSession(context, body.target_id, body);
    if (body.target_type === 'relationship') return memory.forgetRelationship(context, body.target_id, body);
    if (body.target_type === 'account') return memory.forgetAccount(context, body);
    throw new MemoryModuleError('UNSUPPORTED_GOVERNANCE_TARGET', 'Unsupported forget target', { status: 400 });
  }));
  router.post('/governance/delete', run((memory, context, req) => {
    const body = mutationInput(req);
    if (body.target_type === 'source_event') return memory.deleteSourceEvent(context, body.target_id, body);
    if (body.target_type === 'session') return memory.deleteSession(context, body.target_id, body);
    if (body.target_type === 'relationship') return memory.deleteRelationship(context, body.target_id, body);
    if (body.target_type === 'account') return memory.deleteAccount(context, body);
    throw new MemoryModuleError('UNSUPPORTED_GOVERNANCE_TARGET', 'Unsupported delete target', { status: 400 });
  }));
  router.delete('/memories/:id', run((memory, context, req) => memory.remove(context, req.params.id, mutationInput(req))));
  router.post('/confirmations/:id/confirm', run((memory, context, req) => memory.confirm(context, req.params.id, mutationInput(req))));
  router.post('/confirmations/:id/reject', run((memory, context, req) => memory.reject(context, req.params.id, mutationInput(req))));
  router.post('/access-confirmations/:id/confirm', run((memory, context, req) => memory.confirmAccess(context, req.params.id, mutationInput(req))));
  router.post('/mentions', run((memory, context, req) => memory.recordMention(context, mutationInput(req))));
  router.post('/sessions/:id/current-state', run((memory, context, req) => memory.writeCurrentState(context, { ...mutationInput(req), sessionId: req.params.id })));

  return router;
}
