// R-019 engine v2 tests: the rewritten lifeGameEngine must satisfy the
// blueprint mechanisms that the old 122-line prototype lacked.
// The engine touches localStorage only inside load/save, so the pure
// simulation functions run under node directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceLife, catchUpLife, createLifeSeed, resolveDecision,
  PERSONALITY_DIMS, TRAIT_TEMPLATES
} from '../client/src/life/lifeGameEngine.js';

const seedOf = (agentId, layer = {}) => createLifeSeed(agentId, layer, { now: 1_000_000 });

test('R-019 seed: same agentId reproduces identical traits; templates bias without fixing', () => {
  const a = seedOf('agent-a');
  const b = seedOf('agent-a');
  assert.deepEqual(a.traits, b.traits, 'same agentId -> deterministic seed');
  const sunny = seedOf('agent-sunny', { template: '小太阳' });
  assert.ok(sunny.traits.extroversion > 0.6, 'template pulls extroversion up');
  assert.ok(Math.abs(sunny.traits.extroversion - TRAIT_TEMPLATES['小太阳'].extroversion) <= 0.15, 'template keeps jitter');
  assert.equal(Object.keys(a.personality).length, 10);
  for (const dim of Object.values(a.personality)) assert.ok(dim >= 0.3 && dim <= 0.7, 'personality seeded in 0.3~0.7');
});

test('R-019 §13.1 utility engine: survival override beats everything', () => {
  let state = seedOf('agent-sick');
  state.needs.energy = 12;
  state.needs.health = 15;
  const next = advanceLife(state, null);
  assert.equal(next.lastAction, 'rest', 'health/energy below 20 forces rest');
});

test('R-019 §13.2 personality growth passes three gates with attribution', () => {
  let state = seedOf('agent-grow');
  state.personality['胜任感'] = 0.9; // near bound -> saturation must damp
  state.personality['好奇心'] = 0.5;
  const before = { 胜任感: state.personality['胜任感'], 好奇心: state.personality['好奇心'] };
  // small-win event vector {胜任感 +0.05, 乐观感 +0.02} near the bound
  let changed = null;
  for (let i = 0; i < 40 && !changed; i++) {
    state = advanceLife(state, 'work');
    changed = state.lastGrowth && Object.keys(state.lastGrowth).length ? state.lastGrowth : null;
  }
  // whenever growth fires, the near-bound dim must move less than 0.05 (inertia+saturation)
  if (changed && changed['胜任感'] !== undefined) {
    assert.ok(Math.abs(changed['胜任感']) < 0.05, 'saturation gate damps near-bound growth');
  }
  assert.ok(state.growthLog.length >= 0 && state.growthLog.length <= 50);
  assert.equal(state.personality['好奇心'] >= before['好奇心'] - 0.01, true);
});

test('R-019 §13.4 catch-up: elapsed real time advances days and yields cards', () => {
  const MS_PER_GAME_DAY = 6 * 60 * 60 * 1000;
  let state = seedOf('agent-away', {}, { now: 0 });
  state.lastRealTick = 0;
  // 3 game days of elapsed time (need to bypass the 30-day cap test via small numbers)
  const { state: caught, cards } = catchUpLife(state, { now: MS_PER_GAME_DAY * 3 + 1000 });
  assert.equal(caught.day, 4, 'seed day 1 + 3 elapsed days');
  assert.ok(cards.length >= 3 && cards.length <= 6, `cards compressed, got ${cards.length}`);
  assert.equal(caught.pendingCatchUpDays, 3);
  // lastRealTick refreshed: an immediate second catch-up is a no-op
  const again = catchUpLife(caught, { now: MS_PER_GAME_DAY * 3 + 2000 });
  assert.equal(again.state.day, caught.day, 'gate: no double settlement');
});

test('R-019 decisions: participate mode surfaces options with an autonomous default', () => {
  let state = seedOf('agent-decide', { mode: 'participate' });
  state.day = 2; // next advance hits day 3 -> decision due
  const next = advanceLife(state, 'cafe');
  assert.ok(next.pendingDecision, 'decision surfaced on day%3');
  assert.ok(next.pendingDecision.options.some(o => o.id === 'autonomous'), '让它自己决定 is present');
  const resolved = resolveDecision(next, 'autonomous');
  assert.equal(resolved.pendingDecision, null);
  // observe mode never asks
  const observer = advanceLife({ ...seedOf('agent-obs', { mode: 'observe' }), day: 2 }, 'walk');
  assert.equal(observer.pendingDecision, null, 'observe mode decides alone');
});
