// Guard: schema-scoped execution must not trust database-wide catalogs.
//
// pg_constraint / pg_class / pg_type / pg_index / pg_attribute / pg_extension are
// shared by the whole database -- they are NOT scoped to a schema. A guard of the
// form
//
//     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'x') THEN ...
//
// therefore answers the wrong question when the statement runs against an
// isolated schema (see scripts/core-v0-postgres-live-acceptance.js, which pins
// search_path to a throwaway schema): "public" already owns a constraint with
// that name, so the branch is skipped, the constraint is never created in the
// isolated schema, and the next statement that references it by name blows up
// with SQLSTATE 42704.
//
// That exact failure happened twice on 2026-09-12: once for pg_extension
// (gin_trgm_ops) and once for 27 pg_constraint guards.
//
// What counts as scoped, and why (the distinction was forced by a false positive
// this detector produced on its first run):
//
//   conname = 'x'                        -> BAD. Matches any table in the whole
//                                           database, so a "public" copy wins.
//   conrelid = 'tbl'::regclass           -> OK. Anchored to a table and resolved
//                                           through search_path, so it follows the
//                                           executing schema. (memory-module-schema.sql
//                                           uses this form for the content_type check.)
//   n.nspname = current_schema()         -> OK. Explicit.
//
// PART 2 is a self-check: if the detector stops recognising the known-bad form, or
// starts rejecting a known-good form, the "all files are clean" assertion in
// PART 1 becomes meaningless.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const SHARED_CATALOGS = ['pg_constraint', 'pg_class', 'pg_type', 'pg_index', 'pg_attribute', 'pg_extension'];

// Any one of these means the lookup follows the executing schema.
const SCHEMA_SCOPING = /nspname|table_schema|relnamespace|current_schema|pg_my_temp_schema|::regclass|\bconrelid\b/;

export function unscopedCatalogGuards(sql) {
  return String(sql)
    .split(';')
    .map(statement => statement.replace(/\s+/g, ' ').trim())
    .filter(statement => SHARED_CATALOGS.some(catalog => new RegExp(`\\bFROM\\s+${catalog}\\b`, 'i').test(statement)))
    .filter(statement => !SCHEMA_SCOPING.test(statement));
}

test('SQL guards against shared catalogs must name the schema they mean', async () => {
  const dir = new URL('./', import.meta.url);
  const files = (await readdir(dir)).filter(name => name.endsWith('.sql'));
  assert.ok(files.length > 0, 'expected at least one schema file under server/');

  const findings = [];
  for (const file of files) {
    const sql = await readFile(new URL(file, dir), 'utf8');
    for (const statement of unscopedCatalogGuards(sql)) {
      findings.push(`${file}: ${statement.slice(0, 160)}`);
    }
  }

  assert.deepEqual(
    findings,
    [],
    `a guard against a database-wide catalog cannot be evaluated per schema.\n${findings.join('\n')}`
  );
});

test('the guard detector still separates the known-bad form from the known-good ones (anti no-op)', () => {
  const badByName = "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'x') THEN ALTER TABLE t ADD CONSTRAINT x UNIQUE (a); END IF;";
  const goodExplicit = "IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = current_schema() AND c.conname = 'x') THEN NULL; END IF;";
  const goodAnchored = "SELECT pg_get_constraintdef(oid) INTO existing_definition FROM pg_constraint WHERE conrelid = 'assertion_versions'::regclass AND conname = 'x';";
  const notACatalog = 'SELECT 1 FROM core_v0_subjects WHERE tenant_id = $1;';

  assert.equal(unscopedCatalogGuards(badByName).length, 1, 'the pre-fix form must be reported');
  assert.equal(unscopedCatalogGuards(goodExplicit).length, 0, 'an explicit current_schema() guard must pass');
  assert.equal(unscopedCatalogGuards(goodAnchored).length, 0, 'a ::regclass anchor follows search_path and must pass');
  assert.equal(unscopedCatalogGuards(notACatalog).length, 0, 'application tables are not shared catalogs and must never be flagged');
});
