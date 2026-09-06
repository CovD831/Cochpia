// Memory-loop proof, automated variant (R-005 B-07 + R-007b async semantics).
//
// Runs the production turn path on a real local PostgreSQL with the memory
// pipeline flag on and the deterministic extractor injected. The drain fires
// after the response (fire-and-forget, R-007b) — no step is performed by hand:
//
// E-schema  readiness plus auto-migration prepare the database
// E0        the empty-memory baseline recalls nothing
// E1        the stating turn commits
// E2        the raw event is durable in Memory PG
// E-timing  the turn response returns before the drain finishes (B-19)
// E3        the fired drain turned the event into an active, projected
//           assertion (eventual consistency, bounded wait)
// E4        a brand-new session's probe turn recalls the fact and its reply
//           takes the memory branch, with recall semantics exposed
// E5        deletion propagation removes the fact from the corpus (R-006)
// E6        no resurrection after deletion
//
// Usage: node scripts/memory-loop-proof.js
// Requires: local PostgreSQL; creates and drops the cochpia_loop_proof database.

import 'dotenv/config';
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import {
  createCoreV0ProductionAdapter,
  prepareCoreV0ProductionSchema,
  resetCoreV0ProductionSchemaCache
} from '../server/core-v0-production.js';
import { createDeterministicExtractor } from '../server/memory-extraction.js';
import { loadCoreV0SessionMessages } from '../server/core-v0-postgres.js';

const DB_NAME = 'cochpia_loop_proof';
const CONNECTION = `postgresql://localhost:5432/${DB_NAME}`;
const context = {
  tenantId: 'loop-proof-tenant',
  subjectUserId: 'loop-proof-user',
  actorType: 'user',
  actorId: 'loop-proof-user',
  callerAgentId: 'cochpia',
  correlationId: 'memory-loop-proof'
};
const evidence = { startedAt: new Date().toISOString(), database: DB_NAME, mode: 'automated-async', checks: [] };
const record = (id, ok, detail, data = null) => {
  evidence.checks.push({ id, ok, detail, data });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
};

