#!/usr/bin/env node
// One-shot equivalence check for the "shrink-then-merge" hybrid retrieval SQL
// (lane/prefetch-rrf). Spins a DISPOSABLE PostgreSQL cluster (initdb in /tmp,
// port 5494), seeds synthetic index documents, and compares final top-K
// result ID sequences of:
//   legacy  : join-then-limit flat query (pre-change shape)
//   narrowed: WITH narrowed AS (...) shrink-then-merge (new builder)
// for the lexical and vector channels, at prefetch depth N=100 and N=200.
//
// Seed includes two stale-assertion regimes per subject:
//   user-0/user-1: ~10% join-ineligible assertions (a.status='candidate')
//   user-2/user-3: ~60% join-ineligible assertions
// so the only behavioural drift surface (narrowed docs dropped after the
// join) is actually exercised instead of assumed away.
//
// Run OUTSIDE the sandbox, with NODE_OPTIONS cleared:
//   env -u NODE_OPTIONS node scripts/prefetch-equivalence-check.mjs
// Posture follows scripts/pitr-drill.mjs: LC_ALL=C LANG=C, no production
// ports/credentials, cluster stopped and data dir removed at the end.

import { spawn } from 'node:child_process';
import { mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { buildPgvectorMigrationSql } from '../server/memory-module-pgvector.js';
import { buildPostgresIndexCandidateQuery } from '../server/memory-module-postgres-retrieval.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG_BIN = '/opt/homebrew/opt/postgresql@17/bin';
const SCHEMA_SQL = path.join(REPO_ROOT, 'server', 'memory-module-schema.sql');
const PORT = 5494;
const SUPERUSER = 'equivalence';
const DB = 'equivdb';
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const BASE = `/tmp/prefetch-equiv-${TS}`;
const DATA_DIR = path.join(BASE, 'data');
const LOG_DIR = path.join(BASE, 'logs');
const CONNECTION = `postgres://${SUPERUSER}@127.0.0.1:${PORT}/${DB}`;

const DOCUMENT_COUNT = Number(process.env.EQUIV_DOCS || 20_000);
const TENANT_COUNT = 2;
const USER_COUNT = 4;
const FINAL_LIMIT = 50;
const PREFETCH_DEPTHS = [100, 200];
const POLICY_VERSION = 'memory-policy-v1';
const TENANT_PREFIX = `prefetch-equiv-${TS}-`;
const ID_PREFIX = `equiv-${TS}-`;
const PRIMARY_TENANT = `${TENANT_PREFIX}tenant-0`;

const LEXICAL_QUERIES = ['topic-7 red tea', 'topic-3', 'red tea note', 'topic-11', 'no-such-token-xyz', 'tea'];
const VECTOR_QUERIES = [[1, 0.2], [0.3, 0.9], [0.99, 0.1], [0.5, 0.5]];
const PROBE_USERS = ['user-0', 'user-2']; // healthy ~10% stale vs stale-heavy ~60%

function run(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      env: { ...process.env, PATH: `${PG_BIN}:${process.env.PATH}`, PGPASSWORD: '', NODE_OPTIONS: '', LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout: out, stderr: err }));
  });
}

