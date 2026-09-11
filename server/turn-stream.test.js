// R-020 stage 3 acceptance: the streaming turn path.
//
// The frontend cannot leave /api/chat/stream until turns reproduces the three
// behaviours it relies on. Each one is pinned here:
//
//   T1  incremental text -- 'text' events carry { delta }, and the assembled
//       text equals what the non-streaming path would commit
//   T2  metadata         -- 'meta' arrives first and carries the run id
//   T3  completion       -- 'done' carries the turn/message ids and ok: true
//   T4  reattach         -- a second connection with Last-Event-ID replays
//       only the later events, so a dropped connection loses nothing
//   T5  cancellation     -- a cancelled run emits nothing further and never
//       commits an assistant message
//   T6  failure          -- a failing generation emits 'error' then 'done ok:false'
//   T7  no double commit -- a replayed idempotency key yields one message
//
// The stream is a transport for generation, not a second turn implementation;
// these tests assert the transport contract, and the turn semantics are covered
// by the existing core-v0 suites.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { createCoreV0TurnService, createCoreV0MockModelGateway, ensureCoreV0State } from './core-v0.js';
import { createTurnStreamHandler, resetTurnStreamRuns } from './turn-stream.js';

const tenantId = 'stream-tenant';
const subjectUserId = 'stream-user';
const agentId = 'stream-agent';
const applicationSessionId = 'stream-session';

const CTX = {
  tenantId,
  subjectUserId,
  actorType: 'user',
  actorId: subjectUserId,
  callerAgentId: agentId,
  producer: 'companion-core',
  correlationId: 'turn-stream'
};

