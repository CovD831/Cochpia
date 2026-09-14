// Session 删除传播（2026-09-13 生产缺陷修复）：
// 删除 chat session 时，jsonb 运行时面上以 sessionId 为键/域的关联结构必须
// 一并清理，否则留下孤儿键（生产实证：cochpia_state.messages 里两个空数组
// 孤儿键）。这条「session → messages 键」的边在删除传播图里曾被遗漏。
//
// 覆盖范围（只清理删除后不可达的结构）：
//   - state.messages[sessionId]
//   - state.coreV0.turnAdmissions / memorySessionBindings / assistantCommits
//     中 applicationSessionId === sessionId 的记录。execute() 的 sessionFor
//     门在校验先于 findTurnByKey 重放查找（core-v0.js），session id 由
//     randomUUID 生成且不复用，因此这些记录在会话删除后没有任何可达路径，
//     属确定性孤儿。
//
// 不覆盖（跨模块治理面，另行决策，见缺陷笔记）：
//   - memoryModule.sessions：memory session 的删除要走治理流程（墓碑/审计），
//     不在本函数内静默级联。
export function propagateSessionDeletion(state, sessionId) {
  if (!state || typeof state !== 'object') throw new TypeError('state is required');
  if (!sessionId) throw new TypeError('sessionId is required');
  const removed = { messagesKey: false, turnAdmissions: 0, memorySessionBindings: 0, assistantCommits: 0 };
  if (state.messages && typeof state.messages === 'object' && Object.hasOwn(state.messages, sessionId)) {
    delete state.messages[sessionId];
    removed.messagesKey = true;
  }
  const core = state.coreV0;
  if (core && typeof core === 'object') {
    for (const key of ['turnAdmissions', 'memorySessionBindings', 'assistantCommits']) {
      if (!Array.isArray(core[key])) continue;
      const before = core[key].length;
      core[key] = core[key].filter(item => item?.applicationSessionId !== sessionId);
      removed[key] = before - core[key].length;
    }
  }
  return removed;
}
