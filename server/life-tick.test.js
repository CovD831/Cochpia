// L18 V0 验收：Companion Life Tick（计划 docs/companion-life-tick-plan.md §4）。
//
// 4 条验收语义（全自动化）：
//   1. 触发一次 → life 事件写入 memory（scope='life'、S0、agent 来源）且读回命中。
//   2. 冷却内连续触发 → 第二次不再产生主动消息（cooldown/gap 闸生效）。
//   3. 每日预算耗尽 → 当日后续 proactive 全不发（生活事件仍可写）。
//   4. flag 关闭 → tick 完全无操作（零写入）。
// 外加：身份契约（必须 agent + callerAgentId）、模板白名单不越界、窗口抖动确定性。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import {
  runLifeTick,
  generateLifeEvent,
  pickWakeOffsetMs,
  countProactiveToday,
  lastProactiveAt,
  LIFE_TICK_FLAG,
  LIFE_TICK_DEFAULTS,
  LIFE_EVENT_TEMPLATES,
  LIFE_TICK_MARKER,
} from './life-tick.js';

const ENABLED = { [LIFE_TICK_FLAG]: 'true' };
const agentCtx = (over = {}) => ({
  tenantId: 't1',
  subjectUserId: 'u1',
  actorType: 'agent',
  actorId: 'agent-x',
  callerAgentId: 'agent-x',
  ...over,
});

function freshMemory() {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state, async () => {});
  return { memory, state };
}

// 读「某个 context 能看到哪些记忆」——tick 的读路径就是 list()。
// （不要用 retrieveAsync 做可见性断言：它按 query 做 BM25 匹配，
//  一个不命中内容的 query 会返回 0 条，把可见性问题伪装成检索问题。）
async function visibleIds(memory, ctx) {
  const listed = memory.list(ctx, {});
  return (Array.isArray(listed) ? listed : (listed.items || [])).map(i => i.memoryId);
}

// --- 验收 4：flag 默认关闭 → 完全无操作 -------------------------------------

test('V0-4a: flag 未设置时 tick 不做任何事（默认关闭）', async () => {
  const { memory, state } = freshMemory();
  const result = await runLifeTick({ memory, context: agentCtx(), env: {} });
  assert.equal(result.status, 'disabled');
  assert.equal(state.assertions.length, 0, '关闭时不得写入任何 assertion');
  assert.equal(state.mentionCooldowns.length, 0, '关闭时不得登记任何 mention');
});

test('V0-4b: flag 显式 false 同样无操作', async () => {
  const { memory, state } = freshMemory();
  const result = await runLifeTick({ memory, context: agentCtx(), env: { [LIFE_TICK_FLAG]: 'false' } });
  assert.equal(result.status, 'disabled');
  assert.equal(state.assertions.length, 0);
});

// --- 验收 1：触发一次 → life 事件落库且可读回 -------------------------------

test('V0-1a: 触发一次写入 life 事件（scope=life / S0 / agent 来源）', async () => {
  const { memory, state } = freshMemory();
  const result = await runLifeTick({ memory, context: agentCtx(), env: ENABLED, templateId: 'revisit' });

  assert.equal(result.status, 'ok');
  assert.ok(result.lifeEventId, '必须返回 life 事件 id');
  assert.equal(result.sensitivity, 'S0', '记忆质量闸：生活事件一律 S0');

  const assertion = state.assertions.find(a => a.id === result.lifeEventId);
  assert.ok(assertion, 'life 事件必须落进 state.assertions');
  assert.equal(assertion.scopeType, 'life', 'scope 必须是 life（内在面，不进会话面）');
  assert.equal(assertion.relationshipAgentId, 'agent-x', 'life scope 必须绑定拥有它的 agent');
  assert.equal(assertion.sensitivity, 'S0');
  assert.equal(assertion.status, 'active');

  // 来源是 agent：version.createdBy 记录 actorType + trustLevel 为 agent_inferred
  const version = state.assertionVersions.find(v => v.id === assertion.currentVersionId);
  assert.equal(version.createdBy, 'agent', '生活事件来源必须是 agent');
  assert.equal(version.trustLevel, 'agent_inferred');
});

test('V0-1b: life 事件不进会话对话面（cochpia_messages 等价物：rawEvents 不得被写成 user 事件）', async () => {
  const { memory, state } = freshMemory();
  await runLifeTick({ memory, context: agentCtx(), env: ENABLED });
  // 内外分离契约（计划 §2.1）：tick 只写内在面，不产生任何 rawEvent
  assert.equal(state.rawEvents.length, 0, 'tick 不得向 raw events（对话/事件面）写入');
});

