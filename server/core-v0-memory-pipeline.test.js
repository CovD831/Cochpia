// R-005 pipeline tests: projection side effect, extraction drain behavior
// (idempotency, budget, circuit breaker, serialization SQL), confirmation
// route projection, recall semantics and flag parity.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import {
  createMemoryExtractionDrain,
  createDeterministicExtractor,
  createModelExtractor
} from './memory-extraction.js';
import { createCoreV0ProductionAdapter } from './core-v0-production.js';
import { prepareCoreV0ProductionSchema, resetCoreV0ProductionSchemaCache } from './core-v0-production.js';

const CTX = {
  tenantId: 'tenant-pipeline',
  subjectUserId: 'user-pipeline',
  actorType: 'user',
  actorId: 'user-pipeline',
  callerAgentId: 'cochpia',
  correlationId: 'pipeline'
};

const baseState = () => ({
  sessions: [
    { id: 'session-a', title: 'A', summary: '', persona: '', atmosphere: '', companionIntent: 'listen' },
    { id: 'session-b', title: 'B', summary: '', persona: '', atmosphere: '', companionIntent: 'listen' }
  ],
  messages: { 'session-a': [], 'session-b': [] },
  personality: { version: 1, summary: '', traits: [] },
  profile: {}
});

function memoryFixture({ rawEvents = [], activeSessions = 2 } = {}) {
  const state = createMemoryModuleState();
  state.sessions = Array.from({ length: activeSessions }, (_, index) => ({
    id: `ms-${index}`,
    tenantId: CTX.tenantId,
    userId: CTX.subjectUserId,
    callerAgentId: 'cochpia',
    status: 'active',
    profileSnapshotId: `snap-${index}`,
    grantVersion: 0,
    privacyEpoch: 0,
    expiresAt: '2099-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z'
  }));
  state.profileSnapshots = state.sessions.map(session => ({
    id: session.profileSnapshotId,
    tenantId: CTX.tenantId,
    userId: CTX.subjectUserId,
    sessionId: session.id,
    grantVersion: 0,
    privacyEpoch: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    resourceRevision: 1
  }));
  state.rawEvents = rawEvents;
  return state;
}

const rawEvent = (id, content, commitSeq = 1) => ({
  id,
  eventId: `event:${id}`,
  sourceRevision: 'rev-1',
  tenantId: CTX.tenantId,
  userId: CTX.subjectUserId,
  sessionId: 'ms-0',
  eventRole: 'user',
  contentType: 'plain_text',
  content,
  metadata: {},
  occurredAt: '2026-01-01T00:00:00.000Z',
  isStreamFinal: true,
  retentionPolicy: 'default',
  resourceRevision: 1,
  commitSeq
});

function mockRepository(state) {
  const saves = [];
  const queries = [];
  const pool = {
    async connect() {
      return {
        query: async sql => {
          queries.push(String(sql));
          return { rows: [] };
        },
        release() {}
      };
    },
    async query(sql, values) {
      queries.push(String(sql));
      return { rows: [] };
    }
  };
  const repository = {
    async load() { return state; },
    async save(context, mutated) { saves.push(mutated); }
  };
  return { state, saves, queries, pool, repository };
}

test('promotion projects the assertion into every active session snapshot', async () => {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '我对花生过敏')] });
  const memory = createMemoryModule(state, async () => {}, { projectionEnabled: true });
  const candidate = await memory.createCandidate(CTX, {
    sourceEventId: 're-1',
    content: '用户对花生过敏。',
    memoryType: 'fact',
    assertionType: 'observed_fact',
    scopeType: 'user'
  });
  const promoted = await memory.promoteCandidate(CTX, candidate.memory.memoryId, {
    resourceRevision: candidate.memory.resourceRevision
  });
  assert.equal(promoted.status, 'active');
  assert.equal(state.profileSnapshotItems.length, 2, 'one snapshot item per active session');
  assert.ok(state.profileSnapshotItems.every(item => item.assertionId === candidate.memory.memoryId));
});

test('projection is idempotent and flag-off disables it', async () => {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '我对花生过敏')] });
  const memory = createMemoryModule(state, async () => {}, { projectionEnabled: true });
  const candidate = await memory.createCandidate(CTX, {
    sourceEventId: 're-1', content: '用户对花生过敏。', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
  });
  await memory.promoteCandidate(CTX, candidate.memory.memoryId, { resourceRevision: candidate.memory.resourceRevision });
  const afterFirst = state.profileSnapshotItems.length;
  const again = await memory.promoteCandidate(CTX, candidate.memory.memoryId, { resourceRevision: candidate.memory.resourceRevision }).catch(() => null);
  assert.equal(state.profileSnapshotItems.length, afterFirst, 're-promotion adds no duplicate rows');
  assert.ok(again === null || again.status === 'active');

  const offState = memoryFixture({ rawEvents: [rawEvent('re-1', '我对花生过敏')] });
  const off = createMemoryModule(offState, async () => {}, {});
  const offCandidate = await off.createCandidate(CTX, {
    sourceEventId: 're-1', content: '用户对花生过敏。', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
  });
  await off.promoteCandidate(CTX, offCandidate.memory.memoryId, { resourceRevision: offCandidate.memory.resourceRevision });
  assert.equal(offState.profileSnapshotItems.length, 0, 'flag off: no projection rows');
});

test('drain extracts, promotes and is idempotent per source event', async () => {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '请记住：我对花生过敏')] });
  const { pool, repository } = mockRepository(state);
  let extractorCalls = 0;
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: async event => { extractorCalls += 1; return createDeterministicExtractor()(event); },
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  const first = await drain();
  assert.equal(first.status, 'drained');
  assert.ok(first.promoted >= 1, `expected a promotion, got ${JSON.stringify(first)}`);
  assert.ok(state.assertions.some(item => item.status === 'active' && item.canonicalKey));
  assert.equal(state.profileSnapshotItems.length, 2);

  const extractorCallsAfterFirst = extractorCalls;
  const second = await drain();
  assert.equal(second.status, 'idle', 'all events already extracted');
  assert.equal(extractorCalls, extractorCallsAfterFirst, 'no extractor call for extracted events');
});

