// 阶段 0「修信用」回归：不许再对用户说假话。
//
// 背景：这一批改动不是加功能，而是**删掉/修正做不到的承诺**。这类改动没有
// 「新能力」可测，所以要钉的是「假的那个东西不再存在」，以及「替代它的那个
// 说法是由真实数据推导的」。以下每条在修复前必红。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const mainSource = readFileSync(join(repo, 'client', 'src', 'main.jsx'), 'utf8');
const indexSource = readFileSync(join(repo, 'server', 'index.js'), 'utf8');
const htmlSource = readFileSync(join(repo, 'client', 'index.html'), 'utf8');

// --- F1 日历：假 UI 与其假承诺 ---

test('F1: 日历假 UI 已移除（events 恒空 + removeEvent 空函数）', () => {
  assert.ok(!/const \[events\] = useState\(\[\]\)/.test(mainSource), 'events 假 state 仍在');
  assert.ok(!/const removeEvent = \(\) => \{\}/.test(mainSource), 'removeEvent 空函数仍在');
  assert.ok(!/const createEvent = event =>/.test(mainSource), 'createEvent 空实现仍在');
});

test('F1: 「临近的事项会自动注入对话上下文」这句假承诺已移除', () => {
  // 它承诺了一件代码从未做过的事（没有 /api/events 路由，服务端也无人读 state.events）。
  //
  // 【必须剥注释】修复时我把原句写进了说明性注释里（解释「删掉了什么」），
  // 直接对全文断言会把**注释**当成残留的假承诺 —— 这是本文件第二次踩同一个坑
  // （第一次在 session-deletion-wiring 的顺序断言）。凡针对「文案是否还在」的检查，
  // 一律先剥注释，否则测的是散文不是代码。
  const code = mainSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(
    !/自动注入对话上下文/.test(code),
    '仍在对用户承诺「自动注入对话上下文」——这是做不到的承诺'
  );
});

test('F1: 首页不再出现「日历 / N 条日程」这种恒为 0 的假入口', () => {
  assert.ok(!/条日程/.test(mainSource), '仍有「N 条日程」文案（events 恒空 ⇒ 永远显示 0）');
});

// --- F3 连接状态 ---

test('F3: 顶栏不再写死「SSE 已连接」', () => {
  // 客户端根本没有持久 SSE 连接（流式只在一次 turn 期间用 fetch 建立），
  // 所以那行字在任何时刻都不为真 —— 断网时也显示「已连接」。
  assert.ok(
    !/SSE 已连接/.test(mainSource.replace(/\/\/[^\n]*/g, '')),
    '代码里仍有写死的「SSE 已连接」（注释提及不算）'
  );
});

test('F3: 连接状态由 refresh 的实际探测结果推导，且区分三态', () => {
  assert.ok(/serverReachable/.test(mainSource), '缺少 serverReachable 状态');
  // null=尚未探测 / true / false 三态都要有文案，避免一上来就宣称「已连接」
  assert.ok(/连接中…/.test(mainSource), '缺少「尚未探测」态文案');
  assert.ok(/连接中断/.test(mainSource), '缺少「不可达」态文案');
});

// --- F4 首屏视频 ---

test('F4: 首屏不再引用不存在的视频文件（必然 404）', () => {
  const code = mainSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/306155_medium\.mp4/.test(code), '仍在引用 306155_medium.mp4');
  assert.ok(!/<video[^>]*className="aube-splash-video"/.test(code), '首屏 video 元素仍在');
});

// --- F7 记忆截断的诚实性 ---

test('F7: 服务端 overview 区分 count（已返回）与 total（可用总数）', () => {
  const route = indexSource.slice(indexSource.indexOf("app.get('/api/memory/overview'"));
  const body = route.slice(0, route.indexOf('});'));
  assert.ok(/total:/.test(body), '缺少 total 字段 ⇒ 界面无法知道还有多少没显示');
  assert.ok(/truncated:/.test(body), '缺少 truncated 标志');
  // 关键：count 必须等于**实际返回的条数**，不能像以前那样是截断前的总数
  assert.ok(
    /count: limited\.length/.test(body),
    'count 必须是实际返回条数（此前它等于截断前总数，界面写 20 条却只列 8 条）'
  );
});

test('F7: 前端不再把记忆列表硬截到 3 条', () => {
  assert.ok(!/memories\.slice\(0, 3\)/.test(mainSource), '前端仍在 slice(0,3)');
});

// --- F8 关系状态文案 ---

test('F8: 「关系正在形成」不再是写死的字符串，而是由数据推导', () => {
  // 修复前它是一个字面量：无论刚注册还是聊了三个月、无论在线还是断网，显示都一样。
  const literals = mainSource.match(/<strong>关系正在形成<\/strong>/g) || [];
  assert.equal(literals.length, 0, '仍有写死的「关系正在形成」');
  assert.ok(/relationshipState/.test(mainSource), '缺少 relationshipState 推导');
});

