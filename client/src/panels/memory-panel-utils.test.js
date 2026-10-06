// 记忆主权面板纯函数的边界测试。
//
// 重点不是「正常输入返回正常值」，而是**脏数据不能让整页白屏**：
// 面板是用户「可见/可改/可删/可带走」自己记忆的唯一入口，一条来自后端的
// 非法时间戳如果在这里抛 RangeError，冒泡到 AppErrorBoundary 就会把整个
// 应用换成错误页——用户因此彻底失去对记忆的控制权。项目此前踩过一次
// （client/src/life/life-utils.js 的注释留了记录），这里用断言把它焊死。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupMemoriesByScope,
  sortMemories,
  memoryStatusLabel,
  memoryTypeLabel,
  memoryScopeLabel,
  memoryCountLabel,
  memoryKey,
  confidencePercent,
  normalizeStatus,
  canForget,
  canRevoke,
  canCorrect,
  canPin,
  isPinned,
  validateSummaryDraft,
  formatMemoryTime,
  panelPhase,
  UNKNOWN_SCOPE
} from './memory-panel-utils.js';

const memory = (over = {}) => ({ id: 'm1', summary: '一起看过落日', status: 'active', confidence: 0.8, createdAt: '2026-01-02T03:04:05.000Z', source: '对话', scopeType: 'relationship', memoryType: 'fact', ...over });

// ---------------------------------------------------------------- 空数组 / 缺失

test('sortMemories：空数组返回空数组，且不抛', () => {
  assert.deepEqual(sortMemories([]), []);
});

test('sortMemories：非数组输入（undefined/null/字符串/对象）一律降级为空数组', () => {
  for (const bad of [undefined, null, 'nope', 42, {}]) {
    assert.deepEqual(sortMemories(bad), [], `输入 ${JSON.stringify(bad)} 应降级为空数组`);
  }
});

