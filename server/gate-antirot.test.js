// 闸门防腐哨兵（在 npm test 内常驻）。
//
// 背景：闸门脚本（acceptance/live/probe）不在 npm test 里，历史上已腐烂 4 次——
// 阶段 2a/3/4 各一次 + A-12/P-09 一次——腐烂形态固定为「断言停在旧契约上」：
// 链路结构性改动后闸门断言没跟上，变成必红或必绿的死断言，没人发现。
// （chat-route-contract.js 头部注释记录了 A-12/P-09 那次的完整病理。）
//
// 本哨兵做两件事，都不碰网络、不碰 PG，纯文件级：
// 1. 注册表完整性：scripts/gate-registry.json 里每道闸门引用的脚本必须存在，
//    npm 型命令必须真的定义在 package.json（防止注册表指向幻影闸门）。
// 2. 退役字面量禁令：任何登记的闸门脚本都不得重新键入
//    RETIRED_COMPANION_ROUTES 的路由注册字面量——必须 import
//    server/chat-route-contract.js（「Nothing here should ever be re-typed
//    elsewhere. Import it.」）。这正是 4 次腐烂中 A-12/P-09 的直接病灶。
//
// 新增闸门时：先登记进 gate-registry.json，本哨兵会自动纳管。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RETIRED_COMPANION_ROUTES } from './chat-route-contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.join(ROOT, 'scripts', 'gate-registry.json');
const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));

const gateIds = registry.gates.map(g => g.id);

test('gate registry: 闸门 id 唯一', () => {
  assert.equal(gateIds.length, new Set(gateIds).size, 'registry 里有重复 id');
});

test('gate registry: runner 与 contract 存在（防丢失仪式入口）', () => {
  assert.ok(existsSync(path.join(ROOT, registry.runner)), `runner 缺失: ${registry.runner}`);
  assert.ok(existsSync(path.join(ROOT, registry.contract)), `contract 缺失: ${registry.contract}`);
});

test('gate registry: 每道闸门引用的脚本文件必须存在', () => {
  const missing = [];
  for (const gate of registry.gates) {
    for (const f of gate.files || []) {
      if (!existsSync(path.join(ROOT, f))) missing.push(`${gate.id}: ${f}`);
    }
  }
  assert.deepEqual(missing, [], `注册表指向不存在的脚本（幻影闸门）: ${missing.join('; ')}`);
});

test('gate registry: npm 型命令必须定义在 package.json scripts', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const undefinedCmds = registry.gates
    .filter(g => g.kind === 'npm')
    .filter(g => !pkg.scripts || typeof pkg.scripts[g.command] !== 'string')
    .map(g => `${g.id}: npm run ${g.command}`);
  assert.deepEqual(undefinedCmds, [], `npm 命令未在 package.json 定义: ${undefinedCmds.join('; ')}`);
});

test('gate anti-rot: 闸门脚本不得重新键入退役路由字面量（腐烂 x4 的病灶）', () => {
  const offenders = [];
  for (const gate of registry.gates) {
    for (const f of gate.files || []) {
      if (!/\.(js|mjs)$/.test(f)) continue; // 只扫 JS/MJS；python/e2e 走各自验收
      const src = readFileSync(path.join(ROOT, f), 'utf8');
      const hits = RETIRED_COMPANION_ROUTES.filter(literal => src.includes(literal));
      if (hits.length) offenders.push(`${f}: ${hits.join(' | ')}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `闸门脚本重新键入了退役路由字面量（应 import server/chat-route-contract.js，历史教训 A-12/P-09）: ${offenders.join('; ')}`
  );
});