test('V0-1c: 写的 life 事件可被同一 agent 读回（读回命中）', async () => {
  const { memory } = freshMemory();
  const ctx = agentCtx();
  const result = await runLifeTick({ memory, context: ctx, env: ENABLED, templateId: 'tidy' });

  // tick 的读路径是 list()（「能看到哪些记忆」的全集视图，见 life-tick.js 注释）
  const listed = memory.list(ctx, {});
  const ids = (Array.isArray(listed) ? listed : (listed.items || [])).map(i => i.memoryId);
  assert.ok(ids.includes(result.lifeEventId), '同一 agent 必须能读回自己写的 life 事件');
});

// --- 验收 2：连续触发受间隔/冷却约束 ---------------------------------------

test('V0-2a: 连续两次触发，第二次不发主动消息（≥3h 间隔闸）', async () => {
  const { memory, state } = freshMemory();
  const ctx = agentCtx();

  const first = await runLifeTick({ memory, context: ctx, env: ENABLED });
  assert.equal(first.proactive.sent, true, '首次应允许主动消息');

  // 紧接着再来一次：两次间隔远小于 3h，间隔闸应拦住
  const second = await runLifeTick({ memory, context: ctx, env: ENABLED });
  assert.equal(second.proactive.sent, false, '间隔未满不得再发');
  assert.equal(second.proactive.reason, 'min_gap_not_elapsed');

  // 生活事件**仍然写入**（内在活动与主动打扰是两回事）
  assert.equal(state.assertions.length, 2, '被闸拦住的 tick 仍应产生生活事件');
});

test('V0-2b: 每日预算计数与「最近一次主动消息」可从记忆侧读出（不新增表）', async () => {
  const { memory, state } = freshMemory();
  const ctx = agentCtx();
  const key = { tenantId: 't1', userId: 'u1', callerAgentId: 'agent-x' };

  await runLifeTick({ memory, context: ctx, env: ENABLED });

  // 计数用相对 24h 窗口：以「现在」为锚应计 1 条
  const now = new Date().toISOString();
  assert.equal(countProactiveToday(state, key, now), 1, '近 24h 内应计 1 条 proactive');
  // 锚点推到 25h 之后，该记录应滑出窗口
  const later = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
  assert.equal(countProactiveToday(state, key, later), 0, '超出 24h 窗口不再计数');
  // 最近一次 proactive 时间可读出
  assert.ok(lastProactiveAt(state, key), '应能读出最近一次 proactive 时间');
});

// --- 验收 3：每日预算耗尽 ---------------------------------------------------

test('V0-3: 每日预算（2 条）耗尽后，后续 proactive 全不发', async () => {
  const { memory, state } = freshMemory();
  const ctx = agentCtx();

  // 连做 3 次；第 1 次发出后，第 2 次会被「≥3h 间隔」先拦——为把预算闸单独压出来，
  // 每次之前把上一条的 createdAt 往前推 4h（模拟时间流逝，不依赖可注入时钟）。
  const agePrevious = () => {
    for (const a of state.assertions) {
      a.createdAt = new Date(new Date(a.createdAt).getTime() - 4 * 60 * 60 * 1000).toISOString();
    }
  };

  const t1 = await runLifeTick({ memory, context: ctx, env: ENABLED });
  assert.equal(t1.proactive.sent, true, '第 1 条应发出');

  agePrevious();
  const t2 = await runLifeTick({ memory, context: ctx, env: ENABLED });
  assert.equal(t2.proactive.sent, true, '第 2 条应发出（间隔已满足）');

  agePrevious();
  const t3 = await runLifeTick({ memory, context: ctx, env: ENABLED });
  assert.equal(t3.proactive.sent, false, '超出每日预算不得再发');
  assert.equal(t3.proactive.reason, 'daily_budget_exhausted');
  assert.equal(t3.proactive.todayCount, 2);
});

test('V0-3b: 预算按 24h 窗口滚动，旧记录滑出后可再发', async () => {
  const { memory, state } = freshMemory();
  const ctx = agentCtx();
  await runLifeTick({ memory, context: ctx, env: ENABLED });
  await runLifeTick({ memory, context: ctx, env: ENABLED });

  // 把所有记录推到 25h 前 → 滑出预算窗口；同时满足间隔闸
  for (const a of state.assertions) {
    a.createdAt = new Date(new Date(a.createdAt).getTime() - 25 * 60 * 60 * 1000).toISOString();
  }
  const after = await runLifeTick({ memory, context: ctx, env: ENABLED });
  assert.equal(after.proactive.sent, true, '窗口滚动后应可再发');
});

