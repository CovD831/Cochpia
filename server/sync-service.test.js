import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSyncChanges } from './sync-service.js';

test('sync returns stable ordered changes and continues with its cursor', () => {
  const state = {
    sessions: [{ id: 's-1', title: 'One', updatedAt: '2026-01-01T00:00:00.000Z' }],
    messages: { 's-1': [{ id: 'm-1', role: 'user', content: 'Hi', createdAt: '2026-01-01T00:00:00.000Z' }] },
    memories: [], evidence: []
  };
  const first = collectSyncChanges(state, { limit: 1 });
  assert.equal(first.changes.length, 1);
  assert.equal(first.hasMore, true);
  const second = collectSyncChanges(state, { cursor: first.nextCursor, limit: 10 });
  assert.equal(second.changes.length, 1);
  assert.equal(new Set([...first.changes, ...second.changes].map(item => item.id)).size, 2);
});

test('sync rejects malformed cursors', () => {
  assert.throws(() => collectSyncChanges({ sessions: [] }, { cursor: 'bad' }), /Invalid sync cursor/);
});
