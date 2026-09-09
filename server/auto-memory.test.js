import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRemember } from './auto-memory.js';

test('shouldRemember skips short messages and keeps significant or long ones', () => {
  assert.equal(shouldRemember('你好'), false);
  assert.equal(shouldRemember('我喜欢下雨天，尤其是傍晚的时候。'), true);
  assert.equal(shouldRemember('x'.repeat(50)), true);
});
