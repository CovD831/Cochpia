import { readFile } from 'node:fs/promises';
import { getApplicationPostgresPool, loadState } from './store.js';
import { createModelProvider, resolveModelSelection } from './model-provider.js';
import { CoreV0Error, createCoreV0TurnService, createInProcessMemoryPort } from './core-v0.js';
import { createPostgresCoreV0Store, createPostgresMemoryPort } from './core-v0-postgres.js';
import { createMemoryModulePostgresRepository } from './memory-module-postgres.js';

let schemaPreparationCache = new WeakMap();

export const CORE_V0_PRODUCTION_TABLES = Object.freeze([
  'core_v0_subjects',
  'core_v0_turn_admissions',
  'core_v0_memory_session_bindings',
  'core_v0_assistant_commits',
  'core_v0_messages',
  'core_v0_admission_gates',
  'core_v0_admission_leases',
  'core_v0_repair_attempts',
  'core_v0_crash_records'
]);

export const MEMORY_PRODUCTION_TABLES = Object.freeze([
  'memory_sessions',
  'raw_events',
  'memory_assertions',
  'assertion_versions',
  'profile_snapshots',
  'profile_snapshot_items',
  'profile_projections',
  'profile_projection_items',
  'profile_projection_sources',
  'index_documents',
  'episodes',
  'episode_members',
  'assertion_version_sources',
  'current_states',
  'current_state_sources',
  'scope_grants',
  'confirmation_requests',
  'access_confirmations',
  'memory_mention_cooldowns',
  'pins',
  'deletion_operations',
  'memory_tombstones',
  'redaction_epochs',
  'memory_commit_sequences',
  'memory_outbox_events',
  'memory_audit_events',
  'memory_idempotency_records'
]);

const isTruthy = value => /^(1|true|yes)$/i.test(String(value || ''));
const isProductionEnvironment = () => String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const usesAutoMigration = () => isTruthy(process.env.CORE_V0_AUTO_MIGRATE);

function productionError(code, message, options = {}) {
  return new CoreV0Error(code, message, {
    status: options.status || 503,
    retryable: options.retryable ?? true,
    unknown: options.unknown ?? false,
    cause: options.cause
  });
}

async function readSchemaFile(name) {
  return readFile(new URL('./' + name, import.meta.url), 'utf8');
}

async function missingTables(executor, tableNames) {
  const result = await executor.query(
    'SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=ANY($1::text[])',
    [tableNames]
  );
  const existing = new Set((result.rows || []).map(row => row.table_name));
  return tableNames.filter(tableName => !existing.has(tableName));
}

async function withMigrationLock(pool, callback) {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['cochpia:core-v0:schema']);
    locked = true;
    return await callback(client);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['cochpia:core-v0:schema']).catch(() => {});
    client.release();
  }
}

export async function prepareCoreV0ProductionSchema(pool, {
  autoMigrate = usesAutoMigration(),
  production = isProductionEnvironment(),
  coreSchemaSql = null,
  memorySchemaSql = null
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('Core v0 production schema preparation requires a PostgreSQL pool');
  }
  let cached = schemaPreparationCache.get(pool);
  if (cached) return cached;

  cached = (async () => {
    let missingCore;
    let missingMemory;
    try {
      [missingCore, missingMemory] = await Promise.all([
        missingTables(pool, CORE_V0_PRODUCTION_TABLES),
        missingTables(pool, MEMORY_PRODUCTION_TABLES)
      ]);
    } catch (error) {
      throw productionError('CORE_V0_SCHEMA_CHECK_FAILED', 'Core v0 schema readiness could not be checked', { cause: error });
    }

    let migrated = false;
    if (missingCore.length || missingMemory.length) {
      if (production || !autoMigrate) {
        throw productionError('CORE_V0_SCHEMA_NOT_READY', 'Core v0 and Memory PostgreSQL schemas are not ready');
      }
      let coreSql = coreSchemaSql;
      let memorySql = memorySchemaSql;
      try {
        coreSql ||= await readSchemaFile('core-v0-schema.sql');
        memorySql ||= await readSchemaFile('memory-module-schema.sql');
        await withMigrationLock(pool, async client => {
          const lockedMissingCore = await missingTables(client, CORE_V0_PRODUCTION_TABLES);
          const lockedMissingMemory = await missingTables(client, MEMORY_PRODUCTION_TABLES);
          if (lockedMissingCore.length) await client.query(coreSql);
          if (lockedMissingMemory.length) await client.query(memorySql);
          migrated = lockedMissingCore.length > 0 || lockedMissingMemory.length > 0;
        });
      } catch (error) {
        throw productionError('CORE_V0_SCHEMA_MIGRATION_FAILED', 'Core v0 and Memory schemas could not be prepared', { cause: error });
      }
    }

    try {
      [missingCore, missingMemory] = await Promise.all([
        missingTables(pool, CORE_V0_PRODUCTION_TABLES),
        missingTables(pool, MEMORY_PRODUCTION_TABLES)
      ]);
    } catch (error) {
      throw productionError('CORE_V0_SCHEMA_CHECK_FAILED', 'Core v0 schema readiness could not be verified', { cause: error });
    }
    if (missingCore.length || missingMemory.length) {
      throw productionError('CORE_V0_SCHEMA_NOT_READY', 'Core v0 and Memory PostgreSQL schemas are incomplete');
    }
    return { coreReady: true, memoryReady: true, migrated, missing: [] };
  })().catch(error => {
    schemaPreparationCache.delete(pool);
    throw error;
  });
  schemaPreparationCache.set(pool, cached);
  return cached;
}