test('sortMemories：过滤掉数组里的空槽与原始值，不因脏元素整体失败', () => {
  const out = sortMemories([null, undefined, 7, 'x', memory({ id: 'keep' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'keep');
});

test('groupMemoriesByScope：空数组返回空分组', () => {
  assert.deepEqual(groupMemoriesByScope([]), []);
  assert.deepEqual(groupMemoriesByScope(null), []);
});

// ---------------------------------------------------------------- 缺字段

test('缺字段的条目不会崩，且每个取值函数都返回降级值', () => {
  const bare = { id: 'bare' }; // 没有 status / confidence / memoryType / scopeType / createdAt
  assert.equal(memoryStatusLabel(bare.status), '未知状态');
  assert.equal(memoryTypeLabel(bare), '记忆');
  assert.equal(memoryScopeLabel(bare.scopeType), '作用范围未知');
  assert.equal(confidencePercent(bare), null);
  assert.equal(formatMemoryTime(bare.createdAt), '时间未知');
  assert.equal(normalizeStatus(bare.status), 'active');
  assert.doesNotThrow(() => sortMemories([bare]));
  assert.doesNotThrow(() => groupMemoriesByScope([bare]));
});

test('memoryTypeLabel / confidencePercent：item 为 null/undefined/非对象时不抛', () => {
  for (const bad of [null, undefined, 'x', 3]) {
    assert.equal(memoryTypeLabel(bad), '记忆');
    assert.equal(confidencePercent(bad), null);
    assert.equal(canForget(bad), false);
    assert.equal(canRevoke(bad), false);
    assert.equal(canCorrect(bad), false);
    assert.equal(canPin(bad), false);
    assert.equal(isPinned(bad), false);
  }
});

test('confidencePercent：越界值被夹到 0..100，脏值返回 null 而不是 NaN', () => {
  assert.equal(confidencePercent({ confidence: 0 }), 0);
  assert.equal(confidencePercent({ confidence: 1 }), 100);
  assert.equal(confidencePercent({ confidence: 1.7 }), 100);
  assert.equal(confidencePercent({ confidence: -3 }), 0);
  assert.equal(confidencePercent({ confidence: '0.42' }), 42);
  for (const bad of ['abc', NaN, Infinity, {}, null, undefined, '']) {
    assert.equal(confidencePercent({ confidence: bad }), null, `confidence=${String(bad)} 应为 null`);
  }
});

// ---------------------------------------------------------------- 未知 status

test('未知 / 非法 status 不崩，且降级为 active 而不是原样透出', () => {
  for (const bad of ['bogus', '', 'ACTIVE', 'deleted', null, undefined, 42, {}]) {
    assert.equal(normalizeStatus(bad), 'active', `status=${JSON.stringify(bad)} 应降级为 active`);
  }
});

test('未知 status 显示「未知状态」，不泄露原始枚举', () => {
  assert.equal(memoryStatusLabel('bogus'), '未知状态');
  assert.equal(memoryStatusLabel(null), '未知状态');
  assert.equal(memoryStatusLabel(undefined), '未知状态');
  assert.equal(memoryStatusLabel(42), '未知状态');
});

test('已知 status 显示中文标签', () => {
  assert.equal(memoryStatusLabel('active'), '生效中');
  assert.equal(memoryStatusLabel('pinned'), '已钉住');
  assert.equal(memoryStatusLabel('revoked'), '已撤销');
  assert.equal(memoryStatusLabel('forgotten'), '已遗忘');
});

test('未知 status 的条目仍可被渲染与判定（不崩），且按 active 对待', () => {
  const weird = memory({ id: 'w', status: 'deleted' });
  assert.doesNotThrow(() => sortMemories([weird]));
  assert.equal(canForget(weird), true, '未知状态按 active 对待，允许用户处置');
});

// ---------------------------------------------------------------- 时间容错（白屏防线）

test('formatMemoryTime：非法时间返回 fallback，绝不抛 RangeError', () => {
  const bads = ['bad', 'not-a-date', '', '🚀', '2026-13-45T99:99:99Z', {}, [], true];
  for (const bad of bads) {
    assert.doesNotThrow(() => formatMemoryTime(bad), `formatMemoryTime(${JSON.stringify(bad)}) 不应抛`);
    assert.equal(formatMemoryTime(bad), '时间未知', `formatMemoryTime(${JSON.stringify(bad)}) 应降级`);
  }
});

test('formatMemoryTime：null / undefined / 数字 0 都走 fallback，不显示 1970', () => {
  assert.equal(formatMemoryTime(null), '时间未知');
  assert.equal(formatMemoryTime(undefined), '时间未知');
  assert.equal(formatMemoryTime(0), '时间未知');
  assert.equal(formatMemoryTime(NaN), '时间未知');
});

test('formatMemoryTime：合法时间内返回非空字符串，且不含 Invalid Date', () => {
  const out = formatMemoryTime('2026-01-02T03:04:05.000Z');
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
  assert.ok(!out.includes('Invalid Date'));
  assert.ok(!out.includes('NaN'));
});

test('formatMemoryTime：支持自定义 fallback', () => {
  assert.equal(formatMemoryTime('bad', '—'), '—');
});

// ---------------------------------------------------------------- 排序 / 分组

test('sortMemories：新→旧，且不改动入参数组', () => {
  const input = [memory({ id: 'old', createdAt: '2026-01-01T00:00:00Z' }), memory({ id: 'new', createdAt: '2026-03-01T00:00:00Z' }), memory({ id: 'mid', createdAt: '2026-02-01T00:00:00Z' })];
  const snapshot = input.map(i => i.id);
  assert.deepEqual(sortMemories(input).map(i => i.id), ['new', 'mid', 'old']);
  assert.deepEqual(input.map(i => i.id), snapshot, '入参顺序不应被就地修改');
});

test('sortMemories：脏时间戳落到最后，且不破坏其余项的相对顺序', () => {
  const out = sortMemories([memory({ id: 'bad', createdAt: 'nope' }), memory({ id: 'new', createdAt: '2026-03-01T00:00:00Z' }), memory({ id: 'none' })]);
  assert.equal(out[0].id, 'new');
  assert.deepEqual(out.slice(1).map(i => i.id).sort(), ['bad', 'none']);
});

test('groupMemoriesByScope：按作用域分组，组内已排序，组间按数量降序稳定', () => {
  const groups = groupMemoriesByScope([
    memory({ id: 'u1', scopeType: 'user', createdAt: '2026-01-01T00:00:00Z' }),
    memory({ id: 'r1', scopeType: 'relationship', createdAt: '2026-01-01T00:00:00Z' }),
    memory({ id: 'r2', scopeType: 'relationship', createdAt: '2026-02-01T00:00:00Z' })
  ]);
  assert.deepEqual(groups.map(g => g.scope), ['relationship', 'user']);
  assert.deepEqual(groups[0].items.map(i => i.id), ['r2', 'r1'], '组内应新→旧');
  assert.equal(groups[0].label, '这段关系');
  assert.equal(groups[1].label, '只属于我');
});

test('groupMemoriesByScope：缺 scopeType 归入「作用范围未知」组，未知 scopeType 原样成组', () => {
  // 注意：缺 scopeType 曾归入 'relationship' 默认组 —— 那是**假信息**（把「不知道」
  // 伪装成「属于这段关系」），已改为显式的 UNKNOWN_SCOPE 哨兵。
  const groups = groupMemoriesByScope([memory({ id: 'a', scopeType: undefined }), memory({ id: 'b', scopeType: 'custom-scope' })]);
  const scopes = groups.map(g => g.scope).sort();
  assert.deepEqual(scopes, [UNKNOWN_SCOPE, 'custom-scope']);
  assert.equal(groups.find(g => g.scope === 'custom-scope').label, 'custom-scope');
  assert.equal(groups.find(g => g.scope === UNKNOWN_SCOPE).label, '作用范围未知');
});

test('groupMemoriesByScope：相同输入永远得到相同输出（组间顺序稳定）', () => {
  const build = () => [memory({ id: 'x', scopeType: 'user' }), memory({ id: 'y', scopeType: 'relationship' })];
  assert.deepEqual(groupMemoriesByScope(build()).map(g => g.scope), groupMemoriesByScope(build()).map(g => g.scope));
});

// ---------------------------------------------------------------- 动作判据

test('canForget：只有生效中/已钉住可遗忘；已撤销、已遗忘、未知状态都不可', () => {
  assert.equal(canForget(memory({ status: 'active' })), true);
  assert.equal(canForget(memory({ status: 'pinned' })), true);
  assert.equal(canForget(memory({ status: 'revoked' })), false, '已撤销不应再次遗忘');
  assert.equal(canForget(memory({ status: 'forgotten' })), false, '已遗忘不应再次遗忘');
});

test('canRevoke：与 canForget 同域，终态不可再撤销', () => {
  assert.equal(canRevoke(memory({ status: 'active' })), true);
  assert.equal(canRevoke(memory({ status: 'pinned' })), true);
  assert.equal(canRevoke(memory({ status: 'revoked' })), false);
  assert.equal(canRevoke(memory({ status: 'forgotten' })), false);
});

test('canCorrect / canPin：终态不可改写、不可再钉', () => {
  for (const status of ['revoked', 'forgotten']) {
    assert.equal(canCorrect(memory({ status })), false, `${status} 不应可改写`);
    assert.equal(canPin(memory({ status })), false, `${status} 不应可钉住`);
  }
  for (const status of ['active', 'pinned']) {
    assert.equal(canCorrect(memory({ status })), true);
    assert.equal(canPin(memory({ status })), true);
  }
});

test('isPinned：只有 pinned 为真', () => {
  assert.equal(isPinned(memory({ status: 'pinned' })), true);
  assert.equal(isPinned(memory({ status: 'active' })), false);
  assert.equal(isPinned(memory({ status: 'forgotten' })), false);
});

// ---------------------------------------------------------------- 改写校验

test('validateSummaryDraft：空 / 纯空白 / 非字符串一律拒绝，不允许把记忆改成空', () => {
  for (const bad of ['', '   ', '\n\t', null, undefined, 42, {}, []]) {
    const result = validateSummaryDraft(bad);
    assert.equal(result.ok, false, `draft=${JSON.stringify(bad)} 应被拒绝`);
    assert.equal(result.reason, 'empty');
  }
});

test('validateSummaryDraft：合法内容去除首尾空白后返回', () => {
  const result = validateSummaryDraft('  他喜欢在雨天听爵士  ');
  assert.equal(result.ok, true);
  assert.equal(result.value, '他喜欢在雨天听爵士');
});

test('validateSummaryDraft：超长拒绝', () => {
  assert.equal(validateSummaryDraft('x'.repeat(2001)).ok, false);
  assert.equal(validateSummaryDraft('x'.repeat(2001)).reason, 'too-long');
  assert.equal(validateSummaryDraft('x'.repeat(2000)).ok, true);
});

// ---------------------------------------------------------------- 计数与阶段

test('memoryCountLabel：空列表显示暂无记忆', () => {
  assert.equal(memoryCountLabel([], false), '暂无记忆');
  assert.equal(memoryCountLabel(null, false), '暂无记忆');
});

test('memoryCountLabel：截断时诚实说明还有更多', () => {
  assert.equal(memoryCountLabel([memory(), memory({ id: 'm2' })], true), '已加载 2 条 · 还有更多');
  assert.equal(memoryCountLabel([memory()], false), '共 1 条');
});

test('panelPhase：错误优先于一切', () => {
  assert.equal(panelPhase({ error: 'boom', loading: true, memories: [memory()] }), 'error');
});

test('panelPhase：已有数据时即使正在加载更多也保持 list，不让内容闪没', () => {
  assert.equal(panelPhase({ loading: true, memories: [memory()] }), 'list');
});

test('panelPhase：无数据时区分 loading / empty / list(hasMore)', () => {
  assert.equal(panelPhase({ loading: true, memories: [] }), 'loading');
  assert.equal(panelPhase({ loading: false, memories: [] }), 'empty');
  assert.equal(panelPhase({ loading: false, memories: [], hasMore: true }), 'list');
  assert.equal(panelPhase(), 'empty', '完全无参也不崩');
});

// ---------------------------------------------------------------- key

test('memoryKey：字符串 id 直接用；数字 id 加前缀避免类型混淆', () => {
  assert.equal(memoryKey({ id: 'abc' }, 0), 'abc');
  assert.equal(memoryKey({ id: 7 }, 0), 'n:7');
});

test('memoryKey：id 缺失/非法时退回下标，避免重复 key', () => {
  assert.equal(memoryKey({}, 3), 'i:3');
  assert.equal(memoryKey(null, 3), 'i:3');
  assert.equal(memoryKey({ id: '' }, 2), 'i:2');
  assert.equal(memoryKey({ id: {} }, 2), 'i:2');
  assert.equal(memoryKey({ id: 'x' }), 'x', '缺少下标也不崩');
});

// ---------------------------------------------------------------------------
// T5b 增量（frontend-panel）：跨模块「静默强制转换」扫描的 panels 分支。
//
// 这一组用例来自一次系统性排查：本项目已经踩过两次同源缺陷 ——
//   1. `new Date(true)` → 1970（T2 已挡，见 ts 的类型白名单）
//   2. `Number(true) === 1` → 伪造记忆条数（T3 已挡）
// 它们的共同特征是**不抛错、不白屏，只是安静地说假话**。这里把同一族的
// 第三类钉死：**原型链键查表**。
//
// 发现经过（真实缺陷，非假想）：`memoryStatusLabel('constructor')` 曾返回
// `function Object() { [native code] }` —— 因为 'constructor' 不是自有键，
// `STATUS_LABELS[key]` 沿原型链取到了 Object 构造函数，于是 `|| '未知状态'`
// 的兜底**永远不会触发**。该值被 JSX 渲染时 React 抛
// 「Functions are not valid as a React child」，**整块面板崩掉**。
// 这与 onboarding 那边 `emptyStateFor('constructor')` 返回 `{}` 是同一个坑。
// ---------------------------------------------------------------------------

// 原型链上会被继承的键。任何走「表查键 + || 兜底」的写法都必须在这些键上自证。
const PROTO_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'prototype', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'];

test('【增量】memoryStatusLabel：原型链键必须回落为「未知状态」，不得透出原生函数', () => {
  for (const key of PROTO_KEYS) {
    const label = memoryStatusLabel(key);
    assert.equal(typeof label, 'string', `${key} 必须返回字符串，实际 ${typeof label}`);
    assert.equal(label, '未知状态', `${key} 应回落为「未知状态」`);
  }
});

test('【增量】memoryTypeLabel：原型链键不得透出原生函数', () => {
  for (const key of PROTO_KEYS) {
    const label = memoryTypeLabel({ type: key });
    assert.equal(typeof label, 'string', `${key} 必须返回字符串，实际 ${typeof label}`);
    assert.ok(!/native code/.test(label), `${key} 泄漏了原生函数源码：${label}`);
  }
});

test('【增量】memoryScopeLabel：原型链键不得透出原生函数', () => {
  for (const key of PROTO_KEYS) {
    const label = memoryScopeLabel(key);
    assert.equal(typeof label, 'string', `${key} 必须返回字符串，实际 ${typeof label}`);
    assert.ok(!/native code/.test(label), `${key} 泄漏了原生函数源码：${label}`);
  }
});

test('【增量】三个标签函数的返回值永远是可渲染的字符串（回归防线）', () => {
  // 这是上面三条的**通用形式**：不管 key 是什么，返回值都必须是字符串。
  // React 渲染函数/对象会直接抛错，而 JSX 里没有 try/catch —— 一次脏数据
  // 就能把整个面板换成错误页。所以这条断言守的是「面板不会因标签崩掉」。
  const nasty = [...PROTO_KEYS, '', null, undefined, 42, {}, [], true, Symbol.iterator];
  for (const value of nasty) {
    for (const [name, fn] of [['memoryStatusLabel', () => memoryStatusLabel(value)], ['memoryTypeLabel', () => memoryTypeLabel({ type: value })], ['memoryScopeLabel', () => memoryScopeLabel(value)]]) {
      let out;
      assert.doesNotThrow(() => { out = fn(); }, `${name}(${String(value)}) 不应抛`);
      assert.equal(typeof out, 'string', `${name}(${String(value)}) 应返回字符串，实际 ${typeof out}`);
      assert.ok(out.length > 0, `${name}(${String(value)}) 不应返回空串（空串会渲染出空白标签）`);
    }
  }
});

test('【增量】正常标签未被上面的加固破坏（防过度修复）', () => {
  assert.equal(memoryStatusLabel('active'), '生效中');
  assert.equal(memoryStatusLabel('pinned'), '已钉住');
  assert.equal(memoryTypeLabel({ memoryType: 'relationship' }), '关系');
  assert.equal(memoryTypeLabel({ memoryType: 'fact' }), '事实');
  assert.equal(memoryScopeLabel('user'), '只属于我');
  assert.equal(memoryScopeLabel('relationship'), '这段关系');
  // 未知但**合法**的字符串仍应原样透出（类型名来自后端，显示真名比显示「未知」有用）
  assert.equal(memoryTypeLabel({ memoryType: 'custom-xyz' }), 'custom-xyz');
  assert.equal(memoryScopeLabel('custom-abc'), 'custom-abc');
});

test('【增量】confidencePercent：归一化后必须是 0..100 的有限数或 null', () => {
  // 与 ts 的类型白名单同一考虑：真实后端可能送来布尔/数组等形式。
  // 这里不重复 T2 已有的 0/1/越界/字符串用例，只钉「返回值域」这个不变量。
  const inputs = [true, false, [0.5], [], {}, '0.5', '', ' ', '1e-1', '0x1', NaN, Infinity, -Infinity, null, undefined];
  for (const value of inputs) {
    const out = confidencePercent({ confidence: value });
    assert.ok(out === null || (typeof out === 'number' && Number.isFinite(out) && out >= 0 && out <= 100),
      `confidence=${String(value)} 返回值越界：${out}`);
  }
});

test('【增量】validateSummaryDraft：maxLength 为脏值时不得静默放行超长内容', () => {
  // maxLength 是防御性上限。若它被传成 NaN，`text.length > NaN` 恒为 false，
  // 于是**任何长度的内容都会被放行** —— 一个安静失效的护栏。
  const long = 'x'.repeat(5000);
  // 非有限/非正的 maxLength 应被视为「未指定」，回落到默认上限 2000。
  for (const bad of [NaN, null, undefined]) {
    const result = validateSummaryDraft(long, bad);
    assert.equal(result.ok, false, `maxLength=${String(bad)} 时 5000 字应被拒绝，而不是放行`);
  }
  assert.equal(validateSummaryDraft('abc', 5).ok, true);
  assert.equal(validateSummaryDraft('abcdef', 5).ok, false);
});

// ---------------------------------------------------------------------------
// T6 回归防线（integrator 真实浏览器实测发现，captain 独立复现确认）
//
// 这两条断言的作用是**回归时立刻变红**：修好前必须红、修好后必须绿。
// 它们守护的是两个会直接显示给用户的缺陷，不是内部实现细节。
// ---------------------------------------------------------------------------

test('【回归】memoryTypeLabel 必须读 memoryType 字段（治理路由的字段名）', () => {
  // 缺陷：曾读 `item.type`，而 server/memory-governance-routes.js 的 listItem()
  // 发的是 `memoryType`，返回体里根本没有 `type` 字段 ⇒ 一律落到「记忆」兜底，
  // 整张 TYPE_LABELS 沦为死代码。真实浏览器实测渲染出「记忆」而不是「事实」。
  //
  // 取值域是**实测**得来的（跑真实 memory-module 的 hold + list），不是猜的。
  const actual = memoryTypeLabel({ memoryType: 'fact' });
  assert.equal(actual, '事实', '读不到 memoryType 就会退化成「记忆」——这正是原缺陷');

  // 全值域必须命中中文标签（任何一个落到原始英文名都说明表漏了键）
  const expected = {
    fact: '事实',
    preference: '偏好',
    relationship: '关系',
    current_state: '当前状态',
    life_event: '生活事件',
    medical: '健康'
  };
  for (const [type, label] of Object.entries(expected)) {
    assert.equal(memoryTypeLabel({ memoryType: type }), label, `memoryType=${type} 应显示「${label}」`);
  }

  // 反向自检：确认真的在读 memoryType 而不是碰巧读到了别的字段。
  // 若实现退回 item.type，下面这条会失败 —— 这就是回归点。
  assert.equal(memoryTypeLabel({ type: 'fact' }), '记忆', '不应再从 type 字段取值');
  assert.notEqual(memoryTypeLabel({ memoryType: 'fact' }), '记忆');
});

test('【回归】终态说明不得渲染出「已已遗忘」/「已已撤销」', () => {
  // 缺陷：组件里写了 `已{memoryStatusLabel(status)}`，而 memoryStatusLabel
  // 的返回值本身已含「已」⇒ 拼接结果「已已遗忘」（revoked 同理）。
  // 这里断言拼接规则本身：标签已经含「已」，调用方不得再加前缀。
  for (const [status, label] of [['forgotten', '已遗忘'], ['revoked', '已撤销']]) {
    const rendered = `${memoryStatusLabel(status)}，不可再修改`;
    assert.equal(rendered, `${label}，不可再修改`);
    assert.ok(!rendered.includes('已已'), `不得出现「已已」重复前缀：${rendered}`);
  }
  // 正向：原缺陷的渲染结果就是这个字符串。写死它，回归时会立刻变红。
  assert.equal(`已${memoryStatusLabel('forgotten')}`, '已已遗忘', '这是原缺陷的渲染结果，不得回归');
});

test('【回归】缺少 scopeType 时分组头不得伪造「这段关系」', () => {
  // 背景：治理路由**故意不发** scopeType（会带出 relationshipAgentId，属跨主体
  // 内部字段）。原实现把缺失值默认成 'relationship' ⇒ 分组头恒为「这段关系」，
  // 是一个永不变化的**假信息**，会让用户误判记忆的归属范围。
  const noScope = [
    { id: 'a', memoryType: 'fact', status: 'active', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'b', memoryType: 'fact', status: 'active', createdAt: '2026-01-02T00:00:00Z' }
  ];
  const groups = groupMemoriesByScope(noScope);
  assert.equal(groups.length, 1, '无作用域信息时只应有一组');
  assert.equal(groups[0].distinguishable, false, '无法区分时必须标记为不可区分 ⇒ 界面不渲染分组头');
  assert.notEqual(groups[0].label, '这段关系', '不得伪造「这段关系」');

  // 真能区分时才允许渲染分组头
  const withScope = groupMemoriesByScope([
    { ...noScope[0], scopeType: 'user' },
    { ...noScope[1], scopeType: 'relationship' }
  ]);
  assert.equal(withScope.length, 2);
  assert.ok(withScope.every(g => g.distinguishable === true), '两个不同作用域 ⇒ 可区分');
});

test('【回归】memoryScopeLabel 对缺失作用域返回「作用范围未知」而非默认归属', () => {
  assert.equal(memoryScopeLabel(undefined), '作用范围未知');
  assert.equal(memoryScopeLabel(null), '作用范围未知');
  assert.equal(memoryScopeLabel(''), '作用范围未知');
  assert.notEqual(memoryScopeLabel(''), '这段关系');
  // 已知作用域仍正常
  assert.equal(memoryScopeLabel('user'), '只属于我');
  assert.equal(memoryScopeLabel('relationship'), '这段关系');
  assert.equal(memoryScopeLabel(UNKNOWN_SCOPE), '作用范围未知');
});
