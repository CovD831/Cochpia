import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  CoreV0Error,
  createCoreV0TurnService,
  createInProcessMemoryPort
} from '../server/core-v0.js';
import {
  createPostgresCoreV0Store,
  createPostgresMemoryPort
} from '../server/core-v0-postgres.js';
import { createCoreV0PostgresFixture } from '../server/core-v0-postgres-fixture.js';
import {
  CORE_V0_PRODUCTION_REQUIRED_COLUMNS,
  CORE_V0_PRODUCTION_TABLES,
  MEMORY_PRODUCTION_REQUIRED_COLUMNS,
  MEMORY_PRODUCTION_TABLES,
  createCoreV0ProductionAdapter,
  createCoreV0ProductionMessageView,
  prepareCoreV0ProductionSchema,
  resetCoreV0ProductionSchemaCache
} from '../server/core-v0-production.js';
import { createMemoryModule, createMemoryModuleState } from '../server/memory-module.js';
import { routeSurfaceViolations } from '../server/chat-route-contract.js';

// Readiness now inspects columns as well as tables, so the controlled doubles
// must answer information_schema.columns too. The required-column manifest is
// the authoritative shape these doubles present back.
const REQUIRED_COLUMNS = { ...CORE_V0_PRODUCTION_REQUIRED_COLUMNS, ...MEMORY_PRODUCTION_REQUIRED_COLUMNS };
const columnRows = (tableNames, isPresent = () => true) => (Array.isArray(tableNames) ? tableNames : [])
  .filter(isPresent)
  .flatMap(table_name => (REQUIRED_COLUMNS[table_name] || []).map(column_name => ({ table_name, column_name })));

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const fixtureRoot = resolve(repoRoot, 'docs/rearchitecture/core-v0-chat-turns-postgres-slice/fixtures');
const context = {
  tenantId: 'tenant-r004-acceptance',
  subjectUserId: 'user-r004-acceptance',
  actorType: 'user',
  actorId: 'user-r004-acceptance',
  callerAgentId: 'cochpia',
  correlationId: 'r004-acceptance'
};

const baseState = () => ({
  sessions: [{
    id: 'session-r004',
    title: 'R-004 acceptance',
    summary: '',
    persona: '',
    atmosphere: '',
    companionIntent: 'listen'
  }],
  messages: { 'session-r004': [] },
  personality: { version: 1, summary: 'acceptance fixture', traits: [] },
  profile: { name: 'Cochpia', gender: 'none', age: null }
});

const inputFromFixture = fixture => ({
  body: {
    sessionId: fixture.request.sessionId,
    message: fixture.request.message,
    channel: fixture.request.channel
  },
  headerIdempotencyKey: fixture.request.headers['Idempotency-Key']
});

function readyPool({ coreReady = true, memoryReady = true } = {}) {
  const fixture = createCoreV0PostgresFixture();
  const queries = [];
  const readinessRows = values => {
    const names = Array.isArray(values?.[0]) ? values[0] : [];
    const core = names.every(name => CORE_V0_PRODUCTION_TABLES.includes(name));
    const allReady = core ? coreReady : memoryReady;
    return { rows: allReady ? names.map(table_name => ({ table_name })) : [] };
  };
  const columnReadinessRows = values => {
    const names = Array.isArray(values?.[0]) ? values[0] : [];
    const core = names.every(name => CORE_V0_PRODUCTION_TABLES.includes(name));
    const allReady = core ? coreReady : memoryReady;
    return { rows: allReady ? columnRows(names) : [] };
  };
  const pool = {
    database: fixture.database,
    queries,
    async connect() {
      const client = await fixture.connect();
      const query = client.query.bind(client);
      client.query = async (sql, values = []) => {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        queries.push({ sql: normalized, values: structuredClone(values) });
        if (/information_schema\.tables/i.test(normalized)) {
          return readinessRows(values);
        }
        if (/information_schema\.columns/i.test(normalized)) {
          return columnReadinessRows(values);
        }
        if (/pg_advisory_(lock|unlock)/i.test(normalized)) return { rows: [] };
        return query(sql, values);
      };
      return client;
    },
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalized, values: structuredClone(values) });
      if (/information_schema\.tables/i.test(normalized)) {
        return readinessRows(values);
      }
      if (/information_schema\.columns/i.test(normalized)) {
        return columnReadinessRows(values);
      }
      return fixture.query(sql, values);
    }
  };
  return pool;
}