const buildState = () => {
  const state = {
    sessions: [{ id: applicationSessionId, title: 'stream', kind: 'private', agentId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    messages: { [applicationSessionId]: [] },
    memoryModule: createMemoryModuleState(),
    personality: { version: 1, summary: '', traits: [], updatedAt: new Date().toISOString() },
    profile: { name: 'stream-user', gender: 'none', age: null },
    evidence: []
  };
  ensureCoreV0State(state);
  return state;
};

const buildPort = ({ state, generateText = '你好，我在这里。', failGeneration = false } = {}) => {
  const memoryModule = createMemoryModule(state.memoryModule, async () => {});
  const withSession = sessionId => ({ ...CTX, sessionId });
  return {
    memoryModule,
    port: {
      async ensureSessionBinding({ bindingKey }) {
        const result = await memoryModule.createSession(CTX, { idempotency_key: `stream:binding:${bindingKey}`, callerAgentId: agentId });
        const session = result?.session || result;
        return { status: 'completed', memorySessionId: session.id, receipt: { status: 'completed', memorySessionId: session.id } };
      },
      async getSessionBinding({ bindingKey }) {
        const record = (state.memoryModule.idempotencyRecords || []).find(item => item.key === `stream:binding:${bindingKey}`);
        const memorySessionId = record?.response?.id;
        return memorySessionId ? { status: 'completed', memorySessionId, receipt: { status: 'completed', memorySessionId } } : { status: 'not_found' };
      },
      async reconcileSessionBinding(args) { return this.getSessionBinding(args); },
      async appendRawEvent({ event, memorySessionId }) {
        const result = await memoryModule.recordEvent(withSession(memorySessionId), {
          ...event, sessionId: memorySessionId, contentType: 'plain_text', eventRole: event.eventRole || 'user', isStreamFinal: true
        });
        return { status: 'completed', receipt: { status: 'completed', eventId: event.eventId, sourceRevision: event.sourceRevision, rawEventId: result?.id || null, result: 'accepted_stored' } };
      },
      async getRawEventReceipt({ eventId, sourceRevision }) {
        const found = (state.memoryModule.rawEvents || []).find(item => item.eventId === eventId && String(item.sourceRevision) === String(sourceRevision));
        return found ? { status: 'completed', receipt: { status: 'completed', eventId, sourceRevision, rawEventId: found.id, result: 'accepted_stored' } } : { status: 'not_found' };
      },
      async reconcileRawEvent(args) { return this.getRawEventReceipt(args); },
      async retrieveContext() { return { status: 'available', bundle: null, recalled: [], answerability: 'not_found' }; }
    },
    generateText,
    failGeneration
  };
};

// The service is built with a gateway that streams a known sentence word by
// word, so the assembled text can be asserted exactly.
const buildStreamingGateway = ({ text = '你好，我在这里。', failAfterChunks = null } = {}) => ({
  async generate() {
    if (failAfterChunks !== null) throw Object.assign(new Error('model unavailable'), { code: 'MODEL_GENERATION_FAILED' });
    return { status: 'generation_succeeded', content: text };
  },
  async *stream() {
    // [\s\S], not . -- see the note in model-provider.js: '.' skips newlines,
    // which would make this fixture diverge from the real provider.
    const parts = text.match(/[\s\S]{1,2}/gu) || [text];
    let emitted = 0;
    for (const part of parts) {
      // Fail mid-stream: emit `failAfterChunks` deltas, then throw. This is the
      // realistic shape of a provider dropping the connection after partial
      // output, and it is what the client must be able to recover from.
      if (failAfterChunks !== null && emitted >= failAfterChunks) {
        throw Object.assign(new Error('model unavailable'), { code: 'MODEL_GENERATION_FAILED' });
      }
      yield part;
      emitted += 1;
    }
    if (failAfterChunks !== null) {
      throw Object.assign(new Error('model unavailable'), { code: 'MODEL_GENERATION_FAILED' });
    }
  }
});

// A minimal response double: captures what the SSE writer emits and lets the
// test close the connection to simulate a drop.
//
// Note: end() must NOT emit 'close' synchronously. The real http response
// emits 'close' later, asynchronously; emitting it inside end() would detach
// the response before the writer's own follow-up events are flushed, which
// makes a passing implementation look broken.
class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.writableEnded = false;
    this.destroyed = false;
  }
  status(code) { this.statusCode = code; return this; }
  set(headers) { Object.assign(this.headers, headers); return this; }
  flushHeaders() {}
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  end() { this.writableEnded = true; }
  // Simulate a client disconnect (used by the cancellation test).
  simulateClose() { this.destroyed = true; this.emit('close'); }
  body() { return this.chunks.join(''); }
  // Parsed view: [{ event, id, data }]
  events() {
    return this.body().split('\n\n').filter(Boolean).map(block => {
      const event = block.match(/^event:\s*(.+)$/m)?.[1];
      const id = block.match(/^id:\s*(.+)$/m)?.[1];
      const dataText = block.match(/^data:\s*(.+)$/ms)?.[1];
      return { event, id, data: dataText ? JSON.parse(dataText) : null };
    });
  }
}

const buildHarness = ({ text, failAfterChunks = null, generateText } = {}) => {
  resetTurnStreamRuns();
  const state = buildState();
  const { port } = buildPort({ state, generateText });
  const service = createCoreV0TurnService({
    state,
    context: CTX,
    memoryPort: port,
    modelGateway: buildStreamingGateway({ text: text ?? '你好，我在这里。', failAfterChunks })
  });
  const handler = createTurnStreamHandler({
    wantsStream: () => true,
    isEnabled: () => true,
    serviceForRequest: async () => ({ service, drainExtraction: null }),
    drainExtraction: async () => {},
    respondError: (res, error) => res.status(error?.status || 500).json({ error: { code: error?.code || 'CORE_V0_FAILED', message: error?.message } })
  });
  const req = {
    body: { sessionId: applicationSessionId, message: '你好' },
    query: {},
    params: {},
    get: name => (name === 'Idempotency-Key' ? 'stream-turn-1' : name === 'Last-Event-ID' ? '' : undefined)
  };
  return { state, service, handler, req, port };
};