test('S2 facts land in pending confirmation and join retrieval after confirm', async () => {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '提醒：我在服用抗凝血药物')] });
  const { pool, repository } = mockRepository(state);
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: async () => [{ content: '用户在服用抗凝血药物，需避免受伤。', memoryType: 'medical', assertionType: 'observed_fact', scopeType: 'user', sensitivity: 'S2' }],
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  const result = await drain();
  assert.equal(result.pending, 1);
  assert.equal(state.assertions[0].status, 'pending_confirmation');
  assert.equal(state.profileSnapshotItems.length, 0, 'pending assertions are not projected');

  const confirmation = state.confirmations[0];
  await memoryConfirm(state, confirmation);
  assert.equal(state.assertions[0].status, 'active');
  assert.ok(state.profileSnapshotItems.length >= 1, 'confirmation route projects like promotion');
});

async function memoryConfirm(state, confirmation) {
  const memory = createMemoryModule(state, async () => {}, { projectionEnabled: true });
  await memory.confirm(CTX, confirmation.id, { resourceRevision: confirmation.resourceRevision });
}

test('extractor failure records an audit event and keeps the turn path safe', async () => {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '请记住：我对花生过敏')] });
  const { pool, repository } = mockRepository(state);
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: async () => { throw new Error('model exploded'); },
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  const result = await drain();
  assert.equal(result.failed, 1);
  assert.equal(state.assertions.length, 0);
  assert.ok(state.auditEvents.some(item => item.action === 'memory_extraction_failed'));
});

test('drain respects the time budget and the circuit breaker pauses it', async () => {
  const events = Array.from({ length: 6 }, (_, index) => rawEvent(`re-${index}`, `请记住事实${index}`, index + 1));
  const state = memoryFixture({ rawEvents: events });
  const { pool, repository, queries } = mockRepository(state);
  const slow = async () => new Promise(resolve => setTimeout(() => resolve([{ content: `事实`, memoryType: 'fact' }]), 40));
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: slow,
    context: CTX,
    moduleOptions: { projectionEnabled: true },
    batch: 6,
    timeBudgetMs: 60
  });
  const started = Date.now();
  const result = await drain();
  assert.ok(Date.now() - started < 500, 'budget bounds the drain');
  assert.ok(result.extracted < 6, `budget limited extraction (${JSON.stringify(result)})`);
  assert.ok(queries.some(sql => sql.includes('pg_advisory_lock')), 'drain holds the advisory lock');

  const failing = memoryFixture({ rawEvents: [rawEvent('re-1', '请记住：X')] });
  const failPool = mockRepository(failing);
  let attempts = 0;
  const breaker = createMemoryExtractionDrain({
    pool: failPool.pool,
    repository: failPool.repository,
    extractor: async () => { attempts += 1; throw new Error('down'); },
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  for (let index = 0; index < 5; index += 1) await breaker();
  assert.ok(attempts >= 5);
  const paused = await breaker();
  assert.equal(paused.status, 'paused', 'circuit breaker opens after consecutive failures');
});

test('adapter wires the flag into module options and exposes the drain', async () => {
  resetCoreV0ProductionSchemaCache();
  const previous = process.env.CORE_V0_MEMORY_PIPELINE_ENABLED;
  process.env.CORE_V0_MEMORY_PIPELINE_ENABLED = 'true';
  try {
    const { createCoreV0PostgresFixture } = await import('./core-v0-postgres-fixture.js');
    const { CORE_V0_PRODUCTION_TABLES, MEMORY_PRODUCTION_TABLES, CORE_V0_PRODUCTION_REQUIRED_COLUMNS, MEMORY_PRODUCTION_REQUIRED_COLUMNS } =
      await import('./core-v0-production.js');
    const fixture = createCoreV0PostgresFixture();
    const allColumns = { ...CORE_V0_PRODUCTION_REQUIRED_COLUMNS, ...MEMORY_PRODUCTION_REQUIRED_COLUMNS };
    const queries = [];
    const pool = {
      async connect() {
        const client = await fixture.connect();
        const original = client.query.bind(client);
        client.query = async (sql, values = []) => {
          const normalized = String(sql).replace(/\s+/g, ' ').trim();
          queries.push(normalized);
          if (/information_schema\.tables/i.test(normalized)) {
            const names = Array.isArray(values?.[0]) ? values[0] : [];
            return { rows: names.map(table_name => ({ table_name })) };
          }
          if (/information_schema\.columns/i.test(normalized)) {
            const names = Array.isArray(values?.[0]) ? values[0] : [];
            return { rows: names.flatMap(table_name => (allColumns[table_name] || []).map(column_name => ({ table_name, column_name }))) };
          }
          if (/pg_advisory_/i.test(normalized)) return { rows: [] };
          return original(sql, values);
        };
        return client;
      },
      async query(sql, values = []) {
        const client = await this.connect();
        try { return await client.query(sql, values); } finally { client.release(); }
      }
    };
    const adapter = await createCoreV0ProductionAdapter({
      pool,
      context: CTX,
      baseState: baseState(),
      modelProvider: 'mock',
      extractor: createDeterministicExtractor(),
      schemaOptions: { production: false, autoMigrate: false }
    });
    assert.equal(typeof adapter.drainExtraction, 'function');
    assert.equal(adapter.memoryPipelineEnabled, true);
    assert.ok(queries.length > 0);
  } finally {
    if (previous == null) delete process.env.CORE_V0_MEMORY_PIPELINE_ENABLED;
    else process.env.CORE_V0_MEMORY_PIPELINE_ENABLED = previous;
  }
});

test('model extractor demands the fixed JSON schema', async () => {
  const extractor = createModelExtractor({ generate: async () => '好的，这是候选：{"candidates":[{"content":"用户喜欢安静","memoryType":"preference"}]}' });
  const proposals = await extractor({ content: '我喜欢安静' });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].content, '用户喜欢安静');
  await assert.rejects(() => createModelExtractor({ generate: async () => '我觉得没问题' })({ content: 'x' }),
    /MEMORY_EXTRACTION_MALFORMED_OUTPUT/);
});