function migrationPool() {
  const fixture = createCoreV0PostgresFixture();
  const readyTables = new Set();
  const queries = [];
  const execute = async (queryFixture, rawSql, values = []) => {
    const sql = String(rawSql).replace(/\s+/g, ' ').trim();
    queries.push({ sql, values: structuredClone(values) });
    if (/information_schema\.tables/i.test(sql)) {
      const names = Array.isArray(values?.[0]) ? values[0] : [];
      return { rows: names.filter(name => readyTables.has(name)).map(table_name => ({ table_name })) };
    }
    if (/information_schema\.columns/i.test(sql)) {
      const names = Array.isArray(values?.[0]) ? values[0] : [];
      return { rows: columnRows(names, name => readyTables.has(name)) };
    }
    if (/pg_advisory_(lock|unlock)/i.test(sql)) return { rows: [] };
    if (/^CREATE CORE SCHEMA$/i.test(sql)) {
      for (const table of CORE_V0_PRODUCTION_TABLES) readyTables.add(table);
      return { rows: [] };
    }
    if (/^CREATE MEMORY SCHEMA$/i.test(sql)) {
      for (const table of MEMORY_PRODUCTION_TABLES) readyTables.add(table);
      return { rows: [] };
    }
    return queryFixture(rawSql, values);
  };
  const pool = {
    queries,
    async connect() {
      const client = await fixture.connect();
      const queryFixture = client.query.bind(client);
      client.query = (sql, values = []) => execute(queryFixture, sql, values);
      return client;
    },
    async query(sql, values = []) {
      return execute(async (query, queryValues) => fixture.query(query, queryValues), sql, values);
    }
  };
  return pool;
}

function controlledMemoryPort({ retrieve = null, append = null, ensure = null, calls = null } = {}) {
  return {
    async ensureSessionBinding(args) {
      calls && calls.push('ensure');
      return ensure || {
        status: 'completed',
        memorySessionId: 'memory-r004',
        receipt: { status: 'completed', memorySessionId: 'memory-r004' }
      };
    },
    async appendRawEvent(args) {
      calls && calls.push('append');
      return append || {
        status: 'completed',
        receipt: {
          authoritative: true,
          status: 'completed',
          result: 'accepted_stored',
          eventId: args.event.eventId,
          sourceRevision: args.event.sourceRevision,
          rawEventId: `raw:${args.event.eventId}`
        }
      };
    },
    async retrieveContext(args) {
      calls && calls.push('retrieve');
      if (retrieve instanceof Error) throw retrieve;
      return retrieve || { status: 'available', answerability: 'not_found', recalled: [], bundle: null };
    }
  };
}

function noCallGateway() {
  return {
    async generate() {
      throw new Error('replay unexpectedly called the model');
    }
  };
}

async function runCase(id, fn) {
  try {
    const detail = await fn();
    return { id, status: 'passed', detail };
  } catch (error) {
    return {
      id,
      status: 'fail',
      detail: error?.code || error?.message || error?.name || 'acceptance check failed'
    };
  }
}

async function loadFixtures() {
  const [legacy, target] = await Promise.all([
    readFile(resolve(fixtureRoot, 'legacy-chat-turn.json'), 'utf8').then(JSON.parse),
    readFile(resolve(fixtureRoot, 'target-chat-turn.json'), 'utf8').then(JSON.parse)
  ]);
  assert.equal(legacy.scenario, target.scenario);
  assert.equal(legacy.request.message, target.request.message);
  assert.equal(legacy.request.headers['Idempotency-Key'], target.request.headers['Idempotency-Key']);
  return { legacy, target };
}

