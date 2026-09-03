const VERSION = 1;
const DEFAULT_T50_MS = 6 * 60 * 60 * 1000;
const DEFAULT_HORIZON_MS = 24 * 60 * 60 * 1000;
const DIRECTIONS = new Set(['increase', 'decrease', 'hold', 'uncertain']);
const KINDS = new Set(['affective', 'motivational']);
const NUMERIC_FIELDS = new Set([
  'positive', 'negative', 'arousal', 'returnPull', 'strength', 'readiness',
  'inhibition', 'endorsement', 'level', 'limit', 'certainty'
]);

const clamp01 = value => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(1, number));
};

const iso = value => new Date(value).toISOString();
const validDate = value => Number.isFinite(new Date(value).getTime());

export function advance(item, now = Date.now()) {
  const current = { ...item };
  const updatedAt = new Date(item.updatedAt).getTime();
  const elapsed = Number.isFinite(updatedAt) ? Math.max(0, Number(now) - updatedAt) : 0;
  const horizonMs = Number(item.horizonMs) > 0 ? Number(item.horizonMs) : DEFAULT_HORIZON_MS;
  const t50Ms = Number(item.t50Ms) > 0 ? Number(item.t50Ms) : DEFAULT_T50_MS;
  if ((item.direction === 'increase' || item.direction === 'decrease') && item.limit != null && elapsed <= horizonMs) {
    const level = Number(item.level);
    const limit = Number(item.limit);
    if (Number.isFinite(level) && Number.isFinite(limit)) current.level = limit + (level - limit) * 2 ** (-elapsed / t50Ms);
  }
  current.freshness = Math.max(0, Math.min(1, 1 - elapsed / horizonMs));
  return current;
}

const cleanItem = (agentId, input, existing, now) => {
  if (!input || typeof input !== 'object') return null;
  const id = String(input.id || existing?.id || '');
  if (!id || !id.startsWith(`${agentId}:`)) return null;
  const kind = input.kind ?? existing?.kind;
  const direction = input.direction ?? existing?.direction;
  if (!KINDS.has(kind) || !DIRECTIONS.has(direction)) return null;
  const item = { id, kind, direction };
  for (const field of ['positive', 'negative', 'arousal', 'returnPull', 'strength', 'readiness', 'inhibition', 'endorsement', 'level', 'limit', 'certainty']) {
    if (existing && existing[field] != null) item[field] = existing[field];
  }
  for (const field of NUMERIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      const value = clamp01(input[field]);
      if (value != null) item[field] = value;
    }
  }
  item.level ??= 0;
  item.t50Ms = Number(input.t50Ms ?? existing?.t50Ms ?? DEFAULT_T50_MS);
  item.horizonMs = Number(input.horizonMs ?? existing?.horizonMs ?? DEFAULT_HORIZON_MS);
  if (!Number.isFinite(item.t50Ms) || item.t50Ms <= 0) item.t50Ms = DEFAULT_T50_MS;
  if (!Number.isFinite(item.horizonMs) || item.horizonMs <= 0) item.horizonMs = DEFAULT_HORIZON_MS;
  item.createdAt = validDate(existing?.createdAt) ? existing.createdAt : iso(now);
  item.updatedAt = validDate(input.updatedAt) ? iso(input.updatedAt) : iso(now);
  return item;
};

export function createInnerContinuity({ state, saveState }) {
  state.innerStates ||= {};

  const snapshot = (agentId, now = Date.now()) => {
    const stored = state.innerStates[agentId];
    if (!stored) return { agentId, version: VERSION, anchorAt: null, items: [], updatedAt: null };
    return {
      agentId,
      version: VERSION,
      anchorAt: stored.anchorAt || null,
      updatedAt: stored.updatedAt || null,
      items: (stored.items || []).map(item => advance(item, now))
    };
  };

  const applyPatch = async (agentId, patch = {}, now = Date.now()) => {
    if (!agentId || !patch || typeof patch !== 'object') return snapshot(agentId, now);
    const stored = state.innerStates[agentId] || { agentId, version: VERSION, anchorAt: null, items: [], updatedAt: null, tombstones: {} };
    const items = new Map((stored.items || []).map(item => [item.id, item]));
    const tombstones = { ...(stored.tombstones || {}) };
    let changed = false;
    for (const raw of Array.isArray(patch.upsert) ? patch.upsert : []) {
      const item = cleanItem(agentId, raw, items.get(raw?.id), now);
      if (!item) continue;
      const tombstoneAt = tombstones[item.id] ? new Date(tombstones[item.id]).getTime() : 0;
      if (!items.has(item.id) && tombstoneAt && new Date(item.updatedAt).getTime() <= tombstoneAt) continue;
      if (JSON.stringify(items.get(item.id)) !== JSON.stringify(item)) { items.set(item.id, item); changed = true; }
    }
    for (const rawId of Array.isArray(patch.release) ? patch.release : []) {
      const id = String(rawId || '');
      if (!id.startsWith(`${agentId}:`)) continue;
      if (items.delete(id)) changed = true;
      if (tombstones[id] !== iso(now)) changed = true;
      tombstones[id] = iso(now);
    }
    if (!changed) return snapshot(agentId, now);
    const next = { agentId, version: VERSION, anchorAt: iso(now), updatedAt: iso(now), items: [...items.values()], tombstones };
    state.innerStates[agentId] = next;
    await saveState(state);
    return snapshot(agentId, now);
  };

  const activation = (agentId, now = Date.now()) => {
    const items = snapshot(agentId, now).items.filter(item => item.kind === 'affective');
    const positive = Math.max(0, ...items.map(item => Number(item.positive) || 0));
    const negative = Math.max(0, ...items.map(item => Number(item.negative) || 0));
    return Math.max(0, Math.min(1, 1 - (1 - positive) * (1 - negative)));
  };

  return { advance, snapshot, applyPatch, activation };
}
