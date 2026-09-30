// Companion Life Tick 调度器（R-021 / L18 V1）。
//
// 老板 2026-09-17 的 V1 决策：
//   - **不做固定定时器**，改「标准作息窗口内的随机时刻」；
//   - 生成器仍用规则模板（先不接模型）；
//   - 主动消息暂不进会话消息流，只记记忆 + 登记 mention cooldown。
//
// 设计要点：调度器**不预排未来的触发计划**，而是「每隔一个较短的轮询间隔醒来，
// 判定现在该不该发」。这样做的好处：
//   1. 无需持久化待触发计划 —— 进程重启后自然继续，不会丢也不会重放；
//   2. 「随机」体现在两个层次：这一轮醒来的时刻是抖动的，判定通过后的发送时刻
//      也再抖一次（`pickWakeOffsetMs`）—— 对观察者而言没有可预测的整点行为；
//   3. 判定逻辑（预算 / 间隔 / 窗口）全部复用 V0 的 `runLifeTick`，调度器只负责
//      「何时唤起它」，不含任何治理规则，避免规则两处漂移。
//
// 明确不做：cron / 系统定时器 / 持久化的发送队列 / 跨进程协调。
//
// 作息窗口（人类正常作息，老板口径「先做标准作息」）：
//   默认 08:00–22:00 本地时。窗口外**完全静默**——连判定都不做。

import { runLifeTick, LIFE_TICK_FLAG, LIFE_TICK_DEFAULTS } from './life-tick.js';

export const LIFE_TICK_SCHEDULER_FLAG = 'MEMORY_LIFE_TICK_SCHEDULER_ENABLED';

export const SCHEDULER_DEFAULTS = Object.freeze({
  // 轮询间隔：每 10 分钟醒一次看该不该发。
  // 不能太大（会错过窗口内的随机性），也不能太小（无谓唤醒）。
  pollIntervalMs: 10 * 60 * 1000,
  // 每轮醒来后再抖动 ±30% —— 避免「整点醒、整点发」的机械节律被观察到。
  pollJitterRatio: 0.3,
  // 作息窗口（本地时）：标准作息先做 08:00–22:00。
  activeFromHour: 8,
  activeToHour: 22,
});

function isSchedulerEnabled(env) {
  return String((env || process.env)[LIFE_TICK_SCHEDULER_FLAG] || '').toLowerCase() === 'true';
}

// 本地小时（用 getHours() 而非 UTC —— 作息是人类本地时间概念）。
export function localHour(date) {
  return new Date(date).getHours();
}

// 是否落在作息窗口内。窗口允许跨夜（from > to 时按跨夜处理），
// 虽然标准作息用不到，但避免将来改「夜猫子作息」时静默出洞。
export function inActiveWindow(date, defaults = SCHEDULER_DEFAULTS) {
  const hour = localHour(date);
  const { activeFromHour: from, activeToHour: to } = defaults;
  if (from === to) return true;
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to; // 跨夜窗口
}

// 本轮该等多久再醒。注入 rng 以便测试确定化。
export function nextPollDelayMs(rng = Math.random, defaults = SCHEDULER_DEFAULTS) {
  const base = defaults.pollIntervalMs;
  const jitter = base * defaults.pollJitterRatio;
  // 抖动区间 [base - jitter, base + jitter)
  return Math.max(1000, Math.round(base - jitter + rng() * jitter * 2));
}

/**
 * 创建一个 life tick 调度器。
 *
 * 依赖由调用方注入，调度器本身不直接接触 server / state：
 *   - `getTarget()`：返回本次要 tick 的目标数组，每项 { memory, context }。
 *     每次轮询都重新取 —— 这样新建的会话/agent 会被自动纳入，无需重启。
 *   - `runTick`：可选的执行函数覆盖（测试用；默认 runLifeTick）。
 *   - `now()` / `rng()`：时钟与随机源（测试注入）。
 *   - `onResult(entry)`：观察回调（日志/测试断言用）。
 */
