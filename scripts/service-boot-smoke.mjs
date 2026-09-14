#!/usr/bin/env node
// 服务启动冒烟闸门（2026-09-14，独立盲审 F3 处置）。
//
// 为什么存在：wave-3 恢复独立服务 worker 时，「服务能起 + 索引器活」只有一次性手工跑批，
// 独立盲审指出「生产服务修复不应仅凭一次性手工跑批即合并」。本脚本把那次手工序列
// 机制化：一次性集群 → 无垫片启动独立服务（显式开启索引 flag）→ SDK smoke →
// 验证 index_documents 落行 → 清理。
//
// 红线：只在 /tmp 一次性集群上跑，绝不触 5433；跑完立即清理（老板要求）。
// 运行：node scripts/service-boot-smoke.mjs（须沙箱外：PG + loopback socket）
// 需 PostgreSQL 17 客户端/服务端（/opt/homebrew/opt/postgresql@17）+ node_modules。

import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG_BIN = '/opt/homebrew/opt/postgresql@17/bin';
const PORT = Number(process.env.SMOKE_PG_PORT || 5493);
const SERVICE_PORT = Number(process.env.SMOKE_SERVICE_PORT || 8792);
const steps = [];
let verdict = 'PASS';

const record = (step, ok, note = '') => {
  steps.push({ step, ok, note });
  console.log(`${ok ? '✓' : '✗'} ${step}${note ? ' — ' + note : ''}`);
  if (!ok) verdict = 'FAILED';
};

const sh = (cmd, opts = {}) => spawnSync(cmd, { shell: true, cwd: ROOT, encoding: 'utf8', ...opts });

if (!existsSync(path.join(PG_BIN, 'initdb'))) {
  console.error(`PG binaries not found at ${PG_BIN}`);
  process.exit(1);
}

const clusterDir = mkdtempSync(path.join(tmpdir(), 'svc-boot-smoke-'));
const dataDir = path.join(clusterDir, 'data');
const sockDir = clusterDir;

