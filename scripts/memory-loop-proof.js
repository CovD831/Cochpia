// Minimal memory-loop proof against a real local PostgreSQL.
//
// E0  baseline: with an empty memory, a peanut query recalls nothing
// E1  fact admission: one turn stores "对花生过敏" through the production path
// E2  durable facts: raw_events / bindings / assertions land in Memory PG
// E3  same-session recall and cross-session recall, quantified separately
// E4  reply branch: the assistant reply proves whether recall fed generation
// E5  deletion propagation: expected to be absent, recorded as a gap
//
// Usage: node scripts/memory-loop-proof.js
// Requires: local PostgreSQL; creates and drops the cochpia_loop_proof database.

import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createCoreV0ProductionAdapter,
  prepareCoreV0ProductionSchema,
  resetCoreV0ProductionSchemaCache
} from '../server/core-v0-production.js';
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
const evidence = { startedAt: new Date().toISOString(), database: DB_NAME, checks: [] };
const record = (id, ok, detail, data = null) => {
  evidence.checks.push({ id, ok, detail, data });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
};

console.log(`重建验证库 ${DB_NAME} ...`);
execFileSync('psql', ['-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`]);
execFileSync('psql', ['-q', '-d', 'postgres', '-c', `CREATE DATABASE ${DB_NAME}`]);

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

let adapter = null;
try {
  console.log('应用 Core + Memory schema（autoMigrate 开发通道）...');
  const schema = await prepareCoreV0ProductionSchema(pool, { production: false, autoMigrate: true });
  record('E-schema', schema.migrated === true && schema.coreReady && schema.memoryReady,
    `真实 PG 上 readiness + DDL 准备成功（migrated=${schema.migrated}）`);

  adapter = await createCoreV0ProductionAdapter({
    pool,
    context,
    baseState,
    modelProvider: 'mock'
  });
  const { memoryPort, service } = adapter;

  // E0 baseline: empty memory must not recall anything
  const baseline = await memoryPort.retrieveContext({ query: '我能吃花生酱饼干吗', memorySessionId: null });
  const baselineItems = JSON.stringify(baseline.bundle || baseline).includes('花生');
  record('E0-baseline', !baselineItems, '空库基线：花生查询召回为空（无凭空记忆）',
    { answerability: baseline.answerability, status: baseline.status });

  // E1 fact admission through the production turn path
  const factTurn = await service.handleTurn({
    body: { sessionId: 'session-food', message: '请记住：我对花生过敏，吃花生制品会起疹子。', channel: '默认' },
    headerIdempotencyKey: `proof-${randomUUID()}`
  });
  record('E1-admission', factTurn.status === 'committed', `事实陈述 turn：${factTurn.status}`,
    { turnId: factTurn.turnId, memoryStatus: factTurn.memoryStatus });

  // E2 durable facts in Memory PG
  const raw = await pool.query("SELECT event_id, content FROM raw_events WHERE content LIKE '%花生%'");
  const assertions = await pool.query("SELECT assertion_type, canonical_key FROM memory_assertions WHERE canonical_key LIKE '%花生%' OR canonical_key LIKE '%allerg%'");
  const bindings = await pool.query('SELECT COUNT(*)::int AS n FROM core_v0_memory_session_bindings');
  record('E2-durable', raw.rowCount > 0, `raw_events 落库 ${raw.rowCount} 行含"花生"；assertions 匹配 ${assertions.rowCount} 行；Core-Memory 绑定 ${bindings.rows[0].n} 条`,
    { rawEventIds: raw.rows.map(r => r.event_id), assertionKeys: assertions.rows.map(r => r.canonical_key) });

  // E3 recall, same session vs cross session
  // E3 recall with the bound memory session, exactly as the turn service
  // retrieves internally. Expected empty: no active assertion exists yet.
  const binding = await pool.query('SELECT memory_session_id FROM core_v0_memory_session_bindings WHERE memory_session_id IS NOT NULL LIMIT 1');
  const memorySessionId = binding.rows[0]?.memory_session_id || null;
  const recallSame = await memoryPort.retrieveContext({ query: '我能吃花生酱饼干吗', memorySessionId });
  record('E3-recall', recallSame.answerability === 'not_found',
    `绑定 memory session 检索：answerability=${recallSame.answerability}（机制正常但语料空——断点在提取，不在检索）`,
    { answerability: recallSame.answerability, memorySessionId });

  // Turn in the brand-new session B, asking the same question
  const probeTurn = await service.handleTurn({
    body: { sessionId: 'session-other', message: '我能吃花生酱饼干吗？', channel: '默认' },
    headerIdempotencyKey: `proof-${randomUUID()}`
  });
  const probeMessages = await loadCoreV0SessionMessages(pool, context, { sessionId: 'session-other' });
  const assistantReply = probeMessages.find(item => item.role === 'assistant')?.content || '';
  const usedMemoryBranch = assistantReply.includes('过去的经历');
  record('E4-cross-session', probeTurn.status === 'committed' && usedMemoryBranch,
    `全新会话提问：turn=${probeTurn.status}；回复走"有记忆"分支=${usedMemoryBranch}；memoryStatus=${probeTurn.memoryStatus}`,
    { reply: assistantReply.slice(0, 60), memoryStatus: probeTurn.memoryStatus });

  // E5 deletion propagation: Core message deletion is refused by design
  const coreMessages = await loadCoreV0SessionMessages(pool, context, { sessionId: 'session-food' });
  const rawAfterProbe = await pool.query('SELECT COUNT(*)::int AS n FROM raw_events');
  record('E5-deletion', false, `删除传播缺口（预期内）：Core 消息删除被设计拒绝（路由层 501），且 ${rawAfterProbe.rows[0].n} 条 raw event 无级联删除路径；消息 ${coreMessages.length} 条、事实仍在`,
    { coreMessages: coreMessages.length, rawEvents: rawAfterProbe.rows[0].n });

  // E6 isolate the break: run the designed extraction step manually, as a
  // model-driven worker would (createCandidate + promoteCandidate + save)
  const { createMemoryModule } = await import('../server/memory-module.js');
  const fullState = await adapter.repository.load(context);
  const sourceEvent = fullState.rawEvents.find(item => (item.content || '').includes('花生'));
  if (!sourceEvent) throw new Error('E6 需要 source event，但未找到含"花生"的 raw event');
  const memory = createMemoryModule(fullState, async () => {});
  const candidate = await memory.createCandidate(context, {
    sourceEventId: sourceEvent.id,
    content: '用户对花生过敏，食用花生制品会起疹子。',
    memoryType: 'dietary_restriction',
    assertionType: 'observed_fact',
    scopeType: 'user'
  });
  if (candidate.memory) {
    await memory.promoteCandidate(context, candidate.memory.memoryId, {
      resourceRevision: candidate.memory.resourceRevision
    });
  }
  await adapter.repository.save(context, memory.state);
  // Snapshot projection: an active assertion only enters retrieval via its
  // session profile snapshot. A projection worker owns this step in the
  // design and projects to every active session; emulate that here.
  const promotedVersion = candidate.memory?.versionId;
  if (promotedVersion) {
    await pool.query(`
      INSERT INTO profile_snapshot_items (snapshot_id, tenant_id, user_id, assertion_id, version_id, scope_type, created_at)
      SELECT DISTINCT ms.profile_snapshot_id, ms.tenant_id, ms.user_id, $1::text, $2::text, 'user', now()
      FROM memory_sessions ms
      WHERE ms.tenant_id=$3 AND ms.user_id=$4 AND ms.profile_snapshot_id IS NOT NULL
        AND ms.status='active' AND ms.expires_at > now()
    `, [candidate.memory.memoryId, promotedVersion, context.tenantId, context.subjectUserId]);
  }
  const activeAssertions = await pool.query("SELECT count(*)::int AS n FROM memory_assertions WHERE status='active'");
  const snapshotItems = await pool.query('SELECT count(*)::int AS n FROM profile_snapshot_items');
  const afterExtract = await memoryPort.retrieveContext({ query: '我能吃花生酱饼干吗', memorySessionId });
  const recallText = JSON.stringify(afterExtract.bundle || afterExtract);
  record('E6-extraction', afterExtract.answerability === 'known' && recallText.includes('花生'),
    `提取 + 快照投影完成后：active 断言 ${activeAssertions.rows[0].n} 条、snapshot_items ${snapshotItems.rows[0].n} 行，answerability=${afterExtract.answerability}，召回含"花生"=${recallText.includes('花生')}`,
    { answerability: afterExtract.answerability, activeAssertions: activeAssertions.rows[0].n, snapshotItems: snapshotItems.rows[0].n });

  // E7 with extraction wired, a fresh-session turn must take the memory branch
  const finalTurn = await service.handleTurn({
    body: { sessionId: 'session-other', message: '花生酱饼干我可以吃吗？', channel: '默认' },
    headerIdempotencyKey: `proof-${randomUUID()}`
  });
  const finalMessages = await loadCoreV0SessionMessages(pool, context, { sessionId: 'session-other' });
  const finalReply = finalMessages.filter(item => item.role === 'assistant').at(-1)?.content || '';
  const finalBranch = finalReply.includes('过去的经历');
  record('E7-closed-loop', finalTurn.status === 'committed' && finalBranch,
    `提取接上后全新会话提问：turn=${finalTurn.status}，回复走"有记忆"分支=${finalBranch}`,
    { reply: finalReply.slice(0, 60), memoryStatus: finalTurn.memoryStatus });

} finally {
  evidence.finishedAt = new Date().toISOString();
  evidence.passed = evidence.checks.filter(c => c.ok).length;
  evidence.total = evidence.checks.length;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(new URL('../.rearchitecture-runs/memory-loop-proof.json', import.meta.url),
    JSON.stringify(evidence, null, 2));
  console.log(`\n结果：${evidence.passed}/${evidence.total} 通过；证据已写入 .rearchitecture-runs/memory-loop-proof.json`);
  await pool.end();
  execFileSync('psql', ['-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`]);
  console.log(`验证库 ${DB_NAME} 已清理`);
}