test('R-014 context snapshot: flag off ignores metadata, flag on lets the model see the antecedent', async () => {
  let seenPrompt = '';
  const model = { generate: async ({ message }) => { seenPrompt = message; return '{"candidates":[{"content":"用户的指甲油是蓝色的","key":"nail_color","memoryType":"fact","assertionType":"observed_fact"}]}'; } };
  const event = {
    content: '现在涂的是蓝色的',
    metadata: { context_snapshot: ['user: 我的指甲油是红色的。'] }
  };
  // Flag off (default): the context block must NOT enter the prompt even
  // when the event carries a snapshot.
  await createModelExtractor(model, { contextTurns: 0 })(event);
  assert.ok(!seenPrompt.includes('对话上下文'), 'flag off must keep the prompt context-free');
  // Flag on: the snapshot lines reach the prompt, marked reference-only.
  await createModelExtractor(model, { contextTurns: 2 })(event);
  assert.ok(seenPrompt.includes('对话上下文'), 'flag on adds the context block');
  assert.ok(seenPrompt.includes('我的指甲油是红色的'), 'the antecedent line is visible to the model');
  assert.ok(seenPrompt.includes('不要从中提取事实'), 'context is marked reference-only');
  // An event without a snapshot stays clean under the flag.
  await createModelExtractor(model, { contextTurns: 2 })({ content: '现在涂的是蓝色的' });
  assert.ok(!seenPrompt.includes('对话上下文'), 'missing snapshot degrades to the context-free prompt');
});

test('R-016 key injection: same-key memories reach the auditor despite a below-threshold embedding', async () => {
  const { injectKeyMatches } = await import('./memory-extraction.js');
  const docs = [
    { id: 'a1', canonicalKey: 'favorite_movie', similarity: 0.42 },
    { id: 'a2', canonicalKey: 'home_city', similarity: 0.91 }
  ];
  const proposal = { key: 'favorite_movie' };
  // Flag off: the below-threshold same-key memory stays filtered out.
  const legacy = injectKeyMatches(docs, proposal, { enabled: false, minScore: 0.6 }).filter(d => d.similarity >= 0.6);
  assert.deepEqual(legacy.map(d => d.id), ['a2']);
  // Flag on: the same-key memory is boosted to the threshold and survives.
  const injected = injectKeyMatches(docs, proposal, { enabled: true, minScore: 0.6 }).filter(d => d.similarity >= 0.6);
  assert.deepEqual(injected.map(d => d.id), ['a1', 'a2']);
  assert.equal(injected[0].similarity, 0.6);
  // No key on the proposal: no injection either way.
  const noKey = injectKeyMatches(docs, { key: null }, { enabled: true, minScore: 0.6 }).filter(d => d.similarity >= 0.6);
  assert.deepEqual(noKey.map(d => d.id), ['a2']);
});

test('R-017 retention sweep: expired events/assertions are swept once per interval', async () => {
  const expiredEvent = { ...rawEvent('re-exp', '陈旧事件'), deleteAfter: '2026-01-02T00:00:00.000Z' };
  const state = memoryFixture({ rawEvents: [expiredEvent] });
  const { pool, repository } = mockRepository(state);
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: async () => [],
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  const first = await drain();
  assert.ok(first.retention, 'summary carries retention stats');
  assert.equal(first.retention.rawEvents, 1, 'expired raw event physically removed');
  assert.equal(state.rawEvents.length, 0);

  // Interval gate: an event that expires right after the sweep waits for
  // the next interval - an immediate second drain must not sweep again.
  state.rawEvents.push({ ...rawEvent('re-exp-2', '新的陈旧事件'), deleteAfter: '2026-01-02T00:00:00.000Z' });
  const second = await drain();
  assert.equal(state.rawEvents.length, 1, 'interval gate suppresses an immediate second sweep');
  assert.ok(!second.retention || second.retention.rawEvents === 0);
});

test('R-017: flag off keeps legacy behavior; zero interval sweeps every drain', async () => {
  const makeState = () => memoryFixture({ rawEvents: [{ ...rawEvent('re-exp', '陈旧事件'), deleteAfter: '2026-01-02T00:00:00.000Z' }] });

  const offState = makeState();
  const offRepo = mockRepository(offState);
  const offDrain = createMemoryExtractionDrain({
    pool: offRepo.pool, repository: offRepo.repository, extractor: async () => [], context: CTX,
    moduleOptions: { projectionEnabled: true }, retentionSweep: false
  });
  await offDrain();
  assert.equal(offState.rawEvents.length, 1, 'flag off: nothing swept');

  const eagerState = makeState();
  const eagerRepo = mockRepository(eagerState);
  const eagerDrain = createMemoryExtractionDrain({
    pool: eagerRepo.pool, repository: eagerRepo.repository, extractor: async () => [], context: CTX,
    moduleOptions: { projectionEnabled: true }, retentionSweepIntervalMs: 0
  });
  const eager = await eagerDrain();
  assert.equal(eagerState.rawEvents.length, 0, 'zero interval: sweeps every drain');
});

test('Core message deletion persists across hydration and keeps the turn', async () => {
  const { createCoreV0PostgresFixture } = await import('./core-v0-postgres-fixture.js');
  const { CORE_V0_PRODUCTION_TABLES, MEMORY_PRODUCTION_TABLES, CORE_V0_PRODUCTION_REQUIRED_COLUMNS, MEMORY_PRODUCTION_REQUIRED_COLUMNS } =
    await import('./core-v0-production.js');
  const { createPostgresCoreV0Store } = await import('./core-v0-postgres.js');
  const fixture = createCoreV0PostgresFixture();
  const allColumns = { ...CORE_V0_PRODUCTION_REQUIRED_COLUMNS, ...MEMORY_PRODUCTION_REQUIRED_COLUMNS };
  const pool = {
    async connect() {
      const client = await fixture.connect();
      const original = client.query.bind(client);
      client.query = async (sql, values = []) => {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        if (/information_schema\.tables/i.test(normalized)) {
          const names = Array.isArray(values?.[0]) ? values[0] : [];
          return { rows: names.map(table_name => ({ table_name })) };
        }
        if (/information_schema\.columns/i.test(normalized)) {
          const names = Array.isArray(values?.[0]) ? values[0] : [];
          return { rows: names.flatMap(table_name => (allColumns[table_name] || []).map(column_name => ({ table_name, column_name }))) };
        }
        return original(sql, values);
      };
      return client;
    },
    async query(sql, values = []) {
      const client = await this.connect();
      try { return await client.query(sql, values); } finally { client.release(); }
    }
  };
  const store = await createPostgresCoreV0Store({ pool, context: CTX, baseState: baseState() });
  store.state.messages['session-a'].push({
    id: 'message-delete-me', role: 'user', content: '我会被删除', channel: '默认',
    createdAt: '2026-01-01T00:00:00.000Z', coreV0: { applicationSessionId: 'session-a', turnId: 'turn-1' }
  });
  store.state.coreV0.turnAdmissions.push({
    turnId: 'turn-1', applicationSessionId: 'session-a', applicationMessageId: 'message-delete-me', status: 'committed', fingerprint: 'fp-del-1', idempotencyKey: 'del-key-1', sourceRevision: 'rev-del-1', sequenceNo: 1, channel: '默认',
    eventId: 'event-1', tenantId: CTX.tenantId, subjectUserId: CTX.subjectUserId
  });
  await store.persist();
  const deleted = store.deleteApplicationMessage({ sessionId: 'session-a', messageId: 'message-delete-me' });
  assert.equal(deleted.eventId, 'event-1', 'deletion resolves the owning turn event id');
  await store.persist();
  const fresh = await createPostgresCoreV0Store({ pool, context: CTX, baseState: baseState() });
  const stillThere = (fresh.state.messages['session-a'] || []).some(item => item.id === 'message-delete-me');
  assert.equal(stillThere, false, 'deleted message does not resurrect after hydration');
  assert.ok(fresh.state.coreV0.turnAdmissions.some(turn => turn.turnId === 'turn-1'), 'turn admission survives');
  let repeatedDeletionError = null;
  try {
    fresh.deleteApplicationMessage({ sessionId: 'session-a', messageId: 'message-delete-me' });
  } catch (error) {
    repeatedDeletionError = error;
  }
  assert.ok(repeatedDeletionError, 'repeated deletion must fail');
  assert.equal(repeatedDeletionError?.status, 404);
});


