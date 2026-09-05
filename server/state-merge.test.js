import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeState } from './state-merge.js';

test('mergeState adds missing items by id without overwriting existing ones', () => {
  const base = {
    sessions: [{ id: 'a', title: 'existing' }],
    messages: { a: [{ id: 'm1', role: 'user', content: 'old' }] },
    memories: [{ id: 'm1' }],
    personality: { version: 2 },
    evidence: [], personalityHistory: [], personalityAudit: []
  };
  const incoming = {
    sessions: [{ id: 'a', title: 'imported-dup' }, { id: 'b', title: 'new' }],
    messages: { a: [{ id: 'm1', content: 'dup' }, { id: 'm2', content: 'new' }], b: [{ id: 'm3', content: 'b-msg' }] },
    memories: [{ id: 'm1' }, { id: 'm2' }],
    personality: { version: 99 },
    evidence: [], personalityHistory: [], personalityAudit: []
  };
  const merged = mergeState(base, incoming);
  assert.equal(merged.sessions.length, 2);
  assert.equal(merged.sessions[0].title, 'existing');
  assert.equal(merged.messages.a.length, 2);
  assert.equal(merged.messages.b.length, 1);
  assert.equal(merged.memories.length, 2);
  assert.equal(merged.personality.version, 2);
});

test('mergeState fills personality only when missing', () => {
  const merged = mergeState({ sessions: [] }, { personality: { version: 7 }, sessions: [] });
  assert.equal(merged.personality.version, 7);
});

test('mergeState imports workspace preferences only when missing', () => {
  const imported = mergeState({ sessions: [], workspacePreferences: null }, { workspacePreferences: { theme: { themeId: 'ink' } } });
  assert.equal(imported.workspacePreferences.theme.themeId, 'ink');
  const existing = mergeState({ sessions: [], workspacePreferences: { theme: { themeId: 'sakura' } } }, { workspacePreferences: { theme: { themeId: 'ink' } } });
  assert.equal(existing.workspacePreferences.theme.themeId, 'sakura');
});

test('mergeState does not import Core v0 operational receipts from an untrusted payload', () => {
  const base = {
    sessions: [],
    messages: {},
    coreV0: {
      schemaVersion: 1,
      sequence: 2,
      memorySessionBindings: [{ bindingId: 'binding-a', applicationSessionId: 's1' }],
      turnAdmissions: [{ turnId: 'turn-a', idempotencyKey: 'key-a' }],
      assistantCommits: [{ commitId: 'assistant:message-a', status: 'completed' }]
    }
  };
  const incoming = {
    coreV0: {
      schemaVersion: 1,
      sequence: 9,
      memorySessionBindings: [{ bindingId: 'binding-a', applicationSessionId: 'changed' }, { bindingId: 'binding-b', applicationSessionId: 's2' }],
      turnAdmissions: [{ turnId: 'turn-a', idempotencyKey: 'changed' }, { turnId: 'turn-b', idempotencyKey: 'key-b' }],
      assistantCommits: [{ commitId: 'assistant:message-a', status: 'changed' }, { commitId: 'assistant:message-b', status: 'pending' }]
    }
  };
  const merged = mergeState(base, incoming);
  assert.equal(merged.coreV0.sequence, 2);
  assert.deepEqual(merged.coreV0.memorySessionBindings.map(item => item.bindingId), ['binding-a']);
  assert.deepEqual(merged.coreV0.turnAdmissions.map(item => item.turnId), ['turn-a']);
  assert.deepEqual(merged.coreV0.assistantCommits.map(item => item.commitId), ['assistant:message-a']);
  assert.equal(merged.coreV0.turnAdmissions[0].idempotencyKey, 'key-a');
});

test('mergeState rejects invalid payloads', () => {
  assert.throws(() => mergeState({}, null), /Invalid import state/);
  assert.throws(() => mergeState(null, {}), /Invalid base state/);
});
