import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  createCoreV0AdmissionGate,
  createCoreV0RepairRecorder,
  createPostgresCoreV0Store,
  createPostgresMemoryPort
} from './core-v0-postgres.js';
import { createCoreV0TurnService } from './core-v0.js';
import { createMemoryModuleState } from './memory-module.js';
import { createCoreV0PostgresFixture } from './core-v0-postgres-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const context = { tenantId: 'tenant-a', subjectUserId: 'user-a', actorType: 'user', actorId: 'user-a', callerAgentId: 'cochpia' };

function baseState() {
  return {
    sessions: [{ id: 'session-1', title: 'fixture', summary: '', persona: '', atmosphere: '', companionIntent: 'listen' }],
    messages: { 'session-1': [] },
    personality: { version: 1, summary: 'fixture', traits: [] },
    profile: { name: 'Cochpia', gender: 'none', age: null }
  };
}

function input(key, message = '一条持久化消息') {
  return { body: { sessionId: 'session-1', message, channel: '默认' }, headerIdempotencyKey: key };
}

function memoryPort() {
  return {
    async ensureSessionBinding() { return { status: 'completed', memorySessionId: 'memory-1', receipt: { status: 'completed', memorySessionId: 'memory-1' } }; },
    async appendRawEvent({ event }) { return { status: 'completed', receipt: { status: 'completed', eventId: event.eventId, rawEventId: `raw:${event.eventId}` } }; },
    async retrieveContext() { return { status: 'available', answerability: 'not_found', recalled: [], bundle: null }; }
  };
}

function makeTurn(overrides = {}) {
  return {
    turnId: 'turn:fixture',
    tenantId: context.tenantId,
    subjectUserId: context.subjectUserId,
    applicationSessionId: 'session-1',
    idempotencyKey: 'fixture-key',
    fingerprint: JSON.stringify({ sessionId: 'session-1', message: 'fixture', channel: '默认' }),
    message: 'fixture',
    channel: '默认',
    bindingKey: 'tenant-a:user-a:session-1',
    memorySessionId: 'memory-1',
    applicationMessageId: 'message:fixture',
    assistantMessageId: 'assistant-fixture',
    eventId: 'event:fixture',
    sourceRevision: '1',
    sequenceNo: 1,
    commitId: 'assistant:assistant-fixture',
    admissionReceiptId: 'admission:turn:fixture',
    pendingReceiptId: null,
    status: 'committed',
    memoryStatus: 'available',
    memoryAnswerability: 'not_found',
    rawEventReceipt: { status: 'completed', eventId: 'event:fixture' },
    generatedContent: 'response',
    result: { status: 'committed', turnId: 'turn:fixture' },
    failure: null,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:01.000Z',
    committedAt: '2026-09-05T00:00:01.000Z',
    ...overrides
  };
}

test('R-003 schema freezes relational identities, fences and content-free repair rows', async () => {
  const schema = await readFile(resolve(here, 'core-v0-schema.sql'), 'utf8');
  for (const fragment of [
    'UNIQUE (tenant_id, subject_user_id, application_session_id, idempotency_key)',
    'UNIQUE (tenant_id, subject_user_id, application_session_id, source_revision)',
    'UNIQUE (tenant_id, subject_user_id, event_id)',
    'core_v0_admission_gates',
    'close_epoch',
    'core_v0_repair_attempts',
    'core_v0_crash_records'
  ]) assert.match(schema, new RegExp(fragment.replace(/[()]/g, '\\$&')));
  assert.doesNotMatch(schema, /prompt|database_url|content_body/i);
});

test('PostgreSQL-shaped Core store preserves checkpoints and exact replay across fresh workers', async () => {
  const pool = createCoreV0PostgresFixture();
  const store = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  const service = createCoreV0TurnService({
    state: store.state,
    store,
    context,
    memoryPort: memoryPort(),
    modelGateway: { generate: async () => ({ content: '持久化回答' }) }
  });
  const first = await service.handleTurn(input('postgres-key-1'));
  assert.equal(first.status, 'committed');
  assert.equal(store.state.coreV0.persistenceBaseSequence, pool.database.tables.core_v0_subjects[0].sequence);
  assert.equal(pool.database.tables.core_v0_turn_admissions.length, 1);
  assert.equal(pool.database.tables.core_v0_messages.length, 2);

  const fresh = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  const replay = await createCoreV0TurnService({
    state: fresh.state,
    store: fresh,
    context,
    memoryPort: memoryPort(),
    modelGateway: { generate: async () => { throw new Error('replay must not call model'); } }
  }).handleTurn(input('postgres-key-1'));
  assert.equal(replay.status, 'committed');
  assert.equal(replay.replay, true);
  assert.equal(replay.turnId, first.turnId);
  assert.equal(fresh.state.messages['session-1'].filter(item => item.role === 'assistant').length, 1);
});

