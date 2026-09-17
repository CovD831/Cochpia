// L18 V1 调度器验收：作息窗口内的随机触发。
//
// 老板 2026-09-17 V1 口径：不做固定定时器，做「标准作息窗口内的随机时刻」。
// 因此这里要钉住的不是「在某个时刻发送」，而是：
//   1. 窗口外完全静默（连判定都不做）；
//   2. 窗口内会触发，且**发送时刻不固定**（注入 rng 可变 → 偏移可变）；
//   3. scheduler flag 默认关；
//   4. 防重入（上一轮没跑完不叠下一轮）；
//   5. 单个目标失败不拖垮整轮。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { runLifeTick, LIFE_TICK_FLAG } from './life-tick.js';
import {
  createLifeTickScheduler,
  inActiveWindow,
  nextPollDelayMs,
  localHour,
  SCHEDULER_DEFAULTS,
  LIFE_TICK_SCHEDULER_FLAG,
} from './life-tick-scheduler.js';

const SCHED_ON = { [LIFE_TICK_FLAG]: 'true', [LIFE_TICK_SCHEDULER_FLAG]: 'true' };
const SCHED_OFF = { [LIFE_TICK_FLAG]: 'true' };

function freshMemory() {
  const state = createMemoryModuleState();
  return { memory: createMemoryModule(state, async () => {}), state };
}

const agentCtx = () => ({
  tenantId: 't1', subjectUserId: 'u1', actorType: 'agent', actorId: 'agent-x', callerAgentId: 'agent-x',
});

// 构造一个本地时刻的 Date（用本地时构造，因为窗口判定用 getHours）
function localDate(hour, minute = 0) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

// --- 作息窗口判定 -----------------------------------------------------------

test('V1-W1: 标准作息窗口为 08:00–22:00，窗口内/外判定正确', () => {
  const d = SCHEDULER_DEFAULTS;
  assert.equal(d.activeFromHour, 8);
  assert.equal(d.activeToHour, 22);

  assert.equal(inActiveWindow(localDate(8, 0), d), true, '08:00 是窗口起点（含）');
  assert.equal(inActiveWindow(localDate(12, 0), d), true, '中午在窗口内');
  assert.equal(inActiveWindow(localDate(21, 59), d), true, '21:59 仍在窗口内');
  assert.equal(inActiveWindow(localDate(22, 0), d), false, '22:00 是窗口终点（不含）');
  assert.equal(inActiveWindow(localDate(23, 30), d), false, '深夜不在窗口内');
  assert.equal(inActiveWindow(localDate(3, 0), d), false, '凌晨不在窗口内');
  assert.equal(inActiveWindow(localDate(7, 59), d), false, '窗口前不在');
});

test('V1-W2: 跨夜窗口也能正确判定（为将来「夜猫子作息」留的口子不是洞）', () => {
  const nightOwl = { activeFromHour: 20, activeToHour: 4 };
  assert.equal(inActiveWindow(localDate(21, 0), nightOwl), true);
  assert.equal(inActiveWindow(localDate(2, 0), nightOwl), true);
  assert.equal(inActiveWindow(localDate(12, 0), nightOwl), false);
});

test('V1-W3: localHour 用本地时（作息是人类本地时间概念）', () => {
  assert.equal(localHour(localDate(15, 30)), 15);
});

// --- 轮询抖动：不固定时刻 ---------------------------------------------------

test('V1-P1: 轮询间隔带抖动，注入 rng 可确定化', () => {
  const base = SCHEDULER_DEFAULTS.pollIntervalMs;
  assert.equal(nextPollDelayMs(() => 0), base * 0.7, 'rng=0 → 下界');
  assert.ok(nextPollDelayMs(() => 0.999) <= base * 1.3, 'rng≈1 → 上界内');
  assert.equal(nextPollDelayMs(() => 0.5), nextPollDelayMs(() => 0.5), '同 rng 可复现');
  // 抖动的意义：两次取不同 rng 得到不同间隔 → 没有固定节律
  assert.notEqual(nextPollDelayMs(() => 0.1), nextPollDelayMs(() => 0.9));
});

test('V1-P2: 发送时刻不固定 —— 不同 rng 产生不同 scheduledOffsetMs', async () => {
  const offsets = new Set();
  for (const r of [0.0, 0.25, 0.5, 0.75, 0.99]) {
    const { memory } = freshMemory();
    const res = await runLifeTick({
      memory, context: agentCtx(), env: SCHED_ON,
      nowIso: localDate(12, 0).toISOString(), rng: () => r,
    });
    if (res.proactive && res.proactive.sent) offsets.add(res.proactive.scheduledOffsetMs);
  }
  assert.ok(offsets.size > 1, '不同 rng 必须产生不同的发送偏移（否则就是固定时刻）');
});

// --- flag 默认关 ------------------------------------------------------------

test('V1-F1: scheduler flag 未设置时 start() 不启动', () => {
  const s = createLifeTickScheduler({ getTarget: () => [], env: SCHED_OFF });
  assert.equal(s.start(), false, 'flag 关时不得启动');
  s.stop();
});

test('V1-F2: scheduler flag 关闭时 tickOnce 直接返回 scheduler_disabled', async () => {
  const s = createLifeTickScheduler({ getTarget: () => [], env: SCHED_OFF });
  const r = await s.tickOnce();
  assert.equal(r.status, 'scheduler_disabled');
  assert.equal(r.results.length, 0);
});

test('V1-F3: 两个 flag 都开时 start() 成功且幂等', () => {
  const s = createLifeTickScheduler({ getTarget: () => [], env: SCHED_ON, setTimer: () => 1, clearTimer: () => {} });
  assert.equal(s.start(), true);
  assert.equal(s.start(), true, '重复 start 不得叠加定时器');
  s.stop();
});

