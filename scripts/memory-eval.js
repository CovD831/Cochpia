
import 'dotenv/config';
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import {
  createCoreV0ProductionAdapter,
  prepareCoreV0ProductionSchema,
  resetCoreV0ProductionSchemaCache
} from '../server/core-v0-production.js';
import { createMemoryModule } from '../server/memory-module.js';

// The ambient shell may not export USER (pg defaults its user from it), so
// resolve the PG user the same way libpq does instead of trusting the env.
const resolvePgUser = () => {
  if (process.env.PGUSER) return process.env.PGUSER;
  return execFileSync('psql', ['-qtAc', 'select current_user', '-d', 'postgres'], { encoding: 'utf8' }).trim();
};


const DB_NAME = 'cochpia_memory_eval';
const CONNECTION = `postgresql://${resolvePgUser()}@localhost:5432/${DB_NAME}`;
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
let evalAborted = false;
const fail = (caseId, check, detail) => evidence.failures.push({ caseId, check, detail });
// R-011 harness fix: metrics must count failing cases by CHECK, not by caseId
// prefix (the R-010 version matched `caseId.startsWith('s2_')` against ids
// like "C-S01", inflating s2/forget/arbitration/confirm to full marks).
const failedCasesFor = checkPrefix => new Set(
  evidence.failures.filter(item => String(item.check || '').startsWith(checkPrefix)).map(item => item.caseId)
).size;
const fmt = (ok, total) => `${ok}/${total}`;
// Harness survival: a wedged operation must cost the case, not the run.
const withCaseTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((resolve, reject) => setTimeout(() => reject(new Error(`CASE_TIMEOUT ${label} after ${ms}ms`)), ms).unref ? new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`CASE_TIMEOUT ${label} after ${ms}ms`)), ms); if (t.unref) t.unref(); }) : undefined)
]);

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
  SELECT a.id, a.status, a.sensitivity, a.canonical_key, a.resource_revision, v.content
  FROM memory_assertions a
  LEFT JOIN assertion_versions v ON v.id = a.current_version_id
  ORDER BY v.created_at
`)).rows;

console.log(`重建评测库 ${DB_NAME} ...`);
execFileSync('psql', ['-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`]);
execFileSync('psql', ['-q', '-d', 'postgres', '-c', `CREATE DATABASE ${DB_NAME}`]);

process.env.CORE_V0_MEMORY_PIPELINE_ENABLED = 'true';
process.env.CORE_V0_MEMORY_EXTRACT_BUDGET_MS = '30000';
process.env.MEMORY_HYBRID_RETRIEVAL = 'true';
// R-011: the eval judges R-008 latest-wins arbitration, which is flag-gated -
// without this the arbitration cases can only ever report conflict.
process.env.MEMORY_CONFLICT_LATEST_WINS = 'true';
process.env.MEMORY_AUDN_SIMILAR_MIN_SCORE = process.env.MEMORY_AUDN_SIMILAR_MIN_SCORE || '0.6';
process.env.MEMORY_VECTOR_MIN_SCORE = process.env.MEMORY_VECTOR_MIN_SCORE || '0.55';
// Record the effective knobs so the numbers stay interpretable later.
evidence.config = {
  conflictLatestWins: true,
  audnSimilarMinScore: Number(process.env.MEMORY_AUDN_SIMILAR_MIN_SCORE),
  vectorMinScore: Number(process.env.MEMORY_VECTOR_MIN_SCORE),
  embeddingModel: process.env.MEMORY_EMBEDDING_MODEL || 'bge-m3'
};
// Preflight: with hybrid retrieval enabled the whole eval silently degrades
// to lexical-only if the embedding gateway is down (observed 2026-09-08: an
// Ollama killed by a reboot turned the 3c rerun into a fake "no improvement"
// baseline). Fail fast instead of measuring a crippled mode.
if (process.env.MEMORY_HYBRID_RETRIEVAL === 'true') {
  const embedUrl = process.env.MEMORY_EMBEDDING_URL || 'http://127.0.0.1:11434/api/embeddings';
  const embedModel = process.env.MEMORY_EMBEDDING_MODEL || 'bge-m3';
  try {
    const probe = await fetch(embedUrl.replace(/\/api\/embeddings$/, '/api/tags'), { signal: AbortSignal.timeout(3000) });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    const models = await probe.json();
    const names = (models.models || []).map(m => String(m.name || ''));
    if (names.length && !names.some(n => n === embedModel || n.split(':')[0] === embedModel)) {
      throw new Error(`model ${embedModel} not loaded (have: ${names.join(', ')})`);
    }
    console.log(`embedding gateway ready: ${embedUrl} [${embedModel}]`);
  } catch (error) {
    console.error(`FATAL: embedding gateway unavailable (${embedUrl}): ${error?.message}`);
    console.error('Refusing to run a hybrid-retrieval eval against a dead vector channel.');
    process.exit(2);
  }
}

