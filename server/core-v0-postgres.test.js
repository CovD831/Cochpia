import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  createCoreV0AdmissionGate,
  createCoreV0RepairRecorder,
  createPostgresCoreV0Store,
  createPostgresMemoryPort,
  normalizeCoreV0RawEventReceipt
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
    'external_receipt_id',
    'core_commit_id',
    'ADD COLUMN IF NOT EXISTS external_receipt_id',
    'ADD COLUMN IF NOT EXISTS core_commit_id',
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

test('PostgreSQL-shaped MemoryPort accepts the canonical raw-event receipt', async () => {
  const repository = {
    async load() {
      const state = createMemoryModuleState();
      const session = {
        id: 'memory-1',
        tenantId: context.tenantId,
        userId: context.subjectUserId,
        callerAgentId: context.callerAgentId,
        status: 'active',
        startedAt: '2026-09-05T00:00:00.000Z',
        closedAt: null,
        expiresAt: '2099-09-05T00:00:00.000Z',
        profileSnapshotId: 'profile-1',
        grantVersion: 0,
        privacyEpoch: 0,
        resourceRevision: 1
      };
      state.sessions.push(session);
      state.profileSnapshots.push({ id: session.profileSnapshotId, tenantId: context.tenantId, userId: context.subjectUserId, sessionId: session.id, grantVersion: 0, privacyEpoch: 0, createdAt: session.startedAt, resourceRevision: 1 });
      return state;
    },
    async save() {}
  };
  const port = createPostgresMemoryPort({ repository, context, retryAttempts: 0 });
  const event = { eventId: 'event:unverified', sourceRevision: '1', content: 'message' };
  const result = await port.appendRawEvent({ memorySessionId: 'memory-1', event });
  assert.equal(result.status, 'completed');
  assert.equal(result.authoritative, true);
  assert.equal(result.receipt.status, 'completed');
  assert.equal(result.receipt.authoritative, true);
  assert.equal(result.receipt.result, 'accepted_stored');
  assert.equal(result.receipt.eventId, event.eventId);
  assert.equal(result.receipt.sourceRevision, event.sourceRevision);
  assert.match(result.receipt.rawEventId, /^.+$/);
});

test('Core-owned PostgreSQL store exposes assistant commit receipts after a fresh reload', async () => {
  const pool = createCoreV0PostgresFixture();
  const first = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  first.core.turnAdmissions.push(makeTurn({
    commitId: 'assistant:commit-1',
    assistantMessageId: 'assistant-1',
    status: 'committed'
  }));
  first.core.assistantCommits.push({
    commitId: 'assistant:commit-1',
    turnId: 'turn:fixture',
    tenantId: context.tenantId,
    subjectUserId: context.subjectUserId,
    applicationSessionId: 'session-1',
    assistantMessageId: 'assistant-1',
    status: 'completed',
    content: 'response',
    receiptId: 'receipt:commit-1',
    createdAt: '2026-09-05T00:00:00.000Z',
    completedAt: '2026-09-05T00:00:01.000Z'
  });
  first.core.sequence = 1;
  await first.persist();
  const fresh = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  assert.deepEqual(fresh.getAssistantCommitReceipt('assistant:commit-1'), {
    status: 'completed',
    commitId: 'assistant:commit-1',
    receiptId: 'receipt:commit-1',
    assistantMessageId: 'assistant-1'
  });
  assert.deepEqual(fresh.getAssistantCommitReceipt('assistant:missing'), {
    status: 'not_found',
    authoritative: true,
    commitId: 'assistant:missing'
  });
});

test('PostgreSQL MemoryPort does not own Core assistant commit receipts', async () => {
  const repository = {
    async load() {
      const state = createMemoryModuleState();
      state.coreV0 = { assistantCommits: [{ commitId: 'assistant:commit-1', status: 'completed', receiptId: 'receipt:commit-1', assistantMessageId: 'assistant-1' }] };
      return state;
    },
    async save() {}
  };
  const port = createPostgresMemoryPort({ repository, context, retryAttempts: 0 });
  assert.equal(Object.hasOwn(port, 'getAssistantCommitReceipt'), false);
  assert.equal(Object.hasOwn(port, 'reconcileAssistantCommit'), false);
});

test('PostgreSQL-shaped MemoryPort does not promote an unverified idempotency record', async () => {
  const repository = {
    async load() {
      const state = createMemoryModuleState();
      const session = {
        id: 'memory-1',
        tenantId: context.tenantId,
        userId: context.subjectUserId,
        callerAgentId: context.callerAgentId,
        status: 'active',
        startedAt: '2026-09-05T00:00:00.000Z',
        closedAt: null,
        expiresAt: '2099-09-05T00:00:00.000Z',
        profileSnapshotId: 'profile-1',
        grantVersion: 0,
        privacyEpoch: 0,
        resourceRevision: 1
      };
      state.sessions.push(session);
      state.rawEvents.push({
        id: 'raw-existing',
        eventId: 'event:duplicate',
        sourceRevision: '1',
        tenantId: context.tenantId,
        userId: context.subjectUserId,
        sessionId: session.id,
        content: 'message',
        contentType: 'plain_text',
        eventRole: 'user'
      });
      return state;
    },
    async save() {}
  };
  const port = createPostgresMemoryPort({ repository, context, retryAttempts: 0 });
  const result = await port.appendRawEvent({ memorySessionId: 'memory-1', event: { eventId: 'event:duplicate', sourceRevision: '1', content: 'message' } });
  assert.equal(result.status, 'pending');
  assert.equal(result.code, 'MEMORY_RAW_EVENT_RECEIPT_UNVERIFIED');
  assert.equal(result.unknown, true);
});

