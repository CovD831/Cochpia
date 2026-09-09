import { readFile } from 'node:fs/promises';
import { getApplicationPostgresPool } from './store.js';
import { createModelProvider, resolveModelSelection } from './model-provider.js';
import { CoreV0Error, createCoreV0TurnService, createInProcessMemoryPort } from './core-v0.js';
import {
  CORE_V0_DEFAULT_CHANNEL,
  CORE_V0_SESSION_MESSAGE_LIMIT,
  countCoreV0SessionChannels,
  createPostgresCoreV0Store,
  createPostgresMemoryPort,
  loadCoreV0SessionMessages
} from './core-v0-postgres.js';
import { createMemoryModulePostgresRepository } from './memory-module-postgres.js';
import { createMemoryModule } from './memory-module.js';
import { createMemoryExtractionDrain, createModelExtractor, createModelAuditor } from './memory-extraction.js';
import { createOllamaEmbeddingGateway } from './memory-embedding.js';

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

// Readiness is not satisfied by table existence alone. A table left behind by an
// older revision can be present while its subject scope or status columns are
// missing, which would fail later at write time instead of at admission. These
// columns are the minimum structural contract each owner must expose.
export const CORE_V0_PRODUCTION_REQUIRED_COLUMNS = Object.freeze({
  core_v0_subjects: ['tenant_id', 'subject_user_id', 'sequence'],
  core_v0_turn_admissions: ['tenant_id', 'subject_user_id', 'turn_id', 'application_session_id', 'idempotency_key', 'fingerprint', 'status', 'memory_status'],
  core_v0_memory_session_bindings: ['tenant_id', 'subject_user_id', 'binding_id', 'binding_key', 'application_session_id', 'status'],
  core_v0_assistant_commits: ['tenant_id', 'subject_user_id', 'commit_id', 'turn_id', 'status'],
  core_v0_messages: ['tenant_id', 'subject_user_id', 'application_message_id', 'application_session_id', 'role', 'content', 'channel', 'core_v0'],
  core_v0_admission_gates: ['gate_id', 'enabled', 'close_epoch'],
  core_v0_admission_leases: ['gate_id', 'lease_id', 'admission_key', 'status', 'close_epoch'],
  core_v0_repair_attempts: ['repair_attempt_id', 'operation', 'status', 'external_receipt_id', 'core_commit_id'],
  core_v0_crash_records: ['crash_record_id', 'operation', 'status']
});

export const MEMORY_PRODUCTION_REQUIRED_COLUMNS = Object.freeze({
  memory_sessions: ['id', 'tenant_id', 'user_id', 'status'],
  raw_events: ['id', 'tenant_id', 'user_id', 'event_id', 'source_revision'],
  memory_commit_sequences: ['tenant_id', 'user_id', 'commit_seq'],
  memory_assertions: ['id', 'tenant_id', 'user_id', 'canonical_key', 'status']
});

const isTruthy = value => /^(1|true|yes)$/i.test(String(value || ''));

// R-011: similarity thresholds are env-tunable floats in [0,1]; "0" is a
// valid value (disabled), so parse without the || fallback trap.
const parseScoreThreshold = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
};
const isProductionEnvironment = () => String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const usesAutoMigration = () => isTruthy(process.env.CORE_V0_AUTO_MIGRATE);

