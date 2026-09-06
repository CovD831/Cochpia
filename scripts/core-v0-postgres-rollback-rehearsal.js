import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCoreV0AdmissionGate, createCoreV0RepairRecorder } from '../server/core-v0-postgres.js';
import { createCoreV0PostgresFixture } from '../server/core-v0-postgres-fixture.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const fixturePath = resolve(root, 'docs/rearchitecture/core-v0-postgres-slice/fixtures/rollback-drain-rehearsal.json');
const artifactPath = resolve(root, '.rearchitecture-runs/core-v0-postgres-rollback-rehearsal.json');
const context = { tenantId: 'tenant-rehearsal', subjectUserId: 'user-rehearsal' };
const now = () => '2026-09-05T00:00:00.000Z';

function check(condition, code, results) {
  if (!condition) throw new Error(code);
  results.push({ id: code, status: 'passed' });
}

async function expectCode(operation, expectedCode) {
  try {
    await operation();
  } catch (error) {
    if (error.code === expectedCode) return;
    throw new Error(`EXPECTED_${expectedCode}_GOT_${error.code || 'UNKNOWN'}`);
  }
  throw new Error(`MISSING_${expectedCode}`);
}

async function run() {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const results = [];
  const observedSequence = [];
  const step = name => observedSequence.push(name);
  const pool = createCoreV0PostgresFixture();
  const recorder = createCoreV0RepairRecorder({ pool, operatorId: 'rollback-rehearsal', now });
  const gate = createCoreV0AdmissionGate({
    pool,
    gateId: 'core-v0',
    drainTimeoutMs: 0,
    pollIntervalMs: 1,
    crashRecorder: recorder,
    operatorId: 'rollback-rehearsal',
    now
  });
  const writerState = structuredClone(fixture.initialWriterState);
  const writerFence = {
    observeInitial() {
      if (writerState.route !== 'legacy' || writerState.legacyWriter?.status !== 'active' || writerState.legacyWriter?.writable !== true) throw new Error('R-01_INVALID_LEGACY_INITIAL_STATE');
      if (writerState.targetWriter?.status !== 'standby' || writerState.targetWriter?.writable !== false || writerState.targetTrafficSwitched !== false) throw new Error('R-01_INVALID_TARGET_INITIAL_STATE');
      step('legacy_writer_active');
      step('target_writer_standby');
    },
    closeBeforeSwitch({ gateSnapshot }) {
      if (gateSnapshot.enabled || writerState.route !== 'legacy' || writerState.targetTrafficSwitched) throw new Error('R-01_SWITCH_BEFORE_CLOSE');
      writerState.cutoverPhase = 'closed_before_switch';
      writerState.closeBeforeSwitch = true;
      step('close_gate_before_switch');
    },
    rollbackToLegacy({ gateSnapshot }) {
      if (gateSnapshot.enabled || gateSnapshot.activeLeases.length || writerState.cutoverPhase !== 'closed_before_switch') throw new Error('R-01_ROLLBACK_BEFORE_DRAIN');
      writerState.route = 'legacy';
      writerState.legacyWriter = { status: 'active', writable: true };
      writerState.targetWriter = { status: 'standby', writable: false };
      writerState.targetTrafficSwitched = false;
      writerState.cutoverPhase = 'rolled_back';
      step('rollback_to_legacy');
    }
  };
  writerFence.observeInitial();

  const lease = await gate.enter({
    key: 'rollback-drain-key',
    turnId: 'turn-rollback-drain',
    ...context,
    leaseOwner: 'target-worker'
  });
  step('admit_target_lease');
  check(lease.closeEpoch === 0 && lease.duplicate === false, 'R-01_ADMIT_BEFORE_CLOSE', results);

  const close = await gate.disable({ timeoutMs: 0 });
  const closedSnapshot = await gate.snapshot();
  writerFence.closeBeforeSwitch({ gateSnapshot: closedSnapshot });
  step('bounded_drain_timeout');
  check(close.status === 'timed_out', 'R-01_BOUNDED_TIMEOUT', results);
  check(close.closeEpoch === 1 && close.activeIds.includes('turn-rollback-drain'), 'R-01_CLOSE_EPOCH_AND_ACTIVE_ID', results);

  const repairAttemptId = pool.database.tables.core_v0_repair_attempts.find(item => item.turn_id === 'turn-rollback-drain')?.repair_attempt_id;
  step('record_pending_repair');
  check(Boolean(repairAttemptId), 'R-01_REPAIR_ID_RECORDED', results);
  check(
    pool.database.tables.core_v0_repair_attempts.find(item => item.repair_attempt_id === repairAttemptId)?.status === 'pending'
      && pool.database.tables.core_v0_repair_attempts.find(item => item.repair_attempt_id === repairAttemptId)?.external_receipt_status === 'unknown',
    'R-01_PENDING_REPAIR_RECORDED',
    results
  );

  await expectCode(
    () => gate.enter({ key: 'post-close-key', turnId: 'turn-post-close', ...context }),
    'CORE_ADMISSION_CLOSED'
  );
  step('reject_post_close_admission');
  check(true, 'R-01_POST_CLOSE_REJECTED', results);

  await lease.release();
  step('release_in_flight_lease');
  const drained = await gate.disable({ timeoutMs: 10 });
  check(drained.status === 'drained' && (await gate.snapshot()).activeLeases.length === 0, 'R-01_DRAINED_AFTER_RELEASE', results);

  step('reconcile_original_identity');
  let receiptLookupTurnId = null;
  let commitLookupTurnId = null;
  const reconciliation = await recorder.reconcile({
    repairAttemptId,
    receiptLookup: async ({ repair }) => {
      receiptLookupTurnId = repair.turn_id;
      return { authoritative: true, status: 'completed', receiptId: `receipt:${repair.turn_id}`, turnId: repair.turn_id };
    },
    coreCommitLookup: async ({ repair }) => {
      commitLookupTurnId = repair.turn_id;
      return { authoritative: true, status: 'completed', commitId: `commit:${repair.turn_id}`, turnId: repair.turn_id };
    }
  });
  const repairRow = pool.database.tables.core_v0_repair_attempts.find(item => item.repair_attempt_id === repairAttemptId);
  check(
    reconciliation.status === 'completed'
      && receiptLookupTurnId === 'turn-rollback-drain'
      && commitLookupTurnId === 'turn-rollback-drain'
      && repairRow.status === 'completed'
      && repairRow.external_receipt_status === 'completed'
      && repairRow.external_receipt_id === 'receipt:turn-rollback-drain'
      && repairRow.core_commit_id === 'commit:turn-rollback-drain',
    'R-01_ORIGINAL_IDENTITY_RECONCILED',
    results
  );

  const snapshot = await gate.snapshot();
  writerFence.rollbackToLegacy({ gateSnapshot: snapshot });
  const actual = {
    targetTrafficSwitched: writerState.targetTrafficSwitched,
    legacyWriterRemainsMutable: writerState.legacyWriter.status === 'active' && writerState.legacyWriter.writable === true,
    targetWriterRemainsStandby: writerState.targetWriter.status === 'standby' && writerState.targetWriter.writable === false,
    closeBeforeSwitch: writerState.closeBeforeSwitch === true,
    postCloseAdmission: 'CORE_ADMISSION_CLOSED',
    repairEndsWithAuthoritativeReceipt: reconciliation.status === 'completed' && repairRow.external_receipt_status === 'completed' && Boolean(repairRow.external_receipt_id) && Boolean(repairRow.core_commit_id),
    activeLeasesAfterRehearsal: snapshot.activeLeases.length,
    ambiguousExternalOutcome: !(reconciliation.status === 'completed' && repairRow.external_receipt_status === 'completed' && repairRow.external_receipt_id && repairRow.core_commit_id),
    routeAfterRollback: writerState.route
  };
  check(JSON.stringify(observedSequence) === JSON.stringify(fixture.sequence), 'R-01_FIXTURE_SEQUENCE', results);
  for (const [key, expected] of Object.entries(fixture.expected)) check(Object.is(actual[key], expected), `R-01_FIXTURE_EXPECTED_${key}`, results);
  results.push({ id: 'P-10', status: 'passed' });

  const summary = {
    package: 'R-003-postgres-memoryport',
    fixture: fixture.fixture,
    mode: 'sql-shaped-fixture',
    status: 'passed',
    sequence: observedSequence,
    writerState,
    actual,
    results,
    evidence: {
      closeEpoch: snapshot.closeEpoch,
      closeStatus: close.status,
      timedOutActiveIds: close.activeIds,
      repairAttemptId: repairRow.repair_attempt_id,
      repairStatus: repairRow.status,
      externalReceiptStatus: repairRow.external_receipt_status,
      externalReceiptId: repairRow.external_receipt_id,
      coreCommitId: repairRow.core_commit_id,
      activeLeasesAfterRehearsal: snapshot.activeLeases.length,
      postCloseAdmission: 'CORE_ADMISSION_CLOSED'
    }
  };
  await mkdir(resolve(root, '.rearchitecture-runs'), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

try {
  await run();
} catch (error) {
  console.error(JSON.stringify({ package: 'R-003-postgres-memoryport', fixture: 'rollback-drain-rehearsal', status: 'failed', code: error.message }));
  process.exitCode = 1;
}