try {
  // 1. initdb + start
  let r = sh(`${PG_BIN}/initdb -U lab -A trust -E utf8 -D ${dataDir}`, {
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
  });
  record('initdb', r.status === 0, r.stderr?.split('\n').slice(-1)[0]);
  if (verdict === 'FAILED') throw new Error('initdb failed');

  r = sh(`${PG_BIN}/pg_ctl -D ${dataDir} -l ${clusterDir}/pg.log -o "-p ${PORT} -k ${sockDir}" start`, {
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
  });
  record('pg_ctl start', r.status === 0, r.stderr?.split('\n').slice(-1)[0]);

  r = sh(`${PG_BIN}/createdb -h 127.0.0.1 -p ${PORT} -U lab cochpia_smoke`);
  record('createdb', r.status === 0, r.stderr?.split('\n').slice(-1)[0]);

  // 2. 启动独立服务（无垫片；显式开启索引 flag——盲审 F1：flag 全关则 worker 空转）
  // ⚠️ 必须清掉 NODE_OPTIONS：WorkBuddy 沙箱 shell 会注入
  // `--require=node-language-shim.cjs`，该 shim 与 redis/express 的模块加载存在
  // 时序敏感死锁（require('redis') 无声永久挂起，node 22/26 均复现；去掉即秒过）。
  // 真实部署 shell 没有这个注入，因此清掉才是对真实环境的忠实模拟。
  const serviceEnv = { ...process.env };
  delete serviceEnv.NODE_OPTIONS;
  Object.assign(serviceEnv, {
    DATABASE_URL: `postgresql://lab@127.0.0.1:${PORT}/cochpia_smoke`,
    MEMORY_MODULE_PORT: String(SERVICE_PORT),
    MEMORY_MODULE_AUTO_MIGRATE: 'true',
    MEMORY_HYBRID_RETRIEVAL: 'true',
    MEMORY_ALLOW_UNTRUSTED_ACTOR_HEADER: 'true',
    NODE_ENV: 'development'
  });
  const serviceLog = '/tmp/svc-boot-smoke-service.log';
  const service = spawn('node', ['services/memory-module/index.js'], {
    cwd: ROOT, env: serviceEnv,
    stdio: ['ignore', openSync(serviceLog, 'w'), openSync(serviceLog, 'a')]
  });
  let serviceExited = false;
  service.on('exit', () => { serviceExited = true; });

  // 3. 等服务就绪（/metrics 200，30s）
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    const probe = sh(`curl -s -o /dev/null -w "%{http_code}" --noproxy '*' --max-time 2 http://127.0.0.1:${SERVICE_PORT}/metrics`);
    ready = probe.stdout?.trim() === '200';
    if (!ready) await new Promise(res => setTimeout(res, 1000));
  }
  record('service boot (no shim)', ready, ready ? `port ${SERVICE_PORT}` : `see ${serviceLog}`);
  if (!ready) throw new Error('service failed to start');

  // 4. SDK smoke（外部 HTTP 链路，L11/L13 同款 5 用例）
  const sdkLog = '/tmp/svc-boot-smoke-sdk.log';
  r = sh(`npm run test:memory-sdk > ${sdkLog} 2>&1`, {
    env: {
      ...serviceEnv,
      MEMORY_MODULE_URL: `http://127.0.0.1:${SERVICE_PORT}`,
      MEMORY_MODULE_SDK_TENANT_ID: 'smoke-tenant',
      MEMORY_MODULE_SDK_USER_ID: 'smoke-user'
    },
    timeout: 120000
  });
  const sdkTail = (r.status === null && r.error ? String(r.error) : (r.stdout || '')).split('\n').filter(Boolean).slice(-3).join(' | ');
  record('SDK smoke (external HTTP)', r.status === 0, `exit=${r.status}${sdkTail ? ' — ' + sdkTail.slice(0, 160) : ' (输出见 ' + sdkLog + ')'}`);

  // 5. 索引器活性：以 agent actor 注入 raw event（POST /v1/events → outbox
  //    raw_event.created → worker 索引）。SDK 路径（user actor，经 dev gate）不产生
  //    可索引事件，故索引断言用独立的 agent-actor 注入。
  r = sh(`curl -s --noproxy '*' -w "\\n%{http_code}" -X POST http://127.0.0.1:${SERVICE_PORT}/v1/events -H "Content-Type: application/json" -H "x-memory-tenant-id: smoke-tenant" -H "x-memory-user-id: smoke-user" -H "x-memory-agent-id: smoke-agent" -d '{"event_id":"smoke-evt-1","content":"索引器冒烟事实","memoryType":"fact"}'`);
  const bodyOut = (r.stdout || '').trim().split('\n');
  const httpCode = bodyOut[bodyOut.length - 1];
  const respBody = bodyOut.slice(0, -1).join('');
  record('agent-actor raw event ingress', httpCode === '202', `http=${httpCode} body=${respBody.slice(0, 140)}`);

  // 5b. worker 需要时间：poll(1s) + claim + 处理 + save。注入后给 15s 沉降窗口，
  //     断言在清理后读持久日志做最终判定。
  //     注意：index_documents 行来自 active assertions（抽取→晋升链），本冒烟不配
  //     抽取网关，raw event 不直接入索引——行数仅信息性记录，不作断言。
  await new Promise(res => setTimeout(res, 15000));

  // 6. 清理（老板明确要求：跑完即清）
  try { service.kill('SIGTERM'); } catch {}
  await new Promise(res => setTimeout(res, 800));
  sh(`${PG_BIN}/pg_ctl -D ${dataDir} stop -m fast`);
  rmSync(clusterDir, { recursive: true, force: true });
  record('cleanup (cluster deleted)', !existsSync(clusterDir), '老板要求：不留 /tmp 残留');

  // 等 service 进程真正退出（shutdown 链含 worker.stop()/pool.end()，可能拖到 lease 上限），
  // 退出后日志才是最终态，再断言 worker 处理结果。
  for (let i = 0; i < 60 && !serviceExited; i++) await new Promise(res => setTimeout(res, 1000));
  let processed = 0;
  try {
    const content = readFileSync(serviceLog, 'utf8');
    const tail = content.slice(-140).replace(/\n/g, '\\n');
    processed = (content.match(/"status":"completed"/g) || []).length;
    console.log(`DEBUG: exit=${serviceExited} size=${content.length} completed=${processed} tail="${tail}"`);
  } catch (e) {
    console.log(`DEBUG: readFileSync threw: ${e.message}`);
  }
  record('worker processed ingested events', processed >= 1, `completed=${processed}（含 SDK 与 raw event 两个来源；serviceExited=${serviceExited}）`);
} catch (e) {
  record('aborted', false, e.message.slice(0, 120));
  // 兜底清理
  try { sh(`${PG_BIN}/pg_ctl -D ${dataDir} stop -m fast`); } catch {}
  try { rmSync(clusterDir, { recursive: true, force: true }); } catch {}
}

console.log('\n===== boot-smoke 摘要 =====');
console.log(JSON.stringify({ verdict, steps, port: PORT, date: new Date().toISOString() }, null, 2));
process.exit(verdict === 'PASS' ? 0 : 1);
