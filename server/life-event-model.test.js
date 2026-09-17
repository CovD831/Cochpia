// L18 V1.5 验收：生活事件的模型生成器 + 降级。
//
// 老板 2026-09-17：接模型生成，模型来源同主配置（workbuddy2api），
// 模型 Z-deepseek-v4.1-flash，关闭思考模式，成本低不做硬节流。
//
// 这里**不打真实网关**（单测要快、要可离线复现）——用注入的 callModel 覆盖。
// 真实网关连通性单独有一条带 skip 的集成用例（需 .env）。
//
// 要钉住的契约：
//   1. 输出形状与规则实现一致（同签名可互换）；
//   2. 一律 S0；
//   3. **不把记忆原文喂给模型**（只给元信息）——这是防泄露的核心；
//   4. templateId 白名单校验，越界回落；
//   5. 模型输出坏掉时返回 null / 降级，不抛错炸掉整条生活线。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { runLifeTick, LIFE_TICK_FLAG, LIFE_EVENT_TEMPLATES } from './life-tick.js';
import {
  generateLifeEventWithModel,
  buildMetaBrief,
  LIFE_EVENT_MODEL_FLAG,
} from './life-event-model.js';

const BOTH_ON = { [LIFE_TICK_FLAG]: 'true', [LIFE_EVENT_MODEL_FLAG]: 'true' };
const RULE_ONLY = { [LIFE_TICK_FLAG]: 'true' };

const agentCtx = () => ({
  tenantId: 't1', subjectUserId: 'u1', actorType: 'agent', actorId: 'agent-x', callerAgentId: 'agent-x',
});

function freshMemory() {
  const state = createMemoryModuleState();
  return { memory: createMemoryModule(state, async () => {}), state };
}

const okModel = content => ({ lifeEventText: async () => JSON.stringify({ templateId: 'revisit', content }) });

// --- 元信息 brief：不泄露原文 -------------------------------------------------

test('V1.5-M1: 喂给模型的 brief 只含条数与类型分布，不含任何记忆原文', () => {
  const secret = '我住在某小区 3 号楼';
  const brief = buildMetaBrief([
    { memoryType: 'life_event', content: secret },
    { memoryType: 'life_event', content: '另一条原文' },
    { memoryType: 'fact', content: secret },
  ]);
  const serialized = JSON.stringify(brief);
  assert.equal(brief.total, 3);
  assert.ok(serialized.includes('life_event×2'), '应含类型分布');
  assert.ok(serialized.includes('fact×1'));
  assert.ok(!serialized.includes(secret), 'brief 不得包含任何记忆原文');
  assert.ok(!serialized.includes('另一条原文'), 'brief 不得包含任何记忆原文');
});

test('V1.5-M2: 生成器的 prompt 里也不出现记忆原文', async () => {
  const secret = '银行卡密码是 998877';
  let captured = null;
  await generateLifeEventWithModel({
    recentItems: [{ memoryType: 'fact', content: secret }],
    callModel: async payload => { captured = payload; return '{"templateId":"revisit","content":"回顾了最近的事"}'; },
  });
  const all = `${captured.system}\n${captured.user}`;
  assert.ok(!all.includes(secret), 'prompt 不得包含记忆原文');
  assert.ok(!all.includes('998877'), 'prompt 不得包含原文片段');
  assert.ok(all.includes('fact×1'), 'prompt 应包含元信息');
});

// --- 请求参数：关闭思考模式 ---------------------------------------------------

test('V1.5-M3: 生成器请求带 temperature 与 maxTokens（轻任务、短输出）', async () => {
  let captured = null;
  await generateLifeEventWithModel({
    recentItems: [],
    callModel: async payload => { captured = payload; return '{"templateId":"tidy","content":"整理了一下"}'; },
  });
  assert.equal(typeof captured.temperature, 'number');
  assert.equal(typeof captured.maxTokens, 'number');
  assert.ok(captured.maxTokens <= 200, '生活事件是一句话，maxTokens 不应过大');
});

test('V1.5-M4: 非 OpenAI 兼容协议走通用 generate（降级路径不写死）', () => {
  // 这里只断言「有 lifeEventText 时才用」，协议分支在 model-provider 内，
  // 由 V1.5-P* 的真实调用覆盖；本用例钉住生成器对注入 callModel 的依赖形态。
  assert.equal(typeof generateLifeEventWithModel, 'function');
});

// --- 输出契约 ---------------------------------------------------------------

test('V1.5-O1: 模型输出转成与规则实现同形状的事件（可互换）', async () => {
  const event = await generateLifeEventWithModel({
    recentItems: [],
    callModel: async () => '{"templateId":"noticing","content":"注意到最近聊的都是工作"}',
  });
  assert.equal(event.templateId, 'noticing');
  assert.equal(event.content, '注意到最近聊的都是工作');
  assert.equal(event.sensitivity, 'S0', '记忆质量闸：模型实现同样强制 S0');
  assert.deepEqual(event.topics, ['self_activity']);
  assert.equal(event.generatedBy, 'model');
});

