// R-005 extraction smoke: real-model extraction quality on the production
// path. Uses the configured DeepSeek provider end to end - no deterministic
// double - and quantifies candidates, promotion policy, parse failures and
// drain latency per message.
//
// Usage: DEEPSEEK_API_KEY=... node scripts/extraction-smoke.js
// Requires: local PostgreSQL; creates and drops cochpia_extraction_smoke.

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
import { loadCoreV0SessionMessages } from '../server/core-v0-postgres.js';

// The ambient shell may not export USER (pg defaults its user from it), so
// resolve the PG user the same way libpq does instead of trusting the env.
const resolvePgUser = () => {
  if (process.env.PGUSER) return process.env.PGUSER;
  return execFileSync('psql', ['-qtAc', 'select current_user', '-d', 'postgres'], { encoding: 'utf8' }).trim();
};


const DB_NAME = 'cochpia_extraction_smoke';
const CONNECTION = `postgresql://${resolvePgUser()}@localhost:5432/${DB_NAME}`;

const apiKey = process.env.MODEL_DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.MODEL_API_KEY;
if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY（或 MODEL_DEEPSEEK_API_KEY / MODEL_API_KEY）');
  process.exit(1);
}
process.env.MODEL_PROVIDER = 'deepseek';
process.env.MODEL_DEEPSEEK_API_KEY = apiKey;
process.env.MODEL_NAME = process.env.MODEL_NAME || 'deepseek-v4-flash';
process.env.CORE_V0_MEMORY_PIPELINE_ENABLED = 'true';
process.env.CORE_V0_MEMORY_EXTRACT_BUDGET_MS = '12000';

const context = {
  tenantId: 'smoke-tenant',
  subjectUserId: 'smoke-user',
  actorType: 'user',
  actorId: 'smoke-user',
  callerAgentId: 'cochpia',
  correlationId: 'extraction-smoke'
};

const TURNS = [
  { id: 'T1', message: '我对花生过敏，吃花生制品会起疹子。', expectation: '>=1 active (S0)' },
  { id: 'T2', message: '今天外面天气真好，心情不错。', expectation: '0 candidates (chit-chat)' },
  { id: 'T3', message: '我在服用华法林抗凝，医生说每周要验血。', expectation: 'pending confirmation (S2 health)' },
  { id: 'T4', message: '我叫林晓，今年三十二岁，在杭州做产品设计。', expectation: '>=1 active (profile)' },
  { id: 'T5', message: '昨天看了场电影，还不错。', expectation: '0 candidates (chit-chat)' },
  { id: 'T6', message: '我女朋友叫阿禾，她对猫毛过敏。', expectation: '>=1 active (relationship)' }
];

const evidence = { startedAt: new Date().toISOString(), model: 'deepseek-v4-flash', turns: [], assertions: null, retrieval: null };

console.log(`重建冒烟库 ${DB_NAME} ...`);
execFileSync('psql', ['-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`]);
execFileSync('psql', ['-q', '-d', 'postgres', '-c', `CREATE DATABASE ${DB_NAME}`]);

const pool = new pg.Pool({ connectionString: CONNECTION });
resetCoreV0ProductionSchemaCache();

const baseState = {
  sessions: [{ id: 'session-smoke', title: '提取冒烟', summary: '', persona: '', atmosphere: '', companionIntent: 'listen' }],
  messages: { 'session-smoke': [] },
  personality: { version: 1, summary: '提取冒烟', traits: [] },
  profile: { name: 'Cochpia', gender: 'none', age: null }
};

const latency = [];
try {
  const schema = await prepareCoreV0ProductionSchema(pool, { production: false, autoMigrate: true });
  console.log(`schema ready (migrated=${schema.migrated})\n`);

  const adapter = await createCoreV0ProductionAdapter({
    pool,
    context,
    baseState,
    modelProvider: 'deepseek',
    modelName: process.env.MODEL_NAME
  });
  const { service, drainExtraction } = adapter;

  for (const item of TURNS) {
    const turn = await service.handleTurn({
      body: { sessionId: 'session-smoke', message: item.message, channel: '默认' },
      headerIdempotencyKey: `smoke-${randomUUID()}`
    });
    const started = Date.now();
    const drained = await drainExtraction();
    const elapsed = Date.now() - started;
    latency.push(elapsed);
    const entry = {
      id: item.id,
      expectation: item.expectation,
      turnStatus: turn.status,
      drain: drained,
      drainMs: elapsed
    };
    evidence.turns.push(entry);
    console.log(`${item.id}  turn=${turn.status}  drain=${JSON.stringify(drained)}  ${elapsed}ms`);
  }

  const assertions = await pool.query(`
    SELECT a.status, a.sensitivity, a.memory_type, v.content
    FROM memory_assertions a
    LEFT JOIN assertion_versions v ON v.id = a.current_version_id
    ORDER BY a.created_at
  `);
  evidence.assertions = assertions.rows;
  console.log('\n断言库：');
  for (const row of assertions.rows) {
    console.log(`  [${row.status}/${row.sensitivity}] ${String(row.content || '').slice(0, 50)}`);
  }

  const failures = await pool.query("SELECT count(*)::int AS n FROM memory_audit_events WHERE action='memory_extraction_failed'");
  console.log(`\n提取失败事件：${failures.rows[0].n}`);

  const drainProbe = await drainExtraction();
  const probeTurn = await service.handleTurn({
    body: { sessionId: 'session-smoke', message: '最近饮食方面我需要注意什么？', channel: '默认' },
    headerIdempotencyKey: `smoke-${randomUUID()}`
  });
  const probeMessages = await loadCoreV0SessionMessages(pool, context, { sessionId: 'session-smoke' });
  const probeReply = probeMessages.filter(item => item.role === 'assistant').at(-1)?.content || '';
  evidence.retrieval = {
    recalledCount: probeTurn.recalledCount ?? null,
    memoryAnswerability: probeTurn.memoryAnswerability ?? null,
    replyExcerpt: probeReply.slice(0, 120)
  };
  console.log(`\n检索冒烟：recalledCount=${probeTurn.recalledCount} answerability=${probeTurn.memoryAnswerability}`);
  console.log(`回复节选：${probeReply.slice(0, 100)}`);

  latency.sort((left, right) => left - right);
  evidence.latency = {
    p50: latency[Math.floor(latency.length / 2)] || null,
    p95: latency[Math.max(0, Math.ceil(latency.length * 0.95) - 1)] || null,
    max: latency.at(-1) || null
  };
  const totals = evidence.turns.reduce((acc, entry) => {
    for (const key of ['extracted', 'promoted', 'pending', 'skipped', 'failed']) acc[key] = (acc[key] || 0) + (entry.drain?.[key] || 0);
    return acc;
  }, {});
  evidence.totals = totals;
  console.log(`\n汇总：${JSON.stringify(totals)}  延迟 p50=${evidence.latency.p50}ms p95=${evidence.latency.p95}ms max=${evidence.latency.max}ms`);
} finally {
  evidence.finishedAt = new Date().toISOString();
  await writeFile(new URL('../.rearchitecture-runs/extraction-smoke.json', import.meta.url),
    JSON.stringify(evidence, null, 2));
  console.log('\n证据已写入 .rearchitecture-runs/extraction-smoke.json');
  await pool.end();
  execFileSync('psql', ['-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`]);
  console.log(`冒烟库 ${DB_NAME} 已清理`);
}