async function jsonLegacyConstruction(legacy) {
  const state = baseState();
  const memoryState = createMemoryModuleState();
  const memory = createMemoryModule(memoryState, async () => {});
  const service = createCoreV0TurnService({
    state,
    context,
    memoryPort: createInProcessMemoryPort({ memoryModule: memory, context }),
    modelGateway: { generate: async () => ({ content: 'legacy fixture response' }) }
  });
  const result = await service.handleTurn(inputFromFixture(legacy));
  assert.equal(result.status, 'committed');
  assert.equal(state.messages['session-r004'].some(item => item.role === 'assistant'), true);
  return 'JSON/in-process adapter remains executable for the paired fixture';
}

async function postgresConstruction() {
  resetCoreV0ProductionSchemaCache();
  const pool = readyPool();
  const adapter = await createCoreV0ProductionAdapter({
    pool,
    context,
    baseState: baseState(),
    modelProvider: 'mock',
    schemaOptions: { production: false, autoMigrate: false }
  });
  assert.strictEqual(adapter.pool, pool);
  assert.equal(typeof adapter.store.persist, 'function');
  assert.equal(typeof adapter.memoryPort.ensureSessionBinding, 'function');
  assert.equal(adapter.schema.coreReady, true);
  assert.equal(adapter.schema.memoryReady, true);
  return 'one supplied pool constructs Core Store and MemoryPort adapters';
}

async function requestIdentity() {
  resetCoreV0ProductionSchemaCache();
  const pool = readyPool();
  const adapter = await createCoreV0ProductionAdapter({
    pool,
    context,
    baseState: baseState(),
    modelProvider: 'mock'
  });
  assert.deepEqual(adapter.context, context);
  await assert.rejects(
    () => createCoreV0ProductionAdapter({ pool, context: { tenantId: context.tenantId }, baseState: baseState(), modelProvider: 'mock' }),
    error => error.code === 'CORE_V0_CONTEXT_REQUIRED' && error.status === 400
  );
  return 'tenant and subject identity are required and retained in request context';
}

async function targetStoreAndService(target) {
  const pool = readyPool();
  const store = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  let modelCalls = 0;
  const service = createCoreV0TurnService({
    state: store.state,
    store,
    context,
    memoryPort: controlledMemoryPort(),
    modelGateway: { generate: async () => { modelCalls += 1; return { content: 'target fixture response' }; } }
  });
  const first = await service.handleTurn(inputFromFixture(target));
  assert.equal(first.status, 'committed');
  assert.equal(modelCalls, 1);
  const persisted = store.findTurn(first.turnId);
  for (const key of ['turnId', 'applicationMessageId', 'eventId', 'sourceRevision']) assert.ok(persisted?.[key]);
  return { pool, first, store };
}

async function exactReplay(target) {
  const { pool, first } = await targetStoreAndService(target);
  const fresh = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  const replay = await createCoreV0TurnService({
    state: fresh.state,
    store: fresh,
    context,
    memoryPort: controlledMemoryPort({ ensure: null }),
    modelGateway: noCallGateway()
  }).handleTurn(inputFromFixture(target));
  assert.equal(replay.status, 'committed');
  assert.equal(replay.replay, true);
  assert.equal(replay.turnId, first.turnId);
  return 'fresh Core Store replays the same turn without Memory or model calls';
}

async function changedReplayRejected(target) {
  const { pool } = await targetStoreAndService(target);
  const fresh = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  await assert.rejects(
    () => createCoreV0TurnService({
      state: fresh.state,
      store: fresh,
      context,
      memoryPort: controlledMemoryPort(),
      modelGateway: noCallGateway()
    }).handleTurn({
      body: { ...inputFromFixture(target).body, message: 'changed fixture input' },
      headerIdempotencyKey: target.request.headers['Idempotency-Key']
    }),
    error => error.code === 'IDEMPOTENCY_KEY_CONFLICT' && error.status === 409
  );
  return 'same idempotency key with a changed fingerprint is rejected';
}

