// Chat memory loop smoke (R-020 stage 1.4).
//
// End-to-end evidence for the one promise the product makes about memory:
// you tell it something, and next time it remembers. Everything here runs
// locally with no PostgreSQL, no network and no model API key, so it can be
// run on any developer machine and in CI.
//
// Checks:
//   C1  the stating turn commits and the raw event is durable
//   C2  before the drain the probe recalls nothing (negative guard)
//   C3  the drain promotes the stated fact into an active, keyed assertion
//   C4  after the drain the probe recalls it
//   C5  the loop is idempotent: a second drain adds no duplicate assertion
//   C6  a memory failure degrades the turn visibly and never blocks it
//
// Usage: node scripts/chat-memory-smoke.js
// Writes: artifacts/chat-memory-smoke.json

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryModule, createMemoryModuleState } from '../server/memory-module.js';
import { createMemoryExtractionDrain, createDeterministicExtractor } from '../server/memory-extraction.js';
import { createCoreV0TurnService, createCoreV0MockModelGateway, ensureCoreV0State } from '../server/core-v0.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'artifacts', 'chat-memory-smoke.json');

const tenantId = 'smoke-tenant';
const subjectUserId = 'smoke-user';
const agentId = 'smoke-agent';
const applicationSessionId = 'smoke-loop-session';

// actorType 'user' mirrors the product path: /api/chat/* never crosses the /v1
// service boundary, so memory-module-runtime resolves a user actor. The drain
// depends on this -- promoteCandidate asserts a user governance actor, so an
// 'agent' context would stall every candidate at 'candidate' (AR-210).
const CTX = {
  tenantId,
  subjectUserId,
  actorType: 'user',
  actorId: subjectUserId,
  callerAgentId: agentId,
  producer: 'companion-core',
  correlationId: 'chat-memory-smoke'
};

const evidence = {
  startedAt: new Date().toISOString(),
  mode: 'local-in-process-mock-model',
  database: null,
  checks: []
};

const record = (id, ok, detail, data = null) => {
  evidence.checks.push({ id, ok: Boolean(ok), detail, data });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
};

const buildState = () => {
  const state = {
    sessions: [{
      id: applicationSessionId,
      title: 'smoke loop',
      summary: '',
      persona: '',
      atmosphere: '',
      companionIntent: 'listen',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }],
    messages: { [applicationSessionId]: [] },
    memoryModule: createMemoryModuleState(),
    personality: { version: 1, summary: '', traits: [], updatedAt: new Date().toISOString() },
    profile: { name: 'smoke-user', gender: 'none', age: null },
    evidence: []
  };
  ensureCoreV0State(state);
  return state;
};

