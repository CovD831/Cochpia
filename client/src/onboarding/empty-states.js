// 首次引导与统一空状态的**文案 + 判定**唯一来源。
//
// 为什么单独成文件（与 chat/message-utils.js、life/life-utils.js 同一考虑）：
// 1. 无 React 依赖 ⇒ 纯函数能被 node:test 直接钉住，而不是只靠浏览器点一遍；
// 2. 文案集中 ⇒ 本阶段不做全量 i18n（3,771 处硬编码是独立工程），但新增 UI
//    不再制造新的散落文案，将来换 key 只动这一个文件；
// 3. main.jsx 的集成 track 只 import，不复制字符串 ⇒ 同一句话不会有两份会漂移的副本。

// ---------------------------------------------------------------------------
// 文案原则（写在这里是为了让后来人不必去翻文档才知道边界）
//
// 本项目的卖点是「AI 的记忆是透明、可审计、可反悔的」。引导面向的是**新用户**，
// 他们会把这里说的话当成产品承诺。所以每一条都必须对应仓库里真实存在的代码路径：
//
//   看到记忆    → GET  /api/memory/memories           （server/memory-governance-routes.js）
//   改记忆      → POST /api/memory/memories/:id/correct
//   删掉记忆    → DELETE /api/memory/memories/:id（另有 post …/:id/forget、/revoke）
//   看到生活记录 → GET  /api/memory/life               （server/index.js）
//   成长证据可确认/驳回 → GET/PATCH /api/growth/evidence（server/index.js）
//   带走数据    → GET  /api/export                     （server/index.js）
//
// 注意路由前缀是 **/api/memory/memories***（不是 /api/memories*）—— 前缀写错会让
// 这段「出处」变成另一种假话。引用时优先写文件名而不是行号：行号会随改动漂移，
// 一个指向错行的出处，比没有出处更容易骗过后来的人。
//
// **不要**在这里写产品没做的事。本项目刚花一整轮清理「对用户说假话的地方」
// （假日历承诺自动注入上下文、写死「SSE 已连接」、写死「关系正在形成」），
// 新增文案必须做得到。写下一条承诺前，先去仓库里把对应的路由/函数找出来；
// 找不到就不要写。
// ---------------------------------------------------------------------------

// 用户可见的「记忆主权」四条，按用户能亲手做的动作排序，而不是按后端模块名。
// label 是动作，body 说清楚它到底做了什么、边界在哪（例如删除是「连同它派生的
// 证据」而不是含糊的「彻底消失」）。
export const SOVEREIGNTY_POINTS = [
  {
    id: 'see',
    label: '看见',
    body: 'AI 记住的每一条，都列在记忆面板里，包括它是从哪次对话来的。'
  },
  {
    id: 'correct',
    label: '改',
    body: '记忆写错了，你可以直接改，不用绕着跟 AI 解释。'
  },
  {
    id: 'forget',
    label: '忘掉',
    body: '删掉一条记忆，它就真的查不回来了；由它派生的证据会一并清掉。'
  },
  {
    id: 'take',
    label: '带走',
    body: '你的数据可以整体导出成 JSON 文件，不需要向谁申请。'
  }
];

export const GUIDE_TITLE = '这里的记忆，你说了算';
export const GUIDE_BODY = 'Cochpia 会记住你们之间发生过的事。和别处不一样的是：它记住了什么，你随时看得见、改得动、删得掉。';
export const GUIDE_DISMISS_LABEL = '先自己看看';
export const GUIDE_START_LABEL = '开始第一次对话';
export const GUIDE_START_HINT = '第一句话不需要想好，说说今天就行。';


// 未知 kind 的兜底。
//
// 为什么要有兜底而不是抛错：调用方传进来的 kind 可能来自数据（例如后端新加的
// 一个 panel 类型）。为一个空状态把整个应用经 AppErrorBoundary 换成错误页，
// 是把「少一句话」升级成「用不了」。这里如实说「暂无内容」，不假装认识它。
const FALLBACK_STATE = {
  title: '这里还没有内容',
  body: '等有内容之后，会显示在这里。',
  actionLabel: null
};

