// Unit coverage for the R-004 production boundary: schema readiness is a
// structural contract (tables plus required columns), not a table-existence
// probe, and a database that is unreachable or structurally incomplete must
// never be reported as ready.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CORE_V0_PRODUCTION_REQUIRED_COLUMNS,
  CORE_V0_PRODUCTION_TABLES,
  MEMORY_PRODUCTION_REQUIRED_COLUMNS,
  MEMORY_PRODUCTION_TABLES,
  prepareCoreV0ProductionSchema,
  resetCoreV0ProductionSchemaCache
} from './core-v0-production.js';

const ALL_COLUMNS = { ...CORE_V0_PRODUCTION_REQUIRED_COLUMNS, ...MEMORY_PRODUCTION_REQUIRED_COLUMNS };
const ALL_TABLES = [...CORE_V0_PRODUCTION_TABLES, ...MEMORY_PRODUCTION_TABLES];

const allColumnKeys = () => new Set(
  Object.entries(ALL_COLUMNS).flatMap(([table, columns]) => columns.map(column => `${table}.${column}`))
);

const memoryOnlyColumnKeys = () => new Set(
  Object.entries(ALL_COLUMNS)
    .filter(([table]) => MEMORY_PRODUCTION_REQUIRED_COLUMNS[table])
    .flatMap(([table, columns]) => columns.map(column => `${table}.${column}`))
);

// A controlled pool that answers the two information_schema probes the
// readiness check issues. DDL is recorded rather than interpreted.
function fakePool({ tables = new Set(ALL_TABLES), columns = allColumnKeys(), failProbe = false } = {}) {
  const queries = [];
  const executor = {
    queries,
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalized, values });
      if (/information_schema\.tables/i.test(normalized)) {
        if (failProbe) throw Object.assign(new Error('connection terminated'), { code: 'ECONNREFUSED' });
        const names = Array.isArray(values?.[0]) ? values[0] : [];
        return { rows: names.filter(name => tables.has(name)).map(table_name => ({ table_name })) };
      }
      if (/information_schema\.columns/i.test(normalized)) {
        if (failProbe) throw Object.assign(new Error('connection terminated'), { code: 'ECONNREFUSED' });
        const names = Array.isArray(values?.[0]) ? values[0] : [];
        return {
          rows: names.flatMap(table_name => (ALL_COLUMNS[table_name] || [])
            .filter(column_name => columns.has(`${table_name}.${column_name}`))
            .map(column_name => ({ table_name, column_name })))
        };
      }
      if (/pg_advisory_(lock|unlock)/i.test(normalized)) return { rows: [] };
      return { rows: [] };
    },
    async connect() { return executor; },
    release() {}
  };
  return executor;
}

const readinessOnly = { production: false, autoMigrate: false };

test('readiness passes when every required table and column is present', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool();
  const result = await prepareCoreV0ProductionSchema(pool, readinessOnly);
  assert.equal(result.coreReady, true);
  assert.equal(result.memoryReady, true);
  assert.equal(result.migrated, false);
  assert.deepEqual(result.missing, []);
});

test('readiness fails with retryable NOT_READY when required columns are absent', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool({ columns: new Set() });
  await assert.rejects(
    () => prepareCoreV0ProductionSchema(pool, readinessOnly),
    error => {
      assert.equal(error.code, 'CORE_V0_SCHEMA_NOT_READY');
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true);
      return true;
    }
  );
});

test('readiness details name the specific tables with missing columns', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool({ columns: memoryOnlyColumnKeys() });
  await assert.rejects(
    () => prepareCoreV0ProductionSchema(pool, readinessOnly),
    error => {
      assert.equal(error.code, 'CORE_V0_SCHEMA_NOT_READY');
      const incompleteCore = error.details?.incompleteCore || {};
      assert.ok(Object.keys(incompleteCore).length > 0, 'Core incompleteness must be reported');
      assert.ok(incompleteCore.core_v0_messages?.includes('subject_user_id'));
      assert.deepEqual(error.details.incompleteMemory || {}, {}, 'Memory is complete and must not be blamed');
      return true;
    }
  );
});

