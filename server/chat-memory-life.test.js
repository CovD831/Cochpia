// R-021 V2①：/api/memory/life 的读视图契约。
//
// 为什么需要它：独立审计的 CF-C 反事实证明 e2e 的 P12 **抓不住域混入** ——
// 把 life() 的 scopeType 过滤整个去掉，页面照样渲染 4 条（含 user/relationship 域），
// P12 仍然全绿。域隔离此前在服务端**零测试覆盖**。这些用例把该不变量钉在模块层，
// 那里能直接构造反例，而浏览器层不能。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { createChatMemoryAdapter } from './chat-memory.js';

// 注意：真实 runtime 里 user 身份的 actorId === subjectUserId（见
// memory-module-runtime.js: `actorId: actorType === 'user' ? subjectUserId : callerAgentId`）。
// 测试若把两者写成不一致（如 subjectUserId:'uA' 但 actorId:'u1'），canSee 会拒绝，
// 于是「隔离通过」的断言会变成假绿、而「自己能看到」会假红 —— 这里刻意保持同步。
const userCtx = (over = {}) => {
  const subjectUserId = over.subjectUserId ?? 'u1';
  return {
    tenantId: 't1',
    actorType: 'user',
    callerAgentId: null,
    ...over,
    subjectUserId,
    actorId: over.actorId ?? subjectUserId
  };
};
const agentCtx = (over = {}) => ({
  tenantId: 't1',
  subjectUserId: 'u1',
  actorType: 'agent',
  actorId: 'agent-a',
  callerAgentId: 'agent-a',
  ...over
});

function freshMemory() {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state, async () => {});
  // chat adapter 需要 app 形状的 state（legacyImportVersion 在 state.memoryModule 上）
  const doc = { memoryModule: state };
  return { memory, state, doc };
}

const holdLife = (memory, ctx, content) => memory.hold(ctx, {
  content,
  memoryType: 'life_event',
  assertionType: 'observed_fact',
  scopeType: 'life',
  relationshipAgentId: ctx.callerAgentId,
  sensitivity: 'S0',
  structuredData: { lifeTick: { templateId: 'revisit', topics: ['self_activity'], proactive: false, generator: 'rule' } }
});

const adapterFor = (memory, doc, ctx) => createChatMemoryAdapter({ memoryModule: memory, state: doc, context: ctx });