test('T1/T2/T3: the stream emits meta, incremental deltas, then done with turn ids', async () => {
  const text = '你好，我在这里。';
  const { state, handler, req } = buildHarness({ text });
  const res = new FakeResponse();
  await handler.start(req, res);

  const events = res.events();
  assert.equal(events[0].event, 'meta', 'meta must arrive first');
  assert.ok(events[0].data.runId, 'meta must carry the run id');

  const textEvents = events.filter(item => item.event === 'text');
  assert.ok(textEvents.length > 1, `expected several deltas, got ${textEvents.length}`);
  assert.equal(textEvents.map(item => item.data.delta).join(''), text, 'the deltas must assemble to the full text');

  const done = events.find(item => item.event === 'done');
  assert.ok(done, 'a done event must close the stream');
  assert.equal(done.data.ok, true);
  assert.ok(done.data.turnId, 'done must carry the turn id');

  // The committed message must equal the streamed text.
  const committed = (state.messages[applicationSessionId] || []).find(item => item.role === 'assistant');
  assert.ok(committed, 'the assistant message must be committed');
  assert.equal(committed.content, text, 'the committed content must match what was streamed');
});

test('T1: every event carries a monotonic id for replay', async () => {
  const { handler, req } = buildHarness({ text: '一段话' });
  const res = new FakeResponse();
  await handler.start(req, res);
  const ids = res.events().map(item => Number(String(item.id).split(':').at(-1)));
  assert.ok(ids.length > 1);
  for (let index = 1; index < ids.length; index += 1) {
    assert.ok(ids[index] > ids[index - 1], `event ids must increase: ${ids.join(',')}`);
  }
});

test('T4: reattaching with Last-Event-ID replays only the later events', async () => {
  const { handler, req } = buildHarness({ text: '一二三四五六七八' });
  const first = new FakeResponse();
  await handler.start(req, first);
  const events = first.events();
  const runId = events[0].data.runId;

  // Cut the stream at the second event, as a dropped connection would.
  const cutoff = events[1].id;
  const second = new FakeResponse();
  handler.reattach({ params: { runId }, get: name => (name === 'Last-Event-ID' ? cutoff : undefined) }, second);

  const replayed = second.events();
  assert.ok(replayed.length > 0, 'the replay must deliver the remaining events');
  const cutoffSequence = Number(String(cutoff).split(':').at(-1));
  for (const item of replayed) {
    assert.ok(Number(String(item.id).split(':').at(-1)) > cutoffSequence, `replay must not repeat ${item.id}`);
  }
  assert.ok(replayed.some(item => item.event === 'done'), 'the replay must reach the terminal event');
});

test('T4: an unknown run id is a clean 404, not a hang', () => {
  resetTurnStreamRuns();
  const handler = createTurnStreamHandler({ wantsStream: () => true, isEnabled: () => true, serviceForRequest: async () => { throw new Error('unused'); } });
  const res = new FakeResponse();
  let status = null;
  res.status = code => { status = code; return res; };
  res.json = payload => { res.payload = payload; return res; };
  handler.reattach({ params: { runId: 'nope' }, get: () => undefined }, res);
  assert.equal(status, 404);
  assert.equal(res.payload.error.code, 'CHAT_RUN_NOT_FOUND');
});

