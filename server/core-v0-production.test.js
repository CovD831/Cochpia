// Unit coverage for the R-004 production boundary: schema readiness is a
// structural contract (tables plus required columns), not a table-existence
// probe, and a database that is unreachable or structurally incomplete must
// never be reported as ready.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CORE_V0_PRODUCTION_REQUIRED_COLUMNS,
  CORE_V0_PRODUCTION_TABLES,
  MEMORY_PRODUCTION_REQUIRED_COLUMNS,
  MEMORY_PRODUCTION_TABLES,
  createCoreV0ProductionAdapter,
  createCoreV0ProductionMessageView,
  prepareCoreV0ProductionSchema,
  resetCoreV0ProductionSchemaCache
} from './core-v0-production.js';
import { CORE_V0_SESSION_MESSAGE_LIMIT } from './core-v0-postgres.js';
import { createCoreV0PostgresFixture } from './core-v0-postgres-fixture.js';

const ALL_COLUMNS = { ...CORE_V0_PRODUCTION_REQUIRED_COLUMNS, ...MEMORY_PRODUCTION_REQUIRED_COLUMNS };
const ALL_TABLES = [...CORE_V0_PRODUCTION_TABLES, ...MEMORY_PRODUCTION_TABLES];

const allColumnKeys = () => new Set(
  Object.entries(ALL_COLUMNS).flatMap(([table, columns]) => columns.map(column => `${table}.${column}`))
);

const memoryOnlyColumnKeys = () => new Set(
  Object.entries(ALL_COLUMNS)
    .filter(([table]) => MEMORY_PRODUCTION_REQUIRED_COLUMNS[table])
    .flatMap(([table, columns]) => columns.map(column => `${table}.${column}`))
);

// A controlled pool that answers the two information_schema probes the
// readiness check issues. DDL is recorded rather than interpreted.
function fakePool({ tables = new Set(ALL_TABLES), columns = allColumnKeys(), failProbe = false } = {}) {
  const queries = [];
  const executor = {
    queries,
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalized, values });
      if (/information_schema\.tables/i.test(normalized)) {
        if (failProbe) throw Object.assign(new Error('connection terminated'), { code: 'ECONNREFUSED' });
        const names = Array.isArray(values?.[0]) ? values[0] : [];
        return { rows: names.filter(name => tables.has(name)).map(table_name => ({ table_name })) };
      }
      if (/information_schema\.columns/i.test(normalized)) {
        if (failProbe) throw Object.assign(new Error('connection terminated'), { code: 'ECONNREFUSED' });
        const names = Array.isArray(values?.[0]) ? values[0] : [];
        return {
          rows: names.flatMap(table_name => (ALL_COLUMNS[table_name] || [])
            .filter(column_name => columns.has(`${table_name}.${column_name}`))
            .map(column_name => ({ table_name, column_name })))
        };
      }
      if (/pg_advisory_(lock|unlock)/i.test(normalized)) return { rows: [] };
      return { rows: [] };
    },
    async connect() { return executor; },
    release() {}
  };
  return executor;
}

const readinessOnly = { production: false, autoMigrate: false };

test('readiness passes when every required table and column is present', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool();
  const result = await prepareCoreV0ProductionSchema(pool, readinessOnly);
  assert.equal(result.coreReady, true);
  assert.equal(result.memoryReady, true);
  assert.equal(result.migrated, false);
  assert.deepEqual(result.missing, []);
});

test('readiness fails with retryable NOT_READY when required columns are absent', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool({ columns: new Set() });
  await assert.rejects(
    () => prepareCoreV0ProductionSchema(pool, readinessOnly),
    error => {
      assert.equal(error.code, 'CORE_V0_SCHEMA_NOT_READY');
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true);
      return true;
    }
  );
});

test('readiness details name the specific tables with missing columns', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool({ columns: memoryOnlyColumnKeys() });
  await assert.rejects(
    () => prepareCoreV0ProductionSchema(pool, readinessOnly),
    error => {
      assert.equal(error.code, 'CORE_V0_SCHEMA_NOT_READY');
      const incompleteCore = error.details?.incompleteCore || {};
      assert.ok(Object.keys(incompleteCore).length > 0, 'Core incompleteness must be reported');
      assert.ok(incompleteCore.core_v0_messages?.includes('subject_user_id'));
      assert.deepEqual(error.details.incompleteMemory || {}, {}, 'Memory is complete and must not be blamed');
      return true;
    }
  );
});

