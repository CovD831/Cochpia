// InteractionFinalizer — Phase 2 runtime boundary.
//
// Splits finalize into two boundaries, exactly as the foundation plan §2.1 (J)
// prescribes:
//
//   Commit Coordinator    — the interaction result: the assistant event, the
//                           idempotent commit receipt, and duplicate-submission
//                           protection. Realized by the turn service's
//                           handleTurn (which performs collect -> context ->
//                           model -> commit and enforces idempotency).
//
//   Projection Dispatcher — async, fire-and-forget dispatch of the projection
//                           drain (state / memory / personality / audit /
//                           metrics). Never blocks the response and never throws
//                           into the caller.
//
// The route only ever faces `finalizeTurn`. The degrade metric is recorded by the
// caller (the orchestrator / turn stream) before dispatch, so it fires exactly
// once per turn.

// Commit Coordinator. Owns the interaction result: runs the turn through the
// service and returns the committed result (assistant event + idempotency
// receipt). Idempotency is enforced inside handleTurn.
export function createCommitCoordinator() {
  return {
    async commit({ input, service } = {}) {
      if (!service || typeof service.handleTurn !== 'function') {
        throw new TypeError('Commit Coordinator requires a turn service with handleTurn');
      }
      return service.handleTurn(input);
    }
  };
}

// Projection Dispatcher. Fires the async projection drain outside the response
// path. A null/undefined drain is a no-op (mirrors the legacy coreV0DrainExtraction
// early return), and any drain rejection is swallowed via onError.
export function createProjectionDispatcher({ onError = () => {} } = {}) {
  const safeOnError = typeof onError === 'function' ? onError : () => {};
  return {
    dispatch({ drain = null } = {}) {
      setImmediate(() => {
        Promise.resolve(typeof drain === 'function' ? drain() : null).catch(safeOnError);
      });
    }
  };
}

// InteractionFinalizer. The single interface the route faces for finalize.
export function createInteractionFinalizer({
  commitCoordinator = createCommitCoordinator(),
  projectionDispatcher = createProjectionDispatcher()
} = {}) {
  const dispatch = projectionDispatcher.dispatch.bind(projectionDispatcher);

  return {
    commitCoordinator,
    projectionDispatcher,

    // Run commit (interaction result + assistant event + idempotency), record a
    // degrade metric if the turn degraded, then dispatch projections. Returns the
    // committed result unchanged so the route serializes it verbatim.
    async finalizeTurn({ input, service, drain = null, onDegrade = null } = {}) {
      const result = await commitCoordinator.commit({ input, service });
      if (onDegrade && result && result.memoryStatus === 'degraded') {
        try { onDegrade(result.memoryDegradedReason); } catch { /* metric is best-effort */ }
      }
      dispatch({ drain });
      return result;
    },

    async commit({ input, service }) {
      return commitCoordinator.commit({ input, service });
    },

    dispatch({ drain } = {}) {
      return dispatch({ drain });
    }
  };
}
