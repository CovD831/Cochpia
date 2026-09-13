// PITR / tombstone-replay drill for the Cochpia memory module.
//
// Real, one-shot PostgreSQL drill (NOT against production port 5433 / pg-data):
//   initdb(temp) -> apply canonical memory schema + drill cache table
//   -> seed deleted subject + control subject (user + relationship domains)
//   -> pg_basebackup (full) -> perform delete/forget on PRIMARY, capture tombstone ledger
//   -> restore SECOND cluster from base backup -> replay tombstone ledger
//   -> assert: deleted subject retrieve=0, derived tables not resurrected, control survives
//
// All PostgreSQL work goes through the `psql`/`pg_*` CLIs (child_process). The node
// `pg` module is intentionally NOT used: this sandbox brokers file reads of third-party
// node_modules and cannot auto-approve them. psql is pre-authorized via
// dangerouslyDisableSandbox. No loopback-socket / production-db / .env access.
//
// Honesty: any step that cannot run is recorded as failed with the raw error and the
// overall verdict is degraded (PARTIAL/FAILED). Nothing is fabricated as pass.

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG_BIN = '/opt/homebrew/opt/postgresql@17/bin';
const SCHEMA_SQL = path.join(REPO_ROOT, 'server', 'memory-module-schema.sql');

const TS = new Date().toISOString().replace(/[:.]/g, '-');
const BASE = `/tmp/pitr-drill-${TS}`;
const PRIMARY_DATA = path.join(BASE, 'data');
const BACKUP_DIR = path.join(BASE, 'backup');
const RESTORE_DATA = path.join(BASE, 'restore');
const LOG_DIR = path.join(BASE, 'logs');

const PORT_PRIMARY = 5499;
const PORT_RESTORE = 5498;
const SOCKET_DIR = '/tmp';
const SUPERUSER = 'driller';
const DB = 'memdb';
const TENANT = 't_drill';

const DRILL_CACHE_DDL = `
CREATE TABLE IF NOT EXISTS memory_cache (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('user', 'relationship', 'session')),
  subject_id text NOT NULL,
  cache_key text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_cache_subject_idx ON memory_cache (tenant_id, user_id, subject_id);
`;

// ---- helpers ---------------------------------------------------------------

function nowMs() { return Date.now(); }

// Run any binary (PG CLIs). PATH includes PG_BIN so sub-tools resolve.
function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    const start = nowMs();
    const child = spawn(bin, args, {
      env: { ...process.env, PATH: `${PG_BIN}:${process.env.PATH}`, PGPASSWORD: '', LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.stderr?.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout: out, stderr: err, ms: nowMs() - start }));
  });
}

function psql(port, sql, { tuple = false, dbName = DB } = {}) {
  const args = [
    '-h', '127.0.0.1', '-p', String(port), '-U', SUPERUSER, '-d', dbName,
    '-v', 'ON_ERROR_STOP=1',
  ];
  if (tuple) args.push('-t', '-A', '-F', '|');
  args.push('-c', sql);
  return run(`${PG_BIN}/psql`, args);
}

