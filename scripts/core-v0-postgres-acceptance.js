import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCoreV0AdmissionGate, createCoreV0RepairRecorder, createPostgresCoreV0Store, createPostgresMemoryPort } from '../server/core-v0-postgres.js';
import { createCoreV0TurnService } from '../server/core-v0.js';
import { createMemoryModuleState } from '../server/memory-module.js';
import { createCoreV0PostgresFixture } from '../server/core-v0-postgres-fixture.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const context = { tenantId: 'tenant-acceptance', subjectUserId: 'user-acceptance', actorType: 'user', actorId: 'user-acceptance', callerAgentId: 'cochpia' };
const baseState = () => ({
  sessions: [{ id: 'session-acceptance', title: 'fixture', summary: '', persona: '', atmosphere: '', companionIntent: 'listen' }],
  messages: { 'session-acceptance': [] },
  personality: { version: 1, summary: 'fixture', traits: [] },
  profile: { name: 'Cochpia', gender: 'none', age: null }
});
const input = (key, message = '验收消息') => ({ body: { sessionId: 'session-acceptance', message, channel: '默认' }, headerIdempotencyKey: key });
const memoryPort = () => ({
  async ensureSessionBinding() { return { status: 'completed', memorySessionId: 'memory-acceptance' }; },
  async appendRawEvent({ event }) { return { status: 'completed', receipt: { status: 'completed', eventId: event.eventId, rawEventId: `raw:${event.eventId}` } }; },
  async retrieveContext() { return { status: 'available', answerability: 'not_found', recalled: [], bundle: null }; }
});

function check(condition, code) {
  if (!condition) throw new Error(code);
}

