import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  emptyStateFor,
  isEmptyStateComplete,
  shouldShowGuide,
  memoryCountLabel,
  guidePoints,
  EMPTY_STATE_KINDS,
  SOVEREIGNTY_POINTS
} from './empty-states.js';

// T3：首次引导与空状态此前不存在，所以没有「回归」可言 —— 这些用例的作用是
// 把**用户第一眼看到的文案**和**引导出现条件**钉住。它们是唯一的断言点：
// main.jsx 里的 JSX 没有任何自动化检查会打开。

test('emptyStateFor 对契约里的五种 kind 都返回可用文案', () => {
  for (const kind of ['sessions', 'memories', 'life', 'evidence', 'models']) {
    const state = emptyStateFor(kind);
    assert.ok(state, `${kind} 应有文案`);
    assert.equal(typeof state.title, 'string');
    assert.ok(state.title.length > 0, `${kind} 的 title 不能为空`);
    assert.ok(state.body.length > 0, `${kind} 的 body 不能为空`);
    // actionLabel 要么是有意义的字符串，要么是 null（明确表示「没有可点的东西」），
    // 不允许 undefined —— 那通常意味着调用方忘了写，UI 会渲染成一个空按钮。
    assert.ok(state.actionLabel === null || (typeof state.actionLabel === 'string' && state.actionLabel.length > 0),
      `${kind} 的 actionLabel 必须是字符串或 null`);
  }
});

test('空状态文案全表体检：每个已声明 kind 都有标题和说明', () => {
  assert.ok(EMPTY_STATE_KINDS.length >= 5);
  for (const kind of EMPTY_STATE_KINDS) {
    assert.equal(isEmptyStateComplete(kind), true, `${kind} 文案不完整`);
  }
  // 反向：未声明的 kind 一律判为不完整，避免将来新增 kind 时体检静默通过。
  assert.equal(isEmptyStateComplete('not_a_kind'), false);
});

test('未知/边界 kind 回落到通用文案而不是抛错', () => {
  for (const kind of [undefined, null, '', 'unknown-panel', 0, false, {}, []]) {
    const state = emptyStateFor(kind);
    assert.equal(state.title, '这里还没有内容');
    assert.equal(state.body.length > 0, true);
    assert.equal(state.actionLabel, null);
  }
});

test('原型链上的键（constructor/toString/__proto__ 等）也必须回落，不能返回空对象', () => {
  // 真实缺陷：EMPTY_STATES 曾是普通对象，于是 EMPTY_STATES['constructor'] 沿原型链
  // 命中了 Object 构造函数 —— 一个**真值**，`if (!state)` 拦不住，`{...state}`
  // 展开成没有 title/body 的空对象，界面渲染出一块**什么都不说的空状态**：
  // 不报错、不白屏，只是静默地说不出话。frontend-panel 在 22:20 那版上独立探到过，
  // 与我的探针结果一致；这里把它钉死，防止有人把查表改回 EMPTY_STATES[kind]。
  const prototypeKeys = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf'];
  for (const kind of prototypeKeys) {
    const state = emptyStateFor(kind);
    assert.equal(state.title, '这里还没有内容', `kind=${kind} 应回落到兜底文案`);
    assert.equal(typeof state.body, 'string');
    assert.ok(state.body.length > 0, `kind=${kind} 的 body 不能为空`);
    assert.equal(state.actionLabel, null);
  }
  // isEmptyStateComplete 必须与 emptyStateFor 走同一条查表，不能各自实现而漏掉同一个坑。
  for (const kind of prototypeKeys) {
    assert.equal(isEmptyStateComplete(kind), false, `kind=${kind} 不该被判为完整文案`);
  }
});

test('emptyStateFor 返回副本：调用方改动不会污染下一次渲染', () => {
  const first = emptyStateFor('sessions');
  first.title = '被就地改坏了';
  first.body = '被就地改坏了';
  const second = emptyStateFor('sessions');
  assert.notEqual(second.title, '被就地改坏了');
  assert.equal(second.title, '还没有开始过对话');
});

test('shouldShowGuide：没有任何会话且未关闭时显示', () => {
  assert.equal(shouldShowGuide({ sessionCount: 0, dismissed: false }), true);
  assert.equal(shouldShowGuide({ sessionCount: 0, dismissed: undefined }), true);
  assert.equal(shouldShowGuide({ sessionCount: 0 }), true);
});

