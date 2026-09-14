import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCommitCoordinator,
  createProjectionDispatcher,
  createInteractionFinalizer
} from './runtime/interaction-finalizer.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('CommitCoordinator runs the turn service and returns its committed result', async () => {
  const coordinator = createCommitCoordinator();
  const service = { handleTurn: async input => ({ status: 'committed', echo: input.body?.message }) };
  const result = await coordinator.commit({ input: { body: { message: 'hi' } }, service });
  assert.equal(result.status, 'committed');
  assert.equal(result.echo, 'hi');
});

test('CommitCoordinator throws without a turn service', async () => {
  const coordinator = createCommitCoordinator();
  await assert.rejects(() => coordinator.commit({ input: {} }));
});

test('ProjectionDispatcher fires the drain outside the response path and swallows rejects', async () => {
  const errors = [];
  const dispatcher = createProjectionDispatcher({ onError: e => errors.push(e) });
  let fired = false;
  dispatcher.dispatch({
    drain: () => {
      fired = true;
      return Promise.resolve();
    }
  });
  assert.equal(fired, false, 'drain must not run synchronously');
  await tick();
  assert.equal(fired, true);

  dispatcher.dispatch({ drain: () => Promise.reject(new Error('boom')) });
  await tick();
  assert.equal(errors.length, 1);
});

test('ProjectionDispatcher treats a null/undefined drain as a no-op', async () => {
  const dispatcher = createProjectionDispatcher({ onError: () => assert.fail('should not error') });
  assert.doesNotThrow(() => dispatcher.dispatch({ drain: null }));
  assert.doesNotThrow(() => dispatcher.dispatch({}));
  await tick();
});

test('InteractionFinalizer.finalizeTurn commits, records degrade, dispatches, returns result', async () => {
  const service = { handleTurn: async input => ({ status: 'committed', memoryStatus: 'degraded', memoryDegradedReason: 'MEM_X' }) };
  let drained = null;
  let degrade = null;
  const finalizer = createInteractionFinalizer({
    commitCoordinator: createCommitCoordinator(),
    projectionDispatcher: createProjectionDispatcher({ onError: () => {} })
  });
  const result = await finalizer.finalizeTurn({
    input: { body: { message: 'hi' } },
    service,
    drain: () => { drained = true; },
    onDegrade: reason => { degrade = reason; }
  });
  assert.equal(result.status, 'committed');
  assert.equal(degrade, 'MEM_X');
  await tick();
  assert.equal(drained, true);
});

test('InteractionFinalizer does not record degrade on a healthy turn', async () => {
  const service = { handleTurn: async () => ({ status: 'committed', memoryStatus: 'available' }) };
  let degrade = 'untouched';
  const finalizer = createInteractionFinalizer();
  await finalizer.finalizeTurn({
    input: { body: {} },
    service,
    drain: null,
    onDegrade: () => { degrade = 'called'; }
  });
  assert.equal(degrade, 'untouched');
});