async function shapedAcceptance() {
  const results = [];
  const pool = createCoreV0PostgresFixture();
  const staleWorker = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  const store = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  const service = createCoreV0TurnService({ state: store.state, store, context, memoryPort: memoryPort(), modelGateway: { generate: async () => ({ content: 'fixture response' }) } });
  const first = await service.handleTurn(input('acceptance-key-1'));
  const persistedTurn = store.findTurn(first.turnId);
  check(first.status === 'committed' && persistedTurn?.turnId && persistedTurn.eventId && persistedTurn.applicationMessageId && persistedTurn.sourceRevision, 'P-01_CHECKPOINTS');
  const fresh = await createPostgresCoreV0Store({ pool, context, baseState: baseState() });
  const replay = await createCoreV0TurnService({ state: fresh.state, store: fresh, context, memoryPort: memoryPort(), modelGateway: { generate: async () => ({ content: 'unexpected' }) } }).handleTurn(input('acceptance-key-1'));
  check(replay.replay === true && replay.turnId === first.turnId, 'P-01_REPLAY');
  results.push({ id: 'P-01', status: 'passed' });

  const workerB = staleWorker;
  workerB.core.turnAdmissions.push({ ...store.core.turnAdmissions[0], turnId: 'turn-loser', idempotencyKey: 'loser-key', applicationMessageId: 'message-loser', assistantMessageId: 'assistant-loser', eventId: 'event-loser', commitId: 'assistant:assistant-loser' });
  workerB.core.sequence = workerB.core.persistenceBaseSequence + 1;
  let conflict = false;
  try { await workerB.persist(); } catch (error) { conflict = error.code === 'CORE_STORAGE_CONFLICT'; }
  check(conflict && pool.database.tables.core_v0_turn_admissions.length === 1, 'P-02_CAS');
  results.push({ id: 'P-02', status: 'passed' });

  await assertRejects(() => service.handleTurn(input('acceptance-key-1', '不同指纹')), 'IDEMPOTENCY_KEY_CONFLICT');
  results.push({ id: 'P-03', status: 'passed' });

  const memoryState = createMemoryModuleState();
  let conflictOnce = true;
  let savedKey = null;
  const repository = {
    async load() { return structuredClone(memoryState); },
    async save(_, state) {
      savedKey = state.idempotencyRecords.at(-1)?.key || null;
      if (conflictOnce) {
        conflictOnce = false;
        const error = new Error('conflict');
        error.code = 'MEMORY_STORAGE_CONFLICT';
        error.status = 409;
        throw error;
      }
      Object.assign(memoryState, structuredClone(state));
    }
  };
  const memory = createPostgresMemoryPort({ repository, context, retryAttempts: 1 });
  const binding = await memory.ensureSessionBinding({ bindingKey: 'tenant-acceptance:user-acceptance:session-acceptance' });
  check(binding.status === 'completed' && savedKey === 'core-v0:binding:tenant-acceptance:user-acceptance:session-acceptance', 'P-04_ORIGINAL_IDENTITY');
  results.push({ id: 'P-04', status: 'passed' });

  let unknownState = createMemoryModuleState();
  let failAfterWrite = true;
  const unknownRepository = {
    async load() { return structuredClone(unknownState); },
    async save(_, state) {
      unknownState = structuredClone(state);
      if (failAfterWrite) {
        failAfterWrite = false;
        throw Object.assign(new Error('connection closed after commit'), { code: 'ECONNRESET' });
      }
    }
  };
  const unknownMemory = createPostgresMemoryPort({ repository: unknownRepository, context, retryAttempts: 0 });
  const unknownAppend = await unknownMemory.appendRawEvent({ memorySessionId: null, event: { eventId: 'event-unknown', sourceRevision: '1', content: 'unknown outcome fixture', eventRole: 'user', contentType: 'plain_text' } });
  const authoritative = await unknownMemory.getRawEventReceipt({ eventId: 'event-unknown', sourceRevision: '1' });
  check(unknownAppend.status === 'pending' && authoritative.status === 'completed', 'P-05_UNKNOWN_RECEIPT');
  results.push({ id: 'P-05', status: 'passed' });

  const recorder = createCoreV0RepairRecorder({ pool, operatorId: 'acceptance', now: () => '2026-09-05T00:00:00.000Z' });
  const gate = createCoreV0AdmissionGate({ pool, drainTimeoutMs: 0, pollIntervalMs: 1, crashRecorder: recorder, now: () => '2026-09-05T00:00:00.000Z' });
  const lease = await gate.enter({ key: 'drain-key', turnId: 'turn-drain', tenantId: context.tenantId, subjectUserId: context.subjectUserId });
  const timeout = await gate.disable({ timeoutMs: 0 });
  check(timeout.status === 'timed_out' && timeout.activeIds.includes('turn-drain') && timeout.repairRecorded, 'P-06_DRAIN');
  await assertRejects(() => gate.enter({ key: 'after-close', turnId: 'turn-after' }), 'CORE_ADMISSION_CLOSED');
  await lease.release();
  check(pool.database.tables.core_v0_repair_attempts.length === 1, 'P-07_REPAIR_RECORD');
  results.push({ id: 'P-06', status: 'passed' });
  results.push({ id: 'P-07', status: 'passed' });

  const schema = await readFile(resolve(root, 'server/core-v0-schema.sql'), 'utf8');
  for (const fragment of ['core_v0_subjects', 'close_epoch', 'core_v0_repair_attempts', 'UNIQUE (tenant_id, subject_user_id, application_session_id, idempotency_key)']) check(schema.includes(fragment), 'P-08_SCHEMA');
  results.push({ id: 'P-08', status: 'passed' });

  const serverSource = await readFile(resolve(root, 'server/index.js'), 'utf8');
  // R-020 stage 3 retired the legacy companion stream, so the compatibility pin
  // is now "turns registered AND legacy gone" (mirrors stage3-cleanup.test.js
  // C-2/C-3). The old form required the legacy route to still be present.
  check(serverSource.includes("app.post('/api/chat/turns'") && !serverSource.includes("app.post('/api/chat/stream'") && serverSource.includes("app.use('/v1'") && serverSource.includes('saveState'), 'P-09_COMPATIBILITY');
  results.push({ id: 'P-09', status: 'passed' });
  return results;
}

async function assertRejects(operation, code) {
  try {
    await operation();
  } catch (error) {
    check(error.code === code, `EXPECTED_${code}`);
    return;
  }
  throw new Error(`MISSING_${code}`);
}

const livePending = {
  'L-01': { status: 'pending', reason: process.env.DATABASE_URL ? 'live_auth_tls_run_not_executed_by_shaped_acceptance' : 'DATABASE_URL_REQUIRED' },
  'L-02': { status: 'pending', reason: process.env.DATABASE_URL ? 'live_two_process_run_not_executed_by_shaped_acceptance' : 'DATABASE_URL_REQUIRED' }
};

try {
  const shaped = await shapedAcceptance();
  const summary = { package: 'R-003-postgres-memoryport', baseline: '410f770', mode: 'sql-shaped-fixture', results: [...shaped, livePending['L-01'] && { id: 'L-01', ...livePending['L-01'] }, livePending['L-02'] && { id: 'L-02', ...livePending['L-02'] }] };
  const artifactPath = resolve(root, '.rearchitecture-runs/core-v0-postgres-acceptance.json');
  await mkdir(resolve(root, '.rearchitecture-runs'), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(JSON.stringify({ package: 'R-003-postgres-memoryport', status: 'failed', code: error.message }));
  process.exitCode = 1;
}
