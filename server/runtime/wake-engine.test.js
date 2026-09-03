import test from 'node:test';
import assert from 'node:assert/strict';
import { createWakeEngine } from './wake-engine.js';
import { buildRuntimeContext } from '../runtime-context.js';

const make = ({ enabled = true, model = null, now = 0 } = {}) => {
  const previous = process.env.WAKEUP_ENABLED;
  if (enabled) process.env.WAKEUP_ENABLED = 'true'; else delete process.env.WAKEUP_ENABLED;
  const state = { agents: [{ id: 'a1', name: 'A', provider: 'mock' }], sessions: [{ id: 's1', kind: 'private', agentId: 'a1' }], messages: { s1: [] } };
  let saves = 0;
  const engine = createWakeEngine({ state, saveState: async () => { saves += 1; }, agents: { list: () => state.agents, get: id => state.agents.find(agent => agent.id === id) }, model, randomUUID: () => 'uuid', agentAvatar: agent => agent.name, innerContinuity: { activation: () => 0, snapshot: () => ({ items: [] }) }, buildRuntimeContext, now });
  if (previous === undefined) delete process.env.WAKEUP_ENABLED; else process.env.WAKEUP_ENABLED = previous;
  return { state, engine, get saves() { return saves; } };
};

test('default off does not initialize state, interval, or persistence', async () => {
  const { state, engine, saves } = make({ enabled: false });
  assert.equal(engine.enabled, false);
  await engine.reconcile('a1', 1000);
  assert.equal(state.wakeStates, undefined);
  assert.equal(saves, 0);
});

test('request-style state proxy lazily initializes wakeStates for each user', async () => {
  const userStates = new Map([
    ['u1', { agents: [{ id: 'a1', name: 'A' }], sessions: [], messages: {} }],
    ['u2', { agents: [{ id: 'a1', name: 'A' }], sessions: [], messages: {} }]
  ]);
  let active = 'u1';
  const proxy = new Proxy({}, {
    get(_, key) { return userStates.get(active)[key]; },
    set(_, key, value) { userStates.get(active)[key] = value; return true; }
  });
  process.env.WAKEUP_ENABLED = 'true';
  const engine = createWakeEngine({ state: proxy, saveState: async () => {}, agents: { get: () => ({ id: 'a1', name: 'A' }), list: () => [{ id: 'a1', name: 'A' }] }, innerContinuity: { activation: () => 0 }, randomUUID: () => 'proxy-id' });
  await engine.kick('a1', 1000);
  assert.ok(userStates.get('u1').wakeStates?.a1);
  active = 'u2';
  await engine.kick('a1', 1000);
  assert.ok(userStates.get('u2').wakeStates?.a1);
  assert.notEqual(userStates.get('u1').wakeStates, userStates.get('u2').wakeStates);
  engine.stop();
});

test('D/T/X regress to bounded means with deterministic seeded noise', async () => {
  const first = make();
  const second = make();
  first.state.wakeStates = { a1: { agentId: 'a1', version: 1, activationDrive: .8, latentActivityTone: .75, stochasticDriftState: .4, entropySeed: 123, cycleStartedAt: new Date(0).toISOString(), theta: 999, hazardAccum: 0, updatedAt: new Date(0).toISOString(), stateVersion: 1 } };
  second.state.wakeStates = structuredClone(first.state.wakeStates);
  const a = await first.engine.reconcile('a1', 60 * 60 * 1000);
  const b = await second.engine.reconcile('a1', 60 * 60 * 1000);
  assert.deepEqual(first.state.wakeStates.a1, second.state.wakeStates.a1);
  assert.ok(a.current.activationDrive >= .2 && a.current.activationDrive <= .8);
  assert.ok(a.current.latentActivityTone >= .25 && a.current.latentActivityTone <= .75);
  assert.ok(a.current.stochasticDriftState >= -.4 && a.current.stochasticDriftState <= .4);
  assert.equal(a.current.entropySeed, b.current.entropySeed);
});

test('lambda clamps and modulation maps U to [1, 3]', () => {
  const { engine } = make();
  assert.ok(engine.rate('a1', 0) >= .15 && engine.rate('a1', 0) <= 8);
  assert.equal(engine.modulation('a1', 0), 1);
});

test('theta remains fixed within a cycle and hazard threshold triggers once', async () => {
  const { state, engine } = make();
  state.wakeStates = { a1: { agentId: 'a1', version: 1, activationDrive: .5, latentActivityTone: .5, stochasticDriftState: 0, entropySeed: 42, cycleStartedAt: new Date(0).toISOString(), theta: .1, hazardAccum: 0, updatedAt: new Date(0).toISOString(), stateVersion: 1, dispatchedWakeIds: {} } };
  const result = await engine.reconcile('a1', 60 * 60 * 1000);
  assert.equal(result.triggered, true);
  assert.equal(result.current.hazardAccum, 0);
  assert.notEqual(result.current.theta, .1);
  assert.equal(result.current.dispatchedWakeIds[result.wakeId], 60 * 60 * 1000);
});

test('kick lowers D and direct wake is idempotent by wake id', async () => {
  const { state, engine } = make();
  await engine.kick('a1', 1000);
  assert.equal(state.wakeStates.a1.activationDrive, .4);
  const result = await engine.directWake('a1', 'test');
  assert.equal(result.outcome.action, 'silent');
  assert.ok(result.wakeId.includes(':direct:'));
});

test('wake run uses the agent private session and materializes only message decisions', async () => {
  let calls = 0;
  const { state, engine } = make({ model: { provider: 'mock', model: 'mock', generate: async ({ runtimeContext }) => { calls += 1; assert.equal(runtimeContext.dynamic.wakeup.source, 'test'); return '{"action":"message","message":"我主动想起你了"}'; } } });
  const result = await engine.directWake('a1', 'test');
  assert.equal(calls, 1);
  assert.equal(result.outcome.action, 'message');
  assert.equal(state.messages.s1.at(-1).content, '我主动想起你了');
  assert.equal(state.wakeStates.a1.events.at(-1).type, 'wake_materialized');
});