function productionError(code, message, options = {}) {
  return new CoreV0Error(code, message, {
    status: options.status || 503,
    retryable: options.retryable ?? true,
    unknown: options.unknown ?? false,
    cause: options.cause,
    details: options.details ?? null
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

async function missingColumns(executor, requiredColumns) {
  const tableNames = Object.keys(requiredColumns);
  if (!tableNames.length) return {};
  const result = await executor.query(
    'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1::text[])',
    [tableNames]
  );
  const present = new Map();
  for (const row of result.rows || []) {
    if (!present.has(row.table_name)) present.set(row.table_name, new Set());
    present.get(row.table_name).add(row.column_name);
  }
  const missing = {};
  for (const [tableName, columns] of Object.entries(requiredColumns)) {
    const available = present.get(tableName);
    const absent = available ? columns.filter(column => !available.has(column)) : columns.slice();
    if (absent.length) missing[tableName] = absent;
  }
  return missing;
}

const isEmpty = value => (Array.isArray(value) ? value.length === 0 : Object.keys(value || {}).length === 0);

const schemaIsReady = snapshot => isEmpty(snapshot.missingCore)
  && isEmpty(snapshot.missingMemory)
  && isEmpty(snapshot.incompleteCore)
  && isEmpty(snapshot.incompleteMemory);

async function inspectSchema(executor) {
  const [missingCore, missingMemory, incompleteCore, incompleteMemory] = await Promise.all([
    missingTables(executor, CORE_V0_PRODUCTION_TABLES),
    missingTables(executor, MEMORY_PRODUCTION_TABLES),
    missingColumns(executor, CORE_V0_PRODUCTION_REQUIRED_COLUMNS),
    missingColumns(executor, MEMORY_PRODUCTION_REQUIRED_COLUMNS)
  ]);
  return { missingCore, missingMemory, incompleteCore, incompleteMemory };
}

const schemaNotReady = (message, snapshot) => productionError('CORE_V0_SCHEMA_NOT_READY', message, { details: snapshot });

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
    let snapshot;
    try {
      snapshot = await inspectSchema(pool);
    } catch (error) {
      throw productionError('CORE_V0_SCHEMA_CHECK_FAILED', 'Core v0 schema readiness could not be checked', { cause: error });
    }

    let migrated = false;
    if (!schemaIsReady(snapshot)) {
      if (production || !autoMigrate) {
        throw schemaNotReady('Core v0 and Memory PostgreSQL schemas are not ready', snapshot);
      }
      let coreSql = coreSchemaSql;
      let memorySql = memorySchemaSql;
      try {
        coreSql ||= await readSchemaFile('core-v0-schema.sql');
        memorySql ||= await readSchemaFile('memory-module-schema.sql');
        await withMigrationLock(pool, async client => {
          const locked = await inspectSchema(client);
          if (!isEmpty(locked.missingCore) || !isEmpty(locked.incompleteCore)) await client.query(coreSql);
          if (!isEmpty(locked.missingMemory) || !isEmpty(locked.incompleteMemory)) await client.query(memorySql);
          migrated = !schemaIsReady(locked);
        });
      } catch (error) {
        throw productionError('CORE_V0_SCHEMA_MIGRATION_FAILED', 'Core v0 and Memory schemas could not be prepared', { cause: error });
      }
    }

    try {
      snapshot = await inspectSchema(pool);
    } catch (error) {
      throw productionError('CORE_V0_SCHEMA_CHECK_FAILED', 'Core v0 schema readiness could not be verified', { cause: error });
    }
    if (!schemaIsReady(snapshot)) {
      throw schemaNotReady('Core v0 and Memory PostgreSQL schemas are incomplete', snapshot);
    }
    return { coreReady: true, memoryReady: true, migrated, missing: [], incomplete: {} };
  })().catch(error => {
    schemaPreparationCache.delete(pool);
    throw error;
  });
  schemaPreparationCache.set(pool, cached);
  return cached;
}

// Request context is the only trusted identity source for the production
// path. Tenant, subject, actor and correlation must all come from the
// authenticated request; a partially filled context must fail closed here
// rather than reach Core or Memory with a borrowed identity.
function requireRequestContext(rawContext) {
  const tenantId = String(rawContext?.tenantId || '').trim();
  const subjectUserId = String(rawContext?.subjectUserId || '').trim();
  const actorType = String(rawContext?.actorType || '').trim();
  const actorId = String(rawContext?.actorId || '').trim();
  const correlationId = String(rawContext?.correlationId || '').trim();
  if (!tenantId || !subjectUserId || !actorType || !actorId || !correlationId) {
    throw productionError('CORE_V0_CONTEXT_REQUIRED', 'Core v0 request context requires tenant, subject, actor, and correlation identity', { status: 400, retryable: false });
  }
  return { ...rawContext, tenantId, subjectUserId, actorType, actorId, correlationId };
}

