import test from 'node:test';
import assert from 'node:assert/strict';
import { routeMemoryQuery } from './memory-module-query-router.js';

test('query router maps roadmap retrieval modes deterministically', () => {
  assert.equal(routeMemoryQuery('我的 tea 偏好是什么？'), 'profile_exact');
  assert.equal(routeMemoryQuery('我现在的目标是什么？'), 'state_current');
  assert.equal(routeMemoryQuery('我在 release 这段经历里做了什么？'), 'episode_recall');
  assert.equal(routeMemoryQuery('我们之间的共同记忆是什么？'), 'relationship_recall');
  assert.equal(routeMemoryQuery('请把 preference 和 plan 关联起来，只用一跳证据'), 'bridge_candidate');
  assert.equal(routeMemoryQuery('当 current_plan 存在两个版本时应如何回答？'), 'unknown');
  assert.equal(routeMemoryQuery('current_plan'), 'unknown');
  assert.equal(routeMemoryQuery('moon_city 有什么证据？'), 'unknown');
  assert.equal(routeMemoryQuery(''), 'unknown');
});

// P0 修复（2026-09-17）：泛时间副词「现在/当前」曾把偏好类查询误路由到
// state_current。state_current 的检索域是 session 内状态通道
// （state.currentStates，过滤条件含 currentState.sessionId === activeSession.id），
// 无活跃会话时 retrievalDocuments 直接返回空集且不回落检索断言 —— 于是
// 「我现在喜欢吃什么」在无会话时拿到空结果，而答案其实在记忆里。
// 收窄触发词后，这类查询落回携带真实检索路径的 profile_exact。
//
// 范围边界：「正在」**不在**收窄范围内 —— 它是进行体标记（指向进行中的动作），
// 且产品把 currentState 的值就写成「正在…」。删掉它会连带把
// memory-module.test.js:448「我正在发布什么」推到 episode_recall（实测），
// 属于同一缺陷族的新回归。故只删「现在/当前」。
test('query router does not misroute generic-time-adverb queries to state_current (P0 fix)', () => {
  // 修复前这三条断言中的前两条都是 state_current（判别力证据：修复前必须红）。
  assert.notEqual(routeMemoryQuery('我现在喜欢吃什么'), 'state_current');
  assert.equal(routeMemoryQuery('我现在喜欢吃什么'), 'profile_exact');
  assert.notEqual(routeMemoryQuery('我现在的偏好'), 'state_current');
  assert.equal(routeMemoryQuery('我现在的偏好'), 'profile_exact');
  // 回归钉：state_current 的语义触发词（情绪/进展/目标/进行体「正在」）必须保留。
  assert.equal(routeMemoryQuery('我最近情绪如何'), 'state_current');
  assert.equal(routeMemoryQuery('我的进展'), 'state_current');
  assert.equal(routeMemoryQuery('我现在的目标是什么？'), 'state_current');
  assert.equal(routeMemoryQuery('我此刻正在做的事情'), 'state_current');
  // 跨文件回归钉：memory-module.test.js:448 依赖这条路由（session 状态通道）。
  assert.equal(routeMemoryQuery('我正在发布什么'), 'state_current');
});
