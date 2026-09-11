// R-020 stage 3: SSE streaming for /api/chat/turns.
//
// The legacy /api/chat/stream is being retired, and the frontend cannot move
// until turns speaks the same protocol. Three behaviours had to survive the
// move, because the client depends on each of them:
//
//   1. incremental text     -- 'text' events carrying { delta }
//   2. disconnect recovery  -- a run id plus Last-Event-ID replay
//   3. cancellation         -- a client abort must not commit a message
//
// Everything else is deliberately unchanged: the turn still runs through
// admission -> binding -> raw event -> retrieval -> generation -> commit, so
// idempotency and receipts behave exactly as on the non-streaming route. The
// stream is a transport for the generation step, not a second code path.

import { createSseEvent, formatSseEvent, replaySseEvents } from './sse.js';

const ACTIVE_RUN_TTL_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 15_000;
const MAX_BUFFERED_EVENTS = 4000;

// Runs are held in memory so a dropped connection can reattach by id. This is
// the same lifetime model the legacy route used; the durable record of a turn
// is the turn admission, not the run.
const runs = new Map();
let runCounter = 0;

const sweepRuns = now => {
  for (const [id, run] of runs) {
    if (now - run.touchedAt > ACTIVE_RUN_TTL_MS && !run.active) runs.delete(id);
  }
};

export function resetTurnStreamRuns() {
  runs.clear();
  runCounter = 0;
}

const writeEvent = (run, event, data) => {
  const entry = createSseEvent(run, event, data);
  if (run.events.length > MAX_BUFFERED_EVENTS) run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS);
  const target = run.response;
  if (target && !target.writableEnded && !target.destroyed) target.write(formatSseEvent(entry));
  return entry;
};

const attach = (run, res, lastEventId = '') => {
  run.response = res;
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  for (const entry of replaySseEvents(run.events, lastEventId)) {
    if (!res.writableEnded && !res.destroyed) res.write(formatSseEvent(entry));
  }
  const heartbeat = setInterval(() => {
    if (run.finished || run.response !== res) return clearInterval(heartbeat);
    writeEvent(run, 'heartbeat', { runId: run.id, at: new Date().toISOString() });
  }, HEARTBEAT_MS);
  res.on('close', () => {
    clearInterval(heartbeat);
    if (run.response === res) { run.response = null; run.connected = false; }
    // A closed connection without a completed turn is the disconnect case; the
    // run stays reattachable until its TTL expires.
    if (!run.finished) run.touchedAt = Date.now();
  });
};

const finishRun = (run, payload) => {
  if (run.finished) return;
  run.finished = true;
  run.active = false;
  run.touchedAt = Date.now();
  if (!run.cancelled) writeEvent(run, 'done', payload);
  if (run.response) run.response.end();
};