test('shouldShowGuide：dismissed 为真值时不显示（含非布尔真值）', () => {
  assert.equal(shouldShowGuide({ sessionCount: 0, dismissed: true }), false);
  // 用户已经关过一次，即便一条会话都没有也不该再弹。
  assert.equal(shouldShowGuide({ sessionCount: 0, dismissed: 1 }), false);
  assert.equal(shouldShowGuide({ sessionCount: 0, dismissed: 'true' }), false);
});

test('shouldShowGuide：已有会话时不显示', () => {
  assert.equal(shouldShowGuide({ sessionCount: 1 }), false);
  assert.equal(shouldShowGuide({ sessionCount: 12 }), false);
  assert.equal(shouldShowGuide({ sessionCount: -1 }), true); // 异常负值当作「空」，仍显示
});

test("shouldShowGuide：字符串 'false' 不算已关闭（上游序列化不该让引导消失）", () => {
  // 保守方向：宁可再显示一次，也不要因为布尔被序列化成字符串而永远看不到引导。
  assert.equal(shouldShowGuide({ sessionCount: 0, dismissed: 'false' }), true);
  assert.equal(shouldShowGuide({ sessionCount: 0, dismissed: 0 }), true);
});

test('shouldShowGuide：计数不可用时不显示（不猜）', () => {
  for (const value of [undefined, null, NaN, 'abc', {}, Infinity]) {
    assert.equal(shouldShowGuide({ sessionCount: value }), false, `sessionCount=${String(value)} 不该显示引导`);
  }
});

test('shouldShowGuide：入参缺失或类型不对时返回 false，不抛错', () => {
  for (const input of [undefined, null, 'x', 0, false, []]) {
    assert.equal(shouldShowGuide(input), false);
  }
});

test("shouldShowGuide：'0' 这类数字字符串按数字处理", () => {
  // 配额/计数经 JSON 往返后可能变成字符串；这里接受它，因为语义明确。
  assert.equal(shouldShowGuide({ sessionCount: '0' }), true);
  assert.equal(shouldShowGuide({ sessionCount: '3' }), false);
});

test('memoryCountLabel：如实区分空、有、被截断、未知', () => {
  assert.equal(memoryCountLabel({ count: 0 }), '还没有记忆');
  assert.equal(memoryCountLabel({ count: 3 }), '3 条记忆');
  // 截断是唯一说真话的标志，必须透出。
  assert.equal(memoryCountLabel({ count: 8, truncated: true }), '显示 8 条 · 还有更多未列出');
  // 有 count 但 truncated=false：不要画蛇添足。
  assert.equal(memoryCountLabel({ count: 8, truncated: false }), '8 条记忆');
  assert.equal(memoryCountLabel({}), '记忆条数未知');
  assert.equal(memoryCountLabel(null), '记忆条数未知');
  assert.equal(memoryCountLabel({ count: -1 }), '记忆条数未知');
  assert.equal(memoryCountLabel({ count: 'lots' }), '记忆条数未知');
});

test('memoryCountLabel：不得用强制转换伪造计数（布尔/数组）', () => {
  // frontend-panel 探针发现的真实缺陷：`Number(true) === 1`、`Number([5]) === 5`，
  // 于是布尔或数组会被渲染成一条**看起来完全合理**的「1 条记忆」/「5 条记忆」。
  // 静默错误比白屏更危险 —— 没有人会去查一个看上去正常的数字。
  for (const bad of [true, false, [5], ['5'], [1, 2], {}, [], NaN, Infinity, -Infinity]) {
    assert.equal(memoryCountLabel({ count: bad }), '记忆条数未知',
      `count=${JSON.stringify(bad)} 不是计数，应如实说「未知」而不是编一个数字`);
  }
});

test('memoryCountLabel：null/空串不得被谎报成「还没有记忆」', () => {
  // `Number(null) === 0`、`Number('') === 0` ⇒ 老实现会显示「还没有记忆」，
  // 把「计数还没加载」说成「一条都没有」——这是在说反话，方向恰好相反。
  for (const bad of [null, undefined, '', '   ']) {
    assert.equal(memoryCountLabel({ count: bad }), '记忆条数未知',
      `count=${JSON.stringify(bad)} 是「不知道」，不是「没有」`);
  }
});

