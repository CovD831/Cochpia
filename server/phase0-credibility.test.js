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
const s_readApi = () => readFileSync(join(repo, 'client', 'src', 'api.js'), 'utf8');

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

test('F7: 服务端 overview 的截断标志取自上游 bundle（第一版修错了地方）', () => {
  const route = indexSource.slice(indexSource.indexOf("app.get('/api/memory/overview'"));
  const body = route.slice(0, route.indexOf('});'));
  // 第一版只在本层 slice(0,8) 并据此算 truncated —— 实测上游产出恒 ≤6，
  // 于是 truncated 结构性恒为 false、唯一说真话的 bundle.truncated 被丢弃。
  // 现在必须**同时**认上游标志。
  assert.ok(
    /bundle\?\.truncated/.test(body),
    '截断标志必须取自上游 bundle.truncated —— 只靠本层 slice 判断会恒为 false'
  );
  assert.ok(
    /count: limited\.length/.test(body),
    'count 必须等于实际返回条数'
  );
  // 不应再提供已废弃的 total（第一版的产物）
  assert.ok(!/total:/.test(body), 'total 已废弃（它曾是「上游已裁剪后的条数」，具误导性）');
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

// 【行为层，替换掉第一版的自证测试】
// 第一版把路由算法在测试里**重抄了一遍**再断言副本 —— 审计指出它验证的是
// 「我手抄的这段逻辑自洽」，而非真实路由，因此对 F7 这类缺陷零判别力。
// 现在直接驱动**真实模块**：createMemoryModule + createChatMemoryAdapter，
// 用真实 contextBundle 的 token 预算裁剪产出，再套用真实路由的取值方式。
// 这条能抓到「truncated 恒为 false」这个真实缺陷（审计 P0-1）。
test('F7（行为层）: 真实截断必须被标记——不能因为上游裁剪就不告诉用户', async () => {
  const { createMemoryModule, createMemoryModuleState } = await import('./memory-module.js');
  const { createChatMemoryAdapter } = await import('./chat-memory.js');

  const runFor = async N => {
    const state = createMemoryModuleState();
    const memory = createMemoryModule(state, async () => {});
    const actx = { tenantId: 't1', subjectUserId: 'u1', actorType: 'agent', actorId: 'a1', callerAgentId: 'a1' };
    for (let i = 0; i < N; i += 1) {
      await memory.hold(actx, { content: `共同记忆 ${i}`, memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'relationship', relationshipAgentId: 'a1', sensitivity: 'S0' });
    }
    const uctx = { tenantId: 't1', subjectUserId: 'u1', actorType: 'user', actorId: 'u1', callerAgentId: null };
    const adapter = createChatMemoryAdapter({ memoryModule: memory, state: { memoryModule: state }, context: uctx });
    const { memories, bundle } = await adapter.overview();
    const LIMIT = 8;
    const limited = memories.slice(0, LIMIT);
    return {
      realTruncated: Boolean(bundle?.truncated),
      payloadTruncated: Boolean(bundle?.truncated) || memories.length > limited.length,
      count: limited.length
    };
  };

  // 少量记忆：不截断，且不得谎报截断
  const few = await runFor(3);
  assert.equal(few.realTruncated, false, '3 条不该触发截断');
  assert.equal(few.payloadTruncated, false, '3 条不该谎报截断');

  // 大量记忆：上游 token 预算会裁剪，必须如实标记
  const many = await runFor(120);
  assert.equal(many.realTruncated, true, '120 条时上游应已裁剪（bundle.truncated=true）');
  assert.equal(
    many.payloadTruncated, true,
    '真实的截断必须被标记：不能因为「上游已经裁好」就不告诉用户'
  );
  assert.ok(
    many.count < 120,
    `返回条数应远小于实有数（实得 ${many.count}），这正是需要标记截断的原因`
  );
});

test('F7（characterization）: 路由源码形状——截断标志取自上游 bundle', () => {
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

// --- 计数类 UI：接口失败时不得静默显示 0 ---
// 这一类 bug 在本阶段出现了两次：
//   ① load() 把失败写进 panelErrors 却没人渲染（已修，见上一条护栏）；
//   ② 首页「它的近况」卡片直接显示 lifeEvents.length —— Life API 失败时
//      长度是 0，看起来就像「它真的没有生活记录」，用户无从分辨。
// 判据：凡是渲染「N 条/个」这类计数的卡片，若其数据源有对应的 panelErrors.X，
// 就必须在该接口失败时给出不同文案。
test('计数卡片：数据源失败时不得静默显示 0', () => {
  const code = mainSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const homeStart = code.indexOf("{page === 'home' &&");
  assert.ok(homeStart !== -1, '找不到首页段');
  const home = code.slice(homeStart, code.indexOf("{page === 'life' &&", homeStart));
  assert.ok(/lifeEvents\.length/.test(home), '首页卡片应显示生活记录数（前提）');
  assert.ok(
    /panelErrors\.life\s*\?/.test(home),
    '首页卡片必须区分「接口失败」与「真的 0 条」——否则失败时静默显示 0'
  );
  assert.ok(/暂不可用/.test(home), '缺少失败态文案');
});

// --- P0-2 回归：SW 缓存不得让「已连接」变成假话 ---
// 审计实测：杀掉后端、浏览器仍在线时，SW 的 cache-fallback 会回一份缓存的 200，
// 9 路探测全部 fulfilled ⇒ 顶栏仍显示「已连接」。修复分三处，缺一不可：
//   ① sw.js 给回退响应打标记；② api.js 识别该标记；③ refresh 把「来自缓存」计为不可达。
test('P0-2: SW 的 /api/ 回退响应必须带缓存标记（否则与真实响应无法区分）', () => {
  const sw = readFileSync(join(repo, 'client', 'public', 'sw.js'), 'utf8');
  const api = s_readApi();
  assert.ok(
    /X-Cochpia-From-Cache/.test(sw),
    'sw.js 的 cache-fallback 必须打标记 —— 否则后端已死时前端无法分辨，会谎报「已连接」'
  );
  assert.ok(
    /FROM_CACHE_HEADER|x-cochpia-from-cache/i.test(api),
    'api.js 必须识别该标记'
  );
  assert.ok(
    /__fromCache/.test(api),
    'api.js 应把它转成调用方可判定的信号'
  );
  assert.ok(
    /__fromCache/.test(mainSource),
    'refresh 的可达性推导必须把「来自缓存」计为不可达'
  );
});

test('P0-2: 可达性判据不得只用「有 fulfilled 就算连接」（会被缓存击穿）', () => {
  const start = mainSource.indexOf('const anyReal');
  assert.ok(start !== -1, '找不到 anyReal 判据');
  const body = mainSource.slice(start, start + 260);
  assert.ok(/\.some\(/.test(body) || /values\.some/.test(body), '应逐路筛掉缓存响应');
  assert.ok(!/setServerReachable\(allResults\.some\(/.test(mainSource),
    '不能退回「allResults.some(fulfilled)」——那正是被 SW 缓存击穿的写法');
});

// --- P0-2 的最终修法：必须有**主动**探活 ---
// 审计指出 SW 缓存让启动快照说谎；我进一步实测发现更根本的问题：
// 后端死后**根本不会再有 api() 调用**（点「新的相遇」只触发 /api/preferences，
// 且它命中缓存），所以纯被动监听永远等不到信号、顶栏停在旧值。
// 实测证据：只有加入 30s 主动探活后，顶栏才在 ~28s 变为「连接中断」。
test('P0-2: 必须存在主动探活（被动上报在后端死后收不到任何信号）', () => {
  const api = s_readApi();
  assert.ok(/startReachabilityProbe/.test(api), 'api.js 必须提供主动探活');
  assert.ok(/\/api\/health/.test(api), '探活应打轻量的 /api/health，而不是业务接口');
  assert.ok(/cache:\s*'no-store'/.test(api), '探活必须绕开缓存——「缓存的答案」不能回答「后端现在答不答」');
  assert.ok(/startReachabilityProbe\(\)/.test(mainSource), 'App 必须真的启动它');
  assert.ok(/stopReachabilityProbe/.test(mainSource), '卸载时必须停掉，避免泄漏定时器');
  // 与 R-020 移除的重负载轮询划清界限：探活不得传业务数据
  const probe = api.slice(api.indexOf('const probeOnce'));
  assert.ok(!/JSON\.stringify/.test(probe.slice(0, 500)), '探活不得序列化业务数据（重蹈 R-020 轮询覆辙）');
});

test('P0-2: 缓存响应必须被当作「不可达」，而不是「不确定」', () => {
  const start = mainSource.indexOf('onReachability(state =>');
  const body = mainSource.slice(start, start + 400);
  // 第一版把 'cache' 当「不动」，结果离线后唯一还会发生的请求全命中缓存 ⇒ 永远不变
  assert.ok(
    /state === 'up'/.test(body),
    '判据应简化为「只有收到真实响应才算可达」——cache/down 都不可达'
  );
});

// --- P1-1 回归：F8 的分档阈值必须在实际可得范围内可达 ---
test('P1-1: relationshipState 的每一档都必须可达（阈值不得超过 count 上限）', () => {
  const start = mainSource.indexOf('const relationshipState = useMemo');
  const body = mainSource.slice(start, mainSource.indexOf('}, [memory.count, personality?.version]);', start));
  // overview 的返回上限 = OVERVIEW_LIMIT（8），且上游 token 裁剪后实测更小。
  // 任何 >= 9 的阈值都结构上不可达 —— 第一版用了 10，是死代码。
  const thresholds = [...body.matchAll(/memories\s*>=\s*(\d+)/g)].map(m => Number(m[1]));
  for (const t of thresholds) {
    assert.ok(t <= 8, `阈值 ${t} 超过 count 上限 8 ⇒ 该档永不渲染（死代码）`);
  }
  // 且最高档应依赖 count 之外的信号（人格版本），因为 count 本身有上限
  assert.ok(/version\s*>\s*1/.test(body), '最高档应同时要求人格已演进（count 有上限，单靠它无法区分）');
});