test('missing tables are reported separately from missing columns', async () => {
  resetCoreV0ProductionSchemaCache();
  const tables = new Set(ALL_TABLES.filter(name => name !== 'core_v0_messages'));
  const pool = fakePool({ tables });
  await assert.rejects(
    () => prepareCoreV0ProductionSchema(pool, readinessOnly),
    error => {
      assert.deepEqual(error.details?.missingCore, ['core_v0_messages']);
      assert.deepEqual(error.details?.missingMemory, []);
      return true;
    }
  );
});

test('an unreachable database is a check failure, never a ready or JSON success', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool({ failProbe: true });
  await assert.rejects(
    () => prepareCoreV0ProductionSchema(pool, readinessOnly),
    error => error.code === 'CORE_V0_SCHEMA_CHECK_FAILED' && error.retryable === true
  );
});

test('production never applies DDL even when the schema is incomplete', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool({ tables: new Set(), columns: new Set() });
  await assert.rejects(
    () => prepareCoreV0ProductionSchema(pool, {
      production: true,
      autoMigrate: true,
      coreSchemaSql: 'DDL-CORE',
      memorySchemaSql: 'DDL-MEMORY'
    }),
    error => error.code === 'CORE_V0_SCHEMA_NOT_READY'
  );
  assert.equal(pool.queries.some(entry => /^DDL-(CORE|MEMORY)$/.test(entry.sql)), false);
});

test('explicit migration applies both DDL scripts under the migration lock', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool({ tables: new Set(), columns: new Set() });
  await assert.rejects(
    () => prepareCoreV0ProductionSchema(pool, {
      production: false,
      autoMigrate: true,
      coreSchemaSql: 'DDL-CORE',
      memorySchemaSql: 'DDL-MEMORY'
    }),
    error => error.code === 'CORE_V0_SCHEMA_NOT_READY'
  );
  const ddl = pool.queries.filter(entry => /^DDL-(CORE|MEMORY)$/.test(entry.sql)).map(entry => entry.sql);
  assert.deepEqual(ddl, ['DDL-CORE', 'DDL-MEMORY']);
  assert.ok(pool.queries.some(entry => /pg_advisory_lock/.test(entry.sql)), 'migration must hold the advisory lock');
});

test('migration that cannot repair the structure still ends in NOT_READY', async () => {
  resetCoreV0ProductionSchemaCache();
  const tables = new Set(ALL_TABLES);
  const pool = fakePool({ tables, columns: new Set() });
  await assert.rejects(
    () => prepareCoreV0ProductionSchema(pool, {
      production: false,
      autoMigrate: true,
      coreSchemaSql: 'DDL-CORE',
      memorySchemaSql: 'DDL-MEMORY'
    }),
    error => error.code === 'CORE_V0_SCHEMA_NOT_READY'
  );
});

test('preparation is cached per pool so readiness is not re-probed per request', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool();
  await prepareCoreV0ProductionSchema(pool, readinessOnly);
  const probeCount = pool.queries.length;
  assert.ok(probeCount > 0);
  const second = await prepareCoreV0ProductionSchema(pool, readinessOnly);
  assert.equal(pool.queries.length, probeCount);
  assert.equal(second.coreReady, true);
});

test('a failed preparation is not cached and can be retried', async () => {
  resetCoreV0ProductionSchemaCache();
  const pool = fakePool({ columns: new Set() });
  await assert.rejects(() => prepareCoreV0ProductionSchema(pool, readinessOnly));
  const afterFailure = pool.queries.length;
  await assert.rejects(() => prepareCoreV0ProductionSchema(pool, readinessOnly));
  assert.ok(pool.queries.length > afterFailure, 'a rejected preparation must not poison the cache');
});