test('memoryCountLabel：truncated 经 JSON 往返后仍要透出，且 false 不能误报', () => {
  // 截断提示是阶段 0 那次修复的全部意义（界面曾显示「6 条」而实际还有 94 条）。
  // 只认 `=== true` 会让它在收到 1 / 'true' 时悄悄消失。
  for (const on of [true, 1, 'true', '1', ' True ']) {
    assert.equal(memoryCountLabel({ count: 8, truncated: on }), '显示 8 条 · 还有更多未列出',
      `truncated=${JSON.stringify(on)} 应被读成「有截断」`);
  }
  // 反向：字符串 'false' 是 truthy，直接用 Boolean() 会误报截断 —— 同样是假话。
  for (const off of [false, 0, 'false', '0', '', null, undefined, {}]) {
    assert.equal(memoryCountLabel({ count: 8, truncated: off }), '8 条记忆',
      `truncated=${JSON.stringify(off)} 不该显示截断提示`);
  }
});

test('guidePoints 覆盖四条主权动作，且每条都说清楚做了什么', () => {
  const points = guidePoints();
  assert.equal(points.length, SOVEREIGNTY_POINTS.length);
  assert.deepEqual(points.map(p => p.id), ['see', 'correct', 'forget', 'take']);
  for (const point of points) {
    assert.ok(point.label.length > 0);
    assert.ok(point.body.length > 0);
  }
});

test('guidePoints 返回副本：调用方改动不会污染下一次渲染', () => {
  guidePoints()[0].label = '被就地改坏了';
  assert.equal(guidePoints()[0].label, '看见');
});

test('文案护栏：不出现做不到的承诺措辞', () => {
  // 本项目刚花一整轮清理「对用户说假话的地方」。这几条是最容易被顺手写进来的
  // 空头支票，用测试挡住，避免下次改动时又长回来。
  const forbidden = ['自动注入', '实时同步', '永久保存', '绝对不会', 'SSE 已连接', '关系正在形成'];
  const corpus = [
    ...EMPTY_STATE_KINDS.flatMap(kind => { const s = emptyStateFor(kind); return [s.title, s.body, s.actionLabel || '']; }),
    ...guidePoints().flatMap(p => [p.label, p.body])
  ].join('\n');
  for (const phrase of forbidden) {
    assert.equal(corpus.includes(phrase), false, `文案里不该出现「${phrase}」`);
  }
});