test('missing tables are reported separately from missing columns', async () => {
  resetCoreV0ProductionSchemaCache();
  const tables = new Set(ALL_TABLES.filter(name => name !== 'core_v0_messages'));
  const pool = fakePool({ tables });
  await assert.rejects(
    () => prepareCoreV0ProductionSchema(pool, readinessOnly),
    error => {
      assert.deepEqual(error.details?.missingCore, ['core_v0_messages']);
      assert.deepEqual(error.details?.missingMemory, []);
      return true;
    }
  );
});

test('an unreachable database is a check failure, never a ready or JSON success', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool({ failProbe: true });
  await assert.rejects(
    () => prepareCoreV0ProductionSchema(pool, readinessOnly),
    error => error.code === 'CORE_V0_SCHEMA_CHECK_FAILED' && error.retryable === true
  );
});

test('production never applies DDL even when the schema is incomplete', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool({ tables: new Set(), columns: new Set() });
  await assert.rejects(
    () => prepareCoreV0ProductionSchema(pool, {
      production: true,
      autoMigrate: true,
      coreSchemaSql: 'DDL-CORE',
      memorySchemaSql: 'DDL-MEMORY'
    }),
    error => error.code === 'CORE_V0_SCHEMA_NOT_READY'
  );
  assert.equal(pool.queries.some(entry => /^DDL-(CORE|MEMORY)$/.test(entry.sql)), false);
});

test('explicit migration applies both DDL scripts under the migration lock', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool({ tables: new Set(), columns: new Set() });
  await assert.rejects(
    () => prepareCoreV0ProductionSchema(pool, {
      production: false,
      autoMigrate: true,
      coreSchemaSql: 'DDL-CORE',
      memorySchemaSql: 'DDL-MEMORY'
    }),
    error => error.code === 'CORE_V0_SCHEMA_NOT_READY'
  );
  const ddl = pool.queries.filter(entry => /^DDL-(CORE|MEMORY)$/.test(entry.sql)).map(entry => entry.sql);
  assert.deepEqual(ddl, ['DDL-CORE', 'DDL-MEMORY']);
  assert.ok(pool.queries.some(entry => /pg_advisory_lock/.test(entry.sql)), 'migration must hold the advisory lock');
});

test('migration that cannot repair the structure still ends in NOT_READY', async () => {
  resetCoreV0ProductionSchemaCache();
  const tables = new Set(ALL_TABLES);
  const pool = fakePool({ tables, columns: new Set() });
  await assert.rejects(
    () => prepareCoreV0ProductionSchema(pool, {
      production: false,
      autoMigrate: true,
      coreSchemaSql: 'DDL-CORE',
      memorySchemaSql: 'DDL-MEMORY'
    }),
    error => error.code === 'CORE_V0_SCHEMA_NOT_READY'
  );
});

test('preparation is cached per pool so readiness is not re-probed per request', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool();
  await prepareCoreV0ProductionSchema(pool, readinessOnly);
  const probeCount = pool.queries.length;
  assert.ok(probeCount > 0);
  const second = await prepareCoreV0ProductionSchema(pool, readinessOnly);
  assert.equal(pool.queries.length, probeCount);
  assert.equal(second.coreReady, true);
});

test('a failed preparation is not cached and can be retried', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool({ columns: new Set() });
  await assert.rejects(() => prepareCoreV0ProductionSchema(pool, readinessOnly));
  const afterFailure = pool.queries.length;
  await assert.rejects(() => prepareCoreV0ProductionSchema(pool, readinessOnly));
  assert.ok(pool.queries.length > afterFailure, 'a rejected preparation must not poison the cache');
});

// ---------------------------------------------------------------------------
// Session-scoped bounded message view
// ---------------------------------------------------------------------------

const VIEW_CONTEXT = {
  tenantId: 'tenant-view',
  subjectUserId: 'user-view',
  actorType: 'user',
  actorId: 'user-view',
  callerAgentId: 'cochpia',
  correlationId: 'view'
};
const INSERT_MESSAGE = 'INSERT INTO core_v0_messages (tenant_id,subject_user_id,application_message_id,application_session_id,role,content,channel,created_at,visible_at,core_v0) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)';

// The relational double does not model information_schema, so readiness probes
// are answered here while domain statements still reach the fixture.
function viewPool() {
  const fixture = createCoreV0PostgresFixture();
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
          return { rows: names.flatMap(table_name => (ALL_COLUMNS[table_name] || []).map(column_name => ({ table_name, column_name }))) };
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
  return pool;
}

