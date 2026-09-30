// R-021 V2①：Agent 内在面（生活事件）的纯展示助手。
//
// 为什么单独成文件：与 chat/message-utils.js 同一考虑——把「无 React 依赖、
// 无模块状态」的映射逻辑抽出来，它就能被单元测试钉住，而不是只靠浏览器
// 验收跑一遍。页面本身仍留在 main.jsx（与 home/arcana/life 三个页一致）：
// 在没有自动化检查打开它之前抽组件，正是把重构变成「等用户点击才发现」的静默故障。

// life tick 的模板白名单（server/life-tick.js LIFE_EVENT_TEMPLATES）。
// 这里是**展示用**短标签，与产品文案解耦：模板 id 变了下文会回落到原 id，
// 不会抛错，也不会假装认识它。
const TEMPLATE_LABELS = {
  revisit: '回顾',
  tidy: '整理',
  noticing: '留意'
};

// 生成方式：V0 是规则模板，V1.5 起可接模型；rule_fallback 表示模型没答好、
// 自动回落。这三个值对用户是「这次是不是它自己想的」，值得如实显示。
const GENERATOR_LABELS = {
  model: '由模型生成',
  rule: '按规则生成',
  rule_fallback: '模型未就绪，按规则生成'
};

export function lifeTemplateLabel(marker) {
  const id = marker?.templateId;
  if (!id || typeof id !== 'string') return '生活事件';
  return TEMPLATE_LABELS[id] || id;
}

export function lifeGeneratorLabel(marker) {
  const generator = marker?.generator;
  if (!generator || typeof generator !== 'string') return null;
  return GENERATOR_LABELS[generator] || null;
}

// 主动提及标记：V2① 阶段 proactive 一律为 false（老板 2026-09-28 裁决：先不做
// 主动提及）。这里如实读标记，不写死——将来开启后 UI 自动跟着变。
export function isProactive(marker) {
  return Boolean(marker?.proactive);
}

// 时间戳 → 可排序数值；脏值一律落到最旧，避免 NaN 把排序搅乱。
const ts = value => {
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
};

// 时间戳 → 安全的时间显示。
//
// 为什么需要它：`Intl.DateTimeFormat.format(new Date('bad'))` 抛
// `RangeError: Invalid time value`。页面里直接写 `formatTime(item.createdAt)`
// 时，这个异常会冒泡到 AppErrorBoundary，把**整个应用**换成错误页 —— 不是只坏这一页。
// （注意 `dateLabel` 不抛，它对非法值返回「NaN月NaN日」；能抛的是 Intl 这一路。）
// 判定/排序/分组各自已有兜底，唯独「渲染时刻」这条路径此前没有。
export function safeFormatTime(value, formatter, fallback = '时间未知') {
  if (typeof formatter !== 'function') return fallback;
  try {
    const out = formatter(value);
    return typeof out === 'string' && out && out !== 'Invalid Date' ? out : fallback;
  } catch {
    return fallback;
  }
}

// 新→旧排序。server 的 list() 不保证顺序（实测返回顺序是任意的），
// 所以顺序必须由这里确定，而不是指望上游。
export function sortLifeEvents(items) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => ts(b?.createdAt) - ts(a?.createdAt));
}

// 按「今天 / 昨天 / 月日」分组，保持传入顺序（即新→旧）。
// labelOf 接收**整条 item**（不是时间字符串）——这样调用方可以自由决定用哪个字段，
// 也避免「实现传字符串、调用方当对象用」这类只在真实页面才暴露的契约错配。
// 复用 chat/message-utils 的 dateLabel，确保与聊天记录里的日期口径完全一致。
//
// label() 失败同样要吞掉：虽然 dateLabel 对非法值只返回「NaN月NaN日」而不抛，
// 但 labelOf 是调用方注入的，任何实现都可能抛；分组是渲染前置步骤，
// 一次异常就会经 AppErrorBoundary 换掉整个应用。
export function groupLifeByDay(items, labelOf, fallbackLabel = '未知日期') {
  const label = typeof labelOf === 'function' ? labelOf : () => '';
  const groups = [];
  for (const item of Array.isArray(items) ? items : []) {
    let day;
    try {
      day = label(item);
    } catch {
      day = fallbackLabel;
    }
    if (typeof day !== 'string') day = fallbackLabel;
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

// 概览：给页面顶部一行摘要用。空列表返回 null，让调用方决定空状态文案。
export function summarizeLife(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  const sorted = sortLifeEvents(list);
  const newest = sorted[0]?.createdAt || null;
  const modelCount = list.filter(item => item?.marker?.generator === 'model').length;
  return { total: list.length, newest, modelCount };
}