const pool = new pg.Pool({ connectionString: CONNECTION, max: 50 });
resetCoreV0ProductionSchemaCache();

// Hang diagnostics (runs 4-6 hung mid-group): a phase log plus a watchdog
// sampling pool saturation every 30s, both appended to a file so a stuck run
// can be read live.
const progressFile = new URL('./eval-progress.log', import.meta.url);
const logPhase = line => { try { appendFileSync(progressFile, `[${new Date().toISOString()}] ${line} pool=${pool.totalCount}/${pool.idleCount}+${pool.waitingCount}\n`); } catch { /* diagnostics only */ } };
const watchdog = setInterval(() => {
  try { appendFileSync(progressFile, `[wd ${new Date().toISOString()}] pool total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}\n`); } catch { /* diagnostics only */ }
}, 30_000);

try {
  const schema = await prepareCoreV0ProductionSchema(pool, { production: false, autoMigrate: true });
  console.log(`schema ready (migrated=${schema.migrated})`);

  const adapter = await createCoreV0ProductionAdapter({ pool, context, baseState: baseState(), modelProvider: 'deepseek' });
  const { service, drainExtraction, memoryPort } = adapter;

  // ---- Group A: extraction quality --------------------------------------
  logPhase('groupA start');
  for (const item of cases.groupA.facts) {
    logPhase(`A ${item.id}`);
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
    evidence.metrics.chit_chat_leak_rate = fmt(cases.groupA.chitChat.length - failedCasesFor('chit_chat_leak'), cases.groupA.chitChat.length);
    evidence.metrics.dedup_effective = fmt(cases.groupA.dedup.length - failedCasesFor('dedup'), cases.groupA.dedup.length);
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
  logPhase('groupB ingest start');
  for (const item of cases.groupB.paraphrase) {
    logPhase(`B-ingest ${item.id}`);
    await handle(service, item.message, item.id);
    await drainExtraction();
    const rows = await assertRows(pool);
    const row = rows.find(entry => entry.status === 'active' && String(entry.content || '').includes(item.targetKeyword));
    if (row) indexKeyword(item.targetKeyword, row.id);
  }
  // R-011: group B judges the RAW retrieval channel (module retrieveAsync
  // items). Two earlier judging channels are unusable for retrieval quality:
  // `recalled` merges the whole profile snapshot (unrelated queries can never
  // recall zero), and bundle.evidence gets trimmed to a single entry by the
  // token-budget compaction once the profile grows (R-010 finding 3,
  // quantified: every failure in the interim run showed retrieved=1).
  const { createOllamaEmbeddingGateway } = await import('../server/memory-embedding.js');
  const probeGateway = createOllamaEmbeddingGateway({
    url: process.env.MEMORY_EMBEDDING_URL || 'http://127.0.0.1:11434/api/embeddings',
    model: process.env.MEMORY_EMBEDDING_MODEL || 'bge-m3'
  });
  const probeState = await adapter.repository.load(context);
  const probeMemory = createMemoryModule(probeState, async () => {}, {
    projectionEnabled: true,
    featureFlags: { hybridRetrieval: true, conflictLatestWins: true },
    embeddingGateway: probeGateway,
    embeddingTimeoutMs: 2000,
    vectorMinScore: Number(process.env.MEMORY_VECTOR_MIN_SCORE) || 0.55,
    lexicalFloorRatio: Number(process.env.MEMORY_LEXICAL_FLOOR_RATIO) || 0.5
  });
  const rawRetrieve = async query => {
    const result = await probeMemory.retrieveAsync(context, { query, purpose: 'answer_user_query' });
    return (result.items || []).map(item => ({ id: String(item.memoryId || item.id || ''), score: Number(item.score ?? 0) })).filter(item => item.id);
  };

  logPhase('groupB probe start');
  {
    let paraphraseHits = 0;
    for (const item of cases.groupB.paraphrase) {
      const ids = assertionIdsFor(item.targetKeyword);
      const retrieved = await rawRetrieve(item.query);
      const hit = ids.size > 0 && retrieved.some(item => ids.has(item.id));
      if (!hit) fail(item.id, 'paraphrase_miss', `query="${item.query}" (retrieved=${retrieved.length})`);
      else paraphraseHits += 1;
    }
    evidence.metrics.paraphrase_hit_rate = fmt(paraphraseHits, cases.groupB.paraphrase.length);
    let lexicalHits = 0;
    for (const item of cases.groupB.lexical) {
      const ids = assertionIdsFor(item.targetKeyword);
      const retrieved = await rawRetrieve(item.query);
      const hit = ids.size > 0 && retrieved.some(item => ids.has(item.id));
      if (!hit) fail(item.id, 'lexical_miss', `query="${item.query}" (retrieved=${retrieved.length})`);
      else lexicalHits += 1;
    }
    evidence.metrics.lexical_hit_rate = fmt(lexicalHits, cases.groupB.lexical.length);
    let noise = 0;
    for (const item of cases.groupB.noise) {
      const retrieved = await rawRetrieve(item.query);
      if (retrieved.length > 0) {
        noise += 1;
        // R-012: record the scores of the noise hits - without them the
        // residual cannot be attributed (threshold too low vs corpus topic
        // clustering vs fusion ordering).
        const scores = retrieved.map(item => item.score.toFixed(4)).join(',');
        fail(item.id, 'noise_recall', `unrelated query retrieved ${retrieved.length} items (scores: ${scores})`);
      }
    }
    evidence.metrics.precision_noise = fmt(noise, cases.groupB.noise.length);
  }
  console.log(`\n[组B 检索] paraphrase=${evidence.metrics.paraphrase_hit_rate} lexical=${evidence.metrics.lexical_hit_rate} noise=${evidence.metrics.precision_noise}`);

  // ---- Group C: governance correctness ----------------------------------
  // S2: the fact must land in pending_confirmation (not silently active).
  logPhase('groupC S2 start');
  for (const item of cases.groupC.s2) {
    logPhase(`C-S ${item.id}`);
    await handle(service, item.message, item.id);
    const drained = await drainExtraction();
    const rows = await assertRows(pool);
    const row = rows.find(entry => String(entry.content || '').includes(item.expectKeywords[0]));
    if (!row) { fail(item.id, 's2_missing', `no assertion for "${item.expectKeywords[0]}" (drain ${JSON.stringify(drained)})`); continue; }
    if (row.status !== 'pending_confirmation') fail(item.id, 's2_not_pending', `status=${row.status} (drain ${JSON.stringify(drained)})`);
  }
  evidence.metrics.s2_accuracy = fmt(cases.groupC.s2.length - failedCasesFor('s2_'), cases.groupC.s2.length);
  console.log(`\n[组C 治理] S2 pending=${evidence.metrics.s2_accuracy}`);

  // forget: state -> visible -> forget -> invisible
  logPhase('groupC forget start');
  for (const item of cases.groupC.forget) {
    logPhase(`C-F ${item.id}`);
    try {
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
      const memory = createMemoryModule(state, () => adapter.repository.save(context, state), { projectionEnabled: true });
      try {
        await memory.forget(context, row.id, { resourceRevision: row.resource_revision ?? row.resourceRevision ?? 1 });
      } catch (error) {
        if (error?.code === 'RESOURCE_REVISION_CONFLICT') {
          // The fire-and-forget drain may bump the revision between assertRows
          // and the forget; retry once against a fresh load.
          const fresh = await adapter.repository.load(context);
          const memory2 = createMemoryModule(fresh, () => adapter.repository.save(context, fresh), { projectionEnabled: true });
          const target = fresh.assertions.find(entry => entry.id === row.id);
          await memory2.forget(context, row.id, { resourceRevision: target.resourceRevision });
        } else throw error;
      }
      const after = await memoryPort.retrieveContext({ query: item.query, memorySessionId: null });
      if (after.recalled.some(recalled => String(recalled.id || '') === row.id)) fail(item.id, 'forget_resurrect', 'forgotten assertion still recalled');
    } catch (error) {
      fail(item.id, 'forget_error', `${error?.code || 'ERROR'}: ${String(error?.message || error).slice(0, 200)}`);
    }
  }
  evidence.metrics.forget_no_resurrection = fmt(cases.groupC.forget.length - failedCasesFor('forget_'), cases.groupC.forget.length);
  console.log(`[组C 治理] forget=${evidence.metrics.forget_no_resurrection}`);

  // arbitration: contradictory pair -> latest wins in the prompt
  logPhase('groupC arbitration start');
  for (const item of cases.groupC.arbitration) {
    logPhase(`C-A ${item.id}`);
    try {
      await handle(service, item.first, `${item.id}-1`);
      await drainExtraction();
      await handle(service, item.second, `${item.id}-2`);
      await drainExtraction();
      const result = await memoryPort.retrieveContext({ query: item.query, memorySessionId: null });
      if (result.answerability === 'conflict') fail(item.id, 'arbitration_conflict', 'answerability stuck at conflict');
      const rows = await assertRows(pool);
      const newest = rows.filter(entry => entry.status === 'active' && String(entry.content || '').includes(item.targetKeyword));
      if (!newest.length) fail(item.id, 'arbitration_latest', `latest value "${item.targetKeyword}" not in the corpus`);
    } catch (error) {
      fail(item.id, 'arbitration_error', `${error?.code || 'ERROR'}: ${String(error?.message || error).slice(0, 200)}`);
    }
  }
  evidence.metrics.arbitration_latest_wins = fmt(cases.groupC.arbitration.length - failedCasesFor('arbitration_'), cases.groupC.arbitration.length);
  console.log(`[组C 治理] arbitration=${evidence.metrics.arbitration_latest_wins}`);

  // confirm flow: S2 pending -> confirm -> visible. Uses dedicated facts
  // (disjoint from the S2 group) so the dedup gate cannot interfere.
  logPhase('groupC confirm start');
  for (const item of cases.groupC.confirm) {
    logPhase(`C-K ${item.id}`);
    try {
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
      const memory = createMemoryModule(state, () => adapter.repository.save(context, state), { projectionEnabled: true });
      await memory.confirm(context, confirmation.id, { resourceRevision: confirmation.resourceRevision });
      const result = await memoryPort.retrieveContext({ query: item.query, memorySessionId: null });
      if (!result.recalled.some(recalled => String(recalled.id || '') === row.id)) {
        fail(item.id, 'confirm_not_visible', `"${item.expectKeywords[0]}" not recalled after confirmation`);
      }
    } catch (error) {
      fail(item.id, 'confirm_error', `${error?.code || 'ERROR'}: ${String(error?.message || error).slice(0, 200)}`);
    }
  }
  evidence.metrics.confirm_visibility = fmt(cases.groupC.confirm.length - failedCasesFor('confirm_'), cases.groupC.confirm.length);
  console.log(`[组C 治理] confirm=${evidence.metrics.confirm_visibility}`);
} catch (error) {
  // The finally below calls process.exit, which would otherwise swallow the
  // thrown error and report a fake "0 failures" green run (this actually
  // happened: a PG auth failure surfaced as an empty-metrics summary).
  evalAborted = true;
  evidence.abortReason = String(error?.stack || error);
  console.error(`[eval] ABORTED: ${evidence.abortReason}`);
} finally {
  clearInterval(watchdog);
  logPhase('finally');
  evidence.finishedAt = new Date().toISOString();
  const allCases = cases.groupA.facts.length + cases.groupA.chitChat.length + cases.groupA.dedup.length
    + cases.groupB.paraphrase.length + cases.groupB.lexical.length + cases.groupB.noise.length
    + cases.groupC.s2.length + cases.groupC.forget.length + cases.groupC.arbitration.length + cases.groupC.confirm.length;
  evidence.totalCases = allCases;
  evidence.failedCases = new Set(evidence.failures.map(item => item.caseId)).size;
  await writeFile(new URL('../.rearchitecture-runs/memory-eval.json', import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(`\n==== 基线汇总：${allCases} case，${evidence.failedCases} 个失败 case，${evidence.failures.length} 条失败记录；明细见 .rearchitecture-runs/memory-eval.json ====`);
  // R-012 pool attribution: record the counts before closing, then close
  // gracefully (no race cap). If pool.end() completes and the DROP succeeds,
  // the leftover sessions seen in earlier runs were exit-residue from
  // process.exit, not mid-run leaks; if end() hangs, clients are genuinely
  // still checked out and the counts identify the phase that leaked them.
  console.log(`[pool] before end: total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`);
  logPhase(`pool-before-end total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`);
  const endResult = await Promise.race([pool.end().then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('timeout'), 15000))]);
  console.log(`[pool] end: ${endResult}`);
  logPhase(`pool-end ${endResult}`);
  try {
    execFileSync('psql', ['-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`]);
    console.log(`评测库 ${DB_NAME} 已清理`);
  } catch (error) {
    console.log(`评测库清理失败（可手动 DROP DATABASE ${DB_NAME}）: ${error?.message}`);
  }
  process.exit(evalAborted ? 1 : 0);
}
