import pg from 'pg';
import { resolveDbSsl } from '../server/db-ssl.js';
import { createCoreV0AdmissionGate, createCoreV0RepairRecorder, createPostgresCoreV0Store, createPostgresMemoryPort } from '../server/core-v0-postgres.js';
import { createCoreV0TurnService } from '../server/core-v0.js';
import { createMemoryModulePostgresRepository } from '../server/memory-module-postgres.js';

const { Pool } = pg;
const workerName = String(process.env.CORE_V0_LIVE_WORKER || 'worker').trim();
const schema = String(process.env.CORE_V0_LIVE_SCHEMA || '').trim();
const gateId = String(process.env.CORE_V0_LIVE_GATE_ID || '').trim();
const databaseUrl = String(process.env.DATABASE_URL || '');
const context = {
  tenantId: 'live-tenant',
  subjectUserId: 'live-user',
  actorType: 'user',
  actorId: 'live-user',
  callerAgentId: 'cochpia-live-acceptance'
};
const sessionId = 'live-session';
const message = 'live acceptance synthetic message';
const idempotencyKey = 'live-postgres-cas-key';

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function assertWorkerConfiguration() {
  if (String(process.env.CORE_V0_LIVE_ACCEPTANCE || '').toLowerCase() !== 'true') throw new Error('CORE_V0_LIVE_ACCEPTANCE_REQUIRED');
  if (String(process.env.CORE_V0_LIVE_ENV || '').toLowerCase() !== 'isolated') throw new Error('CORE_V0_LIVE_ENV_ISOLATED_REQUIRED');
  if (!/^core_v0_live_[A-Za-z0-9_]+$/.test(schema)) throw new Error('CORE_V0_LIVE_SCHEMA_INVALID');
  if (!/^core-v0-live-gate-[A-Za-z0-9_-]+$/.test(gateId)) throw new Error('CORE_V0_LIVE_GATE_ID_INVALID');
  if (!databaseUrl.trim()) throw new Error('DATABASE_URL_REQUIRED');
  try {
    const parsed = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL_INVALID');
  } catch (error) {
    if (error?.message === 'DATABASE_URL_INVALID') throw error;
    throw new Error('DATABASE_URL_INVALID');
  }
}

function createScopedPool(rawPool) {
  return {
    async connect() {
      const client = await rawPool.connect();
      try {
        await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
        return client;
      } catch (error) {
        client.release();
        throw error;
      }
    },
    async query(sql, values = []) {
      const client = await this.connect();
      try { return await client.query(sql, values); }
      finally { client.release(); }
    }
  };
}

function baseState() {
  return {
    sessions: [{ id: sessionId, title: 'live acceptance', summary: '', persona: '', atmosphere: '', companionIntent: 'listen' }],
    messages: { [sessionId]: [] },
    personality: { version: 1, summary: 'live acceptance', traits: [] },
    profile: { name: 'Cochpia', gender: 'none', age: null }
  };
}

function makeTurn() {
  const suffix = workerName.replace(/[^A-Za-z0-9_-]/g, '_');
  const turnId = `turn:live-${suffix}`;
  const assistantMessageId = `assistant:live-${suffix}`;
  return {
    turnId,
    tenantId: context.tenantId,
    subjectUserId: context.subjectUserId,
    applicationSessionId: sessionId,
    idempotencyKey,
    fingerprint: JSON.stringify({ sessionId, message, channel: 'default' }),
    message,
    channel: 'default',
    bindingKey: `${context.tenantId}:${context.subjectUserId}:${sessionId}`,
    memorySessionId: null,
    applicationMessageId: `message:live-${suffix}`,
    assistantMessageId,
    eventId: `event:live-${suffix}`,
    sourceRevision: '1',
    sequenceNo: 1,
    commitId: `assistant:${assistantMessageId}`,
    admissionReceiptId: `admission:${turnId}`,
    pendingReceiptId: null,
    status: 'committed',
    memoryStatus: 'pending',
    memoryAnswerability: 'not_found',
    rawEventReceipt: null,
    generatedContent: 'live acceptance synthetic response',
    result: {
      status: 'committed',
      turnId,
      applicationMessageId: `message:live-${suffix}`,
      assistantMessageId,
      memoryStatus: 'available',
      receiptId: `receipt:assistant:${assistantMessageId}`
    },
    failure: null,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:01.000Z',
    committedAt: '2026-09-05T00:00:01.000Z'
  };
}

function serializeError(error) {
  return {
    code: String(error?.code || error?.name || 'LIVE_WORKER_ERROR'),
    status: Number.isFinite(Number(error?.status)) ? Number(error.status) : 500,
    retryable: Boolean(error?.retryable),
    unknown: Boolean(error?.unknown || error?.unknownOutcome)
  };
}

