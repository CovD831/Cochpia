import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import express from 'express';
import { SignJWT } from 'jose';
import { resolveDbSsl } from '../server/db-ssl.js';
import { ensureCoreV0PostgresSchema, createCoreV0RepairRecorder, createPostgresMemoryPort } from '../server/core-v0-postgres.js';
import { createMemoryModulePostgresRepository } from '../server/memory-module-postgres.js';
import { createMemoryModuleRuntime } from '../server/memory-module-runtime.js';
import { createMemoryServiceBoundary } from '../server/memory-service-boundary.js';

const { Pool } = pg;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = path.resolve(repoRoot, 'scripts/core-v0-postgres-live-worker.js');
const fixturePath = path.resolve(repoRoot, 'docs/rearchitecture/core-v0-postgres-slice/fixtures/live-postgres-acceptance.json');
const memorySchemaPath = path.resolve(repoRoot, 'server/memory-module-schema.sql');
const artifactPath = path.resolve(repoRoot, '.rearchitecture-runs/core-v0-postgres-live-acceptance.json');
const context = { tenantId: 'live-tenant', subjectUserId: 'live-user' };
const tableNames = [
  'core_v0_subjects',
  'core_v0_turn_admissions',
  'core_v0_memory_session_bindings',
  'core_v0_assistant_commits',
  'core_v0_messages',
  'core_v0_admission_gates',
  'core_v0_admission_leases',
  'core_v0_repair_attempts',
  'core_v0_crash_records'
];
const memoryTableNames = ['memory_sessions', 'raw_events', 'memory_idempotency_records', 'memory_commit_sequences'];
const CLEANUP_TIMEOUT_MS = 5_000;
const WORKER_STOP_TIMEOUT_MS = 3_000;
const INTERRUPT_TEST_MODE = String(process.env.CORE_V0_LIVE_INTERRUPT_TEST || '').toLowerCase() === 'true';

let activeCleanup = null;
let activeSignalCleanup = null;

class LiveAcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizeCode(error, fallback = 'LIVE_ACCEPTANCE_FAILED') {
  return String(error?.code || error?.name || fallback).replace(/[^A-Za-z0-9_.:-]/g, '_');
}

function result(id, status, detail) {
  return { id, status, detail };
}