const buildPort = ({ state, failRetrievalAfter = null }) => {
  const memoryModule = createMemoryModule(state.memoryModule, async () => {});
  const withSession = sessionId => ({ ...CTX, sessionId });
  let retrievals = 0;
  return {
    memoryModule,
    port: {
      async ensureSessionBinding({ bindingKey }) {
        const result = await memoryModule.createSession(CTX, {
          idempotency_key: `smoke:binding:${bindingKey}`,
          callerAgentId: agentId
        });
        const session = result?.session || result;
        return { status: 'completed', memorySessionId: session.id, receipt: { status: 'completed', memorySessionId: session.id } };
      },
      async getSessionBinding({ bindingKey }) {
        const record_ = (state.memoryModule.idempotencyRecords || [])
          .find(item => item.key === `smoke:binding:${bindingKey}`);
        const memorySessionId = record_?.response?.id;
        return memorySessionId
          ? { status: 'completed', memorySessionId, receipt: { status: 'completed', memorySessionId } }
          : { status: 'not_found' };
      },
      async reconcileSessionBinding(args) { return this.getSessionBinding(args); },
      async appendRawEvent({ event, memorySessionId }) {
        const result = await memoryModule.recordEvent(withSession(memorySessionId), {
          ...event,
          sessionId: memorySessionId,
          contentType: 'plain_text',
          eventRole: event.eventRole || 'user',
          isStreamFinal: true
        });
        return {
          status: 'completed',
          receipt: {
            status: 'completed',
            eventId: event.eventId,
            sourceRevision: event.sourceRevision,
            rawEventId: result?.id || null,
            result: 'accepted_stored'
          }
        };
      },
      async getRawEventReceipt({ eventId, sourceRevision }) {
        const found = (state.memoryModule.rawEvents || [])
          .find(item => item.eventId === eventId && String(item.sourceRevision) === String(sourceRevision));
        return found
          ? { status: 'completed', receipt: { status: 'completed', eventId, sourceRevision, rawEventId: found.id, result: 'accepted_stored' } }
          : { status: 'not_found' };
      },
      async reconcileRawEvent(args) { return this.getRawEventReceipt(args); },
      async retrieveContext({ query, memorySessionId }) {
        retrievals += 1;
        if (failRetrievalAfter != null && retrievals > failRetrievalAfter) {
          const error = new Error('memory retrieval is unavailable');
          error.code = 'MEMORY_RETRIEVE_FAILED';
          throw error;
        }
        const bundle = await memoryModule.contextBundleAsync(withSession(memorySessionId), {
          query: String(query || '').slice(0, 1000),
          purpose: 'answer_user_query',
          tokenBudget: 1800
        });
        const recalled = [
          ...(bundle.coreMemory || []),
          ...(bundle.userProfile || []),
          ...(bundle.relationshipProfile || []),
          ...(bundle.currentState || []),
          ...(bundle.relevantEpisodes || [])
        ]
          .map(item => ({ id: item.memoryId || item.episodeId, summary: item.content || item.value || item.summary || '' }))
          .filter(item => String(item.summary || '').trim());
        return { status: 'available', bundle, recalled, answerability: bundle.answerability || 'not_found' };
      }
    }
  };
};

const buildService = ({ state, port }) => createCoreV0TurnService({
  state,
  context: CTX,
  memoryPort: port,
  modelGateway: createCoreV0MockModelGateway()
});

// The drain reads canonical Memory state through the repository, so the
// fixture must hand it the Memory slice. Handing it the application state
// (which merely holds a reference) makes the drain see zero raw events and
// report 'idle' -- a false green.
const mockRepository = memoryState => {
  const pool = {
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
    async query() { return { rows: [] }; }
  };
  return {
    pool,
    repository: {
      async load() { return memoryState; },
      async save() {},
      async loadContextBundleState() { return memoryState; },
      async loadReadMetadata() { return memoryState; }
    }
  };
};

const runDrain = async ({ state }) => {
  const { pool, repository } = mockRepository(state.memoryModule);
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: createDeterministicExtractor({ keywords: ['记住了', '尤克里里', '学'] }),
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  return drain();
};

