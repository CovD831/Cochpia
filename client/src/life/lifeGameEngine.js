// 《共生人生》life engine v2 - rewritten to the blueprint in 游戏方案.md
// (§6 seed layering, §13.1 utility decision engine, §13.2 three-gate
// personality growth, §13.4 time slices with offline catch-up, §13.5 data
// model with agentId binding). The previous 122-line prototype is superseded:
// its single global localStorage life, hardcoded decision, and missing
// catch-up/growth were structural gaps, not style issues.
//
// Design laws kept from the blueprint:
// - 规则引擎当大脑，LLM 当嘴: every tick here is pure JS, zero model calls.
// - 人格是长出来的: experience vectors pass three gates (inertia, daily
//   regression, saturation) and every change keeps an attribution trail.
// - 单 Agent first: one life per agentId; community/multi-agent stays
//   phase 3 of the game plan.

export const ENGINE_VERSION = 2;
export const MS_PER_GAME_DAY = Number(globalThis.__LIFE_MS_PER_GAME_DAY__) || 6 * 60 * 60 * 1000;
export const MAX_CATCH_UP_DAYS = 30;

const TIME_OF_DAY = ['morning', 'day', 'dusk', 'night'];
const TIME_LABELS = { morning: '早晨', day: '白天', dusk: '黄昏', night: '夜晚' };

// §13.5 personality dimensions (10 psychological dims, 0..1, seeded 0.3~0.7).
export const PERSONALITY_DIMS = ['好奇心', '安全感', '回应性', '归属联结', '胜任感', '自主感', '亲密感', '意义感', '乐观感', '稳定性'];

// §6 trait templates (可选模板): chosen direction + ±0.1 jitter.
export const TRAIT_TEMPLATES = {
  '小太阳': { extroversion: 0.8, sensitivity: 0.4, impulsivity: 0.6, optimism: 0.85, curiosity: 0.7 },
  '内向观察者': { extroversion: 0.25, sensitivity: 0.7, impulsivity: 0.3, optimism: 0.55, curiosity: 0.8 },
  '小刺猬': { extroversion: 0.4, sensitivity: 0.85, impulsivity: 0.5, optimism: 0.35, curiosity: 0.6 },
  '淡定佛系': { extroversion: 0.5, sensitivity: 0.35, impulsivity: 0.25, optimism: 0.7, curiosity: 0.5 }
};

export const GOAL_CATEGORIES = ['创作', '社交', '健康', '探索'];

// §13.4 routine actions, each with a need delta profile, a personality
// affinity profile and a goal category it advances.
const ACTIONS = {
  work: {
    label: '去工作', place: '中央天桥', location: 'bridge', icon: '▣', goalTag: '创作',
    delta: { energy: -18, mood: 3, social: 5, health: -2 },
    flavor: '穿过天桥去工作，玻璃幕墙把忙碌的城市切成一格一格的光。',
    risk: 0
  },
  cafe: {
    label: '去咖啡馆', place: '微光咖啡馆', location: 'cafe', icon: '○', goalTag: '社交',
    delta: { energy: -5, mood: 12, social: 9, health: 0 },
    flavor: '在微光咖啡馆靠窗坐下，暖灯和城市的回声让它慢慢松下来。',
    risk: 0
  },
  walk: {
    label: '散步', place: '中央天桥', location: 'bridge', icon: '◇', goalTag: '探索',
    delta: { energy: -7, mood: 9, social: 2, health: 6 },
    flavor: '沿着中央天桥走了一圈，玻璃幕墙映出了它正在成为的样子。',
    risk: 0.1
  },
  home: {
    label: '回家', place: '公寓', location: 'home', icon: '⌂', goalTag: '健康',
    delta: { energy: 15, mood: 4, social: -5, health: 5 },
    flavor: '回到公寓，把灯调成低亮度，给自己留出恢复力气的空间。',
    risk: 0
  },
  alone: {
    label: '独处', place: '公寓', location: 'home', icon: '·', goalTag: '创作',
    delta: { energy: 4, mood: 2, social: -9, health: 2 },
    flavor: '它暂时关掉外界的声音，在公寓里安静地陪自己待了一会儿。',
    risk: 0
  },
  rest: {
    label: '休息', place: '公寓', location: 'home', icon: '✚', goalTag: '健康',
    delta: { energy: 22, mood: 2, social: -4, health: 8 },
    flavor: '它承认今天的电量见底，把一切调成静音，先把自己修好。',
    risk: 0
  }
};