export function createTurnStreamHandler({
  wantsStream = () => false,
  isEnabled = () => true,
  serviceForRequest,
  drainExtraction = async () => {},
  onDegrade = () => {},
  respondError = (res, error) => res.status(500).json({ error: { code: 'CORE_V0_FAILED', message: error?.message || 'failed' } }),
  now = () => Date.now()
} = {}) {
  // Reattach: GET /api/chat/turns/:runId with Last-Event-ID
  const reattach = (req, res) => {
    const run = runs.get(String(req.params.runId || ''));
    if (!run) return res.status(404).json({ error: { code: 'CHAT_RUN_NOT_FOUND', message: 'Streaming run not found' } });
    attach(run, res, req.get('Last-Event-ID') || '');
    return undefined;
  };

  // POST /api/chat/turns with Accept: text/event-stream
  const start = async (req, res) => {
    if (!isEnabled()) {
      // The route checks this first and reports it properly; this is a
      // safety net for direct callers, so it fails loudly rather than
      // quietly streaming nothing.
      return respondError(res, Object.assign(new Error('Core v0 is disabled; set CORE_V0_ENABLED=true'), { code: 'CORE_V0_DISABLED', status: 503, retryable: true }));
    }

    sweepRuns(now());
    runCounter += 1;
    const run = {
      id: `turn-run-${runCounter}`,
      events: [],
      sequence: 0,
      response: null,
      connected: false,
      finished: false,
      active: true,
      cancelled: false,
      touchedAt: now()
    };
    runs.set(run.id, run);
    attach(run, res);

    try {
      const { service, drainExtraction: drain } = await serviceForRequest(req);
      // The metadata event goes out before generation so the client can show
      // the run and start assembling deltas.
      writeEvent(run, 'meta', { runId: run.id, protocol: 'cochpia.sse.v1', memoryStatus: 'pending' });

      const result = await service.handleTurn(
        { body: req.body || {}, headerIdempotencyKey: req.get('Idempotency-Key') },
        {
          // A cancelled run stops the turn itself, not just the output: the
          // service aborts generation on this predicate, so no assistant
          // message is ever committed for a reply the client stopped.
          shouldAbort: () => run.cancelled,
          onDelta: delta => {
            if (run.cancelled) return;
            writeEvent(run, 'text', { delta });
          }
        }
      );

      if (result?.memoryStatus === 'degraded') onDegrade(result.memoryDegradedReason);

      if (run.cancelled) {
        run.finished = true;
        run.active = false;
        run.touchedAt = now();
        if (run.response) run.response.end();
        return undefined;
      }

      if (result?.status === 'pending') {
        // The turn was accepted but not resolved. The client keeps the run id
        // and can reattach; the drain still fires because the raw event is
        // durable.
        writeEvent(run, 'done', { ok: false, runId: run.id, turnId: result.turnId, status: 'pending', retryable: true });
        if (run.response) run.response.end();
        run.finished = true;
        run.active = false;
        setImmediate(() => { Promise.resolve(drainExtraction(drain)).catch(() => {}); });
        return undefined;
      }

      finishRun(run, {
        runId: run.id,
        turnId: result?.turnId || null,
        messageId: result?.assistantMessageId || null,
        memoryStatus: result?.memoryStatus || 'available',
        memoryDegradedReason: result?.memoryDegradedReason || null,
        recalledCount: Number(result?.recalledCount ?? 0),
        ok: true
      });
      setImmediate(() => { Promise.resolve(drainExtraction(drain)).catch(() => {}); });
      return undefined;
    } catch (error) {
      // A cancellation is a client decision, not a failure: it closes the
      // stream quietly rather than reporting an error the user did not cause.
      const cancelled = run.cancelled || error?.code === 'TURN_CANCELLED';
      if (cancelled) {
        run.finished = true;
        run.active = false;
        run.touchedAt = now();
        if (run.response) run.response.end();
        return undefined;
      }
      writeEvent(run, 'error', { code: error?.code || 'CORE_V0_FAILED', message: error?.message || 'Turn failed' });
      finishRun(run, { ok: false, runId: run.id, code: error?.code || 'CORE_V0_FAILED' });
      return undefined;
    }
  };

  // DELETE /api/chat/turns/:runId -- explicit cancellation
  const cancel = (req, res) => {
    const run = runs.get(String(req.params.runId || ''));
    if (!run) return res.status(404).json({ error: { code: 'CHAT_RUN_NOT_FOUND', message: 'Streaming run not found' } });
    if (run.finished) return res.json({ ok: true, runId: run.id, alreadyFinished: true });
    run.cancelled = true;
    // Abort the underlying generation so the model call stops rather than
    // being left to run to completion for a client that has gone away.
    if (run.abort) run.abort();
    run.finished = true;
    run.active = false;
    run.touchedAt = now();
    if (run.response) run.response.end();
    return res.json({ ok: true, runId: run.id, cancelled: true });
  };

  return {
    // True when this request should be served as a stream.
    wantsStream: req => wantsStream(req),
    start,
    reattach,
    cancel,
    registerAbort: (runId, controller) => {
      const run = runs.get(runId);
      if (run) run.abort = () => controller.abort();
    },
    getRun: runId => runs.get(runId) || null
  };
}