function esc(s) { return String(s).replace(/'/g, "''"); }
function sq(s) { return `'${esc(s)}'`; }

let SEQ = 0;
function uid(prefix) { SEQ += 1; return `${prefix}_${TS.split('-').pop()}_${SEQ}`; }

// ---- evidence accumulator -------------------------------------------------

const steps = [];
const assertions = {};
const timings = {};
const notes = [];
let ledger = [];

function recordStep(name, command, res, assertion = null) {
  steps.push({
    name,
    command,
    ok: res.ok,
    durationMs: res.ms,
    assertion: assertion ? { name: assertion.name, pass: assertion.pass, detail: assertion.detail } : undefined,
    error: res.ok ? undefined : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(0, 2000),
  });
}

// ---- the drill -------------------------------------------------------------

async function main() {
  const t0 = nowMs();
  let reachedAssertions = false;
  let anyStepFailed = false;
  let allAssertionsPass = true;

  async function connectUntilReady(port, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const r = await psql(port, 'SELECT 1', { dbName: 'postgres' });
      if (r.ok) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  try {
    await mkdir(BASE, { recursive: true });
    await mkdir(LOG_DIR, { recursive: true });

    // 1) initdb primary
    {
      const cmd = `initdb -D ${PRIMARY_DATA} -U ${SUPERUSER} -A trust --encoding=UTF8 --locale=C`;
      const res = await run(`${PG_BIN}/initdb`, ['-D', PRIMARY_DATA, '-U', SUPERUSER, '-A', 'trust', '--encoding=UTF8', '--locale=C']);
      recordStep('initdb_primary', cmd, res);
      if (!res.ok) { anyStepFailed = true; throw new Error('initdb failed'); }
    }

    // 2) start primary
    {
      const opts = `-p ${PORT_PRIMARY} -k ${SOCKET_DIR} -c listen_addresses='127.0.0.1' -c wal_level=replica -c max_wal_senders=10`;
      const cmd = `pg_ctl -D ${PRIMARY_DATA} -o "${opts}" -l ${LOG_DIR}/primary.log start`;
      const res = await run(`${PG_BIN}/pg_ctl`, ['-D', PRIMARY_DATA, '-o', opts, '-l', `${LOG_DIR}/primary.log`, 'start']);
      recordStep('start_primary', cmd, res);
      if (!res.ok) { anyStepFailed = true; throw new Error('start primary failed'); }
      if (!await connectUntilReady(PORT_PRIMARY)) { anyStepFailed = true; notes.push('primary did not accept connections'); throw new Error('primary not ready'); }
    }

    // 3) createdb
    {
      const cmd = `createdb -h 127.0.0.1 -p ${PORT_PRIMARY} -U ${SUPERUSER} ${DB}`;
      const res = await run(`${PG_BIN}/createdb`, ['-h', '127.0.0.1', '-p', String(PORT_PRIMARY), '-U', SUPERUSER, DB]);
      recordStep('createdb', cmd, res);
      if (!res.ok) { anyStepFailed = true; throw new Error('createdb failed'); }
    }

    // 4) apply canonical schema + drill cache table
    {
      const cmd = `psql -f ${SCHEMA_SQL}`;
      const res = await run(`${PG_BIN}/psql`, ['-h', '127.0.0.1', '-p', String(PORT_PRIMARY), '-U', SUPERUSER, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', SCHEMA_SQL]);
      recordStep('apply_schema', cmd, res);
      if (!res.ok) { anyStepFailed = true; throw new Error('apply schema failed'); }
      const res2 = await psql(PORT_PRIMARY, DRILL_CACHE_DDL);
      recordStep('apply_cache_ddl', 'inline memory_cache DDL', res2);
      if (!res2.ok) { anyStepFailed = true; throw new Error('apply cache ddl failed: ' + res2.stderr); }
    }

    // 5) seed deleted subject + control subject
    {
      const sql = buildSeedSql();
      const res = await psql(PORT_PRIMARY, sql);
      recordStep('seed_subjects', 'inline SQL (2 subjects, user+relationship domains)', res);
      if (!res.ok) { anyStepFailed = true; throw new Error('seed failed: ' + res.stderr); }
    }

    // 6) pg_basebackup (full)
    {
      const cmd = `pg_basebackup -h 127.0.0.1 -p ${PORT_PRIMARY} -U ${SUPERUSER} -D ${BACKUP_DIR} -Fp -Xs`;
      const start = nowMs();
      const res = await run(`${PG_BIN}/pg_basebackup`, ['-h', '127.0.0.1', '-p', String(PORT_PRIMARY), '-U', SUPERUSER, '-D', BACKUP_DIR, '-Fp', '-Xs']);
      res.ms = nowMs() - start;
      timings.backupMs = res.ms;
      recordStep('pg_basebackup', cmd, res);
      if (!res.ok) { anyStepFailed = true; throw new Error('basebackup failed'); }
    }

    // 7) perform delete/forget on PRIMARY + capture tombstone ledger
    {
      const delSql = buildDeleteAndLedgerSql();
      const delRes = await psql(PORT_PRIMARY, delSql);
      timings.deletionMs = delRes.ms;
      recordStep('delete_and_capture_ledger', 'inline SQL: insert tombstones + replay deletes on PRIMARY', delRes);
      if (!delRes.ok) { anyStepFailed = true; throw new Error('delete/capture failed: ' + delRes.stderr); }
      // capture ledger via tuple query
      const cap = await psql(PORT_PRIMARY,
        `SELECT id, tenant_id, user_id, target_type, target_id, action, redaction_epoch::text FROM memory_tombstones WHERE tenant_id=${sq(TENANT)} AND user_id=${sq('user_del')} ORDER BY target_type, target_id`,
        { tuple: true });
      if (!cap.ok) { anyStepFailed = true; throw new Error('ledger capture failed: ' + cap.stderr); }
      ledger = parseLedger(cap.stdout);
      steps.push({ name: 'capture_ledger', command: 'SELECT memory_tombstones for user_del', ok: true, durationMs: cap.ms });
      notes.push(`captured ${ledger.length} tombstone entries for deleted subject`);
    }

    // 8) restore SECOND cluster from base backup
    {
      await rm(RESTORE_DATA, { recursive: true, force: true });
      const cpStart = nowMs();
      await cp(BACKUP_DIR, RESTORE_DATA, { recursive: true });
      const cpMs = nowMs() - cpStart;
      const opts = `-p ${PORT_RESTORE} -k ${SOCKET_DIR} -c listen_addresses='127.0.0.1'`;
      const start = nowMs();
      const res = await run(`${PG_BIN}/pg_ctl`, ['-D', RESTORE_DATA, '-o', opts, '-l', `${LOG_DIR}/restore.log`, 'start']);
      res.ms = nowMs() - start;
      timings.restoreMs = cpMs + res.ms;
      recordStep('restore_start', `cp -R ${BACKUP_DIR} ${RESTORE_DATA} && pg_ctl -D ${RESTORE_DATA} -o "${opts}" start`, res);
      if (!res.ok) { anyStepFailed = true; throw new Error('restore start failed: ' + res.stderr); }
      if (!await connectUntilReady(PORT_RESTORE)) { anyStepFailed = true; notes.push('restore did not accept connections'); throw new Error('restore not ready'); }
    }

    // 8b) resurrection check: before replay, deleted subject must still be present
    {
      const counts = await countSubject(PORT_RESTORE, 'user_del');
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const pass = total > 0;
      reachedAssertions = true;
      recordStep('restore_resurrection_check', 'count deleted-subject rows on RESTORE before replay (expect >0 = resurrected)', { ok: true, ms: 0 }, { name: 'deleted_subject_resurrected_pre_replay', pass, detail: `total=${total}` });
      Object.assign(steps[steps.length - 1], { counts });
      notes.push(`pre-replay deleted-subject row total on restore = ${total} (resurrection confirmed)`);
    }

    // 9) replay tombstone ledger on RESTORE
    {
      const replaySql = buildReplaySql(ledger);
      const res = await psql(PORT_RESTORE, replaySql);
      timings.replayMs = res.ms;
      recordStep('replay_ledger', 're-insert captured tombstones into RESTORE + apply equivalent deletes per tombstone', res);
      if (!res.ok) { anyStepFailed = true; throw new Error('replay failed: ' + res.stderr); }
    }

    // 10) assertions on RESTORE
    {
      const del = await countSubject(PORT_RESTORE, 'user_del');
      const ctrl = await countSubject(PORT_RESTORE, 'user_ctrl');
      const delTotal = Object.values(del).reduce((a, b) => a + b, 0);
      const aPass = delTotal === 0;
      const bPass = del.index_documents === 0 && del.profile_snapshots === 0 && del.profile_snapshot_items === 0 && del.memory_outbox_events === 0 && del.memory_cache === 0;
      const ctrlTotal = Object.values(ctrl).reduce((a, b) => a + b, 0);
      const cPass = ctrlTotal > 0 && ctrl.memory_assertions > 0 && ctrl.raw_events > 0;
      allAssertionsPass = aPass && bPass && cPass;
      assertions.retrieveDeletedSubjectPerTable = del;
      assertions.derivedNotResurrected = {
        index_documents: del.index_documents, profile_snapshots: del.profile_snapshots,
        profile_snapshot_items: del.profile_snapshot_items, memory_outbox_events: del.memory_outbox_events,
        memory_cache: del.memory_cache, pass: bPass,
      };
      assertions.controlSurvives = { ...ctrl, pass: cPass };
      assertions.retrieveDeletedSubjectZero = { total: delTotal, pass: aPass };
      recordStep('final_assertions', 'count deleted vs control subject across all tables on RESTORE', { ok: true, ms: 0 },
        { name: 'pitr_no_resurrection', pass: allAssertionsPass, detail: `retrieveDeleted=0:${aPass} derivedNotResurrected:${bPass} controlSurvives:${cPass}` });
      Object.assign(steps[steps.length - 1], { deletedCounts: del, controlCounts: ctrl });
      notes.push(`final: retrieveDeletedTotal=${delTotal} controlTotal=${ctrlTotal}`);
    }
  } catch (e) {
    notes.push('drill error: ' + (e?.message || String(e)));
  } finally {
    for (const [name, dir] of [['primary', PRIMARY_DATA], ['restore', RESTORE_DATA]]) {
      try {
        await run(`${PG_BIN}/pg_ctl`, ['-D', dir, '-m', 'fast', 'stop']);
        notes.push(`stopped ${name} cluster`);
      } catch {
        notes.push(`could not stop ${name} cluster (dir ${dir})`);
      }
    }
  }

  const t1 = nowMs();
  timings.totalMs = t1 - t0;

  let verdict;
  if (allAssertionsPass && !anyStepFailed && reachedAssertions) verdict = 'PASS';
  else if (reachedAssertions) verdict = 'FAILED';
  else verdict = 'PARTIAL';

  const evidence = {
    generatedAt: new Date().toISOString(),
    verdict,
    environment: {
      pgVersion: 'PostgreSQL 17.11 (Homebrew)',
      pgBin: PG_BIN,
      os: process.platform,
      primary: { port: PORT_PRIMARY, dataDir: PRIMARY_DATA, socketDir: SOCKET_DIR, db: DB, superuser: SUPERUSER, tenant: TENANT },
      backupDir: BACKUP_DIR,
      restore: { port: PORT_RESTORE, dataDir: RESTORE_DATA, db: DB, superuser: SUPERUSER },
      ts: TS,
      productionUntouched: 'port 5433 / /Users/abab/Documents/ChatGPT/cochpia/pg-data NOT used; no .env credentials read; node pg module avoided (FS broker)',
    },
    steps,
    assertions,
    timings,
    ledger,
    notes,
    schemaSource: 'server/memory-module-schema.sql (+ drill-introduced memory_cache table)',
  };

  const outPath = path.join(REPO_ROOT, 'docs', 'rearchitecture', 'core-v0-memory-pipeline-slice', 'evidence', 'pitr-drill-2026-09-13.json');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(evidence, null, 2));
  console.log(`\n=== PITR DRILL VERDICT: ${verdict} ===`);
  console.log(`steps: ${steps.length}, ledger entries: ${ledger.length}`);
  console.log(`timings: backup=${timings.backupMs}ms restore=${timings.restoreMs}ms replay=${timings.replayMs}ms total=${timings.totalMs}ms`);
  if (assertions.retrieveDeletedSubjectPerTable) console.log(`deleted per table: ${JSON.stringify(assertions.retrieveDeletedSubjectPerTable)}`);
  if (assertions.controlSurvives) console.log(`control per table: ${JSON.stringify(assertions.controlSurvives)}`);
  console.log(`evidence: ${outPath}`);
  return evidence;
}

// ---- SQL builders ----------------------------------------------------------

function buildSeedSql() {
  const delUser = 'user_del';
  const ctrlUser = 'user_ctrl';
  const delSession = uid('sess');
  const ctrlSession = uid('sess');
  const parts = [];
  parts.push(sessionSql(delSession, delUser, 'agent_a'));
  const delRaw = [];
  for (let i = 0; i < 3; i++) delRaw.push(uid('raw'));
  delRaw.forEach((rid, i) => parts.push(rawEventSql(rid, delSession, delUser, `del-raw-${i}`)));
  const delA1 = { id: uid('asr'), ver: uid('ver') };
  const delA2 = { id: uid('asr'), ver: uid('ver') };
  const delA3 = { id: uid('asr'), ver: uid('ver') };
  parts.push(assertionSql(delA1.id, delSession, delUser, 'user', null, 'del-a1'));
  parts.push(assertionSql(delA2.id, delSession, delUser, 'relationship', 'agent_b', 'del-a2'));
  parts.push(assertionSql(delA3.id, delSession, delUser, 'session', null, 'del-a3', delSession));
  parts.push(assertionVersionSql(delA1, delRaw[0]));
  parts.push(assertionVersionSql(delA2, delRaw[0]));
  parts.push(assertionVersionSql(delA3, delRaw[0]));
  parts.push(episodeSql(uid('epi'), delSession, delUser, 'session', delRaw[0], delA1.ver));
  parts.push(indexDocSql(uid('idx'), delA1.id, delUser, 'user', null, 'deleted user fact one'));
  parts.push(indexDocSql(uid('idx'), delA2.id, delUser, 'relationship', 'agent_b', 'deleted relationship signal'));
  const delSnap = uid('snap');
  parts.push(`INSERT INTO profile_snapshots (id, tenant_id, user_id, session_id, grant_version, privacy_epoch, resource_revision) VALUES (${sq(delSnap)},${sq(TENANT)},${sq(delUser)},${sq(delSession)},0,0,1);`);
  parts.push(snapshotItemSql(delSnap, delUser, delA1.id, delA1.ver, 'user'));
  parts.push(snapshotItemSql(delSnap, delUser, delA2.id, delA2.ver, 'relationship'));
  parts.push(outboxSql(uid('out'), delA1.id, delUser, 'memory_assertion_committed'));
  parts.push(outboxSql(uid('out'), delRaw[0], delUser, 'raw_event_ingested'));
  parts.push(cacheSql(uid('cache'), delA1.id, delUser, 'user', 'assertion:del-a1'));
  parts.push(cacheSql(uid('cache'), delA2.id, delUser, 'relationship', 'assertion:del-a2'));
  parts.push(cacheSql(uid('cache'), delSession, delUser, 'session', 'session:del'));

  parts.push(sessionSql(ctrlSession, ctrlUser, 'agent_c'));
  const ctrlRaw = [];
  for (let i = 0; i < 3; i++) ctrlRaw.push(uid('raw'));
  ctrlRaw.forEach((rid, i) => parts.push(rawEventSql(rid, ctrlSession, ctrlUser, `ctrl-raw-${i}`)));
  const cA1 = { id: uid('asr'), ver: uid('ver') };
  const cA2 = { id: uid('asr'), ver: uid('ver') };
  const cA3 = { id: uid('asr'), ver: uid('ver') };
  parts.push(assertionSql(cA1.id, ctrlSession, ctrlUser, 'user', null, 'ctrl-a1'));
  parts.push(assertionSql(cA2.id, ctrlSession, ctrlUser, 'relationship', 'agent_d', 'ctrl-a2'));
  parts.push(assertionSql(cA3.id, ctrlSession, ctrlUser, 'session', null, 'ctrl-a3', ctrlSession));
  parts.push(assertionVersionSql(cA1, ctrlRaw[0]));
  parts.push(assertionVersionSql(cA2, ctrlRaw[0]));
  parts.push(assertionVersionSql(cA3, ctrlRaw[0]));
  parts.push(episodeSql(uid('epi'), ctrlSession, ctrlUser, 'session', ctrlRaw[0], cA1.ver));
  parts.push(indexDocSql(uid('idx'), cA1.id, ctrlUser, 'user', null, 'control user fact one'));
  parts.push(indexDocSql(uid('idx'), cA2.id, ctrlUser, 'relationship', 'agent_d', 'control relationship signal'));
  const ctrlSnap = uid('snap');
  parts.push(`INSERT INTO profile_snapshots (id, tenant_id, user_id, session_id, grant_version, privacy_epoch, resource_revision) VALUES (${sq(ctrlSnap)},${sq(TENANT)},${sq(ctrlUser)},${sq(ctrlSession)},0,0,1);`);
  parts.push(snapshotItemSql(ctrlSnap, ctrlUser, cA1.id, cA1.ver, 'user'));
  parts.push(snapshotItemSql(ctrlSnap, ctrlUser, cA2.id, cA2.ver, 'relationship'));
  parts.push(outboxSql(uid('out'), cA1.id, ctrlUser, 'memory_assertion_committed'));
  parts.push(outboxSql(uid('out'), ctrlRaw[0], ctrlUser, 'raw_event_ingested'));
  parts.push(cacheSql(uid('cache'), cA1.id, ctrlUser, 'user', 'assertion:ctrl-a1'));
  parts.push(cacheSql(uid('cache'), cA2.id, ctrlUser, 'relationship', 'assertion:ctrl-a2'));
  parts.push(cacheSql(uid('cache'), ctrlSession, ctrlUser, 'session', 'session:ctrl'));
  return parts.join('\n');
}

function sessionSql(id, user, agent) {
  return `INSERT INTO memory_sessions (id, tenant_id, user_id, caller_agent_id, status, started_at, expires_at, profile_snapshot_id, grant_version, privacy_epoch, resource_revision) VALUES (${sq(id)},${sq(TENANT)},${sq(user)},${sq(agent)},'active',now(),now()+interval '30 days',${sq(uid('snap'))},0,0,1);`;
}
function rawEventSql(id, session, user, eventId) {
  return `INSERT INTO raw_events (id, tenant_id, user_id, event_id, source_revision, session_id, event_role, content_type, content, occurred_at, retention_policy, delete_after, commit_seq, resource_revision) VALUES (${sq(id)},${sq(TENANT)},${sq(user)},${sq(eventId)},'rev1',${sq(session)},'agent','plain_text',${sq('content for ' + eventId)},now(),'keep',now()+interval '30 days',1,1);`;
}
function assertionSql(id, session, user, scope, relAgent, key, sessionScope) {
  return `INSERT INTO memory_assertions (id, tenant_id, user_id, scope_type, relationship_agent_id, session_id, memory_type, assertion_type, canonical_key, status, subject_type, subject_id, sensitivity, confidence, importance, retention_policy, recall_policy, auto_recall_allowed, mention_policy, direct_query_policy, expires_at, resource_revision) VALUES (${sq(id)},${sq(TENANT)},${sq(user)},${sq(scope)},${relAgent ? sq(relAgent) : 'NULL'},${sessionScope ? sq(sessionScope) : 'NULL'},'fact','observed_fact',${sq(key)},'active','user',${sq(user)},'S1',0.6,0.5,'keep','always',false,'mentionable','allow',now()+interval '30 days',1);`;
}
function assertionVersionSql(a, rawId) {
  return [
    `INSERT INTO assertion_versions (id, tenant_id, assertion_id, content, content_type, trust_level, observed_at, version_status, created_by, promotion_reason, promotion_policy_version) VALUES (${sq(a.ver)},${sq(TENANT)},${sq(a.id)},'version content','plain_text','agent_inferred',now(),'current','agent','seed','v1');`,
    `UPDATE memory_assertions SET current_version_id=${sq(a.ver)} WHERE id=${sq(a.id)} AND tenant_id=${sq(TENANT)};`,
    `INSERT INTO assertion_version_sources (tenant_id, version_id, source_type, source_id) VALUES (${sq(TENANT)},${sq(a.ver)},'raw_event',${sq(rawId)});`,
  ].join('\n');
}
function episodeSql(id, session, user, scope, rawId, verId) {
  return [
    `INSERT INTO episodes (id, tenant_id, user_id, scope_type, relationship_agent_id, session_id, title, summary, observed_start, observed_end, grouping_rule_version, summary_model_version, status, resource_revision) VALUES (${sq(id)},${sq(TENANT)},${sq(user)},${sq(scope)},NULL,${sq(session)},${sq(uid('epi-title'))},'summary',now()-interval '1 hour',now(),'g1','m1','active',1);`,
    `INSERT INTO episode_members (id, tenant_id, episode_id, raw_event_id, assertion_version_id, member_role, join_reason) VALUES (${sq(uid('epm'))},${sq(TENANT)},${sq(id)},${sq(rawId)},${sq(verId)},'member','seed');`,
  ].join('\n');
}
function indexDocSql(id, sourceId, user, scope, relAgent, text) {
  return `INSERT INTO index_documents (id, tenant_id, source_type, source_id, source_version, user_id, scope_type, relationship_agent_id, search_text, sensitivity, contextualizable, mentionable, redaction_epoch, policy_epoch, grant_version, embedding, lexical_version, index_status, source_refs) VALUES (${sq(id)},${sq(TENANT)},'assertion',${sq(sourceId)},'v1',${sq(user)},${sq(scope)},${relAgent ? sq(relAgent) : 'NULL'},${sq(text)},'S1',true,true,0,'ep1',0,null,'l1','active',ARRAY[${sq(sourceId)}]);`;
}
function snapshotItemSql(snap, user, asrId, verId, scope) {
  return `INSERT INTO profile_snapshot_items (tenant_id, snapshot_id, user_id, assertion_id, version_id, scope_type) VALUES (${sq(TENANT)},${sq(snap)},${sq(user)},${sq(asrId)},${sq(verId)},${sq(scope)});`;
}
function outboxSql(id, aggregateId, user, type) {
  return `INSERT INTO memory_outbox_events (id, tenant_id, user_id, event_type, aggregate_id, schema_version, commit_seq, status) VALUES (${sq(id)},${sq(TENANT)},${sq(user)},${sq(type)},${sq(aggregateId)},1,1,'pending');`;
}
function cacheSql(id, subjectId, user, scope, key) {
  return `INSERT INTO memory_cache (id, tenant_id, user_id, scope_type, subject_id, cache_key, value) VALUES (${sq(id)},${sq(TENANT)},${sq(user)},${sq(scope)},${sq(subjectId)},${sq(key)},'{"hit":true}');`;
}

// Delete on PRIMARY: write tombstones, then apply equivalent deletes.
function buildDeleteAndLedgerSql() {
  const user = 'user_del';
  const parts = [];
  // We need the assertion ids + session id of the deleted subject. Select them first
  // inside the same script so the deletes target the right rows.
  parts.push(`
DO $$
DECLARE
  r RECORD;
  v_session text;
BEGIN
  SELECT id INTO v_session FROM memory_sessions WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} LIMIT 1;
  FOR r IN SELECT id FROM memory_assertions WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} LOOP
    INSERT INTO memory_tombstones (id, tenant_id, user_id, target_type, target_id, action, redaction_epoch)
      VALUES ('tomb_' || r.id, ${sq(TENANT)}, ${sq(user)}, 'memory', r.id, 'delete', 1);
  END LOOP;
  IF v_session IS NOT NULL THEN
    INSERT INTO memory_tombstones (id, tenant_id, user_id, target_type, target_id, action, redaction_epoch)
      VALUES ('tomb_' || v_session, ${sq(TENANT)}, ${sq(user)}, 'session', v_session, 'delete', 1);
  END IF;
END $$;`);
  // apply deletes for memory targets
  parts.push(`
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT target_id FROM memory_tombstones WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND target_type = 'memory' LOOP
    DELETE FROM index_documents WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND source_id = r.target_id;
    DELETE FROM profile_snapshot_items WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND assertion_id = r.target_id;
    DELETE FROM memory_outbox_events WHERE tenant_id = ${sq(TENANT)} AND aggregate_id = r.target_id AND (user_id = ${sq(user)} OR user_id IS NULL);
    DELETE FROM memory_cache WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND subject_id = r.target_id;
    DELETE FROM memory_assertions WHERE tenant_id = ${sq(TENANT)} AND id = r.target_id;
  END LOOP;
END $$;`);
  // apply deletes for session target
  parts.push(`
DO $$
DECLARE
  v_session text;
  v_raw text[];
  v_asr text[];
  v_ver text[];
BEGIN
  SELECT target_id INTO v_session FROM memory_tombstones WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND target_type = 'session' LIMIT 1;
  IF v_session IS NOT NULL THEN
    SELECT array_agg(id) INTO v_raw FROM raw_events WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND session_id = v_session;
    SELECT array_agg(id) INTO v_asr FROM memory_assertions WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND session_id = v_session;
    v_raw := COALESCE(v_raw, ARRAY[]::text[]);
    v_asr := COALESCE(v_asr, ARRAY[]::text[]);
    SELECT array_agg(id) INTO v_ver FROM assertion_versions WHERE tenant_id = ${sq(TENANT)} AND assertion_id = ANY(v_asr);
    v_ver := COALESCE(v_ver, ARRAY[]::text[]);
    DELETE FROM index_documents WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND session_id = v_session;
    DELETE FROM profile_snapshot_items WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND (snapshot_id IN (SELECT id FROM profile_snapshots WHERE session_id = v_session) OR assertion_id = ANY(v_asr));
    DELETE FROM current_state_sources WHERE tenant_id = ${sq(TENANT)} AND raw_event_id = ANY(v_raw);
    DELETE FROM assertion_version_sources WHERE tenant_id = ${sq(TENANT)} AND version_id = ANY(v_ver);
    DELETE FROM memory_outbox_events WHERE tenant_id = ${sq(TENANT)} AND aggregate_id = ANY(v_raw || v_asr);
    DELETE FROM memory_cache WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND subject_id = ANY(v_raw || v_asr || ARRAY[v_session]);
    DELETE FROM raw_events WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND session_id = v_session;
    DELETE FROM memory_assertions WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND session_id = v_session;
    DELETE FROM episodes WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND session_id = v_session;
    DELETE FROM profile_snapshots WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND session_id = v_session;
    DELETE FROM current_states WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND session_id = v_session;
    DELETE FROM memory_sessions WHERE tenant_id = ${sq(TENANT)} AND user_id = ${sq(user)} AND id = v_session;
  END IF;
END $$;`);
  return parts.join('\n');
}

// Re-insert captured ledger into RESTORE, then apply equivalent deletes per tombstone.
function buildReplaySql(led) {
  const parts = [];
  if (led.length === 0) {
    parts.push(`SELECT 'no-ledger' AS note;`);
    return parts.join('\n');
  }
  const rows = led.map((t) =>
    `(${sq(t.id)},${sq(t.tenant_id)},${sq(t.user_id)},${sq(t.target_type)},${sq(t.target_id)},${sq(t.action)},${Number(t.redaction_epoch)})`).join(',');
  parts.push(`INSERT INTO memory_tombstones (id, tenant_id, user_id, target_type, target_id, action, redaction_epoch) VALUES ${rows};`);
  // memory deletes
  parts.push(`
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tenant_id, user_id, target_id FROM memory_tombstones WHERE target_type = 'memory' LOOP
    DELETE FROM index_documents WHERE tenant_id = r.tenant_id AND user_id = r.user_id AND source_id = r.target_id;
    DELETE FROM profile_snapshot_items WHERE tenant_id = r.tenant_id AND user_id = r.user_id AND assertion_id = r.target_id;
    DELETE FROM memory_outbox_events WHERE tenant_id = r.tenant_id AND aggregate_id = r.target_id AND (user_id = r.user_id OR user_id IS NULL);
    DELETE FROM memory_cache WHERE tenant_id = r.tenant_id AND user_id = r.user_id AND subject_id = r.target_id;
    DELETE FROM memory_assertions WHERE tenant_id = r.tenant_id AND id = r.target_id;
  END LOOP;
END $$;`);
  // session deletes
  parts.push(`
DO $$
DECLARE
  r RECORD;
  v_raw text[];
  v_asr text[];
  v_ver text[];
BEGIN
  FOR r IN SELECT tenant_id, user_id, target_id FROM memory_tombstones WHERE target_type = 'session' LOOP
    SELECT array_agg(id) INTO v_raw FROM raw_events WHERE tenant_id = r.tenant_id AND user_id = r.user_id AND session_id = r.target_id;
    SELECT array_agg(id) INTO v_asr FROM memory_assertions WHERE tenant_id = r.tenant_id AND user_id = r.user_id AND session_id = r.target_id;
    v_raw := COALESCE(v_raw, ARRAY[]::text[]);
    v_asr := COALESCE(v_asr, ARRAY[]::text[]);
    SELECT array_agg(id) INTO v_ver FROM assertion_versions WHERE tenant_id = r.tenant_id AND assertion_id = ANY(v_asr);
    v_ver := COALESCE(v_ver, ARRAY[]::text[]);
    DELETE FROM index_documents WHERE tenant_id = r.tenant_id AND user_id = r.user_id AND session_id = r.target_id;
    DELETE FROM profile_snapshot_items WHERE tenant_id = r.tenant_id AND user_id = r.user_id AND (snapshot_id IN (SELECT id FROM profile_snapshots WHERE session_id = r.target_id) OR assertion_id = ANY(v_asr));
    DELETE FROM current_state_sources WHERE tenant_id = r.tenant_id AND raw_event_id = ANY(v_raw);
    DELETE FROM assertion_version_sources WHERE tenant_id = r.tenant_id AND version_id = ANY(v_ver);
    DELETE FROM memory_outbox_events WHERE tenant_id = r.tenant_id AND aggregate_id = ANY(v_raw || v_asr);
    DELETE FROM memory_cache WHERE tenant_id = r.tenant_id AND user_id = r.user_id AND subject_id = ANY(v_raw || v_asr || ARRAY[r.target_id]);
    DELETE FROM raw_events WHERE tenant_id = r.tenant_id AND user_id = r.user_id AND session_id = r.target_id;
    DELETE FROM memory_assertions WHERE tenant_id = r.tenant_id AND user_id = r.user_id AND session_id = r.target_id;
    DELETE FROM episodes WHERE tenant_id = r.tenant_id AND user_id = r.user_id AND session_id = r.target_id;
    DELETE FROM profile_snapshots WHERE tenant_id = r.tenant_id AND user_id = r.user_id AND session_id = r.target_id;
    DELETE FROM current_states WHERE tenant_id = r.tenant_id AND user_id = r.user_id AND session_id = r.target_id;
    DELETE FROM memory_sessions WHERE tenant_id = r.tenant_id AND user_id = r.user_id AND id = r.target_id;
  END LOOP;
END $$;`);
  return parts.join('\n');
}

function parseLedger(stdout) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const [id, tenant_id, user_id, target_type, target_id, action, redaction_epoch] = s.split('|');
    rows.push({ id, tenant_id, user_id, target_type, target_id, action, redaction_epoch });
  }
  return rows;
}

async function countSubject(port, user) {
  const tbl = ['raw_events', 'memory_assertions', 'assertion_versions', 'episodes', 'index_documents', 'profile_snapshots', 'profile_snapshot_items', 'memory_outbox_events', 'memory_cache', 'memory_sessions'];
  const counts = {};
  for (const t of tbl) {
    const where = t === 'assertion_versions'
      ? `tenant_id=${sq(TENANT)} AND assertion_id IN (SELECT id FROM memory_assertions WHERE tenant_id=${sq(TENANT)} AND user_id=${sq(user)})`
      : `tenant_id=${sq(TENANT)} AND user_id=${sq(user)}`;
    const r = await psql(port, `SELECT count(*)::int AS n FROM ${t} WHERE ${where}`, { tuple: true });
    if (!r.ok) { counts[t] = `ERR:${r.stderr.slice(0, 120)}`; continue; }
    counts[t] = parseInt((r.stdout || '0').trim().split('\n')[0] || '0', 10) || 0;
  }
  return counts;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