test('raw-event receipt normalization rejects untrusted result and identity variants', () => {
  const event = { eventId: 'event:conflict', sourceRevision: '1' };
  const base = {
    authoritative: true,
    status: 'completed',
    result: 'accepted_stored',
    receipt: {
      authoritative: true,
      status: 'completed',
      eventId: event.eventId,
      sourceRevision: event.sourceRevision,
      rawEventId: 'raw-conflict',
      result: 'accepted_stored'
    }
  };

  assert.deepEqual(normalizeCoreV0RawEventReceipt(base, event), base.receipt);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, authoritative: undefined }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, authoritative: false }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, receipt: { ...base.receipt, authoritative: false } }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, status: undefined }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, result: undefined }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, receipt: { ...base.receipt, status: [] } }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, receipt: undefined }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, receipt: { ...base.receipt, status: undefined } }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, receipt: { ...base.receipt, status: 'COMPLETED' } }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, receipt: { ...base.receipt, result: undefined } }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, result: 'accepted_no_store' }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, receipt: { ...base.receipt, result: 'accepted_no_store' } }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, result: ['accepted_stored'] }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, receipt: { ...base.receipt, result: ['accepted_stored'] } }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, status: 'failed' }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, status: 'pending' }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, status: undefined }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, receipt: { ...base.receipt, rawEventId: null } }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, receipt: { ...base.receipt, rawEventId: ['raw-conflict'] } }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, rawEventId: 'raw-top', receipt: { ...base.receipt, rawEventId: 'raw-nested' } }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, eventId: 'event:top', receipt: { ...base.receipt, eventId: 'event:nested' } }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, sourceRevision: '2' }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, sourceRevision: '1', receipt: { ...base.receipt, sourceRevision: '2' } }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, event_id: event.eventId, eventId: 'event:other' }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, receipt: { ...base.receipt, event_id: event.eventId, eventId: 'event:other' } }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, receipt: { ...base.receipt, eventId: 'event:other' } }, event), null);
  assert.equal(normalizeCoreV0RawEventReceipt({ ...base, receipt: { ...base.receipt, sourceRevision: '2' } }, event), null);
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
  await assert.rejects(
    () => recorder.record({ turnId: 'turn-0', operation: 'reconcile', adapter: 'memory-port', status: 'completed' }),
    error => error.code === 'REPAIR_COMPLETION_PROOF_REQUIRED'
  );
  const first = await recorder.record({ turnId: 'turn-1', operation: 'reconcile', adapter: 'memory-port', attempt: 1, closeEpoch: 3 });
  const duplicate = await recorder.record({ turnId: 'turn-1', operation: 'reconcile', adapter: 'memory-port', attempt: 1, closeEpoch: 3 });
  assert.equal(first.repairAttemptId, duplicate.repairAttemptId);
  assert.equal(duplicate.duplicate, true);
  await recorder.transition({ repairAttemptId: first.repairAttemptId, status: 'processing' });
  await assert.rejects(
    () => recorder.transition({ repairAttemptId: first.repairAttemptId, status: 'completed', externalReceiptStatus: 'completed' }),
    error => error.code === 'REPAIR_COMPLETION_PROOF_REQUIRED'
  );
  const reconciled = await recorder.reconcile({
    repairAttemptId: first.repairAttemptId,
    receiptLookup: async () => ({ authoritative: true, status: 'completed', receiptId: 'receipt:turn-1', turnId: 'turn-1' }),
    coreCommitLookup: async () => ({ authoritative: true, status: 'completed', commitId: 'commit:turn-1', turnId: 'turn-1' })
  });
  assert.equal(reconciled.status, 'completed');
  assert.equal(pool.database.tables.core_v0_repair_attempts[0].external_receipt_id, 'receipt:turn-1');
  assert.equal(pool.database.tables.core_v0_repair_attempts[0].core_commit_id, 'commit:turn-1');
  await assert.rejects(() => recorder.transition({ repairAttemptId: first.repairAttemptId, status: 'processing' }), error => error.code === 'REPAIR_TRANSITION_INVALID');
  const crash = await recorder.recordCrash({ processId: 'worker-a', turnId: 'turn-1', operation: 'append', errorCode: 'ECONNRESET' });
  const crashDuplicate = await recorder.recordCrash({ processId: 'worker-a', turnId: 'turn-1', operation: 'append', errorCode: 'ECONNRESET' });
  assert.equal(crash.crashRecordId, crashDuplicate.crashRecordId);
  assert.equal(pool.database.tables.core_v0_repair_attempts.length, 1);
  assert.equal(pool.database.tables.core_v0_crash_records.length, 1);
});