let rawPool;
let scopedPool;
let store;
let recorder;
let gate;
let schemaInfo;
let memoryRepository;
let memoryPort;
let shuttingDown = false;

async function initialize() {
  if (store) return { status: 'ready', worker: workerName };
  assertWorkerConfiguration();
  rawPool = new Pool({
    connectionString: databaseUrl,
    ssl: resolveDbSsl(),
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 10000),
    statement_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 15000),
    query_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 15000),
    max: 2
  });
  rawPool.on('error', () => {});
  scopedPool = createScopedPool(rawPool);
  await scopedPool.query('SELECT 1');
  store = await createPostgresCoreV0Store({ pool: scopedPool, context, baseState: baseState() });
  const namespace = await scopedPool.query('SELECT current_schema() AS current_schema, current_schemas(false) AS search_path');
  const rawSearchPath = namespace.rows[0]?.search_path;
  const searchPath = Array.isArray(rawSearchPath)
    ? rawSearchPath
    : String(rawSearchPath || '')
      .replace(/^\{|\}$/g, '')
      .split(',')
      .map(item => item.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  schemaInfo = {
    currentSchema: namespace.rows[0]?.current_schema || null,
    searchPath
  };
  memoryRepository = createMemoryModulePostgresRepository(scopedPool);
  memoryPort = createPostgresMemoryPort({ repository: memoryRepository, context, retryAttempts: 0 });
  recorder = createCoreV0RepairRecorder({ pool: scopedPool, operatorId: `live-${workerName}` });
  gate = createCoreV0AdmissionGate({
    pool: scopedPool,
    gateId,
    drainTimeoutMs: 0,
    pollIntervalMs: 2,
    crashRecorder: recorder,
    operatorId: `live-${workerName}`
  });
  return { status: 'ready', worker: workerName, schemaInfo };
}

async function replay({ changed = false } = {}) {
  await initialize();
  await store.load();
  const service = createCoreV0TurnService({
    state: store.state,
    store,
    context,
    memoryPort: {
      async ensureSessionBinding() { throw new Error('LIVE_REPLAY_EXTERNAL_CALL'); },
      async appendRawEvent() { throw new Error('LIVE_REPLAY_EXTERNAL_CALL'); },
      async retrieveContext() { throw new Error('LIVE_REPLAY_EXTERNAL_CALL'); }
    },
    modelGateway: { generate: async () => { throw new Error('LIVE_REPLAY_MODEL_CALL'); } }
  });
  try {
    const result = await service.handleTurn({
      body: { sessionId, message: changed ? `${message} changed` : message, channel: 'default' },
      headerIdempotencyKey: idempotencyKey
    });
    return { status: result.status, replay: result.replay === true, turnId: result.turnId || null };
  } catch (error) {
    if (changed) return { status: 'rejected', code: String(error?.code || 'LIVE_REPLAY_ERROR') };
    throw error;
  }
}