// Construction reads legacy compatibility rows from App Runtime state, so the
// state must be the request-scoped one. Falling back to a global load here
// would silently attach another subject's session metadata to this request.
function requireRequestScopedState(baseState) {
  if (!baseState || typeof baseState !== 'object' || Array.isArray(baseState)) {
    throw new TypeError('Core v0 production construction requires request-scoped application state');
  }
  return baseState;
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
  extractor = null,
  auditor = null,
  moduleOptions = {},
  schemaOptions = {}
} = {}) {
  const context = requireRequestContext(rawContext);
  const pool = providedPool || await getPool();
  const schema = await prepareCoreV0ProductionSchema(pool, schemaOptions);
  const state = requireRequestScopedState(baseState);
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

  // R-005 memory pipeline: one flag gates projection and extraction together,
  // and the flag reaches the Module as a construction option, never via the
  // environment inside routes.
  const memoryPipelineEnabled = isTruthy(process.env.CORE_V0_MEMORY_PIPELINE_ENABLED);
  // R-007c semantic retrieval: hybrid retrieval plus an embedding gateway,
  // gated by their own env switches and skipped on mock providers.
  const hybridRetrieval = isTruthy(process.env.MEMORY_HYBRID_RETRIEVAL) && provider !== 'mock';
  const embeddingModel = process.env.MEMORY_EMBEDDING_MODEL || 'bge-m3';
  const embeddingGateway = hybridRetrieval
    ? createOllamaEmbeddingGateway({
      url: process.env.MEMORY_EMBEDDING_URL || 'http://127.0.0.1:11434/api/embeddings',
      model: embeddingModel
    })
    : null;
  const effectiveModuleOptions = {
    ...moduleOptions,
    projectionEnabled: memoryPipelineEnabled,
    featureFlags: { hybridRetrieval: Boolean(hybridRetrieval && embeddingGateway), conflictLatestWins: isTruthy(process.env.MEMORY_CONFLICT_LATEST_WINS) },
    embeddingGateway,
    embeddingTimeoutMs: Number(process.env.MEMORY_MODULE_EMBEDDING_TIMEOUT_MS) || 2000,
    // R-011 precision floor for the vector leg of hybrid retrieval. The
    // calibrated bge-m3 noise floor is 0.55 (unrelated query pairs max out at
    // 0.546); 0 keeps legacy behavior when unset.
    vectorMinScore: parseScoreThreshold(process.env.MEMORY_VECTOR_MIN_SCORE, 0.55),
    // R-012c lexical relative floor: long-tail bigram coincidences below 30%
    // of the top BM25 score are dropped before fusion (phase3b showed the
    // lexical channel saturating the fused ranking at depth).
    lexicalFloorRatio: parseScoreThreshold(process.env.MEMORY_LEXICAL_FLOOR_RATIO, 0.5),
    // R-015: lexical fallback suppression when the embedding channel is
    // healthy but silent (default off).
    suppressLexicalFallback: isTruthy(process.env.MEMORY_LEXICAL_SUPPRESS),
    // R-012c decay re-weight: flag-gated OFF by default. 3b measured ranking
    // as depth-stable (needle hit@1=100% at 2000), so decay only becomes
    // valuable once per-memory access tracking exists.
    decay: { enabled: isTruthy(process.env.MEMORY_DECAY_REWEIGHT), halfLifeDays: 14, weight: 0.3 }
  };
  const memoryPort = createPostgresMemoryPort({ repository, context, retryAttempts, moduleOptions: effectiveModuleOptions });
  // Extraction injection point: an explicit extractor wins; production falls
  // back to the model-backed extractor and skips silently on mock providers.
  // R-014 finding: extractor and auditor are deterministic infrastructure
  // calls - route them through the provider's raw mode (no companion
  // persona, temperature 0). The persona-wrapped temp-0.7 generate made
  // in-pipeline auditor verdicts disagree with the same prompt run bare.
  const infrastructureModel = provider === 'mock' ? null : { generate: ({ message }) => model.generate({ message, raw: true }) };
  const effectiveExtractor = extractor || (infrastructureModel ? createModelExtractor(infrastructureModel, { contextTurns: Number(process.env.MEMORY_EXTRACT_CONTEXT_TURNS) || 0 }) : null);
  // R-007a AUDN injection point: same pattern. Null auditor = ADD-only legacy
  // behavior (flag parity preserved for existing tests and the proof).
  const effectiveAuditor = auditor || (infrastructureModel ? createModelAuditor(infrastructureModel) : null);
  // R-013c: the few-shot extractor needs well over 2s on DeepSeek; a starved
// budget made one slow event time out its whole batch and cascade (dedup
// failures were downstream symptoms). The drain is async - latency here does
// not touch the user-facing turn.
const extractBudgetMs = Number(process.env.CORE_V0_MEMORY_EXTRACT_BUDGET_MS) || 30_000;
  const drainExtraction = memoryPipelineEnabled
    ? createMemoryExtractionDrain({ pool, repository, extractor: effectiveExtractor, auditor: effectiveAuditor, embeddingGateway, embeddingModel, context, moduleOptions: effectiveModuleOptions, timeBudgetMs: extractBudgetMs })
    : null;
  const service = createCoreV0TurnService({
    state: store.state,
    store,
    context,
    memoryPort,
    modelGateway,
    enabled: true
  });

  // R-006 deletion propagation: Memory forget first, Core deletion second.
  // The safe partial-failure direction is remembering less, never more
  // (ADR-006-02); the turn admission always survives its message
  // (ADR-006-03). A Memory failure surfaces before the Core deletion runs.
  const deleteApplicationMessage = async ({ sessionId, messageId } = {}) => {
    const stated = store.deleteApplicationMessage({ sessionId, messageId });
    let fanOut = null;
    if (stated.eventId) {
      const rows = await pool.query(
        'SELECT id, resource_revision FROM raw_events WHERE event_id=$1 AND tenant_id=$2 AND user_id=$3 LIMIT 1',
        [stated.eventId, context.tenantId, context.subjectUserId]
      );
      const rawRow = rows.rows[0];
      if (rawRow) {
        const memoryState = await repository.load(context);
        const memory = createMemoryModule(memoryState, () => repository.save(context, memoryState), effectiveModuleOptions);
        try {
          await memory.forgetSourceEvent(context, rawRow.id, {
            resourceRevision: Number(rawRow.resource_revision) || 1
          });
          fanOut = { forgotten: true };
        } catch (error) {
          if (error?.code === 'SOURCE_EVENT_NOT_FOUND') {
            fanOut = { forgotten: false, reason: 'source_event_not_found' };
          } else {
            throw new CoreV0Error('MEMORY_FORGET_FAILED', 'Memory forget failed before Core deletion', {
              status: 503,
              retryable: true,
              cause: error
            });
          }
        }
      }
    }
    await store.persist();
    return { deleted: stated.deleted, eventId: stated.eventId, fanOut };
  };

  return {
    pool,
    schema,
    context,
    state: store.state,
    store,
    repository,
    memoryPort,
    memoryPipelineEnabled,
    drainExtraction,
    deleteApplicationMessage,
    model: modelInfo(model),
    modelGateway,
    service
  };
}