test('repair reconciliation keeps incomplete or mismatched evidence pending', async () => {
  const pool = createCoreV0PostgresFixture();
  const recorder = createCoreV0RepairRecorder({ pool, operatorId: 'operator-a', now: () => '2026-09-05T00:00:00.000Z' });
  const first = await recorder.record({ turnId: 'turn-pending', operation: 'reconcile', adapter: 'memory-port', closeEpoch: 3 });
  const pendingReceipt = await recorder.reconcile({
    repairAttemptId: first.repairAttemptId,
    receiptLookup: async () => ({ authoritative: false, status: 'pending', receiptId: 'receipt:pending', turnId: 'turn-pending' }),
    coreCommitLookup: async () => ({ authoritative: true, status: 'completed', commitId: 'commit:should-not-be-used', turnId: 'turn-pending' })
  });
  assert.equal(pendingReceipt.status, 'pending');
  assert.equal(pool.database.tables.core_v0_repair_attempts[0].status, 'pending');
  assert.equal(pool.database.tables.core_v0_repair_attempts[0].external_receipt_status, 'pending');

  let coreLookupCalled = false;
  const missingReceiptTurnId = await recorder.reconcile({
    repairAttemptId: first.repairAttemptId,
    receiptLookup: async () => ({ authoritative: true, status: 'completed', receiptId: 'receipt:missing-turn' }),
    coreCommitLookup: async () => {
      coreLookupCalled = true;
      return { authoritative: true, status: 'completed', commitId: 'commit:missing-turn', turnId: 'turn-pending' };
    }
  });
  assert.equal(missingReceiptTurnId.status, 'pending');
  assert.equal(coreLookupCalled, false);
  assert.equal(pool.database.tables.core_v0_repair_attempts[0].error_code, 'REPAIR_RECEIPT_PENDING');

  const mismatch = await recorder.reconcile({
    repairAttemptId: first.repairAttemptId,
    receiptLookup: async () => ({ authoritative: true, status: 'completed', receiptId: 'receipt:pending', turnId: 'turn-pending' }),
    coreCommitLookup: async () => ({ authoritative: true, status: 'completed', commitId: 'commit:wrong-turn', turnId: 'another-turn' })
  });
  assert.equal(mismatch.status, 'pending');
  assert.equal(pool.database.tables.core_v0_repair_attempts[0].error_code, 'REPAIR_CORE_COMMIT_PENDING');
  assert.equal(pool.database.tables.core_v0_repair_attempts[0].status, 'pending');
});

test('repair and crash metadata reject prompt-like, URL-like and oversized identities', async () => {
  const pool = createCoreV0PostgresFixture();
  const recorder = createCoreV0RepairRecorder({ pool, operatorId: 'operator-a' });
  await assert.rejects(
    () => recorder.record({ turnId: 'turn-1', operation: 'reconcile', adapter: 'memory-port', errorCode: 'please-ignore-this' }),
    error => error.code === 'REPAIR_METADATA_INVALID' && error.status === 400
  );
  await assert.rejects(
    () => recorder.record({ turnId: 'postgresql://db.internal/secret', operation: 'reconcile', adapter: 'memory-port' }),
    error => error.code === 'REPAIR_METADATA_INVALID' && error.status === 400
  );
  await assert.rejects(
    () => recorder.record({ turnId: 'x'.repeat(201), operation: 'reconcile', adapter: 'memory-port' }),
    error => error.code === 'REPAIR_METADATA_INVALID' && error.status === 400
  );
  const accepted = await recorder.record({ turnId: 'turn:opaque-1', operation: 'reconcile', adapter: 'memory-port', errorCode: 'ECONNRESET' });
  assert.equal(accepted.status, 'recorded');
  assert.equal(pool.database.tables.core_v0_repair_attempts[0].turn_id, 'turn:opaque-1');
});

test('repair metadata remains content-free at the persistence boundary', async () => {
  const pool = createCoreV0PostgresFixture();
  const recorder = createCoreV0RepairRecorder({ pool, operatorId: 'operator-a' });
  await recorder.record({
    turnId: 'turn:content-free',
    operation: 'reconcile',
    adapter: 'memory-port',
    errorCode: 'MEMORY_RECEIPT_PENDING'
  });
  const serializedQueries = JSON.stringify(pool.database.queries);
  assert.doesNotMatch(serializedQueries, /用户|prompt|database_url|postgresql:\/\//i);
  assert.equal(Object.prototype.hasOwnProperty.call(pool.database.tables.core_v0_repair_attempts[0], 'message'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(pool.database.tables.core_v0_repair_attempts[0], 'content'), false);
});

test('admission gate requires durable repair recording before construction', () => {
  const pool = createCoreV0PostgresFixture();
  assert.throws(() => createCoreV0AdmissionGate({ pool }), /requires a durable repair recorder/);
  assert.throws(() => createCoreV0AdmissionGate({ pool, crashRecorder: { record: async () => ({ status: 'recorded', repairAttemptId: 'fake' }) } }), /requires a durable repair recorder/);
});