function requireRequestContext(rawContext) {
  const tenantId = String(rawContext?.tenantId || '').trim();
  const subjectUserId = String(rawContext?.subjectUserId || '').trim();
  if (!tenantId || !subjectUserId) {
    throw productionError('CORE_V0_CONTEXT_REQUIRED', 'Core v0 request context requires tenant and subject identity', { status: 400, retryable: false });
  }
  return { ...rawContext, tenantId, subjectUserId };
}

function assertProductionModel(provider, selection) {
  if (isProductionEnvironment() && (provider === 'mock' || selection.config?.protocol === 'mock')) {
    throw productionError('MODEL_PROVIDER_INVALID', 'A mock model provider is not allowed in production', { retryable: false });
  }
}

function createModelGateway(model) {
  return {
    async generate(input = {}) {
      const content = String(await model.generate(input) || '').trim();
      if (!content) throw new CoreV0Error('MODEL_EMPTY_RESULT', 'Model returned an empty result', { status: 502, retryable: true });
      return { status: 'generation_succeeded', content };
    }
  };
}

function modelInfo(model) {
  return { provider: model.provider, model: model.model, protocol: model.protocol, ready: model.ready };
}

export async function createCoreV0ProductionAdapter({
  pool: providedPool = null,
  getPool = getApplicationPostgresPool,
  context: rawContext,
  baseState = null,
  modelProvider = null,
  modelName = null,
  retryAttempts = 2,
  moduleOptions = {},
  schemaOptions = {}
} = {}) {
  const context = requireRequestContext(rawContext);
  const pool = providedPool || await getPool();
  const schema = await prepareCoreV0ProductionSchema(pool, schemaOptions);
  const state = baseState || await loadState();
  const provider = String(modelProvider || process.env.MODEL_PROVIDER || 'mock').trim() || 'mock';
  const selection = resolveModelSelection(provider, modelName || '');
  if (!selection.ok) {
    throw new CoreV0Error(selection.code, selection.error, {
      status: selection.code === 'MODEL_NOT_CONFIGURED' ? 503 : 400,
      retryable: selection.code === 'MODEL_NOT_CONFIGURED'
    });
  }
  assertProductionModel(provider, selection);

  const model = createModelProvider(provider, { model: selection.config.model });
  const modelGateway = createModelGateway(model);
  const store = await createPostgresCoreV0Store({ pool, context, baseState: state });
  const repository = createMemoryModulePostgresRepository(pool, { pgvector: isTruthy(process.env.MEMORY_PGVECTOR_ENABLED) });
  const memoryPort = createPostgresMemoryPort({ repository, context, retryAttempts, moduleOptions });
  const service = createCoreV0TurnService({
    state: store.state,
    store,
    context,
    memoryPort,
    modelGateway,
    enabled: true
  });

  return {
    pool,
    schema,
    context,
    state: store.state,
    store,
    repository,
    memoryPort,
    model: modelInfo(model),
    modelGateway,
    service
  };
}

export async function createCoreV0ProductionMessageView({
  pool: providedPool = null,
  getPool = getApplicationPostgresPool,
  context: rawContext,
  baseState = null,
  schemaOptions = {}
} = {}) {
  const context = requireRequestContext(rawContext);
  const pool = providedPool || await getPool();
  const schema = await prepareCoreV0ProductionSchema(pool, schemaOptions);
  const state = baseState || await loadState();
  const store = await createPostgresCoreV0Store({ pool, context, baseState: state });

  const listMessages = async (sessionId, { channel = '' } = {}) => {
    const normalizedSessionId = String(sessionId || '').trim();
    const messages = Array.isArray(store.state.messages?.[normalizedSessionId])
      ? store.state.messages[normalizedSessionId]
      : [];
    const scoped = channel
      ? messages.filter(message => (message.channel || '默认') === channel)
      : messages;
    return structuredClone(scoped);
  };

  const listChannels = async sessionId => {
    const messages = await listMessages(sessionId);
    const counts = new Map();
    for (const message of messages) {
      const name = message.channel || '默认';
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count }));
  };

  return { pool, schema, state: store.state, store, listMessages, listChannels };
}

export function createCoreV0LocalAdapter({
  state,
  context,
  memoryModule,
  modelProvider = 'mock',
  modelName = ''
} = {}) {
  if (!state || !context || !memoryModule) throw new TypeError('Core v0 local adapter requires state, context, and Memory Module');
  const selection = resolveModelSelection(modelProvider, modelName);
  if (!selection.ok) {
    throw new CoreV0Error(selection.code, selection.error, {
      status: selection.code === 'MODEL_NOT_CONFIGURED' ? 503 : 400,
      retryable: selection.code === 'MODEL_NOT_CONFIGURED'
    });
  }
  const modelGateway = createModelGateway(createModelProvider(modelProvider, { model: selection.config.model }));
  const memoryPort = createInProcessMemoryPort({ memoryModule, context });
  const service = createCoreV0TurnService({ state, context, memoryPort, modelGateway, enabled: true });
  return { state, context, memoryPort, modelGateway, service };
}

export function resetCoreV0ProductionSchemaCache() {
  schemaPreparationCache = new WeakMap();
}
