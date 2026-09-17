// retrieve limit 回归（2026-09-17 修，防再被硬编码回去）。
//
// 缺陷史：retrieveAsync / retrieve 的 input.limit 曾完全不生效——六处调用一律
// 硬编码 `limit: 50`，传 10/20/50 都返回 50 条。调用方无法据此控制 token 预算。
//
// 本测试钉住三件事：
//   1. 输出条数严格等于 input.limit（不是「至少」也不是「某个固定值」）；
//   2. 不传 limit 时默认 50（向后兼容——既有调用方行为不变）；
//   3. 同步 retrieve 与 retrieveAsync 两条路径行为一致（曾只有一条被修）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryModule, createMemoryModuleState } from './memory-module.js';

const ctx = () => ({
  tenantId: 't-limit', subjectUserId: 'u-limit',
  actorType: 'agent', actorId: 'a-limit', callerAgentId: 'a-limit',
});

async function seededMemory(count = 60) {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state, async () => {});
  for (let i = 0; i < count; i += 1) {
    await memory.hold(ctx(), {
      content: `可检索的记忆条目 编号${i} 有些共同词便于召回`,
      memoryType: 'fact', assertionType: 'observed_fact',
      scopeType: 'relationship', relationshipAgentId: 'a-limit', sensitivity: 'S0',
    });
  }
  return memory;
}

test('limit-R1: retrieveAsync 输出条数严格等于 limit', async () => {
  const memory = await seededMemory(60);
  for (const limit of [1, 3, 10, 20, 50]) {
    const r = await memory.retrieveAsync(ctx(), { query: '记忆条目', purpose: 'answer_user_query', limit });
    assert.equal((r.items || []).length, limit, `limit=${limit} 应返回 ${limit} 条`);
  }
});

test('limit-R2: 同步 retrieve 与 retrieveAsync 行为一致', async () => {
  const memory = await seededMemory(60);
  for (const limit of [3, 10, 20]) {
    const async = await memory.retrieveAsync(ctx(), { query: '记忆条目', purpose: 'answer_user_query', limit });
    const sync = memory.retrieve(ctx(), { query: '记忆条目', purpose: 'answer_user_query', limit });
    assert.equal((sync.items || []).length, (async.items || []).length, `limit=${limit} 两条路径应一致`);
    assert.equal((sync.items || []).length, limit);
  }
});

test('limit-R3: 不传 limit 默认为 50（向后兼容）', async () => {
  const memory = await seededMemory(60);
  const r = await memory.retrieveAsync(ctx(), { query: '记忆条目', purpose: 'answer_user_query' });
  assert.equal((r.items || []).length, 50, '默认应为 50，保持既有调用方行为不变');
});

test('limit-R4: limit 大于可用记忆数时返回实际条数（不补齐）', async () => {
  const memory = await seededMemory(5);
  const r = await memory.retrieveAsync(ctx(), { query: '记忆条目', purpose: 'answer_user_query', limit: 50 });
  assert.equal((r.items || []).length, 5, '应返回实际可召回的 5 条，不虚构补满');
});

test('limit-R5: limit 非法值回落到默认（不因 NaN/0/负数炸掉）', async () => {
  const memory = await seededMemory(60);
  for (const bad of [undefined, null, NaN, 0, -3, 'abc']) {
    const r = await memory.retrieveAsync(ctx(), { query: '记忆条目', purpose: 'answer_user_query', limit: bad });
    const n = (r.items || []).length;
    assert.ok(n > 0 && n <= 50, `limit=${String(bad)} 应回落到合法默认值，实际 ${n}`);
  }
});

test('limit-R6: limit 上限被夹紧到 1000（防止一次拉爆内存）', async () => {
  const memory = await seededMemory(60);
  const r = await memory.retrieveAsync(ctx(), { query: '记忆条目', purpose: 'answer_user_query', limit: 99999 });
  assert.ok((r.items || []).length <= 1000, '超上限应被夹紧');
  assert.equal((r.items || []).length, 60, '实际只有 60 条可召回，不应虚构');
});