// --- 窗口外静默 -------------------------------------------------------------

test('V1-S1: 窗口外 tickOnce 不产生任何结果（连判定都不做）', async () => {
  const { memory, state } = freshMemory();
  const s = createLifeTickScheduler({
    getTarget: () => [{ memory, context: agentCtx() }],
    env: SCHED_ON,
    now: () => localDate(3, 0), // 凌晨
  });
  const r = await s.tickOnce();
  assert.equal(r.status, 'outside_active_window');
  assert.equal(r.results.length, 0);
  assert.equal(state.assertions.length, 0, '窗口外不得写入任何记忆');
  s.stop();
});

test('V1-S2: 窗口内 tickOnce 会真的写入生活事件', async () => {
  const { memory, state } = freshMemory();
  const s = createLifeTickScheduler({
    getTarget: () => [{ memory, context: agentCtx() }],
    env: SCHED_ON,
    now: () => localDate(12, 0), // 正午
  });
  const r = await s.tickOnce();
  assert.equal(r.status, 'ran');
  assert.equal(r.results.length, 1);
  assert.equal(state.assertions.length, 1, '窗口内应写入生活事件');
  assert.equal(state.assertions[0].scopeType, 'life');
  s.stop();
});

test('V1-S3: force=true 可越过窗口（供手动补跑），但仍受治理闸', async () => {
  const { memory, state } = freshMemory();
  const s = createLifeTickScheduler({
    getTarget: () => [{ memory, context: agentCtx() }],
    env: SCHED_ON,
    now: () => localDate(3, 0), // 凌晨
  });
  const r = await s.tickOnce({ force: true });
  assert.equal(r.status, 'ran', 'force 应越过窗口判定');
  assert.equal(state.assertions.length, 1);
  s.stop();
});

// --- 防重入与失败隔离 -------------------------------------------------------

test('V1-R1: 每个目标失败不拖垮整轮（其余目标照常 tick）', async () => {
  const good = freshMemory();
  const bad = freshMemory();
  const s = createLifeTickScheduler({
    getTarget: () => [
      { memory: { hold: () => { throw new Error('boom'); }, list: () => [], state: null }, context: agentCtx() },
      { memory: good.memory, context: agentCtx() },
    ],
    env: SCHED_ON,
    now: () => localDate(12, 0),
  });
  const r = await s.tickOnce();
  assert.equal(r.status, 'ran');
  assert.equal(r.results.length, 2, '两个目标都要有结果');
  assert.equal(r.results[0].result.status, 'error', '坏目标应记为 error');
  assert.equal(good.state.assertions.length, 1, '好目标仍应正常 tick');
  s.stop();
});

test('V1-R2: 缺 memory/context 的目标被跳过而非报错', async () => {
  const good = freshMemory();
  const s = createLifeTickScheduler({
    getTarget: () => [null, {}, { memory: good.memory }, { context: agentCtx() }, { memory: good.memory, context: agentCtx() }],
    env: SCHED_ON,
    now: () => localDate(12, 0),
  });
  const r = await s.tickOnce();
  assert.equal(r.results.length, 1, '只有完整的目标被执行');
  s.stop();
});

test('V1-R3: onResult 回调收到每个目标的结果（可观测性）', async () => {
  const { memory } = freshMemory();
  const seen = [];
  const s = createLifeTickScheduler({
    getTarget: () => [{ memory, context: agentCtx() }],
    env: SCHED_ON,
    now: () => localDate(12, 0),
    onResult: e => seen.push(e),
  });
  await s.tickOnce();
  assert.equal(seen.length, 1);
  assert.ok(seen[0].result.lifeEventId, '回调应能拿到写入的 life 事件 id');
  s.stop();
});

test('V1-R4: getTarget 每次轮询重新取（新会话自动纳入，无需重启）', async () => {
  const { memory } = freshMemory();
  let include = false;
  const s = createLifeTickScheduler({
    getTarget: () => (include ? [{ memory, context: agentCtx() }] : []),
    env: SCHED_ON,
    now: () => localDate(12, 0),
  });
  const before = await s.tickOnce();
  assert.equal(before.results.length, 0);
  include = true;
  const after = await s.tickOnce();
  assert.equal(after.results.length, 1, '新目标应在下一轮被纳入');
  s.stop();
});

// --- 与治理闸的组合（调度器不是绕过闸的后门）--------------------------------

test('V1-G1: 窗口内连续轮询仍受每日预算与间隔闸约束', async () => {
  const { memory, state } = freshMemory();
  const s = createLifeTickScheduler({
    getTarget: () => [{ memory, context: agentCtx() }],
    env: SCHED_ON,
    // 用真实「现在」：间隔闸比较的是判定时刻与写入时刻（写入用真实时钟），
    // 用一个假的过去/未来时刻会让 sinceLast 变成无意义的大数，测不出闸。
    now: () => new Date(),
  });
  // 连跑 3 轮：生活事件应写 3 条，但 proactive 只有首次发出（间隔闸生效）。
  // force 用于绕过「测试在凌晨跑就落到窗口外」的不确定性——本用例测的是治理闸
  // 与调度器的组合，不是窗口判定（窗口判定另有 V1-W*/V1-S* 覆盖）。
  const r1 = await s.tickOnce({ force: true });
  const r2 = await s.tickOnce({ force: true });
  const r3 = await s.tickOnce({ force: true });
  assert.equal(r1.results[0].result.proactive.sent, true, '首次发出');
  assert.equal(r2.results[0].result.proactive.sent, false, '间隔未满不发');
  assert.equal(r3.results[0].result.proactive.sent, false, '仍不发');
  assert.equal(state.assertions.length, 3, '生活事件照常写（内在活动 ≠ 主动打扰）');
  s.stop();
});
