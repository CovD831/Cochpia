#!/usr/bin/env node
// 闸门防腐 runner（2026-09-14）。
//
// 为什么存在：闸门脚本不在 npm test 里，历史上已腐烂 4 次（阶段 2a/3/4 + A-12/P-09），
// 腐烂形态固定为「断言停在旧契约上」——结构性改动后没人记得重跑。本 runner 把
// 「重跑闸门」从记忆负担变成一条命令；配套哨兵 server/gate-antirot.test.js（在
// npm test 内）盯契约漂移。两者共享 scripts/gate-registry.json 单一真源。
//
// 用法：
//   node scripts/run-gates.mjs                 # tier 1（fast，无 PG）
//   node scripts/run-gates.mjs --tier=2        # tier 1+2（需本机 PG 5433 / 端口）
//   node scripts/run-gates.mjs --tier=3        # tier 1+2+3（e2e 需先 npm run build）
//   node scripts/run-gates.mjs --tier=3 --with-live
//                                              # 额外跑 live 验收——动生产库（隔离 schema），
//                                              # 必须老板点头，且在沙箱外跑
//
// 判定：任一闸门红 → 立即停止后续闸门，exit 1。全绿 → 打印摘要，exit 0。

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(readFileSync(path.join(ROOT, 'scripts', 'gate-registry.json'), 'utf8'));

const args = process.argv.slice(2);
const tierArg = args.find(a => a.startsWith('--tier=')) || '--tier=1';
const tier = Math.min(3, Math.max(1, Number(tierArg.split('=')[1]) || 1));
const withLive = args.includes('--with-live');

const selected = registry.gates.filter(g => {
  if (g.tier > tier) return false;
  if (g.requiresFlag === 'with-live' && !withLive) return false;
  return true;
});

console.log(`gate runner: tier=${tier}${withLive ? ' (with-live)' : ''}，共 ${selected.length} 道闸门\n`);

const results = [];
for (const gate of selected) {
  const label = `[${gate.id}] ${gate.desc}`;
  const needs = (gate.needs || []).join('+') || '—';
  console.log(`\n=== ${gate.id} (tier ${gate.tier}, needs: ${needs}) ===`);
  console.log(`> ${label}`);

  let command;
  if (gate.kind === 'npm') command = `npm run ${gate.command}`;
  else if (gate.kind === 'node') command = `node ${gate.command}`;
  else {
    console.log(`SKIP：未知 kind=${gate.kind}`);
    results.push({ id: gate.id, ok: false, note: `unknown kind ${gate.kind}` });
    break;
  }

  const started = Date.now();
  // NODE_OPTIONS 必须清掉：宿主 shell（编辑器 / agent 运行时）会注入 `--require` shim，
  // 该 shim 的 brokered-fs 策略会拒绝 pg 等模块的加载，使多个测试文件假失败
  // （实测：带 shim 345 tests/5 fail，清掉后 468 tests/0 fail，同一棵树）。
  // 闸门是「判定产品行为」的工具，不能被宿主 shell 的注入污染。
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  const res = spawnSync(command, {
    cwd: ROOT,
    shell: true,
    stdio: 'inherit',
    env: childEnv,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = res.status === 0;
  results.push({ id: gate.id, ok, note: `${seconds}s` });
  if (!ok) {
    console.error(`\n✗ 闸门 ${gate.id} 红（exit ${res.status}，${seconds}s）——按纪律停止后续闸门。`);
    console.error('  修复后重跑；不要为了让它绿而改闸门断言去迎合新行为（那是把腐烂洗白）。');
    break;
  }
  console.log(`✓ ${gate.id} 过（${seconds}s）`);
}

console.log('\n===== 闸门摘要 =====');
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.id}  ${r.note}`);
const failed = results.filter(r => !r.ok).length;
console.log(failed === 0 ? `\n全绿：${results.length}/${results.length} 闸门通过。` : `\n红 ${failed} 道。`);
process.exit(failed === 0 ? 0 : 1);