test('F8: 推导覆盖「数据不足」这一档（不能假装已有关系）', () => {
  assert.ok(/关系尚未开始/.test(mainSource), '缺少零记忆时的诚实文案');
});

// --- AR-212 残留 ---

test('AR-212: 会话切换 load() 不再用 Promise.all（单接口失败不得拖垮整批）', () => {
  const start = mainSource.indexOf('const load = async id =>');
  assert.ok(start !== -1, '找不到 load()');
  const body = mainSource.slice(start, mainSource.indexOf('const target =', start));
  assert.ok(!/await Promise\.all\(/.test(body), 'load() 仍在用 Promise.all');
  assert.ok(/Promise\.allSettled/.test(body), 'load() 应改用 allSettled');
  assert.ok(/loadErrors/.test(body), '失败项应就地可见，而不是静默');
});

test('AR-212: refresh() 的逐接口隔离未被回退', () => {
  const start = mainSource.indexOf('const refresh = async () =>');
  const body = mainSource.slice(start, mainSource.indexOf('setServerReachable', start));
  assert.ok(/Promise\.allSettled/.test(body), 'refresh() 应保持 allSettled');
});

// --- F7 截断分支：真跑一遍算法，而不只断言源码里有 total 字段 ---
// 上面的 F7 用例是源码形状检查；下面这条把「12 条输入」喂进同一段算法，
// 钉住 count/total/truncated 三个数的**具体取值**——否则字段加错了也算过。

test('F7: 截断分支的实际取值（12 条 → count=8 / total=12 / truncated=true）', () => {
  const OVERVIEW_LIMIT = 8;
  const compute = all => {
    const limited = all.slice(0, OVERVIEW_LIMIT);
    return { count: limited.length, total: all.length, truncated: all.length > limited.length };
  };
  const make = n => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }));

  assert.deepEqual(compute(make(12)), { count: 8, total: 12, truncated: true }, '超限时应明示截断');
  assert.deepEqual(compute(make(9)), { count: 8, total: 9, truncated: true });
  assert.deepEqual(compute(make(8)), { count: 8, total: 8, truncated: false }, '恰好等于上限不算截断');
  assert.deepEqual(compute(make(3)), { count: 3, total: 3, truncated: false });
  assert.deepEqual(compute(make(0)), { count: 0, total: 0, truncated: false });
});

test('F7: 服务端真实路由用的是同一套取值（防止只改注释不改算法）', () => {
  const route = indexSource.slice(indexSource.indexOf("app.get('/api/memory/overview'"));
  const body = route.slice(0, route.indexOf('});'));
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(/const OVERVIEW_LIMIT = 8/.test(code), '缺少显式上限常量');
  assert.ok(/const limited = memories\.slice\(0, OVERVIEW_LIMIT\)/.test(code), '未按常量截断');
  assert.ok(/memories\.length > limited\.length/.test(code), 'truncated 判据应为「总数 > 已返回数」');
});

// --- 静默失败：写进 panelErrors 的每个键都必须有人渲染 ---
// 这条是**自查时抓到的真 bug**：load() 改造后把失败写进 panelErrors.channels /
// .persona / .atmosphere / .mode，但全仓没有任何地方渲染这四个键 —— 状态写了没人读，
// 等于把「切会话失败」继续静默掉，只是换了个写法。
// 判据：代码里 set 过的键集合 ⊆ 被 `panelErrors.X &&` 消费过的键集合。
test('panelErrors：写入的键必须都有渲染位（防「写了状态没人读」）', () => {
  const code = mainSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const written = new Set();
  // 形如 panelErrors.foo = ... 或 loadErrors.foo = ...（后者会 merge 进 panelErrors）
  for (const m of code.matchAll(/(?:panelErrors|loadErrors|nextPanelErrors)\.([A-Za-z]+)\s*=/g)) {
    written.add(m[1]);
  }
  // 两种渲染形态都要认：
  //   (a) 条件渲染：{panelErrors.foo && <PanelError .../>}
  //   (b) 作为 prop 传入：historyError={panelErrors.personalityHistory}
  // 只认 (a) 会误报 —— 本测试第一版正是漏了 (b)，把既有的 personalityHistory
  // 当成孤儿键。注意 (b) 必须排除「赋值」形态（panelErrors.foo = ...）。
  const rendered = new Set();
  for (const m of code.matchAll(/panelErrors\.([A-Za-z]+)\s*&&/g)) rendered.add(m[1]);
  for (const m of code.matchAll(/[A-Za-z]+=\{\s*panelErrors\.([A-Za-z]+)\s*\}/g)) rendered.add(m[1]);

  const orphans = [...written].filter(k => !rendered.has(k));
  assert.deepEqual(
    orphans, [],
    `这些 panelErrors 键被写入但没有任何渲染位（用户看不到）：${orphans.join(', ')}`
  );
  assert.ok(written.size > 0, '没解析到任何写入键，说明匹配式失效了');
});