// 查表必须走**自有属性**，不能是 `EMPTY_STATES[kind]`。
//
// 为什么：`EMPTY_STATES` 是普通对象，它的原型链上有 constructor / toString /
// valueOf / hasOwnProperty 等键。于是 `EMPTY_STATES['constructor']` 返回 Object
// 构造函数 —— 一个**真值**，`if (!state)` 拦不住，`{...state}` 会展开成一个
// 没有 title/body 的空对象，界面渲染出一块**空白的空状态**：不报错、不白屏，
// 只是什么话都不说。这正是本项目刚清理过的那类「静默错误」。
//
// kind 是调用方传进来的（可能来自后端新加的 panel 类型），所以这类键是能被撞上的。
// 用 null 原型查表，一次性消除整类问题，而不是给每个可疑键打补丁。
const EMPTY_STATES = Object.freeze(Object.assign(Object.create(null), {
  // 会话列表为空：新用户打开应用看到的第一个画面。
  sessions: {
    title: '还没有开始过对话',
    body: '这里会成为你们的共同记录。每一次对话都会被记下来，重要的部分才会进入长记忆。',
    actionLabel: '开始第一次对话'
  },
  // 记忆面板为空。注意：这里**不能**承诺「AI 已经记住你了」，
  // 因为此刻确实一条都没有。
  memories: {
    title: '还没有形成长期记忆',
    body: '不是每句话都会变成记忆。只有被判定为重要的内容才会留在这里，留下的每一条你都能查看和删除。',
    actionLabel: '去聊几句'
  },
  // 生活记录（Agent 内在面）为空。
  life: {
    title: '它还没有自己的生活记录',
    body: '生活事件会按它自己的节奏生成，不依赖你开口。过一段时间再回来看看。',
    actionLabel: null
  },
  // 成长证据为空。product 真实行为：证据由对话产生，用户确认后才改人格。
  evidence: {
    title: '暂时没有成长证据',
    body: '聊几句之后，这里会出现它可以据以改变的线索。每条都要你确认才会生效，你也可以驳回。',
    actionLabel: null
  },
  // 模型供应商未配置。
  models: {
    title: '还没有可用的模型',
    body: '在设置里填一个供应商的 API Key，对话才能跑起来。没有配置之前，应用不会假装自己能用。',
    actionLabel: '去设置'
  }
}));

// 读取单个 kind 的状态。集中在这里，避免 emptyStateFor / isEmptyStateComplete
// 两处各写一遍查表而漏掉同一个坑。
const stateFor = kind => (typeof kind === 'string' ? EMPTY_STATES[kind] : undefined);

// 「这条文案可用吗」的唯一判据。
// 注意 actionLabel 允许为 null（= 这个空状态没有动作），所以只校验 title/body。
const isCompleteState = state => Boolean(
  state
  && typeof state.title === 'string' && state.title.length > 0
  && typeof state.body === 'string' && state.body.length > 0
);

/**
 * 取某个位置的空状态文案。
 *
 * @param {'sessions'|'memories'|'life'|'evidence'|'models'} kind
 * @returns {{ title: string, body: string, actionLabel: string|null }}
 */
export function emptyStateFor(kind) {
  const state = stateFor(kind);
  // 除了「查不到」，还要挡住「查到了但内容不全」。后者正是原型链漏洞的形态：
  // `EMPTY_STATES['constructor']` 返回的是 Object 构造函数（真值），
  // 但展开后没有 title/body —— 界面会渲染出一块什么都不说的空状态。
  if (!isCompleteState(state)) return { ...FALLBACK_STATE };
  // 只挑这三个字段返回副本：调用方（尤其是 JSX 内联 map）拿到引用后可能就地改，
  // 一旦改了就会污染下一次渲染，而这种 bug 只在第二次打开面板时出现。
  return { title: state.title, body: state.body, actionLabel: state.actionLabel };
}

/** 所有受支持的 kind，供测试与设置页枚举使用。 */
export const EMPTY_STATE_KINDS = Object.freeze(Object.keys(EMPTY_STATES));

/**
 * 空状态文案是否可信（有标题、有说明）。
 * 单元测试用它做全表体检：将来新增 kind 忘了写 body，测试会红。
 */
export function isEmptyStateComplete(kind) {
  return isCompleteState(stateFor(kind));
}

/**
 * 解析「用户是否已经关掉过引导」。
 *
 * 为什么要容忍多种取值而不是只认 `=== true`：
 * - 这个标志会被写进 workspace 偏好、再经 JSON 往返，布尔变成 `'true'` / `1` 是
 *   真实发生过的一类问题；
 * - 但它**不能**用 js 的隐式真值：字符串 `'false'` 是 truthy，直接用 `Boolean()`
 *   会把「没关过」读成「关过了」，引导从此永远不出现，而且没有任何报错。
 *
 * 所以这里显式列出「算关过」与「算没关过」的取值。方向是保守的：
 * 只有明确表示「关过」才返回 true，其余一律当作没关过（最多再显示一次）。
 */