// ---------------------------------------------------------------------------
// R-007a: AUDN write-time decisions, dedup gate, degradation
// ---------------------------------------------------------------------------

import { createModelAuditor } from './memory-extraction.js';

async function seededState() {
  const state = memoryFixture({ rawEvents: [rawEvent('re-seed', '请记住：我对花生过敏')] });
  const memory = createMemoryModule(state, async () => {}, { projectionEnabled: true });
  const candidate = await memory.createCandidate(CTX, {
    sourceEventId: 're-seed', content: '我对花生过敏，吃花生制品会起疹子。',
    memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
  });
  await memory.promoteCandidate(CTX, candidate.memory.memoryId, { resourceRevision: candidate.memory.resourceRevision });
  // R-011: AUDN similar lookup is vector-based, so the seeded assertion needs
  // an active index document with an embedding for the auditor to see it.
  const seeded = state.assertions.find(item => item.id === candidate.memory.memoryId);
  state.indexDocuments.push({
    id: 'idx-seed', tenantId: CTX.tenantId, sourceType: 'assertion', sourceId: seeded.id,
    sourceVersion: seeded.currentVersionId, userId: CTX.subjectUserId, scopeType: 'user',
    searchText: '我对花生过敏，吃花生制品会起疹子。', sensitivity: seeded.sensitivity,
    embedding: [1, 0], embeddingVersion: 'test-vec', indexStatus: 'active', sourceRefs: [],
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  return state;
}

test('B-13 dedup gate: a restated fact is skipped before any candidate is created', async () => {
  const state = await seededState();
  state.rawEvents.push(rawEvent('re-2', '我花生过敏，不能吃花生！', 2));
  const { pool, repository } = mockRepository(state);
  const assertionsBefore = state.assertions.length;
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: async () => [{ content: '我对花生过敏，吃花生制品会起疹子!', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user' }],
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  const result = await drain();
  assert.equal(result.skipped, 1, 'restatement deduped: ' + JSON.stringify(result));
  assert.equal(state.assertions.length, assertionsBefore, 'no duplicate assertion');
});

test('B-14 NOOP: an audited no-value candidate never enters the corpus', async () => {
  const state = await seededState();
  state.rawEvents.push(rawEvent('re-2', '今天天气真好', 2));
  const { pool, repository } = mockRepository(state);
  const assertionsBefore = state.assertions.length;
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: async () => [{ content: '用户说今天天气很好。', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user' }],
    auditor: async () => ({ decision: 'NOOP', target: null, reason: 'chit-chat' }),
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  const result = await drain();
  assert.equal(result.noop, 1);
  assert.equal(state.assertions.length, assertionsBefore, 'NOOP adds no assertion');
});

test('B-15 UPDATE: correct supersedes the version and snapshot rows follow', async () => {
  const state = await seededState();
  const target = state.assertions.find(item => item.status === 'active');
  const oldVersionId = target.currentVersionId;
  const snapshotBefore = state.profileSnapshotItems.filter(item => item.assertionId === target.id);
  assert.ok(snapshotBefore.length >= 1);
  state.rawEvents.push(rawEvent('re-2', '我花生过敏很严重，会休克的那种', 2));
  const { pool, repository } = mockRepository(state);
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: async () => [{ content: '用户对花生严重过敏，接触可能休克。', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user' }],
    auditor: async () => ({ decision: 'UPDATE', target: 0, reason: 'severity changed' }),
    embeddingGateway: async () => [1, 0],
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  const result = await drain();
  assert.equal(result.updated, 1);
  assert.equal(target.currentVersionId === oldVersionId, false, 'current version moved');
  const superseded = state.assertionVersions.find(item => item.id === oldVersionId);
  assert.equal(superseded.versionStatus, 'superseded');
  const current = state.assertionVersions.find(item => item.id === target.currentVersionId);
  assert.ok(current.content.includes('休克'));
  for (const item of state.profileSnapshotItems.filter(entry => entry.assertionId === target.id)) {
    assert.equal(item.versionId, target.currentVersionId, 'snapshot rows follow the current version');
  }
});

test('B-16 DELETE: the audited target is forgotten and cleaned from snapshots', async () => {
  const state = await seededState();
  const target = state.assertions.find(item => item.status === 'active');
  state.rawEvents.push(rawEvent('re-2', '其实我对花生不过敏，之前搞错了', 2));
  const { pool, repository } = mockRepository(state);
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: async () => [{ content: '用户实际上不过敏花生。', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user' }],
    auditor: async () => ({ decision: 'DELETE', target: 0, reason: 'fact retracted' }),
    embeddingGateway: async () => [1, 0],
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  const result = await drain();
  assert.equal(target.status, 'forgotten');
  assert.equal(state.profileSnapshotItems.filter(item => item.assertionId === target.id).length, 0);
  assert.ok(result.extracted >= 1, 'the replacement candidate still goes through ADD');
});

test('B-17 degradation: an auditor failure degrades to ADD with an audit trail', async () => {
  const state = await seededState();
  state.rawEvents.push(rawEvent('re-2', '请记住：我对芒果也过敏', 2));
  const { pool, repository } = mockRepository(state);
  const assertionsBefore = state.assertions.length;
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: async () => [{ content: '用户对芒果过敏。', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user' }],
    auditor: async () => { throw new Error('auditor down'); },
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  const result = await drain();
  assert.ok(result.promoted >= 1, 'degraded to ADD: ' + JSON.stringify(result));
  assert.equal(state.assertions.length, assertionsBefore + 1);
  assert.ok(state.auditEvents.some(item => item.action === 'memory_audn_failed'));
  assert.ok(state.auditEvents.some(item => item.action === 'memory_audn'));
});

// ---------------------------------------------------------------------------
// R-007c: semantic indexing, hybrid RRF retrieval, degradation
// ---------------------------------------------------------------------------

test('B-21 embedding indexing: a promoted assertion gets an active index document', async () => {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '请记住：我对花生过敏')] });
  const { pool, repository } = mockRepository(state);
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: async () => [{ content: '我对花生过敏，吃花生制品会起疹子。', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user' }],
    embeddingGateway: async () => Array.from({ length: 1024 }, () => 0.1),
    embeddingModel: 'bge-m3',
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  const result = await drain();
  assert.ok(result.promoted >= 1);
  assert.equal(state.indexDocuments.length, 1);
  const doc = state.indexDocuments[0];
  assert.equal(doc.indexStatus, 'active');
  assert.equal(doc.sourceId, state.assertions[0].id);
  assert.equal(doc.embedding.length, 1024);
  assert.equal(doc.embeddingVersion, 'bge-m3');
});

test('B-22 hybrid retrieval: the semantic path fuses with BM25 through RRF', async () => {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '请记住：我对花生过敏')] });
  const gateway = async text => (String(text).includes('花生') ? [1, 0] : [0, 1]);
  const memory = createMemoryModule(state, async () => {}, {
    projectionEnabled: true,
    featureFlags: { hybridRetrieval: true },
    embeddingGateway: gateway
  });
  const candidate = await memory.createCandidate(CTX, {
    sourceEventId: 're-1', content: '我对花生过敏，吃花生制品会起疹子。',
    memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
  });
  await memory.promoteCandidate(CTX, candidate.memory.memoryId, { resourceRevision: candidate.memory.resourceRevision });
  state.indexDocuments.push({
    id: 'idx-1', tenantId: CTX.tenantId, sourceType: 'assertion', sourceId: candidate.memory.memoryId,
    sourceVersion: candidate.memory.versionId, userId: CTX.subjectUserId, scopeType: 'user',
    searchText: candidate.memory.content, sensitivity: 'S0', embedding: [1, 0],
    embeddingVersion: 'bge-m3', indexStatus: 'active', sourceRefs: [], createdAt: '2026-01-01T00:00:00.000Z'
  });
  const retrieved = await memory.retrieveAsync(CTX, { query: '我能吃花生酱饼干吗', purpose: 'answer_user_query' });
  assert.ok(retrieved.items.some(item => item.memoryId === candidate.memory.memoryId), 'semantic path hits the assertion');
  assert.ok(['hybrid_rrf', 'vector'].includes(retrieved.retrievalMode), 'retrieval mode: ' + retrieved.retrievalMode);
});

test('B-23 degradation: a dead gateway falls back to lexical BM25 without noise', async () => {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '请记住：我对花生过敏')] });
  const memory = createMemoryModule(state, async () => {}, {
    projectionEnabled: true,
    featureFlags: { hybridRetrieval: true },
    embeddingGateway: async () => null
  });
  const candidate = await memory.createCandidate(CTX, {
    sourceEventId: 're-1', content: '我对花生过敏。', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
  });
  await memory.promoteCandidate(CTX, candidate.memory.memoryId, { resourceRevision: candidate.memory.resourceRevision });
  const retrieved = memory.retrieve(CTX, { query: '花生', purpose: 'answer_user_query' });
  assert.equal(retrieved.items.length >= 1, true, 'lexical fallback still recalls');
  assert.equal(String(retrieved.retrievalMode).startsWith('bm25'), true, 'mode: ' + retrieved.retrievalMode);
});

// ---------------------------------------------------------------------------
// R-008: conflict arbitration and S2 vocabulary stabilization
// ---------------------------------------------------------------------------

async function conflictingState(flagOn) {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '请记住：我对花生过敏')] });
  const memory = createMemoryModule(state, async () => {}, { projectionEnabled: true, featureFlags: { hybridRetrieval: true, conflictLatestWins: flagOn } });
  const first = await memory.createCandidate(CTX, {
    sourceEventId: 're-1', content: '我对花生过敏，吃花生制品会起疹子。',
    memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
  });
  await memory.promoteCandidate(CTX, first.memory.memoryId, { resourceRevision: first.memory.resourceRevision });
  const secondSource = rawEvent('re-2', '其实我不能吃芒果', 2);
  state.rawEvents.push(secondSource);
  const second = await memory.createCandidate(CTX, {
    sourceEventId: 're-2', content: '我不能吃芒果，一吃就起疹子。',
    memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
  });
  await memory.promoteCandidate(CTX, second.memory.memoryId, { resourceRevision: second.memory.resourceRevision });
  // Force the two distinct assertions into one canonical_key so
  // detectConflicts sees a contradiction group.
  const key = 'forced-conflict-key';
  for (const assertion of state.assertions) assertion.canonicalKey = key;
  return { state, memory, first, second };
}