test('subject CAS gives one worker the save and preserves the winner for original-key replay', async () => {
  const pool = createCoreV0PostgresFixture();
  const workerA = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  const workerB = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  workerA.core.turnAdmissions.push(makeTurn());
  workerA.core.sequence = 1;
  await workerA.persist();

  workerB.core.turnAdmissions.push(makeTurn({ turnId: 'turn:loser', applicationMessageId: 'message:loser', assistantMessageId: 'assistant-loser', eventId: 'event:loser', commitId: 'assistant:assistant-loser', idempotencyKey: 'loser-key' }));
  workerB.core.sequence = 1;
  await assert.rejects(() => workerB.persist(), error => error.code === 'CORE_STORAGE_CONFLICT' && error.status === 409 && error.retryable === true);
  assert.equal(pool.database.tables.core_v0_turn_admissions.length, 1);

  await workerB.load();
  assert.equal(workerB.findTurn('turn:fixture').idempotencyKey, 'fixture-key');
  const replayService = createCoreV0TurnService({ state: workerB.state, store: workerB, context, memoryPort: memoryPort(), modelGateway: { generate: async () => ({ content: 'must not run' }) } });
  const replay = await replayService.handleTurn({ body: { sessionId: 'session-1', message: 'fixture', channel: '默认' }, headerIdempotencyKey: 'fixture-key' });
  assert.equal(replay.replay, true);
  await assert.rejects(() => replayService.handleTurn(input('fixture-key', '改过的内容')), error => error.code === 'IDEMPOTENCY_KEY_CONFLICT' && error.status === 409);
});

test('Core keeps an external Memory success pending when its subsequent Core CAS loses', async () => {
  const pool = createCoreV0PostgresFixture();
  const workerB = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  let appendCalls = 0;
  const pendingThenCompleted = {
    async ensureSessionBinding() { return { status: 'completed', memorySessionId: 'memory-cas-loss' }; },
    async appendRawEvent({ event }) {
      appendCalls += 1;
      if (appendCalls === 1) return { status: 'pending' };
      return { status: 'completed', receipt: { status: 'completed', eventId: event.eventId, rawEventId: 'raw-after-cas-loss' } };
    },
    async retrieveContext() { return { status: 'available', answerability: 'not_found', recalled: [], bundle: null }; }
  };
  const workerBService = createCoreV0TurnService({
    state: workerB.state,
    store: workerB,
    context,
    memoryPort: pendingThenCompleted,
    modelGateway: { generate: async () => ({ content: 'must wait for Core commit' }) }
  });
  const pending = await workerBService.handleTurn(input('cas-loss-key'));
  assert.equal(pending.status, 'pending');
  assert.equal(workerB.core.persistenceBaseSequence, pool.database.tables.core_v0_subjects[0].sequence);

  const workerA = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  const competing = makeTurn({ turnId: 'turn:competing', idempotencyKey: 'competing-key', applicationMessageId: 'message:competing', assistantMessageId: 'assistant-competing', eventId: 'event:competing', commitId: 'assistant:assistant-competing', sourceRevision: '2', sequenceNo: workerA.core.sequence + 1 });
  workerA.core.turnAdmissions.push(competing);
  workerA.core.sequence += 1;
  await workerA.persist();

  const stillPending = await workerBService.handleTurn(input('cas-loss-key'));
  assert.equal(stillPending.status, 'pending');
  assert.equal(workerB.state.messages['session-1'].some(message => message.id === pending.applicationMessageId), false);
  assert.equal(pool.database.tables.core_v0_turn_admissions.some(turn => turn.turn_id === 'turn:competing'), true);
});

