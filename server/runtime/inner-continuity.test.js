import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, createInnerContinuity } from './inner-continuity.js';

const base = { id: 'agent-1:state', kind: 'affective', direction: 'increase', level: 0, limit: 1, t50Ms: 1000, horizonMs: 5000, updatedAt: 0 };

test('advance follows the half-life formula', () => assert.equal(advance(base, 1000).level, 0.5));

test('hold and uncertain do not change level', () => {
  assert.equal(advance({ ...base, direction: 'hold', level: 0.3 }, 100000).level, 0.3);
  assert.equal(advance({ ...base, direction: 'uncertain', level: 0.3 }, 100000).level, 0.3);
});

test('horizon stops extrapolation without deleting the item', () => {
  const state = advance(base, 6000);
  assert.equal(state.level, 0);
  assert.equal(state.freshness, 0);
});

test('patches are validated, clamped, idempotent, and release tombstones', async () => {
  const state = {};
  let saves = 0;
  const inner = createInnerContinuity({ state, saveState: async () => { saves += 1; } });
  const patch = { upsert: [{ ...base, positive: 2, unknown: 'drop' }] };
  await inner.applyPatch('agent-1', patch, 1000);
  await inner.applyPatch('agent-1', patch, 1000);
  assert.equal(state.innerStates['agent-1'].items.length, 1);
  assert.equal(state.innerStates['agent-1'].items[0].positive, 1);
  assert.equal(state.innerStates['agent-1'].items[0].unknown, undefined);
  assert.equal(saves, 1);
  await inner.applyPatch('agent-1', { release: ['other:state', base.id] }, 2000);
  assert.equal(inner.snapshot('agent-1', 2000).items.length, 0);
  await inner.applyPatch('agent-1', patch, 1000);
  assert.equal(inner.snapshot('agent-1', 2000).items.length, 0);
});

test('lazy-initializes innerStates on the active user state (multi-user proxy)', async () => {
  // 模拟 index.js 的 state Proxy：读/写重定向到「当前用户 state」
  const base = {};
  let current = base;
  const state = new Proxy(base, {
    get(_t, p) { return current[p]; },
    set(_t, p, v) { current[p] = v; return true; },
    ownKeys(_t) { return Reflect.ownKeys(current); },
    getOwnPropertyDescriptor(_t, p) { return { configurable: true, enumerable: true, value: current[p], writable: true }; }
  });
  const inner = createInnerContinuity({ state, saveState: async () => {} });
  // 请求时切换到另一个用户 state（不含 innerStates 字段）
  current = {};
  assert.deepEqual(inner.snapshot('agent-1').items, []);
  await inner.applyPatch('agent-1', { upsert: [{ id: 'agent-1:s', kind: 'affective', direction: 'hold', level: 0.5, positive: 0.5 }] }, 1000);
  assert.equal(inner.snapshot('agent-1', 1000).items.length, 1);
  assert.equal(current.innerStates['agent-1'].items.length, 1);
});

test('activation combines positive and negative affective presence', async () => {
  const state = {};
  const inner = createInnerContinuity({ state, saveState: async () => {} });
  await inner.applyPatch('agent-1', { upsert: [
    { id: 'agent-1:joy', kind: 'affective', direction: 'hold', level: 0.4, positive: 0.4 },
    { id: 'agent-1:hurt', kind: 'affective', direction: 'hold', level: 0.5, negative: 0.5 }
  ] }, 1000);
  assert.equal(inner.activation('agent-1', 1000), 0.7);
});