async function readParity(target) {
  const { pool } = await targetStoreAndService(target);
  const view = await createCoreV0ProductionMessageView({
    pool,
    context,
    baseState: baseState(),
    schemaOptions: { production: false, autoMigrate: false }
  });
  const messages = await view.listMessages(target.request.sessionId, { channel: target.request.channel });
  const channels = await view.listChannels(target.request.sessionId);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(item => item.role), ['user', 'assistant']);
  assert.equal(channels.some(item => item.name === target.request.channel && item.count === 2), true);
  assert.equal(baseState().messages['session-r004'].length, 0);
  return 'fresh Core hydration exposes both committed messages and does not copy them to JSON state';
}

async function memoryReceipts() {
  let memoryState = createMemoryModuleState();
  const repository = {
    async load() { return structuredClone(memoryState); },
    async save(_, state) {
      memoryState = structuredClone(state);
      state.persistenceBaseSequence = state.sequence;
    }
  };
  const port = createPostgresMemoryPort({ repository, context, retryAttempts: 0 });
  const binding = await port.ensureSessionBinding({ bindingKey: 'tenant-r004-acceptance:user-r004-acceptance:session-r004' });
  const event = { eventId: 'event:r004-receipt', sourceRevision: '1', content: 'receipt fixture' };
  const appended = await port.appendRawEvent({ memorySessionId: binding.memorySessionId, event });
  assert.equal(binding.status, 'completed');
  assert.equal(appended.status, 'completed');
  assert.equal(appended.receipt.authoritative, true);
  assert.equal(appended.receipt.eventId, event.eventId);
  assert.equal(appended.receipt.sourceRevision, event.sourceRevision);
  assert.ok(appended.receipt.rawEventId);
  return 'Memory binding and raw-event receipt preserve their authoritative identities';
}

async function degradedRetrieval(target) {
  const pool = readyPool();
  const store = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  const result = await createCoreV0TurnService({
    state: store.state,
    store,
    context,
    memoryPort: controlledMemoryPort({ retrieve: Object.assign(new Error('retrieval unavailable'), { code: 'MEMORY_RETRIEVE_FAILED' }) }),
    modelGateway: { generate: async () => ({ content: 'degraded fixture response' }) }
  }).handleTurn(inputFromFixture(target));
  assert.equal(result.status, 'committed');
  assert.equal(result.memoryStatus, 'degraded');
  return 'retrieval failure is represented as degraded while the bounded turn commits';
}

async function commitFailure(target) {
  const pool = readyPool();
  const store = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  await assert.rejects(
    () => createCoreV0TurnService({
      state: store.state,
      store,
      context,
      memoryPort: controlledMemoryPort(),
      modelGateway: { generate: async () => ({ content: 'should not be exposed as success' }) },
      commitWriter: async () => {
        throw new CoreV0Error('COMMIT_REJECTED', 'controlled commit failure', { status: 503, retryable: true });
      }
    }).handleTurn(inputFromFixture(target)),
    error => error.code === 'COMMIT_REJECTED'
  );
  assert.equal(store.state.messages['session-r004'].some(item => item.role === 'assistant'), false);
  assert.notEqual(store.findTurnByKey({
    tenantId: context.tenantId,
    subjectUserId: context.subjectUserId,
    applicationSessionId: target.request.sessionId,
    idempotencyKey: target.request.headers['Idempotency-Key']
  })?.status, 'committed');
  return 'assistant commit failure never exposes an assistant success';
}