test('C-07 arbitration: flag on keeps only the newest version in the prompt', async () => {
  const { state, memory } = await conflictingState(true);
  const later = state.assertions.find(item => item.currentVersionId === secondVersionId(state));
  const retrieved = await memory.retrieveAsync(CTX, { query: '过敏 忌口 起疹子', purpose: 'answer_user_query' });
  assert.equal(retrieved.items.length, 1, 'only the newest version survives: ' + retrieved.items.length);
  assert.equal(retrieved.answerability, 'known');
  const suppressed = retrieved.uncertainties.filter(item => item.type === 'conflict_suppressed');
  assert.equal(suppressed.length, 1);
  assert.ok(suppressed[0].suppressedContent && suppressed[0].suppressedContent !== retrieved.items[0].content);
  assert.ok(later);
});

function secondVersionId(state) {
  return state.assertions.map(a => a.currentVersionId).sort().at(-1);
}

test('C-08 flag parity: flag off keeps the baseline conflict behavior', async () => {
  const { memory } = await conflictingState(false);
  const retrieved = await memory.retrieveAsync(CTX, { query: '过敏 忌口 起疹子', purpose: 'answer_user_query' });
  assert.equal(retrieved.items.length, 2, 'both contradictory values co-exist');
  assert.equal(retrieved.answerability, 'conflict');
  assert.equal(retrieved.uncertainties.filter(item => item.type === 'conflict_suppressed').length, 0);
});