function isDismissed(value) {
  if (value === true) return true;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    // 'false' / '' 明确表示没关过；其余非空字符串（含 'true'）算关过。
    return v !== '' && v !== 'false';
  }
  if (typeof value === 'number') return value !== 0 && Number.isFinite(value);
  return false;
}

/**
 * 是否显示首次引导。
 *
 * 判定故意保持简单且**可解释**：只有一个条件 —— 用户还没有任何会话，
 * 且没有关掉过引导。不做「注册天数」「是否首次登录」这类没有真凭实据的推断，
 * 因为一旦猜错，引导会反复弹在一个老用户脸上。
 *
 * @param {{ sessionCount?: unknown, dismissed?: unknown }} input
 * @returns {boolean}
 */
export function shouldShowGuide(input) {
  if (!input || typeof input !== 'object') return false;
  if (isDismissed(input.dismissed)) return false;
  const raw = input.sessionCount;
  // 显式挡住 null / '' / 空数组：Number() 会把它们都变成 0，于是「计数还没加载」
  // 会伪装成「一条会话都没有」，引导就会在别人的数据上弹出来。
  // 只有真正的数字或数字字符串才算数。
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'string' && raw.trim() === '') return false;
  if (typeof raw !== 'number' && typeof raw !== 'string') return false;
  const count = Number(raw);
  // 计数不可用（NaN / Infinity）时**不显示**：引导是锦上添花，
  // 数据没准备好时弹出来，比不弹更糟。
  if (!Number.isFinite(count)) return false;
  return count <= 0;
}

/**
 * 记忆面板头部的计数文案。
 *
 * 为什么单独抽出来：`truncated` 是上游 contextBundle 裁剪后唯一的真话标志
 * （见 server/index.js 里 /api/memory/overview 的注释 —— 第一版修错地方，
 * 导致 truncated 恒为 false，界面显示「6 条」而用户无从知道还有 94 条）。
 * 这里如实透出截断，不知道总数时就说不知道，不编一个数字。
 *
 * 两个必须显式处理的坑（都由 frontend-panel 探针发现）：
 * 1. `Number()` 的强制转换会**伪造计数**：`Number(true) === 1`、`Number([5]) === 5`。
 *    于是一个布尔或数组会被显示成一条看起来合理的「1 条记忆」/「5 条记忆」——
 *    静默错误比白屏更危险，因为没人会去查。
 * 2. `Number(null) === 0`、`Number('') === 0` ⇒ 显示「还没有记忆」，
 *    把「计数还没加载」谎报成「一条都没有」。这正是在说反话。
 * 所以：只接受真正的数字或非空数字字符串，其余一律「未知」。
 *
 * @param {{ count?: unknown, truncated?: unknown }} input
 * @returns {string}
 */
export function memoryCountLabel(input) {
  const count = toFiniteCount(input?.count);
  // 计数不可信时如实说不知道 —— 不猜、也不谎报成 0。
  if (count === null) return '记忆条数未知';
  if (count === 0) return '还没有记忆';
  // 截断标志同样只认真实取值：上游经 JSON 往返后可能是 1 / 'true'。
  // 只认 `=== true` 会让截断提示在真被截断时消失，而那正是这个标志存在的全部意义。
  if (isTruncated(input?.truncated)) return `显示 ${count} 条 · 还有更多未列出`;
  return `${count} 条记忆`;
}

// 「真的是个计数吗」的唯一判据：数字或非空数字字符串，且有限、非负。
// 与 shouldShowGuide 的 sessionCount 共用，避免两处各自写一套转换而漂移。
function toFiniteCount(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  // 布尔、数组、对象、null、undefined 一律不当作计数。
  return null;
}

// 截断标志：容忍布尔与经 JSON 往返的 1/'true'，但 `'false'` 必须读成「没有截断」
// （字符串 'false' 是 truthy，直接用 Boolean() 会把「没截断」读成「截断了」——
// 那会让界面在没截断时也显示「还有更多未列出」，同样是假话）。
function isTruncated(value) {
  if (value === true) return true;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v !== '' && v !== 'false' && v !== '0';
  }
  return false;
}

/**
 * 引导步骤列表。每条都对应上面 SOVEREIGNTY_POINTS 里真实存在的动作。
 * 单独导出是为了让 FirstRunGuide 只负责渲染，文案仍集中在本文件。
 */
export function guidePoints() {
  return SOVEREIGNTY_POINTS.map(point => ({ ...point }));
}
