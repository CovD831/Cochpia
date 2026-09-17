// Companion Life Tick（R-021）—— V0：agent 内在面打通。
//
// 计划：docs/companion-life-tick-plan.md（老板 2026-09-16 裁决四问后定稿）。
//
// V0 范围（守约不越界）：
//   1. 手工触发一次 tick：读最近记忆 + 人格投影 → 规则模板生成生活事件
//      → 写进 memory（scope='life'，agent 内在面），**不进**会话消息面。
//   2. 三道治理闸全部就立：打扰闸（cooldown + 每日 2 条 + ≥3h 间隔）、
//      记忆质量闸（一律 S0、模板白名单、禁涉用户情感推断）、成本闸（零模型调用）。
//   3. feature flag `MEMORY_LIFE_TICK_ENABLED` 默认 false，关闭即完全无操作。
//
// 明确不做（V1+）：真实定时器、模型生成、HTTP 端点、写会话消息文案。
//
// 身份契约（C-6.4）：agent 自主写入**不走** assertUserGovernanceActor，走本模块的
// 显式治理通道——每次 tick 记审计（life_tick_*），写入显式声明 actorType='agent'
// + callerAgentId。这是隔离机制第一次被 agent 主动写入考验（计划 §2.2）。

import { randomUUID } from 'node:crypto';

import { generateLifeEventWithModel, isModelEnabled, LIFE_EVENT_MODEL_FLAG } from './life-event-model.js';

export { LIFE_EVENT_MODEL_FLAG };

export const LIFE_TICK_FLAG = 'MEMORY_LIFE_TICK_ENABLED';

// 治理默认值（计划 §3，老板 2026-09-16 裁决：每日 2 条、不固定时刻）
export const LIFE_TICK_DEFAULTS = Object.freeze({
  dailyProactiveBudget: 2,
  minProactiveGapMs: 3 * 60 * 60 * 1000, // 两次主动消息间隔 ≥3h
  proactiveCooldownMs: 6 * 60 * 60 * 1000, // 单条记忆的 mention cooldown
  wakeWindowStartHour: 8, // 唤醒窗口（本地时）—— 窗口内随机抖动，不固定时刻
  wakeWindowEndHour: 22,
  lookbackLimit: 20, // 读最近记忆的条数
});

// 模板白名单：只描述 agent 自身的元活动，**不涉用户信息、不做情感推断**。
// 记忆质量闸（计划 §3）：V0 生成内容必须落在这个集合内。
export const LIFE_EVENT_TEMPLATES = Object.freeze([
  { id: 'revisit', template: '回顾了最近记住的 {count} 件事', topics: ['self_activity'] },
  { id: 'tidy', template: '把近期的记忆整理了一遍，留下了 {count} 条', topics: ['self_activity'] },
  { id: 'noticing', template: '注意到最近聊到的主题集中在「{topic}」', topics: ['self_activity'] },
]);

function isEnabled(env) {
  return String((env || process.env)[LIFE_TICK_FLAG] || '').toLowerCase() === 'true';
}

// 唤醒窗口内随机抖动（避免固定时刻的机械感与可预测性，计划 §3 打扰闸）。
// 纯函数、注入 rng 以便测试确定化。
export function pickWakeOffsetMs(now, rng = Math.random, defaults = LIFE_TICK_DEFAULTS) {
  const { wakeWindowStartHour: s, wakeWindowEndHour: e } = defaults;
  const windowMs = Math.max(1, (e - s) * 60 * 60 * 1000);
  return Math.floor(rng() * windowMs);
}

// 从检索结果里挑一个可用的主题词（用于模板填充）。只取记忆的**元信息**
// （topic 标签），不引用原文内容——避免把用户原话灌进生活事件。
function pickTopic(items) {
  for (const item of items || []) {
    const key = item && item.topicKey;
    if (key && typeof key === 'string' && /^[a-z0-9:_-]+$/.test(key)) return key;
  }
  return '日常';
}

// 规则模板生成器（V0 实现）。接口先行（计划 §2.3）：V1 换模型实现时签名不变。
// 输入 { recentItems, personalityVersion, templateId, rng } → 输出结构化生活事件。
export function generateLifeEvent({ recentItems = [], templateId = null, rng = Math.random } = {}) {
  const pool = templateId ? LIFE_EVENT_TEMPLATES.filter(t => t.id === templateId) : LIFE_EVENT_TEMPLATES;
  const chosen = pool.length ? pool[Math.floor(rng() * pool.length) % pool.length] : LIFE_EVENT_TEMPLATES[0];
  const count = recentItems.length;
  const content = chosen.template
    .replace('{count}', String(count))
    .replace('{topic}', pickTopic(recentItems));
  return {
    templateId: chosen.id,
    content,
    topics: [...chosen.topics],
    sensitivity: 'S0', // 记忆质量闸：一律 S0
  };
}