// Legacy and Core messages are merged across two sources, so ordering is
// applied after the merge rather than trusted from either one.
const compareMessageOrder = (left, right) => {
  const byTime = String(left?.createdAt || '').localeCompare(String(right?.createdAt || ''));
  return byTime !== 0 ? byTime : String(left?.id || '').localeCompare(String(right?.id || ''));
};

export async function createCoreV0ProductionMessageView({
  pool: providedPool = null,
  getPool = getApplicationPostgresPool,
  context: rawContext,
  baseState = null,
  limit = CORE_V0_SESSION_MESSAGE_LIMIT,
  schemaOptions = {}
} = {}) {
  const context = requireRequestContext(rawContext);
  const pool = providedPool || await getPool();
  const schema = await prepareCoreV0ProductionSchema(pool, schemaOptions);
  const state = requireRequestScopedState(baseState);

  // Legacy messages still live in App Runtime state and stay visible for
  // read parity. Core-owned rows are read through the bounded query and are
  // never copied back into that JSON state.
  const legacyMessages = (sessionId, channel) => {
    const stored = Array.isArray(state?.messages?.[sessionId]) ? state.messages[sessionId] : [];
    const legacy = stored.filter(message => !message?.coreV0);
    return channel ? legacy.filter(message => (message.channel || CORE_V0_DEFAULT_CHANNEL) === channel) : legacy;
  };

  const listMessages = async (sessionId, { channel = '' } = {}) => {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) return [];
    const scopedChannel = channel ? String(channel) : null;
    const coreMessages = await loadCoreV0SessionMessages(pool, context, {
      sessionId: normalizedSessionId,
      channel: scopedChannel,
      limit
    });
    const merged = [...legacyMessages(normalizedSessionId, scopedChannel), ...coreMessages]
      .sort(compareMessageOrder);
    const bounded = merged.length > limit ? merged.slice(-limit) : merged;
    return structuredClone(bounded);
  };

  const listChannels = async sessionId => {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) return [];
    const counts = new Map();
    for (const message of legacyMessages(normalizedSessionId, null)) {
      const name = message.channel || CORE_V0_DEFAULT_CHANNEL;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    for (const entry of await countCoreV0SessionChannels(pool, context, { sessionId: normalizedSessionId })) {
      counts.set(entry.name, (counts.get(entry.name) || 0) + entry.count);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => left.name.localeCompare(right.name));
  };

  return { pool, schema, context, state, listMessages, listChannels };
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