test('PostgreSQL-shaped MemoryPort retries CAS with the original binding identity and returns unknown as pending', async () => {
  let memoryState = createMemoryModuleState();
  let saveCalls = 0;
  const keys = [];
  const repository = {
    async load() { return structuredClone(memoryState); },
    async save(_, state) {
      saveCalls += 1;
      keys.push(state.idempotencyRecords.at(-1)?.key || null);
      if (saveCalls === 1) {
        const error = new Error('subject changed');
        error.code = 'MEMORY_STORAGE_CONFLICT';
        error.status = 409;
        error.retryable = true;
        throw error;
      }
      memoryState = structuredClone(state);
      state.persistenceBaseSequence = state.sequence;
    }
  };
  const port = createPostgresMemoryPort({ repository, context, retryAttempts: 2 });
  const result = await port.ensureSessionBinding({ bindingKey: 'tenant-a:user-a:session-1' });
  assert.equal(result.status, 'completed');
  assert.equal(saveCalls, 2);
  assert.deepEqual(keys, ['core-v0:binding:tenant-a:user-a:session-1', 'core-v0:binding:tenant-a:user-a:session-1']);

  const unknownRepository = {
    async load() { return createMemoryModuleState(); },
    async save() { throw Object.assign(new Error('connection closed'), { code: 'ECONNRESET' }); }
  };
  const unknown = await createPostgresMemoryPort({ repository: unknownRepository, context }).ensureSessionBinding({ bindingKey: 'unknown-binding' });
  assert.equal(unknown.status, 'pending');
  assert.equal(unknown.unknown, true);
});

test('durable admission gate closes the shared epoch, times out active work and rejects later admissions', async () => {
  const pool = createCoreV0PostgresFixture();
  const recorder = createCoreV0RepairRecorder({ pool, operatorId: 'operator-a', now: () => '2026-09-05T00:00:00.000Z' });
  const gateA = createCoreV0AdmissionGate({ pool, drainTimeoutMs: 0, pollIntervalMs: 1, crashRecorder: recorder, now: () => '2026-09-05T00:00:00.000Z' });
  const gateB = createCoreV0AdmissionGate({ pool, drainTimeoutMs: 0, pollIntervalMs: 1, crashRecorder: recorder, now: () => '2026-09-05T00:00:00.000Z' });
  const lease = await gateA.enter({ key: 'turn-key', turnId: 'turn-drain', tenantId: 'tenant-a', subjectUserId: 'user-a', leaseOwner: 'worker-a' });
  const timeout = await gateB.disable({ timeoutMs: 0 });
  assert.equal(timeout.status, 'timed_out');
  assert.deepEqual(timeout.activeIds, ['turn-drain']);
  assert.equal(timeout.repairRecorded, true);
  assert.equal(pool.database.tables.core_v0_repair_attempts.length, 1);
  await assert.rejects(() => gateA.enter({ key: 'after-close', turnId: 'turn-after' }), error => error.code === 'CORE_ADMISSION_CLOSED' && error.status === 503);
  await lease.release();
  const drained = await gateA.disable({ timeoutMs: 10 });
  assert.equal(drained.status, 'drained');
  assert.equal((await gateA.snapshot()).closeEpoch, 1);
});

test('repair recorder identity is stable, append-only and transition-bounded', async () => {
  const pool = createCoreV0PostgresFixture();
  const recorder = createCoreV0RepairRecorder({ pool, operatorId: 'operator-a', now: () => '2026-09-05T00:00:00.000Z' });
  const first = await recorder.record({ turnId: 'turn-1', operation: 'reconcile', adapter: 'memory-port', attempt: 1, closeEpoch: 3 });
  const duplicate = await recorder.record({ turnId: 'turn-1', operation: 'reconcile', adapter: 'memory-port', attempt: 1, closeEpoch: 3 });
  assert.equal(first.repairAttemptId, duplicate.repairAttemptId);
  assert.equal(duplicate.duplicate, true);
  await recorder.transition({ repairAttemptId: first.repairAttemptId, status: 'processing' });
  await recorder.transition({ repairAttemptId: first.repairAttemptId, status: 'completed', externalReceiptStatus: 'completed' });
  await assert.rejects(() => recorder.transition({ repairAttemptId: first.repairAttemptId, status: 'processing' }), error => error.code === 'REPAIR_TRANSITION_INVALID');
  const crash = await recorder.recordCrash({ processId: 'worker-a', turnId: 'turn-1', operation: 'append', errorCode: 'ECONNRESET' });
  const crashDuplicate = await recorder.recordCrash({ processId: 'worker-a', turnId: 'turn-1', operation: 'append', errorCode: 'ECONNRESET' });
  assert.equal(crash.crashRecordId, crashDuplicate.crashRecordId);
  assert.equal(pool.database.tables.core_v0_repair_attempts.length, 1);
  assert.equal(pool.database.tables.core_v0_crash_records.length, 1);
});
