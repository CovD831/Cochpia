import { formatSseEvent, replaySseEvents } from '../sse.js';

export function createRunRegistry({ activeRuns, streamRuns, send, streamRetentionMs }) {
  const finishRun = run => {
    if (run.finished) return;
    run.finished = true;
    if (activeRuns.get(run.key) === run) activeRuns.delete(run.key);
    if (run.heartbeat) clearInterval(run.heartbeat);
    if (run.deadline) clearTimeout(run.deadline);
    setTimeout(() => { if (streamRuns.get(run.id) === run) streamRuns.delete(run.id); }, streamRetentionMs).unref?.();
  };

  const attachStreamResponse = (run, res, afterId = '') => {
    run.response = res;
    run.connected = true;
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    for (const entry of replaySseEvents(run.events, afterId)) {
      if (!res.writableEnded && !res.destroyed) res.write(formatSseEvent(entry));
    }
    const heartbeat = setInterval(() => {
      if (run.finished || run.response !== res) return clearInterval(heartbeat);
      send(res, 'heartbeat', { runId: run.id, at: new Date().toISOString() }, run);
    }, 15_000);
    res.on('close', () => {
      clearInterval(heartbeat);
      if (run.response === res) {
        run.response = null; run.connected = false;
        if (!run.finished) { run.cancelled = true; run.controller.abort(); }
      }
    });
  };

  return { finishRun, attachStreamResponse };
}
