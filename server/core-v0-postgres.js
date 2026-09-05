import { randomUUID } from 'node:crypto';
import { CoreV0Error, createCoreV0Store, ensureCoreV0State } from './core-v0.js';
import { memoryBundleToRecalled } from './chat-memory.js';
import { createMemoryModule } from './memory-module.js';

export const CORE_V0_POSTGRES_SCHEMA_VERSION = 1;
export const CORE_V0_GATE_ID = 'core-v0';

const coreStatuses = new Set(['admission_pending', 'pending', 'admitted', 'context_ready', 'generation_succeeded', 'commit_pending', 'committed', 'failed']);
const bindingStatuses = new Set(['pending', 'completed', 'failed']);
const commitStatuses = new Set(['pending', 'completed', 'failed']);
const repairStatuses = new Set(['pending', 'processing', 'completed', 'failed', 'dead_letter']);
const crashStatuses = new Set(['observed', 'reconciled', 'unresolved']);
const unknownPersistenceCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', '57P01', '08000', '08003', '08006', '08007', '08001', '08004', 'MEMORY_STORAGE_UNKNOWN']);

const clone = value => structuredClone(value);
const asJson = (value, fallback = null) => {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

function requireContext(context = {}) {
  const tenantId = String(context.tenantId || '').trim();
  const subjectUserId = String(context.subjectUserId || '').trim();
  if (!tenantId || !subjectUserId) throw new TypeError('Core v0 PostgreSQL context requires tenantId and subjectUserId');
  return { ...context, tenantId, subjectUserId };
}

function coreError(code, message, options = {}) {
  return new CoreV0Error(code, message, options);
}

function mapTurn(row) {
  return {
    turnId: row.turn_id,
    tenantId: row.tenant_id,
    subjectUserId: row.subject_user_id,
    applicationSessionId: row.application_session_id,
    idempotencyKey: row.idempotency_key,
    fingerprint: row.fingerprint,
    message: row.message,
    channel: row.channel,
    bindingKey: row.binding_key,
    memorySessionId: row.memory_session_id,
    applicationMessageId: row.application_message_id,
    assistantMessageId: row.assistant_message_id,
    eventId: row.event_id,
    sourceRevision: String(row.source_revision),
    sequenceNo: Number(row.sequence_no),
    commitId: row.commit_id,
    admissionReceiptId: row.admission_receipt_id,
    pendingReceiptId: row.pending_receipt_id,
    status: row.status,
    memoryStatus: row.memory_status,
    memoryAnswerability: row.memory_answerability,
    rawEventReceipt: asJson(row.raw_event_receipt),
    generatedContent: row.generated_content,
    result: asJson(row.result),
    failure: asJson(row.failure),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    committedAt: row.committed_at
  };
}

function mapBinding(row) {
  return {
    bindingId: row.binding_id,
    bindingKey: row.binding_key,
    tenantId: row.tenant_id,
    subjectUserId: row.subject_user_id,
    applicationSessionId: row.application_session_id,
    memorySessionId: row.memory_session_id,
    memoryContractVersion: row.memory_contract_version,
    status: row.status,
    receipt: asJson(row.receipt),
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapCommit(row) {
  return {
    commitId: row.commit_id,
    turnId: row.turn_id,
    tenantId: row.tenant_id,
    subjectUserId: row.subject_user_id,
    applicationSessionId: row.application_session_id,
    assistantMessageId: row.assistant_message_id,
    status: row.status,
    content: row.content,
    receiptId: row.receipt_id,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

function mapMessage(row) {
  return {
    id: row.application_message_id,
    role: row.role,
    content: row.content,
    channel: row.channel,
    createdAt: row.created_at,
    visibleAt: row.visible_at,
    coreV0: asJson(row.core_v0, {})
  };
}

function isUniqueViolation(error) {
  return error?.code === '23505' || error?.code === 'CORE_IDENTITY_CONFLICT';
}

function isStorageConflict(error) {
  return error?.code === 'MEMORY_STORAGE_CONFLICT'
    || error?.code === 'CORE_STORAGE_CONFLICT'
    || error?.code === '40001'
    || error?.code === '40P01';
}

function isUnknownPersistence(error) {
  return Boolean(error?.unknown || error?.unknownOutcome)
    || unknownPersistenceCodes.has(String(error?.code || '').toUpperCase())
    || (Number(error?.status) >= 500 && String(error?.code || '').includes('STORAGE'));
}

function conflictError(message = 'Core v0 subject changed while the operation was in flight', cause) {
  return coreError('CORE_STORAGE_CONFLICT', message, { status: 409, retryable: true, unknown: false, cause });
}

function assertSubject(record, context, label) {
  if (!record || record.tenantId !== context.tenantId || record.subjectUserId !== context.subjectUserId) {
    throw coreError('CORE_SUBJECT_SCOPE_VIOLATION', `${label} is outside the requested subject scope`, { status: 403 });
  }
}

function assertUnique(records, key, label) {
  const seen = new Set();
  for (const record of records) {
    const value = key(record);
    if (seen.has(value)) throw conflictError(`${label} identity is duplicated in the loaded subject snapshot`);
    seen.add(value);
  }
}

function validateCoreSnapshot(state, context) {
  const core = ensureCoreV0State(state);
  const turns = core.turnAdmissions;
  const bindings = core.memorySessionBindings;
  const commits = core.assistantCommits;
  const messages = Object.entries(state.messages || {}).flatMap(([sessionId, items]) => (Array.isArray(items) ? items : [])
    .filter(message => message?.coreV0)
    .map(message => ({ sessionId, message })));
  for (const turn of turns) assertSubject(turn, context, 'turn');
  for (const binding of bindings) {
    assertSubject(binding, context, 'binding');
    if (!bindingStatuses.has(binding.status)) throw coreError('CORE_INVALID_STATUS', 'Invalid Memory binding status', { status: 409 });
  }
  for (const commit of commits) {
    assertSubject(commit, context, 'commit');
    if (!commitStatuses.has(commit.status)) throw coreError('CORE_INVALID_STATUS', 'Invalid assistant commit status', { status: 409 });
  }
  for (const turn of turns) {
    if (!coreStatuses.has(turn.status)) throw coreError('CORE_INVALID_STATUS', 'Invalid turn status', { status: 409 });
    if (!turn.fingerprint || !turn.idempotencyKey || !turn.eventId || !turn.applicationMessageId) throw coreError('CORE_IDENTITY_MISSING', 'Core turn identity fields are required', { status: 409 });
  }
  assertUnique(turns, item => `${item.applicationSessionId}\u0000${item.idempotencyKey}`, 'turn idempotency');
  assertUnique(turns, item => `${item.applicationSessionId}\u0000${item.sourceRevision}`, 'turn source revision');
  assertUnique(turns, item => item.applicationMessageId, 'turn application message');
  assertUnique(turns, item => item.eventId, 'turn event');
  assertUnique(bindings, item => item.applicationSessionId, 'application session binding');
  assertUnique(bindings.filter(item => item.memorySessionId), item => item.memorySessionId, 'Memory session binding');
  assertUnique(commits, item => item.commitId, 'assistant commit');
  assertUnique(commits, item => item.assistantMessageId, 'assistant message commit');
  assertUnique(messages, item => item.message.id, 'application message');
  return { core, turns, bindings, commits, messages };
}

async function ensureCoreV0Schema(pool, sql) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required');
  await pool.query(sql);
}

export async function ensureCoreV0PostgresSchema(pool, { sql } = {}) {
  const schema = sql || (await import('node:fs/promises')).readFile(new URL('./core-v0-schema.sql', import.meta.url), 'utf8');
  return ensureCoreV0Schema(pool, await schema);
}

async function loadCoreRows(pool, context) {
  const client = await pool.connect();
  try {
    const values = [context.tenantId, context.subjectUserId];
    const subject = await client.query('SELECT sequence FROM core_v0_subjects WHERE tenant_id=$1 AND subject_user_id=$2', values);
    const turns = await client.query('SELECT * FROM core_v0_turn_admissions WHERE tenant_id=$1 AND subject_user_id=$2 ORDER BY sequence_no, created_at', values);
    const bindings = await client.query('SELECT * FROM core_v0_memory_session_bindings WHERE tenant_id=$1 AND subject_user_id=$2 ORDER BY created_at', values);
    const commits = await client.query('SELECT * FROM core_v0_assistant_commits WHERE tenant_id=$1 AND subject_user_id=$2 ORDER BY created_at', values);
    const messages = await client.query('SELECT * FROM core_v0_messages WHERE tenant_id=$1 AND subject_user_id=$2 ORDER BY created_at', values);
    const mappedTurns = turns.rows.map(mapTurn);
    return {
      persistenceSequence: Number(subject.rows[0]?.sequence || 0),
      operationSequence: Math.max(0, ...mappedTurns.map(item => Number(item.sequenceNo) || 0)),
      turns: mappedTurns,
      bindings: bindings.rows.map(mapBinding),
      commits: commits.rows.map(mapCommit),
      messages: messages.rows.map(mapMessage)
    };
  } finally {
    client.release();
  }
}

function resetHydratedState(state, baseline, rows) {
  const next = clone(baseline || {});
  next.messages ||= {};
  for (const [sessionId, messages] of Object.entries(next.messages)) {
    next.messages[sessionId] = (Array.isArray(messages) ? messages : []).filter(message => !message?.coreV0);
  }
  const nextCore = {
    schemaVersion: CORE_V0_POSTGRES_SCHEMA_VERSION,
    sequence: rows.operationSequence,
    persistenceBaseSequence: rows.persistenceSequence,
    persistenceRevision: rows.persistenceSequence,
    turnAdmissions: rows.turns,
    memorySessionBindings: rows.bindings,
    assistantCommits: rows.commits
  };
  for (const message of rows.messages) {
    next.messages[message.coreV0?.applicationSessionId || message.coreV0?.sessionId || 'unknown'] ||= [];
    const list = next.messages[message.coreV0?.applicationSessionId || message.coreV0?.sessionId || 'unknown'];
    const index = list.findIndex(item => item.id === message.id);
    if (index >= 0) list[index] = message;
    else list.push(message);
  }
  const currentCore = ensureCoreV0State(state);
  for (const key of Object.keys(state)) {
    if (key !== 'coreV0') delete state[key];
  }
  Object.assign(state, next);
  for (const key of Object.keys(currentCore)) delete currentCore[key];
  Object.assign(currentCore, nextCore);
  state.coreV0 = currentCore;
  return state;
}

function messageSessionId(message) {
  return message?.coreV0?.applicationSessionId || message?.coreV0?.sessionId || null;
}

function rowValuesForTurn(context, turn) {
  return [context.tenantId, context.subjectUserId, turn.turnId, turn.applicationSessionId, turn.idempotencyKey, turn.fingerprint, turn.message, turn.channel, turn.bindingKey, turn.memorySessionId, turn.applicationMessageId, turn.assistantMessageId, turn.eventId, turn.sourceRevision, turn.sequenceNo, turn.commitId, turn.admissionReceiptId, turn.pendingReceiptId, turn.status, turn.memoryStatus || 'pending', turn.memoryAnswerability || null, turn.rawEventReceipt || null, turn.generatedContent || null, turn.result || null, turn.failure || null, turn.createdAt, turn.updatedAt, turn.committedAt || null];
}

function rowValuesForBinding(context, binding) {
  return [context.tenantId, context.subjectUserId, binding.bindingId, binding.bindingKey, binding.applicationSessionId, binding.memorySessionId || null, binding.memoryContractVersion || 'v1', binding.status, binding.receipt || null, binding.lastErrorCode || null, binding.createdAt, binding.updatedAt];
}

function rowValuesForCommit(context, commit) {
  return [context.tenantId, context.subjectUserId, commit.commitId, commit.turnId, commit.applicationSessionId, commit.assistantMessageId, commit.status, commit.content || null, commit.receiptId || null, commit.createdAt, commit.completedAt || null];
}

function rowValuesForMessage(context, message, sessionId) {
  return [context.tenantId, context.subjectUserId, message.id, sessionId, message.role, message.content, message.channel || null, message.createdAt, message.visibleAt || null, { ...(message.coreV0 || {}), applicationSessionId: sessionId }];
}

export async function createPostgresCoreV0Store({ pool, context: rawContext, baseState = {}, ensureSchema = false, schemaSql } = {}) {
  const context = requireContext(rawContext);
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Core v0 PostgreSQL store requires a pool');
  if (ensureSchema) await ensureCoreV0PostgresSchema(pool, { sql: schemaSql });
  const state = clone(baseState || {});
  state.messages ||= {};
  const localStore = createCoreV0Store({ state });

  const load = async () => {
    const rows = await loadCoreRows(pool, context);
    resetHydratedState(state, baseState, rows);
    return store;
  };

  const persist = async () => {
    const snapshot = validateCoreSnapshot(state, context);
    const baseSequence = Number(snapshot.core.persistenceBaseSequence ?? 0);
    const operationSequence = Number(snapshot.core.sequence ?? 0);
    if (!Number.isInteger(baseSequence) || baseSequence < 0 || !Number.isInteger(operationSequence) || operationSequence < 0) {
      throw coreError('CORE_SEQUENCE_INVALID', 'Core subject sequence is invalid', { status: 409 });
    }
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO core_v0_subjects (tenant_id,subject_user_id,sequence) VALUES ($1,$2,0) ON CONFLICT (tenant_id,subject_user_id) DO NOTHING', [context.tenantId, context.subjectUserId]);
      const current = await client.query('SELECT sequence FROM core_v0_subjects WHERE tenant_id=$1 AND subject_user_id=$2 FOR UPDATE', [context.tenantId, context.subjectUserId]);
      const databaseSequence = Number(current.rows[0]?.sequence || 0);
      if (databaseSequence !== baseSequence) throw conflictError('Core v0 subject changed before this snapshot could be saved');

      await client.query('DELETE FROM core_v0_messages WHERE tenant_id=$1 AND subject_user_id=$2', [context.tenantId, context.subjectUserId]);
      await client.query('DELETE FROM core_v0_assistant_commits WHERE tenant_id=$1 AND subject_user_id=$2', [context.tenantId, context.subjectUserId]);
      await client.query('DELETE FROM core_v0_memory_session_bindings WHERE tenant_id=$1 AND subject_user_id=$2', [context.tenantId, context.subjectUserId]);
      await client.query('DELETE FROM core_v0_turn_admissions WHERE tenant_id=$1 AND subject_user_id=$2', [context.tenantId, context.subjectUserId]);

      for (const turn of snapshot.turns) {
        await client.query('INSERT INTO core_v0_turn_admissions (tenant_id,subject_user_id,turn_id,application_session_id,idempotency_key,fingerprint,message,channel,binding_key,memory_session_id,application_message_id,assistant_message_id,event_id,source_revision,sequence_no,commit_id,admission_receipt_id,pending_receipt_id,status,memory_status,memory_answerability,raw_event_receipt,generated_content,result,failure,created_at,updated_at,committed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)', rowValuesForTurn(context, turn));
      }
      for (const binding of snapshot.bindings) {
        await client.query('INSERT INTO core_v0_memory_session_bindings (tenant_id,subject_user_id,binding_id,binding_key,application_session_id,memory_session_id,memory_contract_version,status,receipt,last_error_code,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', rowValuesForBinding(context, binding));
      }
      for (const commit of snapshot.commits) {
        await client.query('INSERT INTO core_v0_assistant_commits (tenant_id,subject_user_id,commit_id,turn_id,application_session_id,assistant_message_id,status,content,receipt_id,created_at,completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', rowValuesForCommit(context, commit));
      }
      for (const entry of snapshot.messages) {
        const sessionId = entry.sessionId || messageSessionId(entry.message);
        if (!sessionId) throw coreError('CORE_MESSAGE_SESSION_MISSING', 'Core application message session is required', { status: 409 });
        await client.query('INSERT INTO core_v0_messages (tenant_id,subject_user_id,application_message_id,application_session_id,role,content,channel,created_at,visible_at,core_v0) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', rowValuesForMessage(context, entry.message, sessionId));
      }
      const persistenceSequence = baseSequence + 1;
      await client.query('UPDATE core_v0_subjects SET sequence=$3, updated_at=now() WHERE tenant_id=$1 AND subject_user_id=$2', [context.tenantId, context.subjectUserId, persistenceSequence]);
      await client.query('COMMIT');
      committed = true;
      snapshot.core.persistenceBaseSequence = persistenceSequence;
      snapshot.core.persistenceRevision = persistenceSequence;
      return { status: 'saved', sequence: persistenceSequence, operationSequence };
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => {});
      if (error instanceof CoreV0Error) throw error;
      if (isUniqueViolation(error)) throw conflictError('Core v0 immutable identity conflicts with an existing row', error);
      throw error;
    } finally {
      client.release();
    }
  };

  let store;
  store = {
    ...localStore,
    state,
    core: state.coreV0,
    load,
    persist,
    schemaVersion: CORE_V0_POSTGRES_SCHEMA_VERSION
  };
  await load();
  return store;
}

function contextWithSession(context, memorySessionId) {
  return { ...context, sessionId: memorySessionId };
}

function pendingMemory(code) {
  return { status: 'pending', retryable: true, unknown: true, code };
}

function memoryMutationError(error, fallbackCode) {
  if (error instanceof CoreV0Error) return error;
  if (isStorageConflict(error)) return coreError('MEMORY_STORAGE_CONFLICT', 'Memory subject changed during the original operation', { status: 409, retryable: true, cause: error });
  if (isUnknownPersistence(error)) return coreError(fallbackCode, 'Memory operation outcome is unknown', { status: 503, retryable: true, unknown: true, cause: error });
  return error;
}

export function createPostgresMemoryPort({ repository, context: rawContext, retryAttempts = 2, moduleOptions = {} } = {}) {
  const context = requireContext(rawContext);
  if (!repository || typeof repository.load !== 'function' || typeof repository.save !== 'function') throw new TypeError('PostgreSQL MemoryPort requires repository.load and repository.save');
  const attempts = Math.max(0, Math.min(5, Number(retryAttempts) || 0));

  const runMutation = async (operation, invoke) => {
    let lastConflict = null;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      try {
        const state = await repository.load(context);
        const memory = createMemoryModule(state, () => repository.save(context, state), moduleOptions);
        return await invoke(memory, state, attempt);
      } catch (error) {
        if (isStorageConflict(error)) {
          lastConflict = error;
          if (attempt < attempts) continue;
          throw memoryMutationError(error, `MEMORY_${operation.toUpperCase()}_FAILED`);
        }
        const normalized = memoryMutationError(error, `MEMORY_${operation.toUpperCase()}_FAILED`);
        if (normalized?.unknown) return pendingMemory(normalized.code);
        throw normalized;
      }
    }
    throw memoryMutationError(lastConflict, `MEMORY_${operation.toUpperCase()}_FAILED`);
  };

  const runRead = async (operation, invoke) => {
    try {
      return await invoke();
    } catch (error) {
      const normalized = memoryMutationError(error, `MEMORY_${operation.toUpperCase()}_FAILED`);
      if (normalized?.unknown) return pendingMemory(normalized.code);
      throw normalized;
    }
  };

  const getSessionBinding = ({ bindingKey }) => runRead('session_binding_lookup', async () => {
    const state = await repository.load(context);
    const key = `core-v0:binding:${bindingKey}`;
    const record = (state.idempotencyRecords || []).find(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId && (item.mutationNamespace || item.namespace || 'event') === 'session.create' && item.key === key);
    const memorySessionId = record?.response?.id || record?.response?.session?.id;
    if (!memorySessionId) return { status: 'not_found', authoritative: true, bindingKey };
    return { status: 'completed', memorySessionId, receipt: { status: 'completed', memorySessionId } };
  });

  const getRawEventReceipt = ({ eventId, sourceRevision }) => runRead('raw_event_lookup', async () => {
    const state = await repository.load(context);
    const raw = (state.rawEvents || []).find(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.eventId === eventId && String(item.sourceRevision) === String(sourceRevision));
    if (raw) return { status: 'completed', receipt: { status: 'completed', eventId, sourceRevision, rawEventId: raw.id, result: 'accepted_stored' } };
    const record = (state.idempotencyRecords || []).find(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId && (item.mutationNamespace || item.namespace || 'event') === 'event' && item.key === `${eventId}:${sourceRevision}`);
    if (record?.result === 'accepted_no_store' || record?.result === 'accepted_stored') return { status: 'completed', receipt: { status: 'completed', eventId, sourceRevision, rawEventId: record.resourceId || null, result: record.result } };
    return { status: 'not_found', authoritative: true, eventId, sourceRevision };
  });

  return {
    async ensureSessionBinding({ bindingKey }) {
      const result = await runMutation('session_binding', memory => memory.createSession(context, {
        idempotency_key: `core-v0:binding:${bindingKey}`,
        callerAgentId: context.callerAgentId || 'cochpia'
      }));
      if (result?.status === 'pending') return result;
      const session = result?.session || result;
      if (!session?.id) throw coreError('MEMORY_SESSION_BINDING_FAILED', 'Memory session receipt did not contain a session id', { status: 503, unknown: true });
      return { status: 'completed', memorySessionId: session.id, receipt: { status: 'completed', memorySessionId: session.id } };
    },

    getSessionBinding,
    reconcileSessionBinding: getSessionBinding,

    async appendRawEvent({ event, memorySessionId }) {
      const result = await runMutation('raw_event', memory => memory.recordEvent(contextWithSession(context, memorySessionId), {
        ...event,
        sessionId: memorySessionId,
        contentType: event.contentType || 'plain_text',
        eventRole: event.eventRole || 'user',
        isStreamFinal: true
      }));
      if (result?.status === 'pending') return result;
      if (result?.result === 'accepted_no_store') return { status: 'failed', code: 'MEMORY_CONTENT_NOT_ADMITTED', httpStatus: 422, retryable: false, unknown: false, receipt: { status: 'not_stored', eventId: event.eventId, sourceRevision: event.sourceRevision, result: result.result } };
      return { status: 'completed', receipt: { status: 'completed', eventId: event.eventId, sourceRevision: event.sourceRevision, rawEventId: result?.rawEventId || null, result: result?.result || null } };
    },

    getRawEventReceipt,
    reconcileRawEvent: getRawEventReceipt,

    async retrieveContext({ query, memorySessionId, tokenBudget = 1800 }) {
      return runRead('retrieve', async () => {
        const readContext = contextWithSession(context, memorySessionId);
        const state = typeof repository.loadContextBundleState === 'function'
          ? await repository.loadContextBundleState(readContext, { purpose: 'answer_user_query', query: String(query || '').slice(0, 1000) })
          : await repository.load(readContext);
        const memory = createMemoryModule(state, async () => {} , moduleOptions);
        const bundle = await memory.contextBundleAsync(readContext, { query: String(query || '').slice(0, 1000), purpose: 'answer_user_query', tokenBudget });
        return { status: 'available', bundle, recalled: memoryBundleToRecalled(bundle), answerability: bundle.answerability || 'not_found' };
      });
    }
  };
}

function encodeIdentity(value) {
  return String(value ?? 'none').replace(/[^A-Za-z0-9_.:-]/g, '_');
}

const transitionMap = {
  pending: new Set(['processing', 'failed', 'dead_letter']),
  processing: new Set(['completed', 'failed', 'dead_letter']),
  failed: new Set(['processing', 'dead_letter']),
  completed: new Set(),
  dead_letter: new Set()
};

export function createCoreV0RepairRecorder({ pool, operatorId = 'system', now = () => new Date().toISOString() } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Repair recorder requires a PostgreSQL pool');
  const safeOperatorId = encodeIdentity(operatorId);
  const record = async ({ repairAttemptId, gateId = null, tenantId = null, subjectUserId = null, turnId = null, leaseId = null, operation, adapter, status = 'pending', errorCode = null, attempt = 1, closeEpoch = null, leaseOwner = null, externalReceiptStatus = null } = {}) => {
    if (!operation || !adapter || !repairStatuses.has(status) || !Number.isInteger(Number(attempt)) || Number(attempt) < 1) throw new TypeError('Repair record requires operation, adapter, valid status and attempt');
    const identity = turnId || leaseId || gateId || 'none';
    const id = repairAttemptId || `repair:${encodeIdentity(gateId)}:${encodeIdentity(identity)}:${encodeIdentity(operation)}:${Number(attempt)}:${encodeIdentity(closeEpoch)}`;
    const timestamp = now();
    const client = await pool.connect();
    try {
      const result = await client.query('INSERT INTO core_v0_repair_attempts (repair_attempt_id,gate_id,tenant_id,subject_user_id,turn_id,lease_id,operation,adapter,status,error_code,attempt,operator_id,close_epoch,lease_owner,external_receipt_status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (repair_attempt_id) DO NOTHING RETURNING repair_attempt_id', [id, gateId, tenantId, subjectUserId, turnId, leaseId, operation, adapter, status, errorCode, Number(attempt), safeOperatorId, closeEpoch, leaseOwner, externalReceiptStatus, timestamp, timestamp]);
      return { status: 'recorded', repairAttemptId: result.rows[0]?.repair_attempt_id || id, duplicate: result.rows.length === 0 };
    } finally {
      client.release();
    }
  };

  const transition = async ({ repairAttemptId, status, errorCode = null, externalReceiptStatus = null } = {}) => {
    if (!repairAttemptId || !repairStatuses.has(status)) throw new TypeError('Repair transition requires a valid id and status');
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT status FROM core_v0_repair_attempts WHERE repair_attempt_id=$1 FOR UPDATE', [repairAttemptId]);
      const previous = current.rows[0]?.status;
      if (!previous) throw coreError('REPAIR_ATTEMPT_NOT_FOUND', 'Repair attempt not found', { status: 404 });
      if (previous !== status && !transitionMap[previous]?.has(status)) throw coreError('REPAIR_TRANSITION_INVALID', 'Repair status transition is not allowed', { status: 409 });
      const result = await client.query('UPDATE core_v0_repair_attempts SET status=$2,error_code=$3,external_receipt_status=$4,updated_at=$5 WHERE repair_attempt_id=$1', [repairAttemptId, status, errorCode, externalReceiptStatus, now()]);
      await client.query('COMMIT');
      committed = true;
      return { status: 'updated', repairAttemptId, previousStatus: previous, updated: result.rowCount !== 0 };
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  const recordCrash = async ({ crashRecordId, gateId = null, tenantId = null, subjectUserId = null, turnId = null, leaseId = null, processId = 'unknown-process', operation, status = 'observed', errorCode = null, closeEpoch = null } = {}) => {
    if (!operation || !crashStatuses.has(status)) throw new TypeError('Crash record requires operation and valid status');
    const id = crashRecordId || `crash:${encodeIdentity(processId)}:${encodeIdentity(turnId)}:${encodeIdentity(operation)}`;
    const client = await pool.connect();
    try {
      const result = await client.query('INSERT INTO core_v0_crash_records (crash_record_id,gate_id,tenant_id,subject_user_id,turn_id,lease_id,process_id,operation,status,error_code,operator_id,close_epoch,observed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (crash_record_id) DO NOTHING RETURNING crash_record_id', [id, gateId, tenantId, subjectUserId, turnId, leaseId, processId, operation, status, errorCode, safeOperatorId, closeEpoch, now()]);
      return { status: 'recorded', crashRecordId: result.rows[0]?.crash_record_id || id, duplicate: result.rows.length === 0 };
    } finally {
      client.release();
    }
  };

  return { record, transition, recordCrash, operatorId: safeOperatorId };
}

export function createCoreV0AdmissionGate({ pool, gateId = CORE_V0_GATE_ID, enabled = true, drainTimeoutMs = 5000, crashRecorder = null, operatorId = 'system', pollIntervalMs = 10, now = () => new Date().toISOString() } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Admission gate requires a PostgreSQL pool');
  const gate = String(gateId || CORE_V0_GATE_ID);
  const configuredTimeout = Math.max(0, Math.min(60_000, Number(drainTimeoutMs) || 0));
  const delayMs = Math.max(1, Math.min(100, Number(pollIntervalMs) || 10));

  const ensureGateRow = client => client.query('INSERT INTO core_v0_admission_gates (gate_id,enabled,close_epoch) VALUES ($1,$2,0) ON CONFLICT (gate_id) DO NOTHING', [gate, Boolean(enabled)]);

  const snapshot = async () => {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT gate_id,enabled,close_epoch FROM core_v0_admission_gates WHERE gate_id=$1', [gate]);
      const active = await client.query("SELECT lease_id,admission_key,tenant_id,subject_user_id,turn_id,close_epoch,lease_owner,acquired_at FROM core_v0_admission_leases WHERE gate_id=$1 AND status='active' ORDER BY acquired_at", [gate]);
      const row = result.rows[0] || { gate_id: gate, enabled: Boolean(enabled), close_epoch: 0 };
      return { gateId: gate, enabled: Boolean(row.enabled), closeEpoch: Number(row.close_epoch || 0), activeLeases: active.rows.map(item => ({ leaseId: item.lease_id, admissionKey: item.admission_key, tenantId: item.tenant_id, subjectUserId: item.subject_user_id, turnId: item.turn_id, closeEpoch: Number(item.close_epoch || 0), leaseOwner: item.lease_owner, acquiredAt: item.acquired_at })) };
    } finally {
      client.release();
    }
  };

  const release = async leaseId => {
    const client = await pool.connect();
    try {
      const result = await client.query("UPDATE core_v0_admission_leases SET status='released',released_at=$3 WHERE gate_id=$1 AND lease_id=$2 AND status='active'", [gate, leaseId, now()]);
      return { status: 'released', leaseId, updated: result.rowCount !== 0 };
    } finally {
      client.release();
    }
  };

  const enter = async ({ key, turnId = null, tenantId = null, subjectUserId = null, leaseOwner = operatorId } = {}) => {
    const admissionKey = String(key || '').trim();
    if (!admissionKey) throw new TypeError('Admission gate enter requires a stable key');
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await ensureGateRow(client);
      const gateResult = await client.query('SELECT gate_id,enabled,close_epoch FROM core_v0_admission_gates WHERE gate_id=$1 FOR UPDATE', [gate]);
      const gateRow = gateResult.rows[0] || { enabled: Boolean(enabled), close_epoch: 0 };
      if (!gateRow.enabled) throw coreError('CORE_ADMISSION_CLOSED', 'Core v0 admission is closed', { status: 503, retryable: true });
      const existing = await client.query("SELECT lease_id,tenant_id,subject_user_id,turn_id,close_epoch,lease_owner,acquired_at FROM core_v0_admission_leases WHERE gate_id=$1 AND admission_key=$2 AND status='active' FOR UPDATE", [gate, admissionKey]);
      const row = existing.rows[0] || null;
      if (row) {
        if ((row.turn_id && turnId && row.turn_id !== turnId)
          || (row.tenant_id && tenantId && row.tenant_id !== tenantId)
          || (row.subject_user_id && subjectUserId && row.subject_user_id !== subjectUserId)) {
          throw coreError('CORE_ADMISSION_KEY_CONFLICT', 'Admission key is already active for a different turn', { status: 409 });
        }
        await client.query('COMMIT');
        committed = true;
        return { status: 'admitted', gateId: gate, leaseId: row.lease_id, admissionKey, turnId: row.turn_id, closeEpoch: Number(row.close_epoch), duplicate: true, release: () => release(row.lease_id) };
      }
      const leaseId = `lease:${randomUUID()}`;
      await client.query('INSERT INTO core_v0_admission_leases (gate_id,lease_id,admission_key,tenant_id,subject_user_id,turn_id,close_epoch,status,lease_owner,acquired_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [gate, leaseId, admissionKey, tenantId, subjectUserId, turnId, Number(gateRow.close_epoch || 0), 'active', leaseOwner, now()]);
      await client.query('COMMIT');
      committed = true;
      return { status: 'admitted', gateId: gate, leaseId, admissionKey, turnId, tenantId, subjectUserId, closeEpoch: Number(gateRow.close_epoch || 0), duplicate: false, release: () => release(leaseId) };
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => {});
      if (isUniqueViolation(error)) throw conflictError('Admission key is already active in another worker', error);
      throw error;
    } finally {
      client.release();
    }
  };

  const setEnabled = async value => {
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await ensureGateRow(client);
      const current = await client.query('SELECT gate_id,enabled,close_epoch FROM core_v0_admission_gates WHERE gate_id=$1 FOR UPDATE', [gate]);
      const row = current.rows[0] || { enabled: Boolean(enabled), close_epoch: 0 };
      const nextEpoch = !value && row.enabled ? Number(row.close_epoch || 0) + 1 : Number(row.close_epoch || 0);
      await client.query('UPDATE core_v0_admission_gates SET enabled=$2,close_epoch=$3,updated_at=$4 WHERE gate_id=$1', [gate, Boolean(value), nextEpoch, now()]);
      await client.query('COMMIT');
      committed = true;
      return { gateId: gate, enabled: Boolean(value), closeEpoch: nextEpoch };
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  const disable = async ({ timeoutMs = configuredTimeout } = {}) => {
    const closed = await setEnabled(false);
    const timeout = Math.max(0, Math.min(60_000, Number(timeoutMs) || 0));
    const deadline = Date.now() + timeout;
    while (true) {
      const current = await snapshot();
      if (!current.activeLeases.length) return { status: 'drained', gateId: gate, closeEpoch: closed.closeEpoch, activeIds: [] };
      if (Date.now() >= deadline) {
        const activeIds = current.activeLeases.map(item => item.turnId || item.leaseId);
        if (crashRecorder?.record) {
          try {
            for (const lease of current.activeLeases) {
              await crashRecorder.record({ gateId: gate, tenantId: lease.tenantId, subjectUserId: lease.subjectUserId, turnId: lease.turnId, leaseId: lease.leaseId, operation: 'drain_timeout', adapter: 'admission-gate', status: 'pending', attempt: 1, closeEpoch: closed.closeEpoch, leaseOwner: lease.leaseOwner, externalReceiptStatus: 'unknown' });
            }
          } catch (error) {
            throw coreError('CORE_REPAIR_RECORD_FAILED', 'Admission drain timeout could not be recorded', { status: 503, retryable: true, unknown: true, cause: error });
          }
        }
        return { status: 'timed_out', gateId: gate, closeEpoch: closed.closeEpoch, activeIds, repairRecorded: Boolean(crashRecorder?.record) };
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, Math.max(1, deadline - Date.now()))));
    }
  };

  const enable = () => setEnabled(true);
  return { enter, disable, enable, snapshot, release, gateId: gate };
}
