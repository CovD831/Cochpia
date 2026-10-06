// 记忆主权面板的纯函数层（无 React、无 DOM、无网络）。
//
// 为什么把逻辑挤出组件：面板要回答的问题（这条能不能删、排序、分组、标签、
// 时间怎么显示）全是**纯判定**，把它们放进组件就只能靠渲染才能测。挤出来之后
// 每一个边界都能用 assert 直接钉住，尤其是「后端给了脏数据」这一类 —— 面板是
// 「可见/可改/可删/可带走」的入口，任何一条脏数据让整页白屏，用户就彻底失去
// 对自己记忆的控制权。
//
// 本文件的第一原则：**永不抛异常**。任何输入（undefined / null / 字符串 /
// 缺字段 / 未知 status / 非法时间）都必须返回一个可渲染的降级值。

// 记忆治理状态。未知状态一律降级为 'active'，绝不原样透出——
// 否则 CSS 类名会被后端字段污染，且 UI 会显示一个用户看不懂的原始枚举。
export const MEMORY_STATUSES = ['active', 'pinned', 'revoked', 'forgotten'];

// 状态 → 中文标签。未知状态不显示原始枚举（可能泄露内部实现细节），
// 显示「未知状态」而不是崩掉或留空。
const STATUS_LABELS = {
  active: '生效中',
  pinned: '已钉住',
  revoked: '已撤销',
  forgotten: '已遗忘'
};

// 记忆类型 → 中文标签。沿用 main.jsx 既有 inspector 的既有措辞（关系/事件），
// 不新造词，避免同一份数据在两处显示成两个名字。
const TYPE_LABELS = {
  relationship: '关系',
  event: '事件',
  preference: '偏好',
  fact: '事实',
  episode: '片段'
};

const asArray = value => (Array.isArray(value) ? value : []);

// 时间戳 → 可排序数值；脏值一律落到 0（最旧），避免 NaN 把 sort 搅乱。
// 与 client/src/life/life-utils.js 的 `ts` 保持同一策略。
//
// 类型白名单是**必需**的，不是洁癖：`new Date(true)` 不抛错，它把布尔按
// 数字 1 处理 → 1970-01-01T00:00:00.001Z，于是界面上出现一条“1970 年的记忆”。
// 同理 `new Date([])` → 1970。这类值不会有异常提示，只会安静地显示错时间，
// 比白屏更难被发现，所以在入口就挡掉。布尔日期是错的，但「1970 年有过这段
// 记忆」是**看起来合理**的错——这才危险。
const ts = value => {
  const type = typeof value;
  const numeric = type === 'number' || (type === 'string' && value.trim() !== '');
  const dateLike = value instanceof Date;
  if (!numeric && !dateLike) return 0;
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
};

export const toTimestamp = ts;

// 安全的归一化状态：任何非字符串/未知值 → 'active'。
export function normalizeStatus(status) {
  return typeof status === 'string' && Object.prototype.hasOwnProperty.call(STATUS_LABELS, status) ? status : 'active';
}

// 查表读一个「自有」键的字符串值。
//
// 为什么不能直接 `TABLE[key]`：JS 对象从 Object.prototype 继承了一大票键。
// `STATUS_LABELS['constructor']` 返回的是**函数 Object()**，不是 undefined，
// 于是 `|| '未知状态'` 的兜底根本不会触发。后果分两级：
//   - memoryStatusLabel('constructor') → 返回原生函数 → React 渲染时报
//     「Functions are not valid as a React child」→**整个面板崩掉**；
//   - memoryTypeLabel 会把这个函数当类型名透出。
// 这与 client/src/onboarding/empty-states.js 里 emptyStateFor('constructor')
// 返回空对象是**同一个坑**，那边已用 null 原型根治，这里同样从根上挡掉，
// 而不是给 constructor/toString 逐个打补丁（打不完）。
const ownString = (table, key) => {
  if (typeof key !== 'string') return null;
  const value = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
  return typeof value === 'string' && value ? value : null;
};

export function memoryStatusLabel(status) {
  return ownString(STATUS_LABELS, status) || '未知状态';
}

// 类型标签。item 本身可能是 null/undefined（后端数组里混进空槽），
// 所以先自保再取字段。未知类型**原样透出**是可接受的（类型名来自后端数据，
// 显示真名比显示「未知」更有用），但必须挡掉原型链键 —— 否则会透出一个函数。
export function memoryTypeLabel(item) {
  const type = item && typeof item === 'object' ? item.type : null;
  if (typeof type !== 'string' || !type) return '记忆';
  return ownString(TYPE_LABELS, type) || type;
}

// 认同度 → 0..100 整数百分比；脏值返回 null（表示「不显示」而不是「显示 NaN%」）。
export function confidencePercent(item) {
  const raw = item && typeof item === 'object' ? item.confidence : null;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.min(1, Math.max(0, n));
  return Math.round(clamped * 100);
}

// 每个 item 的稳定 key。后端可能给非字符串 id（数字/空），
// key 不可靠时退回下标，保证 React 不会因重复 key 报警。
export function memoryKey(item, index) {
  const id = item && typeof item === 'object' ? item.id : null;
  if (typeof id === 'string' && id) return id;
  if (typeof id === 'number' && Number.isFinite(id)) return `n:${id}`;
  return `i:${Number.isInteger(index) ? index : 0}`;
}