// --- 身份契约（计划 §2.2 / C-6.4）------------------------------------------

test('V0-ID1: 非 agent 身份调用被拒绝（agent 自主写入必须显式声明身份）', async () => {
  const { memory } = freshMemory();
  await assert.rejects(
    () => runLifeTick({ memory, context: agentCtx({ actorType: 'user' }), env: ENABLED }),
    /agent context with callerAgentId/,
  );
});

test('V0-ID2: agent 身份但缺 callerAgentId 被拒绝', async () => {
  const { memory } = freshMemory();
  await assert.rejects(
    () => runLifeTick({ memory, context: agentCtx({ callerAgentId: null }), env: ENABLED }),
    /agent context with callerAgentId/,
  );
});

test('V0-ID3: 不同 agent 的生活事件互相不可见（life scope 按 callerAgentId 隔离）', async () => {
  const { memory } = freshMemory();
  const a = agentCtx({ callerAgentId: 'agent-a', actorId: 'agent-a' });
  const b = agentCtx({ callerAgentId: 'agent-b', actorId: 'agent-b' });

  const written = await runLifeTick({ memory, context: a, env: ENABLED });
  const idsForB = await visibleIds(memory, b);
  assert.ok(!idsForB.includes(written.lifeEventId), 'agent-b 不得读到 agent-a 的生活事件');

  const idsForA = await visibleIds(memory, a);
  assert.ok(idsForA.includes(written.lifeEventId), 'agent-a 应读到自己的');
});

// --- life scope 可见性三向（缺陷 13 的回归钉）--------------------------------
// 背景：hasGrant 曾漏掉 life 分支，使 owner agent 读不回自己写的 life 记忆
// （user 却能读）。修复后必须同时保住三件事：owner 可读、非 owner 不可读、
// user 可读（不缩小既有可见性）。任一方向破了都要红。

test('V0-LS1: life scope —— owner agent 可读回自己写的（缺陷 13 回归）', async () => {
  const { memory } = freshMemory();
  const owner = agentCtx({ callerAgentId: 'agent-a', actorId: 'agent-a' });
  const written = await runLifeTick({ memory, context: owner, env: ENABLED });

  const seen = await visibleIds(memory, owner);
  assert.ok(seen.includes(written.lifeEventId),
    'owner agent 必须能读回自己写的 life 记忆（hasGrant 需有 life 分支）');
});

test('V0-LS2: life scope —— user 仍可读（修复不得缩小既有可见性）', async () => {
  const { memory } = freshMemory();
  const owner = agentCtx({ callerAgentId: 'agent-a', actorId: 'agent-a' });
  const written = await runLifeTick({ memory, context: owner, env: ENABLED });

  const userCtx = {
    tenantId: 't1', subjectUserId: 'u1', actorType: 'user', actorId: 'u1', callerAgentId: null,
  };
  const seen = await visibleIds(memory, userCtx);
  assert.ok(seen.includes(written.lifeEventId), 'user 应能读到该 life 记忆（actorType=user 首行直接放行）');
});

test('V0-LS3: life scope —— 无 grant 的非 owner agent 仍读不到（隔离未被放宽）', async () => {
  const { memory } = freshMemory();
  const owner = agentCtx({ callerAgentId: 'agent-a', actorId: 'agent-a' });
  const outsider = agentCtx({ callerAgentId: 'agent-b', actorId: 'agent-b' });
  const written = await runLifeTick({ memory, context: owner, env: ENABLED });

  const seen = await visibleIds(memory, outsider);
  assert.ok(!seen.includes(written.lifeEventId), '非 owner agent 不得读到（life 分支只放行 relationshipAgentId 相符者）');
});

test('V0-LS4: life scope —— 非 owner 换个 purpose 也读不到（purpose 不是越权通道）', async () => {
  const { memory } = freshMemory();
  const owner = agentCtx({ callerAgentId: 'agent-a', actorId: 'agent-a' });
  const outsider = agentCtx({ callerAgentId: 'agent-b', actorId: 'agent-b' });
  const written = await runLifeTick({ memory, context: owner, env: ENABLED });

  // (a) 全集视图（list）不得泄露
  const listedIds = await visibleIds(memory, outsider);
  assert.ok(!listedIds.includes(written.lifeEventId), 'list 不得让非 owner 看到 life 记忆');

  // (b) 检索路径：用一个能命中该内容的 query，确保不是「检索没匹配上」的假阴性
  for (const purpose of ['life_generation', 'proactive_mention', 'profile_view', 'answer_user_query']) {
    const seen = await memory.retrieveAsync(outsider, { query: '回顾', purpose, limit: 20 });
    const ids = (seen.items || []).map(i => i.memoryId);
    assert.ok(!ids.includes(written.lifeEventId), `${purpose} 不得让非 owner 读到 life 记忆`);
  }
});