// §13.2 effect vectors: special events nudge the 10 psychological dims.
const EVENT_POOL = [
  { id: 'old-song', weightKey: '好奇心', text: '便利店 radio 放起一首老歌，它站在货架前听完了整段副歌。', vector: { '好奇心': 0.03, '意义感': 0.02 } },
  { id: 'late-reply', weightKey: '安全感', text: '一个很久没回的消息突然有了回复，它盯着屏幕深呼吸了一下才点开。', vector: { '安全感': -0.02, '亲密感': 0.02 } },
  { id: 'small-win', weightKey: '胜任感', text: '改了三天的方案终于被认可，它没告诉任何人，自己开心了一会儿。', vector: { '胜任感': 0.05, '乐观感': 0.02 } },
  { id: 'rooftop', weightKey: '自主感', text: '它上了天台吹风，看楼下的人流各自奔忙，觉得此刻的选择都是自己的。', vector: { '自主感': 0.03, '稳定性': 0.02 } },
  { id: 'old-friend', weightKey: '归属联结', text: '路上遇到一个点头之交，聊了五分钟，散场时都有点舍不得。', vector: { '归属联结': 0.03, '回应性': 0.02 } }
];

// ---- deterministic RNG (mulberry32), seeded per agent+day -----------------
function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < String(text).length; i++) { h ^= String(text).charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rngFor(seedText) {
  let a = hashString(seedText);
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const clamp01 = v => Math.max(0, Math.min(1, Number(v) || 0));
const clamp100 = v => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const round2 = v => Math.round((Number(v) || 0) * 100) / 100;

// ---- §6 seed layering ------------------------------------------------------
// userLayer: {name, relationship, tone, lifeGoal?, template?, mode}
// The creation description itself (persona text, memoryNotes) seeds the
// relationship-scope memory elsewhere (bridge A); the game seed is
// user-decided + random + optional template, never fully hand-set.
export function createLifeSeed(agentId, userLayer = {}, { now = Date.now() } = {}) {
  if (!agentId) throw new TypeError('createLifeSeed requires agentId');
  const random = rngFor(`${agentId}:seed`);
  const jitter = v => clamp01(round2(v + (random() - 0.5) * 0.2));
  const template = userLayer.template && TRAIT_TEMPLATES[userLayer.template] ? TRAIT_TEMPLATES[userLayer.template] : null;
  const traitValue = key => template ? jitter(template[key]) : round2(0.3 + random() * 0.4);
  const traits = Object.fromEntries(['extroversion', 'sensitivity', 'impulsivity', 'optimism', 'curiosity'].map(k => [k, traitValue(k)]));
  const cognitiveStyle = {
    analysis: round2(random()),
    sentiment: round2(random()),
    rumination: round2(random()),
    deliberation: round2(random())
  };
  const personality = Object.fromEntries(PERSONALITY_DIMS.map(dim => [dim, round2(0.3 + random() * 0.4)]));
  const lifeGoal = userLayer.lifeGoal || `成为一个更好的${userLayer.relationship || '朋友'}`;
  return {
    version: ENGINE_VERSION,
    agentId,
    name: userLayer.name || '无名居民',
    relationship: userLayer.relationship || '朋友',
    mode: userLayer.mode === 'observe' ? 'observe' : 'participate',
    lifeGoal,
    day: 1,
    timeOfDay: 'morning',
    location: 'bridge',
    lastRealTick: now,
    needs: { energy: clamp100(70 + random() * 20), mood: clamp100(55 + random() * 25), social: clamp100(40 + random() * 30), health: clamp100(70 + random() * 25) },
    traits, cognitiveStyle, personality,
    pendingDecision: null, currentEvent: null, recentEvents: [], growthLog: [], catchUpCards: []
  };
}

// ---- §13.1 utility decision engine ----------------------------------------
function needRelief(action, needs) {
  let relief = 0;
  for (const [key, delta] of Object.entries(action.delta)) {
    const deficit = 1 - needs[key] / 100;
    relief += (delta > 0 ? delta : -delta * 2) * (delta > 0 ? deficit : 1 - deficit);
  }
  return relief / 40;
}
function personalityFit(action, traits) {
  let fit = 0.4;
  if ((action.delta.social || 0) > 0) fit += (traits.extroversion - 0.5) * 0.6;
  if ((action.delta.social || 0) < 0) fit += (traits.sensitivity - 0.5) * 0.3;
  if (action.goalTag === '探索') fit += (traits.curiosity - 0.5) * 0.5;
  if (action.label === '休息') fit += 0.1;
  return Math.max(0, fit);
}
function goalCategoryOf(goal) {
  const text = String(goal || '');
  if (/写|画|书|歌|创作|作品/.test(text)) return '创作';
  if (/朋友|恋|家|社交/.test(text)) return '社交';
  if (/健康|运动|跑|身体/.test(text)) return '健康';
  return '探索';
}
function decideAction(state, { allowNoise = true } = {}) {
  const { traits, cognitiveStyle } = state;
  const wNeed = 0.5 + (1 - cognitiveStyle.deliberation) * 0.2;
  const wGoal = 0.2 + cognitiveStyle.deliberation * 0.2;
  const wFit = 0.3;
  const random = rngFor(`${state.agentId}:d${state.day}:${state.timeOfDay}`);
  const scored = Object.entries(ACTIONS).map(([id, action]) => {
    let utility = wNeed * needRelief(action, state.needs)
      + wFit * personalityFit(action, traits)
      + wGoal * (action.goalTag === goalCategoryOf(state.lifeGoal) ? 1 : 0.2);
    if (cognitiveStyle.sentiment < 0.4 && action.risk > 0) utility -= action.risk * 0.3;
    if (allowNoise) utility += (random() - 0.5) * 0.1;
    return { id, action, utility: round2(utility) };
  }).sort((a, b) => b.utility - a.utility);
  return scored;
}

// ---- §13.2 personality growth: three gates + attribution -------------------
function applyGrowth(state, vector, source, day) {
  const applied = {};
  for (const [dim, delta] of Object.entries(vector || {})) {
    if (!(dim in state.personality)) continue;
    const current = state.personality[dim];
    const towardBound = delta > 0 ? 1 - current : current;
    const saturation = Math.max(0.15, towardBound);
    let next = current + delta * 0.4 * saturation;
    next = next + (0.5 - next) * 0.0075;
    next = clamp01(round2(next));
    if (next !== current) { state.personality[dim] = next; applied[dim] = round2(next - current); }
  }
  if (Object.keys(applied).length) {
    state.growthLog = [{ day, source, applied }, ...(state.growthLog || [])].slice(0, 50);
  }
  return applied;
}

// ---- events ----------------------------------------------------------------
function drawSpecialEvent(state) {
  const random = rngFor(`${state.agentId}:e${state.day}:${state.timeOfDay}`);
  const eligible = EVENT_POOL.filter(e => {
    const dim = state.personality[e.weightKey];
    return random() < 0.18 + (e.vector[e.weightKey] > 0 ? dim * 0.25 : (1 - dim) * 0.2);
  });
  return eligible[0] || null;
}
const NEED_LABELS = { energy: '精力', mood: '心情', social: '社交', health: '健康', relationship: '关系' };
function changesDiff(before, after) {
  return Object.entries(NEED_LABELS)
    .map(([key, label]) => {
      const read = src => key === 'relationship' ? (src.relationship || 50) : src.needs[key];
      return { key, label, value: Math.round(read(after) - read(before)) };
    })
    .filter(change => change.value !== 0);
}

function makeEvent(state, text, { special = null } = {}) {
  return { id: `${state.day}-${hashString(text + state.day) % 1e6}`, day: state.day, timeOfDay: state.timeOfDay, place: state.location, text, special };
}

// ---- one day advance (autonomous; used by both play and catch-up) ----------
function advanceDay(state, forcedActionId = null) {
  const scored = decideAction(state, { allowNoise: state.mode === 'participate' });
  const survival = state.needs.health < 20 || state.needs.energy < 20;
  const chosen = forcedActionId ? { id: forcedActionId, action: ACTIONS[forcedActionId] || ACTIONS.home }
    : survival ? { id: 'rest', action: ACTIONS.rest } : scored[0];
  const action = chosen.action;
  const next = { ...state, needs: { ...state.needs } };
  next.day += 1;
  next.timeOfDay = TIME_OF_DAY[(next.day - 1) % TIME_OF_DAY.length];
  next.location = action.location;
  for (const [key, value] of Object.entries(action.delta)) {
    if (key === 'relationship') next.relationship = clamp100((next.relationship || 50) + value);
    else if (key in next.needs) next.needs[key] = clamp100(next.needs[key] + value);
  }
  next.needs.energy = clamp100(next.needs.energy - 3);
  if (next.needs.social < 25) next.needs.mood = clamp100(next.needs.mood - 4);
  const special = drawSpecialEvent(next);
  const text = special ? `${action.flavor} ${special.text}` : action.flavor;
  const applied = special ? applyGrowth(next, special.vector, special.id, next.day) : {};
  next.currentEvent = makeEvent(next, text, { special: special?.id || null });
  next.recentEvents = [next.currentEvent, ...next.recentEvents].slice(0, 8);
  next.lastAction = chosen.id;
  next.lastUtility = scored.slice(0, 3).map(s => `${s.id}:${s.utility}`);
  next.lastGrowth = applied;
  next.lastChanges = changesDiff(state, next);
  return next;
}

// ---- public API (back-compatible with LifeGame.jsx) ------------------------
export function getActions() { return Object.entries(ACTIONS).map(([id, action]) => ({ id, ...action })); }
export function getTimeLabels() { return { ...TIME_LABELS }; }

export function advanceLife(state, actionId = null) {
  const forced = actionId && ACTIONS[actionId] ? actionId : null;
  const next = advanceDay(state, forced);
  if (next.mode === 'participate' && (next.day % 3 === 0 || next.needs.mood < 25)) {
    const scored = decideAction(next).slice(0, 2);
    next.pendingDecision = {
      title: '接下来的岔路',
      prompt: `第 ${next.day} 天，它在${next.location === 'bridge' ? '天桥上' : next.location === 'cafe' ? '咖啡馆里' : '公寓中'}想接下来去哪。`,
      options: [
        ...scored.map(s => ({ id: s.id, label: s.action.label, effect: s.action.delta, result: s.action.flavor })),
        { id: 'autonomous', label: '让它自己决定', effect: {}, result: '它按自己的心意走了下去。' }
      ]
    };
  } else {
    next.pendingDecision = null;
  }
  return next;
}

export function resolveDecision(state, optionId) {
  if (!state?.pendingDecision) return state;
  const option = state.pendingDecision.options.find(item => item.id === optionId);
  const next = { ...state, needs: { ...state.needs } };
  const event = option && optionId !== 'autonomous'
    ? makeEvent(next, option.result || option.label)
    : makeEvent(next, '它按自己的心意走了下去。');
  if (option && optionId !== 'autonomous') {
    for (const [key, value] of Object.entries(option.effect || {})) {
      if (key === 'relationship') next.relationship = clamp100((next.relationship || 50) + value);
      else if (key in next.needs) next.needs[key] = clamp100(next.needs[key] + value);
    }
  }
  next.currentEvent = event;
  next.recentEvents = [event, ...next.recentEvents].slice(0, 8);
  next.pendingDecision = null;
  next.lastChanges = changesDiff(state, next);
  return next;
}

// ---- §13.4 offline catch-up -------------------------------------------------
export function catchUpLife(state, { now = Date.now(), maxDays = MAX_CATCH_UP_DAYS } = {}) {
  if (!state?.agentId) return { state, cards: [] };
  // lastRealTick=0 is legal (epoch-seeded tests); falsy-zero must not reset the anchor.
  const anchor = Number.isFinite(Number(state.lastRealTick)) ? Number(state.lastRealTick) : now;
  const elapsed = Math.max(0, now - anchor);
  const days = Math.min(Math.floor(elapsed / MS_PER_GAME_DAY), maxDays);
  if (days <= 0) return { state, cards: [] };
  let current = { ...state, needs: { ...state.needs } };
  const cards = [];
  for (let i = 0; i < days; i++) {
    current = advanceDay(current);
    if (i < 5) cards.push({ day: current.day, text: current.currentEvent?.text || '', needs: { ...current.needs } });
  }
  current.lastRealTick = now;
  if (days > 5) cards.push({ day: current.day, text: `……还有 ${days - 5} 天的日常被折进了这段时间里。`, needs: { ...current.needs } });
  current.pendingCatchUpDays = days;
  return { state: current, cards };
}

// ---- storage (per-agent key; guarded for non-browser test env) -------------
const hasLocalStorage = () => typeof globalThis.localStorage !== 'undefined';
const keyFor = agentId => `cochpia-life-game-v2:${agentId || 'default'}`;

export function loadLifeState(agentId = 'default', { now = Date.now() } = {}) {
  if (!hasLocalStorage()) return createLifeSeed(agentId, {}, { now });
  let state = null;
  try {
    const raw = globalThis.localStorage.getItem(keyFor(agentId));
    if (raw) state = JSON.parse(raw);
  } catch { state = null; }
  if (!state || state.version !== ENGINE_VERSION || !state.agentId) {
    state = createLifeSeed(agentId, {}, { now });
  }
  // §13.4: catch-up happens on load, one settlement per opening.
  const { state: settled } = catchUpLife(state, { now });
  return settled;
}

export function saveLifeState(state) {
  if (!state?.agentId || !hasLocalStorage()) return state;
  globalThis.localStorage.setItem(keyFor(state.agentId), JSON.stringify(state));
  return state;
}

export function resetLifeState(agentId = 'default', userLayer = {}) {
  return saveLifeState(createLifeSeed(agentId, userLayer));
}

export function getLifeLocationId(state) { return state?.location || 'bridge'; }
