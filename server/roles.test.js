import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRole } from './roles.js';

test('resolveRole maps workflow roles to executors', () => {
  assert.equal(resolveRole('verifier').builtin, 'verify');
  assert.equal(resolveRole('planner').executor, 'pi');
  assert.equal(resolveRole('missing'), null);
});