test('LIFE-1: 只返回 life 域，user/relationship 域不得混入（审计 CF-C 的模块层回归钉）', async () => {
  const { memory, state, doc } = freshMemory();
  const ctx = agentCtx();
  await holdLife(memory, ctx, 'LIFE-A 生活事件');
  await memory.hold(ctx, { content: 'REL-CANARY 关系记忆', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'relationship', relationshipAgentId: 'agent-a', sensitivity: 'S0' });
  await memory.hold(ctx, { content: 'USER-CANARY 用户档案', memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user', sensitivity: 'S0' });
  assert.equal(state.assertions.length, 3, '前置：三类断言都已写入');

  const { items } = await adapterFor(memory, doc, userCtx()).life({});
  const summaries = items.map(i => i.summary);
  assert.deepEqual(summaries, ['LIFE-A 生活事件'], '只应有 life 域那一条');
  assert.ok(!summaries.some(s => s.includes('CANARY')), 'user/relationship 域不得出现在 life 视图');
});

test('LIFE-2: 跨用户隔离 —— 用户 B 看不到用户 A 的生活事件', async () => {
  const { memory, doc } = freshMemory();
  await holdLife(memory, agentCtx({ subjectUserId: 'uA' }), 'A 的生活');
  const b = await adapterFor(memory, doc, userCtx({ subjectUserId: 'uB' })).life({});
  assert.equal(b.items.length, 0, 'B 必须看不到 A 的 life 事件');
  const a = await adapterFor(memory, doc, userCtx({ subjectUserId: 'uA' })).life({});
  assert.equal(a.items.length, 1, 'A 自己能看到');
});

test('LIFE-3: 跨租户隔离 —— 不同 tenantId 互不可见', async () => {
  const { memory, doc } = freshMemory();
  await holdLife(memory, agentCtx({ tenantId: 'tenant-1' }), 'T1 的生活');
  const other = await adapterFor(memory, doc, userCtx({ tenantId: 'tenant-2' })).life({});
  assert.equal(other.items.length, 0, '别的租户不得可见');
});

test('LIFE-4: 多个 agent 的 life 事件都返回，且各自带 agentId 可供区分', async () => {
  // 用户级视图不带 callerAgentId，会把所有 agent 的 life 混在一起；
  // 对「agent 自己的生活」这一页，owner 是语义必需（审计 P0 第二半）。
  const { memory, doc } = freshMemory();
  await holdLife(memory, agentCtx({ actorId: 'agent-a', callerAgentId: 'agent-a' }), 'A 的生活');
  await holdLife(memory, agentCtx({ actorId: 'agent-b', callerAgentId: 'agent-b' }), 'B 的生活');

  const { items } = await adapterFor(memory, doc, userCtx()).life({});
  assert.equal(items.length, 2);
  const owners = items.map(i => i.agentId).sort();
  assert.deepEqual(owners, ['agent-a', 'agent-b'], '每条必须带可区分的 owner');
});

test('LIFE-5: 分页 —— limit 生效且 nextCursor 可续读，两页不重叠', async () => {
  const { memory, doc } = freshMemory();
  const ctx = agentCtx();
  for (let i = 0; i < 5; i += 1) await holdLife(memory, ctx, `生活事件 ${i}`);
  const ad = adapterFor(memory, doc, userCtx());

  const p1 = await ad.life({ limit: 2 });
  assert.equal(p1.items.length, 2);
  assert.ok(p1.nextCursor, '还有后续时必须给 cursor（否则是无声截断）');

  const p2 = await ad.life({ limit: 2, cursor: p1.nextCursor });
  assert.equal(p2.items.length, 2);
  const overlap = p2.items.filter(x => p1.items.some(y => y.id === x.id));
  assert.equal(overlap.length, 0, '两页不得重叠');

  const all = await ad.life({ limit: 50 });
  assert.equal(all.items.length, 5);
  assert.equal(all.nextCursor, null, '取完时不得再给 cursor');
});

test('LIFE-6: 返回面只含白名单字段，不泄漏 userId/tenantId/sensitivity 等内部信息', async () => {
  const { memory, doc } = freshMemory();
  await holdLife(memory, agentCtx(), '生活事件');
  const { items } = await adapterFor(memory, doc, userCtx()).life({});
  assert.deepEqual(
    Object.keys(items[0]).sort(),
    ['agentId', 'createdAt', 'id', 'marker', 'summary', 'updatedAt'].sort()
  );
  const raw = JSON.stringify(items[0]);
  assert.ok(!raw.includes('"u1"'), '不得带 userId');
  assert.ok(!raw.includes('"t1"'), '不得带 tenantId');
  assert.ok(!raw.includes('sensitivity'), '不得带 sensitivity');
});

test('LIFE-7: marker 来自 structuredData.lifeTick；无标记的 life 断言 marker 为 null', async () => {
  const { memory, doc } = freshMemory();
  const ctx = agentCtx();
  await holdLife(memory, ctx, '有标记的生活事件');
  // 手工写入一条没有 lifeTick 标记的 life 域断言
  await memory.hold(ctx, { content: '无标记 life 断言', memoryType: 'life_event', assertionType: 'observed_fact', scopeType: 'life', relationshipAgentId: 'agent-a', sensitivity: 'S0' });

  const { items } = await adapterFor(memory, doc, userCtx()).life({});
  assert.equal(items.length, 2);
  const marked = items.find(i => i.summary === '有标记的生活事件');
  const unmarked = items.find(i => i.summary === '无标记 life 断言');
  assert.equal(marked.marker.templateId, 'revisit');
  assert.equal(unmarked.marker, null, '缺标记必须回落 null，而不是伪造');
});

test('LIFE-8: 脏 createdAt 原样透出（不在服务端崩），由展示层兜底', async () => {
  // 服务端不做值校验是有意的：写入路径的非法值要能被观测到，而不是被静默改写。
  // 展示层的兜底由 client/src/life/life-utils.test.js 的 safeFormatTime 用例钉住。
  const { memory, state, doc } = freshMemory();
  await holdLife(memory, agentCtx(), '脏时间');
  const target = state.assertions.find(a => a.scopeType === 'life');
  target.createdAt = 'not-a-date';
  const { items } = await adapterFor(memory, doc, userCtx()).life({});
  assert.equal(items.length, 1);
  assert.equal(items[0].createdAt, 'not-a-date');
});