// Legacy shape: the pre-change flat query — join all payload tables, filter,
// sort the FULL candidate set, then LIMIT. Reproduced here verbatim (user
// actor) so the comparison is against the exact SQL that was benchmarked.
function buildLegacyQuery({ tenantId, subjectUserId, purpose = 'answer_user_query', query, queryVector = null, mode = 'lexical', limit = FINAL_LIMIT }) {
  const params = [tenantId, subjectUserId];
  const conditions = [
    'd.tenant_id = $1',
    'd.user_id = $2',
    "d.index_status = 'active'",
    "a.status = 'active'",
    "v.version_status = 'current'",
    'd.source_id = a.id',
    'd.source_version = v.id',
    'v.assertion_id = a.id',
    '(a.expires_at IS NULL OR a.expires_at > $3::timestamptz)',
    '(v.valid_from IS NULL OR v.valid_from <= $3::timestamptz)',
    '(v.valid_to IS NULL OR v.valid_to > $3::timestamptz)',
    'd.redaction_epoch = COALESCE(redaction.privacy_epoch, 0)',
    'd.policy_epoch = $4'
  ];
  params.push(new Date().toISOString(), POLICY_VERSION);
  let scoreExpression;
  let orderBy;
  if (mode === 'vector') {
    params.push(`[${queryVector.join(',')}]`);
    const vectorParam = `$${params.length}`;
    scoreExpression = `1 - (d.embedding_vector <=> ${vectorParam}::vector)`;
    conditions.push('d.embedding_vector IS NOT NULL');
    orderBy = `d.embedding_vector <=> ${vectorParam}::vector ASC, d.id ASC`;
  } else {
    params.push(String(query).trim());
    const queryParam = `$${params.length}`;
    scoreExpression = `ts_rank_cd(to_tsvector('simple', d.search_text), websearch_to_tsquery('simple', ${queryParam}))
      + CASE WHEN d.search_text ILIKE '%' || ${queryParam} || '%' THEN 0.1 ELSE 0 END`;
    conditions.push(`(
      to_tsvector('simple', d.search_text) @@ websearch_to_tsquery('simple', ${queryParam})
      OR d.search_text ILIKE '%' || ${queryParam} || '%'
    )`);
    orderBy = `candidate_score DESC, d.id ASC`;
  }
  params.push(limit);
  const limitParam = `$${params.length}`;
  const sql = `
    SELECT
      d.source_id AS memory_id,
      ${scoreExpression} AS candidate_score
    FROM index_documents d
    JOIN memory_assertions a ON a.tenant_id = d.tenant_id AND a.user_id = d.user_id AND a.id = d.source_id
    JOIN assertion_versions v ON v.tenant_id = d.tenant_id AND v.assertion_id = a.id AND v.id = d.source_version
    LEFT JOIN redaction_epochs redaction ON redaction.tenant_id = d.tenant_id AND redaction.user_id = d.user_id
    WHERE ${conditions.join('\n      AND ')}
    ORDER BY ${orderBy}
    LIMIT ${limitParam}
  `;
  return { sql, params };
}

function narrowedQuery({ tenantId, subjectUserId, purpose = 'answer_user_query', query, queryVector = null, mode = 'lexical', narrowLimit }) {
  return buildPostgresIndexCandidateQuery({
    tenantId,
    subjectUserId,
    purpose,
    query,
    queryVector,
    mode,
    policyVersion: POLICY_VERSION,
    limit: FINAL_LIMIT,
    narrowLimit
  });
}

function idsOf(rows) {
  return rows.map(row => row.memory_id);
}

function compare(oldIds, newIds) {
  const oldSet = new Set(oldIds);
  const newSet = new Set(newIds);
  let intersection = 0;
  for (const id of oldSet) if (newSet.has(id)) intersection += 1;
  const union = new Set([...oldSet, ...newSet]).size;
  let positionAgreement = 0;
  const length = Math.min(oldIds.length, newIds.length);
  for (let index = 0; index < length; index += 1) if (oldIds[index] === newIds[index]) positionAgreement += 1;
  let firstDivergence = null;
  for (let index = 0; index < Math.max(oldIds.length, newIds.length); index += 1) {
    if (oldIds[index] !== newIds[index]) { firstDivergence = index; break; }
  }
  return {
    overlapPct: oldSet.size ? Number(((intersection / oldSet.size) * 100).toFixed(2)) : 100,
    jaccardPct: union ? Number(((intersection / union) * 100).toFixed(2)) : 100,
    positionAgreement,
    identical: oldIds.length === newIds.length && positionAgreement === oldIds.length,
    firstDivergence,
    onlyInLegacy: [...oldSet].filter(id => !newSet.has(id)).slice(0, 5),
    onlyInNarrowed: [...newSet].filter(id => !oldSet.has(id)).slice(0, 5)
  };
}

async function timedQuery(pool, sql, params, repeats = 3) {
  const durations = [];
  let rows = [];
  for (let attempt = 0; attempt < repeats; attempt += 1) {
    const started = performance.now();
    const result = await pool.query(sql, params);
    durations.push(performance.now() - started);
    rows = result.rows;
  }
  return { rows, avgMs: Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(1)) };
}