export function createLifeTickScheduler({
  getTarget,
  env = process.env,
  now = () => new Date(),
  rng = Math.random,
  defaults = SCHEDULER_DEFAULTS,
  tickDefaults = LIFE_TICK_DEFAULTS,
  runTick = runLifeTick,
  onResult = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  // 可选：模型 provider（V1.5 生活事件用模型生成）。透传给 runLifeTick，
  // 由 runLifeTick 按 MEMORY_LIFE_TICK_MODEL_ENABLED 决定用不用、失败是否降级。
  model = null,
  getPersonality = null,
} = {}) {
  if (typeof getTarget !== 'function') throw new TypeError('createLifeTickScheduler requires getTarget');

  let timer = null;
  let stopped = false;
  let ticking = false; // 防重入：上一轮还在跑就不叠下一轮
  // 可观测状态（2026-09-30 补）：调度器此前在窗口外/flag 关时**静默提前返回**，
  // 于是「窗口外安静」与「调度器已死」在日志上完全不可区分。对一个需要长期
  // 无人值守运行的机制，这是安全缺口 —— 坏了没人知道。这里记录最后几次判定的
  // 结果与时间，供 /api/health 与低频日志消费。
  let lastEvaluatedAt = null;   // 最近一次「醒来的判定」时刻（含被跳过的）
  let lastStatus = null;        // 该次判定的 status（ran / outside_active_window / scheduler_disabled）
  let lastRanAt = null;         // 最近一次真正跑过 target 的时刻
  let lastTickCount = 0;        // 最近一次真正跑过的 target 数
  const startedAt = new Date(now()).toISOString();

  // 低频率地记录「醒来了但没跑」的判定：只在状态发生变化时写一条，避免
  // 每 10 分钟一条把日志刷满（窗口外每天约 84 次判定）。
  const noteEvaluation = (at, status) => {
    lastEvaluatedAt = at.toISOString();
    const changed = status !== lastStatus;
    lastStatus = status;
    return changed;
  };

  // 跑一轮「判定 + 可能的 tick」。返回本轮的结果数组（供测试观察）。
  const tickOnce = async ({ force = false } = {}) => {
    const at = now();
    if (!isSchedulerEnabled(env)) {
      // 状态变化时才记一条（否则每轮都刷）。这是「调度器没在跑」的唯一可见信号。
      if (noteEvaluation(at, 'scheduler_disabled')) console.log(JSON.stringify({ event: 'life_tick_scheduler_idle', at: lastEvaluatedAt, reason: 'scheduler_disabled' }));
      return { status: 'scheduler_disabled', results: [] };
    }
    if (!force && !inActiveWindow(at, defaults)) {
      const hour = localHour(at);
      if (noteEvaluation(at, 'outside_active_window')) console.log(JSON.stringify({ event: 'life_tick_scheduler_idle', at: lastEvaluatedAt, reason: 'outside_active_window', hour }));
      return { status: 'outside_active_window', hour, results: [] };
    }
    noteEvaluation(at, 'ran');

    const targets = await getTarget();
    const results = [];
    for (const target of targets || []) {
      if (!target || !target.memory || !target.context) continue;
      try {
        // getPersonality 每轮重取：人格投影会随对话演化，不该冻结在启动时刻。
        const personality = typeof getPersonality === 'function' ? getPersonality() : null;
        const result = await runTick({ memory: target.memory, context: target.context, env, nowIso: new Date(at).toISOString(), rng, defaults: tickDefaults, model, personality });
        results.push({ target, result });
        onResult({ target, result, at: at.toISOString() });
      } catch (error) {
        // 单个目标的失败不能拖垮整轮 —— 记下来继续
        const failure = { status: 'error', code: error && error.code, message: error && error.message };
        results.push({ target, result: failure });
        onResult({ target, result: failure, at: at.toISOString() });
      }
    }
    lastRanAt = at.toISOString();
    lastTickCount = results.length;
    return { status: 'ran', hour: localHour(at), results };
  };

  const scheduleNext = () => {
    if (stopped) return;
    const delay = nextPollDelayMs(rng, defaults);
    timer = setTimer(async () => {
      if (stopped) return;
      if (!ticking) {
        ticking = true;
        try { await tickOnce(); } finally { ticking = false; }
      }
      scheduleNext();
    }, delay);
    // 调度器不应阻止进程退出（Node 行为）
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  return {
    // 启动轮询。返回是否真的启动了（flag 关时不启动）。
    start() {
      if (stopped) return false;
      if (!isSchedulerEnabled(env)) return false;
      if (timer) return true; // 幂等：重复 start 不叠加
      scheduleNext();
      return true;
    },
    stop() {
      stopped = true;
      if (timer) { clearTimer(timer); timer = null; }
    },
    // 手动跑一轮（测试 / 补跑用）
    tickOnce,
    inActiveWindow: date => inActiveWindow(date || now(), defaults),
    // 可观测快照（2026-09-30 补）。用途：/api/health 暴露它，运维就能回答
    // 「调度器还活着吗、为什么没动静」——此前这个问题在日志与接口上都无解。
    // `stalled` 的判据刻意保守：只有「已启动且当前在窗口内，却从未跑过」才为真，
    // 避免把「正常地处于窗口外」误报成故障。
    status() {
      const nowDate = now();
      const running = Boolean(timer) && !stopped;
      const inWindow = inActiveWindow(nowDate, defaults);
      const enabled = isSchedulerEnabled(env);
      return {
        enabled,
        running,
        startedAt,
        inWindow,
        lastEvaluatedAt,
        lastStatus,
        lastRanAt,
        lastTickCount,
        stalled: enabled && running && inWindow && !lastRanAt,
      };
    },
  };
}