test('C-10 S2 vocabulary: health phrasing without the old keywords is still classified S2', async () => {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '提醒：我在服用华法林进行抗凝治疗，每周要验血')] });
  const { pool, repository } = mockRepository(state);
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: async () => [{ content: '用户在服用华法林进行抗凝治疗，每周验血。', memoryType: 'medical', assertionType: 'observed_fact', scopeType: 'user' }],
    auditor: null,
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  const result = await drain();
  assert.equal(result.pending, 1, 'S2 lands in pending_confirmation: ' + JSON.stringify(result));
  assert.equal(state.assertions[0].status, 'pending_confirmation');
  assert.equal(state.profileSnapshotItems.length, 0);
});

test('R-012a S2 vocabulary: salary, credit card, chemotherapy and family conflict phrasings enter the confirmation flow', async () => {
  const messages = ['用户月薪大概一万五', '用户信用卡欠了几万块还没还清', '用户刚做完化疗，头发都掉了', '用户家里矛盾挺严重的，在考虑搬出去住'];
  for (const [index, content] of messages.entries()) {
    const state = memoryFixture({ rawEvents: [rawEvent(`re-${index}`, content)] });
    const { pool, repository } = mockRepository(state);
    const drain = createMemoryExtractionDrain({
      pool,
      repository,
      extractor: async () => [{ content, memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user' }],
      auditor: null,
      context: CTX,
      moduleOptions: { projectionEnabled: true }
    });
    const result = await drain();
    assert.equal(result.pending, 1, `"${content}" must land in pending_confirmation: ` + JSON.stringify(result));
  }
});

test('R-012b gate merge: a confirmed S2 memory answers direct queries', async () => {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '提醒：我在服用华法林进行抗凝治疗')] });
  const memory = createMemoryModule(state, async () => {}, { projectionEnabled: true });
  const candidate = await memory.createCandidate(CTX, {
    sourceEventId: 're-1', content: '用户在服用华法林进行抗凝治疗', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
  });
  assert.equal(candidate.status, 'pending_confirmation');
  const pending = await memory.retrieveAsync(CTX, { query: '华法林', purpose: 'answer_user_query' });
  assert.equal(pending.items.length, 0, 'unconfirmed S2 stays blocked at direct query');
  const confirmation = state.confirmations.find(item => item.candidateAssertionId === candidate.memory.memoryId && item.status === 'pending');
  assert.ok(confirmation);
  const decision = await memory.confirm(CTX, confirmation.id, { resourceRevision: confirmation.resourceRevision });
  assert.equal(decision.memory.directQueryPolicy, 'allow', 'confirmation relaxes the direct-query gate');
  const after = await memory.retrieveAsync(CTX, { query: '华法林', purpose: 'answer_user_query' });
  assert.equal(after.items.length, 1, 'confirmed S2 answers direct queries');
  assert.equal(after.blocks.length, 0, 'no access-confirmation block remains');
});

test('R-012c-g: the lexical relative floor drops long-tail bigram coincidences', async () => {
  const { bm25Search } = await import('./memory-module-retrieval.js');
  const documents = [
    { id: 'top', text: '空气炸锅食谱大全' },
    { id: 'near', text: '空气炸锅清洁方法' },
    { id: 'far-a', text: '今天空气湿度不错' },
    { id: 'far-b', text: '空气质量预报说了什么' }
  ];
  const all = bm25Search(documents, '空气炸锅怎么选', { floorRatio: 0 });
  const floored = bm25Search(documents, '空气炸锅怎么选', { floorRatio: 0.5 });
  assert.ok(all.length > floored.length, `floor trims long tail (${all.length} -> ${floored.length})`);
  assert.ok(all.length >= 4);
  assert.deepEqual([...floored.map(item => item.id)].sort(), ['near', 'top'], 'strong matches survive: ' + JSON.stringify(floored.map(item => item.id)));
});

test('R-012c-h: decay re-weight ranks recency when flag-gated on', async () => {
  const now = Date.now();
  const build = async decayEnabled => {
    const state = memoryFixture({ rawEvents: [rawEvent('re-1', '请记住：我养了一只鹦鹉')] });
    const memory = createMemoryModule(state, async () => {}, { projectionEnabled: false });
    for (const [index, content] of [['stale', '用户养了一只鹦鹉，已经很熟了。'], ['fresh', '用户养了一只仓鼠，刚到家。']]) {
      state.rawEvents.push(rawEvent('re-x' + index, '我养了小动物', index + 2));
      const sourceEvent = state.rawEvents[state.rawEvents.length - 1];
      const candidate = await memory.createCandidate(CTX, {
        sourceEventId: sourceEvent.id, content, memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
      });
      await memory.promoteCandidate(CTX, candidate.memory.memoryId, { resourceRevision: candidate.memory.resourceRevision });
    }
    state.assertions[0].updatedAt = new Date(now - 60 * 86400000).toISOString();
    state.assertions[1].updatedAt = new Date(now).toISOString();
    const decayMemory = decayEnabled
      ? createMemoryModule(state, async () => {}, { projectionEnabled: false, decay: { enabled: true, halfLifeDays: 14, weight: 0.3 } })
      : memory;
    return decayMemory.retrieve(CTX, { query: '我养的小动物', purpose: 'answer_user_query' });
  };
  const plain = await build(false);
  const decayed = await build(true);
  assert.equal(plain.items.length, 2);
  const ids = result => result.items.map(item => String(item.memoryId)).join(',');
  assert.notEqual(ids(decayed), ids(plain), 'decay reorders recency vs stale: ' + ids(plain) + ' -> ' + ids(decayed));
  assert.equal(decayed.items[0].content.includes('仓鼠'), true, 'the freshly written memory ranks first under decay');
});test('R-013 S2 classification covers the raw message when the rephrase drops the trigger word', async () => {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '我家里矛盾挺严重的，在考虑搬出去住')] });
  const { pool, repository } = mockRepository(state);
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    // The extractor rephrased away every trigger word - only the raw event
    // carries "矛盾" (through sourceContent).
    extractor: async () => [{ content: '用户与家人相处有摩擦，在考虑独立居住', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user' }],
    auditor: null,
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  const result = await drain();
  assert.equal(result.pending, 1, 'S2 must be classified from the raw message: ' + JSON.stringify(result));
  assert.equal(state.assertions[0].status, 'pending_confirmation');
});

