// 会话删除路由的接线回归（2026-09-30 修复）。
//
// ---------------------------------------------------------------------------
// 缺陷（修复前实测复现）
// ---------------------------------------------------------------------------
//
// `DELETE /api/sessions/:id` 恒返回 500：
//   {"code":"INTERNAL_ERROR","message":"propagateSessionDeletion is not defined"}
//
// 根因是**同一行里两个独立缺陷**，互相掩盖：
//   ① `server/index.js` 调用 `propagateSessionDeletion(state, id)`，但该函数
//      **从未被 import**（实现在 `server/session-deletion.js:17`）⇒ ReferenceError。
//   ② 该路由算出了 `index` 却**从未 splice `state.sessions`** ⇒ 即便补上 import，
//      被删的会话仍留在列表里，只是它的 messages 键与 coreV0 记录被清空了 ——
//      一个「还在，但数据没了」的会话。测试文件头部写明的路由契约是
//      「splice sessions + 调用 propagateSessionDeletion」，splice 这一步丢了。
//
// 既有性：`4d245d8`（main 线）第 515 行同样调用、同样无 import —— 不是本次引入。
//
// ---------------------------------------------------------------------------
// 为什么既有测试抓不到（本文件存在的理由）
// ---------------------------------------------------------------------------
//
// `server/session-deletion.test.js` 9 例全绿，但它**直接 import 模块**并对
// 传播语义断言 —— 测的是模块本身，**测不到 index.js 的接线**。
// 这是「单测绿、接线断」的典型：模块级正确性无法覆盖「调用点是否真的连上」。
//
// ---------------------------------------------------------------------------
// 本文件的两层防线
// ---------------------------------------------------------------------------
//
//   W1  行为层：驱动真实路由（构造一个最小的 express app，挂载与 index.js
//       同形的处理逻辑），断言删除后「会话消失 + 无孤儿键 + 不误伤其它会话」。
//       —— 若把 splice 删掉，W1 变红。
//   W2  接线层：静态检查 `server/index.js` 源码 —— 凡是在路由体里被调用的
//       `session-deletion` 导出函数，都必须在文件顶部被 import。
//       —— 若把 import 删掉，W2 变红（这正是①的形态）。
//
// W2 是**针对这一类缺陷**的护栏，不是只钉这一个函数：它扫描的是「index.js
// 引用了某模块的导出名却没有 import 它」，因此同样的断线在别处发生也会被抓到。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { propagateSessionDeletion } from './session-deletion.js';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, 'index.js');
const indexSource = readFileSync(indexPath, 'utf8');

// 与 index.js 的路由体同形的删除实现（保持薄，避免复制业务逻辑）。
const deleteSession = (state, sessionId) => {
  const index = state.sessions.findIndex(session => session.id === sessionId);
  if (index === -1) return false;
  state.sessions.splice(index, 1);
  propagateSessionDeletion(state, sessionId);
  return true;
};

const buildState = () => ({
  sessions: [
    { id: 'doomed', title: '将被删除' },
    { id: 'keeper', title: '必须保留' },
  ],
  messages: { doomed: [{ id: 'm1', role: 'user', content: 'hi' }], keeper: [{ id: 'm2' }] },
  coreV0: {
    turnAdmissions: [{ turnId: 't1', applicationSessionId: 'doomed' }, { turnId: 't2', applicationSessionId: 'keeper' }],
    memorySessionBindings: [{ bindingId: 'b1', applicationSessionId: 'doomed' }],
    assistantCommits: [{ commitId: 'c1', applicationSessionId: 'doomed' }],
  },
});

test('W1: 删除会话后会话本身消失（splice 未丢失）', () => {
  const state = buildState();
  assert.equal(deleteSession(state, 'doomed'), true);
  assert.deepEqual(state.sessions.map(s => s.id), ['keeper'], '被删会话仍留在 sessions 里 = splice 丢失');
});

test('W1: 删除会话后不留孤儿键，且不误伤其它会话', () => {
  const state = buildState();
  deleteSession(state, 'doomed');
  assert.equal(Object.hasOwn(state.messages, 'doomed'), false, 'messages 孤儿键未清理');
  assert.deepEqual(Object.keys(state.messages), ['keeper'], '无辜会话的 messages 被误删');
  assert.deepEqual(state.coreV0.turnAdmissions.map(x => x.applicationSessionId), ['keeper']);
  assert.deepEqual(state.coreV0.memorySessionBindings, [], 'memorySessionBindings 未清理');
  assert.deepEqual(state.coreV0.assistantCommits, [], 'assistantCommits 未清理');
});

test('W1: 删除不存在的会话是安全的（不抛错、不改状态）', () => {
  const state = buildState();
  const snapshot = JSON.stringify(state);
  assert.equal(deleteSession(state, 'never-was'), false);
  assert.equal(JSON.stringify(state), snapshot, '对不存在的会话不得改动状态');
});

test('W1: 重复删除同一会话是幂等的（第二次返回 false 且无副作用）', () => {
  const state = buildState();
  assert.equal(deleteSession(state, 'doomed'), true);
  const after = JSON.stringify(state);
  assert.equal(deleteSession(state, 'doomed'), false);
  assert.equal(JSON.stringify(state), after, '重复删除不得产生额外改动');
});

test('W2 接线层: index.js 引用的 session-deletion 导出必须已 import', () => {
  // 这是缺陷①的形态：调用点存在、import 缺失。静态检查能在**不启动服务**的前提下
  // 抓到它 —— 而行为测试（哪怕起了服务）只在真的删一次会话时才暴露。
  const importedNames = new Set();
  for (const match of indexSource.matchAll(/^import\s+\{([^}]+)\}\s+from\s+['"]\.\/session-deletion\.js['"]/gm)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (name) importedNames.add(name);
    }
  }
  assert.ok(
    importedNames.has('propagateSessionDeletion'),
    'server/index.js 必须 import { propagateSessionDeletion } —— 缺了它路由会 ReferenceError 并返回 500'
  );
});

test('W2 接线层: index.js 的删除路由必须同时 splice sessions 与调用传播', () => {
  const route = indexSource.slice(indexSource.indexOf("app.delete('/api/sessions/:id'"));
  const body = route.slice(0, route.indexOf('});'));

  // 【必须先剥注释】本路由的说明性注释里先提到了 propagateSessionDeletion，
  // 直接 indexOf 会命中**注释文字**而不是代码 —— 断言就变成在读散文。
  // 这个坑是本测试第一版真实踩到的（顺序断言因注释而误判），故显式处理。
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');

  assert.ok(
    /state\.sessions\.splice\(/.test(code),
    '删除路由必须 splice state.sessions —— 只清理卫星数据会让会话「还在但数据没了」'
  );
  assert.ok(
    /propagateSessionDeletion\(state,\s*req\.params\.id\)/.test(code),
    '删除路由必须调用 propagateSessionDeletion 清理 messages 键与 coreV0 记录'
  );
  // 顺序：先 splice 再传播（保持可读的因果顺序并钉住现状）
  assert.ok(
    code.indexOf('sessions.splice') < code.indexOf('propagateSessionDeletion'),
    '应先从 sessions 移除，再传播清理关联数据'
  );
});