// 时间显示的唯一出口。
//
// 为什么必须容错：`Intl.DateTimeFormat.format(new Date('bad'))` 抛
// `RangeError: Invalid time value`。这个异常会冒泡到 AppErrorBoundary，
// 把**整个应用**换成错误页——不是只坏这一条。项目此前已经踩过（见
// client/src/life/life-utils.js 的 safeFormatTime 注释）。面板渲染时间时
// 必须走这里，不允许在 JSX 里直接 `new Date(x).toLocaleString()`。
export function formatMemoryTime(value, fallback = '时间未知') {
  const ms = ts(value);
  if (!ms) return fallback;
  try {
    const out = new Date(ms).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return typeof out === 'string' && out && out !== 'Invalid Date' ? out : fallback;
  } catch {
    return fallback;
  }
}

// 遗忘的判据：只有「还在生效」的记忆才谈得上遗忘。
// 已遗忘/已撤销的记忆再点遗忘是无意义请求，必须在 UI 层就挡掉。
export function canForget(item) {
  if (!item || typeof item !== 'object') return false;
  const status = normalizeStatus(item.status);
  return status === 'active' || status === 'pinned';
}

// 撤销的判据：撤销 = 「不再使用，但保留审计」。已被撤销/遗忘的没有可撤销的语义。
export function canRevoke(item) {
  if (!item || typeof item !== 'object') return false;
  const status = normalizeStatus(item.status);
  return status === 'active' || status === 'pinned';
}

// 改写的判据：撤销/遗忘是终态，不允许再改内容（改了也读不回来，只会造成
// 「我明明改过」的错觉）。这与后端 correct 的语义一致。
export function canCorrect(item) {
  if (!item || typeof item !== 'object') return false;
  const status = normalizeStatus(item.status);
  return status === 'active' || status === 'pinned';
}

// 钉住/取消钉住。撤销/遗忘是终态，不可再钉。
export function canPin(item) {
  if (!item || typeof item !== 'object') return false;
  const status = normalizeStatus(item.status);
  return status === 'active' || status === 'pinned';
}

export function isPinned(item) {
  return normalizeStatus(item?.status) === 'pinned';
}

// 改写提交前的校验。返回 {ok, value} 或 {ok:false, reason}。
// 空内容不允许提交：warden 语义上「把记忆改成空」等于软删除，但用户以为自己在改写。
export function validateSummaryDraft(draft, maxLength = 2000) {
  const text = typeof draft === 'string' ? draft.trim() : '';
  if (!text) return { ok: false, reason: 'empty' };
  // maxLength 的兜底**必须**显式做，不能指望默认参数：默认参数只在实参为
  // undefined 时生效，传 NaN / null 会原样进来。而 `text.length > NaN` 恒为
  // false ⇒ 长度护栏**静默失效**，任意超长内容都被放行。护栏失效比没有护栏
  // 更糟：调用方以为有上限，于是不再自己检查。
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? maxLength : 2000;
  if (text.length > limit) return { ok: false, reason: 'too-long' };
  return { ok: true, value: text };
}

// 新→旧排序。服务端 list() 不保证顺序，所以顺序必须在这里确定，
// 而不是指望上游。永远返回新数组，不改动入参。
export function sortMemories(items) {
  return asArray(items)
    .filter(item => item && typeof item === 'object')
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const diff = ts(b.item.createdAt) - ts(a.item.createdAt);
      // 时间相同（含全部脏时间戳 → 0）时必须回落到原下标，
      // 否则等值项相对顺序不稳定，React 重排会闪。
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map(entry => entry.item);
}

// 作用域中文名。
const SCOPE_LABELS = {
  relationship: '这段关系',
  user: '只属于我',
  session: '本次对话',
  account: '我的账号',
  global: '全局'
};

export function memoryScopeLabel(scopeType) {
  if (typeof scopeType !== 'string' || !scopeType) return '这段关系';
  // 同 memoryStatusLabel：必须查「自有」键，否则 'constructor' 会透出一个函数。
  return ownString(SCOPE_LABELS, scopeType) || scopeType;
}

// 按作用域分组。返回 [{scope, label, items}]，组内已排序，组间按
// 「有内容的组优先 + 名称稳定」排序，保证同样输入永远同样输出。
export function groupMemoriesByScope(items) {
  const sorted = sortMemories(items);
  const buckets = new Map();
  sorted.forEach(item => {
    const scope = typeof item.scopeType === 'string' && item.scopeType ? item.scopeType : 'relationship';
    if (!buckets.has(scope)) buckets.set(scope, []);
    buckets.get(scope).push(item);
  });
  return [...buckets.entries()]
    .map(([scope, groupItems]) => ({ scope, label: memoryScopeLabel(scope), items: groupItems }))
    .sort((a, b) => (b.items.length - a.items.length) || (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
}

// 可见性摘要，给 section-heading 用：诚实反映「被截断了多少」。
// 服务端截断时若不说清楚，用户会以为自己的记忆丢了 —— 这正是主权面板要消除的焦虑。
export function memoryCountLabel(memories, truncated) {
  const total = sortMemories(memories).length;
  if (total === 0) return '暂无记忆';
  return truncated ? `已加载 ${total} 条 · 还有更多` : `共 ${total} 条`;
}

// 面板整体的空/错/加载判定，把「先显示什么」这段优先级逻辑也变成可测的纯函数。
export function panelPhase({ loading, error, memories, hasMore } = {}) {
  if (error) return 'error';
  const list = sortMemories(memories);
  if (list.length > 0) return 'list';
  // 关键：已有数据时即使正在加载更多，也不能把列表换成「加载中」，
  // 否则用户每翻一页就会看到内容闪没 —— 面板的可信度直接受损。
  if (loading) return 'loading';
  if (hasMore) return 'list';
  return 'empty';
}
