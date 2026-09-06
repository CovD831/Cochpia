// R-010 memory quality evaluation baseline (96-case, rule-judged).
//
// Runs the production turn path on a real local PostgreSQL with DeepSeek for
// extraction/AUDN/reply generation and Ollama bge-m3 for hybrid retrieval.
// Every case carries a structured expectation; a script - not an LLM judge -
// decides pass/fail. Produces baseline metrics plus the failing-case list.
//
// Usage: node scripts/memory-eval.js
// Requires: local PostgreSQL, DEEPSEEK/MODEL key in .env, Ollama tunnel on
// 11434 with bge-m3. Creates and drops the cochpia_memory_eval database.

import 'dotenv/config';
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import {
  createCoreV0ProductionAdapter,
  prepareCoreV0ProductionSchema,
  resetCoreV0ProductionSchemaCache
} from '../server/core-v0-production.js';
import { createMemoryModule } from '../server/memory-module.js';

const DB_NAME = 'cochpia_memory_eval';
const CONNECTION = `postgresql://localhost:5432/${DB_NAME}`;
const cases = JSON.parse(readFileSync(new URL('./eval/eval-cases.json', import.meta.url), 'utf8'));

const context = {
  tenantId: 'eval-tenant',
  subjectUserId: 'eval-user',
  actorType: 'user',
  actorId: 'eval-user',
  callerAgentId: 'cochpia',
  correlationId: 'memory-eval'
};

const evidence = { startedAt: new Date().toISOString(), cases: cases.meta, metrics: {}, failures: [] };
const fail = (caseId, check, detail) => evidence.failures.push({ caseId, check, detail });
const failuresFor = prefix => new Set(evidence.failures.filter(item => item.caseId.startsWith(prefix)).map(item => item.caseId)).size;
const fmt = (ok, total) => `${ok}/${total}`;

const baseState = () => ({
  sessions: [{ id: 'session-eval', title: '评测', summary: '', persona: '', atmosphere: '', companionIntent: 'listen' }],
  messages: { 'session-eval': [] },
  personality: { version: 1, summary: '评测会话', traits: [] },
  profile: { name: 'Cochpia', gender: 'none', age: null }
});

const handle = async (service, message, key) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await service.handleTurn({
        body: { sessionId: 'session-eval', message, channel: '默认' },
        headerIdempotencyKey: `eval-${key}-${randomUUID()}`
      });
    } catch (error) {
      if (attempt < 2 && (error?.retryable || error?.code === 'MODEL_TIMEOUT')) continue;
      throw error;
    }
  }
}

const assertRows = async pool => (await pool.query(`
  SELECT a.id, a.status, a.sensitivity, a.canonical_key, v.content
  FROM memory_assertions a
  LEFT JOIN assertion_versions v ON v.id = a.current_version_id
  ORDER BY v.created_at
`)).rows;