const main = async () => {
  // --- The loop proper -----------------------------------------------------
  {
    const state = buildState();
    const { port } = buildPort({ state });
    const service = buildService({ state, port });

    let stated = null;
    try {
      stated = await service.handleTurn({
        body: { sessionId: applicationSessionId, message: '记住了，我在学尤克里里' },
        headerIdempotencyKey: 'smoke-loop-1'
      });
      const rawEvents = state.memoryModule.rawEvents || [];
      const durable = rawEvents.some(event => String(event.content || '').includes('尤克里里'));
      const ok = stated?.status === 'committed' && durable;
      record('C1', ok, ok ? 'stating turn committed and the raw event is durable' : `raw event not durable (${JSON.stringify(stated)})`, {
        status: stated?.status,
        memoryStatus: stated?.memoryStatus,
        rawEventCount: rawEvents.length
      });
      if (!ok) return finish();
    } catch (error) {
      record('C1', false, `stating turn threw: ${error.message}`);
      return finish();
    }

    // C2: negative guard -- nothing is recallable before extraction
    try {
      const probe = await service.handleTurn({
        body: { sessionId: applicationSessionId, message: '我最近在学什么？' },
        headerIdempotencyKey: 'smoke-loop-2'
      });
      const ok = probe?.status === 'committed' && Number(probe?.recalledCount) === 0;
      record('C2', ok, ok ? 'before the drain the probe recalls nothing (guard holds)' : `expected zero recall before drain, got ${probe?.recalledCount}`);
    } catch (error) {
      record('C2', false, `pre-drain probe threw: ${error.message}`);
    }

    // C3: the drain promotes the fact
    let drained = null;
    try {
      drained = await runDrain({ state });
      const active = (state.memoryModule.assertions || [])
        .filter(item => item.status === 'active' && String(item.canonicalKey || ''));
      const ok = drained?.status === 'drained' && drained?.promoted >= 1 && active.length >= 1;
      record('C3', ok, ok ? `drain promoted ${drained.promoted} assertion(s)` : `drain did not promote (${JSON.stringify(drained)})`, {
        status: drained?.status,
        extracted: drained?.extracted,
        promoted: drained?.promoted,
        failed: drained?.failed,
        activeAssertions: active.length
      });
      if (!ok) return finish();
    } catch (error) {
      record('C3', false, `drain threw: ${error.message}`);
      return finish();
    }

    // C4: the probe now recalls it
    try {
      const probe = await service.handleTurn({
        body: { sessionId: applicationSessionId, message: '我最近在学什么？' },
        headerIdempotencyKey: 'smoke-loop-3'
      });
      const ok = probe?.status === 'committed' && Number(probe?.recalledCount) > 0;
      record('C4', ok, ok ? `the loop closes: probe recalled ${probe.recalledCount} item(s)` : `the stated fact was not recalled (recalledCount=${probe?.recalledCount})`, {
        status: probe?.status,
        memoryStatus: probe?.memoryStatus,
        recalledCount: probe?.recalledCount
      });
    } catch (error) {
      record('C4', false, `post-drain probe threw: ${error.message}`);
    }

    // C5: re-draining must not duplicate what is already extracted.
    //
    // The assertion count is the invariant, not the drain status: the probe
    // turns written after the first drain are legitimate new raw events, so a
    // second drain has real work to do and reports 'drained', not 'idle'.
    // What must never happen is the same fact landing twice.
    try {
      const before = (state.memoryModule.assertions || []).length;
      const keysBefore = new Set((state.memoryModule.assertions || []).map(item => item.canonicalKey));
      const second = await runDrain({ state });
      const after = (state.memoryModule.assertions || []).length;
      const keysAfter = (state.memoryModule.assertions || []).map(item => item.canonicalKey);
      const duplicateKeys = keysAfter.length !== new Set(keysAfter).size;
      const ok = after === before && !duplicateKeys;
      record('C5', ok, ok
        ? `re-draining adds no duplicate assertions (${before} -> ${after})`
        : `re-drain duplicated state (status=${second?.status}, ${before}->${after}, dupKeys=${duplicateKeys})`);
    } catch (error) {
      record('C5', false, `second drain threw: ${error.message}`);
    }
  }

  // --- C6: a memory failure degrades visibly ------------------------------
  {
    const state = buildState();
    const { port } = buildPort({ state, failRetrievalAfter: 1 });
    const service = buildService({ state, port });
    try {
      await service.handleTurn({
        body: { sessionId: applicationSessionId, message: '记住了一句话' },
        headerIdempotencyKey: 'smoke-degrade-1'
      });
      const degraded = await service.handleTurn({
        body: { sessionId: applicationSessionId, message: '第二句话' },
        headerIdempotencyKey: 'smoke-degrade-2'
      });
      const ok = degraded?.status === 'committed'
        && degraded?.memoryStatus === 'degraded'
        && degraded?.memoryDegradedReason === 'MEMORY_RETRIEVE_FAILED';
      record('C6', ok, ok
        ? 'a memory failure degrades the turn visibly and never blocks it'
        : `expected a visible degrade, got ${JSON.stringify({ status: degraded?.status, memoryStatus: degraded?.memoryStatus, reason: degraded?.memoryDegradedReason })}`);
    } catch (error) {
      record('C6', false, `degrade scenario threw: ${error.message}`);
    }
  }

  return finish();
};

const finish = async () => {
  const passed = evidence.checks.filter(item => item.ok).length;
  const total = evidence.checks.length;
  evidence.finishedAt = new Date().toISOString();
  evidence.summary = { passed, total, ok: passed === total && total > 0 };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`\n${evidence.summary.ok ? 'OK' : 'NOT OK'}  ${passed}/${total} checks passed`);
  console.log(`evidence: ${path.relative(root, outputPath)}`);
  process.exitCode = evidence.summary.ok ? 0 : 1;
};

await main();