async function insertMessage(pool, { id, sessionId, role = 'user', content = 'content', channel = null, createdAt }) {
  await pool.query(INSERT_MESSAGE, [VIEW_CONTEXT.tenantId, VIEW_CONTEXT.subjectUserId, id, sessionId, role, content, channel, createdAt, createdAt, { applicationSessionId: sessionId }]);
}

const viewOptions = (baseState, limit) => ({
  context: VIEW_CONTEXT,
  baseState,
  ...(limit ? { limit } : {}),
  schemaOptions: readinessOnly
});

test('session message view returns only the requested session', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = viewPool();
  await insertMessage(pool, { id: 'a-1', sessionId: 'session-a', createdAt: '2026-01-01T00:00:00.000Z' });
  await insertMessage(pool, { id: 'b-1', sessionId: 'session-b', createdAt: '2026-01-02T00:00:00.000Z' });
  const view = await createCoreV0ProductionMessageView({ pool, ...viewOptions({ messages: {} }) });
  const messages = await view.listMessages('session-a');
  assert.deepEqual(messages.map(item => item.id), ['a-1']);
});

test('session message view is bounded and keeps the newest messages', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = viewPool();
  for (let index = 1; index <= 5; index += 1) {
    await insertMessage(pool, { id: `m-${index}`, sessionId: 'session-a', createdAt: `2026-01-0${index}T00:00:00.000Z` });
  }
  const view = await createCoreV0ProductionMessageView({ pool, ...viewOptions({ messages: {} }, 3) });
  const messages = await view.listMessages('session-a');
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map(item => item.id), ['m-3', 'm-4', 'm-5']);
});

test('session message view defaults to a bounded limit', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = viewPool();
  const view = await createCoreV0ProductionMessageView({ pool, ...viewOptions({ messages: {} }) });
  for (let index = 0; index < CORE_V0_SESSION_MESSAGE_LIMIT + 5; index += 1) {
    const day = String(index).padStart(4, '0');
    await insertMessage(pool, { id: `m-${index}`, sessionId: 'session-a', createdAt: `2026-01-01T00:${day}Z`.slice(0, 24) + 'Z' });
  }
  const messages = await view.listMessages('session-a');
  assert.equal(messages.length, CORE_V0_SESSION_MESSAGE_LIMIT);
});

test('channel filter applies to Core rows including the null default channel', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = viewPool();
  await insertMessage(pool, { id: 'plain', sessionId: 's', channel: '默认', createdAt: '2026-01-01T00:00:00.000Z' });
  await insertMessage(pool, { id: 'work', sessionId: 's', channel: 'work', createdAt: '2026-01-02T00:00:00.000Z' });
  await insertMessage(pool, { id: 'nulled', sessionId: 's', channel: null, createdAt: '2026-01-03T00:00:00.000Z' });
  const view = await createCoreV0ProductionMessageView({ pool, ...viewOptions({ messages: {} }) });
  assert.deepEqual((await view.listMessages('s', { channel: '默认' })).map(item => item.id).sort(), ['nulled', 'plain']);
  assert.deepEqual((await view.listMessages('s', { channel: 'work' })).map(item => item.id), ['work']);
});

test('Core and legacy messages are both visible and Core rows never enter JSON state', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = viewPool();
  await insertMessage(pool, { id: 'core-1', sessionId: 's', role: 'assistant', createdAt: '2026-01-02T00:00:00.000Z' });
  const baseState = { messages: { s: [{ id: 'legacy-1', role: 'user', content: 'old', channel: null, createdAt: '2026-01-01T00:00:00.000Z' }] } };
  const view = await createCoreV0ProductionMessageView({ pool, ...viewOptions(baseState) });
  const messages = await view.listMessages('s');
  assert.deepEqual(messages.map(item => item.id), ['legacy-1', 'core-1']);
  assert.equal(baseState.messages.s.length, 1);
  assert.equal(baseState.messages.s[0].id, 'legacy-1');
});

test('channel counts stay complete when the session exceeds the read limit', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = viewPool();
  for (let index = 1; index <= 4; index += 1) {
    await insertMessage(pool, { id: `m-${index}`, sessionId: 's', channel: index <= 2 ? '默认' : 'work', createdAt: `2026-01-0${index}T00:00:00.000Z` });
  }
  const view = await createCoreV0ProductionMessageView({ pool, ...viewOptions({ messages: {} }, 2) });
  assert.equal((await view.listMessages('s')).length, 2);
  const counts = Object.fromEntries((await view.listChannels('s')).map(entry => [entry.name, entry.count]));
  assert.deepEqual(counts, { 默认: 2, work: 2 });
});

