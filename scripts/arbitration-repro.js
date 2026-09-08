// Targeted repro: why does a value change fail to land? Trace C-A06
// (盗梦空间 => 星际穿越) through the real production pipeline, dumping
// extraction results, audit decisions, and the assertion table.
import 'dotenv/config';
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createCoreV0ProductionAdapter,
  prepareCoreV0ProductionSchema,
  resetCoreV0ProductionSchemaCache
} from '../server/core-v0-production.js';

const DB_NAME = 'cochpia_arbit_repro';
const resolvePgUser = () => process.env.PGUSER
  || execFileSync('psql', ['-qtAc', 'select current_user', '-d', 'postgres'], { encoding: 'utf8' }).trim();
const CONNECTION = `postgresql://${resolvePgUser()}@localhost:5432/${DB_NAME}`;
const context = { tenantId: 'eval-tenant', subjectUserId: 'eval-user', actorType: 'user', actorId: 'eval-user', callerAgentId: 'cochpia', correlationId: 'arbit-repro' };

execFileSync('psql', ['-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`]);
execFileSync('psql', ['-q', '-d', 'postgres', '-c', `CREATE DATABASE ${DB_NAME}`]);
process.env.MEMORY_EXTRACT_CONTEXT_TURNS = process.env.MEMORY_EXTRACT_CONTEXT_TURNS || '4';
process.env.CORE_V0_MEMORY_PIPELINE_ENABLED = 'true';
process.env.CORE_V0_MEMORY_EXTRACT_BUDGET_MS = '30000';
process.env.MEMORY_HYBRID_RETRIEVAL = 'true';
process.env.MEMORY_CONFLICT_LATEST_WINS = 'true';

const pool = new pg.Pool({ connectionString: CONNECTION, max: 10 });
resetCoreV0ProductionSchemaCache();
try {
  await prepareCoreV0ProductionSchema(pool, { production: false, autoMigrate: true });
  const adapter = await createCoreV0ProductionAdapter({
    pool, context,
    baseState: { sessions: [{ id: 's-repro', title: '复现', summary: '', persona: '', atmosphere: '', companionIntent: 'listen' }], messages: { 's-repro': [] }, personality: { version: 1, summary: '复现', traits: [] }, profile: { name: 'Cochpia', gender: 'none', age: null } },
    modelProvider: 'deepseek'
  });
  const { service, drainExtraction } = adapter;
  const pairs = [
    ['C-A06', '我最喜欢的电影是《盗梦空间》。', '我现在最喜欢的电影换成了《星际穿越》。'],
    ['C-A09', '我常用的邮箱是 QQ 邮箱。', '我改用 gmail 了。'],
    ['C-A15', '我的指甲油是红色的。', '现在涂的是蓝色的。']
  ];
  for (const [id, first, second] of pairs) {
    console.log(`\n===== ${id} =====`);
    await service.handleTurn({ body: { sessionId: 's-repro', message: first, channel: '默认' }, headerIdempotencyKey: `r-${id}-1-${randomUUID()}` });
    console.log('drain1:', JSON.stringify(await drainExtraction()));
    await service.handleTurn({ body: { sessionId: 's-repro', message: second, channel: '默认' }, headerIdempotencyKey: `r-${id}-2-${randomUUID()}` });
    const ev2 = (await pool.query("SELECT metadata FROM raw_events WHERE content LIKE $1 ORDER BY occurred_at DESC LIMIT 1", [`%${second.slice(3, 8)}%`])).rows[0];
    console.log('event2 metadata:', JSON.stringify(ev2?.metadata).slice(0, 300));
    console.log('drain2:', JSON.stringify(await drainExtraction()));
    const rows = (await pool.query(`
      SELECT a.status, a.canonical_key, v.content, v.created_at
      FROM memory_assertions a LEFT JOIN assertion_versions v ON v.id = a.current_version_id
      ORDER BY v.created_at`)).rows;
    for (const row of rows) console.log(`  [${row.status}] ${String(row.content).slice(0, 44)}`);
    const events = (await pool.query(`SELECT action, left(coalesce(details::text,''),200) AS d, created_at FROM memory_audit_events ORDER BY created_at`)).rows;
    for (const e of events.slice(-6)) console.log(`  audit: ${e.action} ${e.d}`);
  }
} catch (error) {
  console.error('REPRO THREW:', error?.stack?.split('\n').slice(0, 5).join('\n') || error);
} finally {
  clearInterval();
  await pool.end().catch(() => {});
  execFileSync('psql', ['-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`]);
  process.exit(0);
}
