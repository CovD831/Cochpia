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