function withTimeout(operation, timeoutMs, code) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new LiveAcceptanceError(code));
    }, timeoutMs);
    Promise.resolve(operation).then(value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function handleSignal(signal) {
  if (activeSignalCleanup) return activeSignalCleanup;
  activeSignalCleanup = (async () => {
    try {
      if (activeCleanup) await activeCleanup(signal);
    } finally {
      process.exitCode = signal === 'SIGINT' ? 130 : 143;
      process.exit(process.exitCode);
    }
  })();
  return activeSignalCleanup;
}

process.once('SIGINT', () => { void handleSignal('SIGINT'); });
process.once('SIGTERM', () => { void handleSignal('SIGTERM'); });

function configSnapshot() {
  const authMode = String(process.env.AUTH_MODE || '').toLowerCase();
  const storageProvider = String(process.env.STORAGE_PROVIDER || '').toLowerCase();
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  let urlSslMode = '';
  let databaseUrlValid = false;
  try {
    const parsed = new URL(databaseUrl);
    databaseUrlValid = ['postgres:', 'postgresql:'].includes(parsed.protocol);
    urlSslMode = String(parsed.searchParams.get('sslmode') || '').toLowerCase();
  } catch {
    databaseUrlValid = false;
  }

  let ssl;
  let sslError = null;
  try { ssl = resolveDbSsl(); }
  catch (error) { sslError = normalizeCode(error, 'DATABASE_TLS_CONFIGURATION_INVALID'); }
  const sslMode = String(process.env.DATABASE_SSL || '').toLowerCase();
  const caConfigured = Boolean(process.env.DATABASE_CA && existsSync(path.resolve(process.env.DATABASE_CA)));
  const connectionStringDoesNotWeakenTls = !urlSslMode || urlSslMode === 'verify-full';
  const strictTlsConfigured = !sslError
    && ssl?.rejectUnauthorized === true
    && connectionStringDoesNotWeakenTls
    && (caConfigured || sslMode === 'verify-full' || urlSslMode === 'verify-full');

  const configuredSsl = sslMode || urlSslMode;
  return {
    optedIn: String(process.env.CORE_V0_LIVE_ACCEPTANCE || '').toLowerCase() === 'true',
    isolatedEnvironment: String(process.env.CORE_V0_LIVE_ENV || '').toLowerCase() === 'isolated',
    databaseConfigured: Boolean(databaseUrl),
    databaseUrlValid,
    authRequired: authMode === 'required',
    storagePostgres: storageProvider === 'postgres',
    supabaseConfigured: Boolean(String(process.env.SUPABASE_URL || '').trim()),
    strictTlsConfigured,
    sslError,
    sslConfiguration: sslError
      ? 'invalid'
      : strictTlsConfigured
        ? 'strict'
        : configuredSsl
          ? 'configured_incomplete_or_non_strict'
          : 'unset'
  };
}

async function writeArtifact(summary) {
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

function pendingSummary(config, reasons) {
  return {
    package: 'R-003-postgres-memoryport',
    fixture: 'live-postgres-acceptance',
    mode: 'live-postgresql-isolated-schema',
    status: 'pending',
    config,
    results: [
      result('L-01', 'pending', reasons.join(',')),
      result('L-02', 'pending', reasons.join(','))
    ],
    evidence: { schemaCreated: false, workersStarted: 0 },
    limitations: ['No live database or explicit isolated-environment opt-in was used.']
  };
}

function createScopedPool(rawPool, schema) {
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

async function inspectSchema(rawPool, schema) {
  const query = await rawPool.query(
    'SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[])',
    [schema, tableNames]
  );
  const columns = new Map();
  for (const row of query.rows) {
    if (!columns.has(row.table_name)) columns.set(row.table_name, new Set());
    columns.get(row.table_name).add(row.column_name);
  }
  const required = {
    core_v0_subjects: ['sequence'],
    core_v0_turn_admissions: ['turn_id', 'idempotency_key', 'fingerprint', 'event_id', 'source_revision', 'commit_id'],
    core_v0_memory_session_bindings: ['binding_key', 'memory_session_id'],
    core_v0_assistant_commits: ['commit_id', 'turn_id'],
    core_v0_admission_gates: ['enabled', 'close_epoch'],
    core_v0_admission_leases: ['lease_id', 'admission_key', 'close_epoch'],
    core_v0_repair_attempts: ['repair_attempt_id', 'external_receipt_id', 'core_commit_id'],
    core_v0_crash_records: ['crash_record_id', 'error_code']
  };
  const missing = [];
  for (const table of tableNames) {
    if (!columns.has(table)) missing.push(`${table}:table`);
    for (const column of required[table] || []) {
      if (!columns.get(table)?.has(column)) missing.push(`${table}:${column}`);
    }
  }
  return { passed: missing.length === 0, tableCount: columns.size, missing };
}

async function inspectDatabaseContract(rawPool, schema) {
  const constraintsQuery = await rawPool.query(
    `SELECT t.relname AS table_name,c.contype,pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid=c.conrelid
       JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=$1 AND t.relname=ANY($2::text[])`,
    [schema, tableNames]
  );
  const indexesQuery = await rawPool.query(
    'SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=ANY($2::text[])',
    [schema, tableNames]
  );
  const constraints = constraintsQuery.rows.map(row => ({
    tableName: row.table_name,
    type: row.contype,
    definition: String(row.definition || '').replace(/\s+/g, ' ').toLowerCase()
  }));
  const hasConstraint = (tableName, type, fragments) => constraints.some(row => row.tableName === tableName
    && row.type === type
    && fragments.every(fragment => row.definition.includes(String(fragment).toLowerCase())));
  const missing = [];
  const primaryKeys = [
    ['core_v0_subjects', ['primary key', 'tenant_id', 'subject_user_id']],
    ['core_v0_turn_admissions', ['primary key', 'tenant_id', 'turn_id']],
    ['core_v0_memory_session_bindings', ['primary key', 'tenant_id', 'binding_id']],
    ['core_v0_assistant_commits', ['primary key', 'tenant_id', 'commit_id']],
    ['core_v0_messages', ['primary key', 'tenant_id', 'application_message_id']],
    ['core_v0_admission_gates', ['primary key', 'gate_id']],
    ['core_v0_admission_leases', ['primary key', 'gate_id', 'lease_id']],
    ['core_v0_repair_attempts', ['primary key', 'repair_attempt_id']],
    ['core_v0_crash_records', ['primary key', 'crash_record_id']]
  ];
  for (const [tableName, fragments] of primaryKeys) if (!hasConstraint(tableName, 'p', fragments)) missing.push(`${tableName}:primary_key`);

  const uniqueConstraints = [
    ['core_v0_turn_admissions', ['unique', 'tenant_id', 'subject_user_id', 'application_session_id', 'idempotency_key']],
    ['core_v0_turn_admissions', ['unique', 'tenant_id', 'subject_user_id', 'application_session_id', 'source_revision']],
    ['core_v0_turn_admissions', ['unique', 'tenant_id', 'subject_user_id', 'application_message_id']],
    ['core_v0_turn_admissions', ['unique', 'tenant_id', 'subject_user_id', 'event_id']],
    ['core_v0_memory_session_bindings', ['unique', 'tenant_id', 'subject_user_id', 'application_session_id']],
    ['core_v0_memory_session_bindings', ['unique', 'tenant_id', 'subject_user_id', 'binding_key']],
    ['core_v0_memory_session_bindings', ['unique', 'tenant_id', 'subject_user_id', 'memory_session_id']],
    ['core_v0_assistant_commits', ['unique', 'tenant_id', 'subject_user_id', 'assistant_message_id']]
  ];
  for (const [tableName, fragments] of uniqueConstraints) if (!hasConstraint(tableName, 'u', fragments)) missing.push(`${tableName}:unique:${fragments.at(-1)}`);

  const foreignKeys = [
    ['core_v0_turn_admissions', ['foreign key (tenant_id, subject_user_id)', 'references', 'core_v0_subjects']],
    ['core_v0_memory_session_bindings', ['foreign key (tenant_id, subject_user_id)', 'references', 'core_v0_subjects']],
    ['core_v0_assistant_commits', ['foreign key (tenant_id, subject_user_id)', 'references', 'core_v0_subjects']],
    ['core_v0_messages', ['foreign key (tenant_id, subject_user_id)', 'references', 'core_v0_subjects']],
    ['core_v0_admission_leases', ['foreign key (gate_id)', 'references', 'core_v0_admission_gates']]
  ];
  for (const [tableName, fragments] of foreignKeys) if (!hasConstraint(tableName, 'f', fragments)) missing.push(`${tableName}:foreign_key`);

  const checks = [
    ['core_v0_subjects', ['sequence >= 0']],
    ['core_v0_turn_admissions', ['status = any', 'admission_pending', 'committed']],
    ['core_v0_turn_admissions', ['memory_status = any', 'pending', 'available', 'degraded']],
    ['core_v0_memory_session_bindings', ['status = any', 'pending', 'completed', 'failed']],
    ['core_v0_assistant_commits', ['status = any', 'pending', 'completed', 'failed']],
    ['core_v0_messages', ['role = any', 'user', 'assistant', 'tool']],
    ['core_v0_admission_gates', ['close_epoch >= 0']],
    ['core_v0_admission_leases', ['close_epoch >= 0']],
    ['core_v0_admission_leases', ['status = any', 'active', 'released']],
    ['core_v0_repair_attempts', ['attempt >= 1']],
    ['core_v0_repair_attempts', ['status = any', 'pending', 'processing', 'completed', 'failed', 'dead_letter']],
    ['core_v0_crash_records', ['status = any', 'observed', 'reconciled', 'unresolved']]
  ];
  for (const [tableName, fragments] of checks) if (!hasConstraint(tableName, 'c', fragments)) missing.push(`${tableName}:check`);

  const activeLeaseIndex = indexesQuery.rows.some(row => row.tablename === 'core_v0_admission_leases'
    && /unique index/i.test(row.indexdef)
    && /admission_key/i.test(row.indexdef)
    && /where/i.test(row.indexdef)
    && /status\s*=\s*'active'/i.test(row.indexdef));
  if (!activeLeaseIndex) missing.push('core_v0_admission_leases:active_unique_index');
  return {
    passed: missing.length === 0,
    constraintCount: constraints.length,
    indexCount: indexesQuery.rows.length,
    missing
  };
}

async function inspectMemoryContract(rawPool, schema) {
  const query = await rawPool.query(
    'SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[])',
    [schema, memoryTableNames]
  );
  const columns = new Map();
  for (const row of query.rows) {
    if (!columns.has(row.table_name)) columns.set(row.table_name, new Set());
    columns.get(row.table_name).add(row.column_name);
  }
  const required = {
    memory_sessions: ['id', 'tenant_id', 'user_id', 'profile_snapshot_id'],
    raw_events: ['id', 'tenant_id', 'user_id', 'event_id', 'source_revision', 'content'],
    memory_idempotency_records: ['tenant_id', 'user_id', 'mutation_namespace', 'idempotency_key'],
    memory_commit_sequences: ['tenant_id', 'user_id', 'commit_seq']
  };
  const missing = [];
  for (const table of memoryTableNames) {
    if (!columns.has(table)) missing.push(`${table}:table`);
    for (const column of required[table]) if (!columns.get(table)?.has(column)) missing.push(`${table}:${column}`);
  }
  return { passed: missing.length === 0, tableCount: columns.size, missing };
}

async function inspectTls(rawPool) {
  try {
    const query = await rawPool.query('SELECT ssl,version,cipher FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
    const row = query.rows[0] || {};
    return { available: true, active: row.ssl === true, version: row.version || null, cipher: row.cipher || null };
  } catch {
    return { available: false, active: false, version: null, cipher: null };
  }
}

function spawnWorker(name, schema, gateId) {
  const child = fork(workerPath, [], {
    env: { ...process.env, CORE_V0_LIVE_SCHEMA: schema, CORE_V0_LIVE_GATE_ID: gateId, CORE_V0_LIVE_WORKER: name },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  let nextId = 0;
  let exited = false;
  const pending = new Map();
  const exitPromise = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      exited = true;
      const error = { code: `LIVE_WORKER_EXIT_${code ?? signal ?? 'UNKNOWN'}`, status: 503, retryable: true, unknown: true };
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
      resolve({ code, signal });
    });
  });
  child.on('error', error => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject({ code: normalizeCode(error, 'LIVE_WORKER_PROCESS_ERROR'), status: 503, retryable: true, unknown: true });
    }
    pending.clear();
  });
  child.on('message', message => {
    const entry = pending.get(message?.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(message.error || { code: 'LIVE_WORKER_ERROR', status: 503, retryable: true, unknown: true });
  });

  const request = (command, payload = {}) => new Promise((resolve, reject) => {
    if (exited || !child.connected) {
      reject({ code: 'LIVE_WORKER_NOT_CONNECTED', status: 503, retryable: true, unknown: true });
      return;
    }
    const id = `${name}:${++nextId}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject({ code: 'LIVE_WORKER_TIMEOUT', status: 503, retryable: true, unknown: true });
    }, 20_000);
    pending.set(id, { resolve, reject, timer });
    child.send({ id, command, payload }, error => {
      if (!error) return;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject({ code: normalizeCode(error, 'LIVE_WORKER_SEND_FAILED'), status: 503, retryable: true, unknown: true });
    });
  });

  return {
    name,
    request,
    terminate(signal = 'SIGTERM') {
      if (!exited) child.kill(signal);
    },
    waitForExit() {
      return exitPromise;
    },
    async stop() {
      if (exited) return exitPromise;
      try { await request('shutdown'); } catch { /* process cleanup below */ }
      if (!exited) child.kill('SIGTERM');
      return exitPromise;
    }
  };
}

async function settle(operation) {
  try { return { ok: true, result: await operation }; }
  catch (error) { return { ok: false, error }; }
}

async function runContextSpoofingNegativeTest() {
  const state = { memoryModule: {} };
  const runtime = createMemoryModuleRuntime({
    getState: () => state,
    getUser: () => ({ id: 'verified-user' }),
    tenantId: 'verified-tenant'
  });
  const directRequest = {
    body: { subject_user_id: 'forged-body-user', tenant_id: 'forged-body-tenant' },
    get(name) {
      const headers = {
        'x-memory-subject-user-id': 'forged-header-user',
        'x-memory-tenant-id': 'forged-header-tenant',
        'x-memory-actor-type': 'forged-actor',
        'x-caller-agent-id': 'forged-agent'
      };
      return headers[String(name).toLowerCase()] || '';
    }
  };
  const direct = runtime.contextFromRequest(directRequest, { chat: true });
  const directPass = direct.tenantId === 'verified-tenant' && direct.subjectUserId === 'verified-user';

  const secret = new TextEncoder().encode(`live-context-${randomUUID()}`);
  const issuer = 'core-v0-live-context-test';
  const audience = 'core-v0-live-context-test';
  const token = await new SignJWT({ sub: 'companion-core', subject_user_id: 'verified-service-user', tenant_id: 'verified-service-tenant' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime('5m')
    .sign(secret);
  const app = express();
  app.use(express.json());
  app.post('/context', createMemoryServiceBoundary({
    serviceId: 'companion-core',
    jwtSecret: new TextDecoder().decode(secret),
    issuer,
    audience,
    production: true
  }), (req, res) => res.json(runtime.contextFromRequest(req, { chat: true })));
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/context`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-memory-producer': 'companion-core',
        'x-correlation-id': 'live-context-correlation',
        'idempotency-key': 'live-context-key',
        'x-memory-subject-user-id': 'forged-service-header-user',
        'x-memory-tenant-id': 'forged-service-header-tenant'
      },
      body: JSON.stringify({ subject_user_id: 'forged-service-body-user', tenant_id: 'forged-service-body-tenant' })
    });
    const body = await response.json();
    const httpPass = response.status === 200
      && body.tenantId === 'verified-service-tenant'
      && body.subjectUserId === 'verified-service-user';
    return { passed: directPass && httpPass, directPass, httpPass };
  } finally {
    await withTimeout(new Promise(resolve => server.close(() => resolve())), CLEANUP_TIMEOUT_MS, 'LIVE_CONTEXT_SERVER_CLOSE_TIMEOUT');
  }
}