// ---------------------------------------------------------------------------
// R-009: bi-temporal validity wiring
// ---------------------------------------------------------------------------

test('D-01/D-02: drain stamps valid_from from the event and UPDATE closes the timeline', async () => {
  const state = memoryFixture({ rawEvents: [Object.assign(rawEvent('re-1', '请记住：我对花生过敏'), { occurredAt: '2026-01-01T08:00:00.000Z' })] });
  const { pool, repository } = mockRepository(state);
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: async () => [{ content: '我对花生过敏，吃花生制品会起疹子。', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user' }],
    embeddingGateway: async () => [1, 0],
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  await drain();
  const target = state.assertions[0];
  const version = state.assertionVersions.find(item => item.id === target.currentVersionId);
  assert.equal(version.validFrom, '2026-01-01T08:00:00.000Z', 'valid_from follows the raw event occurrence');

  state.rawEvents.push(Object.assign(rawEvent('re-2', '我花生过敏很严重，会休克的那种', 2), { occurredAt: '2026-01-02T08:00:00.000Z' }));
  const { pool: pool2, repository: repository2 } = mockRepository(state);
  const drain2 = createMemoryExtractionDrain({
    pool: pool2,
    repository: repository2,
    extractor: async () => [{ content: '用户对花生严重过敏，接触可能休克。', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user' }],
    auditor: async () => ({ decision: 'UPDATE', target: 0, reason: 'severity' }),
    embeddingGateway: async () => [1, 0],
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  await drain2();
  const oldVersion = state.assertionVersions.find(item => item.id === oldVersionId(state, target));
  const newVersion = state.assertionVersions.find(item => item.id === target.currentVersionId);
  assert.equal(newVersion.validFrom, '2026-01-02T08:00:00.000Z', 'restatement starts the new interval');
  assert.equal(oldVersion.validTo, '2026-01-02T08:00:00.000Z', 'superseded interval closes at the new valid_from');
  assert.equal(newVersion.supersedesVersionId, oldVersion.id, 'the replacement supersedes the old version');
});

function oldVersionId(state, assertion) {
  return state.assertionVersions.find(item => item.id !== assertion.currentVersionId && item.assertionId === assertion.id).id;
}

test('D-03: serialized items expose the bi-temporal fields', async () => {
  const state = memoryFixture({ rawEvents: [Object.assign(rawEvent('re-1', '请记住：我对花生过敏'), { occurredAt: '2026-01-01T08:00:00.000Z' })] });
  const memory = createMemoryModule(state, async () => {}, { projectionEnabled: true, featureFlags: { hybridRetrieval: true } });
  const candidate = await memory.createCandidate(CTX, {
    sourceEventId: 're-1', content: '我对花生过敏。', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user',
    observedAt: '2026-01-01T08:00:00.000Z', validFrom: '2026-01-01T08:00:00.000Z'
  });
  await memory.promoteCandidate(CTX, candidate.memory.memoryId, { resourceRevision: candidate.memory.resourceRevision });
  const retrieved = await memory.retrieveAsync(CTX, { query: '花生', purpose: 'answer_user_query' });
  const item = retrieved.items[0];
  assert.equal(item.observedAt, '2026-01-01T08:00:00.000Z');
  assert.equal(item.validFrom, '2026-01-01T08:00:00.000Z');
  assert.equal(item.validTo, null, 'an active assertion has no valid_to yet');
});

// ---------------------------------------------------------------------------
// R-011: fact-level canonical keys, AUDN similarity threshold, vector floor
// ---------------------------------------------------------------------------

test('R-011a: two extractor candidates on different topics never share a canonical key', async () => {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '我对花生过敏'), rawEvent('re-2', '我最喜欢的水果是榴莲', 2)] });
  const memory = createMemoryModule(state, async () => {}, { projectionEnabled: true });
  const first = await memory.createCandidate(CTX, {
    sourceEventId: 're-1', content: '用户对花生过敏', key: 'allergy_peanut',
    memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
  });
  await memory.promoteCandidate(CTX, first.memory.memoryId, { resourceRevision: first.memory.resourceRevision });
  const second = await memory.createCandidate(CTX, {
    sourceEventId: 're-2', content: '用户最喜欢的水果是榴莲', key: 'favorite_fruit',
    memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
  });
  await memory.promoteCandidate(CTX, second.memory.memoryId, { resourceRevision: second.memory.resourceRevision });
  assert.notEqual(state.assertions[0].canonicalKey, state.assertions[1].canonicalKey,
    'distinct topics must not collapse onto one canonical key');
  assert.ok(state.assertions[0].canonicalKey.includes('allergy_peanut'));
  assert.ok(state.assertions[1].canonicalKey.includes('favorite_fruit'));
});

test('R-011b: without a semantic key the canonical key falls back to a content fingerprint', async () => {
  const state = memoryFixture({ rawEvents: [
    rawEvent('re-1', '我对花生过敏'),
    rawEvent('re-2', '我最喜欢的水果是榴莲', 2),
    rawEvent('re-3', '再说一遍，榴莲是我最喜欢的水果', 3)
  ] });
  const memory = createMemoryModule(state, async () => {}, { projectionEnabled: true });
  const first = await memory.createCandidate(CTX, {
    sourceEventId: 're-1', content: '用户对花生过敏',
    memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
  });
  await memory.promoteCandidate(CTX, first.memory.memoryId, { resourceRevision: first.memory.resourceRevision });
  const second = await memory.createCandidate(CTX, {
    sourceEventId: 're-2', content: '用户最喜欢的水果是榴莲',
    memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
  });
  await memory.promoteCandidate(CTX, second.memory.memoryId, { resourceRevision: second.memory.resourceRevision });
  assert.notEqual(state.assertions[0].canonicalKey, state.assertions[1].canonicalKey,
    'the old default keyed both as user:fact and detected a false conflict');
  assert.ok(/hash:/.test(state.assertions[0].canonicalKey), 'fallback is a content hash: ' + state.assertions[0].canonicalKey);
  // The same content asserted from another source lands on the same key.
  const third = await memory.createCandidate(CTX, {
    sourceEventId: 're-3', content: '用户最喜欢的水果是榴莲',
    memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
  });
  await memory.promoteCandidate(CTX, third.memory.memoryId, { resourceRevision: third.memory.resourceRevision });
  assert.equal(state.assertions[2].canonicalKey, state.assertions[1].canonicalKey,
    'identical content hashes to one key - restatement groups, it does not create a false conflict');
});

test('R-011c: same semantic key with a changed value arbitrates to the newest version', async () => {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '请记住：我最喜欢的水果是榴莲')] });
  const memory = createMemoryModule(state, async () => {}, {
    projectionEnabled: true,
    featureFlags: { conflictLatestWins: true }
  });
  const first = await memory.createCandidate(CTX, {
    sourceEventId: 're-1', content: '用户最喜欢的水果是榴莲', key: 'favorite_fruit',
    memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
  });
  await memory.promoteCandidate(CTX, first.memory.memoryId, { resourceRevision: first.memory.resourceRevision });
  state.rawEvents.push(rawEvent('re-2', '我最喜欢的水果变了，现在是西瓜', 2));
  const second = await memory.createCandidate(CTX, {
    sourceEventId: 're-2', content: '用户最喜欢的水果是西瓜', key: 'favorite_fruit',
    memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user'
  });
  await memory.promoteCandidate(CTX, second.memory.memoryId, { resourceRevision: second.memory.resourceRevision });
  const retrieved = await memory.retrieveAsync(CTX, { query: '水果', purpose: 'answer_user_query' });
  assert.equal(retrieved.answerability, 'known', 'same-key value change arbitrates instead of conflicting');
  assert.equal(retrieved.items.filter(item => item.memoryId).length, 1, 'only one value reaches the prompt');
});

