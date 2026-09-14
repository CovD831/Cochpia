// Session 删除传播验收（2026-09-13 生产缺陷回归防线）。
//
// 生产库实证：删除 session 后 cochpia_state.messages 里残留该 session 的
// 空数组孤儿键——「session → messages 键」这条删除传播边缺失。本文件钉住
// 修复后的语义：
//
//   D1  负例：session + 消息 + coreV0 会话域记录，删除后 messages 键消失、
//       coreV0 记录消失，且其他会话的数据原封不动（无孤儿、无误伤）
//   D2  characterization：对不存在 key / 空记录的删除传播是幂等的——
//       不抛错、不改状态、重复调用零效果
//   D3  回滚不复活：快照为空且键已不存在时，restore 不得重新创建
//       messages 键（空数组孤儿键的直接来源之一）
//
// agent+session+消息 的完整链路在模块层构造：index.js 的删除路由只负责
// splice sessions + 调用 propagateSessionDeletion，传播语义全部收在
// session-deletion.js 里，这里直接对它断言。

import test from 'node:test';
import assert from 'node:assert/strict';

import { propagateSessionDeletion } from './session-deletion.js';
import { createCoreV0Store, ensureCoreV0State } from './core-v0.js';

const AGENT = { id: 'agent-1', name: 'Cochpia', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

const buildState = () => {
  const state = {
    agents: [AGENT],
    sessions: [
      { id: 'session-doomed', title: '将被删除', agentId: AGENT.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: 'session-kept', title: '保留会话', agentId: AGENT.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    ],
    messages: {
      'session-doomed': [{ id: 'm-1', role: 'user', content: '你好', createdAt: new Date().toISOString() }],
      'session-kept': [{ id: 'm-2', role: 'user', content: '留下', createdAt: new Date().toISOString() }]
    },
    personality: { version: 1, traits: [], summary: '', updatedAt: new Date().toISOString() },
    evidence: []
  };
  ensureCoreV0State(state);
  state.coreV0.turnAdmissions.push(
    { turnId: 'turn:1', applicationSessionId: 'session-doomed' },
    { turnId: 'turn:2', applicationSessionId: 'session-kept' }
  );
  state.coreV0.memorySessionBindings.push(
    { bindingId: 'binding:1', applicationSessionId: 'session-doomed', memorySessionId: 'memory-session-1' },
    { bindingId: 'binding:2', applicationSessionId: 'session-kept', memorySessionId: 'memory-session-2' }
  );
  state.coreV0.assistantCommits.push(
    { commitId: 'assistant:1', applicationSessionId: 'session-doomed' },
    { commitId: 'assistant:2', applicationSessionId: 'session-kept' }
  );
  return state;
};

test('D1 删除 session 后 messages 键与 coreV0 会话域记录一并清理，其他会话不受影响', () => {
  const state = buildState();
  // 复刻 index.js 删除路由的两步：移除会话本体 + 传播清理。
  state.sessions = state.sessions.filter(session => session.id !== 'session-doomed');
  const removed = propagateSessionDeletion(state, 'session-doomed');

  assert.equal(removed.messagesKey, true);
  assert.equal('session-doomed' in state.messages, false);
  assert.deepEqual(state.coreV0.turnAdmissions.map(item => item.turnId), ['turn:2']);
  assert.deepEqual(state.coreV0.memorySessionBindings.map(item => item.bindingId), ['binding:2']);
  assert.deepEqual(state.coreV0.assistantCommits.map(item => item.commitId), ['assistant:2']);
  // 无孤儿：保留会话的数据原封不动。
  assert.equal(removed.turnAdmissions, 1);
  assert.equal(removed.memorySessionBindings, 1);
  assert.equal(removed.assistantCommits, 1);
  assert.deepEqual(state.messages['session-kept'], [{ id: 'm-2', role: 'user', content: '留下', createdAt: state.messages['session-kept'][0].createdAt }]);
  assert.ok(state.sessions.some(session => session.id === 'session-kept'));
});

test('D2 删除传播对不存在的 key / 空记录幂等：不抛错、状态不变、重复调用零效果', () => {
  const state = buildState();
  const before = structuredClone(state);
  const missing = { id: 'session-never-was', title: '幽灵', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  state.sessions.push(missing);

  const first = propagateSessionDeletion(state, 'session-never-was');
  assert.deepEqual(first, { messagesKey: false, turnAdmissions: 0, memorySessionBindings: 0, assistantCommits: 0 });
  state.sessions.pop();
  assert.deepEqual(state, before);

  // 对已清理过的会话重复传播（崩溃恢复/重试路径）同样零效果。
  state.sessions = state.sessions.filter(session => session.id !== 'session-doomed');
  propagateSessionDeletion(state, 'session-doomed');
  const after = structuredClone(state);
  const second = propagateSessionDeletion(state, 'session-doomed');
  assert.deepEqual(second, { messagesKey: false, turnAdmissions: 0, memorySessionBindings: 0, assistantCommits: 0 });
  assert.deepEqual(state, after);
});

test('D2b 无 coreV0 面 / 无 messages 对象的旧状态也可安全传播', () => {
  const state = { sessions: [], messages: {} };
  assert.doesNotThrow(() => propagateSessionDeletion(state, 'session-doomed'));
  assert.deepEqual(propagateSessionDeletion(state, 'session-doomed'), { messagesKey: false, turnAdmissions: 0, memorySessionBindings: 0, assistantCommits: 0 });
  assert.doesNotThrow(() => propagateSessionDeletion({ sessions: [] }, 'session-doomed'));
});

test('D3 快照回滚不得复活已删除会话的空 messages 键', () => {
  // 来源：commit 失败回滚 restore 时无条件写回快照，会话被并发删除后
  // 快照里的空数组把孤儿键重新写进 jsonb（生产孤儿键形态）。
  const state = buildState();
  const store = createCoreV0Store({ state });
  const snapshot = store.snapshot('session-doomed');
  // 模拟并发删除：先传播清理（键随快照非空而仍应还原——既有语义），
  // 再对「快照为空且键不存在」的形态断言不复活。
  delete state.messages['session-doomed'];
  store.restore('session-doomed', snapshot);
  assert.ok(Array.isArray(state.messages['session-doomed']));

  const emptySnapshot = { ...snapshot, messages: [] };
  delete state.messages['session-doomed'];
  store.restore('session-doomed', emptySnapshot);
  assert.equal('session-doomed' in state.messages, false);
});