console.log(`重建评测库 ${DB_NAME} ...`);
execFileSync('psql', ['-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`]);
execFileSync('psql', ['-q', '-d', 'postgres', '-c', `CREATE DATABASE ${DB_NAME}`]);

process.env.CORE_V0_MEMORY_PIPELINE_ENABLED = 'true';
process.env.CORE_V0_MEMORY_EXTRACT_BUDGET_MS = '12000';
process.env.MEMORY_HYBRID_RETRIEVAL = 'true';
const pool = new pg.Pool({ connectionString: CONNECTION });
resetCoreV0ProductionSchemaCache();

try {
  const schema = await prepareCoreV0ProductionSchema(pool, { production: false, autoMigrate: true });
  console.log(`schema ready (migrated=${schema.migrated})`);

  const adapter = await createCoreV0ProductionAdapter({ pool, context, baseState: baseState(), modelProvider: 'deepseek' });
  const { service, drainExtraction, memoryPort } = adapter;

  // ---- Group A: extraction quality --------------------------------------
  for (const item of cases.groupA.facts) {
    await handle(service, item.message, item.id);
    await drainExtraction();
    const rows = await assertRows(pool);
    const hit = rows.some(row => row.status === 'active' && item.expectKeywords.every(keyword => String(row.content || '').includes(keyword)));
    if (!hit) fail(item.id, 'fact_active', `no active assertion covering "${item.expectKeywords.join(',')}"`);
  }
  for (const item of cases.groupA.chitChat) {
    await handle(service, item.message, item.id);
    const drained = await drainExtraction();
    if ((drained?.promoted || 0) + (drained?.pending || 0) > 0) fail(item.id, 'chit_chat_leak', JSON.stringify(drained));
  }
  for (const item of cases.groupA.dedup) {
    await handle(service, item.first, `${item.id}-1`);
    await drainExtraction();
    const before = (await assertRows(pool)).length;
    await handle(service, item.second, `${item.id}-2`);
    await drainExtraction();
    const after = (await assertRows(pool)).length;
    if (after > before) fail(item.id, 'dedup', `assertions grew ${before}->${after}`);
  }
  {
    const rows = await assertRows(pool);
    const factOk = cases.groupA.facts.filter(item => rows.some(row => row.status === 'active' && item.expectKeywords.every(keyword => String(row.content || '').includes(keyword)))).length;
    evidence.metrics.fact_recall = fmt(factOk, cases.groupA.facts.length);
    evidence.metrics.chit_chat_leak_rate = fmt(cases.groupA.chitChat.length - failuresFor('chit_chat_leak') - evidence.failures.filter(item => item.check === 'chit_chat_leak').length, cases.groupA.chitChat.length);
    evidence.metrics.dedup_effective = fmt(cases.groupA.dedup.length - failuresFor('dedup'), cases.groupA.dedup.length);
  }
  console.log(`\n[组A 提取] recall=${evidence.metrics.fact_recall} leak=${evidence.metrics.chit_chat_leak_rate} dedup=${evidence.metrics.dedup_effective}`);

  // ---- Group B: retrieval recall (paraphrase vs lexical vs noise) --------
  // Facts are ingested through the production path; a keyword -> assertion-id
  // map is built from the database so recalled hits are matched by id, not
  // by content wording (the extractor rephrases).
  const keywordIndex = new Map();
  const indexKeyword = (keyword, memoryId) => {
    for (const [existing, ids] of keywordIndex.entries()) {
      if (existing.includes(keyword) || keyword.includes(existing)) { ids.add(memoryId); return; }
    }
    keywordIndex.set(keyword, new Set([memoryId]));
  };
  const assertionIdsFor = keyword => {
    for (const [existing, ids] of keywordIndex.entries()) if (existing.includes(keyword) || keyword.includes(existing)) return ids;
    return new Set();
  };
  for (const item of cases.groupB.paraphrase) {
    await handle(service, item.message, item.id);
    await drainExtraction();
    const rows = await assertRows(pool);
    const row = rows.find(entry => entry.status === 'active' && String(entry.content || '').includes(item.targetKeyword));
    if (row) indexKeyword(item.targetKeyword, row.id);
  }
  const recalledIds = result => (result.recalled || []).map(item => String(item.id || ''));

  {
    let paraphraseHits = 0;
    for (const item of cases.groupB.paraphrase) {
      const result = await memoryPort.retrieveContext({ query: item.query, memorySessionId: null });
      const ids = assertionIdsFor(item.targetKeyword);
      const hit = ids.size > 0 && recalledIds(result).some(id => ids.has(id));
      if (!hit) fail(item.id, 'paraphrase_miss', `query="${item.query}" (answerability=${result.answerability}, recalled=${recalledIds(result).length})`);
      else paraphraseHits += 1;
    }
    evidence.metrics.paraphrase_hit_rate = fmt(paraphraseHits, cases.groupB.paraphrase.length);
    let lexicalHits = 0;
    for (const item of cases.groupB.lexical) {
      const result = await memoryPort.retrieveContext({ query: item.query, memorySessionId: null });
      const ids = assertionIdsFor(item.targetKeyword);
      const hit = ids.size > 0 && recalledIds(result).some(id => ids.has(id));
      if (!hit) fail(item.id, 'lexical_miss', `query="${item.query}"`);
      else lexicalHits += 1;
    }
    evidence.metrics.lexical_hit_rate = fmt(lexicalHits, cases.groupB.lexical.length);
    let noise = 0;
    for (const item of cases.groupB.noise) {
      const result = await memoryPort.retrieveContext({ query: item.query, memorySessionId: null });
      if ((result.recalled || []).length > 0) { noise += 1; fail(item.id, 'noise_recall', `unrelated query recalled ${result.recalled.length} items`); }
    }
    evidence.metrics.precision_noise = fmt(noise, cases.groupB.noise.length);
  }
  console.log(`\n[组B 检索] paraphrase=${evidence.metrics.paraphrase_hit_rate} lexical=${evidence.metrics.lexical_hit_rate} noise=${evidence.metrics.precision_noise}`);

  // ---- Group C: governance correctness ----------------------------------
  // S2: the fact must land in pending_confirmation (not silently active).
  for (const item of cases.groupC.s2) {
    await handle(service, item.message, item.id);
    const drained = await drainExtraction();
    const rows = await assertRows(pool);
    const row = rows.find(entry => String(entry.content || '').includes(item.expectKeywords[0]));
    if (!row) { fail(item.id, 's2_missing', `no assertion for "${item.expectKeywords[0]}" (drain ${JSON.stringify(drained)})`); continue; }
    if (row.status !== 'pending_confirmation') fail(item.id, 's2_not_pending', `status=${row.status} (drain ${JSON.stringify(drained)})`);
  }
  evidence.metrics.s2_accuracy = fmt(cases.groupC.s2.length - failuresFor('s2_'), cases.groupC.s2.length);
  console.log(`\n[组C 治理] S2 pending=${evidence.metrics.s2_accuracy}`);

  // forget: state -> visible -> forget -> invisible
  for (const item of cases.groupC.forget) {
    await handle(service, item.message, item.id);
    await drainExtraction();
    const result = await memoryPort.retrieveContext({ query: item.query, memorySessionId: null });
    const rows = await assertRows(pool);
    const row = rows.find(entry => entry.status === 'active' && String(entry.content || '').includes(item.targetKeyword));
    if (!row) { fail(item.id, 'forget_setup_miss', `no active assertion for "${item.targetKeyword}"`); continue; }
    if (!result.recalled.some(recalled => String(recalled.id || '') === row.id)) {
      fail(item.id, 'forget_setup_not_recalled', `active assertion not recalled by its own query (mode=${result.answerability})`);
      continue;
    }
    const state = await adapter.repository.load(context);
    const memory = createMemoryModule(state, async mutated => adapter.repository.save(context, mutated), { projectionEnabled: true });
    await memory.forget(context, row.id, { resourceRevision: row.resource_revision ?? row.resourceRevision ?? 1 });
    const after = await memoryPort.retrieveContext({ query: item.query, memorySessionId: null });
    if (after.recalled.some(recalled => String(recalled.id || '') === row.id)) fail(item.id, 'forget_resurrect', 'forgotten assertion still recalled');
  }
  evidence.metrics.forget_no_resurrection = fmt(cases.groupC.forget.length - failuresFor('forget_'), cases.groupC.forget.length);
  console.log(`[组C 治理] forget=${evidence.metrics.forget_no_resurrection}`);

  // arbitration: contradictory pair -> latest wins in the prompt
  for (const item of cases.groupC.arbitration) {
    await handle(service, item.first, `${item.id}-1`);
    await drainExtraction();
    await handle(service, item.second, `${item.id}-2`);
    await drainExtraction();
    const result = await memoryPort.retrieveContext({ query: item.query, memorySessionId: null });
    if (result.answerability === 'conflict') fail(item.id, 'arbitration_conflict', 'answerability stuck at conflict');
    const rows = await assertRows(pool);
    const newest = rows.filter(entry => entry.status === 'active' && String(entry.content || '').includes(item.targetKeyword));
    if (!newest.length) fail(item.id, 'arbitration_latest', `latest value "${item.targetKeyword}" not in the corpus`);
  }
  evidence.metrics.arbitration_latest_wins = fmt(cases.groupC.arbitration.length - failuresFor('arbitration_'), cases.groupC.arbitration.length);
  console.log(`[组C 治理] arbitration=${evidence.metrics.arbitration_latest_wins}`);

  // confirm flow: S2 pending -> confirm -> visible. Uses dedicated facts
  // (disjoint from the S2 group) so the dedup gate cannot interfere.
  for (const item of cases.groupC.confirm) {
    await handle(service, item.message, item.id);
    const drained = await drainExtraction();
    const rows = await assertRows(pool);
    const row = rows.find(entry => entry.status === 'pending_confirmation' && String(entry.content || '').includes(item.expectKeywords[0]))
      || rows.find(entry => String(entry.content || '').includes(item.expectKeywords[0]));
    if (!row) { fail(item.id, 'confirm_setup_miss', `no assertion for "${item.expectKeywords[0]}" (drain ${JSON.stringify(drained)})`); continue; }
    if (row.status === 'active') { fail(item.id, 'confirm_skipped_pending', 'assertion already active without confirmation'); continue; }
    const state = await adapter.repository.load(context);
    const confirmation = state.confirmations.find(entry => entry.candidateAssertionId === row.id && entry.status === 'pending');
    if (!confirmation) { fail(item.id, 'confirm_request_missing', 'no pending confirmation for the assertion'); continue; }
    const memory = createMemoryModule(state, async mutated => adapter.repository.save(context, mutated), { projectionEnabled: true });
    await memory.confirm(context, confirmation.id, { resourceRevision: confirmation.resourceRevision });
    const result = await memoryPort.retrieveContext({ query: item.query, memorySessionId: null });
    if (!result.recalled.some(recalled => String(recalled.id || '') === row.id)) {
      fail(item.id, 'confirm_not_visible', `"${item.expectKeywords[0]}" not recalled after confirmation`);
    }
  }
  evidence.metrics.confirm_visibility = fmt(cases.groupC.confirm.length - failuresFor('confirm_'), cases.groupC.confirm.length);
  console.log(`[组C 治理] confirm=${evidence.metrics.confirm_visibility}`);
} finally {
  evidence.finishedAt = new Date().toISOString();
  const allCases = cases.groupA.facts.length + cases.groupA.chitChat.length + cases.groupA.dedup.length
    + cases.groupB.paraphrase.length + cases.groupB.lexical.length + cases.groupB.noise.length
    + cases.groupC.s2.length + cases.groupC.forget.length + cases.groupC.arbitration.length + cases.groupC.confirm.length;
  evidence.totalCases = allCases;
  evidence.failedCases = new Set(evidence.failures.map(item => item.caseId)).size;
  await writeFile(new URL('../.rearchitecture-runs/memory-eval.json', import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(`\n==== 基线汇总：${allCases} case，${evidence.failedCases} 个失败 case，${evidence.failures.length} 条失败记录；明细见 .rearchitecture-runs/memory-eval.json ====`);
  await pool.end();
  execFileSync('psql', ['-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`]);
  console.log(`评测库 ${DB_NAME} 已清理`);
}