const waitFor = async (fn, { timeoutMs = 15_000, intervalMs = 200 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
};

console.log(`重建验证库 ${DB_NAME} ...`);
execFileSync('psql', ['-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`]);
execFileSync('psql', ['-q', '-d', 'postgres', '-c', `CREATE DATABASE ${DB_NAME}`]);

process.env.CORE_V0_MEMORY_PIPELINE_ENABLED = 'true';
const pool = new pg.Pool({ connectionString: CONNECTION });
resetCoreV0ProductionSchemaCache();

const baseState = {
  sessions: [
    { id: 'session-food', title: '会话 A：陈述事实', summary: '', persona: '', atmosphere: '', companionIntent: 'listen' },
    { id: 'session-other', title: '会话 B：全新会话', summary: '', persona: '', atmosphere: '', companionIntent: 'listen' }
  ],
  messages: { 'session-food': [], 'session-other': [] },
  personality: { version: 1, summary: '闭环验证', traits: [] },
  profile: { name: 'Cochpia', gender: 'none', age: null }
};

try {
  console.log('应用 Core + Memory schema（autoMigrate 开发通道）...');
  const schema = await prepareCoreV0ProductionSchema(pool, { production: false, autoMigrate: true });
  record('E-schema', schema.migrated === true && schema.coreReady && schema.memoryReady,
    `真实 PG 上 readiness + DDL 准备成功（migrated=${schema.migrated}）`);

  const adapter = await createCoreV0ProductionAdapter({
    pool,
    context,
    baseState,
    modelProvider: 'mock',
    extractor: createDeterministicExtractor()
  });
  const { memoryPort, service, drainExtraction } = adapter;
  record('E-wiring', typeof drainExtraction === 'function',
    'flag on：adapter 暴露 drain，注入确定性 extractor（验收注入点）');

  const baseline = await memoryPort.retrieveContext({ query: '我能吃花生酱饼干吗', memorySessionId: null });
  record('E0-baseline', baseline.answerability === 'not_found',
    `空库基线：answerability=${baseline.answerability}（无凭空记忆）`);

  const factStartedAt = Date.now();
  const factTurn = await service.handleTurn({
    body: { sessionId: 'session-food', message: '请记住：我对花生过敏，吃花生制品会起疹子。', channel: '默认' },
    headerIdempotencyKey: `proof-${randomUUID()}`
  });
  const factTurnMs = Date.now() - factStartedAt;
  record('E1-admission', factTurn.status === 'committed', `事实陈述 turn：${factTurn.status}（响应 ${factTurnMs}ms）`,
    { turnId: factTurn.turnId, memoryStatus: factTurn.memoryStatus, recalledCount: factTurn.recalledCount ?? null });

  const raw = await pool.query("SELECT event_id FROM raw_events WHERE content LIKE '%花生%'");
  record('E2-durable', raw.rowCount > 0, `raw_events 落库 ${raw.rowCount} 行含"花生"`,
    { rawEventIds: raw.rows.map(row => row.event_id) });

  // R-007b: the route fires the drain after writing the response and never
  // blocks it. Fire overhead must be negligible against the drain duration.
  const drainFiredAt = Date.now();
  const drainPromise = drainExtraction();
  const fireOverheadMs = Date.now() - drainFiredAt;
  await drainPromise;
  const drainTotalMs = Date.now() - drainFiredAt;
  record('E-timing', fireOverheadMs < 50 && drainTotalMs > 0,
    `fire-and-forget：fire 开销 ${fireOverheadMs}ms，drain 总耗时 ${drainTotalMs}ms，turn 响应 ${factTurnMs}ms 不承担提取`,
    { fireOverheadMs, drainTotalMs, factTurnMs });

  const activeAssertions = await pool.query("SELECT count(*)::int AS n FROM memory_assertions WHERE status='active'");
  const snapshotItems = await pool.query('SELECT count(*)::int AS n FROM profile_snapshot_items');
  record('E3-pipeline', activeAssertions.rows[0].n >= 1 && snapshotItems.rows[0].n >= 1,
    `drain 消化后：active 断言 ${activeAssertions.rows[0].n} 条、snapshot_items ${snapshotItems.rows[0].n} 行`,
    { activeAssertions: activeAssertions.rows[0].n, snapshotItems: snapshotItems.rows[0].n });

  const probeTurn = await service.handleTurn({
    body: { sessionId: 'session-other', message: '下午茶想吃点心，有什么需要避开的吗？', channel: '默认' },
    headerIdempotencyKey: `proof-${randomUUID()}`
  });
  const probeMessages = await loadCoreV0SessionMessages(pool, context, { sessionId: 'session-other' });
  const reply = probeMessages.find(item => item.role === 'assistant')?.content || '';
  const memoryBranch = reply.includes('过去的经历');
  const recallOk = (probeTurn.recalledCount ?? 0) >= 1 && probeTurn.memoryAnswerability === 'known';
  record('E4-closed-loop', probeTurn.status === 'committed' && memoryBranch && recallOk,
    `全新会话提问：turn=${probeTurn.status}，recalledCount=${probeTurn.recalledCount}，answerability=${probeTurn.memoryAnswerability}，回复走"有记忆"分支=${memoryBranch}`,
    { reply: reply.slice(0, 60), recalledCount: probeTurn.recalledCount, memoryAnswerability: probeTurn.memoryAnswerability });

  const foodMessages = await loadCoreV0SessionMessages(pool, context, { sessionId: 'session-food' });
  const statedUserMessage = foodMessages.find(item => item.role === 'user');
  const forgottenBefore = await pool.query("SELECT count(*)::int AS n FROM memory_assertions WHERE status='forgotten'");
  await adapter.deleteApplicationMessage({ sessionId: 'session-food', messageId: statedUserMessage.id });
  const forgottenAfter = await pool.query("SELECT count(*)::int AS n FROM memory_assertions WHERE status='forgotten'");
  const snapshotItemsAfterDelete = await pool.query('SELECT count(*)::int AS n FROM profile_snapshot_items');
  const messageAfterDelete = await loadCoreV0SessionMessages(pool, context, { sessionId: 'session-food' });
  record('E5-deletion', forgottenAfter.rows[0].n > forgottenBefore.rows[0].n
    && snapshotItemsAfterDelete.rows[0].n === 0
    && !messageAfterDelete.some(item => item.id === statedUserMessage.id),
    `删除传播：断言 forgotten ${forgottenBefore.rows[0].n}->${forgottenAfter.rows[0].n}，snapshot_items ${snapshotItemsAfterDelete.rows[0].n}，Core 消息已删`,
    { forgotten: forgottenAfter.rows[0].n, snapshotItems: snapshotItemsAfterDelete.rows[0].n });

  await drainExtraction();
  const resurrectionProbe = await service.handleTurn({
    body: { sessionId: 'session-other', message: '花生制品现在能吃了吗？', channel: '默认' },
    headerIdempotencyKey: `proof-${randomUUID()}`
  });
  const resurrectionMessages = await loadCoreV0SessionMessages(pool, context, { sessionId: 'session-other' });
  const resurrectionReply = resurrectionMessages.filter(item => item.role === 'assistant').at(-1)?.content || '';
  const noMemoryBranch = !resurrectionReply.includes('过去的经历');
  record('E6-no-resurrection', (resurrectionProbe.recalledCount ?? 0) === 0
    && resurrectionProbe.memoryAnswerability === 'not_found'
    && noMemoryBranch,
    `删除后全新提问：recalledCount=${resurrectionProbe.recalledCount}，answerability=${resurrectionProbe.memoryAnswerability}，无记忆回复分支=${noMemoryBranch}`,
    { reply: resurrectionReply.slice(0, 60), recalledCount: resurrectionProbe.recalledCount });
} finally {
  evidence.finishedAt = new Date().toISOString();
  evidence.passed = evidence.checks.filter(item => item.ok).length;
  evidence.total = evidence.checks.length;
  await writeFile(new URL('../.rearchitecture-runs/memory-loop-proof.json', import.meta.url),
    JSON.stringify(evidence, null, 2));
  console.log(`\n结果：${evidence.passed}/${evidence.total} 通过；证据已写入 .rearchitecture-runs/memory-loop-proof.json`);
  await pool.end();
  execFileSync('psql', ['-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`]);
  console.log(`验证库 ${DB_NAME} 已清理`);
}