test('R-011d: model extractor maps the semantic key and tolerates junk keys', async () => {
  const extractor = createModelExtractor({
    generate: async () => '{"candidates":[{"content":"用户对花生过敏","key":"Allergy--PEANUT!!","memoryType":"fact"},{"content":"用户在学日语","key":"   ","memoryType":"fact"}]}'
  });
  const proposals = await extractor({ content: '我对花生过敏，最近在学日语' });
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].key, 'allergy_peanut', 'key is normalized to lowercase snake form');
  assert.equal('key' in proposals[1], false, 'blank keys are dropped, not passed as empty strings');
});

test('R-011e: findSimilar eliminates memories below the cosine threshold', async () => {
  const state = await seededState();
  state.rawEvents.push(rawEvent('re-2', '我在服用华法林抗凝', 2));
  const { pool, repository } = mockRepository(state);
  let seenSimilar = null;
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: async () => [{ content: '用户在服用华法林抗凝', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user' }],
    auditor: async (proposal, similar) => { seenSimilar = similar; return { decision: 'ADD', target: null, reason: 'unrelated to seeded memory' }; },
    // Orthogonal vector: cosine with the seeded [1,0] embedding is 0.
    embeddingGateway: async () => [0, 1],
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  await drain();
  assert.equal(seenSimilar.length, 0, 'unrelated candidate must not reach the auditor');
  assert.ok(state.assertions.some(item => item.status === 'active' && item.canonicalKey.includes('hash:')),
    'the ADD lands with a content-hash canonical key');
});

test('R-011f: vectorSearch applies the minScore floor', async () => {
  const { vectorSearch } = await import('./memory-module-retrieval.js');
  const documents = [
    { id: 'near', text: '用户对花生过敏', embedding: [1, 0] },
    { id: 'far', text: '用户在学日语', embedding: [0, 1] }
  ];
  const embed = async () => [0.92, 0.39]; // cos: near≈0.92, far≈0.39
  const floored = await vectorSearch(documents, '花生过敏', embed, { minScore: 0.55 });
  assert.deepEqual(floored.items.map(item => item.id), ['near'], 'below-floor hits are eliminated');
  const open = await vectorSearch(documents, '花生过敏', embed, {});
  assert.equal(open.items.length, 2, 'default 0 keeps legacy behavior');
});

test('R-011g: a zero-candidate event is consumed, not re-sent forever', async () => {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '今天天气真不错啊')] });
  const { pool, repository } = mockRepository(state);
  let extractorCalls = 0;
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    extractor: async () => { extractorCalls += 1; return []; },
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  const first = await drain();
  assert.equal(first.exhausted, 1, 'zero-yield event marked exhausted');
  assert.equal(extractorCalls, 1);
  assert.ok(state.auditEvents.some(item => item.action === 'memory_extraction_exhausted'));
  const second = await drain();
  assert.equal(second.status, 'idle', 'exhausted event no longer pending');
  assert.equal(extractorCalls, 1, 'the model is not re-sent the dead event');
});

test('R-011h: chit-chat ahead in the queue no longer starves later facts', async () => {
  const state = memoryFixture({ rawEvents: [rawEvent('re-1', '今天天气真不错啊'), rawEvent('re-2', '请记住：我对花生过敏', 2)] });
  const { pool, repository } = mockRepository(state);
  const drain = createMemoryExtractionDrain({
    pool,
    repository,
    // batch=1: the chit event occupies the first drain entirely; before the
    // exhaustion marker the fact event behind it never got a turn.
    batch: 1,
    extractor: async event => (String(event.content).includes('花生') ? [{ content: '用户对花生过敏', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user' }] : []),
    context: CTX,
    moduleOptions: { projectionEnabled: true }
  });
  const first = await drain();
  assert.equal(first.exhausted, 1, 'first drain consumes the chit event');
  const second = await drain();
  assert.equal(second.promoted, 1, 'second drain reaches the fact event: ' + JSON.stringify(second));
});