async function seed(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL synchronous_commit = off');
    // Users 0-1: ~10% stale assertions; users 2-3: ~60% stale (g%10<6 gate).
    await client.query(`
      INSERT INTO memory_assertions (
        id, tenant_id, user_id, scope_type, memory_type, assertion_type,
        canonical_key, status, subject_type, subject_id, sensitivity,
        confidence, importance, retention_policy, recall_policy,
        auto_recall_allowed, mention_policy, direct_query_policy,
        resource_revision, created_at, updated_at
      )
      SELECT
        $5::text || 'assertion-' || g::text,
        $1::text || 'tenant-' || (g % $2::int)::text,
        $1::text || 'user-' || (g % $3::int)::text,
        'user', 'equiv_fact', 'observed_fact',
        'equiv-key-' || (g % 37)::text,
        CASE
          WHEN (g % $3::int) >= 2 THEN CASE WHEN g % 10 < 6 THEN 'candidate' ELSE 'active' END
          ELSE CASE WHEN g % 10 = 9 THEN 'candidate' ELSE 'active' END
        END,
        'user', $1::text || 'user-' || (g % $3::int)::text, 'S0',
        0.9, 0.5, 'default_s0', 'default', true, 'mentionable', 'allow', 1, now(), now()
      FROM generate_series(0, $4::int - 1) AS rows(g)
    `, [TENANT_PREFIX, TENANT_COUNT, USER_COUNT, DOCUMENT_COUNT, ID_PREFIX]);
    await client.query(`
      INSERT INTO assertion_versions (
        id, tenant_id, assertion_id, content, structured_data, content_type,
        trust_level, observed_at, version_status, created_by,
        promotion_reason, promotion_policy_version, created_at
      )
      SELECT
        $4::text || 'version-' || g::text,
        $1::text || 'tenant-' || (g % $2::int)::text,
        $4::text || 'assertion-' || g::text,
        'equiv topic-' || (g % 23)::text || ' red tea note ' || (g % 101)::text,
        '{}'::jsonb, 'plain_text', 'user_explicit', now(), 'current',
        'user', 'equiv_seed', 'equiv-v1', now()
      FROM generate_series(0, $3::int - 1) AS rows(g)
    `, [TENANT_PREFIX, TENANT_COUNT, DOCUMENT_COUNT, ID_PREFIX]);
    await client.query(`
      UPDATE memory_assertions
         SET current_version_id = $2::text || 'version-' || replace(id, $2::text || 'assertion-', '')
       WHERE tenant_id LIKE $1::text
    `, [`${TENANT_PREFIX}%`, ID_PREFIX]);
    await client.query(`
      INSERT INTO index_documents (
        id, tenant_id, source_type, source_id, source_version, user_id,
        scope_type, search_text, sensitivity, contextualizable, mentionable,
        redaction_epoch, policy_epoch, grant_version, embedding,
        embedding_vector, embedding_version, lexical_version, index_status,
        source_refs, created_at
      )
      SELECT
        $6::text || 'index-' || g::text,
        $1::text || 'tenant-' || (g % $2::int)::text,
        'assertion', $6::text || 'assertion-' || g::text, $6::text || 'version-' || g::text,
        $1::text || 'user-' || (g % $3::int)::text, 'user',
        'equiv topic-' || (g % 23)::text || ' red tea note ' || (g % 101)::text,
        'S0', true, true, 0, $4, 0,
        NULL,
        ('[' || round(cos(g * 0.7)::numeric, 6)::text || ',' || round(sin(g * 1.3)::numeric, 6)::text || ']')::vector,
        'equiv-v1', 'bm25-v1', 'active',
        ARRAY['equiv-source-' || g::text], now()
      FROM generate_series(0, $5::int - 1) AS rows(g)
    `, [TENANT_PREFIX, TENANT_COUNT, USER_COUNT, POLICY_VERSION, DOCUMENT_COUNT, ID_PREFIX]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await pool.query('ANALYZE memory_assertions; ANALYZE assertion_versions; ANALYZE index_documents');
}

let vectorEnabled = true;
let exitCode = 0;
const report = { event: 'prefetch_equivalence_check', documentCount: DOCUMENT_COUNT, finalLimit: FINAL_LIMIT, prefetchDepths: PREFETCH_DEPTHS, comparisons: [] };

try {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  let step = await run(`${PG_BIN}/initdb`, ['-D', DATA_DIR, '-U', SUPERUSER, '-A', 'trust', '--encoding=UTF8', '--locale=C']);
  if (!step.ok) throw new Error(`initdb failed: ${step.stderr}`);
  step = await run(`${PG_BIN}/pg_ctl`, ['-D', DATA_DIR, '-o', `-p ${PORT} -k /tmp -c listen_addresses=127.0.0.1`, '-l', `${LOG_DIR}/cluster.log`, 'start']);
  if (!step.ok) throw new Error(`pg_ctl start failed: ${step.stderr}`);

  const admin = new pg.Pool({ connectionString: `postgres://${SUPERUSER}@127.0.0.1:${PORT}/postgres` });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await admin.query('SELECT 1'); break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: CONNECTION, max: 4 });
  pool.on('error', () => {}); // cluster teardown in `finally` may kill idle clients
  await pool.query(await readFile(SCHEMA_SQL, 'utf8'));
  try {
    await pool.query(buildPgvectorMigrationSql(2));
  } catch (error) {
    vectorEnabled = false;
    report.vectorChannel = `skipped: pgvector extension unavailable (${error.message.split('\n')[0]})`;
  }

  const seedStart = performance.now();
  await seed(pool);
  report.seedMs = Number((performance.now() - seedStart).toFixed(0));

  const context = tenantId => ({ tenantId, subjectUserId: `${TENANT_PREFIX}${tenantId}` });
  for (const user of PROBE_USERS) {
    for (const query of LEXICAL_QUERIES) {
      const entry = { channel: 'lexical', query, user, staleRegime: user === 'user-0' ? '~10%' : '~60%', depths: [] };
      const legacy = await timedQuery(pool, ...(() => { const built = buildLegacyQuery({ tenantId: PRIMARY_TENANT, subjectUserId: `${TENANT_PREFIX}${user}`, query }); return [built.sql, built.params]; })());
      entry.legacyAvgMs = legacy.avgMs;
      entry.legacyCount = legacy.rows.length;
      for (const depth of PREFETCH_DEPTHS) {
        const built = narrowedQuery({ tenantId: PRIMARY_TENANT, subjectUserId: `${TENANT_PREFIX}${user}`, query, narrowLimit: depth });
        const narrowed = await timedQuery(pool, built.sql, built.params);
        entry.depths.push({ narrowLimit: depth, avgMs: narrowed.avgMs, count: narrowed.rows.length, ...compare(idsOf(legacy.rows), idsOf(narrowed.rows)) });
      }
      report.comparisons.push(entry);
    }
    if (vectorEnabled) {
      for (const queryVector of VECTOR_QUERIES) {
        const entry = { channel: 'vector', query: `[${queryVector.join(',')}]`, user, staleRegime: user === 'user-0' ? '~10%' : '~60%', depths: [] };
        const legacy = await timedQuery(pool, ...(() => { const built = buildLegacyQuery({ tenantId: PRIMARY_TENANT, subjectUserId: `${TENANT_PREFIX}${user}`, query: 'vector', queryVector, mode: 'vector' }); return [built.sql, built.params]; })());
        entry.legacyAvgMs = legacy.avgMs;
        entry.legacyCount = legacy.rows.length;
        for (const depth of PREFETCH_DEPTHS) {
          const built = narrowedQuery({ tenantId: PRIMARY_TENANT, subjectUserId: `${TENANT_PREFIX}${user}`, query: 'vector', queryVector, mode: 'vector', narrowLimit: depth });
          const narrowed = await timedQuery(pool, built.sql, built.params);
          entry.depths.push({ narrowLimit: depth, avgMs: narrowed.avgMs, count: narrowed.rows.length, ...compare(idsOf(legacy.rows), idsOf(narrowed.rows)) });
        }
        report.comparisons.push(entry);
      }
    }
  }

  const allDepths = report.comparisons.flatMap(entry => entry.depths);
  report.summary = {
    comparisonCount: allDepths.length / PREFETCH_DEPTHS.length,
    minOverlapPct: Math.min(...allDepths.map(depth => depth.overlapPct)),
    fullyIdenticalResults: allDepths.filter(depth => depth.identical).length,
    totalDepthsRun: allDepths.length,
    vectorChannelEnabled: vectorEnabled
  };
  const divergent = allDepths.filter(depth => !depth.identical);
  if (divergent.length) {
    exitCode = 1;
    report.summary.divergentCount = divergent.length;
  }
  console.log(JSON.stringify(report, null, 2));
  await pool.end();
} catch (error) {
  console.error(JSON.stringify({ event: 'prefetch_equivalence_check_failed', message: error.message, stack: error.stack?.split('\n').slice(0, 4) }));
  exitCode = 1;
} finally {
  await run(`${PG_BIN}/pg_ctl`, ['-D', DATA_DIR, '-m', 'fast', 'stop']);
  await rm(BASE, { recursive: true, force: true });
  console.error(JSON.stringify({ event: 'prefetch_equivalence_check_cleanup', dataDirRemoved: BASE, productionUntouched: 'port 5494 only; no .env credentials; no repo state modified' }));
}
process.exit(exitCode);