test('an empty session identifier reads nothing', async () => {
  resetCoreV0ProductionSchemaCache();
  const view = await createCoreV0ProductionMessageView({ pool: viewPool(), ...viewOptions({ messages: {} }) });
  assert.deepEqual(await view.listMessages(''), []);
  assert.deepEqual(await view.listChannels(''), []);
});

test('assistant commit time stays strictly after the user message time', async () => {
  const { createCoreV0Store, createCoreV0TurnService, createInProcessMemoryPort } = await import('./core-v0.js');
  const { createMemoryModule, createMemoryModuleState } = await import('./memory-module.js');
  const state = {
    sessions: [{ id: 's', title: 't', summary: '', persona: '', atmosphere: '', companionIntent: 'listen' }],
    messages: { s: [] },
    personality: { version: 1, summary: '', traits: [] },
    profile: {}
  };
  const store = createCoreV0Store({ state });
  const context = { tenantId: 'tenant-order', subjectUserId: 'user-order', actorType: 'user', actorId: 'user-order', callerAgentId: 'cochpia', correlationId: 'order' };
  const service = createCoreV0TurnService({
    state,
    store,
    context,
    memoryPort: createInProcessMemoryPort({ memoryModule: createMemoryModule(createMemoryModuleState(), async () => {}), context }),
    modelGateway: { generate: async () => ({ content: 'reply' }) },
    enabled: true
  });
  const result = await service.handleTurn({
    body: { sessionId: 's', message: 'hello', channel: '默认' },
    headerIdempotencyKey: 'order-key-1'
  });
  assert.equal(result.status, 'committed');
  const user = state.messages.s.find(item => item.role === 'user');
  const assistant = state.messages.s.find(item => item.role === 'assistant');
  assert.ok(user && assistant, 'both messages must be present');
  assert.ok(
    String(assistant.createdAt) > String(user.createdAt),
    `assistant (${assistant.createdAt}) must be strictly after user (${user.createdAt})`
  );
});

// ---------------------------------------------------------------------------
// Request context and base state tightening
// ---------------------------------------------------------------------------

const adapterOptions = overrides => ({
  pool: fakePool(),
  context: VIEW_CONTEXT,
  baseState: { messages: {} },
  modelProvider: 'mock',
  schemaOptions: readinessOnly,
  ...overrides
});

test('construction requires request-scoped application state instead of global state', async () => {
  resetCoreV0ProductionSchemaCache();
  await assert.rejects(
    () => createCoreV0ProductionAdapter({ pool: fakePool(), context: VIEW_CONTEXT, modelProvider: 'mock', schemaOptions: readinessOnly }),
    error => error instanceof TypeError
  );
  await assert.rejects(
    () => createCoreV0ProductionMessageView({ pool: fakePool(), context: VIEW_CONTEXT, schemaOptions: readinessOnly }),
    error => error instanceof TypeError
  );
});

test('request context must carry actor and correlation identity, not only tenant and subject', async () => {
  resetCoreV0ProductionSchemaCache();
  const partial = { tenantId: VIEW_CONTEXT.tenantId, subjectUserId: VIEW_CONTEXT.subjectUserId };
  await assert.rejects(
    () => createCoreV0ProductionAdapter({ ...adapterOptions({ context: partial, baseState: undefined }) }),
    error => error.code === 'CORE_V0_CONTEXT_REQUIRED' && error.status === 400 && error.retryable === false
  );
  const missingCorrelation = { ...VIEW_CONTEXT, correlationId: '   ' };
  await assert.rejects(
    () => createCoreV0ProductionMessageView({ pool: fakePool(), context: missingCorrelation, baseState: { messages: {} }, schemaOptions: readinessOnly }),
    error => error.code === 'CORE_V0_CONTEXT_REQUIRED'
  );
});

test('a valid context is retained intact with normalized identity fields', async () => {
  resetCoreV0ProductionSchemaCache();
  const view = await createCoreV0ProductionMessageView({ pool: fakePool(), context: VIEW_CONTEXT, baseState: { messages: {} }, schemaOptions: readinessOnly });
  assert.equal(view.context.tenantId, VIEW_CONTEXT.tenantId);
  assert.equal(view.context.subjectUserId, VIEW_CONTEXT.subjectUserId);
  assert.equal(view.context.actorType, VIEW_CONTEXT.actorType);
  assert.equal(view.context.actorId, VIEW_CONTEXT.actorId);
  assert.equal(view.context.correlationId, VIEW_CONTEXT.correlationId);
});