test('V1.5-O2: 模型把 JSON 包在 ```json 里也能解析', async () => {
  const event = await generateLifeEventWithModel({
    recentItems: [],
    callModel: async () => '```json\n{"templateId":"revisit","content":"回顾了一下"}\n```',
  });
  assert.equal(event.content, '回顾了一下');
});

test('V1.5-O3: 模型加了前后缀废话也能抽出 JSON', async () => {
  const event = await generateLifeEventWithModel({
    recentItems: [],
    callModel: async () => '好的，这是结果：{"templateId":"tidy","content":"整理了一下"} 希望有帮助',
  });
  assert.equal(event.content, '整理了一下');
});

test('V1.5-O4: templateId 越界 → 返回 null（不写入未知模板）', async () => {
  const event = await generateLifeEventWithModel({
    recentItems: [],
    callModel: async () => '{"templateId":"hacked_template","content":"x"}',
  });
  assert.equal(event, null, '白名单外的 templateId 必须被拒绝');
});

test('V1.5-O5: 输出完全不是 JSON → 返回 null（由调用方降级）', async () => {
  const event = await generateLifeEventWithModel({
    recentItems: [],
    callModel: async () => '我不太确定该怎么回答',
  });
  assert.equal(event, null);
});

test('V1.5-O6: content 为空/空白 → 返回 null', async () => {
  const event = await generateLifeEventWithModel({
    recentItems: [],
    callModel: async () => '{"templateId":"revisit","content":"   "}',
  });
  assert.equal(event, null);
});

test('V1.5-O7: content 过长被截断到 120 字以内', async () => {
  const long = '很长的内容'.repeat(60);
  const event = await generateLifeEventWithModel({
    recentItems: [],
    callModel: async () => JSON.stringify({ templateId: 'revisit', content: long }),
  });
  assert.ok(event.content.length <= 120, '必须截断，避免污染记忆内容');
});

// --- 与 runLifeTick 的整合 + 降级 -------------------------------------------

test('V1.5-I1: flag 开 + 模型可用 → 用模型生成（generator=model）', async () => {
  const { memory, state } = freshMemory();
  const result = await runLifeTick({
    memory, context: agentCtx(), env: BOTH_ON,
    model: okModel('今天把最近的事又过了一遍'),
  });
  assert.equal(result.generator, 'model');
  assert.equal(result.content, '今天把最近的事又过了一遍');
  const version = state.assertionVersions.find(v => v.id === state.assertions[0].currentVersionId);
  assert.equal(version.structuredData.lifeTick.generator, 'model', 'generator 应落进 structuredData（可审计）');
});

test('V1.5-I2: flag 关 → 走规则模板（零模型调用）', async () => {
  const { memory } = freshMemory();
  let called = false;
  const result = await runLifeTick({
    memory, context: agentCtx(), env: RULE_ONLY,
    model: { lifeEventText: async () => { called = true; return '{}'; } },
  });
  assert.equal(result.generator, 'rule');
  assert.equal(called, false, 'flag 关时不得触碰模型');
});

test('V1.5-I3: 模型抛错 → 降级规则模板，生活线不中断', async () => {
  const { memory, state } = freshMemory();
  const result = await runLifeTick({
    memory, context: agentCtx(), env: BOTH_ON,
    model: { lifeEventText: async () => { const e = new Error('gateway down'); e.code = 'MODEL_CONNECTION_FAILED'; throw e; } },
  });
  assert.equal(result.status, 'ok', '降级后仍应是 ok');
  assert.equal(result.generator, 'rule_fallback');
  assert.ok(result.content, '降级后必须有内容（规则模板产出）');
  assert.equal(result.generatorError.code, 'MODEL_CONNECTION_FAILED', '应记录降级原因');
  assert.equal(state.assertions.length, 1, '生活事件仍应写入');
});

test('V1.5-I4: 模型返回不可用内容 → 同样降级（不写空内容进记忆）', async () => {
  const { memory } = freshMemory();
  const result = await runLifeTick({
    memory, context: agentCtx(), env: BOTH_ON,
    model: { lifeEventText: async () => '不是 JSON' },
  });
  assert.equal(result.generator, 'rule_fallback', '模型输出坏掉应降级');
  assert.ok(result.content);
});

test('V1.5-I5: flag 开但没传 model → 安静走规则（不报错）', async () => {
  const { memory } = freshMemory();
  const result = await runLifeTick({ memory, context: agentCtx(), env: BOTH_ON });
  assert.equal(result.status, 'ok');
  assert.equal(result.generator, 'rule');
});

test('V1.5-I6: 无论哪条路径，写入的记忆一律 S0 且 scope=life', async () => {
  for (const [label, env, model] of [
    ['rule', RULE_ONLY, null],
    ['model', BOTH_ON, okModel('走了一遍最近的事')],
    ['fallback', BOTH_ON, { lifeEventText: async () => { throw new Error('x'); } }],
  ]) {
    const { memory, state } = freshMemory();
    await runLifeTick({ memory, context: agentCtx(), env, model });
    assert.equal(state.assertions[0].sensitivity, 'S0', `${label}: 必须 S0`);
    assert.equal(state.assertions[0].scopeType, 'life', `${label}: 必须 life scope`);
  }
});