// 生活事件的标记位：assertion/version 本身都没有可自由扩展的 refs 列，
// structuredData 是既有的自由 jsonb —— 用它承载 life-tick 语义，不新增表。
export const LIFE_TICK_MARKER = 'lifeTick';

// 判定时钟与写入时钟是分开的：
//   - 写入（memory.hold）用 memory 模块内部的真实时钟，**不可注入**；
//   - 判定（预算/间隔）用调用方传入的 nowIso，让测试可确定化。
// 因此判定不能依赖 assertion.createdAt 的「绝对日期」——那会被写时钟污染，
// 使注入时钟的测试永远算错一天。改为按**相对窗口**判定：
// 以判定时刻为锚，往前 24h 内算「今天」，往前 minGap 内算「刚发生过」。
// 当判定时钟早于记录时间（测试用假时钟的典型情形）时差值为负，
// 视为「刚发生过」——保守方向，只会少发不会多发。
const DAY_MS = 24 * 60 * 60 * 1000;

function isLifeTickAssertion(assertion, { tenantId, userId, callerAgentId }) {
  if (!assertion || assertion.scopeType !== 'life') return false;
  if (assertion.relationshipAgentId !== callerAgentId) return false;
  if (assertion.tenantId !== tenantId || assertion.userId !== userId) return false;
  return true;
}

function markerOf(state, assertion) {
  const version = (state.assertionVersions || []).find(v => v.id === assertion.currentVersionId);
  return (version && version.structuredData && version.structuredData[LIFE_TICK_MARKER]) || null;
}

// 近 24h 内的主动消息计数（从既有记忆侧读，不新增表，计划 §3）。
// 用相对窗口而非「日历日」：写时钟不可注入，绝对日期会与判定时钟错配。
export function countProactiveToday(state, { tenantId, userId, callerAgentId }, nowIso) {
  const anchor = new Date(nowIso).getTime();
  let count = 0;
  for (const assertion of state.assertions || []) {
    if (!isLifeTickAssertion(assertion, { tenantId, userId, callerAgentId })) continue;
    const marker = markerOf(state, assertion);
    if (!marker || !marker.proactive) continue;
    const at = new Date(assertion.createdAt).getTime();
    // 判定时钟早于记录时间 → 计为「窗口内」（保守：只会少发不会多发）
    const age = Number.isFinite(at) ? anchor - at : 0;
    if (age >= DAY_MS) continue;
    count += 1;
  }
  return count;
}

// 最近一次主动消息的时间（用于 ≥3h 间隔闸）。
export function lastProactiveAt(state, { tenantId, userId, callerAgentId }) {
  let latest = null;
  for (const assertion of state.assertions || []) {
    if (!isLifeTickAssertion(assertion, { tenantId, userId, callerAgentId })) continue;
    const marker = markerOf(state, assertion);
    if (!marker || !marker.proactive) continue;
    const at = assertion.createdAt;
    if (!latest || String(at) > String(latest)) latest = at;
  }
  return latest;
}

/**
 * 跑一次 life tick（V0：内部触发函数，不做 HTTP 端点不做 cron —— 计划 §2.4）。
 *
 * @param {object} deps
 * @param {object} deps.memory        createMemoryModule(...) 实例
 * @param {object} deps.context       { tenantId, subjectUserId, actorType:'agent', actorId, callerAgentId, sessionId? }
 * @param {object} [deps.env]         读取 flag 的环境（测试可注入）
 * @param {string} [deps.nowIso]      注入时钟（测试确定化）
 * @param {Function} [deps.rng]       注入随机源
 * @param {string} [deps.templateId]  指定模板（测试确定化）
 * @param {boolean} [deps.allowProactive] 本次 tick 是否允许尝试主动消息
 * @returns {Promise<{status:string, lifeEventId?:string, proactive?:object, reason?:string}>}
 */
