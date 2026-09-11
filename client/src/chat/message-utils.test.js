import test from 'node:test';
import assert from 'node:assert/strict';
import { asArray, describeModelError, providerModelOptions, splitSegments, takeSegment, dateLabel } from './message-utils.js';

// Stage 3 renders one bubble per line. Until now that behaviour was pinned only
// by the browser acceptance run, so a regression here would have shown up as a
// cosmetic change nobody was asserting on. These are the unit-level guards.

test('takeSegment returns null until a line break arrives', () => {
  assert.equal(takeSegment('还没有换行'), null);
  assert.equal(takeSegment(''), null);
  assert.equal(takeSegment('   '), null);
});

test('takeSegment splits on the first break and keeps the remainder', () => {
  assert.deepEqual(takeSegment('第一段\n第二段'), { segment: '第一段', rest: '第二段' });
  // Runs of newlines collapse; leading whitespace on the remainder is dropped.
  assert.deepEqual(takeSegment('A\n\n  B'), { segment: 'A', rest: 'B' });
  assert.deepEqual(takeSegment('A\r\nB'), { segment: 'A', rest: 'B' });
});

test('takeSegment drops an empty leading segment rather than emitting a blank bubble', () => {
  assert.deepEqual(takeSegment('\nA'), { segment: '', rest: 'A' });
});

test('splitSegments reproduces the streaming segmentation for a stored message', () => {
  assert.deepEqual(splitSegments('第一段。\n第二段。\n第三段。'), ['第一段。', '第二段。', '第三段。']);
  // No line breaks at all: the whole text is one segment, not nothing.
  assert.deepEqual(splitSegments('只有一段'), ['只有一段']);
  assert.deepEqual(splitSegments(''), []);
});

test('splitSegments does not drop the trailing line', () => {
  const segments = splitSegments('A\nB\nC');
  assert.equal(segments.length, 3);
  assert.equal(segments.at(-1), 'C');
});

test('asArray only passes arrays through', () => {
  assert.deepEqual(asArray([1]), [1]);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray({ length: 1 }), []);
  assert.deepEqual(asArray('ab'), []);
});

test('providerModelOptions de-duplicates the current model into the suggestion list', () => {
  assert.deepEqual(providerModelOptions({ model: 'a', suggestedModels: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(providerModelOptions({ suggestedModels: ['b'] }), ['b']);
  assert.deepEqual(providerModelOptions(null), []);
});

test('describeModelError prefers the operator-facing label and falls back to the raw message', () => {
  assert.match(describeModelError({ code: 'MODEL_TIMEOUT', message: 'boom' }), /^请求超时，请稍后重试：boom$/);
  assert.equal(describeModelError({ code: 'SOMETHING_ELSE', message: 'raw' }), 'raw');
});

test('dateLabel names today and yesterday, and dates everything else', () => {
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  assert.equal(dateLabel(now.toISOString()), '今天');
  assert.equal(dateLabel(yesterday.toISOString()), '昨天');
  const old = new Date(2020, 0, 5, 12);
  assert.equal(dateLabel(old.toISOString()), '1月5日');
});