async function schemaPolicy() {
  resetCoreV0ProductionSchemaCache();
  const readinessOnlyPool = migrationPool();
  await assert.rejects(
    () => prepareCoreV0ProductionSchema(readinessOnlyPool, { production: false, autoMigrate: false }),
    error => error.code === 'CORE_V0_SCHEMA_NOT_READY'
  );
  resetCoreV0ProductionSchemaCache();
  const migration = migrationPool();
  const prepared = await prepareCoreV0ProductionSchema(migration, {
    production: false,
    autoMigrate: true,
    coreSchemaSql: 'CREATE CORE SCHEMA',
    memorySchemaSql: 'CREATE MEMORY SCHEMA'
  });
  assert.equal(prepared.migrated, true);
  assert.equal(prepared.coreReady, true);
  assert.equal(prepared.memoryReady, true);
  assert.equal(migration.queries.filter(item => /^CREATE (CORE|MEMORY) SCHEMA$/i.test(item.sql)).length, 2);
  resetCoreV0ProductionSchemaCache();
  const cached = readyPool();
  await prepareCoreV0ProductionSchema(cached, { production: false, autoMigrate: false });
  const firstQueryCount = cached.queries.length;
  await prepareCoreV0ProductionSchema(cached, { production: false, autoMigrate: false });
  assert.equal(cached.queries.length, firstQueryCount);
  return 'readiness-only, explicit migration, and per-pool preparation caching are distinct';
}

async function productionModelBoundary() {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    resetCoreV0ProductionSchemaCache();
    await assert.rejects(
      () => createCoreV0ProductionAdapter({
        pool: readyPool(),
        context,
        baseState: baseState(),
        modelProvider: 'mock'
      }),
      error => error.code === 'MODEL_PROVIDER_INVALID' && error.status === 503
    );
  } finally {
    if (previous == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
  return 'production construction rejects the mock model provider';
}

async function rollbackContract() {
  const source = await readFile(resolve(repoRoot, 'server/index.js'), 'utf8');
  assert.match(source, /CORE_V0_ENABLED/);
  // R-020 stage 3 deleted the legacy companion surface. The route surface is
  // defined once in server/chat-route-contract.js: this case and P-09 used to
  // keep private copies of the literals and both rotted the moment stage 3
  // landed, because neither harness is part of `npm test`.
  const routeViolations = routeSurfaceViolations(source);
  assert.deepEqual(
    routeViolations.resurrected,
    [],
    `retired companion routes must be gone, found: ${routeViolations.resurrected.join(' | ')}`
  );
  assert.deepEqual(
    routeViolations.missing,
    [],
    `required chat routes are missing: ${routeViolations.missing.join(' | ')}`
  );
  const state = baseState();
  const service = createCoreV0TurnService({
    state,
    context,
    memoryPort: controlledMemoryPort(),
    modelGateway: { generate: async () => ({ content: 'flag-off must not run' }) },
    enabled: false
  });
  await assert.rejects(
    () => service.handleTurn({ body: { sessionId: 'session-r004', message: 'flag off', channel: '默认' }, headerIdempotencyKey: 'flag-off-key' }),
    error => error.code === 'CORE_V0_DISABLED'
  );
  return 'flag-off refusal and legacy stream route remain present in the current entrypoint';
}

const { legacy, target } = await loadFixtures();
const results = [];
results.push(await runCase('A-01', () => jsonLegacyConstruction(legacy)));
results.push(await runCase('A-02', postgresConstruction));
results.push(await runCase('A-03', requestIdentity));
results.push(await runCase('A-04', () => exactReplay(target)));
results.push(await runCase('A-05', () => changedReplayRejected(target)));
results.push(await runCase('A-06', () => readParity(target)));
results.push(await runCase('A-07', memoryReceipts));
results.push(await runCase('A-08', () => degradedRetrieval(target)));
results.push(await runCase('A-09', () => commitFailure(target)));
results.push(await runCase('A-10', schemaPolicy));
results.push(await runCase('A-11', productionModelBoundary));
results.push(await runCase('A-12', rollbackContract));

const summary = {
  package: 'R-004-core-v0-chat-turns-postgres',
  mode: 'paired-fixture-controlled-doubles',
  fixtureScenario: target.scenario,
  results
};
console.log(JSON.stringify(summary, null, 2));
if (results.some(result => result.status === 'fail')) process.exitCode = 1;