export async function runLifeTick(deps = {}) {
  const {
    memory,
    context,
    env = process.env,
    nowIso = new Date().toISOString(),
    rng = Math.random,
    templateId = null,
    allowProactive = true,
    defaults = LIFE_TICK_DEFAULTS,
  } = deps;

  // 闸 0：feature flag（默认 false，关闭即完全无操作 —— 验收 §4.4）
  if (!isEnabled(env)) return { status: 'disabled', reason: 'MEMORY_LIFE_TICK_ENABLED is not true' };

  if (!memory || typeof memory.hold !== 'function') {
    throw new Error('runLifeTick requires a memory module instance');
  }
  if (!context || context.actorType !== 'agent' || !context.callerAgentId) {
    // 显式治理通道：agent 自主写入必须声明 agent 身份 + callerAgentId（C-6.4）
    throw new Error('runLifeTick requires an agent context with callerAgentId');
  }

  // 1. 读最近记忆。
  //    用 list() 而非 retrieveAsync()：retrieve 是按 query 与内容做 BM25 匹配的
  //    （空 query 会被 INVALID_QUERY 拒绝，非空 query 又会把无关记忆挡在外面），
  //    而 tick 要的是「这个 agent 现在能看到哪些记忆」这个全集视图——那正是 list()
  //    的语义。list() 同样经过 canSee 过滤，所以隔离保证不打折。
  //    life_generation 仍是既有 purpose 白名单成员（C-9），这里不引入新 purpose。
  //    list() 是同步函数（返回数组），失败时抛异常——这里不吞异常，
  //    读不到就不生成，比静默用空集生成一条无信息的「生活事件」更诚实。
  const listed = await Promise.resolve().then(() => memory.list(context, {}));
  const recentItems = (Array.isArray(listed) ? listed : (listed.items || []))
    .slice(0, defaults.lookbackLimit);

  // 2. 生成生活事件。
  //    V1.5：模型实现优先（`MEMORY_LIFE_TICK_MODEL_ENABLED`），失败/未配置时
  //    **回落规则模板** —— 生活事件是「有比好重要」的内在产品，不能因为网关抖动
  //    就整天没有生活线。降级方向明确：模型不可用 → 规则模板 → 永远有输出。
  let event = null;
  let generator = 'rule';
  let lastGeneratorError = null;
  if (isModelEnabled(env) && deps.model) {
    try {
      const generated = await generateLifeEventWithModel({
        model: deps.model,
        recentItems,
        personality: deps.personality || null,
        templateId,
        rng,
        env,
        callModel: deps.callModel,
      });
      if (generated && generated.content) {
        event = generated;
        generator = 'model';
      } else {
        // 模型答了但不可用（非 JSON / 空 content / templateId 越界）——
        // 与抛错同等对待：也是降级，不能把空内容写进记忆。
        generator = 'rule_fallback';
        lastGeneratorError = { code: 'MODEL_OUTPUT_UNUSABLE', message: 'model returned no usable life event' };
      }
    } catch (error) {
      // 不抛：记为降级，继续用规则模板产出
      generator = 'rule_fallback';
      lastGeneratorError = { code: error && error.code, message: error && error.message };
    }
  }
  if (!event) event = generateLifeEvent({ recentItems, templateId, rng });

  // 3. 主动消息闸（先判定，决定本条生活事件是否带 proactive 标记）
  let proactive = null;
  if (allowProactive) {
    const key = {
      tenantId: context.tenantId,
      userId: context.subjectUserId,
      callerAgentId: context.callerAgentId,
    };
    const state = memory.state || null;
    if (state) {
      const todayCount = countProactiveToday(state, key, nowIso);
      const lastAt = lastProactiveAt(state, key);
      const sinceLast = lastAt ? new Date(nowIso).getTime() - new Date(lastAt).getTime() : Infinity;
      if (todayCount >= defaults.dailyProactiveBudget) {
        proactive = { sent: false, reason: 'daily_budget_exhausted', todayCount };
      } else if (sinceLast < defaults.minProactiveGapMs) {
        proactive = { sent: false, reason: 'min_gap_not_elapsed', sinceLastMs: sinceLast };
      } else {
        const offsetMs = pickWakeOffsetMs(nowIso, rng, defaults);
        proactive = { sent: true, scheduledOffsetMs: offsetMs, todayCount };
      }
    }
  }

  // 4. 写入 life 事件（agent 内在面）。走 hold() —— 一步写 active assertion，
  //    不依赖抽取网关（V0 零模型调用），scope='life' + relationshipAgentId=callerAgentId。
  //    标记位落在 structuredData（见 LIFE_TICK_MARKER 注释）。
  const written = await memory.hold(context, {
    content: event.content,
    memoryType: 'life_event',
    assertionType: 'observed_fact',
    scopeType: 'life',
    relationshipAgentId: context.callerAgentId,
    sensitivity: 'S0', // 记忆质量闸
    structuredData: {
      [LIFE_TICK_MARKER]: {
        templateId: event.templateId,
        topics: event.topics,
        proactive: Boolean(proactive && proactive.sent),
        generator, // 'model' | 'rule' | 'rule_fallback' —— 审计用
      },
    },
  });
  const lifeEventId = written && written.memory ? written.memory.memoryId : null;

  // 5. 若允许且判定通过，登记 proactive mention（走既有 cooldown 语义）
  let mention = null;
  if (proactive && proactive.sent && lifeEventId) {
    mention = await memory.recordMention(context, {
      memoryIds: [lifeEventId],
      topicKey: `life_tick_${event.templateId}`,
      cooldownMs: defaults.proactiveCooldownMs,
    }).catch(error => ({ status: 'error', code: error && error.code }));
  }

  return {
    status: 'ok',
    lifeEventId,
    template: event.templateId,
    content: event.content,
    sensitivity: event.sensitivity,
    generator,
    generatorError: lastGeneratorError,
    proactive: proactive ? { ...proactive, mention } : null,
  };
}