async function handle(command, payload = {}) {
  if (command === 'init') return initialize();
  if (command === 'persist') {
    await initialize();
    if (store.core.turnAdmissions.length) throw new Error('LIVE_WORKER_ALREADY_PERSISTED');
    const turn = makeTurn();
    store.core.turnAdmissions.push(turn);
    store.core.memorySessionBindings.push({
      bindingId: `binding:live-${workerName}`,
      bindingKey: turn.bindingKey,
      tenantId: context.tenantId,
      subjectUserId: context.subjectUserId,
      applicationSessionId: sessionId,
      memorySessionId: turn.memorySessionId,
      memoryContractVersion: 'v1',
      status: 'completed',
      receipt: { status: 'completed', memorySessionId: turn.memorySessionId },
      lastErrorCode: null,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt
    });
    store.core.assistantCommits.push({
      commitId: turn.commitId,
      turnId: turn.turnId,
      tenantId: context.tenantId,
      subjectUserId: context.subjectUserId,
      applicationSessionId: sessionId,
      assistantMessageId: turn.assistantMessageId,
      status: 'completed',
      content: turn.generatedContent,
      receiptId: turn.result.receiptId,
      createdAt: turn.createdAt,
      completedAt: turn.committedAt
    });
    store.state.messages[sessionId].push(
      {
        id: turn.applicationMessageId,
        role: 'user',
        content: turn.message,
        channel: turn.channel,
        createdAt: turn.createdAt,
        visibleAt: turn.createdAt,
        coreV0: { turnId: turn.turnId, eventId: turn.eventId, sourceRevision: turn.sourceRevision, status: 'admitted' }
      },
      {
        id: turn.assistantMessageId,
        role: 'assistant',
        content: turn.generatedContent,
        channel: turn.channel,
        createdAt: turn.committedAt,
        visibleAt: turn.committedAt,
        coreV0: { turnId: turn.turnId, commitId: turn.commitId, status: 'committed' }
      }
    );
    store.core.sequence = Number(store.core.persistenceBaseSequence || 0) + 1;
    const saved = await store.persist();
    return { status: saved.status, sequence: saved.sequence, turnId: turn.turnId };
  }
  if (command === 'memory-write') {
    await initialize();
    await store.load();
    const turn = store.findTurn(payload.turnId);
    if (!turn) throw Object.assign(new Error('LIVE_TURN_NOT_FOUND'), { code: 'LIVE_TURN_NOT_FOUND', status: 404 });
    const binding = await memoryPort.ensureSessionBinding({ bindingKey: turn.bindingKey });
    if (binding?.status !== 'completed' || !binding.memorySessionId) {
      throw Object.assign(new Error('LIVE_MEMORY_BINDING_NOT_COMPLETED'), { code: 'LIVE_MEMORY_BINDING_NOT_COMPLETED', status: 503, retryable: true, unknown: true });
    }
    const event = await memoryPort.appendRawEvent({
      memorySessionId: binding.memorySessionId,
      event: {
        eventId: turn.eventId,
        sourceRevision: turn.sourceRevision,
        turnId: turn.turnId,
        applicationSessionId: turn.applicationSessionId,
        applicationMessageId: turn.applicationMessageId,
        content: turn.message,
        eventRole: 'user',
        contentType: 'plain_text',
        occurredAt: turn.createdAt,
        metadata: { producer: 'companion-core-live-acceptance', correlation_id: turn.turnId, turn_id: turn.turnId }
      }
    });
    if (event?.status !== 'completed') {
      throw Object.assign(new Error('LIVE_MEMORY_EVENT_NOT_COMPLETED'), { code: 'LIVE_MEMORY_EVENT_NOT_COMPLETED', status: 503, retryable: true, unknown: true });
    }
    const coreBinding = store.findBindingByApplicationSession({
      tenantId: context.tenantId,
      subjectUserId: context.subjectUserId,
      applicationSessionId: turn.applicationSessionId
    });
    if (!coreBinding) throw Object.assign(new Error('LIVE_CORE_BINDING_NOT_FOUND'), { code: 'LIVE_CORE_BINDING_NOT_FOUND', status: 500 });
    coreBinding.memorySessionId = binding.memorySessionId;
    coreBinding.status = 'completed';
    coreBinding.receipt = binding.receipt;
    coreBinding.updatedAt = new Date().toISOString();
    turn.memorySessionId = binding.memorySessionId;
    turn.rawEventReceipt = event.receipt;
    turn.memoryStatus = 'available';
    turn.updatedAt = new Date().toISOString();
    await store.persist();
    return {
      status: 'completed',
      memorySessionId: binding.memorySessionId,
      rawEventId: event.receipt?.rawEventId || null,
      eventId: turn.eventId,
      sourceRevision: turn.sourceRevision
    };
  }
  if (command === 'replay') return replay({ changed: false });
  if (command === 'replay-conflict') return replay({ changed: true });
  if (command === 'gate-enter') {
    await initialize();
    const lease = await gate.enter({
      key: payload.key,
      turnId: payload.turnId,
      tenantId: context.tenantId,
      subjectUserId: context.subjectUserId,
      leaseOwner: `live-${workerName}`
    });
    return {
      status: lease.status,
      leaseId: lease.leaseId,
      closeEpoch: lease.closeEpoch,
      turnId: lease.turnId,
      duplicate: Boolean(lease.duplicate)
    };
  }
  if (command === 'gate-release') {
    await initialize();
    return gate.release(payload.leaseId);
  }
  if (command === 'gate-disable') {
    await initialize();
    return gate.disable({ timeoutMs: payload.timeoutMs });
  }
  if (command === 'gate-snapshot') {
    await initialize();
    return gate.snapshot();
  }
  if (command === 'shutdown') {
    shuttingDown = true;
    if (rawPool) await rawPool.end();
    return { status: 'stopped', worker: workerName };
  }
  throw new Error('LIVE_WORKER_COMMAND_UNKNOWN');
}

function send(message) {
  if (process.connected && process.send) process.send(message);
}

let queue = Promise.resolve();
process.on('message', message => {
  queue = queue.then(async () => {
    if (!message?.id || shuttingDown && message.command !== 'shutdown') return;
    try {
      const result = await handle(message.command, message.payload || {});
      send({ id: message.id, ok: true, result });
      if (message.command === 'shutdown') setImmediate(() => process.exit(0));
    } catch (error) {
      send({ id: message.id, ok: false, error: serializeError(error) });
    }
  });
});
