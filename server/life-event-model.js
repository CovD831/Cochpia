// Companion Life Tick 的生活事件生成器（R-021 / L18 V1.5 —— 模型实现）。
//
// 契约（V0 就定下的「接口先行」，计划 §2.3）：
//   输入 { recentItems, personality, templateId, rng } → 输出结构化生活事件
//   输出形状：{ templateId, content, topics, sensitivity }
// 规则实现见 `life-tick.js` 的 `generateLifeEvent`；本文件是**同签名的模型实现**，
// 两者可互换，评测同口径。
//
// 老板 2026-09-17 决策：
//   - 模型来源 = 与本项目主模型同一配置（workbuddy2api 网关）；
//   - 模型 = `Z-deepseek-v4.1-flash`；
//   - **关闭思考模式**（`thinking: {type:'disabled'}`，实测网关接受）；
//   - 成本很低，不做硬性成本节流（但保留每日预算闸，那是「打扰闸」不是成本闸）。
//
// 记忆质量闸（必须守住，V0 契约 §3）：
//   1. 输出一律 S0 —— agent 自身的元活动，不涉用户信息；
//   2. **禁止对用户做情感推断**（V0 起就禁止，模型实现同样禁止）；
//   3. 不允许把记忆原文抄进生活事件（模型只看到**聚合元信息**，看不到原文）。
//
// 第 3 条是这里的核心安全设计：喂给模型的不是记忆内容，而是「有多少条、都是什么
// 类型的活动」这类**元数据**。模型没有原文可抄，也就没有泄露通道。

import { LIFE_EVENT_TEMPLATES } from './life-tick.js';

export const LIFE_EVENT_MODEL_FLAG = 'MEMORY_LIFE_TICK_MODEL_ENABLED';

// 模型实现的默认参数。temperature 比主对话低（生活事件要稳定、不要花哨）。
export const LIFE_EVENT_MODEL_DEFAULTS = Object.freeze({
  temperature: 0.7,
  maxTokens: 120,
  timeoutMs: 20000,
});

function isModelEnabled(env) {
  return String((env || process.env)[LIFE_EVENT_MODEL_FLAG] || '').toLowerCase() === 'true';
}

// 只把**元信息**交给模型：条数与类型分布。刻意不含任何 content 字段。
export function buildMetaBrief(recentItems = []) {
  const counts = new Map();
  for (const item of recentItems) {
    const type = (item && item.memoryType) || 'unknown';
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  const distribution = [...counts.entries()]
    .map(([type, n]) => `${type}×${n}`)
    .join('、') || '暂无';
  return { total: recentItems.length, distribution };
}

function buildPrompt({ recentItems, personality }) {
  const brief = buildMetaBrief(recentItems);
  const traits = (personality && Array.isArray(personality.traits))
    ? personality.traits.map(t => `${t.label}${Math.round((t.value ?? 0) * 100)}%`).join('、')
    : '';
  const allowed = LIFE_EVENT_TEMPLATES.map(t => `- ${t.id}: ${t.template}`).join('\n');

  const system = [
    '你在为一个 AI 伴侣生成「它自己这一天做了什么」的生活记录。',
    '要求：',
    '1. 只描述 AI 自己的内在活动（回顾、整理、注意到某事），不要描述用户。',
    '2. 禁止对用户的心情、性格、动机做任何推断。',
    '3. 一句话，20 字以内，用第一人称或无人称都可以，语气自然克制。',
    '4. 不要提及"记忆条数"这类系统术语，要说得像人的日常。',
    `5. 从下面这些类型里挑最贴近的一种，并在 templateId 字段里回它的 id：`,
    allowed,
    '6. 只输出 JSON：{"templateId":"<id>","content":"<一句话>"}，不要任何其他内容。',
  ].join('\n');

  const user = [
    `今天感知到的事：共 ${brief.total} 件（${brief.distribution}）。`,
    traits ? `当前人格倾向：${traits}。` : '',
  ].filter(Boolean).join('\n');

  return { system, user };
}

// 从模型回复里稳健地抽出 JSON（模型可能包 ```json 或加前后缀）。
function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const brace = candidate.match(/\{[\s\S]*\}/);
    if (brace) {
      try { return JSON.parse(brace[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

/**
 * 用模型生成生活事件。
 *
 * @param {object} deps
 * @param {object} deps.model      createModelProvider() 实例（需有 complete/chat 之类方法）
 * @param {Array}  deps.recentItems 最近记忆（**只取元信息喂给模型**）
 * @param {object} [deps.personality] 人格投影
 * @param {string} [deps.templateId]  指定模板（测试/确定性用）
 * @param {Function} [deps.rng]
 * @param {object} [deps.env]
 * @param {Function} [deps.callModel] 覆盖模型调用（测试注入）
 */
export async function generateLifeEventWithModel(deps = {}) {
  const {
    model,
    recentItems = [],
    personality = null,
    templateId = null,
    rng = Math.random,
    env = process.env,
    callModel,
    defaults = LIFE_EVENT_MODEL_DEFAULTS,
  } = deps;

  const invoke = callModel || (model && typeof model.lifeEventText === 'function'
    ? payload => model.lifeEventText(payload, defaults)
    : null);

  if (typeof invoke !== 'function') {
    throw new Error('generateLifeEventWithModel requires a model with lifeEventText() or a callModel override');
  }

  const { system, user } = buildPrompt({ recentItems, personality });
  const text = await invoke({ system, user, temperature: defaults.temperature, maxTokens: defaults.maxTokens });
  const parsed = extractJson(text);

  // 模型输出不可用时**不抛错**——由调用方决定是否回落规则模板（见 life-tick.js）。
  if (!parsed || !parsed.content) return null;

  // 白名单校验：templateId 必须在允许集合内，否则回落到随机合法模板。
  const allowedIds = new Set(LIFE_EVENT_TEMPLATES.map(t => t.id));
  const chosenId = templateId && allowedIds.has(templateId)
    ? templateId
    : (allowedIds.has(parsed.templateId) ? parsed.templateId : (parsed.templateId === undefined ? LIFE_EVENT_TEMPLATES[0].id : null));
  if (chosenId === null) return null;

  const content = String(parsed.content).trim().slice(0, 120);
  if (!content) return null;

  return {
    templateId: chosenId,
    content,
    topics: ['self_activity'],
    sensitivity: 'S0', // 记忆质量闸：模型实现同样强制 S0
    generatedBy: 'model',
  };
}

export { isModelEnabled };