test('T5: a cancelled run commits no assistant message', async () => {
  // The generation must take long enough that the cancel lands mid-stream;
  // otherwise the test would assert on a run that already finished.
  resetTurnStreamRuns();
  const state = buildState();
  const { port } = buildPort({ state });
  const text = '这句话不应该出现在任何消息里';
  const gateway = {
    async generate() { return { status: 'generation_succeeded', content: text }; },
    async *stream() {
      for (const part of (text.match(/[\s\S]{1,2}/gu) || [text])) {
        await new Promise(resolve => setTimeout(resolve, 15));
        yield part;
      }
    }
  };
  const service = createCoreV0TurnService({ state, context: CTX, memoryPort: port, modelGateway: gateway });
  const handler = createTurnStreamHandler({
    wantsStream: () => true,
    isEnabled: () => true,
    serviceForRequest: async () => ({ service, drainExtraction: null }),
    drainExtraction: async () => {}
  });

  const res = new FakeResponse();
  const req = {
    body: { sessionId: applicationSessionId, message: '你好' },
    query: {},
    params: {},
    get: name => (name === 'Idempotency-Key' ? 'cancel-key' : undefined)
  };

  const started = handler.start(req, res);
  // Wait until the meta event has been written, then cancel while generation
  // is still producing deltas.
  while (!res.events().some(item => item.event === 'meta')) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const runId = res.events()[0].data.runId;

  const cancelRes = new FakeResponse();
  cancelRes.json = payload => { cancelRes.payload = payload; return cancelRes; };
  handler.cancel({ params: { runId } }, cancelRes);
  await started;

  assert.equal(cancelRes.payload.cancelled, true, 'cancel must acknowledge the run');
  const assistants = (state.messages[applicationSessionId] || []).filter(item => item.role === 'assistant');
  assert.equal(assistants.length, 0, 'a cancelled run must never commit a partial reply');
});

test('T6: a failing generation emits error then done with ok:false', async () => {
  const { handler, req } = buildHarness({ text: '不会完成', failAfterChunks: 1 });
  const res = new FakeResponse();
  await handler.start(req, res);
  const events = res.events();
  const error = events.find(item => item.event === 'error');
  assert.ok(error, 'a failing generation must surface an error event');
  assert.ok(error.data.code, 'the error must carry a machine code');
  const done = events.find(item => item.event === 'done');
  assert.ok(done, 'the stream must still terminate with done');
  assert.equal(done.data.ok, false);
});

test('T7: a replayed idempotency key commits exactly one assistant message', async () => {
  const { state, service } = buildHarness({ text: '只应出现一次' });
  const first = await service.handleTurn({ body: { sessionId: applicationSessionId, message: '你好' }, headerIdempotencyKey: 'same-key' });
  const second = await service.handleTurn({ body: { sessionId: applicationSessionId, message: '你好' }, headerIdempotencyKey: 'same-key' });
  assert.equal(first.turnId, second.turnId, 'the replay must resolve to the same turn');
  assert.equal(second.replay, true);
  const assistants = (state.messages[applicationSessionId] || []).filter(item => item.role === 'assistant');
  assert.equal(assistants.length, 1, 'the streamed path must not duplicate the commit');
});

test('T8: the streaming and non-streaming paths commit identical content', async () => {
  // Multi-line on purpose: the mock provider's chunker used to drop newlines
  // when streaming while the non-streaming path kept them, so the two paths
  // diverged only for multi-line replies. A single-line fixture hid that.
  const text = '第一行。\n第二行。\n第三行。';
  // Streaming
  const streamed = buildHarness({ text });
  const res = new FakeResponse();
  await streamed.handler.start(streamed.req, res);
  const streamedContent = (streamed.state.messages[applicationSessionId] || []).find(item => item.role === 'assistant')?.content;

  // Non-streaming, same gateway
  const state = buildState();
  const { port } = buildPort({ state });
  const service = createCoreV0TurnService({
    state,
    context: CTX,
    memoryPort: port,
    modelGateway: { generate: async () => ({ status: 'generation_succeeded', content: text }) }
  });
  await service.handleTurn({ body: { sessionId: applicationSessionId, message: '你好' }, headerIdempotencyKey: 'plain-1' });
  const plainContent = (state.messages[applicationSessionId] || []).find(item => item.role === 'assistant')?.content;

  assert.equal(streamedContent, plainContent, 'both transports must commit the same text');
  assert.equal(streamedContent.split('\n').length, 3, 'line breaks must survive streaming');
});