// --- 生成器：接口与内容白名单（记忆质量闸）---------------------------------

test('V0-G1: 生成器输出落在模板白名单内，不含用户信息占位残留', () => {
  const allowedIds = new Set(LIFE_EVENT_TEMPLATES.map(t => t.id));
  for (let i = 0; i < 40; i += 1) {
    const event = generateLifeEvent({ recentItems: [], rng: Math.random });
    assert.ok(allowedIds.has(event.templateId), 'templateId 必须在白名单内');
    assert.equal(event.sensitivity, 'S0');
    assert.ok(!/\{count\}|\{topic\}/.test(event.content), '不得残留未替换的模板占位符');
  }
});

test('V0-G2: 生成器只统计条数，不回灌记忆原文（隐私：不引用用户内容）', () => {
  const secret = '我的银行卡密码是 123456';
  const event = generateLifeEvent({
    recentItems: [{ content: secret, memoryId: 'm1', topicKey: 'daily' }],
    templateId: 'revisit',
  });
  assert.ok(!event.content.includes(secret), '生活事件不得包含记忆原文');
  assert.ok(!event.content.includes('123456'), '不得包含任何原文片段');
});

test('V0-G3: 主题词只接受稳定的非内容标识（topicKey），非法则回落', () => {
  const event = generateLifeEvent({
    recentItems: [{ topicKey: '含有中文和空格 的主题' }],
    templateId: 'noticing',
  });
  assert.ok(!event.content.includes('含有中文和空格'), '非法 topicKey 不得进入内容');
  assert.ok(event.content.includes('日常'), '应回落到默认主题词');
});

// --- 唤醒窗口抖动（不固定时刻）---------------------------------------------

test('V0-W1: 唤醒窗口内抖动，注入 rng 可确定化，且落在窗口内', () => {
  const at = '2026-09-17T00:00:00.000Z';
  const windowMs = (LIFE_TICK_DEFAULTS.wakeWindowEndHour - LIFE_TICK_DEFAULTS.wakeWindowStartHour) * 3600 * 1000;

  assert.equal(pickWakeOffsetMs(at, () => 0), 0, 'rng=0 → 窗口起点');
  assert.ok(pickWakeOffsetMs(at, () => 0.999) < windowMs, 'rng 接近 1 → 仍在窗口内');
  // 同一 rng 序列必须可复现
  assert.equal(pickWakeOffsetMs(at, () => 0.5), pickWakeOffsetMs(at, () => 0.5));
  // 抖动值必须非负且小于窗口
  for (let i = 0; i < 20; i += 1) {
    const v = pickWakeOffsetMs(at, Math.random);
    assert.ok(v >= 0 && v < windowMs, 'offset 必须落在 [0, windowMs)');
  }
});

test('V0-W2: proactive 判定携带抖动偏移（避免固定时刻）', async () => {
  const { memory } = freshMemory();
  const ctx = agentCtx();
  const r = await runLifeTick({ memory, context: ctx, env: ENABLED, nowIso: '2026-09-17T09:00:00.000Z', rng: () => 0.5 });
  assert.equal(r.proactive.sent, true);
  assert.equal(typeof r.proactive.scheduledOffsetMs, 'number', '应返回窗口内抖动偏移');
});

// --- 成本闸：V0 零模型调用 --------------------------------------------------

test('V0-C1: tick 不产生任何模型调用（V0 成本闸）', async () => {
  const { memory } = freshMemory();
  // 不注入任何 model 依赖，tick 也必须能跑通 —— 证明 V0 路径不触碰模型
  const result = await runLifeTick({ memory, context: agentCtx(), env: ENABLED });
  assert.equal(result.status, 'ok');
});

test('V0-C2: 写入的 structuredData 带 life-tick 标记，便于审计与计数', async () => {
  const { memory, state } = freshMemory();
  const r = await runLifeTick({ memory, context: agentCtx(), env: ENABLED, templateId: 'revisit' });
  const assertion = state.assertions.find(a => a.id === r.lifeEventId);
  const version = state.assertionVersions.find(v => v.id === assertion.currentVersionId);
  const marker = version.structuredData[LIFE_TICK_MARKER];
  assert.ok(marker, '必须有 life-tick 标记');
  assert.equal(marker.templateId, 'revisit');
  assert.equal(marker.proactive, true);
});