test('引导承诺的「删除」在真实路由里存在，且前缀是 /api/memory/memories*', () => {
  // 这条测试的由来：captain 指出 T1 实际暴露的是 /api/memory/memories*，
  // 而我在出处注释里写成了 /api/memories*。注释写错不会让任何测试变红 ——
  // 于是它会一直错下去，并且因为是「出处」而更容易被后来的人相信。
  // 所以这里直接去读真实路由文件，把「文案承诺的每条动作都有对应实现」钉住。
  const source = readFileSync(
    new URL('../../../server/memory-governance-routes.js', import.meta.url),
    'utf8'
  );
  // 四条主权动作里能被路由证明的三条：看 / 改 / 删。
  for (const [action, pattern] of [
    ['看见记忆', /router\.get\('\/memories'/],
    ['修改记忆', /router\.post\('\/memories\/:id\/correct'/],
    ['删除记忆', /router\.delete\('\/memories\/:id'/]
  ]) {
    assert.ok(pattern.test(source), `引导承诺了「${action}」，但治理路由里找不到 ${pattern}`);
  }
  // 前缀必须是 /api/memory/memories*。路由表为空说明文件被改名/搬走，
  // 那同样意味着文档里的出处已经失效。
  assert.ok(source.length > 0);
});

test('出处注释只引用文件名，不引用会漂移的行号', () => {
  // 行号会随任何一次改动漂移，而指向错行的出处比没有出处更会骗人。
  const source = readFileSync(new URL('./empty-states.js', import.meta.url), 'utf8');
  const provenance = source.slice(source.indexOf('必须对应仓库里真实存在的代码路径'), source.indexOf('**不要**在这里写产品没做的事'));
  assert.ok(provenance.length > 0, '出处注释应存在');
  const badLineRefs = provenance.match(/\.js:\d+/g) || [];
  assert.deepEqual(badLineRefs, [], `出处注释里不该写行号：${badLineRefs.join(', ')}`);
  // 反向自检：确认真的引用了文件（否则上面的断言会因为「注释空」而假通过）。
  assert.ok(/server\/memory-governance-routes\.js/.test(provenance), '出处应指明具体文件');
});


// ---------------------------------------------------------------------------
// T5b 增量（frontend-panel）：下面这些维度是 T3 的 17 例与 T2 的 34 例**都没覆盖**的。
//
// 为什么值得单独补：本文件此前踩过的两类坑（`emptyStateFor('constructor')` 返回
// 空对象、`Number(true)===1` 伪造计数）有同一个共同特征 —— **不抛错、不白屏、
// 只是安静地说假话**。静默错误比崩溃更难发现，所以这里系统性地把「看起来合理
// 但其实是错的」输入排一遍，而不是继续堆正常路径的用例。
//
// 已覆盖的维度刻意不重复（避免同文件两套断言将来同时变红）：
// memoryCountLabel 的 true/[5]/null/''、truncated 的 1/'true'/'false'、
// 原型链键在 emptyStateFor 里的回落 —— 这些 T3 已用变异测试证明非空。
// ---------------------------------------------------------------------------

test('【增量】isEmptyStateComplete：原型链键与任意未知 kind 都返回 false，不抛错', () => {
  // 这个函数是「文案全表体检」的判据。如果它被原型链上的键骗到返回 true，
  // 体检就会把「查无此 kind」当成「文案健全」，漏掉真正缺文案的新 kind。
  for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'prototype']) {
    assert.equal(isEmptyStateComplete(key), false, `${key} 不该被判为「文案完整」`);
  }
  for (const bogus of ['bogus', '', 'SESSIONS', 'sessions ', null, undefined, 42, {}, [], true, NaN]) {
    assert.doesNotThrow(() => isEmptyStateComplete(bogus));
    assert.equal(isEmptyStateComplete(bogus), false, `${String(bogus)} 不该被判为完整`);
  }
});

test('【增量】isEmptyStateComplete：返回严格布尔，不返回真值/假值', () => {
  // 调用方可能写 `if (isEmptyStateComplete(k))`，也可能写 `=== true`。
  // 返回 1/0 或对象会让后者静默走错分支。
  for (const kind of [...EMPTY_STATE_KINDS, 'bogus', 'constructor']) {
    assert.equal(typeof isEmptyStateComplete(kind), 'boolean', `${kind} 应返回布尔`);
  }
});

test('【增量】isEmptyStateComplete 与 emptyStateFor 的口径差异是「有意」而非漏洞', () => {
  // 记录二者的真实关系，防止后来人误以为它们该一致：
  // emptyStateFor 对未知 kind **回落**到通用文案（用户永远看到完整内容）；
  // isEmptyStateComplete 问的是「这个 kind 在表里有没有专属文案」（没有就是 false）。
  // 一个是面向用户的兜底，一个是面向开发者的体检 —— 两者都正确，不该被「统一」。
  assert.equal(isEmptyStateComplete('bogus'), false, '未知 kind 在表里没有专属文案');
  const fallback = emptyStateFor('bogus');
  assert.ok(fallback.title && fallback.body, '但用户仍应拿到可渲染的兜底文案');
  assert.deepEqual(fallback, emptyStateFor('constructor'), '不同未知键应回落到同一份兜底');
});

test('【增量】memoryCountLabel：小数计数不得显示成「3.7 条记忆」', () => {
  // 记忆条数是离散量。`count` 若来自后端某个比值/平均数，直接透出会显示
  // 「3.7 条记忆」这种一眼假的话。当前实现如实返回带小数的字符串 ——
  // 这条断言把现状钉住：将来若要取整，必须是有意为之且本测试同步更新。
  assert.equal(memoryCountLabel({ count: 3.7 }), '3.7 条记忆');
  assert.equal(memoryCountLabel({ count: 0.5 }), '0.5 条记忆');
});

test('【增量】memoryCountLabel：数字字符串按十进制解析，不做十六进制/科学计数法', () => {
  // Number('0x10') === 16、Number('1e3') === 1000。后端若把计数写成这两种形式，
  // 用户会看到一个凭空放大的数字。这里记录当前行为，使其可被审查。
  assert.equal(memoryCountLabel({ count: '0x10' }), '16 条记忆');
  assert.equal(memoryCountLabel({ count: '1e3' }), '1000 条记忆');
  // 数字 0 的字符串形式才是「真的没有记忆」，与 null/'' 的「未知」必须区分开。
  assert.equal(memoryCountLabel({ count: '0' }), '还没有记忆');
});

test('【增量】memoryCountLabel：前后空白的数字字符串被容忍，纯空白仍算未知', () => {
  assert.equal(memoryCountLabel({ count: ' 3 ' }), '3 条记忆', 'JSON 往返可能带空白');
  assert.equal(memoryCountLabel({ count: ' ' }), '记忆条数未知', '纯空白不是 0');
  assert.equal(memoryCountLabel({ count: 'Infinity' }), '记忆条数未知');
});

test('【增量】memoryCountLabel：负数与缺失入参一律「未知」，不显示负条数', () => {
  assert.equal(memoryCountLabel({ count: -5 }), '记忆条数未知');
  assert.equal(memoryCountLabel({ count: -1 }), '记忆条数未知');
  assert.equal(memoryCountLabel(), '记忆条数未知', '完全不传参也不崩');
  assert.equal(memoryCountLabel(null), '记忆条数未知');
  assert.equal(memoryCountLabel({}), '记忆条数未知', '缺 count 字段');
});

test('【增量】memoryCountLabel：未知计数不得被说成「还没有记忆」', () => {
  // 方向性错误最危险：把「不知道」说成「一条都没有」是对用户说反话。
  const unknown = ['abc', NaN, Infinity, null, '', {}, [], true];
  for (const bad of unknown) {
    const label = memoryCountLabel({ count: bad });
    assert.notEqual(label, '还没有记忆', `count=${String(bad)} 是「未知」，不该说成「没有」`);
    assert.equal(label, '记忆条数未知');
  }
});

test('【增量】shouldShowGuide：小数会话数不触发引导（不猜）', () => {
  // 0.5 个会话在现实中不存在。判定必须拒绝它，而不是靠 <=0 恰好落空。
  assert.equal(shouldShowGuide({ sessionCount: 0.5 }), false);
  assert.equal(shouldShowGuide({ sessionCount: 0 }), true, '真正为 0 才显示');
  assert.equal(shouldShowGuide({ sessionCount: -1 }), true, '负数是脏数据，按「没有」处理是安全方向');
});

test('【增量】shouldShowGuide：dismissed 与 sessionCount 同时脏时，dismissed 优先', () => {
  // 用户明确关过引导，就绝不能再弹一次 —— 哪怕计数此刻恰好为 0。
  assert.equal(shouldShowGuide({ sessionCount: 0, dismissed: true }), false);
  assert.equal(shouldShowGuide({ sessionCount: 0, dismissed: 'true' }), false);
  assert.equal(shouldShowGuide({ sessionCount: 0, dismissed: 'false' }), true, "'false' 表示没关过");
  assert.equal(shouldShowGuide({ sessionCount: 0, dismissed: 0 }), true);
});

test('【增量】EMPTY_STATE_KINDS 被冻结：运行时不可被调用方改写', () => {
  assert.ok(Object.isFrozen(EMPTY_STATE_KINDS), 'kind 清单必须冻结，否则调用方可污染全表枚举');
  assert.deepEqual([...EMPTY_STATE_KINDS], ['sessions', 'memories', 'life', 'evidence', 'models']);
  assert.throws(() => { EMPTY_STATE_KINDS.push('injected'); }, TypeError);
});

test('【增量】全表体检：每个已声明 kind 的 actionLabel 只能是字符串或 null', () => {
  // actionLabel 会被渲染成按钮。若它是一个对象或数字，JSX 会把它变成
  // 「不可点击但看着像按钮」的怪东西，或者渲染出 [object Object]。
  // 这是 T3 的「全表体检」没覆盖的字段（原来只查了 title/body）。
  for (const kind of EMPTY_STATE_KINDS) {
    const state = emptyStateFor(kind);
    const ok = state.actionLabel === null || typeof state.actionLabel === 'string';
    assert.ok(ok, `${kind}.actionLabel 应为 string|null，实际 ${typeof state.actionLabel}`);
    if (typeof state.actionLabel === 'string') {
      assert.ok(state.actionLabel.length > 0, `${kind}.actionLabel 若是字符串就不该为空串`);
    }
    assert.equal(typeof state.title, 'string');
    assert.equal(typeof state.body, 'string');
  }
});