async function runLive(config, fixture) {
  if (!config.databaseUrlValid) throw new LiveAcceptanceError('DATABASE_URL_INVALID');
  let rawPool = null;
  const workers = [];
  const schema = `core_v0_live_${process.pid}_${Date.now()}_${randomUUID().replaceAll('-', '').slice(-8)}`;
  const gateId = `core-v0-live-gate-${process.pid}-${randomUUID().replaceAll('-', '').slice(-8)}`;
  let schemaCreated = false;
  const cleanupErrors = [];
  let cleanupStarted = false;
  const cleanup = async signal => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    for (const worker of workers) {
      try {
        await withTimeout(worker.stop(), WORKER_STOP_TIMEOUT_MS, `WORKER_${worker.name}_STOP_TIMEOUT`);
      } catch (error) {
        cleanupErrors.push(`WORKER_${worker.name}_${normalizeCode(error, 'STOP_FAILED')}`);
        worker.terminate('SIGKILL');
        try { await withTimeout(worker.waitForExit(), WORKER_STOP_TIMEOUT_MS, `WORKER_${worker.name}_KILL_TIMEOUT`); }
        catch (killError) { cleanupErrors.push(`WORKER_${worker.name}_${normalizeCode(killError, 'KILL_TIMEOUT')}`); }
      }
    }
    if (schemaCreated && rawPool) {
      try { await withTimeout(rawPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`), CLEANUP_TIMEOUT_MS, 'LIVE_SCHEMA_DROP_TIMEOUT'); }
      catch (error) { cleanupErrors.push(`SCHEMA_DROP_${normalizeCode(error, 'DROP_FAILED')}`); }
    }
    if (rawPool) {
      try { await withTimeout(rawPool.end(), CLEANUP_TIMEOUT_MS, 'LIVE_POOL_END_TIMEOUT'); }
      catch (error) { cleanupErrors.push(`POOL_END_${normalizeCode(error, 'POOL_END_FAILED')}`); }
    }
    if (cleanupErrors.length) {
      await writeArtifact({
        package: 'R-003-postgres-memoryport',
        fixture: fixture.fixture,
        mode: 'live-postgresql-isolated-schema',
        status: 'failed',
        config,
        results: [
          result('L-01', 'pending', 'live cleanup failed before promotion gate evaluation'),
          result('L-02', 'fail', 'LIVE_CLEANUP_FAILED')
        ],
        evidence: { schemaName: schema, schemaCreated, workersStarted: workers.length, cleanupErrors, signal: signal || null },
        limitations: ['Cleanup failure is fail-closed; the generated schema may require operator inspection before another run.']
      }).catch(() => {});
    }
  };
  activeCleanup = cleanup;
  try {
    rawPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: resolveDbSsl(),
      connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 10000),
      statement_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 15000),
      query_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 15000),
      max: 8
    });
    rawPool.on('error', () => {});
    await rawPool.query('SELECT 1');
    const tls = await inspectTls(rawPool);
    await rawPool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    schemaCreated = true;
    const scopedPool = createScopedPool(rawPool, schema);
    await ensureCoreV0PostgresSchema(scopedPool);
    await ensureCoreV0PostgresSchema(scopedPool);
    const memorySchema = await readFile(memorySchemaPath, 'utf8');
    await scopedPool.query(memorySchema);
    await scopedPool.query(memorySchema);
    const schemaColumns = await inspectSchema(rawPool, schema);
    const schemaContract = schemaColumns.passed ? await inspectDatabaseContract(rawPool, schema) : { passed: false, constraintCount: 0, indexCount: 0, missing: ['column_contract'] };
    const memoryContract = await inspectMemoryContract(rawPool, schema);
    const schemaEvidence = {
      passed: schemaColumns.passed && schemaContract.passed && memoryContract.passed,
      columns: schemaColumns,
      constraints: schemaContract,
      memory: memoryContract
    };
    if (!schemaEvidence.passed) throw new LiveAcceptanceError('LIVE_SCHEMA_INCOMPLETE');
    if (!memoryContract.passed) throw new LiveAcceptanceError('LIVE_MEMORY_SCHEMA_INCOMPLETE');

    workers.push(spawnWorker('worker-a', schema, gateId), spawnWorker('worker-b', schema, gateId));
    const workerInit = await Promise.all(workers.map(worker => worker.request('init')));
    const workerSchemaPass = workerInit.every(item => item?.schemaInfo?.currentSchema === schema
      && Array.isArray(item.schemaInfo.searchPath)
      && item.schemaInfo.searchPath.length === 1
      && item.schemaInfo.searchPath[0] === schema);
    if (INTERRUPT_TEST_MODE) {
      await writeArtifact({
        package: 'R-003-postgres-memoryport',
        fixture: fixture.fixture,
        mode: 'live-postgresql-isolated-schema',
        status: 'pending',
        config,
        results: [
          result('L-01', 'pending', 'interrupt-cleanup-test'),
          result('L-02', 'pending', 'interrupt-cleanup-test')
        ],
        evidence: {
          schemaName: schema,
          schemaCreated,
          workersStarted: workers.length,
          workerSchemaPass,
          interruptCleanupTest: true,
          signal: 'SIGTERM'
        },
        limitations: ['This run intentionally terminates after worker initialization to exercise signal-safe bounded cleanup.']
      });
      await handleSignal('SIGTERM');
      return { summary: null, workers, rawPool, schema, schemaCreated };
    }

    const casSettled = await Promise.all(workers.map(worker => settle(worker.request('persist'))));
    const winners = casSettled.filter(item => item.ok && item.result?.status === 'saved');
    const losers = casSettled.filter(item => !item.ok);
    const winnerRows = await scopedPool.query(
      'SELECT turn_id,idempotency_key,fingerprint,event_id,source_revision,commit_id,status,raw_event_receipt FROM core_v0_turn_admissions WHERE tenant_id=$1 AND subject_user_id=$2',
      [context.tenantId, context.subjectUserId]
    );
    const winnerRow = winnerRows.rows[0] || null;
    const loserConflict = losers.length === 1 && normalizeCode(losers[0].error) === 'CORE_STORAGE_CONFLICT';
    const casPass = winners.length === 1 && losers.length === 1 && winnerRows.rows.length === 1 && loserConflict;

    const loserIndex = casSettled.findIndex(item => !item.ok);
    const replaySettled = loserIndex >= 0 ? await settle(workers[loserIndex].request('replay')) : { ok: false, error: { code: 'LIVE_REPLAY_WORKER_MISSING' } };
    const conflictReplaySettled = loserIndex >= 0 ? await settle(workers[loserIndex].request('replay-conflict')) : { ok: false, error: { code: 'LIVE_REPLAY_WORKER_MISSING' } };
    const replayPass = replaySettled.ok
      && replaySettled.result?.status === 'committed'
      && replaySettled.result?.replay === true
      && replaySettled.result?.turnId === winnerRow?.turn_id;
    const conflictReplayPass = conflictReplaySettled.ok
      && conflictReplaySettled.result?.status === 'rejected'
      && conflictReplaySettled.result?.code === fixture.expected.changedReplayError;

    const winnerIndex = casSettled.findIndex(item => item.ok && item.result?.status === 'saved');
    const memoryWriteSettled = winnerIndex >= 0
      ? await settle(workers[winnerIndex].request('memory-write', { turnId: winnerRow?.turn_id }))
      : { ok: false, error: { code: 'LIVE_WINNER_WORKER_MISSING' } };
    const memoryWritePass = memoryWriteSettled.ok
      && memoryWriteSettled.result?.status === 'completed'
      && memoryWriteSettled.result?.eventId === winnerRow?.event_id
      && String(memoryWriteSettled.result?.sourceRevision) === String(winnerRow?.source_revision);

    const leaseSettled = winnerRow
      ? await settle(workers[0].request('gate-enter', { key: 'live-drain-key', turnId: winnerRow.turn_id }))
      : { ok: false, error: { code: 'LIVE_WINNER_TURN_MISSING' } };
    const timeoutSettled = await settle(workers[1].request('gate-disable', { timeoutMs: 0 }));
    const timeout = timeoutSettled.ok ? timeoutSettled.result : null;
    const postCloseSettled = await settle(workers[1].request('gate-enter', { key: 'live-after-close-key', turnId: 'turn:live-after-close' }));
    const releaseSettled = leaseSettled.ok ? await settle(workers[0].request('gate-release', { leaseId: leaseSettled.result.leaseId })) : { ok: false, error: { code: 'LIVE_LEASE_MISSING' } };
    const drainedSettled = await settle(workers[1].request('gate-disable', { timeoutMs: 1000 }));
    const gateRow = (await scopedPool.query('SELECT gate_id,enabled,close_epoch FROM core_v0_admission_gates WHERE gate_id=$1', [gateId])).rows[0] || null;
    const activeLeases = await scopedPool.query("SELECT lease_id,turn_id,status FROM core_v0_admission_leases WHERE gate_id=$1 AND status='active'", [gateId]);
    const gateRepair = winnerRow
      ? (await scopedPool.query('SELECT repair_attempt_id,status,turn_id,external_receipt_status,external_receipt_id,core_commit_id FROM core_v0_repair_attempts WHERE gate_id=$1 AND turn_id=$2 AND operation=$3', [gateId, winnerRow.turn_id, 'drain_timeout'])).rows[0] || null
      : null;
    const gatePass = leaseSettled.ok
      && leaseSettled.result?.closeEpoch === 0
      && timeout?.status === fixture.expected.gateCloseStatus
      && timeout?.activeIds?.includes(winnerRow?.turn_id)
      && timeout?.repairRecorded === true
      && postCloseSettled.ok === false
      && normalizeCode(postCloseSettled.error) === fixture.expected.postCloseAdmission
      && releaseSettled.ok
      && drainedSettled.ok
      && drainedSettled.result?.status === fixture.expected.drainStatus
      && gateRow?.enabled === false
      && Number(gateRow?.close_epoch) === 1
      && activeLeases.rows.length === 0
      && gateRepair?.status === 'pending'
      && gateRepair?.external_receipt_status === 'unknown';

    const memoryRepository = createMemoryModulePostgresRepository(scopedPool);
    const memoryPort = createPostgresMemoryPort({ repository: memoryRepository, context, retryAttempts: 0 });
    const recorder = createCoreV0RepairRecorder({ pool: scopedPool, operatorId: 'live-parent-reconciler' });
    const reconciliation = gateRepair
      ? await recorder.reconcile({
        repairAttemptId: gateRepair.repair_attempt_id,
        receiptLookup: async ({ repair }) => {
          // The recorder writes whatever status we hand back straight into
          // core_v0_repair_attempts.external_receipt_status, whose domain is
          // unknown | pending | completed | failed (validateReceiptStatus in
          // server/core-v0-postgres.js). The Memory side speaks its own
          // vocabulary (it reports 'not_found' for a missing receipt), so the
          // status must be normalised at this boundary. Anything not
          // representable in the Core domain means "no authoritative receipt
          // yet", i.e. 'unknown' -- returning it raw makes reconcile throw
          // REPAIR_METADATA_INVALID (2026-09-12, twice).
          const coreReceiptStatuses = new Set(['unknown', 'pending', 'completed', 'failed']);
          const toCoreReceiptStatus = value => {
            const normalized = String(value || '').toLowerCase();
            if (coreReceiptStatuses.has(normalized)) return normalized;
            if (String(process.env.CORE_V0_LIVE_DEBUG || '').toLowerCase() === 'true') {
              console.error(JSON.stringify({ event: 'live_receipt_status_normalised', from: normalized || null, to: 'unknown' }));
            }
            return 'unknown';
          };
          const row = (await scopedPool.query('SELECT event_id,source_revision FROM core_v0_turn_admissions WHERE tenant_id=$1 AND subject_user_id=$2 AND turn_id=$3', [context.tenantId, context.subjectUserId, repair.turn_id])).rows[0];
          // An absent admission row means there is no authoritative receipt yet;
          // the absence itself is authoritative, so the flag stays true.
          if (!row) return { authoritative: true, status: 'unknown', turnId: repair.turn_id };
          const receipt = await memoryPort.getRawEventReceipt({ eventId: row.event_id, sourceRevision: row.source_revision });
          const payload = receipt?.receipt || receipt;
          return {
            ...receipt,
            authoritative: receipt?.authoritative === true,
            status: toCoreReceiptStatus(receipt?.status || payload?.status),
            receiptId: receipt?.receiptId || payload?.receiptId || payload?.rawEventId || receipt?.rawEventId || null,
            turnId: repair.turn_id
          };
        },
        coreCommitLookup: async ({ repair }) => {
          const row = (await scopedPool.query('SELECT commit_id,turn_id,status FROM core_v0_assistant_commits WHERE tenant_id=$1 AND subject_user_id=$2 AND turn_id=$3', [context.tenantId, context.subjectUserId, repair.turn_id])).rows[0];
          return row
            ? { authoritative: true, status: row.status, commitId: row.commit_id, turnId: row.turn_id }
            : { authoritative: true, status: 'not_found', turnId: repair.turn_id };
        }
      })
      : { status: 'pending' };
    const reconciledRepair = gateRepair
      ? (await scopedPool.query('SELECT status,turn_id,external_receipt_status,external_receipt_id,core_commit_id FROM core_v0_repair_attempts WHERE repair_attempt_id=$1', [gateRepair.repair_attempt_id])).rows[0] || null
      : null;
    const repairPass = reconciliation.status === 'completed'
      && reconciliation.externalReceiptId === reconciledRepair?.external_receipt_id
      && reconciliation.coreCommitId === reconciledRepair?.core_commit_id
      && reconciledRepair?.status === fixture.expected.repairStatus
      && reconciledRepair?.turn_id === winnerRow?.turn_id
      && reconciledRepair?.external_receipt_status === 'completed';

    const contextSpoofing = await runContextSpoofingNegativeTest();
    const liveL02Pass = schemaEvidence.passed && workerSchemaPass && casPass && replayPass && conflictReplayPass && memoryWritePass && gatePass && repairPass;
    const authConfigPass = config.authRequired && config.storagePostgres && config.supabaseConfigured;
    const l01PendingReasons = [];
    if (!authConfigPass) l01PendingReasons.push('AUTH_STORAGE_CONFIGURATION_REQUIRED');
    if (!config.strictTlsConfigured) l01PendingReasons.push('STRICT_TLS_CONFIGURATION_REQUIRED');
    if (!tls.active) l01PendingReasons.push('DATABASE_TLS_NOT_ACTIVE');
    if (!contextSpoofing.passed) l01PendingReasons.push('CONTEXT_SPOOFING_NEGATIVE_FAILED');
    const l01Status = contextSpoofing.passed && authConfigPass && config.strictTlsConfigured && tls.active
      ? 'passed'
      : contextSpoofing.passed && (!authConfigPass || !config.strictTlsConfigured || !tls.active) ? 'pending' : 'fail';
    const summary = {
      package: 'R-003-postgres-memoryport',
      fixture: fixture.fixture,
      mode: 'live-postgresql-isolated-schema',
      status: liveL02Pass && l01Status === 'passed' ? 'passed' : liveL02Pass && l01Status === 'pending' ? 'pending' : 'failed',
      config: { ...config, databaseTlsActive: tls.active, contextSpoofingPassed: contextSpoofing.passed },
      results: [
        result('L-01', l01Status, l01Status === 'passed' ? 'required Auth/storage configuration, verified TLS and context-spoofing negative test passed' : l01PendingReasons.join(',')),
        result('L-02', liveL02Pass ? 'passed' : 'fail', liveL02Pass ? 'real PostgreSQL schema, two-process CAS, replay, gate and repair checks passed' : 'one or more real PostgreSQL checks failed')
      ],
      evidence: {
        schemaName: schema,
        schemaCreated,
        schemaEvidence,
        migrationRerun: true,
        workers: workers.map(worker => worker.name),
        workerSchemaPass,
        workerInit: workerInit.map(item => ({ worker: item.worker, schemaInfo: item.schemaInfo })),
        cas: {
          winnerCount: winners.length,
          loserCount: losers.length,
          loserError: losers[0] ? normalizeCode(losers[0].error) : null,
          persistedTurnCount: winnerRows.rows.length,
          winnerTurnId: winnerRow?.turn_id || null,
          replayTurnId: replaySettled.result?.turnId || null,
          replayPass,
          changedReplayPass: conflictReplayPass,
          memoryWritePass,
          memoryWriteError: memoryWriteSettled.ok ? null : {
            code: normalizeCode(memoryWriteSettled.error),
            status: Number(memoryWriteSettled.error?.status || 0) || null,
            unknown: memoryWriteSettled.error?.unknown === true
          },
          memoryWriteResult: memoryWriteSettled.ok
            ? { status: memoryWriteSettled.result?.status || null, rawEventIdPresent: Boolean(memoryWriteSettled.result?.rawEventId) }
            : null,
          memoryEventId: memoryWriteSettled.result?.rawEventId || null
        },
        gate: {
          closeStatus: timeout?.status || null,
          postCloseAdmission: postCloseSettled.ok ? 'unexpected_success' : normalizeCode(postCloseSettled.error),
          drainedStatus: drainedSettled.result?.status || null,
          closeEpoch: Number(gateRow?.close_epoch || 0),
          activeLeasesAfterDrill: activeLeases.rows.length,
          repairAttemptId: gateRepair?.repair_attempt_id || null,
          repairStatus: reconciledRepair?.status || null,
          externalReceiptStatus: reconciledRepair?.external_receipt_status || null,
          externalReceiptId: reconciledRepair?.external_receipt_id || null,
          coreCommitId: reconciledRepair?.core_commit_id || null,
          repairPass,
          rollbackPolicy: 'deferred_to_deployment'
        },
        databaseTls: tls,
        contextSpoofing
      },
      limitations: [
        'The schema was created with a generated core_v0_live_ prefix and dropped after the run.',
        'The live harness proves the Core persistence/lifecycle slice; it does not switch application traffic or promote the legacy route.'
      ]
    };
    await writeArtifact(summary);
    return { summary, workers, rawPool, schema, schemaCreated };
  } catch (error) {
    await writeArtifact({
      package: 'R-003-postgres-memoryport',
      fixture: fixture.fixture,
      mode: 'live-postgresql-isolated-schema',
      status: 'failed',
      config,
      results: [result('L-01', 'pending', 'live run failed before promotion gate evaluation'), result('L-02', 'fail', normalizeCode(error))],
      evidence: { schemaName: schema, schemaCreated, workersStarted: workers.length },
      limitations: ['Failure output is code-only; connection strings, credentials and message content are omitted.']
    });
    throw error;
  } finally {
    await cleanup();
    activeCleanup = null;
    if (cleanupErrors.length) throw new LiveAcceptanceError('LIVE_CLEANUP_FAILED');
  }
}

async function main() {
  const config = configSnapshot();
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const reasons = [];
  if (!config.optedIn) reasons.push('CORE_V0_LIVE_ACCEPTANCE_REQUIRED');
  if (!config.isolatedEnvironment) reasons.push('CORE_V0_LIVE_ENV_ISOLATED_REQUIRED');
  if (!config.databaseConfigured) reasons.push('DATABASE_URL_REQUIRED');
  if (reasons.length) {
    const summary = await writeArtifact(pendingSummary(config, reasons));
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 2;
    return;
  }
  try {
    const { summary } = await runLive(config, fixture);
    console.log(JSON.stringify(summary, null, 2));
    if (summary.status === 'pending') process.exitCode = 2;
    else if (summary.status === 'failed') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ package: 'R-003-postgres-memoryport', status: 'failed', code: normalizeCode(error) }));
    process.exitCode = 1;
  }
}

await main();
